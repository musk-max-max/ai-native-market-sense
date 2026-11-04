/**
 * 真实数据适配器：@market-sense/api-client（契约生成的类型化客户端）。
 *
 * 硬约束（A7 system_prompt）：
 *  - 只用 A0 的生成客户端，禁止手写 HTTP 请求与手写 DTO；
 *  - 本文件只做「契约结构 -> 页面 view model」的映射，不定义接口字段、不改契约语义；
 *  - 行情数值原样透传；as_of/staleness/disclaimer/entitlement 全部来自响应 meta；
 *  - 任何「有价格但缺免责」的响应都按错误处理（绝不裸价展示）；
 *  - 错误只带 HTTP 状态码与 network 标志（H3：内部错误码不得进入客户端可取得出口）；
 *  - 不保留权限分层取值、来源内部 ID 等内部标识。
 */
import { createApiClient } from '@market-sense/api-client';
import type {
  ApiClient,
  FundamentalComponents,
  MarketComponents,
  SharedComponents,
  WatchlistComponents,
} from '@market-sense/api-client';
import { readAuthToken } from '../lib/auth';
import type {
  GatewayError,
  MarketGateway,
  StockPageResult,
  WatchlistMutationResult,
  WatchlistResult,
} from './gateway';
import type {
  DataAccess,
  DisclaimerInfo,
  FundamentalInfo,
  FundamentalState,
  QuoteInfo,
  SourceInfo,
  StockPageData,
} from './model';

type Instrument = MarketComponents['schemas']['Instrument'];
type Quote = MarketComponents['schemas']['Quote'];
type InstrumentResponse = MarketComponents['schemas']['InstrumentResponse'];
type QuoteResponse = MarketComponents['schemas']['QuoteResponse'];
type FundamentalSummary = FundamentalComponents['schemas']['FundamentalSummary'];
type FundamentalSummaryResponse = FundamentalComponents['schemas']['FundamentalSummaryResponse'];
type WatchlistResponse = WatchlistComponents['schemas']['WatchlistResponse'];
type ResponseMeta = SharedComponents['schemas']['ResponseMeta'];

interface ApiResponseBody<T> {
  data?: T;
  response: { status: number };
}

type SafeResult<T> =
  | { ok: true; status: number; body: T | undefined }
  | { ok: false; network: true };

