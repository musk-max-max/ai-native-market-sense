-- M04 涨跌停状态（口径：按板块）
-- 依据：H4-D6 已批准「涨跌停按板块」，C11 禁止硬编码 10%。
-- 幅度：主板 10% / 创业板 20% / 科创板 20% / 北交所 30%；主板 ST、*ST 5%（st_limit_boards）。
-- 基准：M08 的 prev_close（除权日由适配层写入除权参考价，避免除权误判涨跌停）。
-- 参数：:start_date, :end_date
WITH base AS (
    SELECT b.instrument_id,
           b.trade_date,
           b.close,
           b.prev_close,
           i.board,
           CASE
               WHEN i.board = 'main' AND (i.name LIKE 'ST%' OR i.name LIKE '*ST%') THEN 5.0
               WHEN i.board = 'main' THEN 10.0
               WHEN i.board IN ('gem', 'star') THEN 20.0
               WHEN i.board = 'bse' THEN 30.0
           END AS limit_pct
    FROM dwd_stock_bar_daily AS b
    JOIN dim_instrument AS i
      ON i.instrument_id = b.instrument_id
    WHERE b.prev_close IS NOT NULL
      AND b.trade_date BETWEEN :start_date AND :end_date
),
priced AS (
    SELECT instrument_id,
           trade_date,
           board,
           limit_pct,
           ROUND(prev_close * (1 + limit_pct / 100.0), 2) AS limit_up_price,
           ROUND(prev_close * (1 - limit_pct / 100.0), 2) AS limit_down_price,
           close
    FROM base
)
SELECT instrument_id,
       trade_date,
       board,
       limit_pct,
       limit_up_price,
       limit_down_price,
       CASE
           WHEN close >= limit_up_price THEN 'limit_up'
           WHEN close <= limit_down_price THEN 'limit_down'
           ELSE 'none'
       END AS limit_status
FROM priced
ORDER BY instrument_id, trade_date;
