/**
 * A3 域插件单测（node:test + Fastify inject，不连 PG）。
 *
 * 覆盖 P0 个股页竖切片的接口契约：
 *  - 三接口 403（internal_eval）与 instrument 200+is_entitled=false / watchlist 恒 platform_user_data；
 *  - 缓存降级：读失败返回最近成功快照（source=platform_snapshot/platform_degraded、保留 as_of、重算 staleness）；
 *  - 停牌三态、bars 复权口径回显、404 语义（INSTRUMENT_NOT_FOUND vs NOT_FOUND）；
 *  - 自选幂等/上限/鉴权；
 *  - 接口层不含投资判断性文案（H3 红线，免责声明除外）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../../api/src/app.js';
import { loadConfig } from '../../api/src/config.js';
import type { AppConfig } from '../../api/src/config.js';
import { MARKET_COPY } from '../../api/src/copy.js';
import { DEFAULT_DISCLAIMER_TEXT, loadMarketConfig, MarketConfigError } from '../src/config.js';
import { assertInstrumentWhitelist } from '../src/domain/build.js';
import type { MarketConfig } from '../src/config.js';
import { createMarketPlugin } from '../src/plugin.js';
import type {
  BarRow,
  BarsPage,
  FactorRow,
  FundamentalSummaryRow,
  InstrumentRow,
  QuoteRow,
  ServingRepo,
} from '../src/ports/serving-repo.js';
import type { EntitlementControlRepo, EntitlementEventRecord, EntitlementEventRepo } from '../src/ports/entitlement.js';
import type { WatchlistAddResult, WatchlistItemRow, WatchlistRepo } from '../src/ports/watchlist-repo.js';
import { WatchlistLimitExceededError } from '../src/ports/watchlist-repo.js';

const NOW = new Date('2026-11-04T10:00:00+08:00');
const AS_OF = '2026-11-04T09:30:00+08:00';

const instrumentRow: InstrumentRow = {
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

const quoteRow: QuoteRow = {
  instrument_id: 'SSE:600519',
  trade_date: '2026-11-03',
  open: '1680.00',
  high: '1700.00',
  low: '1670.00',
  close: '1690.00',
  prev_close: '1675.00',
  change: '15.00',
  change_pct: '0.8955',
  volume: 1234500,
  amount: '2080000000.00',
  suspended: false,
  limit_status: 'none',
  source: 'tushare',
  asOf: AS_OF,
  stalenessMs: 0,
};

const suspendedQuoteRow: QuoteRow = {
  ...quoteRow,
  open: null,
  high: null,
  low: null,
  close: null,
  prev_close: null,
  change: null,
  change_pct: null,
  volume: null,
  amount: null,
  suspended: true,
  limit_status: 'none',
};

const barRows: BarRow[] = [
  {
    instrument_id: 'SSE:600519',
    trade_date: '2026-11-02',
    adj_type: 'none',
    open: '1670.00',
    high: '1680.00',
    low: '1660.00',
    close: '1675.00',
    volume: 1000000,
    amount: '1675000000.00',
    factor: '1.0000000000',
    source: 'tushare',
    asOf: AS_OF,
    stalenessMs: 0,
  },
  {
    instrument_id: 'SSE:600519',
    trade_date: '2026-11-03',
    adj_type: 'none',
    open: '1680.00',
    high: '1700.00',
    low: '1670.00',
    close: '1690.00',
    volume: 1234500,
    amount: '2080000000.00',
    factor: '1.0000000000',
    source: 'tushare',
    asOf: AS_OF,
    stalenessMs: 0,
  },
];

class FakeServing implements ServingRepo {
  instrument: InstrumentRow | null = instrumentRow;
  quote: QuoteRow | null = quoteRow;
  bars: BarRow[] = barRows;
  fundamental: FundamentalSummaryRow | null = null;
  failures = 0;
  calls = 0;

  private maybeFail(): void {
    this.calls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('serving view 连接失败（模拟数据源故障）');
    }
  }

  async getInstrument(instrumentId: string, audience: 'c_end' | 'internal' = 'c_end'): Promise<InstrumentRow | null> {
    this.maybeFail();
    const row = this.instrument?.instrument_id === instrumentId ? this.instrument : null;
    // L30：C 端受众过滤 display_safe=false（repo 层语义；内部评测态仍可取）。
    if (row !== null && audience === 'c_end' && !row.display_safe) return null;
    return row;
  }

  async getQuote(instrumentId: string): Promise<QuoteRow | null> {
    this.maybeFail();
    return this.quote?.instrument_id === instrumentId ? this.quote : null;
  }

  async getBars(query: { instrumentId: string; adjType: 'none' | 'hfq' | 'qfq'; limit: number }): Promise<BarsPage> {
    this.maybeFail();
    const rows = this.bars
      .slice(-query.limit)
      .map((bar) => ({ ...bar, adj_type: query.adjType }));
    return { rows, hasMore: this.bars.length > query.limit, adjustment: query.adjType };
  }

  async getLatestFactor(): Promise<FactorRow | null> {
    return null;
  }

  async getFundamentalSummary(instrumentId: string): Promise<FundamentalSummaryRow | null> {
    this.maybeFail();
    return this.fundamental?.instrument_id === instrumentId ? this.fundamental : null;
  }
}

class FakeWatchlist implements WatchlistRepo {
  readonly byUser = new Map<string, WatchlistItemRow[]>();

  async ensureSchema(): Promise<void> {
    /* 内存实现无需建表 */
  }

  async list(userId: string): Promise<WatchlistItemRow[]> {
    return [...(this.byUser.get(userId) ?? [])].reverse();
  }

  async add(userId: string, instrumentId: string, limit: number): Promise<WatchlistAddResult> {
    const items = this.byUser.get(userId) ?? [];
    const existing = items.find((item) => item.instrument_id === instrumentId);
    if (existing !== undefined) return { item: existing, created: false };
    if (items.length >= limit) throw new WatchlistLimitExceededError(limit);
    const item = { instrument_id: instrumentId, added_at: NOW };
    items.push(item);
    this.byUser.set(userId, items);
    return { item, created: true };
  }

  async remove(userId: string, instrumentId: string): Promise<void> {
    this.byUser.set(
      userId,
      (this.byUser.get(userId) ?? []).filter((item) => item.instrument_id !== instrumentId),
    );
  }
}

