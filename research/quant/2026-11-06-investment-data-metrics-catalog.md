# 投研数据口径表 v0.1（个股行情 / 基本面摘要 / 研究域数据集）

> **固定标识（不可关闭）：AI 生成 · 仅供参考**
>
> 本稿为 **内部研究稿**（A10 编制，2026-11-06）。未经 A16 合规复核与 H3 终审，**不得对外发布、不得进入 C 端展示**。
> 本文是"字段 → 口径 → 频率 → 来源 → as_of → 缺失处理"的对照清单，只做口径映射与证据登记；文中任何数字均为**已发生事实的转述或算术校验**，**非投资建议**，不构成任何买卖依据。

## 0. 元信息

| 项 | 值 |
|---|---|
| 文档 | research/quant/2026-11-06-investment-data-metrics-catalog.md |
| 编制 | A10 research-equity（research/quant 写域；其余域只读） |
| 编制时间 | 2026-11-06T15:25+08:00 |
| 版本 | v0.1（内部草稿；待 A2 字段复核、H4 口径确认、H3 终审） |
| 口径权威源 | `docs/metrics/P0-metrics.md`（505 行，H4 首签 2026-11-04、M04/RES-05 补签 2026-11-05）与 `docs/metrics/p0_metrics.json`（version 1，sign_off.status=signed） |
| 契约源 | `contracts/market/openapi.yaml` v0.4.0；`contracts/fundamental/openapi.yaml` v0.2.0；`contracts/shared/openapi.yaml`（ResponseMeta / InstrumentId） |
| 字段源 | `warehouse/serving/schema.sql:215-232`（research 视图）、`warehouse/dwd/schema.sql`（17 张 dwd 表） |
| 数据源通道 | tushare mirror（`source_channel=third_party_mirror`、`authorization_status=unverified_third_party`，只研究域内部） |
| 真实数据证据 | `tests/fixtures/tushare/real-sample-20261105/`（H4 m02923 一次性授权；`production_evidence=false`；`display_safe=false`） |
| 服务状态 | PG@55432 可连接（本机 role 未知，未取数）；API@8081 未鉴权返回 401；Web@3000 200 |
| 本文性质 | 口径地图 + 证据登记；**不新增口径**；与 P0-metrics 冲突时以 H4 签字版为准并回 H4 |

**上游任务**：task-16（`[A10] 投研数据口径表 + 标的/基金/资金面首批研究`），验收①②③④见任务板。

---

## 1. 全表通用约定（先读）

