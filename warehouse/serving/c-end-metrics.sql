-- C 端展示层视图（金融维度目录 v1.0）
-- 仅数据展示 + 派生计算口径；不输出投资建议/评级/目标价（HANDOFF §1 硬约束 2）。
-- 消费方：services/market（A3）通过 CEndMetricsRepo 读这些 view。
-- 幂等：CREATE SCHEMA IF NOT EXISTS + CREATE OR REPLACE VIEW。

CREATE SCHEMA IF NOT EXISTS serving;

-- ============================================================
-- V1: v_cend_stock_metrics —— 个股全维度（估值/盈利/成长/杠杆/流动性/股东/资金/技术面）
-- 每行 = 一个 instrument 最新可得快照
-- ============================================================
CREATE OR REPLACE VIEW serving.v_cend_stock_metrics AS
WITH latest_daily AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, trade_date, close, volume, amount, prev_close, as_of
    FROM dwd_stock_bar_daily
    ORDER BY instrument_id, trade_date DESC
),
latest_daily_basic AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, trade_date, turnover_rate_pct, free_float_turnover_rate_pct,
           volume_ratio, pe, pe_ttm, pb, ps, ps_ttm, dividend_yield_pct,
           dividend_yield_ttm_pct, total_market_value, circulating_market_value,
           limit_status, as_of
    FROM dwd_daily_basic
    ORDER BY instrument_id, trade_date DESC
),
latest_fina AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, report_end_date, announced_at, grossprofit_margin,
           netprofit_margin, roe, roa, roic, profit_dedt, or_yoy_pct,
           netprofit_yoy_pct, assets_yoy_pct, eqt_yoy_pct, debt_to_assets,
           current_ratio, quick_ratio, q_sales_qoq_pct, as_of
    FROM dwd_fina_indicator
    ORDER BY instrument_id, announced_at DESC NULLS LAST
),
latest_moneyflow AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, trade_date, net_inflow_amount,
           buy_extra_large_amount - sell_extra_large_amount AS xl_net,
           buy_large_amount - sell_large_amount AS l_net,
           buy_medium_amount - sell_medium_amount AS m_net,
           buy_small_amount - sell_small_amount AS s_net,
           as_of
    FROM dwd_moneyflow
    ORDER BY instrument_id, trade_date DESC
),
latest_lhb AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, trade_date, lhb_net_amount, as_of
    FROM dwd_top_list
    ORDER BY instrument_id, trade_date DESC
),
latest_hk_hold AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, trade_date, holding_ratio_pct, as_of
    FROM dwd_hk_hold
    ORDER BY instrument_id, trade_date DESC
),
latest_pledge AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, total_shares_pledged, as_of
    FROM dwd_research_pledge_stat
    ORDER BY instrument_id, ingested_at DESC
),
latest_holder AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, holder_number, avg_market_value, as_of
    FROM dwd_research_stk_holdernumber
    ORDER BY instrument_id, ingested_at DESC
),
daily_5d AS (
    SELECT instrument_id,
           MAX(CASE WHEN rn = 6 THEN close END) AS close_5d_ago
    FROM (
        SELECT instrument_id, close,
               ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY trade_date DESC) AS rn
        FROM dwd_stock_bar_daily
    ) x
    WHERE rn <= 6
    GROUP BY instrument_id
),
daily_20d AS (
    SELECT instrument_id,
           MAX(CASE WHEN rn = 21 THEN close END) AS close_20d_ago,
           AVG(CASE WHEN rn <= 20 THEN close END) AS ma20,
           AVG(CASE WHEN rn <= 5 THEN amount END) AS amount_5d_avg
    FROM (
        SELECT instrument_id, close, amount,
               ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY trade_date DESC) AS rn
        FROM dwd_stock_bar_daily
    ) x
    WHERE rn <= 21
    GROUP BY instrument_id
),
daily_60d AS (
    SELECT instrument_id,
           MAX(CASE WHEN rn = 61 THEN close END) AS close_60d_ago
    FROM (
        SELECT instrument_id, close,
               ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY trade_date DESC) AS rn
        FROM dwd_stock_bar_daily
    ) x
    WHERE rn <= 61
    GROUP BY instrument_id
)
SELECT
    d.instrument_id,
    i.name AS instrument_name,
    i.exchange,
    d.trade_date AS quote_trade_date,
    d.close,
    d.volume,
    d.amount,
    d.prev_close,
    CASE WHEN d.prev_close > 0 THEN (d.close - d.prev_close) / d.prev_close * 100 END AS pct_change_pct,
    db.turnover_rate_pct,
    db.free_float_turnover_rate_pct,
    db.volume_ratio,
    db.pe, db.pe_ttm, db.pb, db.ps_ttm,
    db.dividend_yield_ttm_pct,
    db.total_market_value,
    db.circulating_market_value,
    db.limit_status,
    -- 技术面派生
    CASE WHEN d5.close_5d_ago > 0 THEN (d.close - d5.close_5d_ago) / d5.close_5d_ago * 100 END AS close_5d_pct,
    CASE WHEN d20.close_20d_ago > 0 THEN (d.close - d20.close_20d_ago) / d20.close_20d_ago * 100 END AS close_20d_pct,
    CASE WHEN d60.close_60d_ago > 0 THEN (d.close - d60.close_60d_ago) / d60.close_60d_ago * 100 END AS close_60d_pct,
    d20.ma20,
    d20.amount_5d_avg,
    -- 盈利 / 成长 / 杠杆
    f.grossprofit_margin, f.netprofit_margin, f.roe, f.roa, f.roic, f.profit_dedt,
    f.or_yoy_pct, f.netprofit_yoy_pct, f.assets_yoy_pct, f.eqt_yoy_pct,
    f.debt_to_assets, f.current_ratio, f.quick_ratio, f.q_sales_qoq_pct,
    f.report_end_date AS fina_report_end_date,
    -- 资金
    mf.net_inflow_amount, mf.xl_net, mf.l_net, mf.m_net, mf.s_net,
    lhb.lhb_net_amount,
    -- 股东
    hk.holding_ratio_pct,
    h.holder_number,
    h.avg_market_value,
    -- 质押比例 = pledged / total_shares
    CASE WHEN p.total_shares_pledged IS NOT NULL AND db.total_market_value IS NOT NULL
         THEN p.total_shares_pledged END AS pledged_shares,
    -- 振幅（用 high/low 未取，先省略，后续接 dwd_stock_bar_daily 全表补）
    -- as_of
    GREATEST(
        d.as_of,
        COALESCE(db.as_of, d.as_of),
        COALESCE(f.as_of, d.as_of),
        COALESCE(mf.as_of, d.as_of)
    ) AS as_of,
    GREATEST(0, EXTRACT(EPOCH FROM (now() - GREATEST(
        d.as_of,
        COALESCE(db.as_of, d.as_of),
        COALESCE(f.as_of, d.as_of)
    ))) * 1000)::bigint AS staleness_ms
