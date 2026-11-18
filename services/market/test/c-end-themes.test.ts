import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { buildApp } from '../../api/src/app.js';
import { createMarketPlugin } from '../src/plugin.js';
import type { CEndMetricsRepo } from '../src/ports/c-end-metrics-repo.js';
import type {
  CEndThemeRepo,
  SentimentMarketRow,
  SentimentStockRow,
  SentimentStockSeries,
  SentimentStockSummary,
  ThemeFinHealthRow,
  ValuationPriceSeries,
} from '../src/ports/c-end-theme-repo.js';
import type { ServingRepo } from '../src/ports/serving-repo.js';
import type { WatchlistRepo } from '../src/ports/watchlist-repo.js';

// 占位仓储（主题路由不用 serving/watchlist/metrics，但 plugin 启动必填）。
const unusedServing = {} as ServingRepo;
const unusedWatchlist = { async ensureSchema(): Promise<void> {} } as WatchlistRepo;
const unusedMetrics = {} as CEndMetricsRepo;

const TOKEN = 'test-c-end-theme-token';

const FAKE_FIN_HEALTH: readonly ThemeFinHealthRow[] = [
  {
    instrument_id: 'SSE:600519',
    as_of: '2026-10-30T00:00:00+08:00',
    period: '2026-09-30',
    roe: '24.31',
    or_yoy_pct: '16.32',
    debt_to_assets: '16.40',
    netprofit_yoy_pct: '15.12',
    grossprofit_margin: '91.05',
    netprofit_margin: '52.31',
    current_ratio: '3.85',
    total_revenue: '12314500000',
    net_profit: '6082400000',
    net_profit_parent: '6082400000',
    basic_eps: '48.42',
    staleness_ms: '172800000',
  },
  {
    instrument_id: 'SSE:600519',
    as_of: '2026-08-09T00:00:00+08:00',
    period: '2026-06-30',
    roe: '21.07',
    or_yoy_pct: '15.88',
    debt_to_assets: '16.90',
    netprofit_yoy_pct: '14.80',
    grossprofit_margin: '91.02',
    netprofit_margin: '51.90',
    current_ratio: '3.72',
    total_revenue: '8911200000',
    net_profit: '4624100000',
    net_profit_parent: '4624100000',
    basic_eps: '36.81',
    staleness_ms: '622080000',
  },
  {
    instrument_id: 'SSE:600519',
    as_of: '2026-04-29T00:00:00+08:00',
    period: '2026-03-31',
    roe: '10.72',
    or_yoy_pct: '15.66',
    debt_to_assets: '17.10',
    netprofit_yoy_pct: '11.56',
    grossprofit_margin: '91.00',
    netprofit_margin: '51.60',
    current_ratio: '3.65',
    total_revenue: '5145500000',
    net_profit: '2686800000',
    net_profit_parent: '2686800000',
    basic_eps: '21.39',
    staleness_ms: '1756800000',
  },
];

const FAKE_VALUATION_SERIES: ValuationPriceSeries = {
  rows: [
    { instrument_id: 'SSE:600519', trade_date: '2026-11-17', pe_ttm: '24.80', pb: '8.30', close: '1510.00', turnover_rate_pct: '0.24' },
    { instrument_id: 'SSE:600519', trade_date: '2026-11-14', pe_ttm: '24.62', pb: '8.24', close: '1500.00', turnover_rate_pct: '0.21' },
    { instrument_id: 'SSE:600519', trade_date: '2026-11-13', pe_ttm: '25.10', pb: '8.41', close: '1525.50', turnover_rate_pct: '0.30' },
  ],
  percentiles: { pe_ttm: '66.7', pb: '66.7', close: '66.7', turnover_rate_pct: '66.7' },
};

// T3 市场情绪（3 个交易日；四件套+资金面，全部字符串数字）
const FAKE_SENTIMENT_MARKET: readonly SentimentMarketRow[] = [
  {
    trade_date: '2026-11-17',
    limit_up_count: '86',
    limit_down_count: '12',
    advancers: '3120',
    decliners: '1876',
    adv_dec_ratio: '1.6631',
    max_limit_streak: '7',
    moneyflow_net_inflow_total: '1234567890.55',
    margin_financing_balance: '1876543210000',
  },
  {
    trade_date: '2026-11-14',
    limit_up_count: '54',
    limit_down_count: '31',
    advancers: '2011',
    decliners: '2988',
    adv_dec_ratio: '0.673',
    max_limit_streak: '5',
    moneyflow_net_inflow_total: '-987654321.10',
    margin_financing_balance: '1875123456789',
  },
  {
    trade_date: '2026-11-13',
    limit_up_count: '41',
    limit_down_count: '44',
    advancers: '2500',
    decliners: '2500',
    adv_dec_ratio: '1',
    max_limit_streak: '4',
    moneyflow_net_inflow_total: null,
    margin_financing_balance: null,
  },
];

