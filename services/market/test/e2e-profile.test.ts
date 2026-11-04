/**
 * H5 m02614：E2E profile（APP_PROFILE=e2e + E2E_MODE=1）在**无 token** 时是否存在
 * 数据/授权旁路。这里用 loadMarketConfig 解析真实 env（不是硬编码 bool）驱动插件：
 *   - entitlement 仍按配置档位判定（internal_eval → 403），不因 e2eMode 放行；
 *   - 空 E2E_AUTH_TOKEN 不产生可用 bearer，自选 401；任何静态 token 都不匹配；
 *   - 403 路径不读 serving（gate 前置），响应体无行情数值字段。
 * 另覆盖 L73 生产守卫：APP_PROFILE 缺省/空/拼错都按 prod，E2E_MODE=1 拒启。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../../api/src/app.js';
import { loadConfig } from '../../api/src/config.js';
import { isProductionProfile, loadMarketConfig } from '../src/config.js';
import { createMarketPlugin } from '../src/plugin.js';
import type { AppConfig } from '../../api/src/config.js';
import type { MarketConfig } from '../src/config.js';
import type {
  InstrumentRow,
  ServingRepo,
} from '../src/ports/serving-repo.js';
import type { WatchlistRepo } from '../src/ports/watchlist-repo.js';

const appConfig: AppConfig = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv);

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
  asOf: '2026-11-03T15:00:00+08:00',
  stalenessMs: 1000,
};

/** 记录所有 serving 调用：403 路径必须一次都不碰。 */
function guardedServing(calls: string[]): ServingRepo {
  return {
    async getInstrument() { calls.push('getInstrument'); return instrumentRow; },
    async getQuote() { calls.push('getQuote'); return quoteRow as never; },
    async getBars() { calls.push('getBars'); return { rows: [], hasMore: false, adjustment: 'none' }; },
    async getLatestFactor() { calls.push('getLatestFactor'); return null; },
    async getFundamentalSummary() { calls.push('getFundamentalSummary'); return null; },
  };
}

const quoteRow = {
  instrument_id: 'SSE:600519',
  trade_date: '2026-11-03',
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
  asOf: '2026-11-03T15:00:00+08:00',
  stalenessMs: 1000,
};

function watchlistStub(): WatchlistRepo {
  return {
    async list() { return []; },
    async add() { throw new Error('watchlist add should not be called'); },
    async remove() { /* no-op */ },
    async ensureSchema() { /* autoMigrate=true 时插件会调用；记录已覆盖 */ },
  };
}

const E2E_ENV: NodeJS.ProcessEnv = {
  APP_PROFILE: 'e2e',
  E2E_MODE: '1',
  E2E_AUTH_TOKEN: '',
  ENTITLEMENT_TIER: 'internal_eval',
};

describe('H5 m02614：E2E profile 无 token 旁路回归', () => {
  it('E2E_MODE=1 + E2E_AUTH_TOKEN 空串：config 开启 devAuth 入口但无可用 token，entitlement 仍 internal_eval', () => {
    const config = loadMarketConfig({ ...E2E_ENV });
    assert.equal(config.e2eMode, true);
    assert.equal(config.allowDevAuth, true); // e2eMode 打开静态 token 入口…
    assert.equal(config.devAuthToken, undefined); // …但空 token 不产生可用凭据
    assert.equal(config.entitlementTier, 'internal_eval');
    // 关键 gated 行为：e2eMode 默认**关闭** hold 检查与审计（见下方 hold 生效旁路用例）
    assert.equal(config.entitlementHoldCheck, false);
    assert.equal(config.entitlementAuditEnabled, false);
    assert.equal(config.autoMigrate, true);
  });

  it('无 token 时 quote/bars/fundamental 仍按 entitlement 403，且不读 serving、无行情数值', async () => {
    const config = loadMarketConfig({ ...E2E_ENV });
    const calls: string[] = [];
    const app = buildApp({
      config: appConfig,
      domainPlugins: [
        createMarketPlugin({ config, servingRepo: guardedServing(calls), watchlistRepo: watchlistStub() }),
      ],
      logger: false,
    });

    for (const path of [
      '/v1/instruments/SSE:600519/quote',
      '/v1/instruments/SSE:600519/bars?limit=1',
      '/v1/instruments/SSE:600519/fundamental-summary',
    ]) {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.statusCode, 403, path);
      assert.equal(res.headers['cache-control'], 'no-store', path);
      const body = res.json() as Record<string, unknown>;
      assert.equal(body.code, 'ENTITLEMENT_RESTRICTED', path);
      assert.equal('data' in body, false, `${path} 不得带 data`);
      for (const key of ['last_price', 'prev_close', 'change', 'change_pct', 'volume', 'amount', 'close', 'open', 'high', 'low']) {
        assert.equal(key in body, false, `${path} 不得包含 ${key}`);
      }
    }
    assert.deepEqual(calls, [], 'blocked 403 路径不得读 serving（gate 前置）');
    await app.close();
  });

  it('E2E_MODE=1 空 token：自选 401；任意静态 token 也不匹配（devAuth 无凭据）', async () => {
    const config = loadMarketConfig({ ...E2E_ENV });
    const app = buildApp({
      config: appConfig,
      domainPlugins: [
        createMarketPlugin({ config, servingRepo: guardedServing([]), watchlistRepo: watchlistStub() }),
      ],
      logger: false,
    });

    for (const headers of [
      {},
      { authorization: 'Bearer ' },
      { authorization: 'Bearer   ' },
      { authorization: 'Bearer e2e-token' },
    ] as Array<Record<string, string>>) {
      const res = await app.inject({ method: 'GET', url: '/v1/watchlist', headers });
      assert.equal(res.statusCode, 401, JSON.stringify(headers));
      assert.equal(res.json().code, 'UNAUTHENTICATED');
    }
    await app.close();
  });
});