FROM latest_daily d
LEFT JOIN dim_instrument i USING (instrument_id)
LEFT JOIN latest_daily_basic db USING (instrument_id)
LEFT JOIN latest_fina f USING (instrument_id)
LEFT JOIN latest_moneyflow mf USING (instrument_id)
LEFT JOIN latest_lhb lhb USING (instrument_id)
LEFT JOIN latest_hk_hold hk USING (instrument_id)
LEFT JOIN latest_holder h USING (instrument_id)
LEFT JOIN latest_pledge p USING (instrument_id)
LEFT JOIN daily_5d d5 USING (instrument_id)
LEFT JOIN daily_20d d20 USING (instrument_id)
LEFT JOIN daily_60d d60 USING (instrument_id);

COMMENT ON VIEW serving.v_cend_stock_metrics IS
  'C 端个股全维度（估值/盈利/成长/杠杆/流动性/股东/资金/技术面），每行 = 一个 instrument 最新快照';

-- ============================================================
-- V2: v_cend_market_overview —— 首页 5 tab 聚合（全市场）
-- 每行 = 单指标快照，列名 metric_key，值字符串 precision-safe
-- ============================================================
CREATE OR REPLACE VIEW serving.v_cend_market_overview AS
SELECT 'quote.last_close_avg'::text AS metric_key,
       (SELECT AVG(close) FROM dwd_stock_bar_daily WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_stock_bar_daily))::text AS value_text,
       '元'::text AS unit,
       'daily'::text AS dataset,
       '直取'::text AS derivation
