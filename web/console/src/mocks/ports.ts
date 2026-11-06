import type {
  Actor,
  ApprovalItemView,
  AuditEvent,
  ChangeRequest,
  ConfigItemDef,
  ConfigState,
  ConfigValues,
  DraftConfig,
  PublishedConfig,
  Release,
  ValidationIssue,
} from '../domain/types';

/**
 * 中后台适配层端口（Port）。
 *
 * ⚠️ 目前全部由 src/mocks/backend.ts 的 MockBackend 实现：
 * - Config Service 契约未定（A0 负责，contracts/ 暂无 config-service.openapi.yaml）
 * - Approval API 契约未定（A0/A4，services/identity 刻意未暴露审批 HTTP 入口）
 * TODO(A8/A0)：两张契约落地后，新增 src/adapters/http-config-service.ts 实现同一 Port，
 * 页面只依赖本文件的接口，不感知 mock/http 差异。
 */

export interface ConfigItemSummary {
  item: ConfigItemDef;
  publishedVersion: number;
  publishedAt: string;
  draft: DraftConfig | null;
  pendingApprovals: number;
}

export interface ConfigItemDetail extends ConfigItemSummary {
  published: PublishedConfig;
  releases: Release[];
}

export interface SaveDraftInput {
  itemId: string;
  /** 客户端基于哪个 published version 编辑（If-Match）。 */
  expectedVersion: number;
  values: ConfigValues;
  actor: Actor;
}

export interface ConflictPayload {
  /** 客户端编辑时的基准（服务端用 release 历史还原）。 */
  base: ConfigValues;
  /** 本次提交的草稿值。 */
  mine: ConfigValues;
  /** 服务端当前 published 值。 */
  theirs: ConfigValues;
  currentVersion: number;
  message: string;
}

export type SaveDraftOutcome =
  | { ok: true; draft: DraftConfig; issues: readonly ValidationIssue[] }
  | { ok: false; kind: 'conflict'; conflict: ConflictPayload }
  | { ok: false; kind: 'locked'; message: string }
  | { ok: false; kind: 'invalid'; issues: readonly ValidationIssue[] };

export interface ValidationOutcome {
  ok: boolean;
  state: ConfigState;
  issues: readonly ValidationIssue[];
}

export interface SubmitApprovalInput {
  itemId: string;
  actor: Actor;
  /** 必须已查看 before/after diff + 影响范围（硬约束）。 */
  diffAcknowledged: boolean;
  note?: string;
}

export interface PublishInput {
  itemId: string;
  changeRequestId: string;
  actor: Actor;
  diffAcknowledged: boolean;
}

export interface RollbackInput {
  itemId: string;
  /** 回滚目标 release 的 version。 */
  targetVersion: number;
  actor: Actor;
  diffAcknowledged: boolean;
  reason: string;
}

export interface ApproveInput {
  changeRequestId: string;
  actor: Actor;
  approvalRef: string;
  diffAcknowledged: boolean;
  note?: string;
}

export interface RejectInput {
  changeRequestId: string;
  actor: Actor;
  reason: string;
}

/** 配置服务端口（未来由 Config Service 提供）。 */
export interface ConfigServicePort {
  list(): Promise<ConfigItemSummary[]>;
  get(itemId: string): Promise<ConfigItemDetail>;
  saveDraft(input: SaveDraftInput): Promise<SaveDraftOutcome>;
  validate(itemId: string, actor: Actor): Promise<ValidationOutcome>;
  submitForApproval(input: SubmitApprovalInput): Promise<ChangeRequest>;
  publish(input: PublishInput): Promise<Release>;
  rollback(input: RollbackInput): Promise<Release>;
  listReleases(itemId: string): Promise<Release[]>;
}

/**
 * 审批服务端口（未来由 Approval API 提供）。
 * 单条审批是 API 约束：这里刻意没有 batch/approveMany 方法，UI 不提供批量按钮。
 */
export interface ApprovalServicePort {
  listPending(): Promise<ApprovalItemView[]>;
  approve(input: ApproveInput): Promise<ChangeRequest>;
  reject(input: RejectInput): Promise<ChangeRequest>;
}

export interface AuditPort {
  listAudit(): Promise<AuditEvent[]>;
}

export class ConfigGateError extends Error {
  readonly code:
    | 'LOCKED'
    | 'NOT_FOUND'
    | 'NOT_VALIDATED'
    | 'INVALID'
    | 'DIFF_NOT_ACKNOWLEDGED'
    | 'STATE'
    | 'NO_DRAFT'
    | 'NO_APPROVAL'
    | 'NO_CHANGE'
    | 'VERSION_NOT_FOUND';

  constructor(code: ConfigGateError['code'], message: string) {
    super(message);
    this.name = 'ConfigGateError';
    this.code = code;
  }
}

export class ApprovalAuthorityError extends Error {
  readonly code: 'AGENT_CANNOT_FINAL_APPROVE' | 'HUMAN_ONLY' | 'APPROVAL_REF_REQUIRED' | 'STATE';

  constructor(code: ApprovalAuthorityError['code'], message: string) {
    super(message);
    this.name = 'ApprovalAuthorityError';
    this.code = code;
  }
}
