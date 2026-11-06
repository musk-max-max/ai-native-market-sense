/**
 * identity 领域服务 —— 注册 / 登录 / token 校验 / 人工审批 / 停用 / 改档。
 *
 * 边界（ADR-008 D1/D2/D9 S1）：
 *   - 只做身份与用户侧档位；gate 判定、路由受众选择在 A3（services/market），本域不读 audience；
 *   - 所有写操作同事务落审计（A4 system_prompt 硬规则 3：who / what / before-after / why）；
 *   - 审批只能由人类席位（H3/user）执行，agent 身份一律拒绝（agents/README.md「agent 不能批准 agent」）；
 *   - `internal_pending` 永远不签 token（登录 403，通用 FORBIDDEN，不暴露原因）。
 *
 * 并发：用户更新用乐观并发（expected sessionVersion），申请更新用 expectedStatus；
 * 两个审批人同时点「通过」时只有一个成功，另一个收到冲突错误（不会双写审批人）。
 */

import { createHash } from 'node:crypto';

import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from '../auth/password.js';
import { signToken, verifyToken, type JwtClaims } from '../auth/jwt.js';
import type { IdentityConfig } from '../config.js';
import { INTERNAL_TIER_DEFAULT } from '../config.js';
import { APPROVAL_REF_PATTERN, generateApprovalRef } from '../domain/approval-ref.js';
import { IdentityError, isIdentityError, type IdentityReason } from '../domain/errors.js';
import {
  principalFromUser,
  tierForUser,
  type Principal,
} from '../domain/principal.js';
import {
  applyApproval,
  applyDisable,
  applyInternalTierChange,
  userSnapshot,
} from '../domain/transitions.js';
import {
  INTERNAL_TIERS,
  isAccountAdministratorId,
  isApproverId,
  type ApproverId,
  type InternalApplication,
  type InternalTier,
  type UserRecord,
} from '../domain/types.js';
import type { AuditActor, IdentityAuditEvent, IdentityAuditEventType } from '../ports/audit-sink.js';
import type { Clock, IdGenerator } from '../ports/clock.js';
import { systemClock, uuidIdGenerator } from '../ports/clock.js';
import type { IdentityRepositories, IdentityStore } from '../ports/store.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;

export interface IdentityServiceOptions {
  readonly store: IdentityStore;
  readonly config: IdentityConfig;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface RegistrationResult {
  readonly userId: string;
}

export interface InternalRegistrationResult {
  readonly userId: string;
  readonly applicationId: string;
  readonly status: 'pending';
}

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly principal: Principal;
}

export interface ApprovalResult {
  readonly userId: string;
  readonly internalTier: InternalTier;
  readonly approvalRef: string;
  readonly sessionVersion: number;
}

export interface ApproveInput {
  readonly applicationId: string;
  readonly approver: AuditActor;
  /** 缺省 `internal_eval`（ADR-008 D1：默认档）。 */
  readonly internalTier?: InternalTier;
  /** `research_only` 必填（ADR-008 D1：需显式选择 + 理由）。 */
  readonly reason?: string;
}

export interface RejectInput {
  readonly applicationId: string;
  readonly approver: AuditActor;
  readonly reason?: string;
}

/** 内部注册自报的企业邮箱与登录邮箱分开：审批 UI 以 companyEmail 为准。 */
export interface RegisterInternalInput {
  readonly email: string;
  readonly password: string;
  readonly companyEmail: string;
  readonly inviteCode?: string;
  readonly sourceIp?: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function assertEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(normalized)) {
    throw new IdentityError('VALIDATION_ERROR', 'email_invalid');
  }
  return normalized;
}

function assertPassword(password: string, minLength: number): void {
  if (password.length < minLength || password.length > MAX_PASSWORD_LENGTH) {
    throw new IdentityError('VALIDATION_ERROR', 'password_policy');
  }
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1);
}

/** agent 身份必须带模型版本才可入审计（A4 system_prompt 硬规则 3）。 */
function assertAuditableActor(actor: AuditActor): void {
  if (actor.kind === 'agent' && (actor.modelVersion === undefined || actor.modelVersion.trim() === '')) {
    throw new IdentityError('FORBIDDEN', 'actor_model_version_required');
  }
}

/** 审批人：必须是人类席位 H3/user，agent 即使有 id 也不行。 */
function assertHumanApprover(actor: AuditActor): ApproverId {
  assertAuditableActor(actor);
  if (actor.kind !== 'human') {
    throw new IdentityError('FORBIDDEN', 'approver_not_human');
  }
  if (!isApproverId(actor.id)) {
    throw new IdentityError('FORBIDDEN', 'approver_not_allowed');
  }
  return actor.id;
}

