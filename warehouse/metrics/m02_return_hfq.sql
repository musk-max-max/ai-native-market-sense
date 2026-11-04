-- M02 区间收益率（口径：后复权 hfq）
-- 依据：H4-D6 已批准「后复权算收益」；前复权只用于画图（qdq 依赖 as_of，不能用于收益比较）。
-- 公式：hfq_close = close × factor；return_pct = (末 hfq_close / 首 hfq_close − 1) × 100
-- 说明：因子为累计因子（1.0 = 首个上市交易日），区间两端都用因子归一，除权不改变收益。
-- 参数：:instrument_id, :start_date, :end_date
WITH adj AS (
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
       ) AS return_pct
WHERE EXISTS (SELECT 1 FROM ranked);
