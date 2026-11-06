/**
 * 审批域服务：建单/查单/判定/决定/账本事件（contracts/approval/openapi.yaml + approvals/README.md）。
 *
 * 硬约束落地点：
 *   - approval_ref 只在建单事务生成（apr_<uuidv7> 裸 ref，M2/M3）；
 *   - 一单一对象、决定不可复用（撤回/驳回/过期重提 = 新建单）；
 *   - approved/rejected 只能由人类审批人（HUMAN_APPROVERS = H3/user）作出，agent/A15 一律 403；
 *   - 引擎未实现 ⇒ evaluate 恒 yellow_route，绝不假绿；auto_passed 只能来自确定性引擎；
 *   - 每个写操作留痕：who（人或 agent id+模型版本）/ what / before-after / why（低基数 reason）。
 */

import { generateApprovalRef, uuidv7 } from '../../../identity/src/domain/approval-ref.js';
import { HUMAN_APPROVERS, isApproverId } from '../../../identity/src/domain/types.js';
import type { Principal } from '../../../identity/src/domain/principal.js';

import { canonicalHash } from '../domain/canonical.js';
import { DomainError } from '../domain/errors.js';
import {
  DECIDABLE_STATUSES,
  foldStatus,
  lastOfType,
  toContractApplication,
  verifyChain,
  type EventDraft,
  type LedgerEvent,
  type StoredApplication,
} from '../domain/ledger.js';
import { evaluate } from '../domain/evaluation.js';
import type {
  Actor,
  ApprovalApplication,
  ApprovalApplicationList,
  ApprovalChange,
  ApprovalDecision,
  ApprovalDecisionRequest,
  ApprovalEvent,
  ApprovalEventList,
  ApprovalFlow,
  ApprovalStatus,
  ApprovalSubject,
  CreateApprovalRequest,
} from '../domain/types.js';
import { actorFromPrincipal } from '../domain/types.js';
import type { ApprovalAuditEvent, ApprovalAuditEventType, DomainStore, ListResult } from '../ports/stores.js';

const APPROVAL_FLOWS: readonly ApprovalFlow[] = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'submitted',
  'evaluated',
  'routed',
  'auto_passed',
  'approved',
  'rejected',
  'expired',
];
// 契约 Actor.kind 仅 human|agent：确定性规则引擎记为 agent 机器身份（非 LLM），
// id 标明组件、model_version = 引擎版本；不入 decided_by（A15 约束）。
const RULE_ENGINE_ACTOR: Actor = { kind: 'agent', id: 'approval-rule-engine', model_version: 'kd-rule-engine/0.1.2' };

export interface ActorContext {
  readonly principal: Principal;
  /** agent 主体的模型版本（x-model-version 头）；human 主体忽略。 */
  readonly modelVersion?: string | undefined;
}