function marketConfig(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return {
    entitlementTier: 'c_end_display',
    entitlementExpiresAt: '2099-12-31T23:59:59+08:00',
    disclaimer: { text: '本页面数据仅供参考，不构成任何投资建议或买卖依据。', version: '2026.11.1' },
    watchlistLimit: 2,
    watchlistTable: 'watchlist_items',
    allowDevAuth: true,
    devAuthToken: 'e2e-token',
    devAuthUserId: 'e2e-user',
    autoMigrate: false,
    e2eMode: true,
    now: () => NOW,
    ...overrides,
  };
}

const appConfig: AppConfig = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv);

interface Harness {
  readonly app: ReturnType<typeof buildApp>;
  readonly serving: FakeServing;
  readonly watchlist: FakeWatchlist;
}

function createHarness(overrides: Partial<MarketConfig> = {}): Harness {
  const serving = new FakeServing();
  const watchlist = new FakeWatchlist();
  const plugin = createMarketPlugin({
    config: marketConfig(overrides),
    servingRepo: serving,
    watchlistRepo: watchlist,
  });
  const app = buildApp({ config: appConfig, domainPlugins: [plugin], logger: false });
  return { app, serving, watchlist };
}

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

describe('market 插件：授权矩阵（F1）', () => {
  it('normal 层级：quote/bars/fundamental 200 且 meta.entitlement=c_end_display/true，instrument 同样 true', async () => {
    const { app } = createHarness();
    for (const path of [
      '/v1/instruments/SSE:600519',
      '/v1/instruments/SSE:600519/quote',
      '/v1/instruments/SSE:600519/bars',
    ]) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 200, `${path} 应 200，实际 ${response.statusCode}: ${response.body}`);
      const body = json<{
        meta: {
          entitlement: { tier: string; is_entitled: boolean };
          source: { source: string; source_id?: string; as_of: string };
        };
      }>(response);
      assert.deepEqual(body.meta.entitlement, { tier: 'c_end_display', is_entitled: true });
      assert.equal(body.meta.source.as_of, AS_OF);
      assert.equal(body.meta.source.source, 'platform_eod', `${path} 来源应为平台词表`);
      assert.equal(body.meta.source.source_id, 'tushare', `${path} 原始上游标识只进 source_id`);
    }
    await app.close();
  });

  it('restricted 层级：标的已收录但无数据 → 403 ENTITLEMENT_RESTRICTED（先判存在性，再判授权）', async () => {
    const { app, serving } = createHarness({ entitlementTier: 'internal_eval' });
    serving.quote = null; // 标的已收录（存在性通过）→ 授权闸门先于「无数据」404
    for (const path of [
      '/v1/instruments/SSE:600519/quote',
      '/v1/instruments/SSE:600519/bars',
      '/v1/instruments/SSE:600519/fundamental-summary',
    ]) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 403, `${path} 应 403，实际 ${response.statusCode}: ${response.body}`);
      assert.match(response.headers['content-type'] ?? '', /application\/problem\+json/);
      const body = json<{ code: string; status: number; title: string; detail: string }>(response);
      assert.equal(body.code, 'ENTITLEMENT_RESTRICTED');
      assert.equal(body.status, 403);
      // H3 m01357 / Lead L56：生产默认关闭，不暴露 cause；诊断面走事件 + trace_id。
      assert.equal(response.headers['x-entitlement-cause'], undefined, path);
      for (const [name, value] of Object.entries(response.headers)) {
        assert.doesNotMatch(`${name}:${String(value)}`, /cause|expired|hold|stale|unauthorized/i, `${path} 403 响应头泄漏诊断词`);
      }
      // H3 红线（Lead m00730）：人类可读层中性产品语言，不做"授权"类法律定性。
      assert.equal(body.title, '行情数据暂不可用');
      assert.equal(body.detail, '当前版本暂不提供该标的行情数据');
      for (const forbidden of ['授权', '未取得', '法律', '许可', '再分发']) {
        assert.equal(response.body.includes(forbidden), false, `403 Problem 人类可读层出现法律定性「${forbidden}」`);
      }
      assert.doesNotMatch(response.body, /1690\.00|0\.8955|贵州茅台/);
    }
    await app.close();
  });

  it('restricted 层级：未收录标的仍先返回 404 INSTRUMENT_NOT_FOUND（不能误报 403）', async () => {
    const { app, serving } = createHarness({ entitlementTier: 'internal_eval' });
    serving.instrument = null;
    for (const path of [
      '/v1/instruments/SZSE:000001/quote',
      '/v1/instruments/SZSE:000001/bars',
      '/v1/instruments/SZSE:000001/fundamental-summary',
    ]) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 404, `${path} 应 404，实际 ${response.statusCode}: ${response.body}`);
      assert.equal(json<{ code: string }>(response).code, 'INSTRUMENT_NOT_FOUND');
    }
    await app.close();
  });

  it('restricted 层级：instrument 仍 200 + internal_eval/false（基础信息不整体 403）', async () => {
    const { app } = createHarness({ entitlementTier: 'internal_eval' });
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
    assert.equal(response.statusCode, 200);
    const body = json<{ data: { instrument_id: string; name: string }; meta: { entitlement: unknown } }>(
      response,
    );
    assert.equal(body.data.instrument_id, 'SSE:600519');
    assert.deepEqual(body.meta.entitlement, { tier: 'internal_eval', is_entitled: false });
    await app.close();
  });
});

