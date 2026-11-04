/**
 * Mock 数据适配器（本地 UI/状态开发用）。
 *
 * 定位：不是「假数据上线」，而是让 UI/状态机/E2E testid 先跑通的 fixture 形状；
 *  - 形状严格按 contracts/ 的展示语义（as_of、staleness、disclaimer、entitlement 都齐全）；
 *  - 刻意只收录一只示例标的，未收录标的返回 404，避免对任意代码伪造行情；
 *  - 演示状态用 URL 查询参数 ?mock=... 切换，不污染生产路由：
 *      restricted（403/受限）、stale（>15min）、error（500）、rate-limited（429）、
 *      offline（网络失败）、loading、no-fundamental、fundamental-error、
 *      unknown-source（AC-1b 未覆盖取值原样展示）、guest（未登录）、
 *      delisted（终止上市）、prelisted（未上市）、suspended（停牌，无最新价）。
 *
 * 集成真实客户端后本文件不进入生产路径（见 data/index.ts 的装配点）。
 */
import type {
  MarketGateway,
  StockPageResult,
  WatchlistMutationResult,
  WatchlistResult,
} from './gateway';
import type {
  DisclaimerInfo,
  FundamentalInfo,
  QuoteInfo,
  SourceInfo,
  StockPageData,
} from './model';

const MOCK_WATCHLIST_KEY = 'h5.mock.watchlist';
const MOCK_DELAY_MS = 150;

const AS_OF = '2026-11-03T15:00:00+08:00';
const TRADE_DATE = '2026-11-03';

const DISCLAIMER: DisclaimerInfo = {
  text:
    '本平台展示的行情、基本面与自选信息均来自公开数据源，可能存在延迟、缺失或误差；' +
    '所有内容仅作为客观数据展示，不构成任何投资建议、要约或收益承诺。' +
    '投资有风险，入市需谨慎，请独立判断并自行承担投资决策后果。',
  version: '2026.11.1',
  closable: false,
};

interface MockInstrument {
  name: string;
  exchange: string;
  board: string;
  listStatus: string;
  securityType: string;
  listedAt: string;
  quote: QuoteInfo;
  fundamental: Omit<FundamentalInfo, 'source'>;
}

function quoteSource(
  stalenessMs: number,
  sourceName: string = 'platform_snapshot',
  adjustment: string = 'none',
): SourceInfo {
  return { source: sourceName, asOf: AS_OF, stalenessMs, adjustment };
}

function fundamentalSource(): SourceInfo {
  return { source: 'platform_fundamental', asOf: AS_OF, stalenessMs: 3_600_000, adjustment: null };
}

const INSTRUMENTS: Record<string, MockInstrument> = {
  'SSE:600519': {
    name: '贵州茅台',
    exchange: 'SSE',
    board: 'main',
    listStatus: 'listed',
    securityType: 'stock',
    listedAt: '2001-08-27',
    quote: {
      tradeDate: TRADE_DATE,
      lastPrice: 1680,
      prevClose: 1667.66,
      change: 12.34,
      changePct: 0.74,
      suspended: false,
      limitStatus: 'none',
    },
    fundamental: {
      reportPeriod: '2026Q3',
      reportEndDate: '2026-09-30',
      announcedAt: '2026-10-30T18:00:00+08:00',
      statementBasis: 'reported',
      revenue: 123_456_789_000,
      netProfit: 60_123_000_000,
      revenueYoyPct: 10.5,
      netProfitYoyPct: 12.3,
      eps: 47.82,
      roePct: 30.15,
      grossMarginPct: 91.28,
      totalAssets: 300_000_000_000,
    },
  },
};

type MockState =
  | 'normal'
  | 'restricted'
  | 'stale'
  | 'error'
  | 'rate-limited'
  | 'offline'
  | 'loading'
  | 'no-fundamental'
  | 'fundamental-error'
  | 'unknown-source'
  | 'guest'
  | 'delisted'
  | 'prelisted'
  | 'suspended';