export interface ApprovalListFilter {
  readonly environment?: string | undefined;
  readonly flow?: string | undefined;
  readonly status?: string | undefined;
  readonly applicantId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

function assertActor(value: unknown, path: string): Actor {
  if (typeof value !== 'object' || value === null) {
    throw new DomainError(400, 'validation_failed', {}, [{ path, code: 'required' }]);
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  const id = record['id'];
  const modelVersion = record['model_version'];
  const issues: { path: string; code: string }[] = [];
  if (kind !== 'human' && kind !== 'agent') issues.push({ path: `${path}/kind`, code: 'enum' });
  if (typeof id !== 'string' || id.length < 1 || id.length > 64) issues.push({ path: `${path}/id`, code: 'pattern' });
  if (kind === 'agent' && (typeof modelVersion !== 'string' || modelVersion.length < 1 || modelVersion.length > 64)) {
    issues.push({ path: `${path}/model_version`, code: 'required' });
  }
  if (modelVersion !== undefined && typeof modelVersion !== 'string') {
    issues.push({ path: `${path}/model_version`, code: 'type' });
  }
  if (issues.length > 0) {
    throw new DomainError(400, 'validation_failed', {}, issues);
  }
  return {
    kind,
    id,
    ...(typeof modelVersion === 'string' ? { model_version: modelVersion } : {}),
  } as Actor;
}

function validateCreateRequest(body: unknown): CreateApprovalRequest {
  const issues: { path: string; code: string }[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(400, 'validation_failed', {}, [{ path: '', code: 'type' }]);
  }
  const record = body as Record<string, unknown>;
  const allowed = ['flow', 'applicant', 'subject', 'change', 'beneficiary', 'executor', 'evidence'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push({ path: '/' + key, code: key === 'approval_ref' ? 'INVALID_SYSTEM_FIELD' : 'additional_property' });
    }
  }
  const flow = record['flow'];
  if (typeof flow !== 'string' || !APPROVAL_FLOWS.includes(flow as ApprovalFlow)) {
    issues.push({ path: '/flow', code: 'enum' });
  }
  const subject = record['subject'] as Record<string, unknown> | undefined;
  if (typeof subject !== 'object' || subject === null) {
    issues.push({ path: '/subject', code: 'required' });
  } else {
    const environment = subject['environment'];
    if (environment !== 'dev' && environment !== 'staging' && environment !== 'prod') {
      issues.push({ path: '/subject/environment', code: 'enum' });
    }
    const domain = subject['domain'];
    const domains = ['ops_config', 'rbac', 'identity', 'release', 'export', 'reach', 'other'];
    if (typeof domain !== 'string' || !domains.includes(domain)) {
      issues.push({ path: '/subject/domain', code: 'enum' });
    }
    if (typeof subject['object_id'] !== 'string' || subject['object_id'].length < 1) {
      issues.push({ path: '/subject/object_id', code: 'required' });
    }
  }
  const change = record['change'] as Record<string, unknown> | undefined;
  if (typeof change !== 'object' || change === null) {
    issues.push({ path: '/change', code: 'required' });
  } else {
    const keys = change['keys'];
    if (!Array.isArray(keys) || keys.length < 1 || keys.some((key) => typeof key !== 'string')) {
      issues.push({ path: '/change/keys', code: 'required' });
    }
    if (typeof change['diff_hash'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(change['diff_hash'])) {
      issues.push({ path: '/change/diff_hash', code: 'pattern' });
    }
  }
  if (issues.length > 0) {
    throw new DomainError(400, 'validation_failed', {}, issues);
  }
  const applicant = assertActor(record['applicant'], '/applicant');
  return {
    flow,
    applicant,
    subject: subject as unknown as ApprovalSubject,
    change: change as unknown as ApprovalChange,
    ...(record['beneficiary'] !== undefined ? { beneficiary: assertActor(record['beneficiary'], '/beneficiary') } : {}),
    ...(record['executor'] !== undefined ? { executor: assertActor(record['executor'], '/executor') } : {}),
    ...(record['evidence'] !== undefined ? { evidence: record['evidence'] } : {}),
  } as CreateApprovalRequest;
}

function validateDecisionRequest(body: unknown): ApprovalDecisionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(400, 'validation_failed', {}, [{ path: '', code: 'type' }]);
  }
  const record = body as Record<string, unknown>;
  const issues: { path: string; code: string }[] = [];
  for (const key of Object.keys(record)) {
    if (!['decision', 'reason', 'evidence_refs'].includes(key)) {
      issues.push({ path: '/' + key, code: 'additional_property' });
    }
  }
  const decision = record['decision'];
  if (decision !== 'approved' && decision !== 'rejected') {
    issues.push({ path: '/decision', code: 'enum' });
  }
  const reason = record['reason'];
  if (typeof reason !== 'string' || reason.length < 8 || reason.length > 500) {
    issues.push({ path: '/reason', code: 'pattern' });
  }
  const refs = record['evidence_refs'];
  if (refs !== undefined && (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string'))) {
    issues.push({ path: '/evidence_refs', code: 'type' });
  }
  if (issues.length > 0) {
    throw new DomainError(400, 'validation_failed', {}, issues);
  }
  return record as unknown as ApprovalDecisionRequest;
}

function toContractEvent(event: LedgerEvent): ApprovalEvent {
  return {
    event_id: event.eventId,
    approval_ref: event.approvalRef,
    type: event.type,
    at: event.at,
    ...(event.actor !== null ? { actor: event.actor } : {}),
    ...(event.evaluation !== null ? { evaluation: event.evaluation } : {}),
    ...(event.decision !== null ? { decision: event.decision } : {}),
    ...(event.note !== null ? { note: event.note } : {}),
  };
}

export class ApprovalService {
  constructor(
    private readonly store: DomainStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** 绑定到事务存储的同参实例（submit 在事务内建单时用：建单+绑定同一事务）。 */
  withStore(store: DomainStore): ApprovalService {
    return new ApprovalService(store, this.now);
  }

  private async auditEvent(
    eventType: ApprovalAuditEventType,
    actor: Actor,
    subjectId: string,
    before: unknown,
    after: unknown,
    reason: string,
    approvalRef: string | null,
    store: DomainStore = this.store,
  ): Promise<void> {
    const event: ApprovalAuditEvent = {
      eventId: `aud_${uuidv7()}`,
      eventType,
      occurredAt: this.now(),
      actor,
      subjectKind: 'approval',
      subjectId,
      before,
      after,
      reason,
      approvalRef,
    };
    await store.audit(event);
  }

  private async loadOrThrow(approvalRef: string): Promise<{ application: StoredApplication; events: LedgerEvent[] }> {
    const record = await this.store.getApplication(approvalRef);
    if (record === null) {
      throw new DomainError(404, 'not_found');
    }
    // 账本完整性自检：断链即停用该单（approvals/README.md：账本损坏 → 停用 + 上报）。
    // 500 INTERNAL_ERROR 出壳进日志/告警：fail-closed，不静默修复、不返回损坏内容。
    if (!verifyChain(record.events)) {
      throw new DomainError(500, 'ledger_integrity_failure', { approvalRef });
    }
    return record;
  }

  async create(input: {
    body: unknown;
    idempotencyKey: string;
    actorContext: ActorContext;
  }): Promise<{ application: ApprovalApplication; replayed: boolean }> {
    // agent 主体缺/空 x-model-version → 写前 400（不得以 unknown 落审计；human 主体不受影响）。
    const auditActor = actorFromPrincipal(input.actorContext.principal, input.actorContext.modelVersion);
    const requestHash = canonicalHash(input.body);
    const scope = 'approval.create';
    const existing = await this.store.findIdempotent(scope, input.idempotencyKey);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw new DomainError(409, 'idempotency_key_mismatch');
      }
      return { application: existing.response as ApprovalApplication, replayed: true };
    }