describe('market 插件：quote / bars / fundamental 契约', () => {
  it('quote 正常态：价格数值、meta.adjustment=none、disclaimer 版本与 closable=false', async () => {
    const { app } = createHarness();
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote?adjustment=qfq' });
    assert.equal(response.statusCode, 200);
    const body = json<{
      data: Record<string, unknown>;
      meta: { adjustment: string; disclaimer: { version: string; closable: boolean; text: string } };
    }>(response);
    assert.equal(body.data.last_price, 1690);
    assert.equal(body.data.change_pct, 0.8955);
    assert.equal(body.data.suspended, false);
    assert.equal(body.meta.adjustment, 'none');
    assert.equal(body.meta.disclaimer.version, '2026.11.1');
    assert.equal(body.meta.disclaimer.closable, false);
    assert.ok(body.meta.disclaimer.text.length > 0);
    await app.close();
  });

  it('quote 停牌态：价格为 null（禁止 0 冒充），volume/amount 为 0 且 suspended=true', async () => {
    const { app, serving } = createHarness();
    serving.quote = suspendedQuoteRow;
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(response.statusCode, 200);
    const body = json<{ data: Record<string, unknown> }>(response);
    assert.equal(body.data.last_price, null);
    assert.equal(body.data.change, null);
    assert.equal(body.data.change_pct, null);
    assert.equal(body.data.suspended, true);
    assert.equal(body.data.volume, 0);
    assert.equal(body.data.amount, 0);
    await app.close();
  });

  it('bars：复权口径回显一致、升序、has_more 基于 limit', async () => {
    const { app, serving } = createHarness();
    serving.bars = Array.from({ length: 3 }, (_, index) => ({
      ...barRows[0]!,
      trade_date: `2026-11-0${index + 1}`,
    }));
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/bars?adjustment=hfq&limit=2' });
    assert.equal(response.statusCode, 200);
    const body = json<{
      data: { adjustment: string; bars: Array<{ trade_date: string }>; has_more: boolean };
      meta: { adjustment: string };
    }>(response);
    assert.equal(body.data.adjustment, 'hfq');
    assert.equal(body.meta.adjustment, 'hfq');
    assert.equal(body.data.bars.length, 2);
    assert.deepEqual(
      body.data.bars.map((bar) => bar.trade_date),
      ['2026-11-02', '2026-11-03'],
    );
    assert.equal(body.data.has_more, true);
    await app.close();
  });

  it('serving 数值字段非法 → 400 VALIDATION_ERROR（不允许 NaN 静默通过）', async () => {
    const { app, serving } = createHarness();
    serving.quote = { ...quoteRow, close: 'not-a-number' };
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(json<{ code: string }>(response).code, 'VALIDATION_ERROR');
    await app.close();
  });

  it('bars 参数非法 → 400 VALIDATION_ERROR；instrument_id 非法同样 400', async () => {
    const { app } = createHarness();
    const badAdjustment = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/bars?adjustment=xxx' });
    assert.equal(badAdjustment.statusCode, 400);
    assert.equal(json<{ code: string }>(badAdjustment).code, 'VALIDATION_ERROR');
    const badLimit = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/bars?limit=501' });
    assert.equal(badLimit.statusCode, 400);
    const badId = await app.inject({ method: 'GET', url: '/v1/instruments/600519.SH/quote' });
    assert.equal(badId.statusCode, 400);
    await app.close();
  });

  it('404 语义：不存在的标识 → INSTRUMENT_NOT_FOUND；存在但无行情/财报 → NOT_FOUND', async () => {
    const { app, serving } = createHarness();
    serving.quote = null;
    const noQuote = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(noQuote.statusCode, 404);
    assert.equal(json<{ code: string }>(noQuote).code, 'NOT_FOUND');
    const noFundamental = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/fundamental-summary' });
    assert.equal(noFundamental.statusCode, 404);
    assert.equal(json<{ code: string }>(noFundamental).code, 'NOT_FOUND');
    const unknown = await app.inject({ method: 'GET', url: '/v1/instruments/SZSE:000001/quote' });
    assert.equal(unknown.statusCode, 404);
    assert.equal(json<{ code: string }>(unknown).code, 'INSTRUMENT_NOT_FOUND');
    await app.close();
  });

  it('fundamental 有数据时返回最近一期与 statement_basis', async () => {
    const { app, serving } = createHarness();
    serving.fundamental = {
      instrument_id: 'SSE:600519',
      report_period: '2026Q3',
      report_end_date: '2026-09-30',
      announced_at: '2026-10-25T00:00:00+08:00',
      statement_basis: 'reported',
      currency: 'CNY',
      revenue: '100000000000.00',
      net_profit: '50000000000.00',
      revenue_yoy_pct: '10.5000',
      net_profit_yoy_pct: null,
      eps: '39.5000',
      roe_pct: null,
      gross_margin_pct: null,
      source: 'tushare',
      asOf: AS_OF,
      stalenessMs: 0,
    };
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/fundamental-summary' });
    assert.equal(response.statusCode, 200);
    const body = json<{ data: Record<string, unknown> }>(response);
    assert.equal(body.data.report_period, '2026Q3');
    assert.equal(body.data.statement_basis, 'reported');
    assert.equal(body.data.revenue, 100000000000);
    assert.equal(body.data.revenue_yoy_pct, 10.5);
    assert.equal(body.data.net_profit_yoy_pct, undefined);
    await app.close();
  });
});

