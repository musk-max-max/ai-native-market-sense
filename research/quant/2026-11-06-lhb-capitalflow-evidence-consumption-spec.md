# 龙虎榜 / 资金面数据要素消费口径设计（AI 分析工具 Evidence 视图）

> **AI 生成 · 仅供参考** · 内部研究稿，未经 A16 合规复核与 H3 终审不得对外。
> 本文是投研口径研究产物，只做「已发生数据的描述与结构归因」的口径设计，不产出、不隐含任何标的推荐。

- 版本：v0.1（2026-11-06）
- 编制：A10（a10-research-equity）
- 上游：[investment-data-metrics-catalog.md](2026-11-06-investment-data-metrics-catalog.md)（task-16 口径表 v0.1，通用约定 U1–U10 在此沿用）；[longhubang-youzi-seat-stats.md](../intel/2026-11-05-longhubang-youzi-seat-stats.md)（席位统计公开口径语料包）
- 契约源：contracts/ai/openapi.yaml v0.1.0（AnalysisResult/AnalysisClaim/AnalysisDataRef）、contracts/ai/internal-generation-context.schema.json、ADR-007-ai-functional-layer.md（D2/D3/D4）
- 合规源：rules/redline-basis.json v1.0.2（H3-C01..C12）、rules/ai-content-policy.json `ai-content-policy/1.1.2`、services/compliance/docs/ai-policy.md（P2–P6 口径）
- 字段源：warehouse/dwd/schema.sql（dwd_top_list:205 / dwd_top_inst:231 / dwd_moneyflow:252 / dwd_margin:283 / dwd_hk_hold:303）、warehouse/serving/schema.sql（serving_research_* 视图）
- 数据通道：tushare mirror（`source_channel=third_party_mirror`、`authorization_status=unverified_third_party`，research 域 internal-only；不进 C 端/display/serving）
- audience 现状：**internal only**。C 端消费前置 = F1 商用授权 + C 端 serving view + 契约 + H3 签核，缺一不可（F1 未落地前 tier=internal_eval 恒 403）。

## 1. 目的与范围

本设计回答一个问题：**龙虎榜、资金面结构化数据进入 AI 分析工具 Evidence 视图时，每个"数据要素"以什么语义、什么单位、什么时点、什么窗口、什么合规边界被展示和被模型引用。**

范围内：

1. Evidence 视图数据要素的通用模型（要素 = 证据条目 + 数据引用，如何被 P3/P4 校验、如何被 claim 引用）。
2. 逐数据集消费口径：top_list、top_inst（龙虎榜）；moneyflow、margin、hk_hold（资金面）。
3. 每要素的 evidence.text 形态、numbers 绑定、claim.class、允许/禁止表述与 H3 红线映射。
4. 缺口码建议、合规自查、复核位、溯源清单。

范围外（显式声明，防越界）：

- UI 视觉规格（Evidence 视图布局/组件/色值）→ 归 M1/H5，本文只定数据要素语义。
- 新增数据源、字段改名、dwd/serving DDL 变更 → 归 A1/A2/H4；本文只消费既有字段。
- 派生统计的算法实现（如席位上榜后收益）→ 本文只定消费口径与防未来函数约束。
- 合规规则的制定与调整 → 归 H3；A10 无权调整（H3 红线为最高优先级）。

**"归因"边界定义**：本文所称结构归因，仅指数据内部的算术分解与占比（如 净额 = 买入 − 卖出、榜单金额占比、五档单型拆分）。任何价格涨跌的原因解释均属 H3-C07 因果归因，禁止出现在任何 claim 中。

## 2. 数据链路与消费拓扑

```
tushare mirror（third_party_mirror，unverified_third_party）
  → ODS 批次（含保真校验 warn：suffix_vs_exchange_mismatch=41 沪 B 后缀误标 .BJ）
  → dwd_top_list / dwd_top_inst / dwd_moneyflow / dwd_margin / dwd_hk_hold
  → serving_research_*（仅 /v1/internal/* 与研究消费，不接 C 端契约）
  → AI 工具取数（P1 allowlist 只读；tool registry 按数据集声明 required_tier 与 display_safe）
  → evidence 条目（id/text/numbers）+ AnalysisDataRef（module/as_of/period）
  → 模型生成 draft → runPostprocess P0–P8（P0 授权：403 数据不进 prompt）
  → AnalysisResult（compliance.decision + ai 标识 + meta.disclaimer）
  → Evidence 视图渲染（数值旁必标 as_of + 来源中文标签）
```

