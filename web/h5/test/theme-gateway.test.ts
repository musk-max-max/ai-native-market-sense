import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HttpThemeGateway,
  clearThemeCache,
  parseRetryAfter,
} from '../src/data/themeGateway.ts';
import { canAttempt, markAttempt, remainingMs, resetThrottle } from '../src/data/coldThrottle.ts';
import { interpolate } from '../src/lib/copy.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function countingFetch(handler: (url: string) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: () => number;
} {
  let n = 0;
  const fetchImpl: FetchLike = async (input) => {
    n += 1;
    return handler(String(input));
  };
  return { fetchImpl, calls: () => n };
}

const FIN_HEALTH_BODY = {
  instrument_id: 'SSE:600519',
  as_of: '2026-09-30',
  rows: [
    {
      instrument_id: 'SSE:600519',
      as_of: '2026-09-30',
      period: '2026Q3',
      roe: '12.34',
      or_yoy_pct: '5.6',
      debt_to_assets: null,
      netprofit_yoy_pct: '8.8',
      grossprofit_margin: '91.2',
      netprofit_margin: '52.1',
      current_ratio: '3.5',
      total_revenue: '12000000000',
      net_profit: '6000000000',
      net_profit_parent: '5900000000',
      basic_eps: '47.82',
      staleness_ms: 3600000,
    },
  ],
};

test('T1 财务健康：200 响应解析为 camelCase，string 数字转 number、null 保留', async () => {
  clearThemeCache();
  const { fetchImpl } = countingFetch(() => jsonResponse(FIN_HEALTH_BODY));
  const gw = new HttpThemeGateway('', { fetchImpl });
  const result = await gw.getFinHealth('SSE:600519');
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.equal(result.data.instrumentId, 'SSE:600519');
  assert.equal(result.data.asOf, '2026-09-30');
  assert.equal(result.data.rows.length, 1);
  const row = result.data.rows[0];
  assert.equal(row?.period, '2026Q3');
  assert.equal(row?.roe, 12.34);
  assert.equal(row?.orYoyPct, 5.6);
  assert.equal(row?.debtToAssets, null);
  assert.equal(row?.basicEps, 47.82);
});

test('T2 估值与行情：rows + percentiles 解析，分位缺失为 null', async () => {
  clearThemeCache();
  const body = {
    instrument_id: 'SSE:600519',
    range: '1y',
    as_of: '2026-11-17',
    rows: [
      { instrument_id: 'SSE:600519', trade_date: '2026-11-17', pe_ttm: '25.5', pb: '3.1', close: '1680.00', turnover_rate_pct: '0.42' },
      { instrument_id: 'SSE:600519', trade_date: '2026-11-16', pe_ttm: null, pb: null, close: null, turnover_rate_pct: null },
    ],
    percentiles: { pe_ttm: '60.1', pb: null, close: '88.8', turnover_rate_pct: '12.3' },
  };
  const { fetchImpl } = countingFetch(() => jsonResponse(body));
  const gw = new HttpThemeGateway('', { fetchImpl });
  const result = await gw.getValuationPrice('SSE:600519', '1y');
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.equal(result.data.range, '1y');
  assert.equal(result.data.rows.length, 2);
  assert.equal(result.data.rows[0]?.peTtm, 25.5);
  assert.equal(result.data.rows[1]?.close, null);
  assert.equal(result.data.percentiles.peTtm, 60.1);
  assert.equal(result.data.percentiles.pb, null);
});

test('T3 资金与情绪：市场级 + 个股级双请求合并为一个结果', async () => {
  clearThemeCache();
  const marketBody = {
    window: '30d',
    as_of: '2026-11-17',
    rows: [
      {
        trade_date: '2026-11-17',
        limit_up_count: '80',
        limit_down_count: '5',
        advancers: '3100',
        decliners: '1900',
        adv_dec_ratio: '1.63',
        max_limit_streak: '6',
        moneyflow_net_inflow_total: '1234567890',
        margin_financing_balance: '180000000000',
      },
    ],
  };
  const stockBody = {
    instrument_id: 'SSE:600519',
    window: '30d',
    as_of: '2026-11-17',
    rows: [
      { instrument_id: 'SSE:600519', trade_date: '2026-11-17', net_inflow_amount: '1000000', lhb_net_amount: null, inst_net_buy_amount: '2000000', financing_balance: '9000000' },
    ],
    summary: {
      net_inflow_sum: '5000000',
      net_inflow_latest: '1000000',
      lhb_count: '0',
      lhb_net_buy_sum: null,
      inst_net_buy_sum: '8000000',
      financing_balance_latest: '9000000',
      financing_balance_change: '100000',
    },
  };
  const { fetchImpl, calls } = countingFetch((url) =>
    url.includes('/stocks/') ? jsonResponse(stockBody) : jsonResponse(marketBody),
  );
  const gw = new HttpThemeGateway('', { fetchImpl });
  const result = await gw.getSentiment('SSE:600519');
  assert.equal(calls(), 2);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.equal(result.data.window, '30d');
  assert.equal(result.data.market.length, 1);
  assert.equal(result.data.market[0]?.limitUpCount, 80);
  assert.equal(result.data.market[0]?.maxLimitStreak, 6);
  assert.equal(result.data.stockRows.length, 1);
  assert.equal(result.data.stockSummary?.lhbCount, 0);
  assert.equal(result.data.stockSummary?.lhbNetBuySum, null);
});