describe('market 插件：缓存降级（硬规则 #2）', () => {
  it('数据源失败时返回最近成功快照：source=platform_degraded、保留原 as_of、重算 staleness', async () => {
    const { app, serving } = createHarness();
    const first = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(first.statusCode, 200);

    serving.failures = 10;
    const second = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(second.statusCode, 200, second.body);
    const body = json<{
      data: { last_price: number };
      meta: { source: { source: string; source_id?: string; as_of: string; staleness_ms: number } };
    }>(second);
    assert.equal(body.data.last_price, 1690);
    assert.equal(body.meta.source.source, 'platform_degraded');
    assert.equal(body.meta.source.as_of, AS_OF);
    assert.equal(body.meta.source.staleness_ms, 30 * 60 * 1000);
    assert.equal(body.meta.source.source_id, 'tushare');
    await app.close();
  });

  it('无缓存且数据源失败 → 500 Problem（不能 200+空 data）', async () => {
    const { app, serving } = createHarness();
    serving.failures = 10;
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(response.statusCode, 500);
    assert.match(response.headers['content-type'] ?? '', /application\/problem\+json/);
    assert.equal(json<{ code: string }>(response).code, 'INTERNAL_ERROR');
    assert.doesNotMatch(response.body, /serving view 连接失败/);
    await app.close();
  });
});

describe('market 插件：watchlist（平台自有数据）', () => {
  it('无凭据 → 401 UNAUTHENTICATED；有 Bearer → 200 + platform_user_data/true', async () => {
    const { app } = createHarness();
    const unauthorized = await app.inject({ method: 'GET', url: '/v1/watchlist' });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(json<{ code: string }>(unauthorized).code, 'UNAUTHENTICATED');
    const authorized = await app.inject({
      method: 'GET',
      url: '/v1/watchlist',
      headers: { authorization: 'Bearer e2e-token' },
    });
    assert.equal(authorized.statusCode, 200);
    const body = json<{ data: { items: unknown[] }; meta: { source: { source: string; staleness_ms: number }; entitlement: unknown } }>(
      authorized,
    );
    assert.deepEqual(body.data.items, []);
    assert.equal(body.meta.source.source, 'platform_watchlist');
    assert.equal(body.meta.source.staleness_ms, 0);
    assert.deepEqual(body.meta.entitlement, { tier: 'platform_user_data', is_entitled: true });
    await app.close();
  });

  it('POST 幂等（重复添加 added_at 不变）、GET 列表、DELETE 幂等 204、超上限 400', async () => {
    const { app } = createHarness();
    const headers = { authorization: 'Bearer e2e-token' };
    const add = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers,
      payload: { instrument_id: 'SSE:600519' },
    });
    assert.equal(add.statusCode, 200);
    const firstBody = json<{ data: { instrument_id: string; added_at: string } }>(add);
    assert.equal(firstBody.data.instrument_id, 'SSE:600519');
    assert.match(firstBody.data.added_at, /\+08:00$/);

    const again = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers,
      payload: { instrument_id: 'SSE:600519' },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(json<{ data: { added_at: string } }>(again).data.added_at, firstBody.data.added_at);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers,
      payload: { instrument_id: 'SZSE:000001' },
    });
    assert.equal(second.statusCode, 200);
    const overflow = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers,
      payload: { instrument_id: 'BSE:430047' },
    });
    assert.equal(overflow.statusCode, 400);
    assert.equal(json<{ code: string }>(overflow).code, 'VALIDATION_ERROR');

    const list = await app.inject({ method: 'GET', url: '/v1/watchlist', headers });
    assert.equal(list.statusCode, 200);
    const items = json<{ data: { items: Array<{ instrument_id: string }> } }>(list).data.items;
    assert.deepEqual(
      items.map((item) => item.instrument_id),
      ['SZSE:000001', 'SSE:600519'],
    );

    const remove = await app.inject({ method: 'DELETE', url: '/v1/watchlist/SSE:600519', headers });
    assert.equal(remove.statusCode, 204);
    const removeAgain = await app.inject({ method: 'DELETE', url: '/v1/watchlist/SSE:600519', headers });
    assert.equal(removeAgain.statusCode, 204);
    await app.close();
  });

  it('POST 非法 instrument_id → 400 VALIDATION_ERROR', async () => {
    const { app } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers: { authorization: 'Bearer e2e-token' },
      payload: { instrument_id: '600519.SH' },
    });
    assert.equal(response.statusCode, 400);
    await app.close();
  });
});