链路硬约束：

- mirror 批次不进 C 端/display/serving；研究域产物只进 internal 视图与 internal audience 的 AI 生成。
- 403 = `EntitlementRestricted`（无权展示 ≠ 无数据）；403 数据不进 prompt（P0），不得以缺口文案冒充"无数据"。
- `/v1/ai/*` 响应 `no-store`，禁跨 entitlement 缓存；契约不出现供应商、模型名、内部 tier。

## 3. Evidence 视图数据要素通用模型

### 3.1 两层对象

| 层 | 对象 | 归属 | 说明 |
|---|---|---|---|
| 要素层（本文） | 数据要素 ID（如 `lhb.list.net_amount`） | 口径目录 | 稳定标识，定义字段、单位、时点、窗口、红线映射；不进公共契约 |
| 证据层（运行时） | `evidence: {id, text, numbers?}` | 单次生成内 | AnalysisClaim.evidence_ids 引用之（1..20 条）；evidence_id 生成内唯一 |

### 3.2 AnalysisDataRef 绑定

每个含数据要素的 AnalysisSection 挂 `data_refs`（≤50）：

- `module`：证据所在数据模块，1–64 字符，**不含内部码**（不出现 mirror/research/internal_eval/tier 字样）。龙虎榜与资金面均属公开市场数据模块，建议统一 `market`；最终命名待 A2 契约固化（复核位 R-02）。
- `as_of`：该批数据的业务可得时刻（U4：日频 = 交易日收盘时刻，C2=A，T 日 20:00 后），**不是 fetched_at**。
- `period`：统计窗口显式声明。单日 = `YYYY-MM-DD`；区间 = `YYYY-MM-DD..YYYY-MM-DD`；席位统计须写明窗口档（如 `近三月(2026-08-06..2026-11-05)`），禁止只写"近期"。

### 3.3 evidence 条目构造规则（P3/P4 的前置约束）

| 规则 | 内容 | 违反后果 |
|---|---|---|
| E-1 数值同源 | claim 中出现的每个数字必须能在其引用 evidence 的 text 或 numbers 中找到（P4 数字 token 匹配；日期/时刻 token 除外）。**单位换算在证据构造时完成**：evidence.text 直接以展示单位书写（金额→亿元/万元、比率为百分数数值），numbers 放同值 | P4 block |
| E-2 禁模型自算 | 比率、涨跌幅、净额优先用 dwd 既有字段（如 `lhb_net_rate_pct`、`net_inflow_amount`）；复合派生须在数据侧（SQL/工具）算好写入 evidence，模型不得自算新数字（ADR-007 P4） | P4 block |
| E-3 证据非空 | claim 至少引用 1 条存在且非空的 evidence_id（P3） | P3 block |
| E-4 类型自证 | evidence.text 决定证据类型匹配：`numeric` ↔ 结论前缀「数据显示」；`historical_statistical`（文本含"历史\|统计\|分位\|同比"）↔ 前缀「历史统计上」。前缀与类型不匹配 = `conclusion_unqualified` | P6 block |
| E-5 class 必填 | claim.class ∈ audience 白名单（internal：objective_fields/metrics/quantiles/statistics/historical_facts/timestamps/data_gaps）。建议类、方向判断类无 class 可用 → 本就不得生成 | P2 block |
| E-6 title 禁生成 | section.title 不得由模型生成（`model_generated_title_not_allowed`），由工具/模板给出 | P2 block |
| E-7 自含 | evidence.text 单条自含：主语（标的/指数/市场/交易所）+ 字段语义 + 数值 + 单位 + 时点或窗口；不得依赖上下文补全语义 | 消费歧义 |

### 3.4 净额类要素的双写法规范（防符号歧义）

