/**
 * 域配置：环境变量 → 强类型配置（缺失/非法快速失败）。
 *
 * 只覆盖 A3 域的运行时开关；服务端口/日志等外壳配置归 A0（services/api/src/config.ts）。
 * 环境变量与 E2E compose 对齐：ENTITLEMENT_TIER / DISCLAIMER_VERSION / DATABASE_URL / E2E_MODE。
 */

/** 数据授权层级（契约 shared Entitlement.tier 的当前约定取值，只增不改）。 */
export type DataTier = 'internal_eval' | 'c_end_display' | 'research_only' | 'platform_user_data';

const DATA_TIERS: readonly DataTier[] = ['internal_eval', 'c_end_display', 'research_only', 'platform_user_data'];
const DISCLAIMER_VERSION_PATTERN = /^[0-9]{4}\.[0-9]{2}\.[0-9]+$/;

/**
 * P0 免责文案占位值。归属 A5（合规规则发布，H3 立法权），A5 定稿前由 env DISCLAIMER_TEXT 覆盖；
 * 不在接口层做任何投资判断性表述（H3 红线）。
 */
export const DEFAULT_DISCLAIMER_TEXT =
  '本页面数据仅供参考，不构成任何投资建议或买卖依据。数据可能存在延迟，请以交易所及上市公司公告为准。';

const DEFAULT_DISCLAIMER_VERSION = '2026.11.1';
const DEFAULT_WATCHLIST_LIMIT = 100;
const DEFAULT_WATCHLIST_TABLE = 'watchlist_items';
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export class MarketConfigError extends Error {
  override readonly name = 'MarketConfigError';
}

export interface DisclaimerConfig {
  readonly text: string;
  readonly version: string;
}

export interface MarketConfig {
  /**
   * 行情/财务数据授权层级。默认最小授权 internal_eval（fail-closed）；
   * c_end_display 必须显式配置 + 到期时间 + 流水线指纹 + H4 签字 / H3 放行，绝不作为缺省值。
   */
  readonly entitlementTier: DataTier;
  readonly disclaimer: DisclaimerConfig;
  /** 单用户自选上限（运营配置，契约不写死） */
  readonly watchlistLimit: number;
  /** 自选表名（E2E 可覆盖：E2E_WATCHLIST_TABLE） */
  readonly watchlistTable: string;
  /** E2E/本地只在显式开启时用静态 token 模拟认证；生产必须由统一判定点（A0/A4）注入 principal */
  readonly allowDevAuth: boolean;
  readonly devAuthToken?: string;
  readonly devAuthUserId: string;
  /** 启动时 CREATE TABLE IF NOT EXISTS（仅 E2E/本地，生产走迁移） */
  readonly autoMigrate: boolean;
  readonly databaseUrl?: string;
  /** 可注入时钟（测试用） */
  readonly now?: () => Date;
  /**
   * 授权到期时刻（ISO8601 带时区，例如 2026-11-12T23:59:59+08:00）。
   * H3/ADR-004 的 fail-closed 时间盒：到期后行情/财务一律 403，不靠人记、不降级成空数据。
   * 未设置 = 当前 P0 内部评估阶段不启用时间盒（tier 默认 internal_eval 已默认拒绝）。
   */
  readonly entitlementExpiresAt?: string;
  /** 流水线注入的配置指纹（sha256(tier|expires_at)，小写 hex）；tier!=internal_eval 时必填。 */
  readonly entitlementExpectedSha256?: string;
  /** control 行（audit.entitlement_hold）检查；E2E 默认关闭（审计 schema 由 A13/A5 在真栈落地后打开）。 */
  readonly entitlementHoldCheck?: boolean;
  /** 审计事件写入（audit.entitlement_events）；E2E 默认关闭。 */
  readonly entitlementAuditEnabled?: boolean;
  /** 流水线部署标识（审计事件的 deployment_uid）。 */
  readonly deploymentUid?: string;
  readonly releaseId?: string;
  /** E2E/单测模式：仅此模式允许 c_end_display 缺省期望指纹（生产缺省即拒绝启动）。 */
  readonly e2eMode?: boolean;

}

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseTier(raw: string | undefined): DataTier {
  // 未配置 = 最小授权（internal_eval），绝不能默认成 c_end_display：
  // 漏配的环境若默认最大授权，会把未获授权的行情直接展示给 C 端（H5 fail-open 卡点）。
  const value = raw ?? 'internal_eval';
  if (!DATA_TIERS.includes(value as DataTier)) {
    throw new MarketConfigError(
      `ENTITLEMENT_TIER 必须是 ${DATA_TIERS.join('|')} 之一，收到: ${JSON.stringify(raw)}`,
    );
  }
  return value as DataTier;
}