describe('market 插件：fail-open 默认值（H5 P0 卡点）', () => {
  it('未配置 ENTITLEMENT_TIER → 最小授权 internal_eval：行情/财务 403，instrument meta.tier=internal_eval', async () => {
    const config = loadMarketConfig({ APP_PROFILE: 'test', E2E_MODE: '1', MARKET_NOW: '2026-11-04T10:00:00+08:00' } as NodeJS.ProcessEnv);
    assert.equal(config.entitlementTier, 'internal_eval', '缺省必须是 internal_eval（不能默认最大授权）');
    const { app } = createHarness(config);
    for (const path of ['/v1/instruments/SSE:600519/quote', '/v1/instruments/SSE:600519/bars', '/v1/instruments/SSE:600519/fundamental-summary']) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 403, `${path} 缺省层级必须 403`);
      assert.equal(json<{ code?: string }>(response).code, 'ENTITLEMENT_RESTRICTED');
    }
    const instrument = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
    assert.equal(instrument.statusCode, 200);
    const body = json<{ meta: { entitlement: { tier: string; is_entitled: boolean } } }>(instrument);
    assert.deepEqual(body.meta.entitlement, { tier: 'internal_eval', is_entitled: false });
    await app.close();
  });

  it('tier≠internal_eval 却没有 ENTITLEMENT_EXPIRES_AT → 拒绝启动（不是"不启用时间盒"）', () => {
    assert.throws(
      () => loadMarketConfig({ ENTITLEMENT_TIER: 'c_end_display' } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof MarketConfigError && /ENTITLEMENT_EXPIRES_AT/.test(error.message),
    );
    const { entitlementExpiresAt: _omitted, ...configWithoutExpiry } = marketConfig();
    assert.throws(
      () => createMarketPlugin({ config: configWithoutExpiry, servingRepo: new FakeServing(), watchlistRepo: new FakeWatchlist() }),
      (error: unknown) => error instanceof MarketConfigError && /ENTITLEMENT_EXPIRES_AT/.test(error.message),
      '注入 config 也必须过同一道校验',
    );
    // internal_eval 不强制时间盒（本来就恒 403）
    assert.doesNotThrow(() => loadMarketConfig({ ENTITLEMENT_TIER: 'internal_eval' } as NodeJS.ProcessEnv));
  });

  it('生产守卫 fail-closed（L44/L46）：APP_PROFILE 缺省=prod，仅 dev/test/e2e 放行 E2E 后门', () => {
    // ① 未设任何 profile/node_env + E2E_MODE=1 → 必须拒启
    assert.throws(
      () => loadMarketConfig({ E2E_MODE: '1' } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof MarketConfigError && /E2E 模式在生产不可用/.test(error.message),
    );
    // ② 拼错 / 空串 → 按 prod 拒启
    for (const profile of ['prodd', '', 'Production']) {
      assert.throws(
        () => loadMarketConfig({ APP_PROFILE: profile, E2E_MODE: '1' } as NodeJS.ProcessEnv),
        (error: unknown) => error instanceof MarketConfigError && /E2E 模式在生产不可用/.test(error.message),
        `APP_PROFILE=${JSON.stringify(profile)} 必须按 prod 处理`,
      );
    }
    // NODE_ENV 不参与安全判定：production 但显式 test profile → 允许（只在日志/构建使用）
    assert.doesNotThrow(() =>
      loadMarketConfig({ NODE_ENV: 'production', APP_PROFILE: 'test', E2E_MODE: '1' } as NodeJS.ProcessEnv),
    );
    assert.throws(
      () => loadMarketConfig({ APP_PROFILE: 'prod', E2E_AUTH_TOKEN: 'dev-token' } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof MarketConfigError && /E2E_AUTH_TOKEN/.test(error.message),
    );
    assert.throws(
      () => loadMarketConfig({ APP_PROFILE: 'prod', WATCHLIST_DEV_AUTH: '1' } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof MarketConfigError && /WATCHLIST_DEV_AUTH/.test(error.message),
    );
    // 显式开发 profile 仍可开启（测试栈依赖）
    assert.doesNotThrow(() => loadMarketConfig({ APP_PROFILE: 'e2e', E2E_MODE: '1' } as NodeJS.ProcessEnv));
  });

  it('到期启动写恰好 1 条 entitlement_expired，event_key 逐字 UTC 毫秒且重启幂等（L20/L59）', async () => {
    const records: EntitlementEventRecord[] = [];
    const repo: EntitlementEventRepo = {
      async insert(record) {
        // 模拟 ON CONFLICT (event_key) DO NOTHING
        if (!records.some((existing) => existing.eventKey === record.eventKey)) records.push(record);
      },
    };
    const expiredConfig = marketConfig({
      entitlementTier: 'c_end_display',
      entitlementExpiresAt: '2026-11-01T00:00:00+08:00',
    });
    const start = async (bootId: string): Promise<void> => {
      const plugin = createMarketPlugin({
        config: expiredConfig,
        servingRepo: new FakeServing(),
        watchlistRepo: new FakeWatchlist(),
        eventRepo: repo,
        bootId,
      });
      const app = buildApp({ config: appConfig, domainPlugins: [plugin], logger: false });
      const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
      assert.equal(response.statusCode, 403);
      await app.close();
    };
    await start('22222222-2222-4222-8222-222222222222');
    await start('33333333-3333-4333-8333-333333333333');

    const expired = records.filter((record) => record.eventType === 'entitlement_expired');
    assert.equal(expired.length, 1, '同一 expires_at 重启不重复写（event_key 幂等）');
    assert.equal(
      expired[0]?.eventKey,
      'exp|c_end_display|2026-10-31T16:00:00.000Z|expires_at_passed',
    );
    assert.equal(expired[0]?.reason, 'expires_at_passed');
    assert.equal(expired[0]?.effectiveTier, 'internal_eval');
    assert.equal(expired[0]?.configuredTier, 'c_end_display');
    assert.equal(records.filter((record) => record.eventType === 'tier_state_observed').length, 2);
  });

  it('expired 事件写失败：保持 internal_eval、不拒启，healthz 报 expired_event_write_failed（H4）', async () => {
    const observed: EntitlementEventRecord[] = [];
    const repo: EntitlementEventRepo = {
      async insert(record) {
        if (record.eventType === 'entitlement_expired') throw new Error('audit 表不可写（测试注入）');
        observed.push(record);
      },
    };
    const plugin = createMarketPlugin({
      config: marketConfig({
        entitlementTier: 'c_end_display',
        entitlementExpiresAt: '2026-11-01T00:00:00+08:00',
      }),
      servingRepo: new FakeServing(),
      watchlistRepo: new FakeWatchlist(),
      eventRepo: repo,
      bootId: '55555555-5555-4555-8555-555555555555',
    });
    const app = buildApp({ config: appConfig, domainPlugins: [plugin], logger: false });
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
    const body = json<{ entitlement_degraded?: boolean; entitlement_degraded_reason?: string }>(health);
    assert.equal(body.entitlement_degraded, true);
    assert.equal(body.entitlement_degraded_reason, 'expired_event_write_failed');
    const quote = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(quote.statusCode, 403);
    assert.equal(observed.filter((record) => record.eventType === 'tier_state_observed').length, 1);
    await app.close();
  });

  it('到期后 meta.tier 回显 effective tier（internal_eval），而不是配置原文', async () => {
    const expired = loadMarketConfig({
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: '2026-11-01T00:00:00+08:00',
      APP_PROFILE: 'test',
      E2E_MODE: '1',
      MARKET_NOW: '2026-11-04T10:00:00+08:00',
    } as NodeJS.ProcessEnv);
    const { app } = createHarness(expired);
    const instrument = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
    const body = json<{ meta: { entitlement: { tier: string; is_entitled: boolean } } }>(instrument);
    assert.deepEqual(body.meta.entitlement, { tier: 'internal_eval', is_entitled: false });
    await app.close();
  });

  it('生产（非 E2E）缺期望指纹 → 拒绝启动：预期指纹缺失不再静默跳过自检', () => {
    assert.throws(
      () =>
        loadMarketConfig({
          ENTITLEMENT_TIER: 'c_end_display',
          ENTITLEMENT_EXPIRES_AT: '2099-12-31T23:59:59+08:00',
        } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof MarketConfigError && /ENTITLEMENT_CONFIG_EXPECTED_SHA256/.test(error.message),
    );
    // E2E 允许豁免（真栈不注入流水线指纹）；internal_eval 不需豁免。
    assert.doesNotThrow(() =>
      loadMarketConfig({
        APP_PROFILE: 'test',
        ENTITLEMENT_TIER: 'c_end_display',
        ENTITLEMENT_EXPIRES_AT: '2099-12-31T23:59:59+08:00',
        E2E_MODE: '1',
      } as NodeJS.ProcessEnv),
    );
  });

  it('免责文案仍是 A5 占位：A5 正式文案上线后本测试应变红提醒替换（Lead m00677 允许保留到 E2E）', () => {
    const config = loadMarketConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.disclaimer.version, '2026.11.1');
    assert.equal(config.disclaimer.text, DEFAULT_DISCLAIMER_TEXT, '默认文案仍是占位常量；A5 定稿后请更新此断言');
    assert.ok(config.disclaimer.text.includes('仅供参考'), '占位文案必须带"仅供参考"合规提示');
  });
});

describe('market 插件：H3 红线与降级边界', () => {
  it('quote/bars/instrument 响应 data 不含投资判断性文案（免责声明合规文案除外）', async () => {
    const { app } = createHarness();
    for (const path of ['/v1/instruments/SSE:600519', '/v1/instruments/SSE:600519/quote', '/v1/instruments/SSE:600519/bars']) {
      const response = await app.inject({ method: 'GET', url: path });
      const body = json<{ data: unknown }>(response);
      const dataText = JSON.stringify(body.data);
      for (const banned of ['建议', '评级', '目标价', '买入', '卖出', '增持', '减持', '推荐']) {
        assert.equal(dataText.includes(banned), false, `${path} data 出现禁止词「${banned}」`);
      }
    }
    await app.close();
  });

  it('插件导出 shell 需要的元数据（domain=market, contractVersion=0.3.0）', () => {
    const plugin = createMarketPlugin({ config: marketConfig(), servingRepo: new FakeServing(), watchlistRepo: new FakeWatchlist() });
    assert.equal(plugin.domain, 'market');
    assert.equal(plugin.contractVersion, '0.3.0');
  });
});

describe('market 插件：授权到期 fail-closed（H3 时间盒，ADR-004）', () => {
  // 关键：配置必须走 loadMarketConfig 真实解析（不是硬编码 bool），证明"配置里的 expires_at"生效。
  function loadedConfig(env: Record<string, string>): MarketConfig {
    return loadMarketConfig({
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: '2099-12-31T23:59:59+08:00',
      APP_PROFILE: 'test',
      E2E_MODE: '1',
      MARKET_NOW: '2026-11-04T10:00:00+08:00',
      ...env,
    } as NodeJS.ProcessEnv);
  }

  it('expires_at 已过期：行情/财务 403 ENTITLEMENT_RESTRICTED，instrument 200+false 且仅白名单字段', async () => {
    const expired = loadedConfig({ ENTITLEMENT_EXPIRES_AT: '2026-11-01T00:00:00+08:00' });
    const { app } = createHarness(expired);

    for (const path of [
      '/v1/instruments/SSE:600519/quote',
      '/v1/instruments/SSE:600519/bars',
      '/v1/instruments/SSE:600519/fundamental-summary',
    ]) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 403, `${path} 过期后必须 403`);
      const body = json<{ code?: string; data?: unknown }>(response);
      assert.equal(body.code, 'ENTITLEMENT_RESTRICTED');
      assert.equal(body.data, undefined, `${path} 过期后不得返回 data（空数据会被前端当真实值）`);
    }

    const instrument = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
    assert.equal(instrument.statusCode, 200);
    const body = json<{ data: Record<string, unknown>; meta: { entitlement: { tier: string; is_entitled: boolean } } }>(instrument);
    assert.deepEqual(body.meta.entitlement, { tier: 'internal_eval', is_entitled: false });
    assert.deepEqual(Object.keys(body.data).sort(), [
      'board',
      'exchange',
      'instrument_id',
      'list_status',
      'listed_at',
      'name',
      'security_type',
    ]);

    // 自选是平台自有数据，不受行情授权时间盒影响。
    const watchlist = await app.inject({
      method: 'GET',
      url: '/v1/watchlist',
      headers: { authorization: 'Bearer e2e-token' },
    });
    assert.equal(watchlist.statusCode, 200);
    const wl = json<{ meta: { entitlement: { tier: string; is_entitled: boolean } } }>(watchlist);
    assert.deepEqual(wl.meta.entitlement, { tier: 'platform_user_data', is_entitled: true });

    await app.close();
  });

  it('expires_at 未到期：正常放行；恰好到点（>=）按已过期处理', async () => {
    const future = loadedConfig({ ENTITLEMENT_EXPIRES_AT: '2026-12-31T23:59:59+08:00' });
    const { app } = createHarness(future);
    const ok = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(ok.statusCode, 200);
    await app.close();

    const boundary = loadedConfig({ ENTITLEMENT_EXPIRES_AT: '2026-11-04T10:00:00+08:00' });
    const { app: boundaryApp } = createHarness(boundary);
    const denied = await boundaryApp.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(denied.statusCode, 403);
    await boundaryApp.close();
  });

  it('expires_at 配置非法：loadMarketConfig 快速失败（不允许线上带脏时间盒启动）', () => {
    assert.throws(
      () => loadMarketConfig({ ENTITLEMENT_EXPIRES_AT: '2026-11-12' } as NodeJS.ProcessEnv),
      /ENTITLEMENT_EXPIRES_AT/,
    );
    assert.throws(
      () => loadMarketConfig({ ENTITLEMENT_EXPIRES_AT: 'not-a-date+08:00' } as NodeJS.ProcessEnv),
      /ENTITLEMENT_EXPIRES_AT/,
    );
  });
});