test('429：无缓存 → error，状态与 Retry-After 秒数透出（黄卡输入）', async () => {
  clearThemeCache();
  const { fetchImpl } = countingFetch(() =>
    jsonResponse({ title: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': '120' } }),
  );
  const gw = new HttpThemeGateway('', { fetchImpl });
  const result = await gw.getFinHealth('SSE:600519');
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') return;
  assert.equal(result.error.status, 429);
  assert.equal(result.error.network, false);
  assert.equal(result.error.retryAfterSec, 120);
});

test('5 分钟 LRU：窗口内同 URL 命中缓存不打网络', async () => {
  clearThemeCache();
  let t = 0;
  const { fetchImpl, calls } = countingFetch(() => jsonResponse(FIN_HEALTH_BODY));
  const gw = new HttpThemeGateway('', { fetchImpl, now: () => t });
  const first = await gw.getFinHealth('SSE:600519');
  assert.equal(first.kind, 'ready');
  t = 60_000;
  const second = await gw.getFinHealth('SSE:600519');
  assert.equal(second.kind, 'ready');
  assert.equal(calls(), 1);
});

test('stale-while-error：缓存过期后请求失败 → 旧值回退 + cachedAt + 错误分类', async () => {
  clearThemeCache();
  let t = 0;
  let fail = false;
  const fetchImpl: FetchLike = async () => {
    if (fail) {
      return jsonResponse({ title: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': '90' } });
    }
    return jsonResponse(FIN_HEALTH_BODY);
  };
  const gw = new HttpThemeGateway('', { fetchImpl, now: () => t });
  const first = await gw.getFinHealth('SSE:600519');
  assert.equal(first.kind, 'ready');
  fail = true;
  t = 6 * 60_000;
  const second = await gw.getFinHealth('SSE:600519');
  assert.equal(second.kind, 'stale');
  if (second.kind !== 'stale') return;
  assert.equal(second.data.rows[0]?.roe, 12.34);
  assert.equal(second.cachedAt, 0);
  assert.equal(second.error.status, 429);
});

test('网络失败：fetch 抛错 → network=true、timeout=false、status=null', async () => {
  clearThemeCache();
  const fetchImpl: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
  const gw = new HttpThemeGateway('', { fetchImpl });
  const result = await gw.getValuationPrice('SSE:600519');
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') return;
  assert.equal(result.error.network, true);
  assert.equal(result.error.timeout, false);
  assert.equal(result.error.status, null);
});

test('超时：15s 内未响应被中止 → timeout=true（灰卡输入）', async () => {
  clearThemeCache();
  const fetchImpl: FetchLike = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  const gw = new HttpThemeGateway('', { fetchImpl, timeoutMs: 5 });
  const result = await gw.getFinHealth('SSE:600519');
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') return;
  assert.equal(result.error.timeout, true);
  assert.equal(result.error.network, true);
  assert.equal(result.error.status, null);
});

test('5xx：红卡输入 network=false、timeout=false、status=500', async () => {
  clearThemeCache();
  const { fetchImpl } = countingFetch(() => jsonResponse({ title: 'Internal' }, { status: 500 }));
  const gw = new HttpThemeGateway('', { fetchImpl });
  const result = await gw.getFinHealth('SSE:600519');
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') return;
  assert.equal(result.error.status, 500);
  assert.equal(result.error.network, false);
  assert.equal(result.error.timeout, false);
});

test('parseRetryAfter：delta-seconds / HTTP-date / 非法值', () => {
  assert.equal(parseRetryAfter('120'), 120);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  const now = Date.parse('2026-06-01T00:00:00Z');
  const httpDate = new Date(now + 90_000).toUTCString();
  assert.equal(parseRetryAfter(httpDate, now), 90);
});

test('30s 客户端节流：冷却内不可点、到期恢复、reset 即清', () => {
  resetThrottle();
  const t = 1_000_000;
  assert.equal(canAttempt('theme-key', t), true);
  markAttempt('theme-key', t);
  assert.equal(canAttempt('theme-key', t + 1000), false);
  assert.equal(remainingMs('theme-key', t + 1000), 29_000);
  assert.equal(canAttempt('theme-key', t + 31_000), true);
  markAttempt('other-key', t);
  resetThrottle('other-key');
  assert.equal(canAttempt('other-key', t + 1), true);
  resetThrottle();
});

test('interpolate：单花括号替换、缺参原样保留占位符', () => {
  assert.equal(interpolate('A {x} B', { x: 1 }), 'A 1 B');
  assert.equal(interpolate('{seconds} 秒后可重试', { seconds: 42 }), '42 秒后可重试');
  assert.equal(interpolate('keep {missing} here', {}), 'keep {missing} here');
});
