/**
 * identity 领域服务：D1 状态机 / 注册分流 / 登录 / 审批 / 停用 / session_version / 旧 token 兼容。
 *
 * 覆盖验收清单（ADR-008 §验收 / Lead KD-AUTH-001）：
 *   - 公开注册 → c_end 可登录；内部注册 → internal_pending，pending 登录 403 且不签 token；
 *   - 审批只能人类 H3/user；agent 一律拒绝（含缺模型版本）；
 *   - 审批通过写 approval_ref + 递增 session_version，旧 token 立即失效；
 *   - internal_tier：默认 internal_eval，research_only 需显式理由，不允许 c_end_display；
 *   - 旧 token（无 user_type）按 c_end 兼容；有 claim 但轴错 fail-closed（403）；
 *   - 每次写操作都有审计（who/what/before-after/why）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APPROVAL_REF_PATTERN } from '../src/domain/approval-ref.js';
import { IdentityError } from '../src/domain/errors.js';
import type { Principal } from '../src/domain/principal.js';
import {
  AGENT_ACTOR,
  HUMAN_APPROVER,
  ACCOUNT_ADMIN,
  INTERNAL_EMAIL,
  VALID_PASSWORD,
  makeContext,
  signRawClaims,
  testConfig,
  type TestContext,
} from './helpers.js';

async function expectIdentityError(
  work: Promise<unknown> | (() => Promise<unknown>),
  status: number,
  reason?: string,
): Promise<IdentityError> {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    assert.ok(error instanceof IdentityError, `期望 IdentityError，实际 ${String(error)}`);
    assert.equal(error.status, status);
    if (reason !== undefined) {
      assert.equal(error.reason, reason);
    }
    return error;
  }
  assert.fail('期望抛错，但没有抛');
}

async function registerInternalAndGetApplication(ctx: TestContext): Promise<{
  userId: string;
  applicationId: string;
}> {
  return ctx.service.registerInternal({
    email: INTERNAL_EMAIL,
    password: VALID_PASSWORD,
    companyEmail: 'alice@example.com',
    sourceIp: '10.0.0.1',
  });
}

// ------------------------------------------------------------------ 注册分流

test('公开注册：直接 c_end 并可立即登录；principal 四字段与 token claim 一致', async () => {
  const ctx = makeContext();
  const { userId } = await ctx.service.registerPublic({
    email: 'c-end@example.net',
    password: VALID_PASSWORD,
  });

  const login = await ctx.service.login({ email: 'c-end@example.net', password: VALID_PASSWORD });
  assert.equal(login.principal.userType, 'c_end');
  assert.equal(login.principal.tier, 'c_end_display');
  assert.equal(login.principal.sessionVersion, 0);

  const principal: Principal = await ctx.service.authenticateToken(login.token);
  assert.deepEqual(principal, {
    userId,
    userType: 'c_end',
    tier: 'c_end_display',
    sessionVersion: 0,
  });

  const events = ctx.audit.list();
  assert.equal(events[0]?.eventType, 'identity_registration');
  assert.equal(events[0]?.actor.kind, 'system');
  assert.equal(events[0]?.subjectUserId, userId);
});

test('注册：重复邮箱 → 400 duplicate_email（不泄露更敏感信息）', async () => {
  const ctx = makeContext();
  await ctx.service.registerPublic({ email: 'dup@example.net', password: VALID_PASSWORD });
  await expectIdentityError(
    ctx.service.registerPublic({ email: 'DUP@example.net', password: VALID_PASSWORD }),
    400,
    'duplicate_email',
  );
});

test('注册：弱密码 → 400 password_policy', async () => {
  const ctx = makeContext();
  await expectIdentityError(
    ctx.service.registerPublic({ email: 'weak@example.net', password: 'short' }),
    400,
    'password_policy',
  );
});

test('内部注册：企业邮箱白名单 → internal_pending + pending 申请（不签 token）', async () => {
  const ctx = makeContext();
  const { userId, applicationId } = await registerInternalAndGetApplication(ctx);
  assert.match(applicationId, /^app_/);

  const user = await ctx.store.users.findById(userId);
  assert.equal(user?.userType, 'internal_pending');
  assert.equal(user?.internalTier, null);

  const application = await ctx.store.applications.findById(applicationId);
  assert.equal(application?.status, 'pending');
  assert.equal(application?.companyEmail, 'alice@example.com');

  // pending 登录：403 通用 FORBIDDEN，不签 token、不暴露审核状态。
  const error = await expectIdentityError(
    ctx.service.login({ email: INTERNAL_EMAIL, password: VALID_PASSWORD }),
    403,
    'internal_pending',
  );
  assert.equal(error.code, 'FORBIDDEN');

  // 审计：注册 + 登录拒绝，且拒绝原因只落审计。
  const eventTypes = ctx.audit.list().map((event) => event.eventType);
  assert.ok(eventTypes.includes('internal_registration'));
  assert.ok(eventTypes.includes('identity_login_denied'));
});

test('内部注册：邀请码命中同样放行；两项都不命中统一 403；关闭时一律拒绝', async () => {
  const ctx = makeContext();
  await expectIdentityError(
    ctx.service.registerInternal({
      email: 'bob@other.test',
      password: VALID_PASSWORD,
      companyEmail: 'bob@other.test',
    }),
    403,
    'internal_registration_not_allowed',
  );

  const viaInvite = await ctx.service.registerInternal({
    email: 'bob@other.test',
    password: VALID_PASSWORD,
    companyEmail: 'bob@other.test',
    inviteCode: 'INVITE-2026',
  });
  assert.equal(viaInvite.status, 'pending');

  const disabled = makeContext({ internalRegistration: false });
  await expectIdentityError(
    disabled.service.registerInternal({
      email: 'carol@example.com',
      password: VALID_PASSWORD,
      companyEmail: 'carol@example.com',
    }),
    403,
    'internal_registration_not_allowed',
  );
});

// ------------------------------------------------------------------ 登录

test('登录：未知邮箱与错误密码统一 401 invalid_credentials；失败落审计', async () => {
  const ctx = makeContext();
  await ctx.service.registerPublic({ email: 'login@example.net', password: VALID_PASSWORD });

  await expectIdentityError(
    ctx.service.login({ email: 'nobody@example.net', password: VALID_PASSWORD }),
    401,
    'invalid_credentials',
  );
  await expectIdentityError(
    ctx.service.login({ email: 'login@example.net', password: 'wrong password 000' }),
    401,
    'invalid_credentials',
  );

  const denied = ctx.audit.list().filter((event) => event.eventType === 'identity_login_denied');
  assert.equal(denied.length, 2);
  assert.equal(denied[0]?.subjectUserId, null);
  assert.equal(denied[1]?.reason, 'invalid_credentials');
});

// ------------------------------------------------------------------ 审批

test('审批通过：H3 → internal_active，默认 internal_eval，写 approval_ref 且 session_version+1', async () => {
  const ctx = makeContext();
  const { userId, applicationId } = await registerInternalAndGetApplication(ctx);

  const result = await ctx.service.approve({
    applicationId,
    approver: HUMAN_APPROVER,
  });
  assert.equal(result.userId, userId);
  assert.equal(result.internalTier, 'internal_eval');
  assert.equal(result.sessionVersion, 1);
  assert.match(result.approvalRef, APPROVAL_REF_PATTERN);

  const user = await ctx.store.users.findById(userId);
  assert.equal(user?.userType, 'internal_active');
  assert.equal(user?.internalTier, 'internal_eval');
  assert.equal(user?.approvedBy, 'H3');
  assert.equal(user?.approvalRef, result.approvalRef);
  assert.ok(user?.approvedAt !== null);

  const application = await ctx.store.applications.findById(applicationId);
  assert.equal(application?.status, 'approved');
  assert.equal(application?.decidedBy, 'H3');
  assert.equal(application?.decisionRef, result.approvalRef);

  const approvalEvent = ctx.audit
    .list()
    .find((event) => event.eventType === 'internal_approval');
  assert.ok(approvalEvent !== undefined);
  assert.equal(approvalEvent.actor.kind, 'human');
  assert.equal(approvalEvent.actor.id, 'H3');
  assert.equal(approvalEvent.approvalRef, result.approvalRef);
  const before = approvalEvent.before as Record<string, unknown>;
  const after = approvalEvent.after as Record<string, unknown>;
  assert.equal(before['userType'], 'internal_pending');
  assert.equal(before['approvalRef'], null);
  assert.equal(after['userType'], 'internal_active');
  assert.equal(after['internalTier'], 'internal_eval');
  assert.equal(after['approvalRef'], result.approvalRef);
  assert.equal(after['sessionVersion'], 1);
});

test('审批：agent 不能审批（即使带模型版本）；缺模型版本单独拒绝', async () => {
  const ctx = makeContext();
  const { applicationId } = await registerInternalAndGetApplication(ctx);

  await expectIdentityError(
    ctx.service.approve({ applicationId, approver: AGENT_ACTOR }),
    403,
    'approver_not_human',
  );
  await expectIdentityError(
    ctx.service.approve({
      applicationId,
      approver: { kind: 'agent', id: 'A15' },
    }),
    403,
    'actor_model_version_required',
  );
  // H5 不是审批人（H5 是账号管理员/签字人），审批只允许 H3/user。
  await expectIdentityError(
    ctx.service.approve({ applicationId, approver: { kind: 'human', id: 'H5' } }),
    403,
    'approver_not_allowed',
  );
});

test('审批：research_only 必须显式选择 + 理由；通过后档位生效', async () => {
  const ctx = makeContext();
  const { applicationId, userId } = await registerInternalAndGetApplication(ctx);

  await expectIdentityError(
    ctx.service.approve({ applicationId, approver: HUMAN_APPROVER, internalTier: 'research_only' }),
    400,
    'research_only_requires_reason',
  );

  const result = await ctx.service.approve({
    applicationId,
    approver: { kind: 'human', id: 'user' },
    internalTier: 'research_only',
    reason: '研究需要跨域明细',
  });
  assert.equal(result.internalTier, 'research_only');

  const login = await ctx.service.login({ email: INTERNAL_EMAIL, password: VALID_PASSWORD });
  assert.equal(login.principal.userType, 'internal_active');
  assert.equal(login.principal.tier, 'research_only');
  assert.equal(login.principal.sessionVersion, result.sessionVersion);

  assert.equal((await ctx.store.users.findById(userId))?.internalTier, 'research_only');
});

test('审批拒绝：申请 rejected、用户仍 internal_pending，不能再被审批', async () => {
  const ctx = makeContext();
  const { applicationId, userId } = await registerInternalAndGetApplication(ctx);

  const result = await ctx.service.reject({
    applicationId,
    approver: HUMAN_APPROVER,
    reason: '企业邮箱无法验证',
  });
  assert.equal(result.status, 'rejected');
  assert.equal((await ctx.store.users.findById(userId))?.userType, 'internal_pending');
  assert.equal((await ctx.store.applications.findById(applicationId))?.status, 'rejected');

  await expectIdentityError(
    ctx.service.approve({ applicationId, approver: HUMAN_APPROVER }),
    400,
    'application_not_pending',
  );
  await expectIdentityError(
    ctx.service.login({ email: INTERNAL_EMAIL, password: VALID_PASSWORD }),
    403,
    'internal_pending',
  );
});

// ------------------------------------------------------------------ session_version / token

test('session_version：改内部档递增 → 旧 token 立即失效，重新登录拿到新档', async () => {
  const ctx = makeContext();
  const { applicationId, userId } = await registerInternalAndGetApplication(ctx);
  await ctx.service.approve({ applicationId, approver: HUMAN_APPROVER });

  const oldLogin = await ctx.service.login({ email: INTERNAL_EMAIL, password: VALID_PASSWORD });
  assert.equal(oldLogin.principal.sessionVersion, 1);
  assert.equal(oldLogin.principal.tier, 'internal_eval');

  const changed = await ctx.service.changeInternalTier({
    userId,
    internalTier: 'research_only',
    approver: HUMAN_APPROVER,
    reason: '研究任务需要 research_only',
  });
  assert.equal(changed.sessionVersion, 2);

  await expectIdentityError(
    ctx.service.authenticateToken(oldLogin.token),
    401,
    'session_version_mismatch',
  );

  const newLogin = await ctx.service.login({ email: INTERNAL_EMAIL, password: VALID_PASSWORD });
  assert.equal(newLogin.principal.tier, 'research_only');
  assert.equal((await ctx.service.authenticateToken(newLogin.token)).sessionVersion, 2);
});

test('claim 轴：c_end 用户伪造内部档 token → 403 claim_inconsistent（不降级）', async () => {
  const ctx = makeContext();
  await ctx.service.registerPublic({ email: 'c-end@example.net', password: VALID_PASSWORD });
  const user = await ctx.store.users.findByEmail('c-end@example.net');

  const forged = signRawClaims({
    sub: user?.userId,
    user_type: 'c_end',
    tier: 'research_only',
    session_version: 0,
  });
  await expectIdentityError(ctx.service.authenticateToken(forged), 403, 'claim_inconsistent');
});

test('旧 token 兼容：无 user_type 的 C 端 token 按 c_end；内部用户/关闭兼容后一律拒绝', async () => {
  const ctx = makeContext();
  const { userId } = await ctx.service.registerPublic({
    email: 'legacy@example.net',
    password: VALID_PASSWORD,
  });

  const legacyToken = signRawClaims({ sub: userId });
  const principal = await ctx.service.authenticateToken(legacyToken);
  assert.equal(principal.userType, 'c_end');
  assert.equal(principal.tier, 'c_end_display');

  // 内部用户不接受旧形态 token（即使 user_type 缺失也不得按 c_end 放行）。
  const internal = await registerInternalAndGetApplication(ctx);
  await ctx.service.approve({ applicationId: internal.applicationId, approver: HUMAN_APPROVER });
  await expectIdentityError(
    ctx.service.authenticateToken(signRawClaims({ sub: internal.userId })),
    401,
    'legacy_token_rejected',
  );

  // S4 完成后关闭兼容：旧 token 一律 401。
  const strict = makeContext({ legacy: false });
  const cEnd = await strict.service.registerPublic({
    email: 'strict@example.net',
    password: VALID_PASSWORD,
  });
  await expectIdentityError(
    strict.service.authenticateToken(signRawClaims({ sub: cEnd.userId })),
    401,
    'legacy_token_rejected',
  );
});

test('内部 token 与库不一致（user_type / tier）→ 403 claim_inconsistent', async () => {
  const ctx = makeContext();
  const { applicationId, userId } = await registerInternalAndGetApplication(ctx);
  await ctx.service.approve({ applicationId, approver: HUMAN_APPROVER });
  // 把用户降回 pending 模拟 DB 与 token 不一致。
  const user = await ctx.store.users.findById(userId);
  assert.ok(user !== null);
  await ctx.store.users.update(
    { ...user, userType: 'internal_pending', internalTier: null, approvedBy: null, approvedAt: null, approvalRef: null },
    user.sessionVersion,
  );

  const token = signRawClaims({
    sub: userId,
    user_type: 'internal_active',
    tier: 'internal_eval',
    session_version: 1,
  });
  await expectIdentityError(ctx.service.authenticateToken(token), 403, 'claim_inconsistent');
});

test('internal_active 缺 approval_ref：视为数据错误 fail-closed（403）', async () => {
  const ctx = makeContext();
  const { applicationId, userId } = await registerInternalAndGetApplication(ctx);
  const approved = await ctx.service.approve({ applicationId, approver: HUMAN_APPROVER });

  const login = await ctx.service.login({ email: INTERNAL_EMAIL, password: VALID_PASSWORD });
  const user = await ctx.store.users.findById(userId);
  assert.ok(user !== null);
  const broken = await ctx.store.users.update(
    { ...user, approvalRef: null, approvedBy: null, approvedAt: null },
    user.sessionVersion,
  );
  assert.equal(broken, true);

  await expectIdentityError(
    ctx.service.authenticateToken(login.token),
    403,
    'internal_active_without_approval',
  );
  assert.match(approved.approvalRef, APPROVAL_REF_PATTERN);
});

// ------------------------------------------------------------------ 停用

test('停用：账号锁定 + session_version+1，旧 token 与登录均 403；agent 不能停用', async () => {
  const ctx = makeContext();
  const { userId } = await ctx.service.registerPublic({
    email: 'disabled@example.net',
    password: VALID_PASSWORD,
  });
  const login = await ctx.service.login({ email: 'disabled@example.net', password: VALID_PASSWORD });

  await expectIdentityError(
    ctx.service.disableUser({
      userId,
      actor: { kind: 'agent', id: 'A4', modelVersion: 'deepseek-flash' },
    }),
    403,
    'approver_not_human',
  );

  await ctx.service.disableUser({ userId, actor: ACCOUNT_ADMIN, reason: '离职' });
  const user = await ctx.store.users.findById(userId);
  assert.equal(user?.accountLocked, true);
  assert.equal(user?.userType, 'c_end');
  assert.equal(user?.sessionVersion, 1);

  await expectIdentityError(ctx.service.authenticateToken(login.token), 403, 'account_locked');
  await expectIdentityError(
    ctx.service.login({ email: 'disabled@example.net', password: VALID_PASSWORD }),
    403,
    'account_locked',
  );

  const disabledEvent = ctx.audit.list().find((event) => event.eventType === 'account_disabled');
  assert.equal(disabledEvent?.actor.id, 'H5');
  assert.equal(disabledEvent?.reason, '离职');
});

// ------------------------------------------------------------------ 审计完整性

test('审计：注册/登录/审批事件均含 actor、时间、before-after、reason', async () => {
  const ctx = makeContext();
  const { applicationId } = await registerInternalAndGetApplication(ctx);
  await ctx.service.approve({ applicationId, approver: HUMAN_APPROVER });

  const events = ctx.audit.list();
  assert.ok(events.length >= 2);
  for (const event of events) {
    assert.ok(event.eventType.length > 0);
    assert.ok(!Number.isNaN(Date.parse(event.occurredAt)));
    assert.ok(['human', 'agent', 'system'].includes(event.actor.kind));
    assert.ok(event.actor.id.length > 0);
    if (event.actor.kind === 'agent') {
      assert.ok(event.actor.modelVersion !== undefined);
    }
  }
  const approval = events.find((event) => event.eventType === 'internal_approval');
  assert.ok(approval?.before !== null && approval?.after !== null);
  assert.equal(approval?.reason, 'internal_approval');
});
