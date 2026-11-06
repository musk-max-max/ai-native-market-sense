/**
 * A8 中后台领域模型（四中台共享）。
 *
 * 来源约束：
 * - 决策 #6（agents/decisions.md:124）：version + If-Match 乐观锁；冲突 409 + 三点 diff；
 *   draft/published 双态；publish 生成不可变 release。
 * - H6 配置边界（decisions.md:146）：16 项分 C0–C4 五级；免责声明 / AI 标识 / as_of /
 *   退订入口 / 风险提示 / 话术白名单 = 不可配，界面不渲染入口。
 * - ADR-008：内部员工与 agent 走同一条 草稿→校验→审批→发布 链路；来源以
 *   identity.AuditSink 的 actor{kind,id,modelVersion} 为准。
 *
 * 本文件只放类型与常量，不放 React / 网络。
 */

/** 操作来源：人类员工 or agent。两者必须可区分，且都要落审计。 */
export type ActorKind = 'human' | 'agent';

export interface Actor {
  kind: ActorKind;
  /** 人类工号 / agent 编号（如 H2、A15）。 */
  id: string;
  /** agent 必填：产生本次操作的是哪次模型运行（可追溯到 run）。 */
  modelVersion?: string;
  /** agent 运行 id，审计时与 modelVersion 一起定位“哪次模型运行”。 */
  runId?: string;
}

/** 配置分级：C0 最轻，C4 最重（H6 五级分类）。 */
export type ConfigLevel = 'C0' | 'C1' | 'C2' | 'C3' | 'C4';

/** 中后台四个域（四合一）。 */
export type ConsoleDomain = 'ops' | 'compliance' | 'admin' | 'crm';

/** 单个配置字段的取值。数组用于有序列表（如话术条目，但不包括不可配的话术白名单）。 */
export type ConfigValue = string | number | boolean | readonly string[] | null;

/** 一份配置快照的字段值集合。 */
export type ConfigValues = Readonly<Record<string, ConfigValue>>;

export type ConfigFieldKind = 'text' | 'number' | 'boolean' | 'enum' | 'string-list';

export interface ConfigFieldDef {
  key: string;
  label: string;
  level: ConfigLevel;
  kind: ConfigFieldKind;
  /** 给运营看的说明：改这个字段会影响什么。 */
  help: string;
  /** enum 的候选值。 */
  options?: readonly string[];
  /** 受影响的 C 端页面/内部页面，用于 DiffViewer 的影响面面板。 */
  affects?: readonly string[];
  /** number 字段约束（校验层复用）。 */
  min?: number;
  max?: number;
  integer?: boolean;
  /** 文本字段是否必填。 */
  required?: boolean;
  /** 文本字段允许的前缀（如站内路径 /、https://）。 */
  allowedPrefixes?: readonly string[];
}

export interface ConfigItemDef {
  id: string;
  title: string;
  domain: ConsoleDomain;
  level: ConfigLevel;
  /** 是否可配置。false = 合规锁定项，界面不得渲染任何入口。 */
  editable: boolean;
  /** 锁定原因（只读说明，不可编辑）。 */
  lockedReason?: string;
  /** 锁定项的依据（决策/ADR 引用），用于合规中台展示。 */
  lockedBy?: string;
  fields: readonly ConfigFieldDef[];
  /** C2 及以上必须人类审批；C0/C1 允许规则引擎低风险自动放行（C1=A）。 */
  requireHumanApproval: boolean;
}

/** 配置项生命周期状态（前端不得跳步，服务端二次校验）。 */
export type ConfigState =
  | 'draft'
  | 'validated'
  | 'pending_approval'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'rolled_back';

export interface DraftConfig {
  itemId: string;
  /** 草稿基于哪个 published version（If-Match 的基准）。 */
  baseVersion: number;
  values: ConfigValues;
  state: ConfigState;
  updatedBy: Actor;
  updatedAt: string;
}

export interface PublishedConfig {
  itemId: string;
  version: number;
  values: ConfigValues;
  publishedAt: string;
  releaseId: string;
}

/** 发布授权：人类审批 or 规则引擎低风险自动放行（A15 无终审权，C1=A）。 */
export type ReleaseAuthorization =
  | {
      kind: 'human_approval';
      approvalRef: string;
      approver: Actor;
      changeRequestId: string;
    }
  | {
      kind: 'rule_engine_auto';
      ruleVersion: string;
      engine: Actor;
      changeRequestId: string;
    };

/** 不可变发布记录：publish/rollback 都追加新 release，不修改历史。 */
export interface Release {
  releaseId: string;
  itemId: string;
  version: number;
  values: ConfigValues;
  publishedBy: Actor;
  publishedAt: string;
  authorization: ReleaseAuthorization;
  /** 由哪个 release 回滚而来（rollback 时填写）。 */
  rolledBackFrom?: string;
}

export interface ImpactItem {
  kind: 'users' | 'page' | 'downstream' | 'data';
  label: string;
  detail: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ValidationIssue {
  field?: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ChangeRequest {
  id: string;
  itemId: string;
  title: string;
  level: ConfigLevel;
  values: ConfigValues;
  baseVersion: number;
  requester: Actor;
  submittedAt: string;
  state: 'pending_approval' | 'approved' | 'rejected';
  diffAcknowledged: boolean;
  changedFields: readonly string[];
  /** 审批通过后的授权（publish 时校验）。 */
  authorization?: ReleaseAuthorization;
}

/** 审批单列表项：单条审批是 API 约束，UI 不提供批量按钮。 */
export interface ApprovalItemView {
  changeRequest: ChangeRequest;
  impact: readonly ImpactItem[];
  before: ConfigValues;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: Actor;
  action:
    | 'draft.saved'
    | 'config.validated'
    | 'approval.submitted'
    | 'approval.approved'
    | 'approval.rejected'
    | 'config.published'
    | 'config.rolled_back';
  itemId: string;
  detail: string;
}
