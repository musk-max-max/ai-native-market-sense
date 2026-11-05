import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../../api/src/app.js';
import { createMarketPlugin } from '../src/plugin.js';
import type { MarketConfig } from '../src/config.js';
import { loadMarketConfig } from '../src/config.js';
import { configFingerprint } from '../src/domain/entitlement.js';
import type { EntitlementControlRepo, EntitlementEventRepo } from '../src/ports/entitlement.js';
import type {
  BarsPage,
  BarsQuery,
  FundamentalSummaryRow,
  InstrumentRow,
  MarketBarRow,
  QuoteRow,
  ServingRepo,
} from '../src/ports/serving-repo.js';
import type { WatchlistRepo } from '../src/ports/watchlist-repo.js';

const NOW = new Date('2026-11-05T10:00:00+08:00');
const AS_OF = '2026-11-04T15:00:00+08:00';
const TOKEN = 'b1-token';

const instrument: InstrumentRow = {
  instrument_id: 'SSE:600519',
  exchange: 'SSE',
  code: '600519',
  name: '贵州茅台',
  board: 'main',
  security_type: 'stock',
  list_status: 'listed',
  lot_size: 100,
  listed_at: '2001-08-27',
  display_safe: true,
  source: 'tushare',
  asOf: AS_OF,
  stalenessMs: 0,
};

const gem: InstrumentRow = {
  ...instrument,
  instrument_id: 'SZSE:300001',
  exchange: 'SZSE',
  code: '300001',
  name: '创业标的',
  board: 'gem',
};

const quote: QuoteRow = {
  instrument_id: 'SSE:600519',
  trade_date: '2026-11-04',
  open: '1500.00',
  high: '1520.00',
  low: '1490.00',
  close: '1510.00',
  prev_close: '1505.00',
  change: '5.00',
  change_pct: '0.3322',
  volume: 1000,
  amount: '1510000.00',
  suspended: false,
  limit_status: 'none',
  source: 'tushare',
  asOf: AS_OF,
  stalenessMs: 0,
};

const fundamental: FundamentalSummaryRow = {
  instrument_id: 'SSE:600519',
  report_period: '2026Q3',
  report_end_date: '2026-09-30',
  announced_at: '2026-10-30',
  statement_basis: 'reported',
  currency: 'CNY',
  revenue: '1000.00',
  net_profit: '500.00',
  revenue_yoy_pct: null,
  net_profit_yoy_pct: null,
  eps: null,
  roe_pct: null,
  gross_margin_pct: null,
  source: 'tushare',
  asOf: AS_OF,
  stalenessMs: 0,
};

class FakeServing implements ServingRepo {
  async getInstrument(instrumentId: string): Promise<InstrumentRow | null> {
    if (instrumentId === instrument.instrument_id) return instrument;
    if (instrumentId === gem.instrument_id) return gem;
    return null;
  }

  async getQuote(instrumentId: string): Promise<QuoteRow | null> {
    return instrumentId === instrument.instrument_id ? quote : null;
  }

  async getBars(query: BarsQuery): Promise<BarsPage> {
    const dates = ['2026-11-02', '2026-11-03', '2026-11-04'];
    const rows = dates.map((date, index) => ({
      instrument_id: query.instrumentId,
      trade_date: date,
      adj_type: query.adjType,
      open: '10.00',
      high: '10.00',
      low: '10.00',
      close: String(10 + index),
      volume: 100,
      amount: '1000.00',
      factor: null,
      source: 'tushare',
      asOf: AS_OF,
      stalenessMs: 0,
    }));
    return { rows, hasMore: false, adjustment: query.adjType };
  }

  async getLatestFactor(): Promise<null> {
    return null;
  }

  async getFundamentalSummary(instrumentId: string): Promise<FundamentalSummaryRow | null> {
    return instrumentId === instrument.instrument_id ? fundamental : null;
  }

  async listTradeDates(limit: number, to?: string): Promise<string[]> {
    const dates = ['2026-10-31', '2026-11-02', '2026-11-03', '2026-11-04'];
    return dates.filter((date) => to === undefined || date <= to).slice(-limit);
  }

  async getMarketBars(query: { dates: readonly string[] }): Promise<MarketBarRow[]> {
    const rows: MarketBarRow[] = [];
    const closes: Record<string, [number, number, number]> = {
      'SSE:600519': [10, 11, 12.1],
      'SZSE:300001': [20, 24, 28.8],
    };
    for (const [instrumentId, values] of Object.entries(closes)) {
      const inst = instrumentId === instrument.instrument_id ? instrument : gem;
      ['2026-11-02', '2026-11-03', '2026-11-04'].forEach((date, index) => {
        if (!query.dates.includes(date)) return;
        rows.push({
          ...inst,
          instrument_id: instrumentId,
          trade_date: date,
          adj_type: 'none',
          open: values[index]?.toFixed(2) ?? '0.00',
          high: values[index]?.toFixed(2) ?? '0.00',
          low: values[index]?.toFixed(2) ?? '0.00',
          close: values[index]?.toFixed(2) ?? '0.00',
          volume: 100,
          amount: '1000.00',
          factor: null,
          source: inst.source,
          asOf: inst.asOf,
          stalenessMs: inst.stalenessMs,
        });
      });
    }
    return rows;
  }

  async listInstruments(): Promise<InstrumentRow[]> {
    return [instrument, gem];
  }
}

