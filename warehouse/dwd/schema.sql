-- warehouse/dwd/schema.sql
-- DWD 层 DDL（PostgreSQL 16）。P0 只建竖切片所需三张表 + 一张修订留痕表。
-- 口径依据：ADR-002 D2「DWD 存不复权 OHLC + 每股复权因子表，不存三份 OHLC」；
--           docs/metrics/P0-metrics.md M01/M02/M08。
-- 约束：本文件是列名的唯一真源；warehouse/dwd/build.py 的行结构必须与之一致
--       （warehouse/tests/test_schema_sync.py 交叉校验，漂移即红灯）。

-- --------------------------------------------------------------------------
-- 1. 个股日线（不复权 / 主口径 M01）
--    * 只存不复权 OHLC；qfq/hfq 由 dwd_adj_factor 确定性计算，不落三份价格。
--    * prev_close 为「涨跌幅基准」（M08）：正常日为上一交易日收盘价，
--      除权除息日必须由适配层写入除权参考价（缺失时规则告警，禁止猜测）。
--    * 无交易日/停牌日不建行（C08），不得补 0。
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_stock_bar_daily (
    instrument_id   text        NOT NULL,
    trade_date      date        NOT NULL,
    open            numeric(18,2) NOT NULL,
    high            numeric(18,2) NOT NULL,
    low             numeric(18,2) NOT NULL,
    close           numeric(18,2) NOT NULL,
    volume          bigint      NOT NULL CHECK (volume >= 0),      -- 单位：股（C09）
    amount          numeric(20,2) NOT NULL CHECK (amount >= 0),    -- 单位：元（C09）
    prev_close      numeric(18,2),                                  -- 涨跌幅基准（M08），首日可空
    source          text        NOT NULL,                           -- canonical 来源标识（C03）
    as_of           timestamptz NOT NULL,                           -- 市场时点 +08:00（C04/C18）
    fetched_at      timestamptz NOT NULL,                           -- 采集时间，仅审计（C04）
    batch_id        text        NOT NULL,
    revision        integer     NOT NULL DEFAULT 0,                 -- 历史修正版本（A2 规则 6）
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
COMMENT ON TABLE dwd_stock_bar_daily IS '个股日线（不复权，M01 主口径），PK 幂等 upsert（C15）';

-- --------------------------------------------------------------------------
-- 2. 复权因子（M02/M03 的唯一输入）
--    * factor 为累计复权因子，归一化 1.0 = 该证券首个上市交易日（见 README §复权因子语义）。
--    * hfq = close * factor；qfq = close * factor / factor(区间内最新交易日)。
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_adj_factor (
    instrument_id   text        NOT NULL,
    trade_date      date        NOT NULL,
    factor          numeric(20,10) NOT NULL CHECK (factor > 0),
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    revision        integer     NOT NULL DEFAULT 0,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
COMMENT ON TABLE dwd_adj_factor IS '累计复权因子（0 或负数即结构违规），供 qfq/hfq 确定性计算';

-- --------------------------------------------------------------------------
-- 3. 证券维表（当期快照）
--    * P1 才做历史状态（ADR-002 待定项）；P0 只保留最近一次成功快照。
--    * is_st 不落库：由 name 以 ST/*ST 开头派生（P0 派生规则，见 docs/metrics M04）。
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_instrument (
    instrument_id   text        PRIMARY KEY,
    exchange        text        NOT NULL CHECK (exchange IN ('SSE','SZSE','BSE')),
    code            text        NOT NULL CHECK (code ~ '^[0-9]{6}$'),
    name            text        NOT NULL,
    board           text        NOT NULL CHECK (board IN ('main','gem','star','bse')),
    security_type   text        NOT NULL CHECK (security_type IN ('stock','etf','index')),
    list_status     text        NOT NULL CHECK (list_status IN ('listed','delisted','pre_listed')),
    lot_size        integer     NOT NULL DEFAULT 100 CHECK (lot_size >= 1),
    listed_at       date,
    -- L30 + L34 + H4 m01072：证据式派生，fail-closed。display_safe = origin=='display'
    -- AND manifest 有 succeeded 事件 AND channel ∈ {manual_import,authorized_download,official_api}
    -- AND 快照与事件一致。缺证据一律 false（生产 profile 直接拒绝落库，不静默降级）。
    display_safe    boolean     NOT NULL DEFAULT false,
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    ingested_at     timestamptz NOT NULL
);

-- --------------------------------------------------------------------------
-- 4. 修订留痕（A2 规则 6：历史数据被修正必须留版本并告警）
--    同一 (instrument_id, trade_date, revision, field) 只记一次，禁止覆盖删除。
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_bar_revision (
    instrument_id   text        NOT NULL,
    trade_date      date        NOT NULL,
    revision        integer     NOT NULL CHECK (revision >= 1),
    field           text        NOT NULL,
    old_value       text,
    new_value       text,
    detected_at     timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    PRIMARY KEY (instrument_id, trade_date, revision, field)
);
COMMENT ON TABLE dwd_bar_revision IS 'DWD 行被上游修正时的 before/after 留痕，只增不改';

-- --------------------------------------------------------------------------
-- 5. 停牌证据（L8：停牌日不建 bar，但必须留「该交易日确实无行情」的证据）
--    * 只由 ODS bar.v1 的 suspended:true 证据行写入；不合成 OHLC、不补 0（C08）。
--    * COMP-03 用它区分「停牌」与「漏数据」；禁止用「没有 bar」推断停牌。
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_suspended_daily (
    instrument_id   text        NOT NULL,
    trade_date      date        NOT NULL,
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
COMMENT ON TABLE dwd_suspended_daily IS '停牌证据行（无 OHLC）；停牌日 ≠ 数据缺失，C08/L8';

-- --------------------------------------------------------------------------
-- 6. 财务摘要（M06：reported + restated 两套并存；P0 只有 DDL，数据待 A1 接入）
--    * 财务不适用复权口径；契约只返回最近一期（按 announced_at 排序）。
--    * 两套口径同 report_period 并存，禁止互相覆盖；缺失字段用 NULL，禁止 0 冒充。
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_fundamental_report (
    instrument_id      text        NOT NULL,
    report_period      text        NOT NULL CHECK (report_period ~ '^[0-9]{4}Q[1-4]$'),
    report_end_date    date        NOT NULL,
    announced_at       timestamptz NOT NULL,
    statement_basis    text        NOT NULL CHECK (statement_basis IN ('reported','restated')),
    currency           text        NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY')),
    revenue            numeric(20,2) NOT NULL,
    net_profit         numeric(20,2) NOT NULL,
    revenue_yoy_pct    numeric(10,4),
    net_profit_yoy_pct numeric(10,4),
    eps                numeric(12,4),
    roe_pct            numeric(10,4),
    gross_margin_pct   numeric(10,4),
    source             text        NOT NULL,
    as_of              timestamptz NOT NULL,
    fetched_at         timestamptz NOT NULL,
    batch_id           text        NOT NULL,
    ingested_at        timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, report_period, statement_basis)
);
COMMENT ON TABLE dwd_fundamental_report IS '财务摘要双口径（M06）：reported/restated 并存，按 announced_at 取最近一期';
