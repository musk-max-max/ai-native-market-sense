/**
 * 授权闸门（H4/H5）：① 本地时间盒硬判定 → ② control 行（hold/新鲜度）→ ③ env tier。
 *
 * Fail-closed 规则：
 *  - control 行没有 → 按 hold=true（未留痕按未授权）+ 告警；
 *  - last_reconciled_at 为 null 或超过 15 分钟 → internal_eval（reconciler 静默挂）；
 *  - 读失败/超时 → internal_eval + 5s 负缓存 + 熔断（避免每请求打挂 PG）；
 *  - 403 一律中性文案（H3），不区分 expired/hold/stale。
 *
 * L27 分叉：确定性配置错误（42P01/42501/schema mismatch）→ 启动失败（crashloop）；
 * 瞬态故障 → 不 crash，进 degraded_unauthorized（行情/财务 403，基础信息/合规文案照常，/healthz 报 degraded）。
 */

import type { MarketConfig } from '../config.js';
import {
  classifyControlError,
  type EntitlementControlRepo,
  type EntitlementControlRow,
} from '../ports/entitlement.js';
import { resolveEntitlement, type EntitlementResolution } from './entitlement.js';

export type DegradedReason =
  | 'control_unavailable'
  | 'control_stale'
  | 'hold_active'
  | 'control_missing'
  | 'config_mismatch'
  | 'audit_write_failed'
  | 'expired_event_write_failed'
  | 'expired';

export interface GateDecision {
  readonly resolution: EntitlementResolution;
  readonly degraded: boolean;
  readonly reason?: DegradedReason;
}


export interface GateStatus {
  readonly degraded: boolean;
  readonly reason?: DegradedReason;
}

export interface EntitlementGateOptions {
  /** control 行成功缓存（H4：30s，避免每请求都打 PG）。 */
  readonly controlCacheMs?: number;
  /** 读失败负缓存（H4：5s）。 */
  readonly negativeCacheMs?: number;
  readonly breakerThreshold?: number;
  readonly breakerMs?: number;
  /** control 行新鲜度上限（H5：15 分钟）。 */
  readonly stalenessMs?: number;
  readonly warn?: (message: string) => void;
}

const DEFAULT_CONTROL_CACHE_MS = 30_000;
const DEFAULT_NEGATIVE_CACHE_MS = 5_000;
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_BREAKER_MS = 30_000;
const DEFAULT_STALENESS_MS = 15 * 60_000;

type GateConfig = Pick<MarketConfig, 'entitlementTier' | 'entitlementExpiresAt' | 'entitlementExpectedSha256'>;

export class EntitlementGate {
  private row: EntitlementControlRow | null | undefined;
  private fetchedAtMs = 0;
  private negativeUntilMs = 0;
  private breakerUntilMs = 0;
  private failures = 0;
  private degraded = false;
  private degradedReason: DegradedReason | undefined;
  private startupConfigError: unknown;
  private warnedReasons = new Set<DegradedReason>();

  constructor(
    private readonly config: GateConfig,
    private readonly repo: EntitlementControlRepo | null,
    private readonly clock: () => Date,
    private readonly options: EntitlementGateOptions = {},
  ) {}

  /** 启动探测：确定性配置错误直接抛（L27 crashloop）；瞬态故障只进 degraded，不 crash。 */
  async probeStartup(): Promise<void> {
    await this.evaluate();
    if (this.startupConfigError !== undefined) throw this.startupConfigError;
  }