describe('L73 生产守卫：APP_PROFILE 缺省/空/拼错 = prod', () => {
  for (const [label, env] of [
    ['缺省', {}],
    ['空串', { APP_PROFILE: '' }],
    ['拼错 prodd', { APP_PROFILE: 'prodd' }],
    ['拼错 prodution', { APP_PROFILE: 'prodution' }],
    ['大小写 Production', { APP_PROFILE: 'Production' }],
  ] as Array<[string, NodeJS.ProcessEnv]>) {
    it(`${label} + E2E_MODE=1 → 拒绝启动`, () => {
      assert.equal(isProductionProfile(env), true, label);
      assert.throws(
        () => loadMarketConfig({ ...env, E2E_MODE: '1' }),
        /E2E 模式在生产不可用/,
        label,
      );
    });
  }

  it('显式 e2e 放行，且不因 NODE_ENV=production 改变判定', () => {
    const config: MarketConfig = loadMarketConfig({ ...E2E_ENV, NODE_ENV: 'production' });
    assert.equal(config.e2eMode, true);
    assert.equal(isProductionProfile({ APP_PROFILE: 'e2e', NODE_ENV: 'production' }), false);
  });
});

describe('H5 m02614：E2E_MODE=1 的授权旁路（非 token 维度）', () => {
  it('E2E_MODE=1 默认关闭 hold 检查：c_end_display 且无 expected sha 仍返回行情（hold 不会被读）', async () => {
    const config = loadMarketConfig({
      APP_PROFILE: 'e2e',
      E2E_MODE: '1',
      E2E_AUTH_TOKEN: '',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: '2030-12-31T00:00:00Z',
      // 没有 ENTITLEMENT_CONFIG_EXPECTED_SHA256：e2eMode 跳过指纹自检（config.ts:123）
    });
    assert.equal(config.entitlementHoldCheck, false);
    assert.equal(config.entitlementAuditEnabled, false);
    assert.equal(config.entitlementExpectedSha256, undefined);

    const calls: string[] = [];
    const app = buildApp({
      config: appConfig,
      domainPlugins: [
        createMarketPlugin({ config, servingRepo: guardedServing(calls), watchlistRepo: watchlistStub() }),
      ],
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.meta.entitlement.tier, 'c_end_display');
    assert.equal(body.meta.entitlement.is_entitled, true);
    assert.equal(typeof body.data.last_price, 'number');
    await app.close();
  });

  it('同一 e2e 配置若显式 HOLD_CHECK=1 + control hold=true → 403（证明旁路来自开关默认值，不是 entitlement 自身）', async () => {
    const config = loadMarketConfig({
      APP_PROFILE: 'e2e',
      E2E_MODE: '1',
      E2E_AUTH_TOKEN: '',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: '2030-12-31T00:00:00Z',
      ENTITLEMENT_HOLD_CHECK: '1',
    });
    assert.equal(config.entitlementHoldCheck, true);
    const app = buildApp({
      config: appConfig,
      domainPlugins: [
        createMarketPlugin({
          config,
          servingRepo: guardedServing([]),
          watchlistRepo: watchlistStub(),
          controlRepo: {
            async fetchControl() {
              return { hold: true, holdId: 'h1', reason: 'hold_active', lastReconciledAt: new Date() };
            },
          },
        }),
      ],
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'ENTITLEMENT_RESTRICTED');
    await app.close();
  });

  it('非 e2e（APP_PROFILE=test）同配置缺 expected sha → 拒启；E2E_MODE 是唯一豁免源', () => {
    const base = {
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: '2030-12-31T00:00:00Z',
    };
    assert.throws(
      () => loadMarketConfig({ ...base, APP_PROFILE: 'test' }),
      /ENTITLEMENT_CONFIG_EXPECTED_SHA256/,
    );
    assert.doesNotThrow(() => loadMarketConfig({ ...base, APP_PROFILE: 'e2e', E2E_MODE: '1' }));
  });
});
