import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApp } from '../../api/src/app.js';
import { createMarketPlugin } from '../src/plugin.js';
import {
  DATASETS,
  type DataPlatformRepo,
  type DatasetMeta,
  type DatasetStats,
  type ResearchPage,
  type ResearchQuery,
  type ResearchRow,
} from '../src/ports/data-platform-repo.js';
import type { ServingRepo } from '../src/ports/serving-repo.js';
import type { WatchlistRepo } from '../src/ports/watchlist-repo.js';

// 占位仓储（data-platform 路由不用 serving/watchlist，但 plugin 启动必填）。
const unusedServing = {} as ServingRepo;
const unusedWatchlist = { async ensureSchema(): Promise<void> {} } as WatchlistRepo;

const TOKEN = 'test-ops-token';

const FAKE_DATASETS: readonly DatasetStats[] = DATASETS.map((meta) => ({
  ...meta,
  rowCount: 100,
  latestAsOf: '2026-11-04T15:00:00+08:00',
  latestDate: '2026-11-04',
}));

const FAKE_PAGE: ResearchPage = {
  rows: [
    {
      instrument_id: 'SSE:600519',
      trade_date: '2026-11-04',
      close: '1510.00',
      source: 'tushare',
      as_of: '2026-11-04T15:00:00+08:00',
      staleness_ms: 0,
      asOf: '2026-11-04T15:00:00+08:00',
      stalenessMs: 0,
    } as ResearchRow,
  ],
  total: 1,
  limit: 200,
  offset: 0,
};

class FakeDataPlatformRepo implements DataPlatformRepo {
  listDatasetsCalls = 0;
  queryCalls: Array<{ dataset: string; query: ResearchQuery }> = [];

  async listDatasets(): Promise<readonly DatasetStats[]> {
    this.listDatasetsCalls += 1;
    return FAKE_DATASETS;
  }

  async queryDataset(dataset: string, query: ResearchQuery): Promise<ResearchPage> {
    this.queryCalls.push({ dataset, query });
    return FAKE_PAGE;
  }

  getDatasetMeta(dataset: string): DatasetMeta {
    const meta = DATASETS.find((item) => item.name === dataset);
    if (meta === undefined) {
      throw new Error(`unknown dataset: ${dataset}`);
    }
    return meta;
  }
}

function createApp(repo: FakeDataPlatformRepo) {
  const plugin = createMarketPlugin({
    dataPlatformRepo: repo,
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
    // shell 级 authenticator：/v1/internal/** 要求 Bearer token，其余拒绝。
    authenticator: async (request) => {
      if (!request.url.startsWith('/v1/')) return null;
      const auth = request.headers.authorization;
      if (auth === `Bearer ${TOKEN}`) {
        return { userId: 'ops-1', userType: 'internal_active' as const, tier: 'internal_eval' as const, sessionVersion: 0 };
      }
      return null;
    },
  });
}

describe('data-platform internal routes', () => {
  it('rejects catalog without auth (401)', async () => {
    const repo = new FakeDataPlatformRepo();
    const app = createApp(repo);
    const response = await app.inject({ method: 'GET', url: '/v1/internal/data-platform/catalog' });
    assert.equal(response.statusCode, 401);
  });

  it('returns catalog with datasets (200)', async () => {
    const repo = new FakeDataPlatformRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/internal/data-platform/catalog',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(Array.isArray(body.datasets));
    assert.equal(body.datasets.length, FAKE_DATASETS.length);
    // L169 补完：dc_index + dc_member 东财板块数据集在 catalog 内
    assert.ok(DATASETS.some((d) => d.name === 'dc_index'));
    assert.ok(DATASETS.some((d) => d.name === 'dc_member'));
    assert.equal(DATASETS.length, 14);
    assert.equal(typeof body.as_of, 'string');
    assert.equal(repo.listDatasetsCalls, 1);
  });

  it('returns single dataset meta (200)', async () => {
    const repo = new FakeDataPlatformRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/internal/data-platform/datasets/daily_basic',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.name, 'daily_basic');
    assert.equal(body.domain, 'fundamental');
    assert.equal(body.pointsMin, 2000);
    assert.equal(body.docId, 32);
  });

  it('returns 400 for unknown dataset name', async () => {
    const repo = new FakeDataPlatformRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/internal/data-platform/datasets/not_a_real_dataset',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'VALIDATION_ERROR');
  });

  it('queries dataset rows when authenticated (200)', async () => {
    const repo = new FakeDataPlatformRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/internal/data-platform/datasets/daily_basic/query',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { limit: 50, offset: 0, instrumentId: 'SSE:600519' },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.dataset, 'daily_basic');
    assert.ok(Array.isArray(body.rows));
    assert.equal(body.total, FAKE_PAGE.total);
    assert.equal(body.limit, FAKE_PAGE.limit);
    assert.equal(body.offset, 0);
    assert.equal(repo.queryCalls.length, 1);
    const first = repo.queryCalls[0]!;
    assert.equal(first.dataset, 'daily_basic');
    assert.equal(first.query.limit, 50);
    assert.equal(first.query.instrumentId, 'SSE:600519');
  });

  it('rejects limit > MAX_LIMIT (400)', async () => {
    const repo = new FakeDataPlatformRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/internal/data-platform/datasets/daily_basic/query',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { limit: 5001 },
    });
    assert.equal(response.statusCode, 400);
  });

  it('rejects invalid exchange (400)', async () => {
    const repo = new FakeDataPlatformRepo();
    const app = createApp(repo);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/internal/data-platform/datasets/margin/query',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { exchange: 'HKEX' },
    });
    assert.equal(response.statusCode, 400);
  });
});
