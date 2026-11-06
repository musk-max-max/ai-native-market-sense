/**
 * 契约线格式（wire types）——只描述 HTTP 上真实收发的形状。
 * 与 contracts/config/openapi.yaml、contracts/approval/openapi.yaml 一一对应；
 * web/console/test/http-adapter.test.ts 用 tests/contract/specimens/provider/*.json
 * 对照这些形状（A8 契约测试门禁）。
 *
 * 只声明 adapter 读/写的字段；响应里契约允许的额外字段（如 meta 细节）原样忽略。
 * ⚠️ 与契约的对应关系以 CONTRACT-MAP.md 为准；改这里前先看契约 diff（h2-arch 终审）。
 */

export type Environment = 'dev' | 'staging' | 'prod';
export type ImpactScope =
  | 'column_layout'
  | 'content_copy'
  | 'content_placement'
  | 'ranking'
  | 'rotation'
  | 'visibility';

/* ---------- contracts/config/openapi.yaml ---------- */

export interface WireActor {
  kind: 'human' | 'agent';
  id: string;
  model_version?: string;
}

export interface WireReleaseMeta {
  release_id: string;
  published_at: string;
  approval_ref: string;
  content_hash: string;
  schema_version: '0.1';
  policy_version: string;
}

export interface WireSystemMeta {
  created_at?: string;
  updated_at?: string;
  created_by?: WireActor;
  published_release?: WireReleaseMeta;
}

export interface WireColumn {
  id: string;
  title: string;
  subtitle?: string;
  order: number;
  visible?: boolean;
  max_items?: number;
}

export interface WireContentItem {
  id: string;
  kind: 'editorial' | 'data_card' | 'banner';
  column_id: string;
  order: number;
  visible?: boolean;
  content_ref?: string;
  asset_ref?: string;
  display_title?: string;
  summary?: string;
  target_route?: string;
  display_window?: { start_at: string; end_at: string; timezone?: string };
}

export interface WireRankingStrategy {
  type: 'ranking';
  id: string;
  metric_id: string;
  metric_label: string;
  universe: 'all_a' | 'main_board';
  /** 契约修订：枚举是 d1/d5/d20（不是 1d/5d/20d）。 */
  window: 'd1' | 'd5' | 'd20';
  limit: number;
  title_template: string;
  schedule?: 'eod' | 'manual';
  /** const false：策略不得个性化（红线）。 */
  personalized: false;
  enabled?: boolean;
}

export interface WireRotationStrategy {
  type: 'rotation';
  id: string;
  max_items: number;
  interval_seconds: number;
  enabled?: boolean;
}

export type WireStrategy = WireRankingStrategy | WireRotationStrategy;

/** OpsSpec 三数组均 required（PUT 必须提交完整文档，即使只改一个标量）。 */
export interface WireOpsSpec {
  columns: WireColumn[];
  content_items: WireContentItem[];
  strategies: WireStrategy[];
}

/** GET/PUT 顶层体（OpsConfigDocument）。 */
export interface WireOpsConfigDocument {
  schema_version: '0.1';
  config_id: string;
  environment: Environment;
  version: number;
  status: 'draft' | 'published';
  change_reason: string;
  impact_scope: ImpactScope[];
  spec: WireOpsSpec;
  meta?: WireSystemMeta;
}

/** 请求体（OpsConfigWrite）：version/status/meta 由服务端维护，携带即 400。 */
export interface WireOpsConfigWrite {
  schema_version: '0.1';
  config_id: string;
  environment: Environment;
  change_reason: string;
  impact_scope: ImpactScope[];
  spec: WireOpsSpec;
}

export interface WireValidationIssue {
  /** JSON Pointer（如 /spec/columns/0/order），直接当表单字段定位。 */
  path: string;
  code: string;
  message: string;
}

export interface WireValidationReport {
  valid: boolean;
  structural_errors: WireValidationIssue[];
  semantic_errors: WireValidationIssue[];
  normalized_hash?: string;
}

export interface WireSubmitRequest {
  change_reason: string;
  impact_scope: ImpactScope[];
  expected_version: number;
  /** T3 文案审批必填；服务端校验与当前已签 policy 一致。 */
  policy_version?: string;
}