净额字段可负（`lhb_net_amount`、`net_buy_amount`、`net_inflow_amount` 注释均"可负"）。Evidence 采用两种合法形态，**同一 claim 内不得混用**：

- 形态 A（推荐，方向词承载符号）：「龙虎榜净卖出 6.46 亿元」，`numbers=[6.46]`（正幅值），方向由"净卖出"一词承担。
- 形态 B（表格行，signed 值）：「龙虎榜净额 -6.46 亿元」，`numbers=[-6.46]`，claim 引用时必须保留符号与"净额"措辞。

禁止：写"净卖出 6.46 亿元"却把 `numbers=[-6.46]`（数字匹配将失败）；或 claim 在形态 A 证据上写"-6.46"。

## 4. 通用消费口径约定（E 系列，在 U1–U10 之上）

| # | 约定 |
|---|---|
| E-U1 | 单位沿用 U7：价格元、量股、额元、比率为百分数数值（1.23 表示 1.23%）。展示单位换算（元→亿元/万元）只发生在证据构造与渲染层，换算后数值即 evidence.numbers |
| E-U2 | as_of 沿用 U4：日频 = 交易日收盘时刻；缺 as_of 的要素**数值与 AI 标识同时不渲染**（H3 m02666 条件 2），不得裸展示 |
| E-U3 | 缺失三态沿用 U3：null / 缺口码 / 无记录；缺失显示 `—`，禁止 0 或空串冒充；moneyflow 字段注释明示"缺失为 NULL，禁止补 0" |
| E-U4 | 防未来函数沿用 U5 + M07 精神：任何"上榜后 N 日"统计，样本只计入窗口已完整实现（T+N ≤ as_of）的事件；窗口未满标 `PARTIAL_HISTORY`，不得混入统计 |
| E-U5 | 窗口与样本数强制声明（RSR-02）：席位类统计必须带 窗口档 + 样本数（买入次数/上榜次数）；无窗口标注的数字不得进 claim |
| E-U6 | 榜单口径显式：单日榜 / 多日榜（主要三日）不得静默混算；`reason` 保留原文（M05），不归类、不合并成单一"上榜" |
| E-U7 | 代理观察标注（D-1）：席位、北向持股等作私募/游资/机构持仓代理时，必须标「代理观察，非实际持仓」；营业部席位 ≠ 确定主体持仓 |
| E-U8 | 研究域隔离：本文要素全部 internal-only；进 C 端需 F1 授权 + C 端 serving view + 契约 + H3，缺一即 403 |
| E-U9 | 每要素携带 source + as_of（A20 硬规则）；staleness_ms>900000 渲染陈旧标记（CMP-03） |
| E-U10 | 机构观点隔离：intel 语料包中券商研报方法论（中泰"高胜率席位"、华鑫游资活跃度）只作口径参考，**不得当事实沿用、不得进 evidence**（RSR-02 明令） |
| E-U11 | 席位统计数据要素当前**无派生表**（dwd 只有 top_list/top_inst 明细）：上线前不可交付统计类 claim，缺口显式（见 §9） |
| E-U12 | 数据质量声明：mirror 保真 warn（41 行沪 B 后缀误标 .BJ）已知；样本外推、覆盖率表述必须以实测行数为准（2026-11-04：top_list 84 行、top_inst 840 行、moneyflow 5578 行、margin 3 行、hk_hold 1017 行） |

## 5. 龙虎榜数据集消费口径

### 5.1 上榜明细（dwd_top_list → serving_research_top_list:232）

PK(instrument_id, trade_date)；注释"金额元"。日样本 ≈ 84 行（2026-11-04 实测，含转债等非股票口径需排除，股票口径更小）。