function readMockState(): MockState {
  const value = new URLSearchParams(window.location.search).get('mock');
  switch (value) {
    case 'restricted':
    case 'stale':
    case 'error':
    case 'rate-limited':
    case 'offline':
    case 'loading':
    case 'no-fundamental':
    case 'fundamental-error':
    case 'unknown-source':
    case 'guest':
    case 'delisted':
    case 'prelisted':
    case 'suspended':
      return value;
    default:
      return 'normal';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readWatchlist(): string[] {
  try {
    const raw = window.localStorage.getItem(MOCK_WATCHLIST_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeWatchlist(ids: string[]): void {
  try {
    window.localStorage.setItem(MOCK_WATCHLIST_KEY, JSON.stringify(ids));
  } catch {
    // 存储不可用时仅本次会话内生效（mock 场景可接受）。
  }
}

function buildPage(instrumentId: string, state: MockState): StockPageResult {
  const instrument = INSTRUMENTS[instrumentId];
  if (!instrument) {
    return { kind: 'error', instrumentId, status: 404, network: false };
  }

  const staleMs = state === 'stale' ? 3_600_000 : 120_000;
  const restricted = state === 'restricted';
  const fundamentalMissing = state === 'no-fundamental' || restricted;
  const fundamentalError = state === 'fundamental-error';

  const listStatus =
    state === 'delisted'
      ? 'delisted'
      : state === 'prelisted'
        ? 'pre_listed'
        : instrument.listStatus;
  const listedAt = state === 'prelisted' ? null : instrument.listedAt;
  const quote =
    state === 'suspended'
      ? {
          ...instrument.quote,
          lastPrice: null,
          prevClose: null,
          change: null,
          changePct: null,
          suspended: true,
        }
      : instrument.quote;

  const source = restricted
    ? null
    : quoteSource(staleMs, state === 'unknown-source' ? 'weird_source' : 'platform_snapshot');
  const fundamental: FundamentalInfo | null = fundamentalMissing
    ? null
    : { ...instrument.fundamental, source: fundamentalSource() };

  const data: StockPageData = {
    instrumentId,
    name: instrument.name,
    exchange: instrument.exchange,
    board: instrument.board,
    listStatus,
    securityType: instrument.securityType,
    listedAt,
    access: restricted ? 'restricted' : 'granted',
    quote: restricted ? null : quote,
    source,
    disclaimer: DISCLAIMER,
    fundamental,
    fundamentalState: fundamentalMissing ? 'missing' : fundamentalError ? 'error' : 'ready',
  };

  return { kind: 'ready', data };
}

export function createMockGateway(): MarketGateway {
  return {
    async getStockPage(instrumentId: string): Promise<StockPageResult> {
      const state = readMockState();
      if (state === 'loading') {
        // 永不 resolve：用于验证 loading 态与 E2E 的等待逻辑。
        return new Promise<StockPageResult>(() => {});
      }
      await delay(MOCK_DELAY_MS);
      if (state === 'offline') {
        return { kind: 'error', instrumentId, status: null, network: true };
      }
      if (state === 'rate-limited') {
        return { kind: 'error', instrumentId, status: 429, network: false };
      }
      if (state === 'error') {
        return { kind: 'error', instrumentId, status: 500, network: false };
      }
      return buildPage(instrumentId, state);
    },

    async getWatchlist(): Promise<WatchlistResult> {
      await delay(MOCK_DELAY_MS);
      if (readMockState() === 'guest') return { kind: 'anonymous' };
      return { kind: 'ready', instrumentIds: readWatchlist() };
    },

    async addToWatchlist(instrumentId: string): Promise<WatchlistMutationResult> {
      await delay(MOCK_DELAY_MS);
      if (readMockState() === 'guest') return { kind: 'anonymous' };
      const ids = readWatchlist();
      if (!ids.includes(instrumentId)) writeWatchlist([instrumentId, ...ids]);
      return { kind: 'ok' };
    },

    async removeFromWatchlist(instrumentId: string): Promise<WatchlistMutationResult> {
      await delay(MOCK_DELAY_MS);
      if (readMockState() === 'guest') return { kind: 'anonymous' };
      writeWatchlist(readWatchlist().filter((id) => id !== instrumentId));
      return { kind: 'ok' };
    },
  };
}
