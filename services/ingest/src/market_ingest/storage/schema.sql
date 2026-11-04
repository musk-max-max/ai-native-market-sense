-- A1 接入层本地/CI 存储（SQLite）。生产 PG 后端实现同一接口（接口见 sqlite.py）。
-- 语义：ODS 原始 payload 台账「只追加、不可改、不可删」（ADR-002 D3/D5）。

CREATE TABLE IF NOT EXISTS ods_batch (
    batch_id        TEXT PRIMARY KEY,
    dataset         TEXT NOT NULL,
    adapter         TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    status          TEXT NOT NULL DEFAULT 'running',  -- running|succeeded|failed|interrupted
    row_count       INTEGER NOT NULL DEFAULT 0,
    rejected_count  INTEGER NOT NULL DEFAULT 0,
    note            TEXT
);

-- ODS 原始页：payload 原样保留，供审计与重放；batch 只是来源标记。
CREATE TABLE IF NOT EXISTS ods_raw_page (
    page_key        TEXT PRIMARY KEY,          -- sha256(dataset|endpoint|params|payload)，重放幂等
    batch_id        TEXT NOT NULL,
    dataset         TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    request_params  TEXT NOT NULL,             -- JSON
    response_payload TEXT NOT NULL,            -- JSON（源原始结构，不得被解析后回写）
    row_count       INTEGER NOT NULL,
    source          TEXT NOT NULL,
    as_of           TEXT,                      -- 市场时点 ISO8601(+08:00)，可空
    fetched_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

-- DLQ：映射/校验失败的行必须留存并告警，禁止静默丢弃。
CREATE TABLE IF NOT EXISTS ods_rejected_row (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id        TEXT NOT NULL,
    dataset         TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    reason          TEXT NOT NULL,
    instrument_id   TEXT,
    trade_date      TEXT,
    payload         TEXT NOT NULL,             -- JSON
    created_at      TEXT NOT NULL
);

-- 断点续跑：每块成功后推进 last_success_trade_date（幂等 upsert）。
CREATE TABLE IF NOT EXISTS ingest_checkpoint (
    dataset                     TEXT NOT NULL,
    scope                       TEXT NOT NULL,   -- 例如 instrument_id
    last_success_trade_date     TEXT,
    last_batch_id               TEXT,
    updated_at                  TEXT NOT NULL,
    PRIMARY KEY (dataset, scope)
);

-- 配额台账：按自然日（Asia/Shanghai）累计源调用次数，跨进程/跨运行可预算。
CREATE TABLE IF NOT EXISTS quota_ledger (
    period_key      TEXT PRIMARY KEY,
    calls           INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL
);

-- 复权因子归一化锚点（原始因子 / anchor = 归一化因子；1.0 = 最早可得因子日）。
-- 老股锚点固定 1990-12-19，与其他标的保持同一归一语义，DWD 才能确定性重算 qfq/hfq。
CREATE TABLE IF NOT EXISTS ingest_factor_anchor (
    instrument_id   TEXT PRIMARY KEY,              -- EXCH:CODE
    anchor_date     TEXT NOT NULL,                 -- 该标的首个可得因子日
    anchor_factor   TEXT NOT NULL,                 -- 十进制字符串，禁 float
    source          TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- 原始 payload 与 DLQ 只追加：任何 UPDATE/DELETE 直接 ABORT。
CREATE TRIGGER IF NOT EXISTS trg_ods_raw_page_no_update
BEFORE UPDATE ON ods_raw_page
BEGIN SELECT RAISE(ABORT, 'ods_raw_page is append-only (ADR-002 D3)'); END;

CREATE TRIGGER IF NOT EXISTS trg_ods_raw_page_no_delete
BEFORE DELETE ON ods_raw_page
BEGIN SELECT RAISE(ABORT, 'ods_raw_page is append-only (ADR-002 D3)'); END;

CREATE TRIGGER IF NOT EXISTS trg_ods_rejected_row_no_update
BEFORE UPDATE ON ods_rejected_row
BEGIN SELECT RAISE(ABORT, 'ods_rejected_row is append-only (ADR-002 D5)'); END;

CREATE TRIGGER IF NOT EXISTS trg_ods_rejected_row_no_delete
BEFORE DELETE ON ods_rejected_row
BEGIN SELECT RAISE(ABORT, 'ods_rejected_row is append-only (ADR-002 D5)'); END;

-- 配额台账只累加不删除：清账目等于隐藏超支，DELETE 一律 ABORT（UPDATE 用于累加）。
CREATE TRIGGER IF NOT EXISTS trg_quota_ledger_no_delete
BEFORE DELETE ON quota_ledger
BEGIN SELECT RAISE(ABORT, 'quota_ledger is append-only per period'); END;

-- checkpoint 允许前进（幂等 upsert）；batch 允许收尾状态流转。
CREATE INDEX IF NOT EXISTS idx_ods_raw_page_dataset ON ods_raw_page (dataset, fetched_at);
CREATE INDEX IF NOT EXISTS idx_ods_rejected_row_batch ON ods_rejected_row (batch_id);
