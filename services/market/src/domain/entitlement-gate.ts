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

import type { Principal, PrincipalParse } from '../auth.js';
import type { MarketConfig } from '../config.js';
import {
  classifyControlError,
  type EntitlementControlRepo,
  type EntitlementControlRow,
} from '../ports/entitlement.js';
import { minReleaseTier, resolveEntitlement, type EntitlementResolution, type ReleaseTier } from './entitlement.js';

export type DegradedReason =
  | 'control_unavailable'
  | 'control_stale'
  | 'hold_active'
  | 'control_missing'
  | 'config_mismatch'
  | 'audit_write_failed'
  | 'expired_event_write_failed'
  | 'audit_write_misconfigured'
  | 'expired';

/**
 * H4 m01713：降级分两类。
 *  - 阻断（改 resolution：effective=internal_eval、blocked=true）：授权判定本身不成立；
 *  - 非阻断（只标记 healthz/stderr/指标，不改 resolution）：审计写失败不扩大授权，
 *    安全由 reconciler 的 observed 缺失兜底（H3「写失败不阻止翻转，先安全后告警」）。
 */
export const BLOCKING_REASONS = new Set<DegradedReason>([
  'control_unavailable',
  'control_stale',
  'control_missing',
  'hold_active',
  'config_mismatch',
  'expired',
  'control_stale',
  // H4 m01784/M01741：确定性写错误（INSERT 权限/表/列/类型/schema 配错）单独成阻断原因，
  // 与"记账抖动"区分；语义上属于"我们不知道能否记账"，不是"记账没写成"。
  'audit_write_misconfigured',
]);

export const NON_BLOCKING_REASONS = new Set<DegradedReason>([
  'audit_write_failed',
  'expired_event_write_failed',
]);

/**
 * 非阻断的判据（可测不变量，H4 m01741）：**该事件缺失不改变 resolution** 才可非阻断；
 * 任何"缺失会改变放行"的新事件类型默认归阻断，不要顺手放进 NON_BLOCKING。
 */
export function isBlockingDegradedReason(reason: DegradedReason): boolean {
  return BLOCKING_REASONS.has(reason);
}

export type Audience = 'c_end' | 'internal';
export type InternalTier = 'internal_eval' | 'research_only';

/**
 * ADR-008 D3.2：双维度判别式联合。两个受众分支**只**暴露各自轴上的档位，
 * 不允许压成一个 effective_tier 字符串（内部档位不是 C 端发布档位）。
 */
export interface CEndAudienceDecision {
  readonly audience: 'c_end';
  readonly releaseTier?: ReleaseTier;
  readonly displayAllowed: boolean;
  readonly blocked: boolean;
  readonly degraded: boolean;
  readonly reason?: DegradedReason;
}

export interface InternalAudienceDecision {
  readonly audience: 'internal';
  readonly internalTier?: InternalTier;
  readonly internalAccessAllowed: boolean;
  readonly blocked: boolean;
  readonly degraded: boolean;
  readonly reason?: DegradedReason;
}

export type AudienceGateDecision = CEndAudienceDecision | InternalAudienceDecision;

/** S3 起内部访问审计；schema 由 A5 定，A3 只经回调写入。 */
export interface InternalAccessRecord {
  readonly userId: string;
  readonly userType: Principal['userType'];
  readonly tier: Principal['tier'];
  readonly sessionVersion: number;
  readonly audience: 'internal';
  readonly allowed: boolean;
  readonly blocked: boolean;
  readonly reason?: DegradedReason;
}

interface ServiceGateDecision {
  readonly resolution: EntitlementResolution;
  readonly degraded: boolean;
  readonly reason?: DegradedReason;
}

export interface GateDecision extends ServiceGateDecision {
  /** ADR-008：C 端路径的受众轴判定；与 resolution（服务发布轴）并存，不互压。 */
  readonly audience: CEndAudienceDecision;
}


export interface GateStatus {
  readonly degraded: boolean;
  readonly reason?: DegradedReason;
}