UNION ALL
SELECT 'quote.limit_up_count',
       (SELECT count(*) FROM dwd_stk_limit WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_stk_limit) AND limit_pct > 0)::text,
       '家', 'stk_limit', '派生'
UNION ALL
SELECT 'quote.limit_down_count',
       (SELECT count(*) FROM dwd_stk_limit WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_stk_limit) AND limit_pct < 0)::text,
       '家', 'stk_limit', '派生'
UNION ALL
SELECT 'flow.net_inflow_total',
       (SELECT SUM(net_inflow_amount) FROM dwd_moneyflow WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_moneyflow))::text,
       '元', 'moneyflow', '直取'
UNION ALL
SELECT 'flow.margin_financing_balance',
       (SELECT SUM(financing_balance) FROM dwd_margin WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_margin))::text,
       '元', 'margin', '直取'
UNION ALL
SELECT 'flow.lhb_net_total',
       (SELECT SUM(lhb_net_amount) FROM dwd_top_list WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_top_list))::text,
       '元', 'top_list', '直取'
UNION ALL
SELECT 'fundamental.pe_ttm_median',
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pe_ttm) FROM dwd_daily_basic WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_daily_basic) AND pe_ttm > 0)::text,
       '倍', 'daily_basic', '派生'
UNION ALL
SELECT 'fundamental.pb_median',
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pb) FROM dwd_daily_basic WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_daily_basic) AND pb > 0)::text,
       '倍', 'daily_basic', '派生'
UNION ALL
SELECT 'fundamental.dividend_yield_ttm_avg',
       (SELECT AVG(dividend_yield_ttm_pct) FROM dwd_daily_basic WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_daily_basic))::text,
       '%', 'daily_basic', '派生'
UNION ALL
SELECT 'fundamental.total_mv_sum',
       (SELECT SUM(total_market_value) FROM dwd_daily_basic WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_daily_basic))::text,
       '元', 'daily_basic', '派生'
UNION ALL
SELECT 'sector.board_up_count',
       (SELECT count(*) FROM dwd_dc_index WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_dc_index) AND pct_change > 0)::text,
       '家', 'dc_index', '派生'
UNION ALL
SELECT 'sector.board_down_count',
       (SELECT count(*) FROM dwd_dc_index WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_dc_index) AND pct_change < 0)::text,
       '家', 'dc_index', '派生'
UNION ALL
SELECT 'sector.board_turnover_avg',
       (SELECT AVG(turnover_rate) FROM dwd_dc_index WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_dc_index))::text,
       '%', 'dc_index', '派生'
UNION ALL
SELECT 'index.shcomp_pct_change',
       (SELECT pct_change_pct FROM dwd_index_daily WHERE instrument_id = 'SSE:000001' ORDER BY trade_date DESC LIMIT 1)::text,
       '%', 'index_daily', '直取'
UNION ALL
SELECT 'index.szcomp_pct_change',
       (SELECT pct_change_pct FROM dwd_index_daily WHERE instrument_id = 'SZSE:399001' ORDER BY trade_date DESC LIMIT 1)::text,
       '%', 'index_daily', '直取'
UNION ALL
SELECT 'index.chinext_pct_change',
       (SELECT pct_change_pct FROM dwd_index_daily WHERE instrument_id = 'SZSE:399006' ORDER BY trade_date DESC LIMIT 1)::text,
       '%', 'index_daily', '直取'
UNION ALL
SELECT 'research.fund_nav_count',
       (SELECT count(DISTINCT fund_code) FROM dwd_research_fund_nav)::text,
       '只', 'fund_nav', '派生'