/** submit 返回；approval_ref 只能服务端生成（请求体不接受该字段）。 */
export interface WireApprovalSubmission {
  approval_ref: string;
  application_id: string;
  flow: 't1' | 't3';
  status: 'submitted';
  submitted_at: string;
}

export interface WirePublishRequest {
  approval_ref: string;
  expected_version: number;
  /** 灰度 1–10；无全量字段（全量请求不存在，而不是被忽略）。 */
  canary_percent: number;
  release_notes?: string;
}

export interface WireRollbackRequest {
  target_release_id: string;
  approval_ref: string;
  reason?: string;
}

export interface WireRelease {
  release_id: string;
  config_id: string;
  environment: Environment;
  /** = expected_version，不递增；UI 的 vN 来自 config version。 */
  version: number;
  schema_version: '0.1';
  policy_version: string;
  content_hash: string;
  published_at: string;
  approval_ref: string;
  canary_percent: number;
  release_notes?: string;
}

export interface WireRollback {
  config_id: string;
  environment: Environment;
  release_id: string;
  previous_release_id: string;
  approval_ref: string;
  rolled_back_at: string;
}

export interface WireFieldChange {
  path: string;
  kind: 'added' | 'removed' | 'modified';
  base?: unknown;
  current?: unknown;
  submitted?: unknown;
}

export interface WireFieldConflict {
  path: string;
  reason: 'both_modified' | 'base_removed_current_modified' | 'base_modified_current_removed';
  base?: unknown;
  current?: unknown;
  submitted?: unknown;
}

export interface WireThreeWayDiff {
  config_id: string;
  environment: Environment;
  base_version: number;
  current_version: number;
  submitted_version: number;
  changes: WireFieldChange[];
  conflicts: WireFieldConflict[];
}

/** shared Problem（400/409/412 均为 Problem(+json)）。 */
export interface WireProblem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  trace_id?: string;
  /** VALIDATION_ERROR 时按 JSON Pointer 定位字段错误。 */
  errors?: WireValidationIssue[];
}

/** 409 ConfigConflictProblem：required=[type,title,status,code,diff]。 */
export interface WireConfigConflictProblem extends WireProblem {
  diff: WireThreeWayDiff;
}

/* ---------- contracts/approval/openapi.yaml ---------- */

export type WireApprovalFlow = 't1' | 't2' | 't3' | 't4' | 't5' | 't6' | 't7';
export type WireApprovalStatus =
  | 'submitted'
  | 'evaluated'
  | 'routed'
  | 'auto_passed'
  | 'approved'
  | 'rejected'
  | 'expired';

export interface WireApprovalSubject {
  environment: Environment;
  domain: 'ops_config' | 'rbac' | 'identity' | 'release' | 'export' | 'reach' | 'other';
  object_id: string;
  path?: string;
  diff_hash?: string;
}

export interface WireApprovalChange {
  keys: string[];
  diff_hash: string;
  before?: unknown;
  after?: unknown;
}

export interface WireApprovalApplication {
  approval_ref: string;
  application_id: string;
  flow: WireApprovalFlow;
  status: WireApprovalStatus;
  applicant: WireActor;
  beneficiary?: WireActor;
  executor?: WireActor;
  subject: WireApprovalSubject;
  change: WireApprovalChange;
  evidence?: Record<string, unknown>;
  created_at: string;
  decision?: WireApprovalDecision;
}

export interface WireApprovalDecisionRequest {
  decision: 'approved' | 'rejected';
  /** 8–500；「通过」也必填（合规留痕）。 */
  reason: string;
  evidence_refs?: string[];
}

export interface WireApprovalDecision {
  approval_ref: string;
  decision: 'approved' | 'rejected';
  decided_by: WireActor;
  decided_at: string;
  reason: string;
}

export interface WireApprovalEvent {
  event_id: string;
  approval_ref: string;
  type: 'created' | 'evaluated' | 'routed' | 'auto_passed' | 'approved' | 'rejected' | 'expired';
  at: string;
  actor?: WireActor;
  decision?: WireApprovalDecision;
  note?: string;
}

/** 列表响应统一信封（无 data/meta 信封，items 直挂顶层）。 */
export interface WireList<T> {
  items: T[];
  next_cursor?: string | null;
}
