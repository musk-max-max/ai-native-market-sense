/**
 * 授权状态与审计事件的端口（A5 出 DDL，A13 迁移/GRANT；A3 只读 control 行、只写事件 INSERT）。
 *
 * 数据源（H4 m00813 定稿）：
 *  - `audit.entitlement_hold`：全局单行 control 行（id=1），market_app 仅 SELECT；
 *  - `audit.entitlement_events`：append-only，market_app 仅 INSERT。
 */

/** control 行（对应 audit.entitlement_hold 的读取投影）。 */
export interface EntitlementControlRow {
  readonly lastReconciledAt: Date | null;
  readonly hold: boolean;
  readonly holdId: string | null;
  readonly reason: string | null;
}

export interface EntitlementControlRepo {
  /** 无行返回 null（调用方按 fail-closed 处理）；确定性配置错误应抛出带 PG code 的错误。 */
  fetchControl(): Promise<EntitlementControlRow | null>;
}

/** A3 可写的 4 类事件；deploy/tier_switch/hold_set/hold_clear 不是 A3 写。 */
export type EntitlementEventType =
  | 'entitlement_expired'
  | 'entitlement_flip'
  | 'tier_state_observed'
  | 'unauthorized_config'
  // A5 增量（m01741/H4）：审计窗口断口补记，schema_version=2；DDL 未落地前运行时写入会失败。
  | 'audit_gap';

export interface EntitlementEventRecord {
  readonly eventKey: string;
  readonly eventType: EntitlementEventType;
  readonly occurredAt: Date;
  readonly bootId: string;
  readonly deploymentUid?: string;
  readonly stateVersion: number;
  readonly schemaVersion?: number;
  readonly reason?: string;
  readonly oldValue?: Record<string, unknown>;
  readonly newValue?: Record<string, unknown>;
  readonly effectiveTier?: string;
  readonly configuredTier?: string;
  readonly expiresAt?: string;
  readonly configFingerprint?: string;
  readonly traceId?: string;
  readonly ruleVersion?: string;
  readonly releaseId?: string;
}

export interface EntitlementEventRepo {
  /** 幂等写入：event_key 冲突时 ON CONFLICT DO NOTHING。 */
  insert(record: EntitlementEventRecord): Promise<void>;
}

/** 确定性部署/配置错误（表不存在/无权限/schema 不匹配）→ 启动应失败（L27）。 */
export class EntitlementControlConfigError extends Error {
  override readonly name = 'EntitlementControlConfigError';
}

/** 瞬时故障（连接断/超时/PG 不可用）→ degraded_unauthorized，不 crash。 */
export class EntitlementControlUnavailableError extends Error {
  override readonly name = 'EntitlementControlUnavailableError';
}

const DETERMINISTIC_PG_CODES = new Set(['42P01', '42501', '3F000', '42703', '42883', '42P17']);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** L27 的错误分类：确定性部署错误 crash；其余按瞬态处理。 */
export function classifyControlError(error: unknown): 'config' | 'transient' {
  const code = errorCode(error);
  return code !== undefined && DETERMINISTIC_PG_CODES.has(code) ? 'config' : 'transient';
}

/**
 * 写路径错误分类（H4 m01741）：确定性写错误（权限/表/列/类型/schema 版本）→ 阻断降级；
 * 连接断/超时/序列化冲突/5xx → 非阻断。只分类读不分类写 = INSERT 权限配错能静默跑一晚。
 */
export function classifyWriteError(error: unknown): 'deterministic' | 'transient' {
  const code = errorCode(error);
  if (code !== undefined && DETERMINISTIC_PG_CODES.has(code)) return 'deterministic';
  if (code === '42804') return 'deterministic'; // 类型不匹配
  if (isSchemaVersionMismatch(error)) return 'deterministic';
  return 'transient';
}

function isSchemaVersionMismatch(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'SchemaVersionMismatchError') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /schema[_ ]version/i.test(message);
}