const FAKE_SENTIMENT_STOCK_ROWS: readonly SentimentStockRow[] = [
  {
    instrument_id: 'SSE:600519',
    trade_date: '2026-11-17',
    net_inflow_amount: '12345678.90',
    lhb_net_amount: null,
    inst_net_buy_amount: null,
    financing_balance: '987654321.00',
  },
  {
    instrument_id: 'SSE:600519',
    trade_date: '2026-11-14',
    net_inflow_amount: '-5555555.55',
    lhb_net_amount: '-23456789.10',
    inst_net_buy_amount: '-12000000.00',
    financing_balance: '990000000.00',
  },
];

const FAKE_SENTIMENT_STOCK_SUMMARY: SentimentStockSummary = {
  net_inflow_sum: '67890123.35',
  net_inflow_latest: '12345678.90',
  lhb_count: '1',
  lhb_net_buy_sum: '-23456789.10',
  inst_net_buy_sum: '-12000000.00',
  financing_balance_latest: '987654321.00',
  financing_balance_change: '-2345679.00',
};

const EMPTY_SENTIMENT_STOCK_SUMMARY: SentimentStockSummary = {
  net_inflow_sum: null,
  net_inflow_latest: null,
  lhb_count: null,
  lhb_net_buy_sum: null,
  inst_net_buy_sum: null,
  financing_balance_latest: null,
  financing_balance_change: null,
};

class FakeCEndThemeRepo implements CEndThemeRepo {
  finHealthCalls: string[] = [];
  valuationCalls: Array<{ instrumentId: string; windowRows: number }> = [];
  valuationSeries: ValuationPriceSeries = FAKE_VALUATION_SERIES;
  sentimentMarketCalls: number[] = [];
  sentimentStockCalls: Array<{ instrumentId: string; windowRows: number }> = [];

  async getFinHealth(instrumentId: string): Promise<readonly ThemeFinHealthRow[]> {
    this.finHealthCalls.push(instrumentId);
    return FAKE_FIN_HEALTH.filter((row) => row.instrument_id === instrumentId);
  }

  async getValuationPrice(instrumentId: string, windowRows: number): Promise<ValuationPriceSeries> {
    this.valuationCalls.push({ instrumentId, windowRows });
    const rows = this.valuationSeries.rows.filter((row) => row.instrument_id === instrumentId);
    // 空序列 → 分位全 null（与仓储 SQL 的 percentileRows[0] ?? {4 null} 语义一致）
    if (rows.length === 0) {
      return { rows: [], percentiles: { pe_ttm: null, pb: null, close: null, turnover_rate_pct: null } };
    }
    return { rows, percentiles: this.valuationSeries.percentiles };
  }

  async getSentimentMarket(windowRows: number): Promise<readonly SentimentMarketRow[]> {
    this.sentimentMarketCalls.push(windowRows);
    // 固定夹具（3 行），窗口参数只记录不裁剪（窗口语义由仓储 SQL 测试覆盖）
    return FAKE_SENTIMENT_MARKET;
  }

  async getSentimentStock(instrumentId: string, windowRows: number): Promise<SentimentStockSeries> {
    this.sentimentStockCalls.push({ instrumentId, windowRows });
    const rows = FAKE_SENTIMENT_STOCK_ROWS.filter((row) => row.instrument_id === instrumentId);
    // 空序列 → summary 全 null（与仓储 CASE WHEN EXISTS 兜底语义一致）
    if (rows.length === 0) {
      return { rows: [], summary: EMPTY_SENTIMENT_STOCK_SUMMARY };
    }
    return { rows, summary: FAKE_SENTIMENT_STOCK_SUMMARY };
  }
}

function createApp(themes: CEndThemeRepo) {
  const plugin = createMarketPlugin({
    cEndMetricsRepo: unusedMetrics,
    cEndThemeRepo: themes,
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
      if (auth === 'Bearer ' + TOKEN) {
        return { userId: 'c-end-1', userType: 'internal_active' as const, tier: 'internal_eval' as const, sessionVersion: 0 };
      }
      return null;
    },
  });
}

