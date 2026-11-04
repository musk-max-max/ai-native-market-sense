/**
 * A11 G-IMPL 本地实现驱动（no docker 模式）。
 *
 * 目的：在没有 docker/Postgres 的开发机上，用 A3 的真实 market 插件 + 内存假仓储起一个
 * 真实 HTTP 服务，供 tests/contract/live_impl_check.py 对「实现」做契约首跑。
 * 这不能替代 tests/e2e 的真栈（A12），但它验证的是 A3 的路由/序列化/错误映射代码本身。
 *
 * 用法：services/market/node_modules/.bin/tsx tests/contract/live_harness/harness.ts
 * 输出：一行 JSON {"baseUrl":"http://127.0.0.1:<port>"}，之后保持运行直到 SIGTERM。
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { installErrorHandling } from '../../../services/api/src/errors.ts';
import { createMarketPlugin } from '../../../services/market/src/plugin.ts';
import type {
  EntitlementControlRepo,
  EntitlementControlRow,
  EntitlementEventRecord,
  EntitlementEventRepo,
} from '../../../services/market/src/ports/entitlement.ts';
import type {
  BarRow,
  BarsPage,
  BarsQuery,
  FundamentalSummaryRow,
  InstrumentRow,
  QuoteRow,
  ServingRepo,
  SourceInfo,
} from '../../../services/market/src/ports/serving-repo.ts';
import type { WatchlistRepo } from '../../../services/market/src/ports/watchlist-repo.ts';
import type { MarketConfig } from '../../../services/market/src/config.ts';

const requireFromApi = createRequire(new URL('../../../services/api/package.json', import.meta.url));
const Fastify = requireFromApi('fastify') as typeof import('fastify').default;

const AS_OF = '2026-11-03T15:00:00+08:00';
// 契约 shared SourceRef.source 是封闭枚举 platform_*；serving 端口目前是自由字符串（A2 ports.yaml），
// 由 A3 HTTP 边界负责映射到契约词表。这里按契约合法值给样本，用于发现映射层之后的问题。
const source: SourceInfo = { source: 'platform_eod', asOf: AS_OF, stalenessMs: 1000 };

const INSTRUMENTS: Record<string, InstrumentRow> = {
  'SSE:600519': {
    ...source,
    instrument_id: 'SSE:600519',
    exchange: 'SSE',
    code: '600519',
    name: '贵州茅台',
    board: 'main',
    security_type: 'stock',
    list_status: 'listed',
    listed_at: '2001-08-27',
  },
  'SSE:688981': {
    ...source,
    instrument_id: 'SSE:688981',
    exchange: 'SSE',
    code: '688981',
    name: '中芯国际',
    board: 'star',
    security_type: 'stock',
    list_status: 'listed',
    listed_at: '2020-07-16',
  },
};

const quotes: Record<string, QuoteRow> = {
  'SSE:600519': {
    ...source,
    instrument_id: 'SSE:600519',
    trade_date: '2026-11-03',
    open: '1650.00',
    high: '1688.00',
    low: '1645.00',
    close: '1680.50',
    prev_close: '1666.00',
    change: '14.50',
    change_pct: '0.87',
    volume: 3124500,
    amount: '5240000000.00',
    suspended: false,
    limit_status: 'none',
  },
  'SSE:688981': {
    ...source,
    instrument_id: 'SSE:688981',
    trade_date: '2026-11-03',
    open: null,
    high: null,
    low: null,
    close: null,
    prev_close: '86.20',
    change: null,
    change_pct: null,
    volume: 0,
    amount: null,
    suspended: true,
    limit_status: 'none',
  },
};

const bars: BarRow[] = [
  {
    ...source,
    instrument_id: 'SSE:600519',
    trade_date: '2026-10-30',
    adj_type: 'none',
    open: '1660.00',
    high: '1672.00',
    low: '1652.00',
    close: '1666.00',
    volume: 2800000,
    amount: '4670000000.00',
    factor: '1.0',
  },
  {
    ...source,
    instrument_id: 'SSE:600519',
    trade_date: '2026-11-02',
    adj_type: 'none',
    open: '1668.00',
    high: '1675.00',
    low: '1660.00',
    close: '1670.00',
    volume: 2950000,
    amount: '4920000000.00',
    factor: '1.0',
  },
  {
    ...source,
    instrument_id: 'SSE:600519',
    trade_date: '2026-11-03',
    adj_type: 'none',
    open: '1672.00',
    high: '1688.00',
    low: '1665.00',
    close: '1680.50',
    volume: 3124500,
    amount: '5240000000.00',
    factor: '1.0',
  },
];

const fundamental: FundamentalSummaryRow = {
  ...source,
  instrument_id: 'SSE:600519',
  report_period: '2026Q3',
  report_end_date: '2026-09-30',
  announced_at: '2026-10-25T18:30:00+08:00',
  statement_basis: 'reported',
  currency: 'CNY',
  revenue: '130900000000.00',
  net_profit: '64600000000.00',
  revenue_yoy_pct: '15.66',
  net_profit_yoy_pct: '13.53',
  eps: '51.42',
  roe_pct: '25.31',
  gross_margin_pct: '91.30',
};

class FakeServingRepo implements ServingRepo {
  async getInstrument(instrumentId: string): Promise<InstrumentRow | null> {
    return INSTRUMENTS[instrumentId] ?? null;
  }
  async getQuote(instrumentId: string): Promise<QuoteRow | null> {
    return quotes[instrumentId] ?? null;
  }
  async getBars(query: BarsQuery): Promise<BarsPage> {
    return { rows: bars.filter((b) => b.instrument_id === query.instrumentId), hasMore: false, adjustment: query.adjType };
  }
  async getLatestFactor(): Promise<null> {
    return null;
  }
  async getFundamentalSummary(instrumentId: string): Promise<FundamentalSummaryRow | null> {
    return instrumentId === fundamental.instrument_id ? fundamental : null;
  }
}

class FakeWatchlistRepo implements WatchlistRepo {
  private readonly items = new Map<string, Date>([
    ['SSE:600519', new Date('2026-11-01T09:30:00+08:00')],
  ]);
  async list(userId: string) {
    void userId;
    return [...this.items.entries()].map(([instrument_id, added_at]) => ({ instrument_id, added_at }));
  }
  async add(userId: string, instrumentId: string, limit: number) {
    void userId;
    const created = !this.items.has(instrumentId);
    if (created) {
      if (this.items.size >= limit) throw new Error('watchlist limit exceeded');
      this.items.set(instrumentId, new Date('2026-11-04T09:30:00+08:00'));
    }
    return {
      item: { instrument_id: instrumentId, added_at: this.items.get(instrumentId) as Date },
      created,
    };
  }
  async remove(userId: string, instrumentId: string): Promise<void> {
    void userId;
    this.items.delete(instrumentId);
  }
  async ensureSchema(): Promise<void> {}
}

const TIERS = ['internal_eval', 'c_end_display', 'research_only', 'platform_user_data'] as const;
const tierEnv = process.env.ENTITLEMENT_TIER;
if (tierEnv !== undefined && !TIERS.includes(tierEnv as (typeof TIERS)[number])) {
  throw new Error(`ENTITLEMENT_TIER 非法: ${tierEnv}`);
}

const expiresAtEnv = process.env.ENTITLEMENT_EXPIRES_AT?.trim();
// 测试专用：A3 要求 tier!=internal_eval 时必带配置指纹（流水线按 sha256("<tier>|<expiresAt>") 注入）。
// 真栈必须由发布流水线从审批记录派生；harness 只在本地按同一公式自算，不模拟生产。
const expectedShaEnv = process.env.ENTITLEMENT_CONFIG_EXPECTED_SHA256?.trim();
const expectedSha = expectedShaEnv && expectedShaEnv !== ''
  ? expectedShaEnv
  : tierEnv && expiresAtEnv
    ? createHash('sha256').update(`${tierEnv}|${expiresAtEnv}`).digest('hex')
    : undefined;
const marketNowEnv = process.env.MARKET_NOW?.trim();
if (marketNowEnv !== undefined && Number.isNaN(Date.parse(marketNowEnv))) {
  throw new Error(`MARKET_NOW 非法: ${marketNowEnv}`);
}

// 测试注入的 control 行（A11_CONTROL=hold|stale|missing|unavailable），
// 用真实 A3 EntitlementGate 验证 hold/stale/不可达三条 fail-closed 路径，不需要真 PG。
const controlMode = process.env.A11_CONTROL?.trim();
/** A11 写失败注入：transient=连接断（非阻断）/ deterministic=权限错误（阻断，启动拒绝）。 */
function fakeEventRepo(mode: string): EntitlementEventRepo | undefined {
  if (mode === 'transient') {
    return {
      async insert(_record: EntitlementEventRecord): Promise<void> {
        throw new Error('connection terminated unexpectedly');
      },
    };
  }
  if (mode === 'deterministic') {
    return {
      async insert(_record: EntitlementEventRecord): Promise<void> {
        const error = new Error('permission denied for table entitlement_events') as Error & { code?: string };
        error.code = '42501';
        throw error;
      },
    };
  }
  return undefined;
}

