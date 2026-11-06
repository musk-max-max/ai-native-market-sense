-- Serving 只读视图（A2 写域 warehouse/）· PostgreSQL 16
-- 职责：只做「宽表化 + 口径固化」，不做聚合计算；口径以 docs/metrics/P0-metrics.md 为准。
-- 消费方：services/market（A3）通过 ServingRepo 端口读这些 view，禁止直接 SELECT DWD 表。
-- 幂等：CREATE SCHEMA IF NOT EXISTS + CREATE OR REPLACE VIEW，可在启动时重复执行。
-- 执行顺序：warehouse/dwd/schema.sql → 本文件（A13 在 compose bootstrap / migration 中执行）。

CREATE SCHEMA IF NOT EXISTS serving;

-- --------------------------------------------------------------------------
-- 1. 证券维表（契约 Instrument 字段；价格域/基本面域共用）
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW serving.serving_instrument AS
SELECT i.instrument_id,
       i.exchange,
       i.code,
       i.name,
       i.board,
       i.security_type,
       i.list_status,
       i.lot_size,
       i.listed_at,
       i.display_safe,
       i.source,
       i.as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - i.as_of)) * 1000)::bigint AS staleness_ms
FROM dim_instrument AS i;

-- --------------------------------------------------------------------------
-- 2. 最新行情快照（Quote 契约：停牌时价格/涨跌幅为 NULL，禁止 0 冒充）
--    * 活跃标的：最近一根 bar。
--    * 停牌标的：最近一条停牌证据行（trade_date=停牌日，OHLC 全 NULL，suspended=true）。
--    * limit_status 口径 = warehouse/metrics/m04_limit_status.sql（docs/metrics/P0-metrics.md
--      同步件；H4 2026-11-05 签发时点规则）：主板 ST 2026-07-06 起 10%、S 股 5%、首日/注册制
--      新股前 5 交易日 NULL、历史 regime 时点档、未知板块 fail-closed。下方 base/priced 的
--      limit_pct/limit_up_price/limit_down_price/limit_status 四段 CASE 与 M04 逐字同步，
--      由 warehouse/tests/test_serving_limit_sync.py 门禁（静态逐字 + PG 行为矩阵）。
--    * L135.6（L0 临时裁决，待 H4 追认）：limit_status NULL=「规则不适用/未知」（新股前 5/未知
--      板块/停牌日/缺价日），展示层按「—/未知」不表态呈现，禁止渲染为「非涨停」。
--    * 证据日取 GREATEST(最近 bar 日, 最近停牌日)，保证停牌覆盖旧 bar。
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW serving.serving_quote_latest AS
WITH last_bar AS (
    SELECT DISTINCT ON (b.instrument_id)
           b.instrument_id, b.trade_date, b.open, b.high, b.low, b.close, b.prev_close,
           b.volume, b.amount, b.source, b.as_of
    FROM dwd_stock_bar_daily AS b
    ORDER BY b.instrument_id, b.trade_date DESC
),
last_susp AS (
    SELECT DISTINCT ON (s.instrument_id)
           s.instrument_id, s.trade_date, s.source, s.as_of
    FROM dwd_suspended_daily AS s
    ORDER BY s.instrument_id, s.trade_date DESC
),
joined AS (
    SELECT i.instrument_id,
           i.board,
           i.name,
           i.exchange,
           i.code,
           i.security_type,
           i.list_status,
           GREATEST(b.trade_date, s.trade_date) AS trade_date,
           (s.trade_date IS NOT NULL AND (b.trade_date IS NULL OR s.trade_date > b.trade_date)) AS suspended,
           b.open, b.high, b.low, b.close, b.prev_close, b.volume, b.amount,
           CASE WHEN s.trade_date IS NOT NULL AND (b.trade_date IS NULL OR s.trade_date > b.trade_date)
                THEN s.source ELSE b.source END AS source,
           CASE WHEN s.trade_date IS NOT NULL AND (b.trade_date IS NULL OR s.trade_date > b.trade_date)
                THEN s.as_of ELSE b.as_of END AS as_of
    FROM dim_instrument AS i
    LEFT JOIN last_bar AS b ON b.instrument_id = i.instrument_id
    LEFT JOIN last_susp AS s ON s.instrument_id = i.instrument_id
),
seq AS (
    -- M04 trade_seq：全历史上按 instrument_id 的 bar 排行号（缺 bar 交易日按已有 bar 近似）
    SELECT instrument_id,
           trade_date AS seq_date,
           ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY trade_date) AS trade_seq
    FROM dwd_stock_bar_daily
),
base AS (
    SELECT j.*,
           s.trade_seq,
           CASE
               WHEN board IS NULL THEN NULL
               WHEN listed_at IS NULL THEN NULL
               WHEN trade_date = listed_at THEN NULL
               WHEN trade_seq <= 5 AND (
                        (board = 'star' AND listed_at >= DATE '2019-07-22')
                     OR (board = 'gem'  AND listed_at >= DATE '2020-08-24')
                     OR (board = 'main' AND listed_at >= DATE '2023-04-10')
               ) THEN NULL
               WHEN board = 'main' AND name LIKE 'S%' AND name NOT LIKE 'ST%' THEN 5.0
               WHEN board = 'main' AND (name LIKE 'ST%' OR name LIKE '*ST%') THEN
                   CASE WHEN trade_date < DATE '2026-07-06' THEN 5.0 ELSE 10.0 END
               WHEN board = 'main' THEN 10.0
               WHEN board = 'gem' THEN
                   CASE WHEN trade_date < DATE '2020-08-24' THEN 10.0 ELSE 20.0 END
               WHEN board = 'star' THEN
                   CASE WHEN trade_date < DATE '2019-07-22' THEN NULL ELSE 20.0 END
               WHEN board = 'bse' THEN
                   CASE WHEN trade_date < DATE '2021-11-15' THEN NULL ELSE 30.0 END
               ELSE NULL
           END AS limit_pct
    FROM joined AS j
    LEFT JOIN seq AS s ON s.instrument_id = j.instrument_id AND s.seq_date = j.trade_date
),
priced AS (
    SELECT base.*,
           CASE
               WHEN limit_pct IS NULL THEN NULL
               WHEN board = 'bse' AND (code LIKE '43%' OR code LIKE '83%' OR code LIKE '87%'
                                       OR code LIKE '88%' OR code LIKE '92%')
                   THEN FLOOR(prev_close * (1 + limit_pct / 100.0) * 100) / 100
               WHEN exchange = 'SSE' AND code LIKE '900%'
                   THEN ROUND(prev_close * (1 + limit_pct / 100.0), 3)
               ELSE ROUND(prev_close * (1 + limit_pct / 100.0), 2)
           END AS limit_up_price,
           CASE
               WHEN limit_pct IS NULL THEN NULL
               WHEN board = 'bse' AND (code LIKE '43%' OR code LIKE '83%' OR code LIKE '87%'
                                       OR code LIKE '88%' OR code LIKE '92%')
                   THEN CEIL(prev_close * (1 - limit_pct / 100.0) * 100) / 100
               WHEN exchange = 'SSE' AND code LIKE '900%'
                   THEN ROUND(prev_close * (1 - limit_pct / 100.0), 3)
               ELSE ROUND(prev_close * (1 - limit_pct / 100.0), 2)
           END AS limit_down_price
    FROM base
)
SELECT p.instrument_id,
       p.trade_date,
       CASE WHEN p.suspended THEN NULL ELSE p.open END AS open,
       CASE WHEN p.suspended THEN NULL ELSE p.high END AS high,
       CASE WHEN p.suspended THEN NULL ELSE p.low END AS low,
       CASE WHEN p.suspended THEN NULL ELSE p.close END AS close,
       CASE WHEN p.suspended THEN NULL ELSE p.prev_close END AS prev_close,
       CASE WHEN p.suspended OR p.prev_close IS NULL THEN NULL
            ELSE ROUND(p.close - p.prev_close, 2) END AS change,
       CASE WHEN p.suspended OR p.prev_close IS NULL OR p.prev_close = 0 THEN NULL
            ELSE ROUND((p.close / p.prev_close - 1) * 100, 4) END AS change_pct,
       CASE WHEN p.suspended THEN NULL ELSE p.volume END AS volume,
       CASE WHEN p.suspended THEN NULL ELSE p.amount END AS amount,
       COALESCE(p.suspended, false) AS suspended,
       CASE
           WHEN p.suspended OR p.close IS NULL OR p.prev_close IS NULL THEN NULL
           ELSE CASE
               WHEN limit_pct IS NULL THEN NULL
               WHEN close >= limit_up_price THEN 'limit_up'
               WHEN close <= limit_down_price THEN 'limit_down'
               ELSE 'none'
           END
       END AS limit_status,
       p.source,
       p.as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - p.as_of)) * 1000)::bigint AS staleness_ms