| # | 约定 | 内容 | 依据 |
|---|---|---|---|
| U1 | 响应四要素 | 每个成功响应必须带 `data` + `meta.source`（`as_of` / `staleness_ms`）+ `data_entitlement` + `disclaimer`；缺 copy 版本 → 500 不降级 | ADR-007 P7；`contracts/shared/openapi.yaml` ResponseMeta |
| U2 | 权限 | 未获授权数据集返回 **403 EntitlementRestricted**；禁止 200 + `is_entitled=false` 的假成功 | A10 红线③；ADR-007 |
| U3 | 缺失三态 | ①字段级 `null`（有语义的空：停牌无价、亏损无 PE）；②缺口码（`STK_LIMIT_PRECISE_PENDING`、`MARKET_BREADTH_PENDING`、`DAILY_BASIC_MISSING` 等，见 `contracts/market/openapi.yaml:431-437`）；③无记录（404 或空列表 + gaps）。**禁止用 0 或空串冒充缺失** | 契约 Gap；M01/M08；FUN-01 |
| U4 | as_of | `as_of` = 数据**在源头可得/生效**的时刻，不是 `fetched_at`；快照类 = 快照日；披露类 = `announced_at`；日频类 = 交易日收盘时刻（C2=A，T 日 20:00 后） | ADR-007 P7；P0-metrics §0 |
| U5 | 时点纪律 | 财报/指标一律按 **可见时点 join**（`announced_at`），禁止按 `report_end_date` join 制造未来函数；成分/分类按 `snapshot_date` 取 `max(<=as_of)` | P0-metrics M06/M07；serving 视图注释 |
| U6 | 复权 | 日线主口径 = **不复权**（`adjustment` 缺省 `none`）；后复权 `hfq = close × factor`，随输出下发 `anchor_date` / `factor_version` / `factor_as_of`；HFQ 绝对价不进 C 端 | P0-metrics M01/M02 |
| U7 | 单位 | 价格：元（沪市 B 股 **美元**、深市 B 股 **港元**）；成交量：股；成交额：元；财务金额：元；比率：**百分数数值**（`1.23` 表示 1.23%）；EPS：元/股 | `contracts/market/openapi.yaml:305,371`；`contracts/fundamental/openapi.yaml` FundSummary |
| U8 | 停牌/无成交 | 停牌日不合成 K 线（无 bar），不得 0 填充；停牌快照保留 `suspended=true` 证据行（L8）；`last_price/change/change_pct` 允许 `null` | 契约 bars/quote；P0-metrics L8 |
| U9 | 标识 | `instrument_id = EXCHANGE:CODE`（如 `SSE:600519`、`BSE:920000`）；北交所历史统一 920 段（旧 43/83/87/88 无序列，需 alias 表，见 §9 注） | 真实样本 `stk_limit_rounding_rules.json.bse_legacy_codes` |
| U10 | 研究域隔离 | research 视图/数据集**只进 internal**，不进 `ports.yaml`、不进 serving 对外视图、不进 C 端 | `warehouse/serving/schema.sql` §7.8–7.11 注释；decisions.md:1380 附近 |

---

## 2. 标的维表（instrument）

数据对象：`dim_instrument`（`warehouse/dwd/schema.sql:61`）/ `contracts/market/openapi.yaml` Instrument / serving_instrument。

| 字段 | 口径 / 单位 | 频率 | 来源 | as_of | 缺失处理 | 状态 |
|---|---|---|---|---|---|---|
| instrument_id | `EXCHANGE:CODE`；交易所 enum SSE/SZSE/BSE（新增交易所须 H2 签字） | 快照（每日全量刷新） | tushare stock_basic | 该批 `fetched_at` | 无 ID 即无法入库（fail-closed） | 生产可用 |
| name | 证券简称（当前名称快照，**非历史**） | 同上 | stock_basic | 同上 | 空 → 拒绝 | 生产可用 |
| exchange / board | board ∈ main/gem/star/bse；H4 涨跌停/涨跌幅按板块规则 | 同上 | stock_basic + 代码段映射 | 同上 | 未知板块 → **BIZ-01 blocker（fail-closed）** | 生产可用 |
| security_type | P0 仅 `stock`；转债/基金/指数不入股票口径 | 同上 | stock_basic | 同上 | 非 stock → 不进股票域统计 | 生产可用 |
| list_status | listed / delisted（P0 仅这两态） | 同上 | stock_basic | 同上 | 未知 → 拒绝 | 生产可用 |
| listed_at | 上市日 `YYYY-MM-DD` | 同上 | stock_basic list_date | 同上 | `NULL` → 涨跌停首日豁免不可判定，fail-closed；覆盖率 >1% 须回 H4 | 生产可用（口径见 M04 条件） |
| lot_size | 最小交易单位（股） | 同上 | stock_basic | 同上 | 缺失 → 展示降级，不参与计算 | 生产可用 |

**已知限制**：ST 状态只用 `dim_instrument.name` 的**当前名称快照**（`st_by_current_name`，L80），不还原历史戴帽/摘帽/退市；跨窗口的 ST 判定不作为 blocker（BIZ-03 warn）。→ 实证见 `research/quant/2026-11-06-limit-price-structure.md` §4。

---

## 3. 个股行情日线（不复权主口径）