| 字段 | 语义 | evidence.text 形态（形态示例，数字示意） | class | 备注 |
|---|---|---|---|---|
| name / instrument_id | 标的 | 主语用 name，ID 用 U9 `EXCHANGE:CODE` | objective_fields | |
| close | 当日收盘价（元） | 「X 当日收盘 12.34 元」 | metrics | |
| pct_change_pct | 当日涨跌幅（%数值） | 「X 当日涨跌幅 +3.21%」 | metrics | 纯事实字段，禁"因上榜而涨"表述 |
| turnover_rate_pct | 换手率（%数值） | 「X 当日换手率 5.67%」 | metrics | |
| amount | 成交额（元） | 「X 当日成交额 18.90 亿元」 | metrics | |
| lhb_buy_amount / lhb_sell_amount | 龙虎榜买入/卖出总额（元） | 「龙虎榜买入 8.90 亿元、卖出 6.46 亿元」 | metrics | P4 复算基础 |
| lhb_amount / lhb_amount_rate_pct | 龙虎榜成交额 / 占成交额比 | 「龙虎榜成交额 15.36 亿元，占当日成交额 81.27%」 | metrics | |
| lhb_net_amount | 净额（元，可负） | §3.4 形态 A/B | metrics | |
| lhb_net_rate_pct | 净额占比（%数值，可负） | 「龙虎榜净买入占成交额 12.85%」 | metrics | 优先用该字段，禁模型自算（E-2） |
| float_market_value | 流通市值（元） | 「X 流通市值 234.50 亿元」 | metrics | |
| reason | 上榜原因（M05 原文） | 「上榜原因（原文）：日涨幅偏离值达到7%」 | historical_facts | 不归类、不润色、不合并 |

**RSR-01 边界（H3-C09 最高风险）**：只呈现上榜事实。禁止「游资/机构抢筹」「重点关注」「主力进场」等任何榜单招揽表述；禁止从单日榜单推"资金看好/看空"。

### 5.2 席位明细（dwd_top_inst → serving_research_top_inst:240）

PK(instrument_id, trade_date, seat_name, side)；side 0=买入 1=卖出；注释"5000 分档；整表可为空"，**数据缺失时视图返回 0 行不报错**——0 行 ≠ 无席位，须走缺口三态（E-U3）。

| 字段 | 语义 | evidence.text 形态（形态示例，数字示意） | class | 备注 |
|---|---|---|---|---|
| seat_name | 营业部/机构席位名 | 「买入席位（营业部）：XXX证券上海XX路」 | historical_facts | 原文保留，不改写、不贴"游资/机构"标签（D-1） |
| side | 买/卖方向 | 模板文字承载 | objective_fields | |
| buy_amount / sell_amount | 买入/卖出额（元） | 「该席位当日买入 1.23 亿元」 | metrics | |
| buy_rate_pct / sell_rate_pct | 买入/卖出占成交额比（%数值） | 「买入占该股当日成交额 6.49%」 | metrics | |
| net_buy_amount | 席位净买入（元，可负） | §3.4 双写法 | metrics | |
| reason | 上榜原因（原文） | 同 5.1 | historical_facts | |

### 5.3 席位统计（RSR-02 派生口径，消费规范先行、数据未到）

公开口径参考（intel 语料包）：按席位聚合上榜后 1/2/3/5/10 日 ×（买入次数 / 平均涨幅 / 上涨概率），窗口档 近一月/三月/六月/一年。**当前 dwd 无派生统计表**（E-U11），本节只定消费规范：

1. 统计类 evidence 必须同时声明：窗口档 + 起止日期（period）、样本数（买入次数/上榜次数）、榜单类型口径（单日榜/多日榜）、as_of。
2. 防未来函数（E-U4）：上榜后 10 日窗口的样本只含 T+10 ≤ as_of 的上榜事件；不足标 `PARTIAL_HISTORY`。
3. 证据类型一律 `historical_statistical`（文本含"历史/统计"），结论前缀只能是「历史统计上」（E-4）。
4. 严格禁止（H3-C09/C02/C10/C07）：「高胜率席位值得跟」「推荐营业部」「该席位后续会涨」「席位定价权导致上涨」「行业轮动由此判断」；研报观点不得当事实（E-U10）。
5. 席位归属推断（"游资/机构"）属持仓代理，必须带 D-1 标注「代理观察，非实际持仓」（E-U7）。

## 6. 资金面数据集消费口径

### 6.1 个股资金流五档（dwd_moneyflow → serving_research_moneyflow:247）

PK(instrument_id, trade_date)；buy/sell × small/medium/large/extra_large 的 volume(bigint 股)+amount(numeric 元)，全可空；net_inflow_volume/net_inflow_amount 可负；注释"量股/额元；缺失为 NULL，禁止补 0"。2026-11-04 实测 5578 行 = 全市场覆盖。