/** 把「网络失败」与「有响应但非 2xx」分开；网络失败时不在客户端猜测状态码。 */
async function safeRequest<T>(run: () => Promise<ApiResponseBody<T>>): Promise<SafeResult<T>> {
  try {
    const result = await run();
    return { ok: true, status: result.response.status, body: result.data };
  } catch {
    return { ok: false, network: true };
  }
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

export interface ApiGatewayOptions {
  /** 同源部署传 ''（E2E 由 web 容器反代 /v1）；跨域时传 API origin。 */
  baseUrl?: string;
  /** 测试注入用；传入时不再挂鉴权中间件。 */
  client?: ApiClient;
}

/** 浏览器离线时短路，避免把「没网」拖成一次超时后的模糊错误。 */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function networkError(): GatewayError {
  return { status: null, network: true };
}

function responseError(status: number): GatewayError {
  return { status, network: false };
}

function mapSource(meta: ResponseMeta | undefined): SourceInfo | null {
  if (!meta) return null;
  return {
    source: meta.source.source,
    asOf: meta.source.as_of,
    stalenessMs: meta.source.staleness_ms,
    adjustment: meta.adjustment ?? null,
  };
}

function mapDisclaimer(meta: ResponseMeta | undefined): DisclaimerInfo | null {
  const disclaimer = meta?.disclaimer;
  if (!disclaimer) return null;
  return { text: disclaimer.text, version: disclaimer.version, closable: disclaimer.closable };
}

function mapQuote(quote: Quote): QuoteInfo {
  return {
    tradeDate: quote.trade_date,
    lastPrice: quote.last_price ?? null,
    prevClose: quote.prev_close ?? null,
    change: quote.change ?? null,
    changePct: quote.change_pct ?? null,
    suspended: quote.suspended,
    limitStatus: quote.limit_status ?? null,
  };
}

function mapFundamental(
  summary: FundamentalSummary,
  meta: ResponseMeta | undefined,
): FundamentalInfo | null {
  const source = mapSource(meta);
  if (!source) return null;
  return {
    reportPeriod: summary.report_period,
    reportEndDate: summary.report_end_date,
    announcedAt: summary.announced_at,
    statementBasis: summary.statement_basis,
    revenue: summary.revenue,
    netProfit: summary.net_profit,
    revenueYoyPct: summary.revenue_yoy_pct ?? null,
    netProfitYoyPct: summary.net_profit_yoy_pct ?? null,
    eps: summary.eps ?? null,
    roePct: summary.roe_pct ?? null,
    grossMarginPct: summary.gross_margin_pct ?? null,
    totalAssets: summary.total_assets ?? null,
    source,
  };
}

class ApiMarketGateway implements MarketGateway {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async getStockPage(instrumentId: string): Promise<StockPageResult> {
    if (isOffline()) {
      return { kind: 'error', instrumentId, ...networkError() };
    }

    const instrumentRes = await safeRequest<InstrumentResponse>(() =>
      this.client.GET('/v1/instruments/{instrument_id}', {
        params: { path: { instrument_id: instrumentId } },
      }),
    );
    if (!instrumentRes.ok) return { kind: 'error', instrumentId, ...networkError() };
    if (!isOk(instrumentRes.status)) {
      return { kind: 'error', instrumentId, ...responseError(instrumentRes.status) };
    }

    const instrument: Instrument | undefined = instrumentRes.body?.data;
    if (!instrument) {
      return { kind: 'error', instrumentId, status: null, network: false };
    }

    const quoteRes = await safeRequest<QuoteResponse>(() =>
      this.client.GET('/v1/instruments/{instrument_id}/quote', {
        params: { path: { instrument_id: instrumentId } },
      }),
    );
    if (!quoteRes.ok) return { kind: 'error', instrumentId, ...networkError() };

    const fundamentalRes = await safeRequest<FundamentalSummaryResponse>(() =>
      this.client.GET('/v1/instruments/{instrument_id}/fundamental-summary', {
        params: { path: { instrument_id: instrumentId } },
      }),
    );

    const quoteStatus = quoteRes.status;
    const quoteMeta: ResponseMeta | undefined = quoteRes.body?.meta;
    const quoteData: Quote | undefined = quoteRes.body?.data;
    const fundamentalMeta: ResponseMeta | undefined = fundamentalRes.ok
      ? fundamentalRes.body?.meta
      : undefined;

    let access: DataAccess = 'restricted';
    let quote: QuoteInfo | null = null;
    let source: SourceInfo | null = null;
    let disclaimer: DisclaimerInfo | null = null;

    if (isOk(quoteStatus) && quoteData && quoteMeta) {
      disclaimer = mapDisclaimer(quoteMeta);
      source = mapSource(quoteMeta);
      if (quoteMeta.entitlement.is_entitled) {
        access = 'granted';
        quote = mapQuote(quoteData);
      } else {
        // 防御分支：200 但 is_entitled=false 时同样不得渲染数值（AC-5）。
        access = 'restricted';
        quote = null;
      }
    } else if (quoteStatus === 403) {
      access = 'restricted';
    } else {
      return { kind: 'error', instrumentId, ...responseError(quoteStatus) };
    }

    const fundamentalStatus = fundamentalRes.ok ? fundamentalRes.status : null;
    let fundamental: FundamentalInfo | null = null;
    let fundamentalState: FundamentalState = 'missing';

    if (fundamentalRes.ok && isOk(fundamentalRes.status) && fundamentalRes.body?.data) {
      // H4：数值展示的唯一开关是服务端 entitlement.is_entitled === true。
      const entitled = fundamentalRes.body.meta?.entitlement.is_entitled === true;
      const mapped = entitled
        ? mapFundamental(fundamentalRes.body.data, fundamentalRes.body.meta)
        : null;
      if (mapped) {
        fundamental = mapped;
        fundamentalState = 'ready';
      } else {
        fundamentalState = 'error';
      }
    } else if (fundamentalStatus === 404) {
      fundamentalState = 'missing';
    } else if (fundamentalStatus !== null) {
      // 受限矩阵下基本面断言由 E2E 跳过；这里如实显示「暂时无法取得」，不伪造。
      fundamentalState = 'error';
    } else {
      fundamentalState = 'error';
    }

    if (access === 'restricted') {
      // 403 时 quote 响应无 meta；免责文案若基本面响应携带则复用（同一规则版本），否则留空由页面声明缺失。
      disclaimer ??= mapDisclaimer(fundamentalMeta);
    }

    if (
      access === 'granted' &&
      (!quote || !source || !disclaimer || source.source.trim() === '' || source.asOf.trim() === '')
    ) {
      // 有响应但缺免责/时点：视为结构不合法（非网络错误），页面停止展示价格。
      return { kind: 'error', instrumentId, status: null, network: false };
    }

    const data: StockPageData = {
      instrumentId,
      name: instrument.name,
      exchange: instrument.exchange,
      board: instrument.board,
      listStatus: instrument.list_status,
      securityType: instrument.security_type,
      listedAt: instrument.listed_at ?? null,
      access,
      quote,
      source,
      disclaimer,
      fundamental,
      fundamentalState,
    };

    return { kind: 'ready', data };
  }

  async getWatchlist(): Promise<WatchlistResult> {
    if (isOffline()) return { kind: 'error', ...networkError() };
    const result = await safeRequest<WatchlistResponse>(() => this.client.GET('/v1/watchlist'));
    if (!result.ok) return { kind: 'error', ...networkError() };
    if (result.status === 401) return { kind: 'anonymous' };
    if (!isOk(result.status) || !result.body) {
      return { kind: 'error', ...responseError(result.status) };
    }
    return {
      kind: 'ready',
      instrumentIds: result.body.data.items.map((item) => item.instrument_id),
    };
  }

  async addToWatchlist(instrumentId: string): Promise<WatchlistMutationResult> {
    if (isOffline()) return { kind: 'error', ...networkError() };
    const result = await safeRequest(() =>
      this.client.POST('/v1/watchlist', { body: { instrument_id: instrumentId } }),
    );
    if (!result.ok) return { kind: 'error', ...networkError() };
    if (result.status === 401) return { kind: 'anonymous' };
    if (!isOk(result.status)) return { kind: 'error', ...responseError(result.status) };
    return { kind: 'ok' };
  }

  async removeFromWatchlist(instrumentId: string): Promise<WatchlistMutationResult> {
    if (isOffline()) return { kind: 'error', ...networkError() };
    const result = await safeRequest(() =>
      this.client.DELETE('/v1/watchlist/{instrument_id}', {
        params: { path: { instrument_id: instrumentId } },
      }),
    );
    if (!result.ok) return { kind: 'error', ...networkError() };
    if (result.status === 401) return { kind: 'anonymous' };
    if (!isOk(result.status)) return { kind: 'error', ...responseError(result.status) };
    return { kind: 'ok' };
  }
}

export function createApiGateway(options: ApiGatewayOptions = {}): MarketGateway {
  if (options.client) return new ApiMarketGateway(options.client);

  const baseUrl =
    options.baseUrl ?? (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  const client = createApiClient({ baseUrl });
  client.use({
    onRequest({ request }) {
      const token = readAuthToken();
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
  });
  return new ApiMarketGateway(client);
}