FROM priced AS p;

-- --------------------------------------------------------------------------
-- 3. 日线（三口径固化：none=不复权 M01、hfq=后复权 M02、qfq=前复权仅画图）
--    * 同一 view 内 UNION ALL 三种 adj_type；调用方按 adj_type 过滤，不自己算价格。
--    * volume/amount 不随复权变化；内部量化 4 位小数（与 adjust.py 一致）。
--    * qfq 基准 = 该标的全部历史最新因子（不是区间内），与 adjust.py 一致。
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW serving.serving_bar_daily AS
WITH latest_factor AS (
    SELECT t.instrument_id, t.factor AS latest_factor, t.as_of AS factor_as_of
    FROM (
        SELECT f.instrument_id, f.factor, f.as_of,
               ROW_NUMBER() OVER (PARTITION BY f.instrument_id ORDER BY f.trade_date DESC) AS rn
        FROM dwd_adj_factor AS f
    ) AS t
    WHERE t.rn = 1
)
SELECT b.instrument_id,
       b.trade_date,
       'none'::text AS adj_type,
       b.open, b.high, b.low, b.close,
       b.volume, b.amount,
       f.factor,
       b.source, b.as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - b.as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_stock_bar_daily AS b
LEFT JOIN dwd_adj_factor AS f
       ON f.instrument_id = b.instrument_id AND f.trade_date = b.trade_date