UNION ALL
SELECT 'research.fut_settle_latest',
       (SELECT settlement_price FROM dwd_research_fut_settle ORDER BY ingested_at DESC LIMIT 1)::text,
       '元', 'fut_settle', '直取'
UNION ALL
SELECT 'research.hk_hold_total_ratio',
       (SELECT SUM(holding_ratio_pct) FROM dwd_hk_hold WHERE trade_date = (SELECT MAX(trade_date) FROM dwd_hk_hold))::text,
       '%', 'hk_hold', '派生';

COMMENT ON VIEW serving.v_cend_market_overview IS
  '首页多维度聚合（quote/flow/fundamental/sector/index/research 6 类指标，每行 = 一条 metric_key）';

-- ============================================================
-- V3: v_cend_limit_ladder —— 涨跌停梯队
-- 每行 = 一个涨跌停股的当日快照（含板块归属）
-- ============================================================
CREATE OR REPLACE VIEW serving.v_cend_limit_ladder AS
WITH latest_limit AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, trade_date, previous_close, up_limit, down_limit,
           limit_pct, asset_type, exchange, as_of
    FROM dwd_stk_limit
    ORDER BY instrument_id, trade_date DESC
),
today_basic AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, trade_date, close, turnover_rate_pct, pe_ttm,
           total_market_value, limit_status, as_of
    FROM dwd_daily_basic
    ORDER BY instrument_id, trade_date DESC
),
today_mf AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, trade_date, net_inflow_amount, as_of
    FROM dwd_moneyflow
    ORDER BY instrument_id, trade_date DESC
),
sector_of AS (
    SELECT DISTINCT ON (instrument_id)
           instrument_id, l1_name, l2_name, as_of
    FROM dwd_index_member_all
    WHERE out_date IS NULL
    ORDER BY instrument_id, snapshot_date DESC
)
SELECT
    l.instrument_id,
    i.name AS instrument_name,
    l.trade_date,
    l.up_limit,
    l.down_limit,
    l.limit_pct,
    l.exchange,
    b.close,
    b.turnover_rate_pct,
    b.pe_ttm,
    b.total_market_value,
    b.limit_status,
    CASE WHEN b.limit_status IN ('U','D') AND b.total_market_value > 0
         THEN b.close / b.total_market_value * 1e8 END AS seal_ratio_pct_hint,
    mf.net_inflow_amount,
    s.l1_name,
    s.l2_name,
    GREATEST(l.as_of, COALESCE(b.as_of, l.as_of)) AS as_of,
    GREATEST(0, EXTRACT(EPOCH FROM (now() - GREATEST(l.as_of, COALESCE(b.as_of, l.as_of)))) * 1000)::bigint AS staleness_ms
FROM latest_limit l
LEFT JOIN dim_instrument i USING (instrument_id)
LEFT JOIN today_basic b USING (instrument_id)
LEFT JOIN today_mf mf USING (instrument_id)
LEFT JOIN sector_of s USING (instrument_id)
WHERE l.limit_pct IS NOT NULL
  AND b.limit_status IN ('U','D','Z')
  AND b.trade_date = l.trade_date;

COMMENT ON VIEW serving.v_cend_limit_ladder IS
  '涨跌停梯队（每行 = 一只当前涨跌停股，含板块归属 + 主力资金）';

-- ============================================================
-- V4: v_cend_portfolio_metrics —— 自选组合复盘（占位：等 watchlist API）
-- 设计：消费方 join watchlist.instrument_id 与 v_cend_stock_metrics
-- 本视图先导出 instrument_id -> watchlist_metrics 一行；实际组合 = join watchlist 表
-- ============================================================
CREATE OR REPLACE VIEW serving.v_cend_portfolio_metrics AS
SELECT * FROM serving.v_cend_stock_metrics;

COMMENT ON VIEW serving.v_cend_portfolio_metrics IS
  '组合复盘基础（= v_cend_stock_metrics 的别名，消费方 join watchlist.instrument_id 后聚合）';