| 字段 | 语义 | evidence.text 形态（形态示例，数字示意） | class | 备注 |
|---|---|---|---|---|
| net_inflow_amount | 当日净流入额（元，可负） | 「X 当日主力单净流入 2.34 亿元」/形态 B | metrics | **M03 口径：不含大宗交易**，禁止把大宗并入主力 |
| buy/sell×extra_large,large | 超大单/大单买卖额（元） | 「超大单买入 5.67 亿元、卖出 4.89 亿元」 | metrics | 单型口径写明"超大单/大单/中单/小单" |
| buy/sell×medium,small | 中单/小单买卖额（元） | 同上 | metrics | |
| *_volume | 各档成交量（股） | 「小单买入 1234.56 万股」 | metrics | |
| net_inflow_volume | 净流入量（股，可负） | 同 §3.4 | metrics | |

**RSR-03 边界（H3-C02/C09）**：禁止「主力进场看多」「资金抱团」「主力资金抢筹」；单型拆分是算术分解（结构归因），不是动机判断。

### 6.2 两融汇总（dwd_margin → serving_research_margin:257）

PK(exchange, trade_date)，exchange ∈ SSE/SZSE/BSE；**仅 3 行/日，交易所维度，无个股两融**（2026-11-04 实测）。个股级两融分析**不可交付**，不得以市场级数据冒充个股结论。

| 字段 | 语义 | evidence.text 形态（形态示例，数字示意） | class | 备注 |
|---|---|---|---|---|
| financing_balance | 融资余额（元） | 「沪市融资余额 1.23 万亿元」 | metrics | 市场级 + 交易所维度显式 |
| financing_buy_amount / financing_repayment_amount | 融资买入额 / 偿还额（元） | 「深市当日融资买入 456.78 亿元、偿还 432.10 亿元」 | metrics | P4 复算基础 |
| securities_balance / securities_sell_volume | 融券余量/卖出量 | 「沪市融券余量 12.34 亿股」 | metrics | |
| margin_balance / securities_volume | 融资融券余额/融券量 | 「三交易所两融余额合计 2.34 万亿元」 | metrics | 合计须显式"三交易所合计" |

**RSR-04 边界（H3-C02）**：禁止「杠杆资金看涨/看空」「融资盘抄底」等方向结论；只描述余额与流量的已发生变化。

### 6.3 北向持股（dwd_hk_hold → serving_research_hk_hold:265）

PK(instrument_id, trade_date)；holding_volume(bigint 股)、holding_ratio_pct(0–100 百分数)、northbound_channel ∈ SH/SZ/HK；2026-11-04 实测 1017 行，**覆盖口径（全量还是活跃子集）待 A2 核**（复核位 R-05）。

| 字段 | 语义 | evidence.text 形态（形态示例，数字示意） | class | 备注 |
|---|---|---|---|---|
| holding_volume | 持股量（股） | 「北向持股（沪股通）持有 X 1234.56 万股」 | metrics | channel 显式（SH/SZ/HK） |
| holding_ratio_pct | 持股占总股本比（0–100） | 「北向持股占总股本比 3.21%」 | metrics | |
| （派生）较前日变化 | 变动量/变动比 | 「较上一交易日持股量变化 -56.78 万股」 | metrics | 用 dwd 两日相减由数据侧算好（E-2） |

**RSR-05 边界（H3-C02/C09）**：禁止「北向加仓荐股」「聪明钱看多」；作持仓代理须带 D-1 标注（E-U7）。数据源为港交所源（非 mirror），但仍受 F1/C 端门禁（E-U8）。

## 7. Evidence 视图数据要素清单（要素 ID 表）

要素 ID 命名：`lhb.*`（龙虎榜）/ `cap.*`（资金面）；ID 稳定不随 UI 变化。所有要素共享 E-U1..E-U12。`module` 建议 `market`（待 A2 固化，R-02）。