function parsePositiveInt(raw: string | undefined, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new MarketConfigError(`${key} 必须是 >=1 的整数，收到: ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * 时间盒 fail-closed：除最小授权 internal_eval 外，任何层级都必须显式配置到期时间。
 * 「没配置到期时间」不等于「永久有效」——那正是 H5 指出的 fail-open 默认值。
 */
function parseSha256(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = readTrimmed(env, key);
  if (raw === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new MarketConfigError(`${key} 必须是 64 位小写 hex sha256，收到: ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function assertEntitlementTimebox(config: MarketConfig): void {
  if (config.entitlementTier === 'internal_eval') return;
  if (config.entitlementExpiresAt === undefined) {
    throw new MarketConfigError(
      `ENTITLEMENT_TIER=${config.entitlementTier} 必须同时配置 ENTITLEMENT_EXPIRES_AT（授权到期时间）；` +
        '未配置到期时间视为 fail-open，服务拒绝启动。internal_eval 档可不配置（本来就恒 403）。',
    );
  }
  // H4 m00813：tier!=internal_eval 时期望指纹必填（由流水线注入，不可手填），缺失→启动失败。
  if (config.entitlementExpectedSha256 === undefined && config.e2eMode !== true) {
    throw new MarketConfigError(
      `ENTITLEMENT_TIER=${config.entitlementTier} 必须配置 ENTITLEMENT_CONFIG_EXPECTED_SHA256` +
        '（流水线按 sha256("${tier}|${expiresAt}") 注入）；缺失视为期望指纹不可信，服务拒绝启动。',
    );
  }
}

/**
 * 授权到期时刻：必须带时区（Z 或 ±HH:MM），避免把「日期」误读成 UTC 零点。
 * 解析失败快速失败，不允许线上带着非法时间盒启动。
 */
function parseExpiresAt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new MarketConfigError(
      `ENTITLEMENT_EXPIRES_AT 必须是带时区的 ISO8601（如 2026-11-12T23:59:59+08:00），收到: ${JSON.stringify(raw)}`,
    );
  }
  if (Number.isNaN(Date.parse(raw))) {
    throw new MarketConfigError(
      `ENTITLEMENT_EXPIRES_AT 不是合法时刻，收到: ${JSON.stringify(raw)}`,
    );
  }
  return new Date(raw).toISOString();
}

/**
 * L44 + L46：生产环境禁止任何 E2E 后门，且**不依赖"别忘了配"**。
 * APP_PROFILE 缺省/空串/未知拼写一律按 prod 处理；只有显式 dev|test|e2e 才放行。
 * NODE_ENV 不参与安全判定（一个变量决定两件事是漏配的温床）。
 * E2E_MODE=1 会同时打开 dev 身份与自动迁移；E2E_AUTH_TOKEN / WATCHLIST_DEV_AUTH 同样是固定身份入口。
 */
const EXPLICIT_DEV_PROFILES: ReadonlySet<string> = new Set(['dev', 'test', 'e2e']);

export function assertNoE2EBackdoorInProduction(env: NodeJS.ProcessEnv): void {
  const rawProfile = env.APP_PROFILE?.trim() ?? '';
  const profile = rawProfile === '' ? 'prod' : rawProfile;
  if (EXPLICIT_DEV_PROFILES.has(profile)) return;
  const offenders: string[] = [];
  if (env.E2E_MODE === '1') offenders.push('E2E_MODE=1');
  if (env.WATCHLIST_DEV_AUTH === '1') offenders.push('WATCHLIST_DEV_AUTH=1');
  if (readTrimmed(env, 'E2E_AUTH_TOKEN') !== undefined) offenders.push('E2E_AUTH_TOKEN');
  if (offenders.length > 0) {
    throw new MarketConfigError(
      `E2E 模式在生产不可用（L44/L46）：APP_PROFILE=${JSON.stringify(rawProfile)}（缺省=prod）下禁止 ${offenders.join('、')}`,
    );
  }
}