UNION ALL
SELECT b.instrument_id,
       b.trade_date,
       'hfq'::text AS adj_type,
       ROUND(b.open * f.factor, 4),
       ROUND(b.high * f.factor, 4),
       ROUND(b.low * f.factor, 4),
       ROUND(b.close * f.factor, 4),
       b.volume, b.amount,
       f.factor,
       b.source,
       GREATEST(b.as_of, f.as_of),
       GREATEST(0, EXTRACT(EPOCH FROM (now() - GREATEST(b.as_of, f.as_of))) * 1000)::bigint
FROM dwd_stock_bar_daily AS b
JOIN dwd_adj_factor AS f
  ON f.instrument_id = b.instrument_id AND f.trade_date = b.trade_date
UNION ALL
SELECT b.instrument_id,
       b.trade_date,
       'qfq'::text AS adj_type,
       ROUND(b.open * f.factor / l.latest_factor, 4),
       ROUND(b.high * f.factor / l.latest_factor, 4),
       ROUND(b.low * f.factor / l.latest_factor, 4),
       ROUND(b.close * f.factor / l.latest_factor, 4),
       b.volume, b.amount,
       f.factor,
       b.source,
       GREATEST(b.as_of, f.as_of, l.factor_as_of),
       GREATEST(0, EXTRACT(EPOCH FROM (now() - GREATEST(b.as_of, f.as_of, l.factor_as_of))) * 1000)::bigint
FROM dwd_stock_bar_daily AS b
JOIN dwd_adj_factor AS f
  ON f.instrument_id = b.instrument_id AND f.trade_date = b.trade_date
JOIN latest_factor AS l
  ON l.instrument_id = b.instrument_id;

-- --------------------------------------------------------------------------
-- 4. 最新复权因子（qfq 的分母；口径=该标的全部历史最新一条 factor）
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW serving.serving_factor_latest AS
SELECT t.instrument_id, t.trade_date, t.factor, t.source, t.as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - t.as_of)) * 1000)::bigint AS staleness_ms
FROM (
    SELECT f.instrument_id, f.trade_date, f.factor, f.source, f.as_of,
           ROW_NUMBER() OVER (PARTITION BY f.instrument_id ORDER BY f.trade_date DESC) AS rn
    FROM dwd_adj_factor AS f
) AS t
WHERE t.rn = 1;

-- --------------------------------------------------------------------------
-- 5. 基本面摘要（M06：reported/restated 两套并存，取 announced_at 最近一期）
--    * P0 无财务数据：view 返回 0 行，A3 按契约返回 404（禁止空对象/全 0）。
--    * 数据接入后（A1 fundamental 端口 → dwd_fundamental_report）本 view 自动生效。
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW serving.serving_fundamental_summary AS
SELECT t.instrument_id,
       t.report_period,
       t.report_end_date,
       t.announced_at,
       t.statement_basis,
       t.currency,
       t.revenue,
       t.net_profit,
       t.revenue_yoy_pct,
       t.net_profit_yoy_pct,
       t.eps,
       t.roe_pct,
       t.gross_margin_pct,
       t.source,
       t.as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - t.as_of)) * 1000)::bigint AS staleness_ms