function fakeControlRepo(clock: () => Date): EntitlementControlRepo | null {
  if (!controlMode) return null;
  return {
    async fetchControl(): Promise<EntitlementControlRow | null> {
      if (controlMode === 'unavailable') {
        throw new Error('fake control unreachable (A11 harness)');
      }
      if (controlMode === 'missing') return null;
      // 必须跟闸门用同一个可注入时钟：真实 Date.now() 会与 MARKET_NOW 打架，
      // 把 hold 误判成 control_stale（上次实跑就踩到）。
      const nowMs = clock().getTime();
      const lastReconciledAt = controlMode === 'stale' ? new Date(nowMs - 16 * 60_000) : new Date(nowMs);
      return {
        lastReconciledAt,
        hold: controlMode === 'hold',
        holdId: controlMode === 'hold' ? 'hold-test-id' : null,
        reason: controlMode === 'hold' ? 'manual_signoff' : null,
      };
    },
  };
}

const config: MarketConfig = {
  // 默认 internal_eval：未设 ENTITLEMENT_EXPIRES_AT 时 c_end_display 会按 L18 拒绝启动，
  // 测试工具不应默认 fail-open（A3 m00978）。
  entitlementTier: (tierEnv as MarketConfig['entitlementTier']) ?? 'internal_eval',
  ...(expiresAtEnv !== undefined && expiresAtEnv !== '' ? { entitlementExpiresAt: expiresAtEnv } : {}),
  ...(expectedSha !== undefined ? { entitlementExpectedSha256: expectedSha } : {}),
  disclaimer: {
    text: '本页面数据仅供参考，不构成任何投资建议或买卖依据。数据可能存在延迟，请以交易所及上市公司公告为准。',
    version: '2026.11.1',
  },
  watchlistLimit: 100,
  watchlistTable: 'watchlist_items',
  allowDevAuth: false,
  devAuthUserId: 'qa',
  autoMigrate: false,
  now: () => new Date(marketNowEnv === undefined || marketNowEnv === '' ? '2026-11-03T15:02:00+08:00' : marketNowEnv),
};

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  installErrorHandling(app);
  const eventWriteMode = process.env.A11_EVENT_WRITE ?? '';
  const eventRepo = fakeEventRepo(eventWriteMode);
  const market = createMarketPlugin({
      config,
      servingRepo: new FakeServingRepo(),
      watchlistRepo: new FakeWatchlistRepo(),
      authenticate: () => ({ userId: 'qa-user' }),
      ...(fakeControlRepo(() => new Date(marketNowEnv === undefined || marketNowEnv === '' ? '2026-11-03T15:02:00+08:00' : marketNowEnv)) !== null
        ? {
            controlRepo: fakeControlRepo(() =>
              new Date(marketNowEnv === undefined || marketNowEnv === '' ? '2026-11-03T15:02:00+08:00' : marketNowEnv),
            )!,
          }
        : {}),
      ...(eventRepo !== undefined ? { eventRepo } : {}),
  });
  await app.register(market, { prefix: '/v1' });
  // 只暴露 A3 域贡献（data_ready + entitlement_degraded），与外壳 /healthz 合并语义一致。
  app.get('/healthz', async () => ({ ...(await market.health()) }));
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  process.stdout.write(`${JSON.stringify({ baseUrl: address })}\n`);
  const close = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