// 响应键全集 allowlist（红线①守门：任何上游非 canonical 字段进响应即红）。
const FIN_HEALTH_TOP_KEYS = ['instrument_id', 'as_of', 'rows'];
// T2 valuation-price 顶层键全集（range 显式回显 + 分位块）
const VALUATION_TOP_KEYS = ['instrument_id', 'range', 'as_of', 'rows', 'percentiles'];
const VALUATION_ROW_KEYS = ['instrument_id', 'trade_date', 'pe_ttm', 'pb', 'close', 'turnover_rate_pct'];
const PERCENTILE_KEYS = ['pe_ttm', 'pb', 'close', 'turnover_rate_pct'];
// T3 market sentiment 顶层键全集（window 回显；无 instrument_id——只市场级）
const SENTIMENT_MARKET_TOP_KEYS = ['window', 'as_of', 'rows'];
const SENTIMENT_MARKET_ROW_KEYS = [
  'trade_date',
  'limit_up_count',
  'limit_down_count',
  'advancers',
  'decliners',
  'adv_dec_ratio',
  'max_limit_streak',
  'moneyflow_net_inflow_total',
  'margin_financing_balance',
];
// T3 stock sentiment 顶层与行键全集（行内无任何涨跌停字段——H3 m02407）
const SENTIMENT_STOCK_TOP_KEYS = ['instrument_id', 'window', 'as_of', 'rows', 'summary'];
const SENTIMENT_STOCK_ROW_KEYS = [
  'instrument_id',
  'trade_date',
  'net_inflow_amount',
  'lhb_net_amount',
  'inst_net_buy_amount',
  'financing_balance',
];
const SENTIMENT_STOCK_SUMMARY_KEYS = [
  'net_inflow_sum',
  'net_inflow_latest',
  'lhb_count',
  'lhb_net_buy_sum',
  'inst_net_buy_sum',
  'financing_balance_latest',
  'financing_balance_change',
];
const FIN_HEALTH_ROW_KEYS = [
  'instrument_id',
  'as_of',
  'period',
  'roe',
  'or_yoy_pct',
  'debt_to_assets',
  'netprofit_yoy_pct',
  'grossprofit_margin',
  'netprofit_margin',
  'current_ratio',
  'total_revenue',
  'net_profit',
  'net_profit_parent',
  'basic_eps',
  'staleness_ms',
];
// 红线③/H3：个股级不暴露涨跌停梯队明细、不出现投资结论字段。
const FORBIDDEN_PATTERN = /akshare|up_limit|down_limit|seal_ratio|limit_status|dwd_stk_limit|target_price/i;

function assertForbiddenAbsent(body: unknown): void {
  const json = JSON.stringify(body);
  assert.ok(!FORBIDDEN_PATTERN.test(json), '响应含禁出字段: ' + json);
}

