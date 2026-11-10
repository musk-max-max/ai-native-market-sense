/**
 * 数据中台内部路由（Console 专属，不进 C 端契约）：
 *  - GET /internal/data-platform/catalog  数据集 catalog + 行数/最新 as_of 统计
 *  - GET /internal/data-platform/datasets/:dataset  单数据集元数据
 *  - POST /internal/data-platform/datasets/:dataset/query  查询行（分页 + 时间窗 + 过滤）
 *
 * 边界：
 *  - 仅内部使用，挂 /v1/internal/**（与 config/approval internal 路由同定位）；
 *  - 不输出投资结论/评级/目标价/推荐（H3 红线）；
 *  - 数字以字符串透传（precision-safe），由前端 number() 转换；
 *  - realtime_quote 标 source_internal_only（SEC-012 F1 residual，翻档前 C 端不可见）。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DataPlatformRepo, ResearchDataset, ResearchQuery } from './ports/data-platform-repo.js';
import { DATASETS } from './ports/data-platform-repo.js';
import { validationError } from './errors.js';

const DATASET_NAMES: readonly string[] = DATASETS.map((item) => item.name);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 5000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function parseDataset(request: FastifyRequest): ResearchDataset {
  const value = asRecord(request.params).dataset;
  if (typeof value !== 'string' || !DATASET_NAMES.includes(value)) {
    throw validationError();
  }
  return value as ResearchDataset;
}

function optionalCalendarDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw validationError();
  }
  return value;
}

export function registerDataPlatformRoutes(
  app: FastifyInstance,
  deps: { readonly dataPlatform: DataPlatformRepo },
): void {
  // GET /internal/data-platform/catalog
  app.get('/internal/data-platform/catalog', async () => {
    const datasets = await deps.dataPlatform.listDatasets();
    return {
      datasets,
      as_of: new Date().toISOString(),
    };
  });

  // GET /internal/data-platform/datasets/:dataset
  app.get('/internal/data-platform/datasets/:dataset', async (request: FastifyRequest) => {
    const dataset = parseDataset(request);
    return deps.dataPlatform.getDatasetMeta(dataset);
  });

  // POST /internal/data-platform/datasets/:dataset/query
  app.post('/internal/data-platform/datasets/:dataset/query', async (request: FastifyRequest) => {
    const dataset = parseDataset(request);
    const body = asRecord(request.body);
    const query: ResearchQuery = {};

    if (body.limit !== undefined) {
      const limit = Number(body.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw validationError();
      }
      query.limit = limit;
    }
    if (body.offset !== undefined) {
      const offset = Number(body.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        throw validationError();
      }
      query.offset = offset;
    }
    if (body.from !== undefined) {
      const from = optionalCalendarDate(body.from, 'from');
      if (from !== undefined) {
        query.from = from;
      }
    }
    if (body.to !== undefined) {
      const to = optionalCalendarDate(body.to, 'to');
      if (to !== undefined) {
        query.to = to;
      }
    }
    if (body.instrumentId !== undefined) {
      if (typeof body.instrumentId !== 'string' || body.instrumentId.length === 0) {
        throw validationError();
      }
      query.instrumentId = body.instrumentId;
    }
    if (body.exchange !== undefined) {
      if (body.exchange !== 'SSE' && body.exchange !== 'SZSE' && body.exchange !== 'BSE') {
        throw validationError();
      }
      query.exchange = body.exchange;
    }

    const page = await deps.dataPlatform.queryDataset(dataset, query);
    return {
      dataset,
      rows: page.rows,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      as_of: new Date().toISOString(),
    };
  });
}