describe('market 插件：getInstrument 正向白名单（H4 基础信息口径）', () => {
  it('buildInstrumentResponse 只输出白名单字段，绝不含 lot_size/price/volume', async () => {
    const { app } = createHarness();
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
    const body = json<{ data: Record<string, unknown> }>(response);
    assert.deepEqual(Object.keys(body.data).sort(), [
      'board',
      'exchange',
      'instrument_id',
      'list_status',
      'listed_at',
      'name',
      'security_type',
    ]);
    for (const banned of ['price', 'last_price', 'volume', 'amount', 'change', 'change_pct', 'lot_size']) {
      assert.equal(banned in body.data, false, `getInstrument 泄漏白名单外字段: ${banned}`);
    }
    await app.close();
  });

  it('往 instrument 响应塞 price 字段会被运行时白名单拦下（默认拒绝）', async () => {
    const response = {
      instrument_id: 'SSE:600519',
      exchange: 'SSE',
      name: '贵州茅台',
      board: 'main',
      security_type: 'stock',
      list_status: 'listed',
      price: 1690,
    };
    assert.throws(() => assertInstrumentWhitelist(response), /白名单外字段: price/);
    const { app } = createHarness();
    await app.close();
  });
});


async function makeApp(
  overrides: Partial<MarketConfig> = {},
  options: { controlRepo?: EntitlementControlRepo } = {},
): Promise<Harness> {
  const serving = new FakeServing();
  const watchlist = new FakeWatchlist();
  const plugin = createMarketPlugin({
    config: marketConfig(overrides),
    servingRepo: serving,
    watchlistRepo: watchlist,
    ...(options.controlRepo !== undefined ? { controlRepo: options.controlRepo } : {}),
  });
  const app = buildApp({ config: appConfig, domainPlugins: [plugin], logger: false });
  return { app, serving, watchlist };
}