class FakeWatchlist implements WatchlistRepo {
  async list(): Promise<Array<{ instrument_id: string; added_at: Date }>> {
    return [{ instrument_id: 'SSE:600519', added_at: new Date('2026-01-01T00:00:00Z') }];
  }

  async add(): Promise<never> {
    throw new Error('not used');
  }

  async remove(): Promise<void> {
    throw new Error('not used');
  }

  async ensureSchema(): Promise<void> {}
}

const control: EntitlementControlRepo = {
  async fetchControl() {
    return { hold: false, holdId: null, reason: null, lastReconciledAt: NOW };
  },
};

const events: Array<{ eventType: string }> = [];
const eventRepo: EntitlementEventRepo = {
  async insert(record) {
    events.push({ eventType: record.eventType });
  },
};

function configFor(tier: 'internal_eval' | 'c_end_display'): MarketConfig {
  const expiresAt = '2030-12-31T00:00:00Z';
  const baseEnv: NodeJS.ProcessEnv = {
    APP_PROFILE: 'test',
    ENTITLEMENT_TIER: tier,
    ENTITLEMENT_HOLD_CHECK: '1',
    ENTITLEMENT_AUDIT: '1',
  };
  if (tier === 'c_end_display') {
    return loadMarketConfig({
      ...baseEnv,
      ENTITLEMENT_EXPIRES_AT: expiresAt,
      ENTITLEMENT_CONFIG_EXPECTED_SHA256: configFingerprint('c_end_display', new Date(expiresAt).toISOString()),
    });
  }
  return loadMarketConfig(baseEnv);
}

function createApp(tier: 'internal_eval' | 'c_end_display', authenticate: () => { userId: string } | null = () => ({ userId: 'user-1' })) {
  const plugin = createMarketPlugin({
    config: { ...configFor(tier), now: () => NOW },
    servingRepo: new FakeServing(),
    watchlistRepo: new FakeWatchlist(),
    controlRepo: control,
    eventRepo,
    bootId: `11111111-1111-4111-8111-${tier === 'c_end_display' ? '111111111111' : '222222222222'}`,
    authenticate,
  });
  return buildApp({ domainPlugins: [plugin], logger: false });
}

describe('B1 路由（watchlist review / limit-ladder / page-summary）', () => {
  it('review：已授权 200，返回确定性统计、meta.adjustment 与 disclaimer', async () => {
    const app = createApp('c_end_display');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/watchlist/review?adjustment=qfq',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.meta.adjustment, 'qfq');
    assert.equal(body.meta.entitlement.tier, 'c_end_display');
    assert.equal(body.meta.entitlement.is_entitled, true);
    assert.ok(body.meta.disclaimer.version);
    assert.equal(body.data.adjustment, 'qfq');
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].instrument_id, 'SSE:600519');
    assert.equal(body.data.universe.count, 1);
  });

  it('review：受限档（internal_eval）403 ENTITLEMENT_RESTRICTED', async () => {
    const app = createApp('internal_eval');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/watchlist/review',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'ENTITLEMENT_RESTRICTED');
  });

  it('review：无 bearer token 401', async () => {
    const app = createApp('c_end_display', () => null);
    const response = await app.inject({ method: 'GET', url: '/v1/watchlist/review' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 'UNAUTHENTICATED');
  });

  it('limit-ladder：已授权 200，rule.price_basis=none，涨停梯队递归无行情泄漏字段', async () => {
    const app = createApp('c_end_display');
    const response = await app.inject({ method: 'GET', url: '/v1/market/limit-ladder' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.meta.adjustment, 'none');
    assert.equal(body.data.rule.price_basis, 'none');
    assert.equal(body.data.rule.version, 'b1-02-provisional-v1');
    assert.ok(body.data.limit_up.length >= 1);
    assert.equal(body.data.limit_up[0].instrument_id, 'SSE:600519');
    assert.equal(body.data.limit_up[0].consecutive_boards, 2);
  });

  it('limit-ladder：受限档 403', async () => {
    const app = createApp('internal_eval');
    const response = await app.inject({ method: 'GET', url: '/v1/market/limit-ladder' });
    assert.equal(response.statusCode, 403);
  });

  it('page-summary：已授权 200，五段各一次，行情/财务 available，其余 pending/gap 显式', async () => {
    const app = createApp('c_end_display');
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/page-summary' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(
      body.data.sections.map((section: { id: string }) => section.id),
      ['quote', 'fundamental', 'valuation', 'capital', 'risk'],
    );
    assert.equal(body.data.sections[0].availability, 'available');
    assert.equal(body.data.sections[1].availability, 'available');
    assert.equal(body.data.sections[2].availability, 'pending');
    assert.ok(body.meta.disclaimer.version);
    assert.equal(body.meta.entitlement.tier, 'c_end_display');
  });

  it('page-summary：受限档 200 restricted 骨架，不带数值/data_refs', async () => {
    const app = createApp('internal_eval');
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/page-summary' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.sections[0].availability, 'restricted');
    assert.equal(body.data.sections[1].availability, 'restricted');
    assert.deepEqual(body.data.sections[0].data_refs ?? [], []);
    const text = JSON.stringify(body.data);
    for (const forbidden of ['last_price', 'close', 'volume', '1510', 'change_pct']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });

  it('page-summary：不存在标的 404 INSTRUMENT_NOT_FOUND', async () => {
    const app = createApp('c_end_display');
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:999999/page-summary' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'INSTRUMENT_NOT_FOUND');
  });
});
