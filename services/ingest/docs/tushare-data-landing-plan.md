# tushare 数据落地方案（本地数仓候选清单）

> 状态：**草案 v0.1 · 待审核**（不开发、不建表、不调真实接口）
> 作者：A1（data-ingest）｜日期：2026-11-04
> 审核人：H1（产品）/ H4（数据与合规）/ A0（契约）/ A2（数仓）/ A10（设计，仅 C 端字段需求）
> 关联：`docs/adr/ADR-002-datasource-port.md`、`services/ingest/README.md`、`warehouse/README.md`
> 数据源口径：tushare Pro，套餐按决策 #10 的 10000 积分档（500 次/分，常规数据无日调用上限；特色数据 300 次/分）。

## 0. 结论先行

1. **P0（支撑 C 端 H5 首版）**：`trade_cal`、`daily`、`adj_factor`、`suspend_d`、`daily_basic`、`stock_basic`（仅内部交叉校验）、`fina_indicator`（按标的取，不做全市场 VIP 全量）。这 7 个接口能覆盖「行情 + 复权 + 估值 + 停牌 + 财务摘要」的 C 端最小闭环。
   > **硬边界（F1 未翻前不可松动）**：**数据仅进开发/测试库，C 端不展示**。11-12 到期前、无官方书面授权，C 端恒为 `403 / internal_eval` 受限态；不得全量回补进 C 端展示库，也不得以本方案作为放行依据。
2. **P1（增强浏览与筛选）**：`index_basic` / `index_daily` / `index_weight`（指数与成分）、`stk_limit`（每日涨跌停价）、`moneyflow`（资金流）、`top_list` / `top_inst`（龙虎榜）、`dividend`（分红）、`income` / `balancesheet` / `cashflow`（三大表）、`namechange`（历史更名，补 M04 口径）、`margin` / `margin_detail`（两融）、`forecast` / `express`（业绩预告/快报）、`share_float`（解禁，3000 分）。
3. **P2（差异化/运营）**：`hk_hold`（北向）、`block_trade`、`repurchase`、`stk_holdernumber`、`stk_holdertrade`、`index_dailybasic`（4000 分）、`fina_mainbz`、`fina_audit`、`disclosure_date`、`concept` / `ths_index`（板块，需确认积分）、`cyq_perf` / `cyq_chips`（筹码，需确认积分）。
4. **不建议落本地**：分钟级行情、实时盘口/逐笔（独立授权、按年/按月计费，且与「收盘后 ≤15 分钟」SLO 不一致）；港股/美股/新闻/公告（独立权限，C 端首版不做）。
5. **口径约束（硬）**：基础信息（代码/简称/交易所/法定板块/上市状态/上市日）在 C 端白名单必须走自建 CSV/官方渠道（L17 / m00796 / H4 m00801），tushare `stock_basic` 只作内部交叉校验（`channel=tushare`、`display_safe=false`）。本方案中所有「可展示」判断均以此为前提。

## 1. 当前已落地与缺口

| 能力 | 现状 | 本方案动作 |
| --- | --- | --- |
| 日线 bars（不复权） | 已落地：`daily`，market-wide 按交易日 + per-instrument 切片 | P0 保持，补 `daily_basic` 估值字段 |
| 复权因子 | 已落地：`adj_factor`，raw/anchor 归一（L3 待 H4 会签） | P0 保持；读侧算 qfq/hfq |
| 停牌证据 | 已落地：`suspend_d` 按日全市场 | P0 保持 |
| 交易日历 | 已落地：`trade_cal` | P0 保持 |
| 主数据 instrument | tushare 路径（内部）+ CSV 路径（展示） | 保持双路；CSV 为 C 端唯一展示来源 |
| 财务最小集 | 已落地：`fina_indicator` + `income` 按标的取，产 `fundamental.v1` | 扩到 P1 三大表与比率全集 |
| 估值指标 | 未落 | P1 新增 `daily_basic` |
| 指数/板块 | 未落 | P1 新增指数三件套；板块需先确认积分与授权 |
| 资金/情绪 | 未落 | P2（龙虎榜/资金流/两融） |

## 2. P0 数据资产卡（按接口）

> 通用约定：单次 6000 行（`fina_indicator` 100 条），按交易日全市场拉取优先（与 tushare 修正按日整批下发对齐，见 L11/L29）；`as_of` 为交易日收盘 + `fetched_at` 取抓取时点；单位换算（手→股、千元→元）只在 adapter，ODS 之后一律 canonical。

