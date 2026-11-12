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
    market_segment  text        CHECK (market_segment IS NULL OR market_segment = 'neeq_select'),
                                                                    -- 内部 canonical：BSE 2021-11-15 前=精选层（neeq_select）；其余 NULL；不进 C 端
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
    -- L30 + L34 + H4 2026-11-04 裁定（agents/decisions.md L42）：证据式派生，fail-closed。display_safe = origin=='display'
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

-- --------------------------------------------------------------------------
-- 7. 研究数据集 DWD（KD-AIP0-INF-05 / ADR-007 第 2 批；只进 internal root）
--    边界：不接 C 端契约，不改变 P0 八条口径；字段名保持 A1 canonical（provisional，
--    H4 对齐后只改 warehouse/ods/loader.py 的 RESEARCH_ROW_SPECS 与这里）。
--    语义：按 (as_of, fetched_at, batch_id) 后写覆盖（last-write-wins），幂等；
--    不使用 dwd_bar_revision（修订留痕仅行情 bar，研究数据集为研究态快照）。
--    top_inst 依赖 5000 分档：允许整表为空（SourceAuthError 时 ODS 不产批次）。
-- --------------------------------------------------------------------------

-- 7.1 每日指标（估值/换手/市值/涨跌停状态）——PK (instrument_id, trade_date)
CREATE TABLE IF NOT EXISTS dwd_daily_basic (
    instrument_id               text        NOT NULL,
    trade_date                  date        NOT NULL,
    close                       numeric(18,2) NOT NULL,
    turnover_rate_pct           numeric(10,4),
    free_float_turnover_rate_pct numeric(10,4),
    volume_ratio                numeric(12,4),
    pe                          numeric(14,4),   -- 可负（亏损），不设 CHECK
    pe_ttm                      numeric(14,4),
    pb                          numeric(14,4),   -- 可负（净资产为负）
    ps                          numeric(14,4),
    ps_ttm                      numeric(14,4),
    dividend_yield_pct          numeric(10,4),
    dividend_yield_ttm_pct      numeric(10,4),
    total_shares                numeric(20,2),
    float_shares                numeric(20,2),
    free_float_shares           numeric(20,2),
    total_market_value          numeric(20,2),
    circulating_market_value    numeric(20,2),
    limit_status                text,            -- 源侧涨跌停状态（U/D/Z），P0 不解释
    source                      text        NOT NULL,
    as_of                       timestamptz NOT NULL,
    fetched_at                  timestamptz NOT NULL,
    batch_id                    text        NOT NULL,
    ingested_at                 timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
COMMENT ON TABLE dwd_daily_basic IS '每日指标（PE/PB/换手/市值/涨跌停状态）；单位元/股/百分数，decimal 字符串不丢精度';

-- 7.2 基准指数日线——PK (instrument_id, trade_date)
CREATE TABLE IF NOT EXISTS dwd_index_daily (
    instrument_id   text        NOT NULL,
    trade_date      date        NOT NULL,
    open            numeric(18,2) NOT NULL,
    high            numeric(18,2) NOT NULL,
    low             numeric(18,2) NOT NULL,
    close           numeric(18,2) NOT NULL,
    prev_close      numeric(18,2) NOT NULL,
    change          numeric(18,4) NOT NULL,
    pct_change_pct  numeric(10,4) NOT NULL,
    volume          bigint      NOT NULL CHECK (volume >= 0),      -- 单位：股
    amount          numeric(20,2) NOT NULL CHECK (amount >= 0),    -- 单位：元
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
COMMENT ON TABLE dwd_index_daily IS '基准指数日线（5 个基准指数；指数不在 dim_instrument 时 RES-02 豁免）';

-- 7.3 龙虎榜每日明细——PK (instrument_id, trade_date)
CREATE TABLE IF NOT EXISTS dwd_top_list (
    instrument_id       text        NOT NULL,
    trade_date          date        NOT NULL,
    name                text        NOT NULL,
    close               numeric(18,2) NOT NULL,
    pct_change_pct      numeric(10,4) NOT NULL,
    turnover_rate_pct   numeric(10,4) NOT NULL,
    amount              numeric(20,2) NOT NULL CHECK (amount >= 0),
    lhb_sell_amount     numeric(20,2) NOT NULL CHECK (lhb_sell_amount >= 0),
    lhb_buy_amount      numeric(20,2) NOT NULL CHECK (lhb_buy_amount >= 0),
    lhb_amount          numeric(20,2) NOT NULL CHECK (lhb_amount >= 0),
    lhb_net_amount      numeric(20,2) NOT NULL,   -- 可负（净卖出）
    lhb_net_rate_pct    numeric(10,4) NOT NULL,   -- 可负
    lhb_amount_rate_pct numeric(10,4) NOT NULL,
    float_market_value  numeric(20,2) NOT NULL CHECK (float_market_value >= 0),
    reason              text        NOT NULL,     -- 上榜原因（M05：保留原文，不做归类；一只可多原因上榜，入 PK）
    source              text        NOT NULL,
    as_of               timestamptz NOT NULL,
    fetched_at          timestamptz NOT NULL,
    batch_id            text        NOT NULL,
    ingested_at         timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date, reason)
);
COMMENT ON TABLE dwd_top_list IS '龙虎榜每日明细（M05 保留上榜原因原文，同一股票可因多原因上榜，reason 入 PK）；金额元';

-- 7.4 龙虎榜席位明细——PK (instrument_id, trade_date, seat_name, side, reason)
-- 同一席位+同侧可因多个不同上榜原因重复出现，reason 入 PK 消除误判重复。
CREATE TABLE IF NOT EXISTS dwd_top_inst (
    instrument_id   text        NOT NULL,
    trade_date      date        NOT NULL,
    seat_name       text        NOT NULL,
    side            smallint    NOT NULL CHECK (side IN (0,1)),   -- 0=买入 1=卖出
    buy_amount      numeric(20,2) NOT NULL CHECK (buy_amount >= 0),
    buy_rate_pct    numeric(10,4) NOT NULL,
    sell_amount     numeric(20,2) NOT NULL CHECK (sell_amount >= 0),
    sell_rate_pct   numeric(10,4) NOT NULL,
    net_buy_amount  numeric(20,2) NOT NULL,   -- 可负
    reason          text        NOT NULL,
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date, seat_name, side, reason)
);
COMMENT ON TABLE dwd_top_inst IS '龙虎榜机构/营业部席位明细（5000 分档；整表可为空）';

