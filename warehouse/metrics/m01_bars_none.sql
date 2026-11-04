-- M01 个股日线（主口径：不复权）
-- 依据：H4-D6 已批准「不复权为主口径」；契约 contracts/market AdjType=none 为 K 线默认。
-- 用途：K 线、行情快照；不使用复权因子，保证与交易所公布的原始价格逐分一致。
-- 参数（binding，:name 形式，由 serving 层注入）：:instrument_id, :start_date, :end_date
SELECT instrument_id,
       trade_date,
       open,
       high,
       low,
       close,
       volume,
       amount
FROM dwd_stock_bar_daily
WHERE instrument_id = :instrument_id
  AND trade_date BETWEEN :start_date AND :end_date
ORDER BY trade_date;