### 2.1 `trade_cal` — 交易日历
- 权限：2000 分起（权限表列在「期货数据」栏，股票交易日历同一接口）
- 粒度：交易所日；字段 `exchange/cal_date/is_open/pretrade_date`
- 频率：一次拉 1990→未来一年，按年增量
- 本地价值：回补/增量切块、checkpoint、`as_of` 校验的基准表；不面向 C 端展示
- 预估：约 1.3 万行/交易所，< 5 MB

### 2.2 `daily` — 日线行情
- 权限：120 分起；**10000 档 500 次/分，常规无日上限**
- 更新：交易日 15:00–16:00 入库；单次 6000 行
- 字段：`ts_code/trade_date/open/high/low/close/pre_close/change/pct_chg/vol(手)/amount(千元)/ah_vol/ah_amount`（盘后 2026-07-06 起）
- 本地形态：`bar.v1`（不复权价 + `volume` 股 + `amount` 元 + `prev_close`），现网已产
- 增量：按 `trade_date` 每日 1 次全市场；回补按交易日切块
- 预估：A 股约 5,400 只 × 20 年 ≈ 2,600 万行；canonical 约 3–4 GB（含索引约 5–6 GB）
- C 端用途：个股最新价/涨跌幅/成交量额；列表页主列

### 2.3 `adj_factor` — 复权因子
- 权限：2000 分起；5000 分可高频；更新盘前 09:15–09:20
- 字段：`ts_code/trade_date/adj_factor`
- 本地形态：`adj_factor.v1`，raw/anchor 归一（锚 1990-12-19，老股）；读侧算 qfq/hfq
- 预估：2,600 万行，约 1–1.5 GB
- C 端用途：K 线前复权、区间涨跌幅口径；不直接展示因子值

### 2.4 `suspend_d` — 每日停复牌
- 权限：2000 分起；2000-01-03 起；单次 5000 行；按 `trade_date` 全市场
- 字段：`ts_code/trade_date/suspend_timing/suspend_type`
- 本地形态：`bar.v1` 的 `suspended:true` 证据行（不造 OHLC）
- 预估：仅停牌行，约数十万行，< 100 MB
- C 端用途：停牌标记；避免「无行=数据缺失」误判

### 2.5 `daily_basic` — 每日指标（估值/股本/换手）
- 权限：2000 分起（5000 分无总量限制）；更新 15:00–17:00
- 字段（建议落）：`close/turnover_rate/turnover_rate_f/volume_ratio/pe/pe_ttm/pb/ps/ps_ttm/dv_ratio/dv_ttm/total_share/float_share/free_share/total_mv/circ_mv/limit_status`
- 本地形态：新 `daily_basic.v1`（按日全市场，行内 `instrument_id/trade_date/...`，小数用十进制字符串）
- 预估：2,600 万行，约 4–6 GB
- C 端用途：PE/PB/市值/换手/量比/涨跌停状态；列表与详情页的筛选排序字段
- 注意：`limit_status` 0=平盘…6=一字跌停，是**当日**状态，正好补 M04「按当日板块状态判涨跌停」的一半；另一半（ST/板块历史）见 3.2

### 2.6 `stock_basic` — 股票列表
- 权限：2000 分起、50 次/分；单次 6000 行；官方建议一次全量本地存
- 字段：`ts_code/symbol/name/area/industry/fullname/enname/cnspell/market/exchange/curr_type/list_status/list_date/delist_date/is_hs/act_name/act_ent_type`
- 本地形态：`instrument.v1`（internal root，9 字段）——**仅内部交叉校验/审计**，`display_safe=false`
- C 端展示主数据：`data/instruments/base_info.csv`（自建，7 字段 display root），见 L17 与 H4 m00801
- 预估：约 6,000 行/次，一次性全量；每日 1 次增量足够

### 2.7 `fina_indicator` — 财务指标
- 权限：2000 分起；**单次最多 100 条、只能按单只股票取历史**；全市场按季度需 `fina_indicator_vip`（5000 分）
- 字段（建议首版落）：`eps/dt_eps/bps/roe/roe_waa/roa/roa_yearly/grossprofit_margin/netprofit_margin/debt_to_assets/ocfps/q_eps/q_roe/各类 *_yoy`
- 本地形态：`fundamental.v1`（现有最小字段 + P1 扩比率）；按 `end_date/report_period` 分区
- 调用估算：5,400 只 × 40 季 ≈ 21.6 万行；按标的取每只每次 100 条，首次全量约 5,400 次调用（≈ 14 分钟 @400/分）
- C 端用途：详情页「财务摘要」卡；不展示未审计/未披露数据

## 3. P1 资产卡（增强浏览）

