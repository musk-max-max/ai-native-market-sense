/**
 * serving 行 → 契约响应（唯一"形状映射 + 数字转换"层）。
 *
 * 依据：contracts/{market,fundamental,watchlist}/openapi.yaml；契约类型来自 @market-sense/api-client
 * （openapi-typescript 生成物，禁止手写 DTO）。本文件不做任何投资判断/评级/目标价文案（H3 红线）。
 */

import type {
  FundamentalComponents,
  MarketComponents,
  SourceValue,
  WatchlistComponents,
} from '@market-sense/api-client';

import type { DataTier } from '../config.js';
import { effectiveTier } from './entitlement.js';
import type {
  AdjType,
  BarRow,
  FundamentalSummaryRow,
  InstrumentRow,
  QuoteRow,
  SourceInfo,
} from '../ports/serving-repo.js';
import type { WatchlistItemRow } from '../ports/watchlist-repo.js';
import { ServingDataError, validationError } from '../errors.js';
import { assertCanonicalSource, toCstIso } from './time.js';

type Market = MarketComponents['schemas'];
type Fundamental = FundamentalComponents['schemas'];
type Watchlist = WatchlistComponents['schemas'];
type SourceRef = Market['SourceRef'];
type Entitlement = Market['Entitlement'];
type DisclaimerMeta = Market['DisclaimerMeta'];

export interface DisclaimerConfigInput {
  readonly text: string;
  readonly version: string;
}