describe('c-end theme routes (M1a)', () => {
  it('rejects fin-health without auth (401)', async () => {
    const app = createApp(new FakeCEndThemeRepo());
    const response = await app.inject({ method: 'GET', url: '/v1/c-end/stocks/SSE:600519/themes/fin-health' });
    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'UNAUTHENTICATED');
  });

  it('rejects invalid instrument_id format (400)', async () => {
    const app = createApp(new FakeCEndThemeRepo());
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/not-a-valid-id/themes/fin-health',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'VALIDATION_ERROR');
  });

  it('returns fin-health rows for known instrument (200, key allowlist)', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:600519/themes/fin-health',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    // 顶层键全集（响应形状冻结：instrument_id / as_of / rows）
    assert.deepEqual(Object.keys(body).sort(), [...FIN_HEALTH_TOP_KEYS].sort());
    assert.equal(body.instrument_id, 'SSE:600519');
    assert.equal(body.as_of, FAKE_FIN_HEALTH[0]?.as_of);
    assert.ok(Array.isArray(body.rows));
    assert.equal(body.rows.length, 3);
    // 每行键全集 = 视图列 allowlist（红线①守门：多一列少一列都红）
    for (const row of body.rows) {
      assert.deepEqual(Object.keys(row).sort(), [...FIN_HEALTH_ROW_KEYS].sort());
      // 数字必须以字符串透传（precision-safe）
      assert.equal(typeof row.roe, 'string');
      assert.equal(typeof row.basic_eps, 'string');
    }
    // 按 as_of DESC（最新一季在前）
    assert.equal(body.rows[0].period, '2026-09-30');
    assert.equal(body.rows[2].period, '2026-03-31');
    assertForbiddenAbsent(body);
    assert.deepEqual(repo.finHealthCalls, ['SSE:600519']);
  });

  it('returns 200 with empty rows when no disclosed report (as_of null)', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:000001/themes/fin-health',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    // 空行 ≠ 标的不存在：200 + rows:[] + as_of:null（与 /metrics 的 404 语义区分，设计定案）
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.instrument_id, 'SSE:000001');
    assert.equal(body.as_of, null);
    assert.deepEqual(body.rows, []);
    assert.deepEqual(repo.finHealthCalls, ['SSE:000001']);
  });

  it('returns valuation-price with default range 1y (window 250, key allowlist)', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:600519/themes/valuation-price',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    // 顶层键全集（含 range 回显与 percentiles 分位块）
    assert.deepEqual(Object.keys(body).sort(), [...VALUATION_TOP_KEYS].sort());
    assert.equal(body.instrument_id, 'SSE:600519');
    assert.equal(body.range, '1y');
    // as_of = 窗口最新交易日；行序 trade_date DESC
    assert.equal(body.as_of, '2026-11-17');
    assert.equal(body.rows.length, 3);
    for (const row of body.rows) {
      assert.deepEqual(Object.keys(row).sort(), [...VALUATION_ROW_KEYS].sort());
      // 数字以字符串透传（precision-safe）
      assert.equal(typeof row.close, 'string');
    }
    assert.deepEqual(Object.keys(body.percentiles).sort(), [...PERCENTILE_KEYS].sort());
    assert.equal(body.percentiles.pe_ttm, '66.7');
    // 缺省 range=1y → 窗口 250 交易日
    assert.deepEqual(repo.valuationCalls, [{ instrumentId: 'SSE:600519', windowRows: 250 }]);
    assertForbiddenAbsent(body);
  });

  it('maps range=3y to 750-row window and rejects unknown range (400)', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:600519/themes/valuation-price?range=3y',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(repo.valuationCalls, [{ instrumentId: 'SSE:600519', windowRows: 750 }]);
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:600519/themes/valuation-price?range=5y',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).code, 'VALIDATION_ERROR');
    // 非法 range 不触仓储
    assert.equal(repo.valuationCalls.length, 1);
  });

  it('returns 200 empty series when no quote rows (as_of null, percentiles null)', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:000001/themes/valuation-price',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    // 空序列 ≠ 标的不存在：200 + rows:[] + 分位全 null（设计定案，与 /metrics 404 区分）
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.as_of, null);
    assert.deepEqual(body.rows, []);
    assert.deepEqual(body.percentiles, { pe_ttm: null, pb: null, close: null, turnover_rate_pct: null });
  });

  it('returns market sentiment with default window 30d (key allowlist, no instrument rows)', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/themes/money-sentiment',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    // 顶层键全集（window 回显；无 instrument_id——只市场级，H3 m02407）
    assert.deepEqual(Object.keys(body).sort(), [...SENTIMENT_MARKET_TOP_KEYS].sort());
    assert.equal(body.window, '30d');
    assert.equal(body.as_of, '2026-11-17');
    assert.equal(body.rows.length, 3);
    for (const row of body.rows) {
      assert.deepEqual(Object.keys(row).sort(), [...SENTIMENT_MARKET_ROW_KEYS].sort());
      assert.equal(typeof row.limit_up_count, 'string');
      assert.equal(typeof row.max_limit_streak, 'string');
      // 行内禁个股标识（只市场级汇总）
      assert.ok(!('instrument_id' in row));
    }
    // 缺省 window=30d → 30 个交易日
    assert.deepEqual(repo.sentimentMarketCalls, [30]);
    assertForbiddenAbsent(body);
  });

  it('rejects unknown money-sentiment window (400) without touching repo', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/themes/money-sentiment?window=7d',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).code, 'VALIDATION_ERROR');
    assert.deepEqual(repo.sentimentMarketCalls, []);
  });

  it('returns stock sentiment rows + window summary (200, key allowlist)', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:600519/themes/money-sentiment',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(Object.keys(body).sort(), [...SENTIMENT_STOCK_TOP_KEYS].sort());
    assert.equal(body.instrument_id, 'SSE:600519');
    assert.equal(body.window, '30d');
    assert.equal(body.as_of, '2026-11-17');
    assert.equal(body.rows.length, 2);
    for (const row of body.rows) {
      assert.deepEqual(Object.keys(row).sort(), [...SENTIMENT_STOCK_ROW_KEYS].sort());
      assert.equal(typeof row.net_inflow_amount, 'string');
      // H3 m02407：个股行禁涨跌停字段
      assert.ok(!('limit_up_count' in row || 'limit_status' in row));
    }
    assert.deepEqual(Object.keys(body.summary).sort(), [...SENTIMENT_STOCK_SUMMARY_KEYS].sort());
    assert.equal(body.summary.lhb_count, '1');
    assert.equal(body.summary.financing_balance_change, '-2345679.00');
    assert.deepEqual(repo.sentimentStockCalls, [{ instrumentId: 'SSE:600519', windowRows: 30 }]);
    assertForbiddenAbsent(body);
  });

  it('returns 200 empty stock sentiment with all-null summary when no rows', async () => {
    const repo = new FakeCEndThemeRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/c-end/stocks/SSE:000001/themes/money-sentiment',
      headers: { authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.as_of, null);
    assert.deepEqual(body.rows, []);
    // 空序列 → summary 全 null（含 lhb_count；与仓储 CASE WHEN EXISTS 兜底一致）
    assert.deepEqual(body.summary, EMPTY_SENTIMENT_STOCK_SUMMARY);
  });

  it('theme SQL: DWD-only sources, H4 announced_at guard present (红线静态守门)', async () => {
    const url = new URL('../../../warehouse/serving/c-end-themes.sql', import.meta.url);
    const sql = await readFile(url, 'utf8');
    // 剥掉注释后断言（守门针对实际执行 SQL，不针对注释里的红线引用）
    const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(/CREATE SCHEMA IF NOT EXISTS serving/.test(sql), '幂等 schema');
    assert.ok(/CREATE OR REPLACE VIEW serving\.v_cend_theme_fin_health/.test(code), 'T1 视图存在');
    // T2 视图存在且只联两表（bar 真源 + basic 估值），无第三表
    assert.ok(/CREATE OR REPLACE VIEW serving\.v_cend_theme_valuation_price/.test(code), 'T2 视图存在');
    const t2 = code.split('v_cend_theme_valuation_price AS')[1]?.split(';')[0] ?? '';
    assert.ok(/FROM dwd_stock_bar_daily bar/.test(t2), '价格真源 dwd_stock_bar_daily');
    assert.ok(/LEFT JOIN dwd_daily_basic basic/.test(t2), '估值源 dwd_daily_basic');
    assert.equal((t2.match(/FROM |JOIN /g) ?? []).length, 2, 'T2 视图只允许 2 表');
    // 红线③：个股涨跌停明细表不得进主题视图
    assert.ok(!/FROM\s+dwd_stk_limit/i.test(code), 'dwd_stk_limit 禁入主题视图');
    // H4：income 并入必须过 announced_at 可见时点守卫（禁 report_end_date 裸 as-of join）
    assert.ok(/i\.income_announced_at\s*<=\s*f\.announced_at/.test(code), 'H4 announced_at 守卫缺失');
    // H4：近 8 季窗口排序键必须是 announced_at（可见时点），不是报告期
    assert.ok(/ORDER BY announced_at DESC NULLS LAST/.test(code), '窗口排序须按 announced_at DESC');

    // T3 视图存在（市场级 + 个股级两段）
    assert.ok(/CREATE OR REPLACE VIEW serving\.v_cend_theme_sentiment_market/.test(code), 'T3 市场级视图存在');
    assert.ok(/CREATE OR REPLACE VIEW serving\.v_cend_theme_sentiment_stock/.test(code), 'T3 个股级视图存在');
    // H3 m02407：个股情绪视图段禁 limit_status / dwd_stk_limit（不暴露涨跌停信息）
    const stockSeg = code.split('v_cend_theme_sentiment_stock AS')[1]?.split(';')[0] ?? '';
    assert.ok(stockSeg.length > 0, '个股视图段可解析');
    assert.ok(!/limit_status|dwd_stk_limit/i.test(stockSeg), '个股视图段禁涨跌停源');
    // 市场级四件套按 L202b/L203 映射：limit_status::numeric IN (1,5)/(2,6)
    assert.ok(/limit_status::numeric IN \(1, 5\)/.test(code), '涨停映射 IN (1,5)');
    assert.ok(/limit_status::numeric IN \(2, 6\)/.test(code), '跌停映射 IN (2,6)');
    // 连板底座 = dwd_daily_basic.limit_status 岛屿技法（交易日相邻），非 dwd_stk_limit
    assert.ok(/FROM dwd_daily_basic/i.test(code.split('v_cend_theme_sentiment_market AS')[1]?.split(';')[0] ?? ''), '市场级连板底座 dwd_daily_basic');
  });
});