数据对象：`dwd_stock_bar_daily`（`warehouse/dwd/schema.sql:15`）/ `contracts/market/openapi.yaml` Bar / M01 SQL `warehouse/metrics/m01_bars_none.sql`。

| 字段 | 口径 / 单位 | 频率 | 来源 | as_of | 缺失处理 | 状态 |
|---|---|---|---|---|---|---|
| trade_date | A 股交易日（非自然日） | 日频 | tushare daily | T 日收盘后 | 非交易日无行 | 生产可用 |
| open/high/low/close | 元，两位小数；**不复权**；B 股按本币报价单位（沪 B 0.001 美元、深 B 0.01 港元） | 日频 | tushare daily | T 日 20:00 后 | 停牌无行（不合成） | 生产可用 |
| prev_close | 前收盘价（元）；除权日以除权参考价为基准 | 日频 | tushare daily pre_close | 同上 | `NULL` → 涨跌幅 `NULL`，不得回退 0 | 生产可用 |
| volume | **股** | 日频 | tushare daily vol（手）→ ×100 归一 | 同上 | 无成交 → 0 是真实值（与缺失不同态） | 生产可用 |
| amount | **元** | 日频 | tushare daily amount（千元）→ ×1000 | 同上 | 同上 | 生产可用 |
| suspended | 停牌标记；停牌保留 `suspended=true` 证据行 | 日频 | 停牌表/日线缺口 | T 日 | 缺口即 evidence，不补 0 | 生产可用 |
| source / as_of / staleness_ms | 响应级元信息，逐行冗余 | 每行 | 批元数据 | 批 fetched_at | 缺 → 拒绝出接口 | 生产可用 |

**质量门**：BAR 连续性、价格 ≤0、OHLC 关系、成交量为负等为 blocker（L9 只计 blocker，阈值 95/90/85，一票否决）。
**M01 输出契约**：不复权字段直接对外；`adjustment` 必须在 data 与 meta 双回显（契约测试断言）。

---

## 4. 复权与收益（M02）

| 字段 | 口径 / 单位 | 频率 | 来源 | as_of | 缺失处理 | 状态 |
|---|---|---|---|---|---|---|
| adj_factor | 复权因子（无量纲，基准 1.0 = **最早可得因子日**） | 日频 | tushare adj_factor | 因子发布时点 | 缺失 → 该日 hfq 不输出（不插值） | 可执行（M02） |
| hfq_close 等 | `hfq = close × adj_factor`；绝对价**不进 C 端**，只在研究域计算 | 日频 | 派生 | 随 bar + factor | 因子缺失 → 不输出 | 可执行 |
| anchor_date / factor_version / factor_as_of | 复权锚与版本，随输出下发；**锚变更 = 口径变更，须重新会签** | 每批 | P0-metrics M02 | 批元数据 | 缺 → 拒绝 | 可执行 |
| 区间收益 | `hfq_end / hfq_start − 1`，仅研究域/自选区间统计 | 按需 | 派生 | 区间端点 as_of | 端点缺失 → 不输出 | 研究域可用 |

**禁止**：用不复权价算跨除权区间收益；用 HFQ 绝对价做任何对外展示或跨标的比较。

---

## 5. 涨跌停与涨跌幅（M04 / M08）

数据对象：`dwd_stk_limit`（`warehouse/dwd/schema.sql:325`）/ `serving_research_stk_limit`（internal-only，§7.8）/ M04 SQL `warehouse/metrics/m04_limit_status.sql`。

