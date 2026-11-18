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
  SentimentMarketRow,
  SentimentStockRow,
  SentimentStockSeries,
  SentimentStockSummary,
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

  async getSentimentMarket(windowRows: number): Promise<readonly SentimentMarketRow[]> {
    // 窗口行：trade_date DESC 前 windowRows 个交易日（30d=30）；streak 已在视图内
    // 按全历史算完（窗口截断不影响跨窗口边界的连板延续）
    const { rows } = await this.pool.query<SentimentMarketRow>(
      `SELECT trade_date, limit_up_count, limit_down_count, advancers, decliners,
              adv_dec_ratio, max_limit_streak, moneyflow_net_inflow_total,
              margin_financing_balance
         FROM (
           SELECT v.*, ROW_NUMBER() OVER (ORDER BY v.trade_date DESC) AS rn_desc
             FROM serving.v_cend_theme_sentiment_market v
         ) w
        WHERE w.rn_desc <= $1
        ORDER BY w.trade_date DESC`,
      [windowRows],
    );
    return rows;
  }

  async getSentimentStock(instrumentId: string, windowRows: number): Promise<SentimentStockSeries> {
    // 窗口行：该股 trade_date DESC 前 windowRows 个有数据的交易日
    const { rows } = await this.pool.query<SentimentStockRow>(
      `SELECT instrument_id, trade_date, net_inflow_amount, lhb_net_amount,
              inst_net_buy_amount, financing_balance
         FROM (
           SELECT v.*, ROW_NUMBER() OVER (ORDER BY v.trade_date DESC) AS rn_desc
             FROM serving.v_cend_theme_sentiment_stock v
            WHERE v.instrument_id = $1
         ) w
        WHERE w.rn_desc <= $2
        ORDER BY w.trade_date DESC`,
      [instrumentId, windowRows],
    );
    // 窗口汇总：净流入合计/最新、上榜天数与净额、机构净买合计、融资余额最新与变化
    // （最新 - 最早非空）；空窗口 → 全 null（含 lhb_count，CASE WHEN EXISTS 兜底）
    const { rows: summaryRows } = await this.pool.query<SentimentStockSummary>(
      `WITH w AS (
        SELECT net_inflow_amount, lhb_net_amount, inst_net_buy_amount, financing_balance,
               ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn_desc
          FROM serving.v_cend_theme_sentiment_stock
         WHERE instrument_id = $1
      ),
      win AS (SELECT * FROM w WHERE rn_desc <= $2)
      SELECT
        (SELECT SUM(net_inflow_amount) FROM win) AS net_inflow_sum,
        (SELECT net_inflow_amount FROM win ORDER BY rn_desc LIMIT 1) AS net_inflow_latest,
        CASE WHEN EXISTS (SELECT 1 FROM win)
             THEN (SELECT COUNT(*) FROM win WHERE lhb_net_amount IS NOT NULL)
        END AS lhb_count,
        (SELECT SUM(lhb_net_amount) FROM win WHERE lhb_net_amount IS NOT NULL) AS lhb_net_buy_sum,
        (SELECT SUM(inst_net_buy_amount) FROM win WHERE inst_net_buy_amount IS NOT NULL) AS inst_net_buy_sum,
        (SELECT financing_balance FROM win WHERE financing_balance IS NOT NULL
          ORDER BY rn_desc LIMIT 1) AS financing_balance_latest,
        (SELECT financing_balance FROM win WHERE financing_balance IS NOT NULL
          ORDER BY rn_desc LIMIT 1)
        - (SELECT financing_balance FROM win WHERE financing_balance IS NOT NULL
          ORDER BY rn_desc DESC LIMIT 1) AS financing_balance_change`,
      [instrumentId, windowRows],
    );
    return {
      rows,
      summary:
        summaryRows[0] ??
        ({
          net_inflow_sum: null,
          net_inflow_latest: null,
          lhb_count: null,
          lhb_net_buy_sum: null,
          inst_net_buy_sum: null,
          financing_balance_latest: null,
          financing_balance_change: null,
        } satisfies SentimentStockSummary),
    };
  }
}
