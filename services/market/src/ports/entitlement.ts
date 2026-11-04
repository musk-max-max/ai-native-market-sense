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
  | 'unauthorized_config';

export interface EntitlementEventRecord {
  readonly eventKey: string;
  readonly eventType: EntitlementEventType;
  readonly occurredAt: Date;
  readonly bootId: string;
  readonly deploymentUid?: string;
  readonly stateVersion: number;
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