| 字段 | 口径 / 单位 | 频率 | 来源 | as_of | 缺失处理 | 状态 |
|---|---|---|---|---|---|---|
| previous_close | 前收盘（元，本币报价单位） | 日频 | stk_limit.pre_close | 交易日 | 缺失 → 该行不判涨跌停 | 研究域可用 |
| up_limit / down_limit | 涨停价 / 跌停价（元）；**BSE：涨停 floor、跌停 ceil**；沪深 A half-up 至 0.01；沪 B 0.001 美元；深 B 0.01 港元 | 日频 | stk_limit | 交易日 | 缺失 → `null`，不得 0 填充 | 研究域可用 |
| limit_pct | 档位：5 / 10 / 20 / 30（%）；由板块 + 时点 + ST/S 股 + 上市状态决定 | 日频 | 派生（M04） | 交易日 | 无法判定 → `NULL`（如上市首日、注册制新股前 5 交易日、BSE 部分行） | 研究域可用 |
| limit_pct_source | 档位来源（板块规则/ST 快照/首日豁免等），审计用 | 日频 | 派生 | 交易日 | 缺 → 质量 warn | 研究域可用 |
| effective ratio（如 `ratio_pct`） | `(up_limit / pre_close − 1) × 100`，**实测有效幅度**，受舍入影响**不等于标称档位**（实测 000564.SZ：1.35→1.49 = 10.37%） | 日频 | 派生（样本文件字段） | 交易日 | — | 研究域可用 |
| 涨跌幅 change_pct（M08） | `close / prev_close − 1`，百分数；除权日以除权参考价为基准 | 日频 | 派生 | T 日 | 基准缺失 → `NULL`，**禁 0 冒充** | 生产可用 |

**M04 档位速查**（以 P0-metrics §3 为准）：
主板 10%；ST：<2026-07-06 为 5%、≥2026-07-06 为 10%；**S 股 5% 优先**；创业板 <2020-08-24 10% / ≥2020-08-24 20%；科创板 20%；北交所 <2021-11-15 `NULL` / ≥2021-11-15 30%；上市首日 `NULL`；注册制新股前 5 个交易日 `NULL`。

**实测校准（真实受控样本 2026-11-03..05，5655 行/日）**：
- 5% 档全市场仅 1 行（`600182.SH S佳通`，S 股优先，符合 M04）；
- 198 只 ST **无一落在 5% 档**（142 只 10%、53 只 20%、1–2 只 30%、1–2 只 NULL）→ 与 M04「ST 5%」表面冲突，属 **L80 当前名称快照 + 源端不返回 ST 5% 档行**的已知限制，按 blocker 处理前须 A2/H4 复核；
- 30% 档全部为 BSE，且 BSE 中约一半行 `limit_pct=NULL`（原因未逐一核验，列 §14 待查）；
- `5655 行/日` 与在册 5578 只的差额 ≈ B 股 76 行（沪 B 41 + 深 B 35）+ 1 行待核。

---

## 6. 基本面摘要（FUN-01，P0）

数据对象：`serving_fundamental_summary`（当前仅少量标的）/ `contracts/fundamental/openapi.yaml` v0.2.0 `FundamentalSummary`。

| 字段 | 口径 / 单位 | 频率 | 来源 | as_of | 缺失处理 | 状态 |
|---|---|---|---|---|---|---|
| instrument_id | `EXCHANGE:CODE` | 季度（披露驱动） | income + fina_indicator | — | 无 | 生产可用（覆盖待扩） |
| report_period | `YYYYQn`（如 `2023Q4`），累计口径 | 季度 | 派生 | — | 不符 pattern → 拒绝 | 生产可用 |
| report_end_date | 报告期末 `YYYY-MM-DD` | 季度 | income.end_date | — | 缺 → 拒绝 | 生产可用 |
| announced_at | **首次公告时刻**（可见时点；restated 另有修订时点） | 季度 | income.ann_date | 公告日 | 缺 → 该期不可见（fail-closed） | 生产可用 |
| statement_basis | `reported` / `restated` 并存（M06：P0 只立法） | 季度 | 派生 | — | 未知 → 拒绝 | reported 可用 |
| currency | `CNY`（P0 仅 A 股） | 季度 | 派生 | — | 非 CNY → 拒绝 | 生产可用 |
| revenue | 营业收入，**元** | 季度 | income.revenue | as_of=announced_at | `null` 允许，**禁 0 冒充** | 生产可用 |
| net_profit | 归母净利润，**元** | 季度 | income.n_income_attr_p | 同上 | 同上 | 生产可用 |
| revenue_yoy_pct / net_profit_yoy_pct | 同比 %（与上年同期比，**只历史已披露**） | 季度 | income/fina_indicator | 同上 | `null` 允许 | 生产可用 |
| eps | 元/股 | 季度 | fina_indicator.eps | 同上 | `null` | 生产可用 |
| roe_pct | 净资产收益率 %（**须注明摊薄/加权口径**，见 §7） | 季度 | fina_indicator | 同上 | `null` | 生产可用 |
| gross_margin_pct | 毛利率 % | 季度 | fina_indicator.grossprofit_margin | 同上 | `null` | 生产可用 |
| total_assets | 总资产，元 | 季度 | 资产负债表 | 同上 | `null`（可空） | 生产可用（未进本批） |

