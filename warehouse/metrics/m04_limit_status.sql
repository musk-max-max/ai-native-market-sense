-- M04 涨跌停状态（口径：按板块 + 时点；P0 ST 判定=当前名称快照，L80）
-- 依据：H4-D6 已批准「涨跌停按板块」，C11 禁止硬编码 10%；L80 裁定 P0 不还原历史 ST 状态。
-- 时点规则（H4 2026-11-05 口径更正；旧「主板 ST 一律 5%」作废）：
--   主板           10%
--   主板 ST/*ST    < 2026-07-06 → 5%；>= 2026-07-06 → 10%（沪深同步，2026-07-06 起施行）
--   创业板         < 2020-08-24 → 10%；>= 2020-08-24 → 20%
--   科创板         < 2019-07-22（开板前不存在）→ NULL；>= 2019-07-22 → 20%
--   北交所         >= 2021-11-15 → 30%；更早 → NULL（不猜精选层规则，禁止把 30% 套到更早日期）
--   主板 S 股      名称 S 开头且非 ST（如 600182 S佳通）→ 5%
--   首日           trade_date = listed_at → NULL（无涨跌幅；创/科上市前 5 日特殊档 P1 处理）
-- 基准：M08 的 prev_close（除权日为除权参考价，由适配层写入，避免除权误判涨跌停）。
-- fail-closed：板块未知/为空时 limit_pct=NULL、limit_status=NULL，禁止 CASE 静默落到 'none'
--             （"不知道"≠"没涨跌停"）；质量规则 BIZ-01 对未知板块直接 blocker。
-- ST 时点性（L80）：P0 只有 dim_instrument.name 当前快照，历史交易日未还原；
--             输出 st_by_current_name / st_status_source / known_limitation，跨戴帽、摘帽、
--             退市窗口的结果不适用。P1 接入 namechange 后改按交易日状态并转 blocker。
-- 限价取整（按交易所/报价单位，不能一律 half-up）：
--   沪深 A 股 0.01 元 half-up（10.05×1.05=10.5525→10.55）；
--   沪市 B 股 900xxx 0.001 美元 half-up；深市 B 股 200xxx 0.01 港元 half-up（B 股规则待 H4 签，先按此实现）；
--   北交所 A 股（43/83/87/88/92）涨停向下截断、跌停向上截断（0.01 元）；
--   比较用取整后的限价，不用涨跌幅百分比直接判。
-- known limitation：B 股（沪 900xxx / 深 200xxx）报价单位规则待 H4 签字；
--             新股上市初期特殊档（创/科前 5 日）P1 处理（P0 仅有 listed_at，无交易日历）。
-- 参数：:start_date, :end_date
WITH base AS (
    SELECT b.instrument_id,
           b.trade_date,
           b.close,
           b.prev_close,
           i.exchange,
           i.code,
           i.board,
           i.name,
           i.listed_at,
           CASE
               WHEN i.board IS NULL THEN NULL
               WHEN b.trade_date = i.listed_at THEN NULL
               WHEN i.board = 'main' AND (i.name LIKE 'ST%' OR i.name LIKE '*ST%') THEN
                   CASE WHEN b.trade_date < DATE '2026-07-06' THEN 5.0 ELSE 10.0 END
               WHEN i.board = 'main' AND i.name LIKE 'S%' THEN 5.0
               WHEN i.board = 'main' THEN 10.0
               WHEN i.board = 'gem' THEN
                   CASE WHEN b.trade_date < DATE '2020-08-24' THEN 10.0 ELSE 20.0 END
               WHEN i.board = 'star' THEN
                   CASE WHEN b.trade_date < DATE '2019-07-22' THEN NULL ELSE 20.0 END
               WHEN i.board = 'bse' THEN
                   CASE WHEN b.trade_date < DATE '2021-11-15' THEN NULL ELSE 30.0 END
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
           WHEN trade_date = listed_at THEN '首日无涨跌幅限制（listed_at 判定）'
           WHEN board = 'star' AND trade_date < DATE '2019-07-22'
               THEN '科创板 2019-07-22 开板前无该板块（limit_pct=NULL）'
           WHEN board = 'bse' AND trade_date < DATE '2021-11-15'
               THEN '北交所 2021-11-15 前无 30% 涨跌幅口径（不猜精选层），limit_pct=NULL'
           WHEN board = 'bse'
               THEN '北交所取整按交易所规则（涨停 floor / 跌停 ceil）；沪 B 900xxx / 深 B 200xxx 规则待 H4 签字'
           WHEN board = 'main' AND (name LIKE 'ST%' OR name LIKE '*ST%')
               THEN 'ST 判定=当前名称快照，历史交易日未还原；跨戴帽/摘帽/退市窗口不适用（L80；P1 接 namechange 后转 blocker）；ST 限价 2026-07-06 起为 10%'
           ELSE NULL
       END AS known_limitation
FROM priced
ORDER BY instrument_id, trade_date;
