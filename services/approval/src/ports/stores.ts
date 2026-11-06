/**
 * 存储端口（Memory 与 Pg 两实现的单一契约）。
 * 每个方法 = 一个事务边界（PG 实现内部 BEGIN/COMMIT）；账本追加与审计写入永不静默丢。
 * 多步写（建单+幂等+留痕、发布五步等）必须经 transaction(fn) 组成单一原子边界：
 * fn 抛错 → 整体回滚后原样抛出（fail-closed，不留半截写）；嵌套 transaction 并入外层。
 */

import type {
  Actor,
  ApprovalFlow,
  ApprovalStatus,
  ApprovalSubject,
  ApprovalChange,
  Environment,
  OpsConfigWrite,
  OpsSpec,
} from '../domain/types.js';
import type { EventDraft, LedgerEvent, StoredApplication } from '../domain/ledger.js';

export type ApprovalAuditEventType =
  | 'approval_created'
  | 'approval_evaluated'
  | 'approval_decided'
  | 'config_drafted'
  | 'config_submitted'
  | 'config_published'
  | 'config_rolled_back';

export interface ApprovalAuditEvent {
  readonly eventId: string;
  readonly eventType: ApprovalAuditEventType;
  readonly occurredAt: string;
  readonly actor: Actor;
  readonly subjectKind: 'approval' | 'ops_config' | 'ops_release';
  readonly subjectId: string;
  readonly before: unknown;
  readonly after: unknown;
  /** 低基数 reason 码，不写用户原文。 */
  readonly reason: string | null;
  readonly approvalRef: string | null;
}

export interface IdempotentRecord {
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
  readonly approvalRef: string | null;
  readonly response: unknown;
  readonly createdAt: string;
}

export interface CreateApplicationInput {
  readonly application: StoredApplication;
  /** created 事件草稿（seq=1，prev=GENESIS，hash 由存储层计算）。 */
  readonly event: EventDraft;
}

export interface ApplicationFilter {
  readonly environment?: Environment | undefined;
  readonly flow?: ApprovalFlow | undefined;
  readonly status?: ApprovalStatus | undefined;
  readonly applicantId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface StoredConfig {
  readonly configId: string;
  readonly environment: Environment;
  readonly version: number;
  readonly status: 'draft' | 'published';
  readonly schemaVersion: string;
  readonly changeReason: string;
  readonly impactScope: OpsConfigWrite['impact_scope'];
  readonly spec: OpsSpec;
  readonly createdBy: Actor;
  readonly updatedBy: Actor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredVersionRow {
  readonly configId: string;
  readonly environment: Environment;
  readonly version: number;
  readonly spec: OpsSpec;
  readonly changeReason: string;
  readonly impactScope: OpsConfigWrite['impact_scope'];
  readonly savedAt: string;
  readonly savedBy: Actor;
}

export interface StoredRelease {
  readonly releaseId: string;
  readonly configId: string;
  readonly environment: Environment;
  readonly version: number;
  readonly schemaVersion: string;
  readonly policyVersion: string;
  readonly contentHash: string;
  readonly publishedAt: string;
  readonly approvalRef: string;
  readonly canaryPercent: number;
  readonly releaseNotes: string | null;
  readonly previousReleaseId: string | null;
  readonly isCurrent: boolean;
}

export type BindingPurpose = 'config_publish' | 'config_rollback';

export interface ReleaseBinding {
  readonly approvalRef: string;
  readonly purpose: BindingPurpose;
  readonly configId: string;
  readonly environment: Environment;
  readonly version: number;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
}

export interface ListResult<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface ConfigFilter {
  readonly environment: Environment;
  readonly status?: 'draft' | 'published' | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface ReleaseFilter {
  readonly environment: Environment;
  readonly configId?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface DomainStore {
  // —— 审批账本 ——
  insertApplicationWithCreatedEvent(input: CreateApplicationInput): Promise<LedgerEvent>;
  getApplication(approvalRef: string): Promise<{ application: StoredApplication; events: LedgerEvent[] } | null>;
  listApplications(filter: ApplicationFilter): Promise<ListResult<StoredApplication>>;
  appendEvent(approvalRef: string, event: EventDraft): Promise<LedgerEvent>;

  // —— 幂等 ——
  findIdempotent(scope: string, key: string): Promise<IdempotentRecord | null>;
  putIdempotent(record: IdempotentRecord): Promise<void>;

  // —— 运营配置 ——
  getConfig(configId: string, environment: Environment): Promise<StoredConfig | null>;
  /** PUT 语义 S1：registry 注册的 config_id 首次落笔即创建（upsert-create），未注册 id 被校验层拒绝。 */
  upsertConfig(config: StoredConfig): Promise<StoredConfig>;
  insertVersionRow(row: StoredVersionRow): Promise<void>;
  getVersionRow(configId: string, environment: Environment, version: number): Promise<StoredVersionRow | null>;
  listConfigs(filter: ConfigFilter): Promise<ListResult<StoredConfig>>;

  // —— 发布/回滚 ——
  insertBinding(binding: ReleaseBinding): Promise<void>;
  getBinding(approvalRef: string): Promise<ReleaseBinding | null>;
  consumeBinding(approvalRef: string, consumedAt: string): Promise<ReleaseBinding | null>;
  insertRelease(release: StoredRelease): Promise<StoredRelease>;
  getRelease(releaseId: string): Promise<StoredRelease | null>;
  getCurrentRelease(configId: string, environment: Environment): Promise<StoredRelease | null>;
  setCurrentRelease(configId: string, environment: Environment, releaseId: string): Promise<void>;
  listReleases(filter: ReleaseFilter): Promise<ListResult<StoredRelease>>;

  // —— 留痕（who 人或 agent id+模型版本 / what / before-after / why）——
  audit(event: ApprovalAuditEvent): Promise<void>;

  /**
   * 多步写原子边界：fn 内的所有 DomainStore 调用共享同一事务；
   * fn 抛错 → 整体回滚后原样抛出；嵌套调用并入外层事务（重入不新开）。
   */
  transaction<T>(fn: (tx: DomainStore) => Promise<T>): Promise<T>;

  /**
   * submit 幂等查询：(configId, environment, version) 上未消费（consumed_at IS NULL）
   * 且非终态（rejected/expired 按 R9 允许重提新建单）的活跃提交；无 → null。
   */
  findActiveSubmission(input: {
    configId: string;
    environment: Environment;
    version: number;
  }): Promise<{ application: StoredApplication; binding: ReleaseBinding } | null>;

  close?(): Promise<void>;
}