**禁止**：业绩趋势外推、未来盈利预测、"将持续"式表述（FUN-01/03/04 + H3-C10）。

---

## 7. 财务指标扩展（fina_indicator，研究域）

数据对象：`dwd_fina_indicator`（`warehouse/dwd/schema.sql:346`）/ `serving_research_fina_indicator`（internal-only）。

| 字段 | 口径 / 单位 | 说明 |
|---|---|---|
| eps | 元/股 | 与 income 反算股本自洽（实测：归母净利 747.34 亿 / 59.49 = 12.5625 亿股） |
| roe | %（摊薄口径，源定义） | 与 roe_waa、roe_dt 三口径并存，**禁止混用** |
| roe_waa | %（加权平均 ROE） | 对外优先引用时须写明"加权" |
| roe_dt | %（扣非摊薄） | 研究域 |
| bps | 元/股 | 每股净资产 |
| total_revenue_ps / revenue_ps | 元/股 | 每股营业总收入 / 每股营业收入 |
| netprofit_margin | % | **分母 = 营业收入，分子 = 净利润（含少数股东损益）**；实测反推 775.21 亿，与归母 747.34 亿差 27.87 亿（少数股东损益）→ 以归母净利反算会得 50.60%，口径不同，**不可混算** |
| grossprofit_margin | % | 毛利率 |
| or_yoy / netprofit_yoy | % | 营业总收入同比 / 归母净利同比 |
| report_period / report_end_date / announced_at / revision_flag | — | 时点字段；可见时点 = `announced_at`，禁按 `report_end_date` join |

**单位证据**：`tests/fixtures/tushare/real-sample-20261105/fina_indicator_600519_20231231.json`（`note`：eps=59.49 元/股、roe_waa=34.19%、ann_date=20240403）；`income_600519_20231231.json`（total_revenue=150560330316.45 元、n_income_attr_p=74734071550.75 元）。

---

## 8. 估值（daily_basic，P1 待建视图/契约）

数据对象：`dwd_daily_basic`（`warehouse/dwd/schema.sql:153`）/ `serving_research_daily_basic`（internal-only）/ `warehouse/serving/schema.sql:215-232`。

| 字段 | 口径 / 单位 | 频率 | 来源 | 缺失处理 | 状态 |
|---|---|---|---|---|---|
| close | 元（当日不复权收盘） | 日频 | daily_basic | 停牌 → null | 研究域可用 |
| turnover_rate_pct / free_float_turnover_rate_pct | 换手率 %（总股本 / 自由流通股本分母） | 日频 | 同上 | null | 研究域可用 |
| volume_ratio | 量比（倍） | 日频 | 同上 | null | 研究域可用 |
| pe / pe_ttm / pb / ps / ps_ttm | 倍；**亏损 → null**（不得填 0 或负值） | 日频 | 同上 | null | 研究域可用 |
| dividend_yield_pct / dividend_yield_ttm_pct | 股息率 % | 日频 | 同上 | null | 研究域可用 |
| total_shares / float_shares / free_float_shares | 股 | 日频 | 同上 | null | 研究域可用 |
| total_market_value / circulating_market_value | 元 | 日频 | 同上 | null | 研究域可用 |
| limit_status | 涨跌停状态（与 M04 联动） | 日频 | 派生 | null | 研究域可用 |

