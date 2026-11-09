import type {
  Actor,
  ApprovalItemView,
  AuditEvent,
  ChangeRequest,
  ConfigItemDef,
  ConfigState,
  ConfigValues,
  DraftConfig,
  ImpactScope,
  PublishedConfig,
  Release,
  ValidationIssue,
} from '../domain/types';

/**
 * 端口（Port）层：页面依赖此处接口，不感知 mock/http 差异。
 *
 * 实现状态：
 * - Config Service：契约 contracts/config/openapi.yaml 已落地（A0），适配层 src/mocks/backend.ts（MockBackend，本地开发 fallback）+ src/adapters/http-config-service.ts（HttpConfigService，?backend=http 运行时切换）。
 * - Approval API：契约 contracts/approval/openapi.yaml 已落地（A0/A4），适配层 src/mocks/backend.ts + src/adapters/http-approval-service.ts。
 * - AuditSink：identity 域审计事件端口，当前 HTTP 适配层返回空数组（identity 侧事件读接口待 A4 暴露）。
 * - 切换入口：web/console/src/adapters/index.ts createHttpConsoleServices()；App.tsx bootstrapServices() URL ?backend=http&baseUrl=/v1&environment=dev 启用真契约。
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
  /** 变更说明（契约 SubmitRequest.change_reason，8–200 字；HTTP 适配器使用）。 */
  changeReason?: string;
  /** 变更影响面（契约 impact_scope，1–6 个不重复枚举值；HTTP 适配器使用）。 */
  impactScope?: readonly ImpactScope[];
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
  /** 契约 SubmitRequest.change_reason（8–200 字，HTTP 适配器必填；Mock 容忍缺省）。 */
  changeReason?: string;
  /** 契约 SubmitRequest.impact_scope（1–6 枚举，HTTP 适配器必填；Mock 容忍缺省）。 */
  impactScope?: readonly ImpactScope[];
}

export interface PublishInput {
  itemId: string;
  changeRequestId: string;
  actor: Actor;
  diffAcknowledged: boolean;
  /** 灰度百分比（契约 canary_percent，1–10 必填；HTTP 适配器使用，缺省取 options.canaryPercent）。 */
  canaryPercent?: number;
  /** 发布说明（契约 release_notes，≤500 字，可选）。 */
  releaseNotes?: string;
}

export interface RollbackInput {
  itemId: string;
  /** 回滚目标 release 的 version。 */
  targetVersion: number;
  actor: Actor;
  diffAcknowledged: boolean;
  reason: string;
  /** T6 审批单号（契约 RollbackRequest.approval_ref 必填；HTTP 适配器使用）。 */
  approvalRef?: string;
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