export function loadMarketConfig(env: NodeJS.ProcessEnv = process.env): MarketConfig {
  assertNoE2EBackdoorInProduction(env);
  const version = readTrimmed(env, 'DISCLAIMER_VERSION') ?? DEFAULT_DISCLAIMER_VERSION;
  if (!DISCLAIMER_VERSION_PATTERN.test(version)) {
    throw new MarketConfigError(
      `DISCLAIMER_VERSION 必须匹配 ${DISCLAIMER_VERSION_PATTERN}，收到: ${JSON.stringify(version)}`,
    );
  }

  const table = readTrimmed(env, 'E2E_WATCHLIST_TABLE') ?? readTrimmed(env, 'WATCHLIST_TABLE') ?? DEFAULT_WATCHLIST_TABLE;
  if (!TABLE_NAME_PATTERN.test(table)) {
    throw new MarketConfigError(`自选表名必须是合法 SQL 标识符，收到: ${JSON.stringify(table)}`);
  }

  const e2eMode = env.E2E_MODE === '1';
  const devAuthToken = readTrimmed(env, 'E2E_AUTH_TOKEN');
  const devAuthUserId = readTrimmed(env, 'E2E_AUTH_USER_ID') ?? 'e2e-user';
  const databaseUrl = readTrimmed(env, 'DATABASE_URL');
  const now = env.MARKET_NOW?.trim();
  const entitlementExpiresAt = parseExpiresAt(readTrimmed(env, 'ENTITLEMENT_EXPIRES_AT'));
  const entitlementExpectedSha256 = parseSha256(env, 'ENTITLEMENT_CONFIG_EXPECTED_SHA256');
  const deploymentUid = readTrimmed(env, 'DEPLOYMENT_UID');
  const releaseId = readTrimmed(env, 'RELEASE_ID');

  const config: MarketConfig = {
    entitlementTier: parseTier(readTrimmed(env, 'ENTITLEMENT_TIER')),
    disclaimer: {
      text: readTrimmed(env, 'DISCLAIMER_TEXT') ?? DEFAULT_DISCLAIMER_TEXT,
      version,
    },
    watchlistLimit: parsePositiveInt(readTrimmed(env, 'WATCHLIST_LIMIT'), 'WATCHLIST_LIMIT', DEFAULT_WATCHLIST_LIMIT),
    watchlistTable: table,
    allowDevAuth: e2eMode || env.WATCHLIST_DEV_AUTH === '1',
    // 审计/control 读默认开启（fail-closed）；E2E 默认关闭，因为 A5 的 audit schema 尚未进入真栈，
    // 默认开启会让无表环境按 L27 crashloop。A5 DDL + A13 迁移落地后，A13 在发布流水线去掉 E2E 例外。
    entitlementHoldCheck: env.ENTITLEMENT_HOLD_CHECK === '1' || (env.ENTITLEMENT_HOLD_CHECK !== '0' && !e2eMode),
    entitlementAuditEnabled: env.ENTITLEMENT_AUDIT === '1' || (env.ENTITLEMENT_AUDIT !== '0' && !e2eMode),
    devAuthUserId,
    autoMigrate: e2eMode || env.WATCHLIST_AUTO_MIGRATE === '1',
    ...(entitlementExpiresAt !== undefined ? { entitlementExpiresAt } : {}),
    ...(entitlementExpectedSha256 !== undefined ? { entitlementExpectedSha256 } : {}),
    ...(deploymentUid !== undefined ? { deploymentUid } : {}),
    ...(releaseId !== undefined ? { releaseId } : {}),
    ...(e2eMode ? { e2eMode: true } : {}),
  };

  const withOptionals: MarketConfig = {
    ...config,
    ...(devAuthToken !== undefined ? { devAuthToken } : {}),
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    ...(now !== undefined && !Number.isNaN(Date.parse(now)) ? { now: () => new Date(now) } : {}),
  };
  assertEntitlementTimebox(withOptionals);
  return withOptionals;
}