**边界**：`daily_basic` 当前**无 serving 对外 view、无契约** → 严禁在 C 端以任何形式出现；估值字段禁止"低估/高估/合理价位"表述（FUN-02）。

---

## 9. 研究域资金面数据集（P1，internal-only，无 serving view）

通道：tushare mirror（`third_party_mirror` / `unverified_third_party`，只研究域内部，不进 C 端）。
**2026-11-04 单日实测行数**（H4 m03540，`stk_limit_rounding_rules.json.source_consistency_probe_20261104`）：

| 数据集 | 字段（serving 视图口径） | 频率 | 单日实测 | 覆盖/功效含义 | 状态 |
|---|---|---|---|---|---|
| moneyflow | buy/sell × small/medium/large/extra_large 的 volume+amount；net_inflow_volume / net_inflow_amount | 日频 | 5578 行 | = 在册股票数 5578 → 全市场 1 行/标的/日 | 无 serving view；研究域可用 |
| margin | exchange、financing_balance、financing_buy_amount、financing_repayment_amount、securities_balance、securities_sell_volume、margin_balance、securities_volume | 日频 | 3 行 | **交易所维度聚合**（SSE/SZSE/BSE），**无个股两融** | 无 serving view；只能做市场级 |
| top_list | name、close、pct_change_pct、turnover_rate_pct、amount、lhb_*（买卖/净额/占比）、float_market_value、**reason** | 日频 | 84 行 | 龙虎榜日样本 ≈ 84/5578 ≈ 1.5%（含转债，已排除；股票口径更小） | 无 serving view；研究域可用 |
| top_inst | seat_name、side、buy/sell amount+rate、net_buy_amount、**reason** | 日频 | 840 行 | ≈ 84 榜 × 10 席位 | 无 serving view；研究域可用 |
| hk_hold | instrument_id、name、holding_volume、holding_ratio_pct、northbound_channel | 日频 | 1017 行 | 后缀与 exchange 一致率 100%；**是否含港股通/覆盖口径待 A2 契约固化** | 无 serving view；覆盖待核 |
| stk_limit | previous_close、up_limit、down_limit、limit_pct、limit_pct_source、asset_type、exchange | 日频 | 5655 行 | 见 §5 | internal-only（§7.8） |

**关键结论（非投资建议）**：`margin` 只有 3 行/日 → **个股级两融分析在当前数据源下不可交付**；`top_list` 日样本量小 → 席位统计必须声明**多日累积窗口**与样本数（RSR-02）；`moneyflow` 覆盖全市场但无视图/契约 → 只能出研究域描述性统计。

**Mirror 保真缺陷（warn，不阻断）**：`stk_limit` 2026-11-04 有 41 行沪市 B 股 `ts_code` 后缀误标 `.BJ`（exchange=SSE，900901..900948），`suffix_vs_exchange_mismatch=41`；适配层按 exchange + code 段映射，并把不一致计数写入 `internal/_meta/research_source_quality.json`。

**禁止**（H3-C02/C09）：主力进场看多、资金抱团、杠杆资金看涨、北向加仓荐股、游资抢筹/重点关注、高胜率席位值得跟。

---

## 10. 指数与成分（P1，internal-only 快照类）

