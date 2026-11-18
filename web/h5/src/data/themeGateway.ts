/**
 * 主题数据网关（M1a-F4，需求 §3.4/§4.3）：T1 财务健康 / T2 估值与价格 / T3 资金与情绪。
 *
 * - 走 c-end 主题端点（Bearer 注入 authFetch，401 统一收口 handleUnauthorized）。
 * - 降级语义：429→retryAfterSec（Retry-After 头解析）；网络失败/超时→network/timeout；
 *   错误且本地有缓存→stale 回退（旧值 + cachedAt，UI 标「X 分钟前缓存」）。
 * - 5 分钟 LRU（同 URL 命中不打网络；过期条目仅作 stale 回退），容量 20 条。
 * - 后端数字字段全 string|null 透传，这里统一 num() 转 number，null 保留。
 * - 本模块零相对依赖（测试在 node --test 下直接导入）；Bearer 注入与 401 收口由
 *   装配点（data/index.ts）以 fetchImpl/onUnauthorized 传入。
 */

/** 可空数值（后端 string|null 透传后的统一形态）。 */
export type Num = number | null;

/** 注入用最小 fetch 形状（测试注入 fake，生产用 authFetch）。 */
type ThemeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

/** 冷数据错误分类（UI 按此选黄/灰/红卡）。 */
export interface ColdError {
  status: number | null;
  network: boolean;
  timeout: boolean;
  retryAfterSec: number | null;
}

/** 三态结果：ready=新鲜或 5 分钟缓存命中；stale=失败但有旧值；error=失败无旧值。 */
export type ThemeResult<T> =
  | { kind: 'ready'; data: T }
  | { kind: 'stale'; data: T; cachedAt: number; error: ColdError }
  | { kind: 'error'; error: ColdError };

export interface ThemeFinHealthRow {
  period: string;
  asOf: string;
  roe: Num;
  orYoyPct: Num;
  debtToAssets: Num;
  netprofitYoyPct: Num;
  grossprofitMargin: Num;
  netprofitMargin: Num;
  currentRatio: Num;
  totalRevenue: Num;
  netProfit: Num;
  netProfitParent: Num;
  basicEps: Num;
}

export interface FinHealthData {
  instrumentId: string;
  asOf: string | null;
  rows: readonly ThemeFinHealthRow[];
}

export interface ValuationPriceRow {
  tradeDate: string;
  peTtm: Num;
  pb: Num;
  close: Num;
  turnoverRatePct: Num;
}

export interface ValuationPercentiles {
  peTtm: Num;
  pb: Num;
  close: Num;
  turnoverRatePct: Num;
}

export interface ValuationData {
  instrumentId: string;
  range: string;
  asOf: string | null;
  rows: readonly ValuationPriceRow[];
  percentiles: ValuationPercentiles;
}

export interface SentimentMarketRow {
  tradeDate: string;
  limitUpCount: Num;
  limitDownCount: Num;
  advancers: Num;
  decliners: Num;
  advDecRatio: Num;
  maxLimitStreak: Num;
  moneyflowNetInflowTotal: Num;
  marginFinancingBalance: Num;
}

export interface SentimentStockRow {
  tradeDate: string;
  netInflowAmount: Num;
  lhbNetAmount: Num;
  instNetBuyAmount: Num;
  financingBalance: Num;
}

export interface SentimentStockSummary {
  netInflowSum: Num;
  netInflowLatest: Num;
  lhbCount: Num;
  lhbNetBuySum: Num;
  instNetBuySum: Num;
  financingBalanceLatest: Num;
  financingBalanceChange: Num;
}

export interface SentimentData {
  instrumentId: string;
  window: string;
  asOf: string | null;
  market: readonly SentimentMarketRow[];
  stockRows: readonly SentimentStockRow[];
  stockSummary: SentimentStockSummary | null;
}

export interface ThemeGateway {
  getFinHealth(instrumentId: string): Promise<ThemeResult<FinHealthData>>;
  getValuationPrice(instrumentId: string, range?: '1y' | '3y'): Promise<ThemeResult<ValuationData>>;
  getSentiment(instrumentId: string): Promise<ThemeResult<SentimentData>>;
}

interface CacheEntry {
  at: number;
  data: unknown;
}

const cache = new Map<string, CacheEntry>();

/** 清空主题缓存（测试隔离；生产不调用）。 */
export function clearThemeCache(): void {
  cache.clear();
}

