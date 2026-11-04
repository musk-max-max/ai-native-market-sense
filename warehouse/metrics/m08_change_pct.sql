-- M08 涨跌幅（口径：以前收盘价为基准）
-- 依据：H4-D6 已批准「涨跌幅按板块规则」，基准为前收盘价；除权除息日基准为除权参考价（由适配层写入 prev_close）。
-- 契约：Quote.change_pct 可为 null（停牌/新股），禁止用 0 冒充。
-- 参数：:instrument_id, :start_date, :end_date
SELECT instrument_id,
       trade_date,
       prev_close,
       close,
       ROUND((close / prev_close - 1) * 100, 4) AS change_pct
FROM dwd_stock_bar_daily
WHERE instrument_id = :instrument_id
  AND trade_date BETWEEN :start_date AND :end_date
  AND prev_close IS NOT NULL
  AND prev_close > 0
ORDER BY trade_date;
