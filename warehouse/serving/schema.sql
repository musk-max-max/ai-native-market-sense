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
--    * limit_status 口径 = docs/metrics/m04_limit_status.sql（按板块；主板 ST/*ST 5%）。
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
priced AS (
    SELECT j.*,
           CASE
               WHEN j.board = 'main' AND (j.name LIKE 'ST%' OR j.name LIKE '*ST%') THEN 5.0
               WHEN j.board = 'main' THEN 10.0
               WHEN j.board IN ('gem', 'star') THEN 20.0
               WHEN j.board = 'bse' THEN 30.0
           END AS limit_pct
    FROM joined AS j
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
           WHEN p.suspended THEN 'none'
           WHEN p.prev_close IS NULL THEN 'none'
           WHEN p.close >= ROUND(p.prev_close * (1 + p.limit_pct / 100.0), 2) THEN 'limit_up'
           WHEN p.close <= ROUND(p.prev_close * (1 - p.limit_pct / 100.0), 2) THEN 'limit_down'
           ELSE 'none'
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