/** 账号管理（停用）：H3/H5/user 人类席位。 */
function assertAccountAdministrator(actor: AuditActor): void {
  assertAuditableActor(actor);
  if (actor.kind !== 'human') {
    throw new IdentityError('FORBIDDEN', 'approver_not_human');
  }
  if (!isAccountAdministratorId(actor.id)) {
    throw new IdentityError('FORBIDDEN', 'approver_not_allowed');
  }
}

function assertInternalTier(value: string): InternalTier {
  if (!(INTERNAL_TIERS as readonly string[]).includes(value)) {
    throw new IdentityError('VALIDATION_ERROR', 'internal_tier_invalid');
  }
  return value as InternalTier;
}

function researchOnlyRequiresReason(tier: InternalTier, reason: string | undefined): void {
  if (tier === 'research_only' && (reason === undefined || reason.trim().length === 0)) {
    throw new IdentityError('VALIDATION_ERROR', 'research_only_requires_reason');
  }
}

function auditEvent(input: {
  eventType: IdentityAuditEventType;
  at: string;
  actor: AuditActor;
  subjectUserId?: string | null;
  subjectApplicationId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  approvalRef?: string | null;
}): IdentityAuditEvent {
  return {
    eventType: input.eventType,
    occurredAt: input.at,
    actor: input.actor,
    subjectUserId: input.subjectUserId ?? null,
    subjectApplicationId: input.subjectApplicationId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    approvalRef: input.approvalRef ?? null,
  };
}

export class IdentityService {
  private readonly store: IdentityStore;
  private readonly config: IdentityConfig;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(options: IdentityServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? uuidIdGenerator;
  }

  // ---------------------------------------------------------------- 注册

  /** 公开注册：直接 `c_end`（ADR-008 D1），可立即登录。 */
  async registerPublic(input: { email: string; password: string }): Promise<RegistrationResult> {
    const email = assertEmail(input.email);
    assertPassword(input.password, this.config.passwordMinLength);
    // 先算哈希再查重：成功/重复两条路径耗时一致，避免用响应时间枚举已注册邮箱。
    const passwordHash = await hashPassword(input.password);
    const at = this.clock.now().toISOString();
    const userId = this.ids.userId();
    const user: UserRecord = {
      userId,
      email,
      passwordHash,
      userType: 'c_end',
      internalTier: null,
      approvedBy: null,
      approvedAt: null,
      approvalRef: null,
      sessionVersion: 0,
      accountLocked: false,
      createdAt: at,
      updatedAt: at,
    };
    const inserted = await this.store.users.insertIfAbsent(user);
    if (!inserted) {
      throw new IdentityError('VALIDATION_ERROR', 'duplicate_email');
    }
    await this.store.audit.record(
      auditEvent({
        eventType: 'identity_registration',
        at,
        actor: { kind: 'system', id: 'self-registration:public' },
        subjectUserId: userId,
        after: userSnapshot(user),
        reason: 'public_registration',
      }),
    );
    return { userId };
  }

