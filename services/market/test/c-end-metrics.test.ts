import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../../api/src/app.js';
import { createMarketPlugin } from '../src/plugin.js';
import type {
  CEndMetricsRepo,
  LimitLadderRow,
  MarketOverviewRow,
  StockMetricsRow,
} from '../src/ports/c-end-metrics-repo.js';
import type { ServingRepo } from '../src/ports/serving-repo.js';
import type { WatchlistRepo } from '../src/ports/watchlist-repo.js';

// 占位仓储（c-end 路由不用 serving/watchlist，但 plugin 启动必填）。
const unusedServing = {} as ServingRepo;
const unusedWatchlist = { async ensureSchema(): Promise<void> {} } as WatchlistRepo;

const TOKEN = 'test-c-end-token';

const FAKE_OVERVIEW: readonly MarketOverviewRow[] = [
  {
    metric_key: 'quote.last_close_avg',
    value_text: '24.13',
    unit: '元',
    dataset: 'dwd_stock_bar_daily',
    derivation: 'AVG(close) 最新交易日',
  },
  {
    metric_key: 'quote.instrument_count',
    value_text: '19',
    unit: '只',
    dataset: 'dim_instrument',
    derivation: 'COUNT(*) WHERE listed_at IS NOT NULL',
  },
];

const FAKE_STOCK: StockMetricsRow = {
  instrument_id: 'SSE:600519',
  instrument_name: '贵州茅台',
  exchange: 'SSE',
  quote_trade_date: '2026-11-12',
  close: '1510.00',
  volume: '30000',
  amount: '45000000000',
  prev_close: '1500.00',
  pct_change_pct: '0.67',
  turnover_rate_pct: '0.24',
  free_float_turnover_rate_pct: '0.31',
  volume_ratio: '0.90',
  pe: '25.10',
  pe_ttm: '24.80',
  pb: '8.30',
  ps_ttm: '9.20',
  dividend_yield_ttm_pct: '1.10',
  total_market_value: '1898600000000',
  circulating_market_value: '1898600000000',
  limit_status: null,
  close_5d_pct: '1.20',
  close_20d_pct: '3.40',
  close_60d_pct: '-2.10',
  ma20: '1480.00',
  amount_5d_avg: '44000000000',
  grossprofit_margin: '91.20',
  netprofit_margin: '52.30',
  roe: '31.50',
  roa: '22.10',
  roic: '28.40',
  profit_dedt: '62000000000',
  or_yoy_pct: '15.20',
  netprofit_yoy_pct: '18.30',
  assets_yoy_pct: '12.10',
  eqt_yoy_pct: '14.50',
  debt_to_assets: '22.30',
  current_ratio: '3.20',
  quick_ratio: '2.80',
  q_sales_qoq_pct: '4.20',
  fina_report_end_date: '2026-09-30',
  net_inflow_amount: '-150000000',
  xl_net: '-80000000',
  l_net: '-50000000',
  m_net: '-20000000',
  s_net: '100000000',
  lhb_net_amount: '30000000',
  holding_ratio_pct: '68.20',
  holder_number: '82000',
  avg_market_value: '1500000',
  pledged_shares: '0',
  as_of: '2026-11-12T15:00:00+08:00',
  staleness_ms: '0',
};

const FAKE_LIMIT_ROW: LimitLadderRow = {
  instrument_id: 'SZSE:000001',
  instrument_name: '平安银行',
  trade_date: '2026-11-12',
  up_limit: '12.50',
  down_limit: '10.30',
  limit_pct: '10.00',
  exchange: 'SZSE',
  close: '12.50',
  turnover_rate_pct: '5.10',
  pe_ttm: '6.30',
  total_market_value: '242000000000',
  limit_status: 'up',
  seal_ratio_pct_hint: '85.20',
  net_inflow_amount: '180000000',
  l1_name: '银行',
  l2_name: '股份制银行',
  as_of: '2026-11-12T15:00:00+08:00',
  staleness_ms: '0',
};

class FakeCEndMetricsRepo implements CEndMetricsRepo {
  overviewCalls = 0;
  stockCalls: string[] = [];
  limitCalls = 0;

  async getMarketOverview(): Promise<readonly MarketOverviewRow[]> {
    this.overviewCalls += 1;
    return FAKE_OVERVIEW;
  }

  async getStockMetrics(instrumentId: string): Promise<StockMetricsRow | null> {
    this.stockCalls.push(instrumentId);
    if (instrumentId === 'SSE:600519') return FAKE_STOCK;
    return null;
  }

  async getLimitLadder(): Promise<readonly LimitLadderRow[]> {
    this.limitCalls += 1;
    return [FAKE_LIMIT_ROW];
  }
}

function createApp(repo: FakeCEndMetricsRepo) {
  const plugin = createMarketPlugin({
    cEndMetricsRepo: repo,
    servingRepo: unusedServing,
    watchlistRepo: unusedWatchlist,
    env: {
      APP_PROFILE: 'test',
      ENTITLEMENT_TIER: 'internal_eval',
      ENTITLEMENT_HOLD_CHECK: '0',
      ENTITLEMENT_AUDIT: '0',
    },
  });
  return buildApp({
    domainPlugins: [plugin],
    logger: false,
    authenticator: async (request) => {
      if (!request.url.startsWith('/v1/')) return null;
      const auth = request.headers.authorization;
      if (auth === `Bearer ${TOKEN}`) {
        return { userId: 'c-end-1', userType: 'internal_active' as const, tier: 'internal_eval' as const, sessionVersion: 0 };
      }
      return null;
    },
  });
}

describe('c-end metrics routes', () => {
  it('rejects overview without auth (401)', async () => {
    const repo = new FakeCEndMetricsRepo();
    const app = createApp(repo);
    const response = await app.inject({ method: 'GET', url: '/v1/c-end/overview' });
    assert.equal(response.statusCode, 401);
  });

  it('returns overview with metric rows (200)', async () => {
    const repo = new FakeCEndMetricsRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/overview',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(Array.isArray(body.metrics));
    assert.equal(body.metrics.length, FAKE_OVERVIEW.length);
    assert.equal(body.metrics[0].metric_key, 'quote.last_close_avg');
    assert.equal(body.metrics[0].value_text, '24.13');
    assert.equal(typeof body.as_of, 'string');
    assert.equal(repo.overviewCalls, 1);
  });

  it('returns stock metrics for known instrument (200)', async () => {
    const repo = new FakeCEndMetricsRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:600519/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.instrument_id, 'SSE:600519');
    assert.equal(body.instrument_name, '贵州茅台');
    assert.equal(body.close, '1510.00');
    assert.equal(body.pe_ttm, '24.80');
    // 数字必须以字符串透传（precision-safe）
    assert.equal(typeof body.close, 'string');
    assert.equal(typeof body.pe, 'string');
    assert.equal(repo.stockCalls.length, 1);
  });

  it('returns 404 for unknown instrument', async () => {
    const repo = new FakeCEndMetricsRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:999999/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
  });

  it('rejects invalid instrument_id format (400)', async () => {
    const repo = new FakeCEndMetricsRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/not-a-valid-id/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'VALIDATION_ERROR');
  });

  it('returns limit ladder rows (200)', async () => {
    const repo = new FakeCEndMetricsRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/limits',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(Array.isArray(body.rows));
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].instrument_id, 'SZSE:000001');
    assert.equal(body.rows[0].limit_status, 'up');
    assert.equal(typeof body.as_of, 'string');
    assert.equal(repo.limitCalls, 1);
  });
});