-- 7.5 个股资金流向五档——PK (instrument_id, trade_date)
CREATE TABLE IF NOT EXISTS dwd_moneyflow (
    instrument_id            text        NOT NULL,
    trade_date               date        NOT NULL,
    buy_small_volume         bigint,
    buy_small_amount         numeric(20,2),
    sell_small_volume        bigint,
    sell_small_amount        numeric(20,2),
    buy_medium_volume        bigint,
    buy_medium_amount        numeric(20,2),
    sell_medium_volume       bigint,
    sell_medium_amount       numeric(20,2),
    buy_large_volume         bigint,
    buy_large_amount         numeric(20,2),
    sell_large_volume        bigint,
    sell_large_amount        numeric(20,2),
    buy_extra_large_volume   bigint,
    buy_extra_large_amount   numeric(20,2),
    sell_extra_large_volume  bigint,
    sell_extra_large_amount  numeric(20,2),
    net_inflow_volume        bigint,          -- 可负
    net_inflow_amount        numeric(20,2),   -- 可负
    source                   text        NOT NULL,
    as_of                    timestamptz NOT NULL,
    fetched_at               timestamptz NOT NULL,
    batch_id                 text        NOT NULL,
    ingested_at              timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
COMMENT ON TABLE dwd_moneyflow IS '个股资金流向五档（量股/额元；缺失为 NULL，禁止补 0）';

-- 7.6 融资融券汇总（交易所维度）——PK (exchange, trade_date)
CREATE TABLE IF NOT EXISTS dwd_margin (
    exchange                     text        NOT NULL CHECK (exchange IN ('SSE','SZSE','BSE')),
    trade_date                   date        NOT NULL,
    financing_balance            numeric(20,2) NOT NULL CHECK (financing_balance >= 0),
    financing_buy_amount         numeric(20,2) NOT NULL CHECK (financing_buy_amount >= 0),
    financing_repayment_amount   numeric(20,2) NOT NULL CHECK (financing_repayment_amount >= 0),
    securities_balance           numeric(20,2) NOT NULL CHECK (securities_balance >= 0),
    securities_sell_volume       bigint      NOT NULL CHECK (securities_sell_volume >= 0),
    margin_balance               numeric(20,2) NOT NULL CHECK (margin_balance >= 0),
    securities_volume            bigint      NOT NULL CHECK (securities_volume >= 0),
    source                       text        NOT NULL,
    as_of                        timestamptz NOT NULL,
    fetched_at                   timestamptz NOT NULL,
    batch_id                     text        NOT NULL,
    ingested_at                  timestamptz NOT NULL,
    PRIMARY KEY (exchange, trade_date)
);
COMMENT ON TABLE dwd_margin IS '两融交易汇总（SSE/SZSE/BSE 三交易所；金额元）';

-- 7.7 北向持股——PK (instrument_id, trade_date)
CREATE TABLE IF NOT EXISTS dwd_hk_hold (
    instrument_id        text        NOT NULL,
    trade_date           date        NOT NULL,
    name                 text        NOT NULL,
    holding_volume       bigint      NOT NULL CHECK (holding_volume >= 0),  -- 股
    holding_ratio_pct    numeric(10,4) NOT NULL CHECK (holding_ratio_pct >= 0 AND holding_ratio_pct <= 100),
    northbound_channel   text        NOT NULL CHECK (northbound_channel IN ('SH','SZ','HK')),
    source               text        NOT NULL,
    as_of                timestamptz NOT NULL,
    fetched_at           timestamptz NOT NULL,
    batch_id             text        NOT NULL,
    ingested_at          timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
COMMENT ON TABLE dwd_hk_hold IS '沪深股通持股明细（港交所源）；持股比例百分数，0–100';

-- ==========================================================================
-- 7.8–7.11 P2 研究数据集（KD-DSW-P2；A1 commit 9ebdb73，字段 provisional）
-- ==========================================================================

-- 7.8 涨跌停价格（stk_limit.v1，日频）——PK (instrument_id, trade_date)
-- 只落 A1 canonical 原始价，不派生 limit_pct / ST 档位（H4 口径待定）。
CREATE TABLE IF NOT EXISTS dwd_stk_limit (
    instrument_id   text        NOT NULL,
    trade_date      date        NOT NULL,
    previous_close  numeric(18,4) NOT NULL CHECK (previous_close > 0),
    up_limit        numeric(18,4) NOT NULL CHECK (up_limit > 0),
    down_limit      numeric(18,4) NOT NULL CHECK (down_limit > 0),
    limit_pct       numeric(10,4),           -- A1 比值分档 5/10/20/30（H4 口径，A2 不派生）
    limit_pct_source text,                   -- exchange_price_ratio | NULL
    asset_type      text        NOT NULL,
    exchange        text        NOT NULL CHECK (exchange IN ('SSE','SZSE','BSE')),
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
COMMENT ON TABLE dwd_stk_limit IS '涨跌停原始价（stk_limit.v1）；不加工 ST/精度档位，原样透传 A1 canonical';

-- 7.9 财务指标宽表（fina_indicator.v1，报告期维度）——PK (instrument_id, report_period)
-- 可见时点 = announced_at（H4：serving/as-of 查询禁止按 report_end_date join，防未来函数）。
CREATE TABLE IF NOT EXISTS dwd_fina_indicator (
    instrument_id                    text        NOT NULL,
    report_period                    text        NOT NULL,  -- YYYYQn
    report_end_date                  date        NOT NULL,
    announced_at                     date        NOT NULL,
    revision_flag                    text,        -- A1 canonical：财报修订标记（源 tushare update_flag）
    ar_turn                          numeric(20,4),
    assets_turn                      numeric(20,4),
    assets_yoy_pct                   numeric(20,4),
    bps                              numeric(20,4),
    bps_yoy_pct                      numeric(20,4),
    current_ratio                    numeric(20,4),
    debt_to_assets                   numeric(20,4),
    dt_eps                           numeric(20,4),
    dt_netprofit_yoy_pct             numeric(20,4),
    ebit                             numeric(20,4),
    ebitda                           numeric(20,4),
    eps                              numeric(20,4),
    eqt_yoy_pct                      numeric(20,4),
    extra_item                       numeric(20,4),
    fixed_assets                     numeric(20,4),
    grossprofit_margin               numeric(20,4),
    inv_turn                         numeric(20,4),
    netprofit_margin                 numeric(20,4),
    netprofit_yoy_pct                numeric(20,4),
    npta                             numeric(20,4),
    ocfps                            numeric(20,4),
    op_yoy_pct                       numeric(20,4),
    or_yoy_pct                       numeric(20,4),
    profit_dedt                      numeric(20,4),
    q_eps                            numeric(20,4),
    q_gsprofit_margin                numeric(20,4),
    q_netprofit_margin               numeric(20,4),
    q_op_qoq_pct                     numeric(20,4),
    q_profit_qoq_pct                 numeric(20,4),
    q_roe                            numeric(20,4),
    q_sales_qoq_pct                  numeric(20,4),
    q_sales_yoy_pct                  numeric(20,4),
    quick_ratio                      numeric(20,4),
    revenue_ps                       numeric(20,4),
    roa                              numeric(20,4),
    roe                              numeric(20,4),
    roe_dt                           numeric(20,4),
    roe_waa                          numeric(20,4),
    roe_yoy_pct                      numeric(20,4),
    roic                             numeric(20,4),
    total_revenue_ps                 numeric(20,4),
    tr_yoy_pct                       numeric(20,4),
    source                           text        NOT NULL,
    as_of                            timestamptz NOT NULL,
    fetched_at                       timestamptz NOT NULL,
    batch_id                         text        NOT NULL,
    ingested_at                      timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, report_period)
);
COMMENT ON TABLE dwd_fina_indicator IS '财务指标宽表（fina_indicator.v1）；可见时点=announced_at，禁止按 report_end_date 做 as-of join（H4 防未来函数）';

-- 7.10 申万行业树（index_classify.v1，append-only 快照）——PK (index_code, snapshot_date)
-- 历史快照不可原地更新；同快照日重跑同主键覆盖（幂等）。历史快照不可回补由 A1 采集约束。
CREATE TABLE IF NOT EXISTS dwd_index_classify (
    index_code             text        NOT NULL,
    snapshot_date          date        NOT NULL,
    industry_name          text        NOT NULL,
    parent_code            text,
    level                  text        NOT NULL,
    industry_code          text        NOT NULL,
    is_published           text        NOT NULL,
    classification_source  text        NOT NULL,
    coverage               text,        -- full_history | current_snapshot_only（A1 _meta；后者不得用于历史回测）
    source                 text        NOT NULL,
    as_of                  timestamptz NOT NULL,
    fetched_at             timestamptz NOT NULL,
    batch_id               text        NOT NULL,
    ingested_at            timestamptz NOT NULL,
    PRIMARY KEY (index_code, snapshot_date)
);
COMMENT ON TABLE dwd_index_classify IS '申万行业树快照（L1/L2/L3）；主键含 snapshot_date，多日快照共存，append-only，历史快照不可回补';

-- 7.11 申万三级成分（index_member_all.v1，时点快照）——PK (instrument_id, l1/l2/l3_code, snapshot_date)
-- 保留 in_date/out_date/is_new 全字段（H4：禁止只存最新快照，否则回测有幸存者偏差）；
-- 支持按任意 as-of 日期查历史成分：WHERE snapshot_date <= :as_of AND in_date <= :as_of AND (out_date IS NULL OR out_date > :as_of)。
CREATE TABLE IF NOT EXISTS dwd_index_member_all (
    instrument_id   text        NOT NULL,
    snapshot_date   date        NOT NULL,
    name            text        NOT NULL,
    l1_code         text        NOT NULL,
    l1_name         text,
    l2_code         text        NOT NULL,
    l2_name         text,
    l3_code         text        NOT NULL,
    l3_name         text,
    in_date         date        NOT NULL,
    out_date        date,
    is_new          text        NOT NULL CHECK (is_new IN ('Y','N')),
    coverage        text,        -- full_history | current_snapshot_only（A1 _meta；后者不得用于历史回测）
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, l1_code, l2_code, l3_code, snapshot_date)
);
COMMENT ON TABLE dwd_index_member_all IS '申万三级成分时点快照；保留 in_date/out_date/is_new，多日快照共存，支持任意 as-of 历史成分（防幸存者偏差）';

-- --------------------------------------------------------------------------
-- 实时行情快照（AKshare 东方财富源，A1 P1 任务）
--    * 来源 = akshare_eastmoney（爬虫封装东方财富），合规标注 F1 residual
--    * 快照 append-only，多时点共存，serving 层取最新
--    * 单位：volume=股、amount=元（C09）
--    * 涨跌幅/换手率为百分比数值（如 3.25 表示 3.25%）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_realtime_quote (
    instrument_id   text        NOT NULL,
    as_of           timestamptz NOT NULL,                           -- 快照市场时点 +08:00（C04）
    last            numeric(18,2) NOT NULL,                         -- 最新价
    prev_close      numeric(18,2) NOT NULL,                         -- 昨收
    open            numeric(18,2) NOT NULL,                         -- 今开
    high            numeric(18,2) NOT NULL,                         -- 最高
    low             numeric(18,2) NOT NULL,                         -- 最低
    volume          bigint      NOT NULL CHECK (volume >= 0),      -- 单位：股（C09）
    amount          numeric(20,2) NOT NULL CHECK (amount >= 0),    -- 单位：元（C09）
    pct_change      numeric(8,4),                                   -- 涨跌幅（%），如 3.25
    change          numeric(18,2),                                  -- 涨跌额（元）
    turnover_rate   numeric(8,4),                                   -- 换手率（%）
    volume_ratio    numeric(8,4),                                   -- 量比
    limit_status    text        CHECK (limit_status IS NULL OR limit_status IN ('limit_up','limit_down','none')),
    source          text        NOT NULL,                           -- canonical 来源标识（C03）
    fetched_at      timestamptz NOT NULL,                           -- 采集时间，仅审计（C04）
    batch_id        text        NOT NULL,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (instrument_id, as_of)
);
COMMENT ON TABLE dwd_realtime_quote IS '实时行情快照（AKshare 东方财富源），append-only 多时点共存，serving 取最新（F1 residual / SEC-012：爬虫源仅限内部研究/展示，C 端实时行情展示未放行待 H3/H4 书面裁）';
-- --------------------------------------------------------------------------
-- 数据中台 P1 补完（L169）：东财板块数据（dc_index 行情 / dc_member 成分股）
--    * 来源 = tushare（dc_index doc=362 6000 分 / dc_member doc=363 6000 分，需 .DC 后缀）
--    * dc_index: 板块日行情（含 leading_name/pct_change/total_mv/turnover_rate/up_num/down_num）
--    * dc_member: 板块成分股快照（append-only 多日共存；PK (board_code, trade_date, instrument_id)）
--    * 仅内部使用（Console 数据中台 /v1/internal/data-platform），C 端不接
--    * 板块代码形态 = XXXXXX.DC；instrument_id 走 A1 canonical 形态（如 SSE:600519）
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dwd_dc_index (
    board_code      text        NOT NULL,                          -- 板块代码，如 BK1184.DC
    trade_date      date        NOT NULL,
    board_name      text        NOT NULL,
    leading_name    text,                                          -- 领涨股名
    leading_code    text,                                          -- 领涨股代码（A1 canonical）
    pct_change      numeric(10,4),                                 -- 板块涨跌幅（%）
    leading_pct     numeric(10,4),                                 -- 领涨股涨跌幅（%）
    total_mv        numeric(20,2),                                 -- 板块总市值（元）
    turnover_rate   numeric(10,4),                                 -- 板块换手率（%）
    up_num          integer       CHECK (up_num   IS NULL OR up_num   >= 0),
    down_num        integer       CHECK (down_num IS NULL OR down_num >= 0),
    idx_type        text,                                          -- 板块类型（N=概念/行业/地域）
    level           text,                                          -- L1/L2/L3（地域/概念无级）
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (board_code, trade_date)
);
COMMENT ON TABLE dwd_dc_index IS '东财板块行情（概念/行业/地域，tushare dc_index doc=362 6000 分）；金额元，涨跌幅 %';

CREATE TABLE IF NOT EXISTS dwd_dc_member (
    trade_date      date        NOT NULL,
    board_code      text        NOT NULL,                          -- 板块代码，如 BK1184.DC
    instrument_id   text        NOT NULL,                          -- 成分股（A1 canonical，如 SSE:600519）
    name            text,                                          -- 成分股名
    source          text        NOT NULL,
    as_of           timestamptz NOT NULL,
    fetched_at      timestamptz NOT NULL,
    batch_id        text        NOT NULL,
    ingested_at     timestamptz NOT NULL,
    PRIMARY KEY (board_code, trade_date, instrument_id)
);
COMMENT ON TABLE dwd_dc_member IS '东财板块成分股快照（tushare dc_member doc=363 6000 分；append-only 多日共存，支持任意 as-of 板块成分回溯）';


-- L172 第一批（15000 档全量接入，20 数据集）
-- 口径：daily/weekly/monthly 存 OHLCV（复用 stock_bar_daily 语义，但独立表）
CREATE TABLE IF NOT EXISTS dwd_research_daily (
    instrument_id text NOT NULL, trade_date date NOT NULL,
    open numeric(18,2), high numeric(18,2), low numeric(18,2), close numeric(18,2),
    prev_close numeric(18,2), change_ numeric(18,4), pct_change_pct numeric(10,4),
    volume bigint, amount numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, trade_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_weekly (
    instrument_id text NOT NULL, trade_date date NOT NULL,
    open numeric(18,2), high numeric(18,2), low numeric(18,2), close numeric(18,2),
    prev_close numeric(18,2), change_ numeric(18,4), pct_change_pct numeric(10,4),
    volume bigint, amount numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, trade_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_monthly (
    instrument_id text NOT NULL, trade_date date NOT NULL,
    open numeric(18,2), high numeric(18,2), low numeric(18,2), close numeric(18,2),
    prev_close numeric(18,2), change_ numeric(18,4), pct_change_pct numeric(10,4),
    volume bigint, amount numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, trade_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_new_share (
    instrument_id text NOT NULL, announced_at date,
    subscription_date date, listing_date date,
    issue_price numeric(18,4), issue_volume bigint, lottery_date date, raise_funds numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id)
);
CREATE TABLE IF NOT EXISTS dwd_research_income (
    instrument_id text NOT NULL, announced_at date, report_end_date date NOT NULL,
    total_revenue numeric(20,2), revenue numeric(20,2), operating_cost numeric(20,2),
    total_operating_cost numeric(20,2), operating_profit numeric(20,2), total_profit numeric(20,2),
    net_profit numeric(20,2), net_profit_parent numeric(20,2),
    basic_eps numeric(18,6), diluted_eps numeric(18,6),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, report_end_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_balancesheet (
    instrument_id text NOT NULL, announced_at date, report_end_date date NOT NULL,
    total_assets numeric(20,2), total_liabilities numeric(20,2), total_equity numeric(20,2),
    current_assets numeric(20,2), noncurrent_assets numeric(20,2),
    current_liabilities numeric(20,2), noncurrent_liabilities numeric(20,2),
    receivables numeric(20,2), inventory numeric(20,2), goodwill numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, report_end_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_cashflow (
    instrument_id text NOT NULL, announced_at date, report_end_date date NOT NULL,
    operating_cashflow numeric(20,2), investing_cashflow numeric(20,2),
    financing_cashflow numeric(20,2), net_cashflow numeric(20,2), capex numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, report_end_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_forecast (
    instrument_id text NOT NULL, announced_at date, report_end_date date NOT NULL,
    forecast_type text, net_profit_min numeric(10,4), net_profit_max numeric(10,4),
    net_profit numeric(20,2), reason text,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, report_end_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_express (
    instrument_id text NOT NULL, announced_at date, report_end_date date NOT NULL,
    revenue numeric(20,2), net_profit numeric(20,2),
    yoy_netprofit_pct numeric(10,4), qoq_netprofit_pct numeric(10,4),
    yoy_revenue_pct numeric(10,4), qoq_revenue_pct numeric(10,4),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, report_end_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_dividend (
    instrument_id text NOT NULL, announced_at date, report_end_date date NOT NULL,
    dividend_per_share numeric(18,6), stock_dividend_ratio numeric(18,6),
    record_date date, ex_date date, payment_date date,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, report_end_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_pledge_detail (
    instrument_id text NOT NULL, announced_at date,
    pledge_count int, pledge_ratio_pct numeric(10,4), total_shares_pledged bigint, pledge_value numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, announced_at)
);
CREATE TABLE IF NOT EXISTS dwd_research_pledge_stat (
    instrument_id text NOT NULL, announced_at date,
    pledge_count int, unpledge_count int, pledge_ratio_pct numeric(10,4),
    total_shares_pledged bigint, total_pledge_ratio_pct numeric(10,4),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, announced_at)
);
CREATE TABLE IF NOT EXISTS dwd_research_margin_detail (
    instrument_id text NOT NULL, trade_date date NOT NULL,
    financing_balance numeric(20,2), securities_balance numeric(20,2),
    securities_sell_volume bigint, margin_balance numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, trade_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_repurchase (
    instrument_id text NOT NULL, announced_at date, report_end_date date,
    repurchase_volume bigint, repurchase_amount numeric(20,2),
    repurchase_high numeric(18,2), repurchase_low numeric(18,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, announced_at, report_end_date)
);
CREATE TABLE IF NOT EXISTS dwd_research_share_float (
    instrument_id text NOT NULL, float_date date,
    float_share bigint, float_ratio_pct numeric(10,4), holder_name text, share_type text,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, float_date, holder_name)
);
CREATE TABLE IF NOT EXISTS dwd_research_block_trade (
    instrument_id text NOT NULL, trade_date date NOT NULL,
    price numeric(18,4), volume bigint, amount numeric(20,2), buyer text, seller text,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, trade_date, buyer, seller)
);
CREATE TABLE IF NOT EXISTS dwd_research_stk_holdernumber (
    instrument_id text NOT NULL, announced_at date, report_end_date date,
    holder_number bigint, holder_number_change bigint,
    avg_market_value numeric(20,2), avg_hold_volume bigint,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, announced_at)
);
CREATE TABLE IF NOT EXISTS dwd_research_stk_holdertrade (
    instrument_id text NOT NULL, holder_name text NOT NULL, announced_at date,
    change_date date, change_volume bigint, change_ratio_pct numeric(10,4),
    avg_price numeric(18,4), total_shares bigint, direction text,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, holder_name, change_date)
);

-- L172 第二批（指数/基金/期货/期权/债券/外汇，21 数据集）

CREATE TABLE IF NOT EXISTS dwd_research_index_weekly (
    instrument_id text NOT NULL, trade_date date NOT NULL,
    open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4),
    prev_close numeric(18,4), change_ numeric(18,6), pct_change_pct numeric(10,4),
    volume bigint, amount numeric(20,2), open_interest bigint,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, trade_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_index_monthly (
    instrument_id text NOT NULL, trade_date date NOT NULL,
    open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4),
    prev_close numeric(18,4), change_ numeric(18,6), pct_change_pct numeric(10,4),
    volume bigint, amount numeric(20,2), open_interest bigint,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instrument_id, trade_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_index_basic (
    index_code text NOT NULL, name text NOT NULL,
    market text, publisher text, category text, base_date date, base_point numeric(18,4), listing_date date,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (index_code)
);

CREATE TABLE IF NOT EXISTS dwd_research_fund_daily (
    fund_code text NOT NULL, trade_date date NOT NULL,
    open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4),
    prev_close numeric(18,4), change_ numeric(18,6), pct_change_pct numeric(10,4),
    volume bigint, amount numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (fund_code, trade_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_fund_basic (
    fund_code text NOT NULL, name text NOT NULL,
    management_company text, custodian text, fund_type text,
    established_date date, listing_date date, issue_date date, delisting_date date, issue_amount bigint,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (fund_code)
);

CREATE TABLE IF NOT EXISTS dwd_research_fund_company (
    company_code text NOT NULL, name text NOT NULL,
    short_name text, established_date date, registered_capital numeric(20,2), city text,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (company_code)
);

CREATE TABLE IF NOT EXISTS dwd_research_fund_nav (
    fund_code text NOT NULL, announced_at date NOT NULL,
    unit_nav numeric(18,6), accumulated_nav numeric(18,6),
    unit_nav_return_pct numeric(10,4), accum_nav_return_pct numeric(10,4),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (fund_code, announced_at)
);

CREATE TABLE IF NOT EXISTS dwd_research_fund_div (
    fund_code text NOT NULL, announced_at date,
    imp_announced_at date, dividend_per_unit numeric(18,6),
    record_date date, ex_date date, payment_date date,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (fund_code, announced_at)
);

CREATE TABLE IF NOT EXISTS dwd_research_fut_basic (
    futures_code text NOT NULL, name text NOT NULL,
    exchange text, contract_unit text, listing_date date, delisting_date date, delivery_month text,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (futures_code)
);

CREATE TABLE IF NOT EXISTS dwd_research_trade_cal (
    exchange text NOT NULL, calendar_date date NOT NULL,
    is_open text, prev_trade_date date,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (exchange, calendar_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_fut_daily (
    futures_code text NOT NULL, trade_date date NOT NULL,
    open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4),
    settlement numeric(18,4), prev_settlement numeric(18,4),
    volume bigint, amount numeric(20,2), open_interest bigint,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (futures_code, trade_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_fut_holding (
    futures_code text NOT NULL, trade_date date NOT NULL, broker text NOT NULL,
    long_volume bigint, long_change bigint, short_volume bigint, short_change bigint,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (futures_code, trade_date, broker)
);

CREATE TABLE IF NOT EXISTS dwd_research_fut_wsr (
    futures_code text NOT NULL, trade_date date NOT NULL,
    warehouse_receipt bigint, change bigint,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (futures_code, trade_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_fut_settle (
    futures_code text NOT NULL, trade_date date NOT NULL,
    settlement_price numeric(18,4), settlement_margin numeric(10,4),
    settlement_fee numeric(18,6), delivery_price numeric(18,4),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (futures_code, trade_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_opt_basic (
    option_code text NOT NULL, name text NOT NULL,
    exchange text, underlying_code text, option_type text, exercise_price numeric(18,4),
    listing_date date, expiry_date date,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (option_code)
);

CREATE TABLE IF NOT EXISTS dwd_research_opt_daily (
    option_code text NOT NULL, trade_date date NOT NULL,
    open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4),
    settlement numeric(18,4), prev_settlement numeric(18,4),
    volume bigint, amount numeric(20,2), open_interest bigint,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (option_code, trade_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_cb_basic (
    bond_code text NOT NULL, name text NOT NULL,
    underlying_code text, underlying_name text, issue_price numeric(18,4),
    issue_volume bigint, listing_date date, maturity_date date,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (bond_code)
);

CREATE TABLE IF NOT EXISTS dwd_research_cb_issue (
    bond_code text NOT NULL, name text NOT NULL, underlying_code text,
    announced_at date, listing_date date, issue_price numeric(18,4),
    issue_volume bigint, coupon numeric(10,4), maturity_years numeric(10,4),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (bond_code)
);

CREATE TABLE IF NOT EXISTS dwd_research_cb_daily (
    bond_code text NOT NULL, trade_date date NOT NULL,
    open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4),
    prev_close numeric(18,4), change_ numeric(18,6), pct_change_pct numeric(10,4),
    volume bigint, amount numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (bond_code, trade_date)
);

CREATE TABLE IF NOT EXISTS dwd_research_fx_obasic (
    fx_code text NOT NULL, name text NOT NULL,
    exchange text, base_currency text, quote_currency text, listing_date date,
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (fx_code)
);

CREATE TABLE IF NOT EXISTS dwd_research_fx_daily (
    fx_code text NOT NULL, trade_date date NOT NULL,
    open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4),
    volume bigint, amount numeric(20,2),
    source text NOT NULL, as_of timestamptz NOT NULL, batch_id text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (fx_code, trade_date)
);