  /**
   * 内部注册：进入 `internal_pending`，**不签 token**；同时建审批申请。
   *
   * 准入（ADR-008 D2）：企业邮箱白名单域 **或** 邀请码哈希命中，二者至少一项；
   * 两项都未命中统一 403，不区分「邮箱不在白名单」还是「邀请码错」，避免探测。
   */
  async registerInternal(input: RegisterInternalInput): Promise<InternalRegistrationResult> {
    const registration = this.config.internalRegistration;
    if (!registration.enabled) {
      throw new IdentityError('FORBIDDEN', 'internal_registration_not_allowed');
    }
    const email = assertEmail(input.email);
    const companyEmail = assertEmail(input.companyEmail);
    assertPassword(input.password, this.config.passwordMinLength);

    const domainAllowed = registration.companyEmailDomains.includes(emailDomain(companyEmail));
    const inviteHash =
      input.inviteCode === undefined || input.inviteCode.trim() === ''
        ? null
        : sha256Hex(input.inviteCode.trim());
    const inviteAllowed = inviteHash !== null && registration.inviteCodeSha256.has(inviteHash);
    if (!domainAllowed && !inviteAllowed) {
      throw new IdentityError('FORBIDDEN', 'internal_registration_not_allowed');
    }

    // 与公开注册同理：先算哈希，拉平已存在/新注册的时间。
    const passwordHash = await hashPassword(input.password);
    const at = this.clock.now().toISOString();
    const userId = this.ids.userId();
    const applicationId = this.ids.applicationId();
    const user: UserRecord = {
      userId,
      email,
      passwordHash,
      userType: 'internal_pending',
      internalTier: null,
      approvedBy: null,
      approvedAt: null,
      approvalRef: null,
      sessionVersion: 0,
      accountLocked: false,
      createdAt: at,
      updatedAt: at,
    };
    const application: InternalApplication = {
      applicationId,
      userId,
      status: 'pending',
      companyEmail,
      inviteCodeRef: inviteHash === null ? null : inviteHash.slice(0, 16),
      sourceIpHash:
        input.sourceIp === undefined || input.sourceIp === ''
          ? null
          : sha256Hex(`${registration.sourceIpHashSalt}:${input.sourceIp}`),
      requestedAt: at,
      proposedInternalTier: null,
      decidedAt: null,
      decidedBy: null,
      decisionRef: null,
      decisionReason: null,
    };

    await this.store.runInTransaction(async (repos) => {
      const inserted = await repos.users.insertIfAbsent(user);
      if (!inserted) {
        throw new IdentityError('VALIDATION_ERROR', 'duplicate_email');
      }
      await repos.applications.insertIfAbsent(application);
      await repos.audit.record(
        auditEvent({
          eventType: 'internal_registration',
          at,
          actor: { kind: 'system', id: 'self-registration:internal' },
          subjectUserId: userId,
          subjectApplicationId: applicationId,
          after: userSnapshot(user),
          reason: 'internal_registration',
        }),
      );
    });

    return { userId, applicationId, status: 'pending' };
  }

  // ---------------------------------------------------------------- 登录 / token

  /**
   * 密码登录。`internal_pending` 返回 403 且不签 token；
   * `account_locked` 同样拒绝登录（ADR-008 D1 状态机）。
   */
  async login(input: { email: string; password: string }): Promise<LoginResult> {
    const email = assertEmail(input.email);
    const at = this.clock.now().toISOString();
    const user = await this.store.users.findByEmail(email);
    if (user === null) {
      // 等时响应：未知邮箱也跑一次同参数 scrypt。
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
      await this.recordLoginDenied(at, null, 'invalid_credentials');
      throw new IdentityError('UNAUTHENTICATED', 'invalid_credentials');
    }
    const passwordOk = await verifyPassword(input.password, user.passwordHash);
    if (!passwordOk) {
      await this.recordLoginDenied(at, user.userId, 'invalid_credentials');
      throw new IdentityError('UNAUTHENTICATED', 'invalid_credentials');
    }
    if (user.accountLocked) {
      await this.recordLoginDenied(at, user.userId, 'account_locked');
      throw new IdentityError('FORBIDDEN', 'account_locked');
    }
    if (user.userType === 'internal_pending') {
      // 403 通用 FORBIDDEN：不签 token、不暴露审核状态/原因（ADR-008 D2 登录 2.）。
      await this.recordLoginDenied(at, user.userId, 'internal_pending');
      throw new IdentityError('FORBIDDEN', 'internal_pending');
    }
    const principal = principalFromUser(user);
    const issued = signToken(principal, this.config.jwt, this.clock.now().getTime());
    await this.store.audit.record(
      auditEvent({
        eventType: 'identity_login',
        at,
        actor: { kind: 'human', id: user.userId },
        subjectUserId: user.userId,
        reason: 'password_login',
      }),
    );
    return { token: issued.token, expiresAt: issued.expiresAt, principal };
  }

