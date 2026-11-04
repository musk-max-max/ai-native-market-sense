-- M02 区间收益率（口径：后复权 hfq）
-- 依据：H4-D6 已批准「后复权算收益」；前复权只用于画图（qfq 依赖 as_of，不能用于收益比较）。
-- 公式：hfq_close = close × factor；return_pct = (末 hfq_close / 首 hfq_close − 1) × 100
-- 说明：因子为累计因子，1.0 = 该标的**最早可得因子日**（L3），不是"首个上市交易日"；
--       1990-12-19 前上市的老股锚定 1990-12-19。区间内 hfq 收益与锚选择无关，但 hfq 绝对价
--       随锚变化——锚一变即口径变更，必须重新会签。
-- 输出：anchor_date（该标的因子序列起点）、factor_version（含锚的版本串，锚变则串变）、
--       factor_as_of（因子批次 as_of，用于追溯数据来源）。hfq 绝对价不得直接进 C 端展示，
--       仅用于收益；要展示 hfq 绝对价需另立口径并会签。
-- 参数：:instrument_id, :start_date, :end_date
WITH factor_meta AS (
    SELECT instrument_id,
           MIN(trade_date) AS anchor_date,
           MAX(as_of) AS factor_as_of
    FROM dwd_adj_factor
    WHERE instrument_id = :instrument_id
    GROUP BY instrument_id
),
adj AS (
    SELECT b.trade_date,
           b.close * f.factor AS hfq_close
    FROM dwd_stock_bar_daily AS b
    JOIN dwd_adj_factor AS f
      ON f.instrument_id = b.instrument_id
     AND f.trade_date = b.trade_date
    WHERE b.instrument_id = :instrument_id
      AND b.trade_date BETWEEN :start_date AND :end_date
),
ranked AS (
    SELECT trade_date,
           hfq_close,
           ROW_NUMBER() OVER (ORDER BY trade_date ASC) AS rn_first,
           ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn_last
    FROM adj
)
SELECT (SELECT trade_date FROM ranked WHERE rn_first = 1) AS start_date,
       (SELECT trade_date FROM ranked WHERE rn_last = 1) AS end_date,
       ROUND(
           ((SELECT hfq_close FROM ranked WHERE rn_last = 1)
            / (SELECT hfq_close FROM ranked WHERE rn_first = 1) - 1) * 100,
           4
       ) AS return_pct,
       m.anchor_date,
       'L3:anchor=' || m.anchor_date::text AS factor_version,
       m.factor_as_of
FROM factor_meta AS m
WHERE EXISTS (SELECT 1 FROM ranked);
