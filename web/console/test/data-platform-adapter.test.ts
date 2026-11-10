import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpDataPlatformService } from '../src/adapters/http-data-platform-service';
import type { HttpFetch } from '../src/adapters/http-common';

/** 构造 HttpFetch（测试注入；按 URL pattern 返回预置响应）。 */
function fakeFetch(
  handler: (url: string, init?: { method?: string; body?: string }) => { status: number; body: unknown },
): { fetch: HttpFetch; calls: { url: string; init?: { method?: string; body?: string } }[] } {
  const calls: { url: string; init?: { method?: string; body?: string } }[] = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    const out = handler(url, init);
    return {
      status: out.status,
      ok: out.status >= 200 && out.status < 300,
      headers: { get: () => null },
      json: async () => out.body,
      text: async () => JSON.stringify(out.body),
    };
  };
  return { fetch: fetchImpl, calls };
}

const opts = (fetchImpl: HttpFetch) => ({
  fetchImpl,
  baseUrl: '/v1',
  environment: 'dev' as const,
  authHeaders: () => ({ authorization: 'Bearer tok' }),
});

test('data-platform: listDatasets GET /v1/internal/data-platform/catalog', async () => {
  const payload = {
    as_of: '2026-11-10T07:00:00+08:00',
    datasets: [
      { name: 'daily_basic', domain: 'fundamental', title: '每日基本面', description: 'x', pointsMin: 2000, docId: 32, source: 'tushare', mode: 'daily', viewName: 'serving_research_daily_basic', rowCount: '12345', latestAsOf: '2026-11-09T15:00:00+08:00', latestDate: '2026-11-09' },
    ],
  };
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: payload }));
  const svc = new HttpDataPlatformService(opts(fetch));
  const out = await svc.listDatasets();
  assert.equal(out.as_of, payload.as_of);
  assert.equal(out.datasets.length, 1);
  // rowCount 字符串强制转 number（precision-safe wire → React state）
  assert.equal(typeof out.datasets[0]!.rowCount, 'number');
  assert.equal(out.datasets[0]!.rowCount, 12345);
  assert.equal(calls[0]!.url, '/v1/internal/data-platform/catalog');
  assert.equal(calls[0]!.init?.method, 'GET');
});

test('data-platform: getDatasetMeta encodeURIComponent dataset name', async () => {
  const meta = { name: 'daily_basic', domain: 'fundamental', title: 'x', description: 'y', pointsMin: 2000, docId: 32, source: 'tushare', mode: 'daily', viewName: 'v' };
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: meta }));
  const svc = new HttpDataPlatformService(opts(fetch));
  const out = await svc.getDatasetMeta('daily_basic');
  assert.equal(out.name, 'daily_basic');
  assert.equal(calls[0]!.url, '/v1/internal/data-platform/datasets/daily_basic');
});

test('data-platform: queryDataset POST body 透传 + limit/instrumentId', async () => {
  const page = { dataset: 'daily_basic', rows: [{ instrument_id: 'SSE:600519', trade_date: '2026-11-09', close: '1510', source: 'tushare', as_of: '2026-11-09T15:00:00+08:00', staleness_ms: 0 }], total: 1, limit: 50, offset: 0, as_of: '2026-11-10T07:00:00+08:00' };
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: page }));
  const svc = new HttpDataPlatformService(opts(fetch));
  const out = await svc.queryDataset('daily_basic', { limit: 50, instrumentId: 'SSE:600519' });
  assert.equal(out.dataset, 'daily_basic');
  assert.equal(out.rows.length, 1);
  assert.equal(out.total, 1);
  assert.equal(calls[0]!.init?.method, 'POST');
  const body = JSON.parse(calls[0]!.init?.body ?? '{}') as Record<string, unknown>;
  assert.equal(body.limit, 50);
  assert.equal(body.instrumentId, 'SSE:600519');
});