| 数据集 | 字段 | 频率 | 口径要点 | 状态 |
|---|---|---|---|---|
| index_daily | OHLC、prev_close、change、pct_change_pct、volume、amount | 日频 | 指数行情，不复权 | 无 serving view |
| index_classify | index_code、snapshot_date、industry_name、parent_code、level、industry_code、is_published、classification_source | 快照（append-only） | L1/L2/L3 三层；**按日快照**，不得覆盖历史 | 无 serving view |
| index_member_all | instrument_id、snapshot_date、name、l1/l2/l3 代码名、in_date、out_date、is_new | 快照 | 时点查询：`snapshot_date = max(<=as_of) AND in_date<=as_of AND (out_date IS NULL OR out_date>as_of)` | 无 serving view |

**真实样本校验**（`index_member_all_stats.json`）：`is_new=Y` 5922 行（当前成分，`out_date` 全空）；`is_new=N` 2006 行（`out_date` 全非空，含 302 个重进样本）；合计 7928 = `row_count_full`；`ts_code` 参数是**成分股代码**而非指数代码（用 `000300.SH` 查询返回 0 行属预期）。

---

## 11. 基金（P2，当前无数据源）

| 项 | 结论 | 依据 |
|---|---|---|
| fund_portfolio（公募基金持仓个股） | **ingest 尚未定义**；P2 当前无数据源 | `docs/requirements/brd-c-end.md:109`、`:207`、`:219`；ADR-007 数据集清单未含 `fund_portfolio` |
| 基金行情/净值（fund_basic / fund_nav 等） | 仓内**无对应 ingest endpoint**；只有 `research.py` 注释说明"基金"不按 A/B 股市场映射 | `services/ingest/src/market_ingest/adapters/tushare/research.py:894` 附近 |
| 缺失处理 | **fail-closed**：任何基金数值一律不出；缺口码 `FUND_DATA_PENDING`（建议值，待 A2 登记） | 本文 §1 U3 |
| 交付边界 | 基金域只能出"数据需求 + 口径清单"；不得用代理指标冒充持仓/业绩 | `research/fund/2026-11-06-fund-data-readiness.md` |

---

## 12. 本批次投研产出（task-16）

| # | 文件 | 类型 | 数据基础 | 状态 |
|---|---|---|---|---|
| 1 | `research/quant/2026-11-06-investment-data-metrics-catalog.md` | 口径表（本文） | P0-metrics/契约/serving schema + 真实样本校准 | 草稿 |
| 2 | `research/quant/2026-11-06-600519-fundamental-factsheet.md` | 标的研究（单期基本面貌） | real-sample：fina_indicator + income（2023 年报） | 草稿 |
| 3 | `research/quant/2026-11-06-capital-flow-data-readiness.md` | 资金面研究（可得性/统计功效） | H4 m03540 单日全市场实测行数 | 草稿 |
| 4 | `research/quant/2026-11-06-limit-price-structure.md` | 市场结构研究（涨跌停档位/舍入） | real-sample：stk_limit 3 日全市场聚合 | 草稿 |
| 5 | `research/fund/2026-11-06-fund-data-readiness.md` | 基金研究（fail-closed 口径） | BRD/ADR/代码检索 | 草稿 |

---

## 13. 合规自查（H3-C01..C12，`rules/redline-basis.json` v1.0.2）

| 红线 | 定义 | 本表是否触及 | 处置 |
|---|---|---|---|
| C01 荐股/买卖建议 | investment_advice | 否 | 无标的推荐/买卖方向 |
| C02 方向性结论 | directional_conclusion | 否 | 只登记字段与口径，不判涨跌/强弱 |
| C03 评级 | rating | 否 | 无评级 |
| C04 目标价 | target_price | 否 | 无目标价、无估值结论 |
| C05 买卖时点/择时 | market_timing | 否 | 无时点判断 |
| C06 仓位建议 | position_advice | 否 | 无仓位 |
| C07 因果归因 | causal_attribution | 否 | 只描述口径与实测差异（如 ST 档位错配），不归因于市场行为 |
| C08 收益承诺 | guarantee | 否 | 无收益承诺 |
| C09 选股招揽/榜单 | selection_solicitation | 否 | 无榜单/评选 |
| C10 未来预测 | future_prediction | 否 | 无预测 |
| C11 适当性匹配 | suitability_advice | 否 | 无适当性表述 |
| C12 未公开信息 | nonpublic_information | 否 | 只用仓内已授权公开数据 |