    const request = validateCreateRequest(input.body);
    const now = this.now();
    const approvalRef = generateApprovalRef();
    const application: StoredApplication = {
      approvalRef,
      applicationId: `app_${uuidv7()}`,
      flow: request.flow,
      status: 'submitted',
      applicant: request.applicant,
      beneficiary: request.beneficiary ?? null,
      executor: request.executor ?? null,
      subject: request.subject,
      change: request.change,
      evidence: request.evidence ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const draft: EventDraft = {
      eventId: `evt_${uuidv7()}`,
      approvalRef,
      type: 'created',
      at: now,
      actor: request.applicant,
      evaluation: null,
      decision: null,
      note: null,
    };
    const contractApplication = toContractApplication(application, null, null);
    // 单据 + 幂等 + 留痕同一事务：任一步失败整体回滚（不留无幂等记录的孤儿单）。
    await this.store.transaction(async (tx) => {
      await tx.insertApplicationWithCreatedEvent({ application, event: draft });
      await tx.putIdempotent({
        scope,
        key: input.idempotencyKey,
        requestHash,
        approvalRef,
        response: contractApplication,
        createdAt: now,
      });
      // 留痕：audit actor = token 主体（谁发起的操作），created 事件 actor = 单据 applicant（单据归属）。
      await this.auditEvent(
        'approval_created',
        auditActor,
        approvalRef,
        null,
        contractApplication,
        'create',
        approvalRef,
        tx,
      );
    });
    return { application: contractApplication, replayed: false };
  }