  async evaluate(): Promise<GateDecision> {
    const now = this.clock();
    const base = resolveEntitlement(this.config, now);
    // ① 本地时间盒：不依赖 PG，到期即拒绝（也不读 control）。
    if (base.expired) return { resolution: base, degraded: false, reason: 'expired' };
    // 配置指纹不一致：进程内已降级，无需读 control。
    if (base.configMismatch) return this.degrade(base, 'config_mismatch');
    if (this.repo === null) return { resolution: base, degraded: false };

    const nowMs = now.getTime();
    if (nowMs < this.breakerUntilMs) return this.degrade(base, 'control_unavailable');
    if (nowMs < this.negativeUntilMs) return this.degrade(base, 'control_unavailable');

    // 正常放行态缓存 30s（H4，避免每请求打 PG）；但 hold 生效态不缓存：
    // 清 hold 必须"立即恢复"（task-8 验收），且 403 路径流量低，多一次读可接受。
    if (this.row !== undefined && this.row !== null && this.row.hold !== true && nowMs - this.fetchedAtMs <= this.cacheMs()) {
      return this.fromRow(base, this.row, now);
    }

    try {
      const row = await this.repo.fetchControl();
      this.failures = 0;
      this.breakerUntilMs = 0;
      this.negativeUntilMs = 0;
      this.fetchedAtMs = nowMs;
      this.row = row;
      return this.fromRow(base, row, now);
    } catch (error) {
      if (classifyControlError(error) === 'config') {
        // 运行时才暴露的表不存在/权限不足：记下供启动探测抛出，同时按 fail-closed 降级（不静默放行）。
        this.startupConfigError = error;
        return this.degrade(base, 'config_mismatch');
      }
      this.failures += 1;
      this.negativeUntilMs = nowMs + this.negativeCacheMs();
      if (this.failures >= this.breakerThreshold()) this.breakerUntilMs = nowMs + this.breakerMs();
      return this.degrade(base, 'control_unavailable');
    }
  }

  status(): GateStatus {
    return this.degradedReason === undefined
      ? { degraded: this.degraded }
      : { degraded: this.degraded, reason: this.degradedReason };
  }

  /** 启动/状态变更路径写事件失败 → effective=internal_eval（H4）。 */
  markDegraded(reason: DegradedReason): void {
    this.degraded = true;
    this.degradedReason = reason;
    this.warnOnce(reason);
  }

  private fromRow(base: EntitlementResolution, row: EntitlementControlRow | null, now: Date): GateDecision {
    if (row === null) {
      // H4：无 control 行 = 未留痕，按 hold=true 处理（fail-closed），不 crash。
      return this.degrade(base, 'control_missing');
    }
    const last = row.lastReconciledAt;
    if (last === null || Number.isNaN(last.getTime()) || now.getTime() - last.getTime() > this.stalenessLimitMs()) {
      return this.degrade(base, 'control_stale');
    }
    if (row.hold) return this.degrade(base, 'hold_active');
    this.degraded = false;
    this.degradedReason = undefined;
    return { resolution: base, degraded: false };
  }

  private degrade(base: EntitlementResolution, reason: DegradedReason): GateDecision {
    this.degraded = true;
    this.degradedReason = reason;
    this.warnOnce(reason);
    return {
      resolution: {
        ...base,
        effectiveTier: 'internal_eval',
        isEntitled: false,
        blocked: true,
      },
      degraded: true,
      reason,
    };
  }

  private warnOnce(reason: DegradedReason): void {
    if (this.warnedReasons.has(reason)) return;
    this.warnedReasons.add(reason);
    const warn = this.options.warn ?? ((message: string) => process.emitWarning(message));
    warn(`[market] entitlement 已降级为 internal_eval（reason=${reason}），行情/财务将返回 403`);
  }

  private cacheMs(): number {
    return this.options.controlCacheMs ?? DEFAULT_CONTROL_CACHE_MS;
  }

  private negativeCacheMs(): number {
    return this.options.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS;
  }

  private breakerThreshold(): number {
    return this.options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
  }

  private breakerMs(): number {
    return this.options.breakerMs ?? DEFAULT_BREAKER_MS;
  }

  private stalenessLimitMs(): number {
    return this.options.stalenessMs ?? DEFAULT_STALENESS_MS;
  }
}
