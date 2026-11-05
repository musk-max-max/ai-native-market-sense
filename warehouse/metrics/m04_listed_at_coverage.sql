-- M04 listed_at 覆盖率诊断（H4 2026-11-05 签字条件 3）
-- 目的：量出 dim_instrument 中 listed_at IS NULL 的标的数，以及这些标的在全量 bar 中的行数占比。
-- 判定：若占比 > 1%，属覆盖口径变化，必须回 H4 决策（不能只写 known_limitation）；<=1% 写入 known_limitation。
-- 只读诊断查询，不参与 M04 计算。
WITH bar_counts AS (
    SELECT instrument_id, COUNT(*) AS bar_rows
    FROM dwd_stock_bar_daily
    GROUP BY instrument_id
)
SELECT COUNT(*)                                              AS instruments_total,
       COUNT(*) FILTER (WHERE i.listed_at IS NULL)           AS instruments_missing_listed_at,
       COALESCE(SUM(b.bar_rows) FILTER (WHERE i.listed_at IS NULL), 0) AS bars_missing_listed_at,
       COALESCE(SUM(b.bar_rows), 0)                          AS bars_total,
       CASE
           WHEN COALESCE(SUM(b.bar_rows), 0) = 0 THEN 0
           ELSE ROUND(100.0 * COALESCE(SUM(b.bar_rows) FILTER (WHERE i.listed_at IS NULL), 0)
                      / SUM(b.bar_rows), 4)
       END                                                   AS pct_bars_missing_listed_at
FROM dim_instrument AS i
LEFT JOIN bar_counts AS b
       ON b.instrument_id = i.instrument_id;