  async list(filter: ApprovalListFilter): Promise<ApprovalApplicationList> {
    const result: ListResult<StoredApplication> = await this.store.listApplications({
      environment: filter.environment as never,
      flow: filter.flow as never,
      status: filter.status as never,
      applicantId: filter.applicantId,
      from: filter.from,
      to: filter.to,
      limit: filter.limit,
      cursor: filter.cursor,
    });
    const items = result.items.map((app) => toContractApplication(app, null, null));
    return { items, next_cursor: result.nextCursor };
  }

  async get(approvalRef: string): Promise<ApprovalApplication> {
    const { application, events } = await this.loadOrThrow(approvalRef);
    const evaluationEvent = lastOfType(events, 'evaluated');
    const decisionEvent =
      lastOfType(events, 'approved') ?? lastOfType(events, 'rejected') ?? lastOfType(events, 'auto_passed');
    return toContractApplication(
      application,
      evaluationEvent?.evaluation ?? null,
      decisionEvent?.decision ?? null,
    );
  }

  async evaluateApproval(approvalRef: string, actorContext: ActorContext): Promise<ApprovalApplication> {
    const { application, events } = await this.loadOrThrow(approvalRef);
    const status = foldStatus(events);
    if (!DECIDABLE_STATUSES.includes(status)) {
      throw new DomainError(409, 'approval_state_conflict', { approvalRef, currentStatus: status });
    }
    const evidence = application.evidence as { policy_version?: unknown } | null;
    const policyVersion = typeof evidence?.policy_version === 'string' ? evidence.policy_version : undefined;
    const evaluation = evaluate({
      flow: application.flow,
      subject: application.subject,
      change: application.change,
      policyVersion,
      evaluatedAt: this.now(),
    });
    const draft: EventDraft = {
      eventId: `evt_${uuidv7()}`,
      approvalRef,
      type: 'evaluated',
      at: this.now(),
      actor: RULE_ENGINE_ACTOR,
      evaluation,
      decision: null,
      note: null,
    };
    // 评估事件 + 留痕同一事务：失败整体回滚（不出现无留痕的 evaluated 状态）。
    await this.store.transaction(async (tx) => {
      await tx.appendEvent(approvalRef, draft);
      await this.auditEvent(
        'approval_evaluated',
        RULE_ENGINE_ACTOR,
        approvalRef,
        { status },
        { status: 'evaluated', decision: evaluation.decision },
        'evaluate',
        approvalRef,
        tx,
      );
    });
    return this.get(approvalRef);
  }

  async decide(input: {
    approvalRef: string;
    body: unknown;
    idempotencyKey: string;
    actorContext: ActorContext;
  }): Promise<ApprovalDecision> {
    const { application } = await this.loadOrThrow(input.approvalRef);
    const approver = input.actorContext.principal.userId;
    // N1：人类审批人强制（服务端），agent/A15 一律 403；decided_by 从 token 推导，不取请求体。
    if (!isApproverId(approver) || !HUMAN_APPROVERS.includes(approver)) {
      throw new DomainError(403, 'approver_not_human');
    }
    if (application.applicant.id === approver) {
      throw new DomainError(403, 'self_approval');
    }
    const request = validateDecisionRequest(input.body);
    const requestHash = canonicalHash(input.body);
    const scope = `approval.decide:${input.approvalRef}`;
    // 幂等重放必须先于状态检查：已决定后同 key 重放仍返回原决定。
    const existing = await this.store.findIdempotent(scope, input.idempotencyKey);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw new DomainError(409, 'idempotency_key_mismatch');
      }
      return existing.response as ApprovalDecision;
    }
    const { events } = await this.loadOrThrow(input.approvalRef);
    const status = foldStatus(events);
    if (!DECIDABLE_STATUSES.includes(status)) {
      throw new DomainError(409, 'already_decided', { approvalRef: input.approvalRef, currentStatus: status });
    }

