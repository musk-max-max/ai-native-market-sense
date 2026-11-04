-- 001_watchlist.sql —— 自选表（平台自有数据）
--
-- 归属：A3（services/market），执行点：E2E/本地由 E2E_MODE=1 的插件兜底建表；
-- 生产迁移由 A13 发布流水线执行（A0 明确 forbids 数据库迁移脚本由他代跑）。
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS，可重复执行。
--
-- 表名默认 watchlist_items；E2E_WATCHLIST_TABLE 可覆盖（插件按同一配置建表/查询）。

CREATE TABLE IF NOT EXISTS watchlist_items (
  user_id       text        NOT NULL,
  instrument_id text        NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, instrument_id),
  CONSTRAINT watchlist_items_instrument_id_format
    CHECK (instrument_id ~ '^(SSE|SZSE|BSE):[0-9]{6}$')
);

CREATE INDEX IF NOT EXISTS watchlist_items_user_added_idx
  ON watchlist_items (user_id, added_at DESC);
