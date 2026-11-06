/**
 * 审批账本（approvals/README.md = 账本规则真源，A9 拥有；实现在 A4 services/approval/）：
 *   - 账本 append-only（UPDATE/DELETE 无授权）；更正 = 追加新事件 + note 指向旧事件；
 *   - current status = 事件 fold 的投影（不存权威）；本文件是 fold 的单一实现；
 *   - per-approval_ref seq 连续 + hash 链（prev_event_hash/event_hash），断链 = 账本损坏 → 停用该单 + 上报；
 *   - approved/rejected 事件的 actor.kind 必须 human；auto_passed 只能来自确定性规则引擎（非 LLM）；
 *   - 审批决定不可复用：撤回/驳回/过期后重提 = 新建单（R9）。
 */

import type { Actor, ApprovalApplication, ApprovalEvaluation, ApprovalDecision, ApprovalStatus } from './types.js';
import type { ApprovalChange, ApprovalSubject, ApprovalFlow } from './types.js';
import { canonicalHash } from './canonical.js';

export type ApprovalEventType =
  | 'created'
  | 'evaluated'
  | 'routed'
  | 'auto_passed'
  | 'approved'
  | 'rejected'
  | 'expired';

export const APPROVAL_EVENT_TYPES: readonly ApprovalEventType[] = [
  'created',
  'evaluated',
  'routed',
  'auto_passed',
  'approved',
  'rejected',
  'expired',
];

export const GENESIS_HASH = '0'.repeat(64);

/** 账本事件（对外剥掉 seq/prev_event_hash/event_hash 再映射契约 ApprovalEvent）。 */
export interface LedgerEvent {
  readonly eventId: string;
  readonly approvalRef: string;
  readonly seq: number;
  readonly type: ApprovalEventType;
  readonly at: string;
  readonly actor: Actor | null;
  readonly evaluation: ApprovalEvaluation | null;
  readonly decision: ApprovalDecision | null;
  readonly note: string | null;
  readonly prevEventHash: string;
  readonly eventHash: string;
}

/** applications 表行（折叠投影含 status 列，仅服务查询过滤）。 */
export interface StoredApplication {
  readonly approvalRef: string;
  readonly applicationId: string;
  readonly flow: ApprovalFlow;
  readonly status: ApprovalStatus;
  readonly applicant: Actor;
  readonly beneficiary: Actor | null;
  readonly executor: Actor | null;
  readonly subject: ApprovalSubject;
  readonly change: ApprovalChange;
  readonly evidence: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const STATUS_BY_EVENT: Record<ApprovalEventType, ApprovalStatus> = {
  created: 'submitted',
  evaluated: 'evaluated',
  routed: 'routed',
  auto_passed: 'auto_passed',
  approved: 'approved',
  rejected: 'rejected',
  expired: 'expired',
};

/** fold：current status = 末事件类型投影（空账本无单可查，不出现）。 */
export function foldStatus(events: readonly LedgerEvent[]): ApprovalStatus {
  const last = events[events.length - 1];
  if (last === undefined) {
    throw new Error('foldStatus: empty ledger');
  }
  return STATUS_BY_EVENT[last.type];
}

export function lastOfType(events: readonly LedgerEvent[], type: ApprovalEventType): LedgerEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.type === type) {
      return event;
    }
  }
  return null;
}

export type HashableEvent = Omit<LedgerEvent, 'eventHash'>;

/** 追加前的事件草稿：seq / prev_event_hash / event_hash 由存储层按链计算。 */
export type EventDraft = Omit<LedgerEvent, 'eventHash' | 'prevEventHash' | 'seq'>;

/** event_hash = sha256(规范化 JSON({eventId, approvalRef, seq, type, at, actor, evaluation, decision, note, prevEventHash}))。 */
export function computeEventHash(event: HashableEvent): string {
  return canonicalHash({
    eventId: event.eventId,
    approvalRef: event.approvalRef,
    seq: event.seq,
    type: event.type,
    at: event.at,
    actor: event.actor,
    evaluation: event.evaluation,
    decision: event.decision,
    note: event.note,
    prevEventHash: event.prevEventHash,
  });
}

/** seq 连续 + hash 链校验；断链即账本损坏（停用该单 + 上报，不静默修复）。 */
export function verifyChain(events: readonly LedgerEvent[]): boolean {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined || event.seq !== i + 1 || event.prevEventHash !== prev) {
      return false;
    }
    const { eventHash, ...rest } = event;
    if (computeEventHash(rest) !== eventHash) {
      return false;
    }
    prev = eventHash;
  }
  return true;
}

/** 可下决定的非终态（approved/rejected/expired/auto_passed 均不可再决定）。 */
export const DECIDABLE_STATUSES: readonly ApprovalStatus[] = ['submitted', 'evaluated', 'routed'];

export function toContractApplication(
  app: StoredApplication,
  evaluation: ApprovalEvaluation | null,
  decision: ApprovalDecision | null,
): ApprovalApplication {
  const base = {
    approval_ref: app.approvalRef,
    application_id: app.applicationId,
    flow: app.flow,
    status: app.status,
    applicant: app.applicant,
    subject: app.subject,
    change: app.change,
    created_at: app.createdAt,
    ...(app.beneficiary !== null ? { beneficiary: app.beneficiary } : {}),
    ...(app.executor !== null ? { executor: app.executor } : {}),
    ...(app.evidence !== undefined && app.evidence !== null ? { evidence: app.evidence } : {}),
    ...(evaluation !== null ? { evaluation } : {}),
    ...(decision !== null ? { decision } : {}),
  };
  return base as ApprovalApplication;
}
