/**
 * DataPlatformRepo 的 PostgreSQL 实现：只 SELECT `serving.serving_research_*` view。
 *
 * 边界（与 pg-serving-repo.ts 一致）：
 *  - 不 SELECT warehouse 的 dwd_* 表；
 *  - 不在适配器里做契约映射（数字字符串 → number 在 HTTP 边界完成）；
 *  - 行数统计用 `SELECT count(*)` 近似（无物化视图，运行时算）。
 *
 * 归属：services/market。用于 Console 数据中台查询，仅内部使用。
 */

import type { Pool } from 'pg';

import {
  DATASETS,
  type DataPlatformRepo,
  type DatasetMeta,
  type DatasetStats,
  type ResearchDataset,
  type ResearchPage,
  type ResearchQuery,
  type ResearchRow,
} from '../ports/data-platform-repo.js';

/** 硬上限：单次查询最多返回 5000 行（防止意外全表扫描）。 */
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 200;

interface DbRow {
  [key: string]: unknown;
}

/** 允许的排序时间字段（按数据集选择）。 */
const TIME_COLUMN: Record<ResearchDataset, string> = {
  daily_basic: 'trade_date',
  index_daily: 'trade_date',
  top_list: 'trade_date',
  top_inst: 'trade_date',
  moneyflow: 'trade_date',
  margin: 'trade_date',
  hk_hold: 'trade_date',
  stk_limit: 'trade_date',
  fina_indicator: 'announced_at',
  index_classify: 'snapshot_date',
  index_member_all: 'snapshot_date',
  realtime_quote: 'as_of',
  dc_index: 'trade_date',
  dc_member: 'trade_date',
};

/** 允许的 instrument 过滤字段（realtime_quote 用 instrument_id；margin 无）。 */
const INSTRUMENT_COLUMN: Partial<Record<ResearchDataset, string>> = {
  daily_basic: 'instrument_id',
  index_daily: 'instrument_id',
  top_list: 'instrument_id',
  top_inst: 'instrument_id',
  moneyflow: 'instrument_id',
  hk_hold: 'instrument_id',
  stk_limit: 'instrument_id',
  fina_indicator: 'instrument_id',
  index_member_all: 'instrument_id',
  realtime_quote: 'instrument_id',
  dc_member: 'instrument_id',
  // margin 用 exchange，index_classify/dc_index 用 board_code —— 不做 instrument 过滤。
};

export class PgDataPlatformRepo implements DataPlatformRepo {
  constructor(private readonly pool: Pool) {}

  getDatasetMeta(dataset: ResearchDataset): DatasetMeta {
    const meta = DATASETS.find((item) => item.name === dataset);
    if (meta === undefined) {
      throw new Error(`unknown dataset: ${dataset}`);
    }
    return meta;
  }

  async listDatasets(): Promise<readonly DatasetStats[]> {
    const stats: DatasetStats[] = [];
    for (const meta of DATASETS) {
      const view = `serving.${meta.viewName}`;
      const timeCol = TIME_COLUMN[meta.name];
      const countSql = `SELECT count(*)::bigint AS row_count, max(${timeCol})::text AS latest_date, max(as_of)::text AS latest_as_of FROM ${view}`;
      try {
        const result = await this.pool.query<DbRow>(countSql);
        const row = result.rows[0] ?? {};
        stats.push({
          ...meta,
          rowCount: Number(row.row_count ?? 0),
          latestDate: (row.latest_date as string | null) ?? null,
          latestAsOf: (row.latest_as_of as string | null) ?? null,
        });
      } catch (err) {
        // 单个 view 不可用（如表未建 / 权限问题）不影响其他数据集。
        console.warn(`[data-platform] listDatasets failed for ${meta.name}: ${String(err)}`);
        stats.push({ ...meta, rowCount: 0, latestDate: null, latestAsOf: null });
      }
    }
    return stats;
  }

  async queryDataset(dataset: ResearchDataset, query: ResearchQuery): Promise<ResearchPage> {
    const meta = this.getDatasetMeta(dataset);
    const view = `serving.${meta.viewName}`;
    const timeCol = TIME_COLUMN[dataset];
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    // WHERE 条件拼装（时间窗 + instrument + exchange）。
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    let paramIdx = 1;

    if (query.from !== undefined) {
      conditions.push(`${timeCol} >= $${paramIdx++}`);
      params.push(query.from);
    }
    if (query.to !== undefined) {
      conditions.push(`${timeCol} <= $${paramIdx++}`);
      params.push(query.to);
    }
    const instrumentCol = INSTRUMENT_COLUMN[dataset];
    if (query.instrumentId !== undefined && instrumentCol !== undefined) {
      conditions.push(`${instrumentCol} = $${paramIdx++}`);
      params.push(query.instrumentId);
    }
    if (query.exchange !== undefined && dataset === 'margin') {
      conditions.push(`exchange = $${paramIdx++}`);
      params.push(query.exchange);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    // count 总数（分页用）。
    const countSql = `SELECT count(*)::bigint AS total FROM ${view}${whereClause}`;
    const countResult = await this.pool.query<DbRow>(countSql, params);
    const total = Number(countResult.rows[0]?.total ?? 0);

    // 查行数据。
    const dataSql =
      `SELECT * FROM ${view}${whereClause} ` +
      `ORDER BY ${timeCol} DESC, 1 ASC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);
    const dataResult = await this.pool.query<DbRow>(dataSql, params);

    // 数字/boolean 原样透传（pg 驱动会把 numeric 转 string，bigint 转 string），TS 侧不映射。
    const rows: ResearchRow[] = dataResult.rows.map((row) => {
      const out: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(row)) {
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          out[key] = value;
        } else if (value instanceof Date) {
          out[key] = value.toISOString();
        } else {
          out[key] = String(value);
        }
      }
      return out as ResearchRow;
    });

    return { rows, total, limit, offset };
  }
}