  /**
   * Bearer token → 当前 principal。所有档位/状态以**服务端存储为准**，token 只作身份凭据。
   *
   * 失败语义：
   *   - token 形态/签名/过期/aud 错误 → `UNAUTHENTICATED`（401）；
   *   - 用户被停用 → `FORBIDDEN account_locked`（403）；
   *   - 角色/档位/session_version 与库不一致 → `UNAUTHENTICATED`（旧 token 失效）。
   */
  async authenticateToken(token: string): Promise<Principal> {
    const claims = verifyToken(token, this.config.jwt, this.clock.now().getTime());
    const user = await this.store.users.findById(claims.sub);
    if (user === null) {
      throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
    }
    if (user.accountLocked) {
      throw new IdentityError('FORBIDDEN', 'account_locked');
    }

    if (claims.user_type === undefined) {
      // S4 兼容：旧 C 端 token 无 user_type，按 c_end 处理；内部用户不接受旧形态 token。
      if (!this.config.acceptLegacyTokensWithoutUserType) {
        throw new IdentityError('UNAUTHENTICATED', 'legacy_token_rejected');
      }
      if (user.userType !== 'c_end') {
        throw new IdentityError('UNAUTHENTICATED', 'legacy_token_rejected');
      }
      return principalFromUser(user);
    }

    // claim 轴与库不一致：403（H2 L125「有 claim 但非法不得降级」），不泄露差异细节。
    if (claims.user_type !== user.userType) {
      throw new IdentityError('FORBIDDEN', 'claim_inconsistent');
    }
    // 审批 / 改档 / 停用递增 session_version → 旧 token 立即失效（ADR-008 D1 硬规则 4）。
    // 非 legacy token 必须带 session_version 且与库严格相等（缺省也视为失效，fail-closed）。
    if (
      claims.session_version === undefined ||
      claims.session_version !== user.sessionVersion
    ) {
      throw new IdentityError('UNAUTHENTICATED', 'session_version_mismatch');
    }
    const expectedTier = tierForUser(user);
    if (claims.tier === undefined || claims.tier !== expectedTier) {
      throw new IdentityError('FORBIDDEN', 'claim_inconsistent');
    }
    return principalFromUser(user);
  }

