-- M04 涨跌停状态（口径：按板块；P0 ST 判定=当前名称快照，L80）
-- 依据：H4-D6 已批准「涨跌停按板块」，C11 禁止硬编码 10%；L80 裁定 P0 不还原历史 ST 状态。
-- 幅度：主板 10% / 创业板 20% / 科创板 20% / 北交所 30%；主板 ST、*ST 5%（st_limit_boards）。
-- 基准：M08 的 prev_close（除权日为除权参考价，由适配层写入，避免除权误判涨跌停）。
-- fail-closed：板块未知/为空时 limit_pct=NULL、limit_status=NULL，禁止 CASE 静默落到 'none'
--             （"不知道"≠"没涨跌停"）；质量规则 BIZ-01 对未知板块直接 blocker。
-- ST 时点性（L80）：P0 只有 dim_instrument.name 当前快照，历史交易日未还原；
--             输出 st_by_current_name / st_status_source / known_limitation，跨戴帽、摘帽、
--             退市窗口的结果不适用。P1 接入 namechange 后改按交易日状态并转 blocker。
-- 限价取整：按交易所规则先用 prev_close×(1±幅度) 算理论价，再四舍五入到分（如
--             10.05×1.05=10.5525→10.55），比较用取整后的限价，不用涨跌幅百分比直接判。
-- 参数：:start_date, :end_date
WITH base AS (
    SELECT b.instrument_id,
           b.trade_date,
           b.close,
           b.prev_close,
           i.board,
           i.name,
           CASE
               WHEN i.board = 'main' AND (i.name LIKE 'ST%' OR i.name LIKE '*ST%') THEN 5.0
               WHEN i.board = 'main' THEN 10.0
               WHEN i.board IN ('gem', 'star') THEN 20.0
               WHEN i.board = 'bse' THEN 30.0
               ELSE NULL
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
           name,
           limit_pct,
           CASE
               WHEN limit_pct IS NULL THEN NULL
               ELSE ROUND(prev_close * (1 + limit_pct / 100.0), 2)
           END AS limit_up_price,
           CASE
               WHEN limit_pct IS NULL THEN NULL
               ELSE ROUND(prev_close * (1 - limit_pct / 100.0), 2)
           END AS limit_down_price,
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
           WHEN limit_pct IS NULL THEN NULL
           WHEN close >= limit_up_price THEN 'limit_up'
           WHEN close <= limit_down_price THEN 'limit_down'
           ELSE 'none'
       END AS limit_status,
       CASE
           WHEN board = 'main' AND (name LIKE 'ST%' OR name LIKE '*ST%') THEN true
           ELSE false
       END AS st_by_current_name,
       'dim_instrument.name@as_of' AS st_status_source,
       CASE
           WHEN board IS NULL THEN 'board 未知：fail-closed，不判涨跌停'
           WHEN board = 'main' AND (name LIKE 'ST%' OR name LIKE '*ST%')
               THEN 'ST 判定=当前名称快照，历史交易日未还原；跨戴帽/摘帽/退市窗口不适用（L80；P1 接 namechange 后转 blocker）'
           ELSE NULL
       END AS known_limitation
FROM priced
ORDER BY instrument_id, trade_date;