function num(v: unknown): Num {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nullableText(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

interface NetFailure {
  kind: 'net';
  network: true;
  timeout: boolean;
}

interface HttpFailure {
  kind: 'http';
  status: number;
  retryAfterSec: number | null;
}

type Failure = NetFailure | HttpFailure;

function netFailure(timeout: boolean): NetFailure {
  return { kind: 'net', network: true, timeout };
}

function isAbort(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { name?: unknown }).name === 'AbortError';
}

function toColdError(raw: unknown): ColdError {
  const failure = raw as Failure;
  if (failure !== null && typeof failure === 'object' && failure.kind === 'http') {
    return { status: failure.status, network: false, timeout: false, retryAfterSec: failure.retryAfterSec };
  }
  if (failure !== null && typeof failure === 'object' && failure.kind === 'net') {
    return { status: null, network: true, timeout: failure.timeout, retryAfterSec: null };
  }
  return { status: null, network: true, timeout: false, retryAfterSec: null };
}

function parseFinHealth(body: unknown): FinHealthData {
  const b = obj(body);
  return {
    instrumentId: text(b.instrument_id),
    asOf: nullableText(b.as_of),
    rows: arr(b.rows).map((raw) => {
      const r = obj(raw);
      return {
        period: text(r.period),
        asOf: text(r.as_of),
        roe: num(r.roe),
        orYoyPct: num(r.or_yoy_pct),
        debtToAssets: num(r.debt_to_assets),
        netprofitYoyPct: num(r.netprofit_yoy_pct),
        grossprofitMargin: num(r.grossprofit_margin),
        netprofitMargin: num(r.netprofit_margin),
        currentRatio: num(r.current_ratio),
        totalRevenue: num(r.total_revenue),
        netProfit: num(r.net_profit),
        netProfitParent: num(r.net_profit_parent),
        basicEps: num(r.basic_eps),
      };
    }),
  };
}

function parseValuation(body: unknown): ValuationData {
  const b = obj(body);
  const p = obj(b.percentiles);
  return {
    instrumentId: text(b.instrument_id),
    range: text(b.range),
    asOf: nullableText(b.as_of),
    rows: arr(b.rows).map((raw) => {
      const r = obj(raw);
      return {
        tradeDate: text(r.trade_date),
        peTtm: num(r.pe_ttm),
        pb: num(r.pb),
        close: num(r.close),
        turnoverRatePct: num(r.turnover_rate_pct),
      };
    }),
    percentiles: {
      peTtm: num(p.pe_ttm),
      pb: num(p.pb),
      close: num(p.close),
      turnoverRatePct: num(p.turnover_rate_pct),
    },
  };
}

function parseSentimentMarket(body: unknown): SentimentMarketRow[] {
  return arr(obj(body).rows).map((raw) => {
    const r = obj(raw);
    return {
      tradeDate: text(r.trade_date),
      limitUpCount: num(r.limit_up_count),
      limitDownCount: num(r.limit_down_count),
      advancers: num(r.advancers),
      decliners: num(r.decliners),
      advDecRatio: num(r.adv_dec_ratio),
      maxLimitStreak: num(r.max_limit_streak),
      moneyflowNetInflowTotal: num(r.moneyflow_net_inflow_total),
      marginFinancingBalance: num(r.margin_financing_balance),
    };
  });
}

function parseSentimentStock(body: unknown): { rows: SentimentStockRow[]; summary: SentimentStockSummary | null; instrumentId: string; window: string; asOf: string | null } {
  const b = obj(body);
  const s = b.summary === null || b.summary === undefined ? null : obj(b.summary);
  return {
    instrumentId: text(b.instrument_id),
    window: text(b.window),
    asOf: nullableText(b.as_of),
    rows: arr(b.rows).map((raw) => {
      const r = obj(raw);
      return {
        tradeDate: text(r.trade_date),
        netInflowAmount: num(r.net_inflow_amount),
        lhbNetAmount: num(r.lhb_net_amount),
        instNetBuyAmount: num(r.inst_net_buy_amount),
        financingBalance: num(r.financing_balance),
      };
    }),
    summary:
      s === null
        ? null
        : {
            netInflowSum: num(s.net_inflow_sum),
            netInflowLatest: num(s.net_inflow_latest),
            lhbCount: num(s.lhb_count),
            lhbNetBuySum: num(s.lhb_net_buy_sum),
            instNetBuySum: num(s.inst_net_buy_sum),
            financingBalanceLatest: num(s.financing_balance_latest),
            financingBalanceChange: num(s.financing_balance_change),
          },
  };
}

/** 解析 Retry-After：纯数字按 delta-seconds；否则按 HTTP-date 与 now 的差值；非法返回 null。 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.ceil(Number(trimmed)));
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export class HttpThemeGateway implements ThemeGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: ThemeFetch;
  private readonly onUnauthorized: (status: number | null) => void;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    baseUrl = '',
    options: {
      fetchImpl?: ThemeFetch;
      onUnauthorized?: (status: number | null) => void;
      timeoutMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.baseUrl = baseUrl;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.onUnauthorized = options.onUnauthorized ?? (() => undefined);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  getFinHealth(instrumentId: string): Promise<ThemeResult<FinHealthData>> {
    const encoded = encodeURIComponent(instrumentId);
    const url = `${this.baseUrl}/v1/c-end/stocks/${encoded}/themes/fin-health`;
    return this.cached(`fin-health:${instrumentId}`, url, parseFinHealth);
  }

  getValuationPrice(instrumentId: string, range: '1y' | '3y' = '1y'): Promise<ThemeResult<ValuationData>> {
    const encoded = encodeURIComponent(instrumentId);
    const url = `${this.baseUrl}/v1/c-end/stocks/${encoded}/themes/valuation-price?range=${range}`;
    return this.cached(`valuation-price:${instrumentId}:${range}`, url, parseValuation);
  }

  getSentiment(instrumentId: string): Promise<ThemeResult<SentimentData>> {
    const encoded = encodeURIComponent(instrumentId);
    const marketUrl = `${this.baseUrl}/v1/c-end/themes/money-sentiment?window=30d`;
    const stockUrl = `${this.baseUrl}/v1/c-end/stocks/${encoded}/themes/money-sentiment?window=30d`;
    return this.cached(`money-sentiment:${instrumentId}`, [marketUrl, stockUrl], (bodies: unknown[]) => {
      const stock = parseSentimentStock(bodies[1]);
      return {
        instrumentId: stock.instrumentId,
        window: stock.window,
        asOf: stock.asOf,
        market: parseSentimentMarket(bodies[0]),
        stockRows: stock.rows,
        stockSummary: stock.summary,
      };
    });
  }

  /** 带 5 分钟缓存 + stale 回退的统一取数入口（key 参与 LRU，url 决定网络请求）。 */
  private async cached<T>(key: string, url: string | string[], map: (body: unknown) => T): Promise<ThemeResult<T>>;
  private async cached<T>(key: string, urls: string[], map: (bodies: unknown[]) => T): Promise<ThemeResult<T>>;
  private async cached<T>(key: string, url: string | string[], map: unknown): Promise<ThemeResult<T>> {
    const cacheKey = `theme:${key}`;
    const now = this.now();
    const hit = cache.get(cacheKey);
    if (hit !== undefined && now - hit.at < CACHE_TTL_MS) {
      // LRU 触碰：移到队尾。
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return { kind: 'ready', data: hit.data as T };
    }
    try {
      const multi = Array.isArray(url);
      const urls = multi ? url : [url as string];
      const bodies = await Promise.all(urls.map((u) => this.getJson(u)));
      const data = multi
        ? (map as (b: unknown[]) => T)(bodies)
        : (map as (b: unknown) => T)(bodies[0]);
      cache.delete(cacheKey);
      cache.set(cacheKey, { at: this.now(), data });
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return { kind: 'ready', data };
    } catch (raw) {
      const error = toColdError(raw);
      const stale = cache.get(cacheKey);
      if (stale !== undefined) {
        return { kind: 'stale', data: stale.data as T, cachedAt: stale.at, error };
      }
      return { kind: 'error', error };
    }
  }

  /** 单请求：超时控制 + 401 收口 + 非 2xx 抛分类失败（含 429 的 Retry-After）。 */
  private async getJson(url: string): Promise<unknown> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer =
      controller === null ? null : setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, controller === null ? undefined : { signal: controller.signal });
    } catch (raw) {
      if (isAbort(raw)) throw netFailure(true);
      throw netFailure(false);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    this.onUnauthorized(res.status);
    if (!res.ok) {
      const retryAfterSec =
        res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After'), this.now()) : null;
      const failure: HttpFailure = { kind: 'http', status: res.status, retryAfterSec };
      throw failure;
    }
    try {
      return await res.json();
    } catch {
      throw netFailure(false);
    }
  }
}
