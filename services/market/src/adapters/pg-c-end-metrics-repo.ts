/**
 * PG 实现：C 端展示指标（消费 serving.v_cend_* 视图）。
 *
 * 边界：
 *  - 只 SELECT serving.v_cend_*，禁直接 SELECT DWD 表；
 *  - 数字以字符串透传（pg 默认 numeric → string）；
 *  - 查询失败 fail-closed：throw HttpProblem 由外壳转 5xx。
 */

import type { Pool, PoolClient } from 'pg';

import {
  type CEndMetricsRepo,
  type LimitLadderRow,
  type MarketOverviewRow,
  type StockMetricsRow,
} from '../ports/c-end-metrics-repo.js';

export class PgCEndMetricsRepo implements CEndMetricsRepo {
  constructor(private readonly pool: Pool | PoolClient) {}

  async getStockMetrics(instrumentId: string): Promise<StockMetricsRow | null> {
    const { rows } = await this.pool.query<StockMetricsRow>(
      'SELECT * FROM serving.v_cend_stock_metrics WHERE instrument_id = $1 LIMIT 1',
      [instrumentId],
    );
    return rows[0] ?? null;
  }

  async getMarketOverview(): Promise<readonly MarketOverviewRow[]> {
    const { rows } = await this.pool.query<MarketOverviewRow>(
      'SELECT * FROM serving.v_cend_market_overview ORDER BY metric_key',
    );
    return rows;
  }

  async getLimitLadder(): Promise<readonly LimitLadderRow[]> {
    const { rows } = await this.pool.query<LimitLadderRow>(
      'SELECT * FROM serving.v_cend_limit_ladder ORDER BY limit_pct DESC NULLS LAST, total_market_value DESC NULLS LAST LIMIT 100',
    );
    return rows;
  }
}
