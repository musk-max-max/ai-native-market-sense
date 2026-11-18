/**
 * PG 实现：P1a 主题视图（M1a，A3 2026-11-18）。
 *
 * 边界（与 PgCEndMetricsRepo 同约定）：
 *  - 只 SELECT serving.v_cend_theme_*，禁直接 SELECT DWD 表；
 *  - 数字以字符串透传（pg 默认 numeric → string），行序由 ORDER BY 保证；
 *  - 查询失败 fail-closed：错误原样上抛，由外壳转 5xx（不吞错、不以空数组冒充成功）。
 */

import type { Pool, PoolClient } from 'pg';

import type {
  CEndThemeRepo,
  ThemeFinHealthRow,
  ValuationPriceRow,
  ValuationPriceSeries,
} from '../ports/c-end-theme-repo.js';

export class PgCEndThemeRepo implements CEndThemeRepo {
  constructor(private readonly pool: Pool | PoolClient) {}

  async getFinHealth(instrumentId: string): Promise<readonly ThemeFinHealthRow[]> {
    const { rows } = await this.pool.query<ThemeFinHealthRow>(
      'SELECT * FROM serving.v_cend_theme_fin_health WHERE instrument_id = $1 ORDER BY as_of DESC, period DESC',
      [instrumentId],
    );
    return rows;
  }

  async getValuationPrice(instrumentId: string, windowRows: number): Promise<ValuationPriceSeries> {
    // 窗口行：trade_date DESC 前 windowRows 个交易日（1y=250、3y=750，路由按 range 传入）
    const { rows } = await this.pool.query<ValuationPriceRow>(
      `SELECT instrument_id, trade_date, pe_ttm, pb, close, turnover_rate_pct
         FROM (
           SELECT v.*, ROW_NUMBER() OVER (ORDER BY v.trade_date DESC) AS rn_desc
             FROM serving.v_cend_theme_valuation_price v
            WHERE v.instrument_id = $1
         ) w
        WHERE w.rn_desc <= $2
        ORDER BY w.trade_date DESC`,
      [instrumentId, windowRows],
    );
    // 同窗口分位：窗口内 ≤ 最新值占比 ×100（ROUND 1 位）；样本 <2 或最新值缺失 → null
    const { rows: percentileRows } = await this.pool.query<{
      pe_ttm: string | null;
      pb: string | null;
      close: string | null;
      turnover_rate_pct: string | null;
    }>(
      `WITH w AS (
        SELECT pe_ttm, pb, close, turnover_rate_pct,
               ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn_desc
          FROM serving.v_cend_theme_valuation_price
         WHERE instrument_id = $1
      ),
      win AS (SELECT * FROM w WHERE rn_desc <= $2),
      latest AS (SELECT * FROM win WHERE rn_desc = 1)
      SELECT
        CASE WHEN latest.pe_ttm IS NULL
                  OR COUNT(*) FILTER (WHERE w.pe_ttm IS NOT NULL) < 2 THEN NULL
             ELSE ROUND(
                    COUNT(*) FILTER (WHERE w.pe_ttm IS NOT NULL AND w.pe_ttm <= latest.pe_ttm)::numeric * 100
                    / COUNT(*) FILTER (WHERE w.pe_ttm IS NOT NULL), 1)
        END AS pe_ttm,
        CASE WHEN latest.pb IS NULL
                  OR COUNT(*) FILTER (WHERE w.pb IS NOT NULL) < 2 THEN NULL
             ELSE ROUND(
                    COUNT(*) FILTER (WHERE w.pb IS NOT NULL AND w.pb <= latest.pb)::numeric * 100
                    / COUNT(*) FILTER (WHERE w.pb IS NOT NULL), 1)
        END AS pb,
        CASE WHEN latest.close IS NULL
                  OR COUNT(*) FILTER (WHERE w.close IS NOT NULL) < 2 THEN NULL
             ELSE ROUND(
                    COUNT(*) FILTER (WHERE w.close IS NOT NULL AND w.close <= latest.close)::numeric * 100
                    / COUNT(*) FILTER (WHERE w.close IS NOT NULL), 1)
        END AS close,
        CASE WHEN latest.turnover_rate_pct IS NULL
                  OR COUNT(*) FILTER (WHERE w.turnover_rate_pct IS NOT NULL) < 2 THEN NULL
             ELSE ROUND(
                    COUNT(*) FILTER (WHERE w.turnover_rate_pct IS NOT NULL AND w.turnover_rate_pct <= latest.turnover_rate_pct)::numeric * 100
                    / COUNT(*) FILTER (WHERE w.turnover_rate_pct IS NOT NULL), 1)
        END AS turnover_rate_pct
      FROM latest CROSS JOIN win w
      GROUP BY latest.rn_desc, latest.pe_ttm, latest.pb, latest.close, latest.turnover_rate_pct`,
      [instrumentId, windowRows],
    );
    return {
      rows,
      percentiles:
        percentileRows[0] ?? { pe_ttm: null, pb: null, close: null, turnover_rate_pct: null },
    };
  }
}