  /** 便于外壳把 principal 注入请求；不存在的用户返回 null（不抛错）。 */
  async findPrincipalByUserId(userId: string): Promise<Principal | null> {
    const user = await this.store.users.findById(userId);
    if (user === null || user.accountLocked || user.userType === 'internal_pending') {
      return null;
    }
    try {
      return principalFromUser(user);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- 审批

  /**
   * 审批通过：`internal_pending → internal_active`，写审批人/时间/`approval_ref`，
   * `session_version+1` 使旧 token 失效（ADR-008 D1）。
   *
   * `approval_ref` 生成点：本服务事务内（decisions.md L51「生成点唯一」）。
   * 仅当 A4 审批 API 已在建单时生成并通过 `approvalRef` 传入时才复用；否则这里生成。
   */
  async approve(input: ApproveInput): Promise<ApprovalResult> {
    let approvedBy: ApproverId;
    try {
      approvedBy = assertHumanApprover(input.approver);
    } catch (error) {
      if (isIdentityError(error)) {
        await this.recordApprovalDenied({
          actor: input.approver,
          operation: 'approve',
          applicationId: input.applicationId,
          reason: error.reason,
        });
      }
      throw error;
    }
    const internalTier = assertInternalTier(input.internalTier ?? INTERNAL_TIER_DEFAULT);
    researchOnlyRequiresReason(internalTier, input.reason);
    const approvalRef = this.generateApprovalRef();
    if (!APPROVAL_REF_PATTERN.test(approvalRef)) {
      throw new IdentityError('VALIDATION_ERROR', 'approval_ref_invalid');
    }
    const at = this.clock.now().toISOString();

    return this.store.runInTransaction(async (repos) => {
      const application = await this.loadPendingApplication(repos, input.applicationId);
      const user = await this.loadUser(repos, application.userId);
      if (user.userType !== 'internal_pending') {
        throw new IdentityError('VALIDATION_ERROR', 'claim_inconsistent');
      }
      const updated = applyApproval(user, {
        internalTier,
        approvedBy,
        approvalRef,
        at,
      });
      const userUpdated = await repos.users.update(updated, user.sessionVersion);
      if (!userUpdated) {
        throw new IdentityError('VALIDATION_ERROR', 'session_version_mismatch');
      }
      const applicationUpdated: InternalApplication = {
        ...application,
        status: 'approved',
        decidedAt: at,
        decidedBy: approvedBy,
        decisionRef: approvalRef,
        decisionReason: input.reason?.trim() ?? null,
      };
      const applicationUpdatedOk = await repos.applications.update(applicationUpdated, 'pending');
      if (!applicationUpdatedOk) {
        throw new IdentityError('VALIDATION_ERROR', 'application_not_pending');
      }
      await repos.audit.record(
        auditEvent({
          eventType: 'internal_approval',
          at,
          actor: input.approver,
          subjectUserId: user.userId,
          subjectApplicationId: application.applicationId,
          before: userSnapshot(user),
          after: userSnapshot(updated),
          reason: input.reason?.trim() ?? 'internal_approval',
          approvalRef,
        }),
      );
      return {
        userId: updated.userId,
        internalTier,
        approvalRef,
        sessionVersion: updated.sessionVersion,
      };
    });
  }

  /** 审批拒绝：申请置 rejected，用户仍为 `internal_pending`（不签 token，可走 P1 重申请）。 */
  async reject(input: RejectInput): Promise<{ applicationId: string; status: 'rejected' }> {
    let decidedBy: ApproverId;
    try {
      decidedBy = assertHumanApprover(input.approver);
    } catch (error) {
      if (isIdentityError(error)) {
        await this.recordApprovalDenied({
          actor: input.approver,
          operation: 'reject',
          applicationId: input.applicationId,
          reason: error.reason,
        });
      }
      throw error;
    }
    const at = this.clock.now().toISOString();
    return this.store.runInTransaction(async (repos) => {
      const application = await this.loadPendingApplication(repos, input.applicationId);
      const applicationUpdated: InternalApplication = {
        ...application,
        status: 'rejected',
        decidedAt: at,
        decidedBy,
        decisionRef: null,
        decisionReason: input.reason?.trim() ?? null,
      };
      const ok = await repos.applications.update(applicationUpdated, 'pending');
      if (!ok) {
        throw new IdentityError('VALIDATION_ERROR', 'application_not_pending');
      }
      await repos.audit.record(
        auditEvent({
          eventType: 'internal_rejection',
          at,
          actor: input.approver,
          subjectUserId: application.userId,
          subjectApplicationId: application.applicationId,
          after: applicationUpdated,
          reason: input.reason?.trim() ?? 'internal_rejection',
        }),
      );
      return { applicationId: application.applicationId, status: 'rejected' };
    });
  }

  // ---------------------------------------------------------------- 账号管理

  /** 停用：不改 user_type，`account_locked=true` 且 `session_version+1`（旧 token 失效）。 */
  async disableUser(input: { userId: string; actor: AuditActor; reason?: string }): Promise<void> {
    assertAccountAdministrator(input.actor);
    const at = this.clock.now().toISOString();
    await this.store.runInTransaction(async (repos) => {
      const user = await this.loadUser(repos, input.userId);
      if (user.accountLocked) {
        return;
      }
      const updated = applyDisable(user, at);
      const ok = await repos.users.update(updated, user.sessionVersion);
      if (!ok) {
        throw new IdentityError('VALIDATION_ERROR', 'session_version_mismatch');
      }
      await repos.audit.record(
        auditEvent({
          eventType: 'account_disabled',
          at,
          actor: input.actor,
          subjectUserId: user.userId,
          before: userSnapshot(user),
          after: userSnapshot(updated),
          reason: input.reason?.trim() ?? 'account_disabled',
        }),
      );
    });
  }

  /**
   * 改内部数据档（internal_eval ↔ research_only）：审批人执行，`session_version+1`。
   * `research_only` 仍需显式理由（ADR-008 D1：提升到研究档必须留痕）。
   */
  async changeInternalTier(input: {
    userId: string;
    internalTier: InternalTier;
    approver: AuditActor;
    reason?: string;
  }): Promise<{ internalTier: InternalTier; sessionVersion: number }> {
    try {
      assertHumanApprover(input.approver);
    } catch (error) {
      if (isIdentityError(error)) {
        await this.recordApprovalDenied({
          actor: input.approver,
          operation: 'change_internal_tier',
          userId: input.userId,
          reason: error.reason,
        });
      }
      throw error;
    }
    const internalTier = assertInternalTier(input.internalTier);
    researchOnlyRequiresReason(internalTier, input.reason);
    const at = this.clock.now().toISOString();
    return this.store.runInTransaction(async (repos) => {
      const user = await this.loadUser(repos, input.userId);
      if (user.userType !== 'internal_active') {
        throw new IdentityError('FORBIDDEN', 'tier_change_not_internal');
      }
      if (user.internalTier === internalTier) {
        return { internalTier, sessionVersion: user.sessionVersion };
      }
      const updated = applyInternalTierChange(user, { internalTier, at });
      const ok = await repos.users.update(updated, user.sessionVersion);
      if (!ok) {
        throw new IdentityError('VALIDATION_ERROR', 'session_version_mismatch');
      }
      await repos.audit.record(
        auditEvent({
          eventType: 'internal_tier_change',
          at,
          actor: input.approver,
          subjectUserId: user.userId,
          before: userSnapshot(user),
          after: userSnapshot(updated),
          reason: input.reason?.trim() ?? 'internal_tier_change',
        }),
      );
      return { internalTier, sessionVersion: updated.sessionVersion };
    });
  }

  /** 审批 id：审批建单事务内生成（decisions.md L51「生成点唯一」）。 */
  generateApprovalRef(): string {
    return generateApprovalRef({
      ...(this.config.approvalEnv === null ? {} : { env: this.config.approvalEnv }),
      nowMs: this.clock.now().getTime(),
    });
  }

  // ---------------------------------------------------------------- 内部

  private async loadUser(repos: IdentityRepositories, userId: string): Promise<UserRecord> {
    const user = await repos.users.findById(userId);
    if (user === null) {
      throw new IdentityError('NOT_FOUND', 'user_not_found');
    }
    return user;
  }

  private async loadPendingApplication(
    repos: IdentityRepositories,
    applicationId: string,
  ): Promise<InternalApplication> {
    const application = await repos.applications.findById(applicationId);
    if (application === null) {
      throw new IdentityError('NOT_FOUND', 'application_not_found');
    }
    if (application.status !== 'pending') {
      throw new IdentityError('VALIDATION_ERROR', 'application_not_pending');
    }
    return application;
  }

  private recordLoginDenied(
    at: string,
    userId: string | null,
    reason: IdentityReason,
  ): Promise<void> {
    return this.store.audit.record(
      auditEvent({
        eventType: 'identity_login_denied',
        at,
        actor: { kind: 'system', id: 'password-login' },
        subjectUserId: userId,
        reason,
      }),
    );
  }

  /**
   * 审批/改档**被拒**也必须留痕（A4 system_prompt 硬规则 3：agent 不能批 agent，
   * 但「谁试图批、为何被拒」必须有据）。`approval_denied` 本就在端口白名单
   * `IDENTITY_AUDIT_EVENT_TYPES` 与 `identity.audit_events` 的 event_type CHECK 内，无需 DDL。
   * 与 `recordLoginDenied` 同构：先记账，调用方再抛原错（审计写失败 fail-closed）。
   *
   * 两个约束决定了写法：
   *   - 拒斥发生在读申请/用户之前，而 `subject_*` 是外键：先解析存在性，查不到则置 null、
   *     被拒目标 id 放进 `after` 快照，避免审计写入把 403 变成 FK 违例 500；
   *   - agent 缺 modelVersion 不满足 `ck_audit_events_agent_model`：改以 system 记录员入账，
   *     被拒 actor 原样放 `after.attemptedActor`（不伪造 modelVersion）。
   *
   * 只覆盖事务前的审批人断言拒绝；事务内拒绝（application_not_pending 等）在同一事务里
   * 记账会随 ROLLBACK 消失，需 out-of-txn 留痕，另行排期（见 G-03 判定材料）。
   */
  private async recordApprovalDenied(input: {
    actor: AuditActor;
    operation: 'approve' | 'reject' | 'change_internal_tier';
    applicationId?: string;
    userId?: string;
    reason: IdentityReason;
  }): Promise<void> {
    const at = this.clock.now().toISOString();
    const attempted: Record<string, unknown> = {
      operation: input.operation,
      attemptedActor: input.actor,
    };
    if (input.applicationId !== undefined) {
      attempted['applicationId'] = input.applicationId;
    }
    if (input.userId !== undefined) {
      attempted['userId'] = input.userId;
    }
    const actor: AuditActor =
      input.actor.kind === 'agent' && (input.actor.modelVersion ?? '').trim() === ''
        ? { kind: 'system', id: 'approval-denied-recorder' }
        : input.actor;

    let subjectUserId: string | null = null;
    let subjectApplicationId: string | null = null;
    if (input.applicationId !== undefined) {
      const application = await this.store.applications.findById(input.applicationId);
      if (application !== null) {
        subjectApplicationId = application.applicationId;
        subjectUserId = application.userId;
      }
    }
    if (input.userId !== undefined && subjectUserId === null) {
      const user = await this.store.users.findById(input.userId);
      if (user !== null) {
        subjectUserId = user.userId;
      }
    }

    await this.store.audit.record(
      auditEvent({
        eventType: 'approval_denied',
        at,
        actor,
        subjectUserId,
        subjectApplicationId,
        after: attempted,
        reason: input.reason,
      }),
    );
  }
}

export function createIdentityService(options: IdentityServiceOptions): IdentityService {
  return new IdentityService(options);
}
