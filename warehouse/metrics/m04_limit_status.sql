-- M04 涨跌停状态（口径：按板块 + 时点 + 上市初期；P0 ST 判定=当前名称快照，L80）
-- 依据：H4-D6 已批准「涨跌停按板块」，C11 禁止硬编码 10%；L80 裁定 P0 不还原历史 ST 状态。
-- 时点规则（H4 2026-11-05 口径更正；旧「主板 ST 一律 5%」作废）：
--   主板           10%
--   主板 ST/*ST    < 2026-07-06 → 5%；>= 2026-07-06 → 10%（沪深同步，2026-07-06 起施行）
--   主板 S 股      名称 S 开头且非 ST（如 600182 S佳通）→ 5%；S 股规则优先于 ST（S*ST 历史名也 5%）
--   创业板         < 2020-08-24 → 10%；>= 2020-08-24 → 20%
--   科创板         < 2019-07-22（开板前不存在）→ NULL；>= 2019-07-22 → 20%
--   北交所         >= 2021-11-15 → 30%；更早 → NULL（不猜精选层规则，禁止把 30% 套到更早日期）
-- 上市初期无涨跌幅（注册制改革，P0 用 trade_seq 判定）：
--   trade_date = listed_at → NULL（首日）
--   科创板（listed_at >= 2019-07-22）、创业板（listed_at >= 2020-08-24）、
--   主板（listed_at >= 2023-04-10）上市后前 5 个交易日 → NULL
--   注：trade_seq 在 trade_date <= :end_date 的全历史上按 instrument_id 排行号，
--       再按 :start_date 过滤，避免窗口起点重置序号；缺 bar 的交易日按已有 bar 近似。
--   北交所新股仅首日无涨跌幅（已被 listed_at 规则覆盖）。
--   listed_at IS NULL → NULL，fail-closed（无法判首日/上市初期，不猜）。
-- 基准：M08 的 prev_close（除权日为除权参考价，由适配层写入，避免除权误判涨跌停）。
-- fail-closed：板块未知/为空时 limit_pct=NULL、limit_status=NULL，禁止 CASE 静默落到 'none'
--             （"不知道"≠"没涨跌停"）；质量规则 BIZ-01 对未知板块直接 blocker。
-- ST 时点性（L80）：P0 只有 dim_instrument.name 当前快照，历史交易日未还原；
--             输出 st_by_current_name / st_status_source / known_limitation，跨戴帽、摘帽、
--             退市窗口的结果不适用。P1 接入 namechange 后改按交易日状态并转 blocker。
-- 限价取整（按交易所/报价单位，不能一律 half-up）：沪深 A 0.01 元 half-up
--   （10.05×1.05=10.5525→10.55）；北交所 A（43/83/87/88/92）涨停 floor、跌停 ceil；
--   沪市 B 股 900xxx 0.001 美元 half-up、深市 B 股 200xxx 0.01 港元 half-up
--   （H4 2026-11-05 已签：沪 B 41/41、深 B 35/35 命中；B 股仍只研究域，不进 C 端）。
-- known limitation：创/科/主板注册制前 5 交易日序号按已有 bar 近似；缺 bar 的交易日会使序号偏小。
-- 参数：:start_date, :end_date
WITH hist AS (
    SELECT b.instrument_id,
           b.trade_date,
           b.close,
           b.prev_close,
           i.exchange,
           i.code,
           i.board,
           i.name,
           i.listed_at,
           ROW_NUMBER() OVER (PARTITION BY b.instrument_id ORDER BY b.trade_date) AS trade_seq
    FROM dwd_stock_bar_daily AS b
    JOIN dim_instrument AS i
      ON i.instrument_id = b.instrument_id
    WHERE b.trade_date <= :end_date
),
base AS (
    SELECT instrument_id,
           trade_date,
           close,
           prev_close,
           exchange,
           code,
           board,
           name,
           listed_at,
           trade_seq,
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
    FROM hist
    WHERE trade_date >= :start_date
      AND prev_close IS NOT NULL
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
           WHEN listed_at IS NULL THEN '上市日缺失，无法判首日/上市初期：limit_pct=NULL（fail-closed）'
           WHEN trade_date = listed_at THEN '首日无涨跌幅限制（listed_at 判定）'
           WHEN trade_seq <= 5 AND (
                    (board = 'star' AND listed_at >= DATE '2019-07-22')
                 OR (board = 'gem'  AND listed_at >= DATE '2020-08-24')
                 OR (board = 'main' AND listed_at >= DATE '2023-04-10')
               ) THEN '注册制新股上市前 5 个交易日无涨跌幅（trade_seq<=5，limit_pct=NULL）'
           WHEN board = 'star' AND trade_date < DATE '2019-07-22'
               THEN '科创板 2019-07-22 开板前无该板块（limit_pct=NULL）'
           WHEN board = 'bse' AND trade_date < DATE '2021-11-15'
               THEN '北交所 2021-11-15 前无 30% 涨跌幅口径（不猜精选层），limit_pct=NULL'
           WHEN board = 'bse'
               THEN '北交所取整按交易所规则（涨停 floor / 跌停 ceil）；沪 B 900xxx 0.001 美元 / 深 B 200xxx 0.01 港元 half-up（H4 2026-11-05 已签；B 股只研究域）'
           WHEN board = 'main' AND name LIKE 'S%' AND name NOT LIKE 'ST%'
               THEN 'S 股规则优先（5%）；若名称同时含 ST（如 S*ST），仍按 S 股 5%'
           WHEN board = 'main' AND (name LIKE 'ST%' OR name LIKE '*ST%')
               THEN 'ST 判定=当前名称快照，历史交易日未还原；跨戴帽/摘帽/退市窗口不适用（L80；P1 接 namechange 后转 blocker）；ST 限价 2026-07-06 起为 10%'
           ELSE NULL
       END AS known_limitation
FROM priced
ORDER BY instrument_id, trade_date;
