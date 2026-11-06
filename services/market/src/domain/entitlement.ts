/**
 * 授权有效期与判定（H3 的 fail-closed 时间盒，ADR-004 H3/H4 判定记录 a 条）。
 *
 * 配置里的 expires_at 是「授权取得 deadline」：到点后即使 tier=c_end_display 也必须拒绝回答
 * 行情/财务数值（403 ENTITLEMENT_RESTRICTED），不能降级成空数据/空串——空数据会被前端当真实值渲染。
 *
 * 这里是唯一判定点；单测必须用 loadMarketConfig 解析真实 env 配置后驱动，不允许硬编码 bool。
 * meta.entitlement.is_entitled 永远由 effective_tier 现算（H4 m00830：不独立存储第二个真相源）。
 */

import { createHash } from 'node:crypto';

import type { DataTier } from '../config.js';

/** ADR-008 D3：发布轴档位；platform_user_data 正交、不参与发布比较。 */
export type ReleaseTier = Exclude<DataTier, 'platform_user_data'>;

/** 发布轴唯一排序真源（ADR-008 D3 / Lead m03143）：internal_eval(0) < research_only(1) < c_end_display(2)。 */
export const RELEASE_RANK: Readonly<Record<ReleaseTier, number>> = {
  internal_eval: 0,
  research_only: 1,
  c_end_display: 2,
};

/** 取发布轴最小档（越靠前授权越窄）；空集 fail-closed 回 internal_eval。 */
export function minReleaseTier(...tiers: readonly ReleaseTier[]): ReleaseTier {
  if (tiers.length === 0) return 'internal_eval';
  return tiers.reduce((lowest, tier) => (RELEASE_RANK[tier] < RELEASE_RANK[lowest] ? tier : lowest));
}


/**
 * 响应 meta 必须回显「实际生效的层级」而非配置原文：
 * 授权到期后即使配置 c_end_display，实际生效的是最小授权 internal_eval（is_entitled=false）。
 */
export function effectiveTier(tier: DataTier, expired: boolean): DataTier {
  return expired ? 'internal_eval' : tier;
}

/**
 * 恰好到点视为已过期（fail-closed，边界不留缝）。
 * 缺省 = 视为已过期（H4 m00779：没有 expires_at 绝不能解释成"永久有效"）；
 * 非 internal_eval 缺省会在启动时直接失败，能走到这里的缺省只可能是 internal_eval（本就恒 403）。
 */
export function isEntitlementExpired(expiresAt: string | undefined, now: Date): boolean {
  if (expiresAt === undefined) return true;
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    // 配置层已校验，走到这里说明被注入脏值：按过期处理（默认拒绝）。
    return true;
  }
  return now.getTime() >= expiresAtMs;
}

/**
 * 授权配置指纹（Lead m00803 / H4 m00813 定稿公式）：
 * `sha256(utf8("${tier}|${expiresAtNormalized ?? ''}"))`，输出 64 位小写 hex。
 * A13 注入侧必须用共享测试向量校验两边一致；没有测试向量的"同一公式"通常不是同一公式。
 */
export function configFingerprint(tier: DataTier, expiresAt: string | undefined): string {
  return createHash('sha256').update(`${tier}|${expiresAt ?? ''}`, 'utf8').digest('hex');
}

/** 仅当注入了期望指纹时才比对；E2E 例外由配置层保证（生产非 internal 必填）。 */
export function hasConfigFingerprintMismatch(config: {
  readonly entitlementTier: DataTier;
  readonly entitlementExpiresAt?: string;
  readonly entitlementExpectedSha256?: string;
}): boolean {
  if (config.entitlementExpectedSha256 === undefined) return false;
  return configFingerprint(config.entitlementTier, config.entitlementExpiresAt) !== config.entitlementExpectedSha256;
}

export interface EntitlementResolution {
  readonly configuredTier: DataTier;
  /** 响应 meta 必须回显它（到期/指纹不一致/control 降级时降为 internal_eval）。 */
  readonly effectiveTier: DataTier;
  readonly isEntitled: boolean;
  readonly expired: boolean;
  readonly configMismatch: boolean;
  /** 配置的到期时刻（规范化 ISO，审计事件用）。 */
  readonly expiresAt?: string;
  /** 行情/财务接口是否拒绝回答（403 ENTITLEMENT_RESTRICTED）。 */
  readonly blocked: boolean;
}

type ResolveConfig = {
  readonly entitlementTier: DataTier;
  readonly entitlementExpiresAt?: string;
  readonly entitlementExpectedSha256?: string;
};

/**
 * 单点判定（H4/H5 每请求顺序中属于 env 的部分）：① 本地 now>=expires_at 硬判定 → ② 配置指纹 → ③ env tier。
 * control 行（hold/新鲜度）由 EntitlementGate 在 ① 与 ③ 之间读取。
 */
export function resolveEntitlement(config: ResolveConfig, now: Date): EntitlementResolution {
  const expired = isEntitlementExpired(config.entitlementExpiresAt, now);
  const configMismatch = hasConfigFingerprintMismatch(config);
  const degraded = expired || configMismatch;
  const effective = degraded ? 'internal_eval' : config.entitlementTier;
  const isEntitled = config.entitlementTier === 'c_end_display' && !degraded;
  return {
    configuredTier: config.entitlementTier,
    effectiveTier: effective,
    isEntitled,
    expired,
    configMismatch,
    ...(config.entitlementExpiresAt !== undefined ? { expiresAt: config.entitlementExpiresAt } : {}),
    blocked: !isEntitled,
  };
}