export interface EntitlementGateOptions {
  /** L77：control 读的独立超时；不依赖 pg 驱动默认（默认 1000ms）。 */
  controlTimeoutMs?: number;
  /** control 行成功缓存（H4：30s，避免每请求都打 PG）。 */
  readonly controlCacheMs?: number;
  /** 读失败负缓存（H4：5s）。 */
  readonly negativeCacheMs?: number;
  readonly breakerThreshold?: number;
  readonly breakerMs?: number;
  /** control 行新鲜度上限（H5：15 分钟）。 */
  readonly stalenessMs?: number;
  readonly warn?: (message: string) => void;
  /** ADR-008 D9：off=不算受众（默认）；shadow=只记录不改变响应；enforce=S3 起内部受众强制。 */
  readonly audienceGateMode?: 'off' | 'shadow' | 'enforce';
  /** S3：内部访问审计写入；S2 shadow 不传。 */
  readonly onInternalAccess?: (record: InternalAccessRecord) => void | Promise<void>;
}

const DEFAULT_CONTROL_CACHE_MS = 30_000;
const DEFAULT_NEGATIVE_CACHE_MS = 5_000;
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_BREAKER_MS = 30_000;
const DEFAULT_STALENESS_MS = 15 * 60_000;

type GateConfig = Pick<MarketConfig, 'entitlementTier' | 'entitlementExpiresAt' | 'entitlementExpectedSha256'>;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class EntitlementGate {
  private row: EntitlementControlRow | null | undefined;
  private fetchedAtMs = 0;
  private negativeUntilMs = 0;
  private breakerUntilMs = 0;
  private failures = 0;
  private degraded = false;
  private degradedReason: DegradedReason | undefined;
  private startupConfigError: unknown;
  /** 审计写失败标记：非阻断，但 reconciler 心跳缺失时自动升级为阻断（Lead L60）。 */
  private auditFailure: DegradedReason | undefined;
  /** 确定性写错误（权限/表/列/类型/schema）：不依赖 reconciler，直接阻断（H4 m01741）。 */
  private auditWriteBlocked = false;
  private warnedReasons = new Set<DegradedReason>();
  private shadowLogged = new Set<string>();

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

  async evaluate(principal: PrincipalParse = { kind: 'absent' }): Promise<GateDecision> {
    const service = await this.evaluateService();
    const audience = this.cEndDecision(service, principal);
    if (this.audienceGateMode() === 'shadow') this.shadowLog(principal, audience);
    return { ...service, audience };
  }

  /** ADR-008 受众轴判定（供表驱动测试与内部路由使用）。 */
  async evaluateAudience(input: {
    readonly audience: Audience;
    readonly principal?: PrincipalParse;
  }): Promise<AudienceGateDecision> {
    const principal = input.principal ?? { kind: 'absent' };
    const service = await this.evaluateService();
    const decision =
      input.audience === 'internal' ? this.internalDecision(service, principal) : this.cEndDecision(service, principal);
    if (this.audienceGateMode() === 'shadow') this.shadowLog(principal, decision);
    if (input.audience === 'internal') {
      this.emitInternalAccess(principal, decision as InternalAudienceDecision);
    }
    return decision;
  }

  private cEndDecision(service: ServiceGateDecision, principal: PrincipalParse): CEndAudienceDecision {
    const configured = this.config.entitlementTier;
    const serviceRelease: ReleaseTier =
      configured === 'platform_user_data' ? 'internal_eval' : (configured as ReleaseTier);
    const releaseTier = minReleaseTier(serviceRelease, 'c_end_display');
    // /v1/*（C 端路径）对 internal_active 也按 c_end 处理；claim 非法一律拒绝（不得降级 c_end）。
    const principalUsable = principal.kind !== 'invalid';
    const displayAllowed = principalUsable && !service.resolution.blocked && releaseTier === 'c_end_display';
    return {
      audience: 'c_end',
      releaseTier,
      displayAllowed,
      blocked: !displayAllowed,
      degraded: service.degraded,
      ...(service.reason !== undefined ? { reason: service.reason } : {}),
    };
  }

  private internalDecision(service: ServiceGateDecision, principal: PrincipalParse): InternalAudienceDecision {
    let internalTier: InternalTier | undefined;
    let internalAccessAllowed = false;
    if (principal.kind === 'present' && principal.principal.userType === 'internal_active') {
      internalTier = principal.principal.tier === 'research_only' ? 'research_only' : 'internal_eval';
      // 内部轴不是发布轴：服务档位 internal_eval/research_only 本身不构成"阻断"，
      // 只有授权基础设施（时间盒/control/hold/指纹/审计）失败才 fail-closed。
      const infrastructureBlocked = service.degraded || service.reason !== undefined;
      internalAccessAllowed = !infrastructureBlocked;
    }
    return {
      audience: 'internal',
      ...(internalTier !== undefined ? { internalTier } : {}),
      internalAccessAllowed,
      blocked: !internalAccessAllowed,
      degraded: service.degraded,
      ...(service.reason !== undefined ? { reason: service.reason } : {}),
    };
  }

  private emitInternalAccess(principal: PrincipalParse, decision: InternalAudienceDecision): void {
    const writer = this.options.onInternalAccess;
    if (writer === undefined) return;
    if (principal.kind !== 'present') return;
    if (this.audienceGateMode() !== 'enforce') return;
    try {
      void Promise.resolve(
        writer({
          userId: principal.principal.userId,
          userType: principal.principal.userType,
          tier: principal.principal.tier,
          sessionVersion: principal.principal.sessionVersion,
          audience: 'internal',
          allowed: decision.internalAccessAllowed,
          blocked: decision.blocked,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        }),
      ).catch((error: unknown) => {
        (this.options.warn ?? ((message: string) => process.emitWarning(message)))(
          `[market] internal_access 审计写入失败: ${String(error)}`,
        );
      });
    } catch (error) {
      (this.options.warn ?? ((message: string) => process.emitWarning(message)))(
        `[market] internal_access 审计写入失败: ${String(error)}`,
      );
    }
  }

  private audienceGateMode(): 'off' | 'shadow' | 'enforce' {
    return this.options.audienceGateMode ?? 'off';
  }

  private shadowLog(principal: PrincipalParse, decision: AudienceGateDecision): void {
    const key = JSON.stringify([
      principal.kind,
      principal.kind === 'present' ? principal.principal.userType : '',
      principal.kind === 'invalid' ? principal.reason : '',
      decision.audience,
      decision.blocked,
      decision.audience === 'c_end' ? decision.releaseTier ?? null : decision.internalTier ?? null,
      decision.reason ?? null,
    ]);
    if (this.shadowLogged.has(key)) return;
    this.shadowLogged.add(key);
    const payload = JSON.stringify({
      event: 'audience_gate_shadow',
      principal:
        principal.kind === 'present'
          ? {
              user_type: principal.principal.userType,
              tier: principal.principal.tier,
              session_version: principal.principal.sessionVersion,
            }
          : { kind: principal.kind },
      audience: decision.audience,
      blocked: decision.blocked,
      release_tier: decision.audience === 'c_end' ? decision.releaseTier ?? null : null,
      internal_tier: decision.audience === 'internal' ? decision.internalTier ?? null : null,
      reason: decision.reason ?? null,
    });
    (this.options.warn ?? ((message: string) => process.emitWarning(message)))(`[market] ${payload}`);
  }

  private async evaluateService(): Promise<ServiceGateDecision> {
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

    if (this.row !== undefined && this.row !== null && this.row.hold !== true && nowMs - this.fetchedAtMs <= this.cacheMs()) {
      return this.fromRow(base, this.row, now);
    }

    try {
      const row = await withTimeout(this.repo.fetchControl(), this.controlTimeoutMs(), 'control_fetch_timeout');
      this.failures = 0;
      this.breakerUntilMs = 0;
      this.negativeUntilMs = 0;
      this.fetchedAtMs = nowMs;
      this.row = row;
      return this.fromRow(base, row, now);
    } catch (error) {
      if (classifyControlError(error) === 'config') {
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

  /**
   * 非阻断降级标记（仅 audit/事件写失败用）：不改 resolution，不置 blocked。
   * 阻断原因必须走 degrade()，避免"写失败=降权"与 H3 冻结口径冲突（H4 m01713）。
   */
  markDegraded(reason: DegradedReason): void {
    if (!NON_BLOCKING_REASONS.has(reason)) {
      throw new Error(`非阻断标记不接受阻断原因：${reason}`);
    }
    this.degraded = true;
    this.degradedReason = reason;
    this.auditFailure = reason;
    this.page(reason);
  }

  /**
   * 确定性写错误：INSERT 权限/表/列/类型/schema 配错，重启也不会自愈 → 直接阻断并寻呼。
   * 启动路径由调用方决定"拒绝以 c_end_display 启动"（H4 m01741）。
   */
  markWriteBlocked(reason: DegradedReason): void {
    if (reason !== 'audit_write_misconfigured' && !NON_BLOCKING_REASONS.has(reason)) {
      throw new Error(`写阻断标记只接受审计原因：${reason}`);
    }
    this.auditWriteBlocked = true;
    this.degraded = true;
    this.degradedReason = reason;
    this.page(reason);
  }

  private fromRow(base: EntitlementResolution, row: EntitlementControlRow | null, now: Date): ServiceGateDecision {
    // Lead L60：非阻断的前提是 reconciler 还活着（它负责 observed 缺失兜底）。
    // 心跳缺失/过期 = 补偿控制停摆 → audit 写失败自动升级为阻断，保持原 reason 以便告警定位。
    if (this.auditWriteBlocked) return this.blockAudit(base, 'audit_write_misconfigured');
    if (this.auditFailure !== undefined && !this.reconcilerAlive(row, now)) {
      return this.blockAudit(base, this.auditFailure);
    }
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

  private reconcilerAlive(row: EntitlementControlRow | null, now: Date): boolean {
    if (row === null) return false;
    const last = row.lastReconciledAt;
    if (last === null || Number.isNaN(last.getTime())) return false;
    return now.getTime() - last.getTime() <= this.stalenessLimitMs();
  }

  /** 审计失败 + 补偿控制停摆：不改 reason，但强制 effective=internal_eval/blocked=true。 */
  private blockAudit(base: EntitlementResolution, reason: DegradedReason): ServiceGateDecision {
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

  private degrade(base: EntitlementResolution, reason: DegradedReason): ServiceGateDecision {
    if (!BLOCKING_REASONS.has(reason)) {
      throw new Error(`阻断降级只接受阻断原因：${reason}`);
    }
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

  /**
   * Lead L60：审计写失败必须 page（不是普通 log）。A3 无寻呼通道，输出 severity=page 的
   * 结构化告警，由 A13/H5 的日志告警规则接寻呼；进程内每种 reason 只发一次。
   */
  private page(reason: DegradedReason): void {
    if (this.warnedReasons.has(reason)) return;
    this.warnedReasons.add(reason);
    // H5 m02456：写入失败必须能区分「阻断并寻呼」与「非阻断、仅降级」，
    // 不能让值班按一条中性日志误判；blocked 时 reason 也必须是阻断集合内的原因。
    const blocking = this.auditWriteBlocked;
    const payload = JSON.stringify({
      event: 'entitlement_audit_write_failed',
      severity: 'page',
      blocking,
      effect: blocking ? 'blocked_internal_eval' : 'degraded_only',
      reason,
    });
    const text = blocking
      ? `[market] 审计写入确定性失败（reason=${reason}）：已阻断为 internal_eval 并寻呼`
      : `[market] 审计写入瞬态失败（reason=${reason}）：非阻断，仅降级+寻呼`;
    (this.options.warn ?? ((message: string) => process.emitWarning(message)))(`[PAGE] ${text} ${payload}`);
    process.stderr.write(`${payload}\n`);
  }

  private warnOnce(reason: DegradedReason): void {
    if (this.warnedReasons.has(reason)) return;
    this.warnedReasons.add(reason);
    const warn = this.options.warn ?? ((message: string) => process.emitWarning(message));
    const blocking = BLOCKING_REASONS.has(reason);
    if (blocking) {
      warn(`[market] entitlement 已降级为 internal_eval（reason=${reason}），行情/财务将返回 403`);
      return;
    }
    // Lead L60：audit 写失败必须 page（不是普通 log），且是"非阻断"成立的前提条件之一。
    // A3 无寻呼通道，这里输出带 severity=page 的结构化告警，由 A13/H5 的日志告警规则接寻呼。
    const payload = JSON.stringify({
      event: 'entitlement_audit_write_failed',
      severity: 'page',
      reason,
      effective_tier: 'internal_eval',
    });
    warn(`[PAGE] ${payload}`);
    process.stderr.write(`${payload}\n`);
  }

  private controlTimeoutMs(): number {
    return this.options.controlTimeoutMs ?? 1000;
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