| 要素 ID | 数据集.字段 | 单位 | evidence 类型 | period | gap 码（建议） | 红线映射 |
|---|---|---|---|---|---|---|
| lhb.list.close | top_list.close | 元 | numeric | 单日 | LHB_DETAIL_MISSING | C02/C07 禁因果 |
| lhb.list.pct_change | top_list.pct_change_pct | %数值 | numeric | 单日 | LHB_DETAIL_MISSING | C02/C07 |
| lhb.list.turnover_rate | top_list.turnover_rate_pct | %数值 | numeric | 单日 | LHB_DETAIL_MISSING | C02 |
| lhb.list.amount | top_list.amount | 元 | numeric | 单日 | LHB_DETAIL_MISSING | — |
| lhb.list.buy_amount / sell_amount | lhb_buy_amount / lhb_sell_amount | 元 | numeric | 单日 | LHB_DETAIL_MISSING | C02/C09 |
| lhb.list.amount_rate | lhb_amount_rate_pct | %数值 | numeric | 单日 | LHB_DETAIL_MISSING | — |
| lhb.list.net_amount | lhb_net_amount | 元（可负） | numeric | 单日 | LHB_DETAIL_MISSING | C02/C09 |
| lhb.list.net_rate | lhb_net_rate_pct | %数值（可负） | numeric | 单日 | LHB_DETAIL_MISSING | C02/C09 |
| lhb.list.float_mv | float_market_value | 元 | numeric | 单日 | LHB_DETAIL_MISSING | — |
| lhb.list.reason | reason（原文） | — | historical_facts | 单日 | LHB_DETAIL_MISSING | C09 禁招揽解读 |
| lhb.seat.name | top_inst.seat_name | — | historical_facts | 单日 | LHB_SEAT_DETAIL_MISSING（5000 分档不可用） | C09/D-1 |
| lhb.seat.buy_amount / sell_amount | top_inst.buy_amount / sell_amount | 元 | numeric | 单日 | LHB_SEAT_DETAIL_MISSING | C02/C09 |
| lhb.seat.buy_rate / sell_rate | buy_rate_pct / sell_rate_pct | %数值 | numeric | 单日 | LHB_SEAT_DETAIL_MISSING | — |
| lhb.seat.net_buy | net_buy_amount | 元（可负） | numeric | 单日 | LHB_SEAT_DETAIL_MISSING | C02/C09 |
| lhb.seat.stat.count | 派生（上榜后 N 日买入次数） | 次 | historical_statistical | 窗口档+起止 | SEAT_STATS_PENDING（无派生表） | C09/C10/C07 |
| lhb.seat.stat.avg_return | 派生（上榜后 1/2/3/5/10 日平均涨幅） | %数值 | historical_statistical | 窗口档+起止 | SEAT_STATS_PENDING | C02/C09/C10 |
| lhb.seat.stat.win_rate | 派生（上涨概率） | %数值 | historical_statistical | 窗口档+起止 | SEAT_STATS_PENDING | C02/C09/C10 |
| cap.mf.net_inflow_amount | moneyflow.net_inflow_amount | 元（可负） | numeric | 单日 | MONEYFLOW_MISSING（已有码） | C02/C09 |
| cap.mf.net_inflow_volume | net_inflow_volume | 股（可负） | numeric | 单日 | MONEYFLOW_MISSING | C02 |
| cap.mf.order_flow_{small,medium,large,extra_large} | buy/sell×四档 volume+amount | 元/股 | numeric | 单日 | MONEYFLOW_MISSING | C02/C09 |
| cap.margin.financing_balance | margin.financing_balance | 元 | numeric | 单日（交易所） | MARGIN_MISSING | C02 |
| cap.margin.financing_flow | financing_buy_amount / repayment | 元 | numeric | 单日（交易所） | MARGIN_MISSING | C02 |
| cap.margin.securities_* | securities_balance / sell_volume / volume | 股/元 | numeric | 单日（交易所） | MARGIN_MISSING | C02 |
| cap.hk.holding_volume | hk_hold.holding_volume | 股 | numeric | 单日 | NORTHBOUND_COVERAGE_PENDING（覆盖口径待核） | C02/C09/D-1 |
| cap.hk.holding_ratio | holding_ratio_pct | %数值（0–100） | numeric | 单日 | NORTHBOUND_COVERAGE_PENDING | C02/C09/D-1 |
| cap.hk.holding_change | 派生（较前日变化） | 股 | numeric | 两交易日 | NORTHBOUND_COVERAGE_PENDING | C02/C09/D-1 |