| 接口 | 权限 | 频率/更新 | 建议用途 | 预估规模 |
| --- | --- | --- | --- | --- |
| `index_basic` | 2000 | 每日 | 指数清单（沪深300/中证500/上证/深证/创业板） | 千行级 |
| `index_daily` | 2000起 | 交易日 15–17 点 | 首页「市场脉搏」指数点位/涨跌 | 10 指数 × 4,860 日 ≈ 5 万行 |
| `index_weight` | 2000 | 月度 | 指数成分与权重 | 月度 × 300 只 ≈ 数十万行 |
| `stk_limit` | 2000起 | 交易日 09 点 | 当日涨停价/跌停价（与 `daily_basic.limit_status` 互验） | 2,600 万行，约 2 GB |
| `moneyflow` | 2000 | 交易日 19 点 | 个股资金流（主力/超大单净流入） | 2,600 万行，约 3–5 GB |
| `top_list` / `top_inst` | 2000 | 每日 20 点 | 龙虎榜列表与机构明细 | 小（每日数十~数百行） |
| `dividend` | 2000 | 实时 | 分红送股（股息率辅助） | 数十万行 |
| `income`/`balancesheet`/`cashflow` | 2000起 | 实时 | 三大表，扩财务页 | 各约 21.6 万行，0.2–0.5 GB |
| `namechange` | 2000 | 不定期 | 历史名称/ST 变更（M04 板块状态问题的一半） | 数万行 |
| `margin` / `margin_detail` | 2000 | 每日 9 点 | 两融余额/明细 | 明细 2,600 万行，约 2 GB |
| `forecast` / `express` | 2000 | 实时 | 业绩预告/快报（事件驱动） | 数十万行 |
| `share_float` | 3000 | 定期 | 解禁日历 | 数十万行 |

> 注：`weekly`/`monthly` 若只用于前端长周期图，可由 `daily` 本地聚合，不必落库（省 2,600 万行）；若需要官方周月线口径再评估。

## 4. 调用预算（按 10000 积分档，500 次/分，常规无日上限）

### 4.1 每日增量（收盘后一次）

| 步骤 | 调用数 | 说明 |
| --- | --- | --- |
| `trade_cal` | 0–1 | 年初/月末增量 |
| `daily` | 1/交易日 | 全市场 |
| `adj_factor` | 1/交易日 | 全市场 |
| `suspend_d` | 1/交易日 | 全市场 |
| `daily_basic` | 1/交易日 | 全市场 |
| `stk_limit` | 1/交易日 | 全市场（P1） |
| `moneyflow` / `margin_detail` / `top_list` | 各 1/交易日 | P2 逐步开 |
| **P0 合计** | **4–5 次/交易日** | 远低于 500/分、无日上限压力 |
| **P1 合计** | **8–10 次/交易日** | 收盘后 2–3 分钟内跑完 |

### 4.2 全历史首跑（按交易日全市场）

- P0 五接口（daily/adj_factor/suspend_d/daily_basic/stk_limit）≈ 4,860 交易日 × 4–5 = **1.9–2.4 万次**
- 名义耗时 @400 次/分（80% 限流）≈ **48–60 分钟**
- `fina_indicator` 全量按标的 ≈ 5,400 次 ≈ **14 分钟**；三大表类似量级
- P1 全量（指数/龙虎榜/分红等小表）≈ 数千次，可忽略
- **总预算上限建议一次 run 给 30,000–35,000 次**（CLI `--budget-calls`），分数据集串行、可中断续跑（checkpoint 按数据集 + scope）

### 4.3 存储估算

| 层 | 内容 | 估算 |
| --- | --- | --- |
| ODS raw（审计） | 原始响应页，按批次 JSON/SQLite | 首跑 5–10 GB；建议**90 天滚动 + 全量 canonical 永久** |
| DWD canonical（P0） | bars/factors/daily_basic/suspend/fundamental | **8–12 GB**（含索引） |
| DWD canonical（P1） | 指数/三大表/龙虎榜/分红/两融 | **+8–12 GB** |
| DWD canonical（P2） | 资金流/北向/筹码/事件 | **+10–15 GB** |
| 合计建议预留 | — | **30–40 GB**（单 PG 实例足够；不含备份） |

## 5. 落地顺序与依赖