describe('market 插件：响应缓存头与 C 端受众（L30/L36）', () => {
  it('凡响应含 meta.entitlement（含 getInstrument 200 / 403）一律 Cache-Control: no-store', async () => {
    const { app } = await makeApp();
    const paths = [
      '/v1/instruments/SSE:600519',
      '/v1/instruments/SSE:600519/quote',
      '/v1/instruments/SSE:600519/bars?limit=1',
    ];
    for (const path of paths) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 200, path);
      assert.equal(response.headers['cache-control'], 'no-store', path);
    }
    // 403 与缺失资源同样 no-store；未授权的行情不得被 CDN 缓存后继续渲染。
    const restricted = await makeApp({ entitlementTier: 'internal_eval' });
    const forbidden = await restricted.app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.headers['cache-control'], 'no-store');
    // 顺序：存在性先于 entitlement（Lead m00443）——未知标的 404 而非 403。
    const unknown = await restricted.app.inject({ method: 'GET', url: '/v1/instruments/SSE:999999/quote' });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.headers['cache-control'], 'no-store');
    const watchlist = await app.inject({
      method: 'GET',
      url: '/v1/watchlist',
      headers: { authorization: 'Bearer e2e-token' },
    });
    assert.equal(watchlist.statusCode, 200);
    assert.equal(watchlist.headers['cache-control'], 'no-store');
  });

  it('display_safe=false：C 端不出现（404 INSTRUMENT_NOT_FOUND），不被当成无数据', async () => {
    const { app, serving } = await makeApp();
    serving.instrument = { ...instrumentRow, display_safe: false };
    for (const path of [
      '/v1/instruments/SSE:600519',
      '/v1/instruments/SSE:600519/quote',
      '/v1/instruments/SSE:600519/bars',
      '/v1/instruments/SSE:600519/fundamental-summary',
    ]) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 404, path);
      assert.equal(json<{ code: string }>(response).code, 'INSTRUMENT_NOT_FOUND', path);
    }
  });

  it('授权配置指纹不一致：effective tier 降为 internal_eval 且行情 403（绝不静默放行）', async () => {
    const config = loadMarketConfig({
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: '2099-12-31T23:59:59+08:00',
      ENTITLEMENT_CONFIG_EXPECTED_SHA256: '0'.repeat(64),
      APP_PROFILE: 'test',
      E2E_MODE: '1',
    } as NodeJS.ProcessEnv);
    const { app } = await makeApp(config);
    const quote = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(quote.statusCode, 403);
    assert.equal(json<{ code: string }>(quote).code, 'ENTITLEMENT_RESTRICTED');
    const instrument = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
    assert.equal(instrument.statusCode, 200);
    const payload = json<{ meta: { entitlement: { tier: string; is_entitled: boolean } } }>(instrument);
    assert.equal(payload.meta.entitlement.tier, 'internal_eval');
    assert.equal(payload.meta.entitlement.is_entitled, false);
  });

  it('control 行 hold=true：行情/财务 403、基础信息照常 internal_eval、/healthz 报 entitlement_degraded', async () => {
    const controlRepo = {
      fetchControl: async () => ({
        lastReconciledAt: new Date(NOW.getTime() - 60_000),
        hold: true,
        holdId: 'hold-1',
        reason: 'human_hold',
      }),
    };
    const { app } = await makeApp({}, { controlRepo });
    const quote = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(quote.statusCode, 403);
    // H4 m01681：内部原因只能出现在运维可达的 /healthz，不得出现在 C 端响应。
    for (const internal of ['entitlement_degraded', 'hold_reason', 'hold_active', 'expired_event_write_failed']) {
      assert.equal(quote.body.includes(internal), false, `C 端 403 不应包含内部原因 ${internal}`);
    }
    const instrument = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
    assert.equal(instrument.statusCode, 200);
    const payload = json<{ meta: { entitlement: { tier: string; is_entitled: boolean } } }>(instrument);
    assert.equal(payload.meta.entitlement.tier, 'internal_eval');
    // control hold 必须在 /healthz 与 data_ready 分维度暴露（A12 preflight 要能区分）。
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
    const body = json<Record<string, unknown>>(health);
    assert.equal(body.entitlement_degraded, true);
    assert.equal(typeof body.data_ready, 'boolean');
  });

  it('403 文案来自 shell copy.ts 的中性文案，不出现法律定性词', async () => {
    const { app } = await makeApp({ entitlementTier: 'internal_eval' });
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(response.statusCode, 403);
    const problem = json<{ title: string; detail: string }>(response);
    assert.equal(problem.title, MARKET_COPY.entitlementRestrictedTitle);
    assert.equal(problem.detail, MARKET_COPY.entitlementRestrictedDetail);
    for (const banned of ['授权', '未取得', '法律', '许可', '再分发']) {
      assert.ok(!problem.detail.includes(banned), `403 detail 不应含「${banned}」`);
    }
    const missing = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:999999' });
    assert.equal(missing.statusCode, 404);
    const notFound = json<{ code: string; detail: string }>(missing);
    assert.equal(notFound.code, 'INSTRUMENT_NOT_FOUND');
    assert.ok(notFound.detail.startsWith(MARKET_COPY.instrumentNotFoundDetailPrefix));
  });
});