gap 码均为**建议值，待 A2 登记后生效**（同 FUND_DATA_PENDING 先例）；已存在码（MONEYFLOW_MISSING、PARTIAL_HISTORY）直接复用，不得另造同义码。

## 8. 红线映射与允许/禁止表述

| 数据集 | 允许（正例形态） | 禁止（违规形态） | 红线 |
|---|---|---|---|
| top_list | 「数据显示，X 于 2026-11-04 上榜，龙虎榜净买入 2.44 亿元」 | 「龙虎榜显示主力抢筹，值得关注」 | C02/C09 |
| top_list | 「上榜原因（原文）：日涨幅偏离值达到7%」 | 「因游资介入所以涨停」 | C07 |
| top_inst | 「历史统计上，该席位近三月上榜 12 次（样本数），上榜后 5 日平均涨幅 1.23%（窗口：2026-08-06..2026-11-05，截至 2026-11-05）」 | 「高胜率席位值得跟」「该席位后续大概率上涨」 | C09/C10 |
| moneyflow | 「数据显示，X 当日超大单净流入 1.23 亿元」 | 「主力进场，看多」「资金抱团」 | C02/C09 |
| margin | 「沪市融资余额较上一交易日增加 45.67 亿元」 | 「杠杆资金看涨」 | C02 |
| hk_hold | 「北向持股（沪股通）占总股本比 3.21%。代理观察，非实际持仓」 | 「北向加仓，建议跟进」 | C02/C09/C01 |
| 全部 | 「数据显示/历史统计上…」（前缀与证据类型匹配） | 「预计后市…」「建议买入/持有/减仓」「目标价 XX」 | C01/C04/C10 |
| 全部 | 结构拆分（净额=买入−卖出、占比） | 任何涨跌原因解释 | C07 |
| 全部 | 缺口显式（gap 码 + caveat） | 缺失补 0、mock 数值、"无数据"冒充 403 | U2/U3/F1 |

附加禁语清单（承接口径表 §9 与 BRD）：主力进场看多、资金抱团、杠杆资金看涨、北向加仓荐股、游资抢筹、重点关注、高胜率席位值得跟、市场情绪偏多、主线、资金轮动、跟着基金买、该买什么、会涨吗、该持有几天。

## 9. 缺口码建议（待 A2 登记）

| gap 码 | 触发语境 | 对应现状 |
|---|---|---|
| LHB_DETAIL_MISSING | top_list 无该日/该标的记录 | 日样本仅 ≈84 行，绝大多数标的天然无记录 |
| LHB_SEAT_DETAIL_MISSING | top_inst 0 行 | 5000 分档可能不可用（视图返回 0 行不报错） |
| SEAT_STATS_PENDING | 席位统计派生表未建 | E-U11，RSR-02 暂不可交付 |
| MARGIN_MISSING | margin 交易所级缺失 | 个股级不存在 ≠ 缺失，个股两融走"不支持该粒度"口径 |
| NORTHBOUND_COVERAGE_PENDING | hk_hold 覆盖口径未核 | 1017 行口径待 A2 |
| 复用：MONEYFLOW_MISSING / PARTIAL_HISTORY / FUND_DATA_PENDING / BENCHMARK_PENDING | 见 contracts/market/openapi.yaml:435-436 及口径表 | 不得另造同义码 |

## 10. 合规自查（本文档自身）