function num(value: string | null, field: string): number {
  if (value === null) {
    throw new ServingDataError(`serving 列为空但契约要求数值: ${field}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    // Lead 要求：decimal 字符串→number 失败必须显式 400 VALIDATION_ERROR，不能 NaN 静默通过。
    // 字段名/值属于内部数据形态，不拼进用户可见 detail（H3 m00865 / A0 m00835）。
    throw validationError();
  }
  return parsed;
}

function numOrNull(value: string | null, field: string): number | null {
  return value === null ? null : num(value, field);
}

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ServingDataError(`serving 列不是合法非负整数: ${field}=${JSON.stringify(value)}`);
  }
  return value;
}

export function entitlementForTier(tier: DataTier, expired = false): Entitlement {
  // shared 契约语义：只有 c_end_display（已获 C 端展示与再分发授权）才 is_entitled=true；
  // 授权到期后（H3 fail-closed 时间盒）即使配置 tier=c_end_display 也必须 is_entitled=false，
  // 且 meta.tier 必须回显实际生效的 internal_eval，而不是配置原文（H5 卡点）。
  return { tier: effectiveTier(tier, expired), is_entitled: tier === 'c_end_display' && !expired };
}

/** platform 自有数据（自选）恒为 platform_user_data / true，不受 F1 行情授权矩阵影响。 */
export function platformEntitlement(): Entitlement {
  return { tier: 'platform_user_data', is_entitled: true };
}

/** 节点/域 → 平台来源词表档位（shared 0.1.2 封闭枚举，见 ADR-002/ADR-004）。 */
export type SourceKind = 'eod' | 'fundamental';

const PLATFORM_SOURCES = [
  'platform_realtime',
  'platform_delayed',
  'platform_eod',
  'platform_snapshot',
  'platform_degraded',
  'platform_watchlist',
  'platform_fundamental',
] as const satisfies readonly SourceValue[];

const PLATFORM_SOURCE_SET: ReadonlySet<string> = new Set<string>(PLATFORM_SOURCES);

/**
 * serving 当前透传上游供数方 source（如 tushare），而 shared 0.1.2 要求对外只出现平台词表。
 * 映射放在 HTTP 适配层：P0 行情/基础信息=收盘后官方快照 platform_eod，财报=platform_fundamental；
 * 若 serving 以后直接产出 platform_*，本函数幂等放行（不二次改写）。原始上游标识保留进 source_id
 * （内部溯源、不参与 C 端展示，符合 shared 契约描述）。
 */
export function platformSourceValue(raw: string, kind: SourceKind): SourceValue {
  if (PLATFORM_SOURCE_SET.has(raw)) return raw as SourceValue;
  return kind === 'fundamental' ? 'platform_fundamental' : 'platform_eod';
}

export function sourceRef(row: SourceInfo, kind: SourceKind = 'eod'): SourceRef {
  assertCanonicalSource(row.source);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(row.asOf)) {
    throw new ServingDataError(`serving as_of 不是 +08:00 ISO8601: ${JSON.stringify(row.asOf)}`);
  }
  if (!Number.isSafeInteger(row.stalenessMs) || row.stalenessMs < 0) {
    throw new ServingDataError(`serving staleness_ms 非法: ${JSON.stringify(row.stalenessMs)}`);
  }
  const ref: SourceRef = {
    source: platformSourceValue(row.source, kind),
    as_of: row.asOf,
    staleness_ms: row.stalenessMs,
  };
  if (!PLATFORM_SOURCE_SET.has(row.source)) {
    ref.source_id = row.source;
  }
  return ref;
}

export function disclaimerMeta(input: DisclaimerConfigInput): DisclaimerMeta {
  return { text: input.text, version: input.version, closable: false };
}

/**
 * 未授权/授权到期时 getInstrument 的正向字段白名单（H4 基础信息口径 + Lead 2026-11-04）：
 * 证券代码、简称、交易所、法定板块、证券类型、上市/停牌状态、上市日期。
 * 白名单外一律不返回——尤其不得放 price/volume/change_pct 等行情数值，也不得用 0/"--" 占位。
 * 正向枚举 + 默认拒绝：新增字段必须先改这里和契约，不允许 spread 整行漏字段。
 */
export const INSTRUMENT_PUBLIC_FIELDS = [
  'instrument_id',
  'exchange',
  'name',
  'board',
  'security_type',
  'list_status',
  'listed_at',
] as const;

const INSTRUMENT_PUBLIC_FIELD_SET: ReadonlySet<string> = new Set<string>(INSTRUMENT_PUBLIC_FIELDS);

/**
 * 运行时兜底：即使未来有人把 buildInstrumentResponse 改成 {...row}，未知字段也会在这里失败。
 * 抛 ServingDataError（500 Problem）而不是静默丢弃——静默会让泄漏字段在线上长期不可见。
 */
export function assertInstrumentWhitelist(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (!INSTRUMENT_PUBLIC_FIELD_SET.has(key)) {
      throw new ServingDataError(`getInstrument 响应出现白名单外字段: ${key}`);
    }
  }
}

export function buildInstrumentResponse(
  row: InstrumentRow,
  tier: DataTier,
  expired = false,
): Market['InstrumentResponse'] {
  const fields: Record<string, unknown> = {
    instrument_id: row.instrument_id,
    exchange: row.exchange,
    name: row.name,
    board: row.board,
    security_type: row.security_type,
    list_status: row.list_status,
    ...(row.listed_at !== null ? { listed_at: row.listed_at } : {}),
  };
  assertInstrumentWhitelist(fields);
  return {
    data: fields as Market['Instrument'],
    meta: {
      source: sourceRef(row),
      entitlement: entitlementForTier(tier, expired),
    },
  };
}

/**
 * Quote 三态映射（serving ports.yaml）：
 *  - 正常：价格/成交量来自 serving；
 *  - 停牌（suspended=true）：价格/涨跌幅为 null；volume/amount 在契约里 required 且非负，
 *    停牌日无成交 → 映射为 0（不是价格 0 冒充；契约仅禁止用 0 冒充价格）；
 *  - trade_date=null：无任何行情/停牌证据 → 路由层已转 404 NOT_FOUND。
 */
export function buildQuoteResponse(
  row: QuoteRow,
  tier: DataTier,
  disclaimer: DisclaimerConfigInput,
  expired = false,
): Market['QuoteResponse'] {
  if (row.trade_date === null) {
    throw new ServingDataError('quote.trade_date 为空：数据未就绪时不应组装 200 响应');
  }
  const suspended = row.suspended;
  const lastPrice = suspended ? null : numOrNull(row.close, 'quote.close');
  const prevClose = suspended ? null : numOrNull(row.prev_close, 'quote.prev_close');
  const change = suspended ? null : numOrNull(row.change, 'quote.change');
  const changePct = suspended ? null : numOrNull(row.change_pct, 'quote.change_pct');

  const volume = suspended ? 0 : positiveInt(row.volume ?? -1, 'quote.volume');
  const amount = suspended ? 0 : num(row.amount, 'quote.amount');

  const data: Market['Quote'] = {
    instrument_id: row.instrument_id,
    trade_date: row.trade_date,
    last_price: lastPrice,
    prev_close: prevClose,
    change,
    change_pct: changePct,
    volume,
    amount,
    suspended,
  };
  if (!suspended) {
    data.open = numOrNull(row.open, 'quote.open');
    data.high = numOrNull(row.high, 'quote.high');
    data.low = numOrNull(row.low, 'quote.low');
  }
  data.limit_status = row.limit_status;

  return {
    data,
    meta: {
      source: sourceRef(row),
      adjustment: 'none',
      entitlement: entitlementForTier(tier, expired),
      disclaimer: disclaimerMeta(disclaimer),
    },
  };
}

export function buildBarsResponse(
  rows: readonly BarRow[],
  hasMore: boolean,
  adjustment: AdjType,
  fallback: { source: SourceInfo; instrumentId: string },
  tier: DataTier,
  disclaimer: DisclaimerConfigInput,
  expired = false,
): Market['BarsResponse'] {
  const bars: Market['Bar'][] = rows.map((row) => {
    if (row.adj_type !== adjustment) {
      throw new ServingDataError(`serving bar adj_type 与请求口径不一致: ${row.adj_type} != ${adjustment}`);
    }
    return {
      trade_date: row.trade_date,
      open: num(row.open, 'bar.open'),
      high: num(row.high, 'bar.high'),
      low: num(row.low, 'bar.low'),
      close: num(row.close, 'bar.close'),
      volume: positiveInt(row.volume, 'bar.volume'),
      amount: num(row.amount, 'bar.amount'),
    };
  });

  // meta.source 取区间内最新一根 bar 的行级时点；无数据时退化为标的维表时点（serving 同一数据链路）。
  const latest = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const sourceInfo = latest ?? fallback.source;

  return {
    data: {
      instrument_id: latest?.instrument_id ?? fallback.instrumentId,
      adjustment,
      bars,
      has_more: hasMore,
    },
    meta: {
      source: sourceRef(sourceInfo),
      adjustment,
      entitlement: entitlementForTier(tier, expired),
      disclaimer: disclaimerMeta(disclaimer),
    },
  };
}

export function buildFundamentalResponse(
  row: FundamentalSummaryRow,
  tier: DataTier,
  disclaimer: DisclaimerConfigInput,
  expired = false,
): Fundamental['FundamentalSummaryResponse'] {
  const data: Fundamental['FundamentalSummary'] = {
    instrument_id: row.instrument_id,
    report_period: row.report_period,
    report_end_date: row.report_end_date,
    announced_at: row.announced_at,
    statement_basis: row.statement_basis,
    currency: row.currency,
    revenue: num(row.revenue, 'fundamental.revenue'),
    net_profit: num(row.net_profit, 'fundamental.net_profit'),
  };
  if (row.revenue_yoy_pct !== null) data.revenue_yoy_pct = num(row.revenue_yoy_pct, 'fundamental.revenue_yoy_pct');
  if (row.net_profit_yoy_pct !== null) data.net_profit_yoy_pct = num(row.net_profit_yoy_pct, 'fundamental.net_profit_yoy_pct');
  if (row.eps !== null) data.eps = num(row.eps, 'fundamental.eps');
  if (row.roe_pct !== null) data.roe_pct = num(row.roe_pct, 'fundamental.roe_pct');
  if (row.gross_margin_pct !== null) data.gross_margin_pct = num(row.gross_margin_pct, 'fundamental.gross_margin_pct');

  return {
    data,
    meta: {
      source: sourceRef(row, 'fundamental'),
      entitlement: entitlementForTier(tier, expired),
      disclaimer: disclaimerMeta(disclaimer),
    },
  };
}

export function buildWatchlistResponse(
  items: readonly WatchlistItemRow[],
  meta: { source: Market['SourceRef']; entitlement: Entitlement },
): Watchlist['WatchlistResponse'] {
  return {
    data: {
      items: items.map((item) => ({
        instrument_id: item.instrument_id,
        added_at: toCstIso(item.added_at),
      })),
    },
    meta: { source: meta.source, entitlement: meta.entitlement },
  };
}

export function buildWatchlistItemResponse(
  item: WatchlistItemRow,
  meta: { source: Market['SourceRef']; entitlement: Entitlement },
): Watchlist['WatchlistItemResponse'] {
  return {
    data: { instrument_id: item.instrument_id, added_at: toCstIso(item.added_at) },
    meta: { source: meta.source, entitlement: meta.entitlement },
  };
}