FROM (
    SELECT r.*,
           ROW_NUMBER() OVER (
               PARTITION BY r.instrument_id
               ORDER BY r.announced_at DESC, r.statement_basis DESC
           ) AS rn
    FROM dwd_fundamental_report AS r
) AS t
WHERE t.rn = 1;

-- --------------------------------------------------------------------------
-- 6–12. 研究数据集只读视图（KD-INGEST-CONSUME / ADR-007 第 2 批）
--    * 仅供内部 /v1/internal/* 与研究消费；**不接 C 端契约**（C 端仍 internal_eval 403）。
--    * 字段名保持 A1 canonical（provisional=True，待 H4 对齐），不做重命名。
--    * top_inst 数据缺失时 view 返回 0 行，不报错（5000 分档可能不可用）。
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW serving.serving_research_daily_basic AS
SELECT instrument_id, trade_date, close,
       turnover_rate_pct, free_float_turnover_rate_pct, volume_ratio,
       pe, pe_ttm, pb, ps, ps_ttm,
       dividend_yield_pct, dividend_yield_ttm_pct,
       total_shares, float_shares, free_float_shares,
       total_market_value, circulating_market_value,
       limit_status, source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_daily_basic;

CREATE OR REPLACE VIEW serving.serving_research_index_daily AS
SELECT instrument_id, trade_date, open, high, low, close, prev_close,
       change, pct_change_pct, volume, amount, source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_index_daily;

CREATE OR REPLACE VIEW serving.serving_research_top_list AS
SELECT instrument_id, trade_date, name, close, pct_change_pct, turnover_rate_pct,
       amount, lhb_sell_amount, lhb_buy_amount, lhb_amount, lhb_net_amount,
       lhb_net_rate_pct, lhb_amount_rate_pct, float_market_value,
       reason, source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_top_list;

CREATE OR REPLACE VIEW serving.serving_research_top_inst AS
SELECT instrument_id, trade_date, seat_name, side,
       buy_amount, buy_rate_pct, sell_amount, sell_rate_pct, net_buy_amount,
       reason, source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_top_inst;

CREATE OR REPLACE VIEW serving.serving_research_moneyflow AS
SELECT instrument_id, trade_date,
       buy_small_volume, buy_small_amount, sell_small_volume, sell_small_amount,
       buy_medium_volume, buy_medium_amount, sell_medium_volume, sell_medium_amount,
       buy_large_volume, buy_large_amount, sell_large_volume, sell_large_amount,
       buy_extra_large_volume, buy_extra_large_amount, sell_extra_large_volume, sell_extra_large_amount,
       net_inflow_volume, net_inflow_amount, source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_moneyflow;

CREATE OR REPLACE VIEW serving.serving_research_margin AS
SELECT exchange, trade_date,
       financing_balance, financing_buy_amount, financing_repayment_amount,
       securities_balance, securities_sell_volume, margin_balance, securities_volume,
       source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_margin;

CREATE OR REPLACE VIEW serving.serving_research_hk_hold AS
SELECT instrument_id, trade_date, name, holding_volume, holding_ratio_pct,
       northbound_channel, source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_hk_hold;

-- ==========================================================================
-- 7.8–7.11 研究数据集 P2（KD-DSW-P2 / A1 commit 9ebdb73），internal-only：
-- 只读视图供内部 /v1/internal/* 查询，不进 ports.yaml、不接 C 端契约。
-- ==========================================================================

CREATE OR REPLACE VIEW serving.serving_research_stk_limit AS
SELECT instrument_id, trade_date,
       previous_close, up_limit, down_limit, limit_pct, limit_pct_source, asset_type, exchange,
       source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_stk_limit;

-- 可见时点 = announced_at（H4：as-of join 必须按 announced_at，禁止按 report_end_date，防未来函数）。
-- 示例：WHERE announced_at <= :as_of ORDER BY announced_at DESC LIMIT 1
CREATE OR REPLACE VIEW serving.serving_research_fina_indicator AS
SELECT instrument_id, report_period, report_end_date, announced_at, revision_flag,
       ar_turn, assets_turn, assets_yoy_pct, bps, bps_yoy_pct, current_ratio,
       debt_to_assets, dt_eps, dt_netprofit_yoy_pct, ebit, ebitda, eps,
       eqt_yoy_pct, extra_item, fixed_assets, grossprofit_margin, inv_turn,
       netprofit_margin, netprofit_yoy_pct, npta, ocfps, op_yoy_pct, or_yoy_pct,
       profit_dedt, q_eps, q_gsprofit_margin, q_netprofit_margin, q_op_qoq_pct,
       q_profit_qoq_pct, q_roe, q_sales_qoq_pct, q_sales_yoy_pct, quick_ratio,
       revenue_ps, roa, roe, roe_dt, roe_waa, roe_yoy_pct, roic,
       total_revenue_ps, tr_yoy_pct,
       source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_fina_indicator;

-- append-only 快照：多日 snapshot_date 共存；历史快照不可原地更新/不可回补。
CREATE OR REPLACE VIEW serving.serving_research_index_classify AS
SELECT index_code, snapshot_date, industry_name, parent_code, level, industry_code,
       is_published, classification_source, source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_index_classify;

-- 时点成分：保留 in_date/out_date/is_new，支持任意 as-of 历史成分查询：
--   WHERE snapshot_date = (SELECT max(snapshot_date) FROM dwd_index_member_all WHERE snapshot_date <= :as_of)
--     AND in_date <= :as_of AND (out_date IS NULL OR out_date > :as_of)
CREATE OR REPLACE VIEW serving.serving_research_index_member_all AS
SELECT instrument_id, snapshot_date, name,
       l1_code, l1_name, l2_code, l2_name, l3_code, l3_name,
       in_date, out_date, is_new, source, as_of,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - as_of)) * 1000)::bigint AS staleness_ms
FROM dwd_index_member_all;

-- --------------------------------------------------------------------------
-- 实时行情快照（AKshare 东方财富源，A1 P1）
--    * 来源 = akshare_eastmoney（F1 residual / SEC-012：爬虫源仅限内部研究/展示）
--    * **C 端实时行情展示未放行**（待 H3/H4 书面裁），source_internal_only=true 标记
--      翻档前 C 端不可见（H4 核验闭环判据 §12.3-4）
--    * 每个 instrument_id 取最新快照（DISTINCT ON）
--    * limit_status 沿用 serving_quote_latest 逻辑：主板 10%/ST 5%/创业板科创板 20%/北交所 30%
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW serving.serving_quote_realtime AS
WITH latest AS (
    SELECT DISTINCT ON (r.instrument_id)
           r.instrument_id, r.as_of, r.last, r.prev_close, r.open, r.high, r.low,
           r.volume, r.amount, r.pct_change, r.change, r.turnover_rate, r.volume_ratio,
           r.source, r.fetched_at
    FROM dwd_realtime_quote AS r
    ORDER BY r.instrument_id, r.as_of DESC
),
priced AS (
    SELECT l.*,
           i.board,
           i.name,
           CASE
               WHEN i.board = 'main' AND (i.name LIKE 'ST%' OR i.name LIKE '*ST%') THEN 5.0
               WHEN i.board = 'main' THEN 10.0
               WHEN i.board IN ('gem', 'star') THEN 20.0
               WHEN i.board = 'bse' THEN 30.0
           END AS limit_pct
    FROM latest AS l
    JOIN dim_instrument AS i ON i.instrument_id = l.instrument_id
)
SELECT p.instrument_id,
       p.name,
       p.as_of,
       p.last AS close,
       p.prev_close,
       p.open,
       p.high,
       p.low,
       CASE WHEN p.prev_close IS NULL OR p.prev_close = 0 THEN NULL
            ELSE ROUND((p.last / p.prev_close - 1) * 100, 4) END AS change_pct,
       CASE WHEN p.prev_close IS NULL THEN NULL
            ELSE ROUND(p.last - p.prev_close, 2) END AS change,
       p.volume,
       p.amount,
       p.turnover_rate,
       p.volume_ratio,
       CASE
           WHEN p.prev_close IS NULL OR p.limit_pct IS NULL THEN 'none'
           WHEN p.last >= ROUND(p.prev_close * (1 + p.limit_pct / 100.0), 2) THEN 'limit_up'
           WHEN p.last <= ROUND(p.prev_close * (1 - p.limit_pct / 100.0), 2) THEN 'limit_down'
           ELSE 'none'
       END AS limit_status,
       p.source,
       p.as_of AS source_as_of,
       -- SEC-012 / F1 residual：akshare 来源标记 internal-only，翻档前 C 端不可见
       -- fail-closed：未知来源默认 true（保守策略，仅已确认安全来源可标 false）
       (p.source IS DISTINCT FROM 'tushare') AS source_internal_only,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - p.as_of)) * 1000)::bigint AS staleness_ms
FROM priced AS p;