| # | 检查项 | 结果 |
|---|---|---|
| H3-C01 荐股/买卖建议 | 有无推荐买卖 | 否 |
| H3-C02 方向性结论 | 有无看多/看空 | 否 |
| H3-C03 评级 | 有无评级 | 否 |
| H3-C04 目标价 | 有无目标价 | 否 |
| H3-C05 买卖时点/择时 | 有无择时 | 否 |
| H3-C06 仓位建议 | 有无仓位建议 | 否 |
| H3-C07 因果归因 | 有无价格因果解释 | 否（§1 显式禁止） |
| H3-C08 收益承诺/保本 | 有无承诺 | 否 |
| H3-C09 选股招揽/榜单 | 有无榜单招揽 | 否（§8 列禁语并禁止） |
| H3-C10 未来预测 | 有无预测 | 否（禁"预计/将会"） |
| H3-C11 适当性匹配 | 有无适当性建议 | 否 |
| H3-C12 未公开信息 | 有无引用未公开信息 | 否（仅公开信息/mirror 研究域，mirror 商用授权本身为 residual 风险已在 §0 声明） |

## 11. 复核位（待审，R 系列）

| 编号 | 复核内容 | 等待方 |
|---|---|---|
| R-01 | Evidence 视图 claim 正文是否允许出现「非投资建议」类标注 vs ADR-007:192「免责即定性」不得进正文的张力（沿用口径表 R-01，未决） | H3 |
| R-02 | AnalysisDataRef.module 命名（建议 `market`）与 period 形态（区间/窗口档）固化 | A2/H3 |
| R-03 | 席位统计派生表建表与计算口径（上榜后收益窗口、复权处理）由谁承接 | A1/A2 + L3 |
| R-04 | 净额双写法（§3.4）是否需要 A5 在 extractNumericTokens 侧加 signed 值容错 | A5/H3 |
| R-05 | hk_hold 覆盖口径（全量 vs 活跃子集）与 northbound_channel=SH/SZ/HK 语义 | A2 |
| R-06 | mirror 保真 warn（沪 B 后缀 41 行）对研究统计的影响评估 | H4/A2 |
| R-07 | gap 码建议值（§9）登记 | A2 |
| R-08 | margin"不支持个股粒度"的缺口展示文案（不可用 ≠ 缺失） | A2/A5 |

## 12. 溯源清单

| # | 来源 | 摘要 |
|---|---|---|
| 1 | rules/redline-basis.json v1.0.2（signed H3 2026-11-06） | H3-C01..C12 十二红线与三档依据 |
| 2 | rules/ai-content-policy.json（ai-content-policy/1.1.2） | audience 白名单、前缀↔证据类型、data_gap caveat 触发正则 |
| 3 | services/compliance/docs/ai-policy.md | runAiPolicy P2–P6 口径（P4 数字 token 排除日期、P6 前缀匹配） |
| 4 | ADR-007-ai-functional-layer.md（D2/D3/D4） | AnalysisResult 证据模型、runPostprocess P0–P8、tool registry required_tier/display_safe |
| 5 | contracts/ai/openapi.yaml v0.1.0 | AnalysisKind（lhb_review/capital_features/post_market_review）、AnalysisClaim/DataRef/Section |
| 6 | docs/requirements/brd-c-end.md v1.1 | RSR-01..06、AI-03、CMP-01..04、F1；各条红线要求 |
| 7 | warehouse/dwd/schema.sql | dwd_top_list:205 / top_inst:231 / moneyflow:252 / margin:283 / hk_hold:303 字段与单位注释 |
| 8 | warehouse/serving/schema.sql:232,240,247,257,265 | serving_research_* 五视图；internal-only 注释；top_inst 0 行语义 |
| 9 | docs/metrics/P0-metrics.md:18,20,22,358-369,454,466 | M03 不含大宗、M05 保留 reason、M07 按日快照；P0 只立法、数据未到不得进 C 端 |
| 10 | contracts/market/openapi.yaml:435-436 | 既有缺口码 |
| 11 | research/quant/2026-11-06-investment-data-metrics-catalog.md | U1–U10、§9 研究域实测行数与禁语、§13 自查表样板 |
| 12 | research/intel/2026-11-05-longhubang-youzi-seat-stats.md | 席位统计公开口径（东财 1/2/3/5/10 日）、单日榜/多日榜、机构观点隔离 |
| 13 | docs/decision/decisions.md:1380 附近 | mirror 批次标记与研究域隔离；F1 书面授权认定 |
| 14 | tests/fixtures/tushare/real-sample-20261105/（H4 m02923 一次性授权） | production_evidence=false；无 top_list/moneyflow fixture → 样例仅形态示意 |