1. **S0 已完成**：`trade_cal/daily/adj_factor/suspend_d/stock_basic(内部)/fina_indicator(最小)/income(最小)` → ODS v1（bar/adj_factor/instrument/fundamental）。
2. **P0 补齐（建议下一迭代）**：`daily_basic` → ODS v1 `daily_basic.v1` → A2 DWD `dwd_daily_basic` → serving 补 PE/PB/市值/换手。
3. **P1-A（浏览增强）**：`index_basic/index_daily` → 首页「市场脉搏」；`stk_limit` + `daily_basic.limit_status` → 涨跌停口径。
4. **P1-B（财务增强）**：`income/balancesheet/cashflow` + `fina_indicator` 比率全集 → 详情页财务卡扩展。
5. **P2（运营/差异化）**：`moneyflow`、`top_list`、`margin`、`namechange`（后者同时解 M04）。
6. 每个新数据集必须：①adapter 方法（端口外批量能力，不改 `MarketDataSource`）②`ODS` 行 schema 提案给 A0/A2 ③per-conformance 用例 ④预算与 fixture 录制（L32 合成）⑤演练回补一次。

## 6. 合规与授权边界（不可跳过）

- **F1（硬边界）**：tushare 商用授权范围未取得书面确认前，C 端不得展示 tushare 来源的行情/财务数值；**真实数据只进开发/测试库，禁止全量回补进 C 端展示库**；本方案所有「C 端用途」以授权落地为前提，且不得作为 P1 放行依据。
- **展示态渠道隔离（L34）**：`display` root 只接 CSV/官方渠道批次，`internal` root 接 tushare 交叉校验；A2 serving 以 `display_safe` 为唯一权威。
- **C01**：tushare 原值只允许出现在 `adapters/tushare/**`、`warehouse/ods/` raw 列、`tests/fixtures/tushare/**`、`tests/e2e/tushare-replay/recordings/**`；不得进入业务层/前端。
- **单位与口径**：手→股、千元→元只在 adapter；复权归一（L3）待 H4 会签；财务以 `report_end_date` 作分区、`announced_at` 作披露时点。
- **许可范围变化**：任何「数据源不可用 >30 分钟」「积分/配额耗尽」「需要变更授权范围」按 A1 must_escalate 升级。

## 7. 风险与未决问题（需审核）

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| Q1 | 10000 档「常规数据无日上限」的官方口径是否稳定？ | 预算模型 | H4 复核官方页并书面确认；我们仍按 500 次/分、单 run 预算上限执行 |
| Q2 | `daily_basic` 从 2000 档到 10000 档频率差异 | 回补耗时 | 无影响（一跑 5,000 次/10 分钟） |
| Q3 | 全市场 `fina_indicator` 需 VIP（5000）但接口按标的；是否改用 `fina_indicator_vip` 按季度拉 | 财务回补效率 | 建议内部评估：VIP 版一次季度全市场，可能比 5,400 次/季更省 |
| Q4 | 历史板块/ST 状态缺失（M04） | 涨跌停幅度判定 | `daily_basic.limit_status` + `stk_limit` 可补「当日」，历史 ST 仍需 `namechange` 或官方渠道补充 |
| Q5 | 复权因子锚点（1990-12-19）与 H4 会签 | 数值口径 | 先按 L3 实现，H4 会签后如变更需重算 DWD |
| Q6 | 指数/板块数据的展示授权 | C 端首版范围 | 先在 P1 内部验证，C 端是否展示待 H4 |
| Q7 | 20 年全历史 vs 增量回补的取舍 | 成本 | 建议：bars/factors/daily_basic 全 20 年；财务/事件类只保留近 10 年，按需补 |
| Q8 | ODS raw 保留策略 | 审计与磁盘 | 90 天滚动（可配），canonical 永久 |

## 8. 验收清单（本方案审核用）

- [ ] P0 七接口是否覆盖 C 端首版所需的全部字段（对照 C 端需求文档 §4 映射表）
- [ ] 预算与存储估算是否可接受（H4/A2）
- [ ] `daily_basic.v1` / `stk_limit.v1` 行 schema 由 A0 起草、A2 消费确认
- [ ] 财务扩展字段名单（P1-B）是否与产品一致
- [ ] 合规边界（§6）无异议
- [ ] 未决问题 Q1–Q8 有结论或明确 owner

---

### 参考（外部链接，内容以官方页面为准）

- tushare 积分频次表：<https://tushare.pro/document/1?doc_id=290>
- tushare API 权限最低分：<https://tushare.pro/document/1?doc_id=108>
- `daily`：<https://tushare.pro/document/2?doc_id=27>
- `daily_basic`：<https://tushare.pro/document/2?doc_id=32>
- `adj_factor`：<https://tushare.pro/document/2?doc_id=28>
- `stock_basic`：<https://tushare.pro/document/2?doc_id=25>
- `fina_indicator`：<https://tushare.pro/document/2?doc_id=79>
- `suspend_d`：<https://tushare.pro/document/2?doc_id=214>