    const decidedAt = this.now();
    const decidedBy: Actor = { kind: 'human', id: approver };
    const decision: ApprovalDecision = {
      approval_ref: input.approvalRef,
      decision: request.decision,
      decided_by: decidedBy,
      decided_at: decidedAt,
      reason: request.reason,
    };
    const draft: EventDraft = {
      eventId: `evt_${uuidv7()}`,
      approvalRef: input.approvalRef,
      type: request.decision === 'approved' ? 'approved' : 'rejected',
      at: decidedAt,
      actor: decidedBy,
      evaluation: null,
      decision,
      note: null,
    };
    // 决定事件 + 幂等 + 留痕同一事务：失败整体回滚（账本与审计一致）。
    await this.store.transaction(async (tx) => {
      await tx.appendEvent(input.approvalRef, draft);
      await tx.putIdempotent({
        scope,
        key: input.idempotencyKey,
        requestHash,
        approvalRef: input.approvalRef,
        response: decision,
        createdAt: decidedAt,
      });
      await this.auditEvent(
        'approval_decided',
        decidedBy,
        input.approvalRef,
        { status },
        { status: request.decision === 'approved' ? 'approved' : 'rejected', decision },
        request.decision === 'approved' ? 'decide_approve' : 'decide_reject',
        input.approvalRef,
        tx,
      );
    });
    return decision;
  }

  async events(approvalRef: string, limit: number, cursor?: string | undefined): Promise<ApprovalEventList> {
    const { events } = await this.loadOrThrow(approvalRef);
    // cursor = 上一页末 seq（十进制字符串）；NaN/科学计数法等畸形值 → 400（不得静默翻空页）。
    if (cursor !== undefined && !/^[0-9]{1,15}$/.test(cursor)) {
      throw new DomainError(400, 'validation_failed', {}, [
        { path: '/cursor', code: 'pattern', message: 'cursor 必须是上一页返回的十进制 seq。' },
      ]);
    }
    const startSeq = cursor !== undefined ? Number.parseInt(cursor, 10) + 1 : 1;
    const page = events.filter((event) => event.seq >= startSeq);
    const items = page.slice(0, limit).map(toContractEvent);
    const lastIncluded = page[items.length - 1];
    return {
      items,
      next_cursor: page.length > limit && lastIncluded !== undefined ? String(lastIncluded.seq) : null,
    };
  }

  /** 回滚放行检查：approval_ref 可解析到具名账本记录 + approved + 绑定本 config（决定不可复用）。 */
  async assertApprovedFor(approvalRef: string, configId: string): Promise<StoredApplication> {
    const { application, events } = await this.loadOrThrow(approvalRef);
    const status = foldStatus(events);
    if (status !== 'approved' || application.subject.object_id !== configId) {
      throw new DomainError(409, 'approval_state_conflict', { approvalRef, currentStatus: status });
    }
    return application;
  }

  /** config 域放行检查（publish/rollback）：approval_ref 必须可解析、approved、绑定一致。 */
  async requireApprovedBinding(input: {
    approvalRef: string;
    purpose: 'config_publish' | 'config_rollback';
    configId: string;
    environment: string;
    version: number;
    policyVersion: string;
  }): Promise<void> {
    const { events } = await this.loadOrThrow(input.approvalRef);
    const status = foldStatus(events);
    if (status !== 'approved') {
      throw new DomainError(409, 'approval_state_conflict', {
        approvalRef: input.approvalRef,
        currentStatus: status,
      });
    }
    const binding = await this.store.getBinding(input.approvalRef);
    if (binding === null) {
      throw new DomainError(409, 'approval_ref_unresolvable', { approvalRef: input.approvalRef });
    }
    if (
      binding.purpose !== input.purpose ||
      binding.configId !== input.configId ||
      binding.environment !== input.environment ||
      binding.version !== input.version
    ) {
      throw new DomainError(409, 'approval_state_conflict', {
        approvalRef: input.approvalRef,
        currentStatus: status,
      });
    }
    if (input.purpose === 'config_publish' && binding.policyVersion !== input.policyVersion) {
      throw new DomainError(400, 'policy_version_mismatch');
    }
    if (binding.consumedAt !== null) {
      // 一 ref 发布恰一次 / 决定不可复用。
      throw new DomainError(409, 'approval_ref_reuse', { approvalRef: input.approvalRef, currentStatus: status });
    }
  }
}