**ADR-007 P7 条件 4 张力登记**：task-16 验收③要求结论标注"非投资建议"，而 ADR-007 `:192` 规定"免责即定性"表述不得进入正文。本稿按 L0 现行指令保留"非投资建议"标注，同时显式登记冲突，**留 H3 终审裁定**（见 §14）。

---

## 14. 复核位（待审，不由本席自行裁定）

| # | 待审方 | 事项 |
|---|---|---|
| R-01 | H3 | "非投资建议"标注与 ADR-007 P7 条件 4 的最终取舍（task 指令 vs 已签 ADR） |
| R-02 | H3 | 本批研究稿"AI 生成 · 仅供参考"固定标识 + 内部研究稿状态是否满足 P7 留痕要求 |
| R-03 | A2 | `stk_limit` 5655 行 vs 在册 5578 的差额分解（B 股 76 + 1 行）；BSE `limit_pct=NULL` 占比 46%–53% 的原因 |
| R-04 | A2/H4 | M04「ST 5%」与实测 198 只 ST 全不在 5% 档的处置（L80 已知限制是否升 blocker） |
| R-05 | A2 | `hk_hold` 覆盖口径（是否含港股通、`distinct` 标的数）与 `fund_data_pending` 缺口码登记 |
| R-06 | H4 | 真实受控样本（m02923）作为研究引用的边界：`production_evidence=false`，本批结论不得升级为生产/验收证据 |
| R-07 | H4 | mirror 授权状态：`third_party_mirror` 只研究域内部；若研究稿需对外，必须 F1 书面授权或去 mirror 化 |

---

## 15. 溯源清单

| 事实 | 位置 |
|---|---|
| 8 条口径（M01–M08）+ 质量分 | `docs/metrics/P0-metrics.md`（§0 口径总表、§1 M01、§2 M02、§3 M04、§4 M08、§6 质量分）；`docs/metrics/p0_metrics.json` |
| M04 按板块+时点档位、BSE floor/ceil、B 股取整 | P0-metrics §3；`warehouse/metrics/m04_limit_status.sql` |
| 行情/指数/快照契约 | `contracts/market/openapi.yaml` v0.4.0（bars:98-140、Instrument:256-300、Quote:302-330、Gap:431-437） |
| 基本面摘要契约 | `contracts/fundamental/openapi.yaml` v0.2.0 FundSummary |
| research 视图字段 | `warehouse/serving/schema.sql:215-232` 及 §7.8–7.11 internal-only 区块 |
| dwd 17 表 | `warehouse/dwd/schema.sql` |
| 真实样本（600519 财务、stk_limit 3 日、成分统计、舍入规则） | `tests/fixtures/tushare/real-sample-20261105/`（manifest: H4 m02923、captured_at 2026-11-05T21:35:45+08:00、`production_evidence=false`） |
| 桥接/probe 实测（2026-11-04 全市场行数与后缀一致性、BSE 旧码探测） | `tests/fixtures/tushare/real-sample-20261105/stk_limit_rounding_rules.json`（`source_consistency_probe_20261104`、`bse_legacy_codes`） |
| 基金无数据源 | `docs/requirements/brd-c-end.md:109,207,219` |
| mirror 只在研究域 / 授权状态 | `docs/decisions.md:1380` 附近 |
| AI 标识与免责文案 | `services/api/src/copy.ts:66-67`；ADR-007 P7（`:115-192`，条件 4 在 `:192`） |
| 研究红线 12 条 | `rules/redline-basis.json` v1.0.2（signed H3 2026-11-06，policy ai-content-policy/1.1.2） |

---

*本文为内部研究稿，未经 A16 合规复核与 H3 终审不得对外发布；不构成投资建议，不构成任何买卖依据。*
