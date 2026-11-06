# market-sense C 端业务需求文档（BRD）

- **文档编号**：BRD-CEND-001
- **版本**：v1.1（2026-11-06 H1 对齐 PRD-v2）
- **日期**：2026-11-06
- **作者**：A20 投研数据分析师 + A21 宏观政策研究员
- **消费方**：A0（契约）、A3（后端）、A7（H5）、A16/H3（合规）、H4（数据口径）
- **定位**：本文描述 market-sense **C 端（c_end audience）** 的业务目标、用户场景、功能需求、合规边界与数据依赖。本文是**业务需求**文档，不是技术设计；实现细节见 ADR-001/002/004/006/007/008。
- **合规基线**：本文所有功能受 `rules/redline-basis.json`（H3-C01..C12）与 `rules/ai-content-policy.json`（ai-content-policy/1.1.2，C 端分区已签）硬约束。C 端为无牌平台，**只做客观数据展示**，不得输出任何荐股/择时/目标价/涨跌预测/收益承诺。

> **优先级定义（本文口径）**
> - **P0**：现有 contracts（market 0.4.0 / fundamental 0.2.0 / watchlist 0.3.0）+ `warehouse/serving/ports.yaml` 的 5 个 serving view（`serving_instrument`/`serving_quote_latest`/`serving_bar_daily`/`serving_factor_latest`/`serving_fundamental_summary`）**已具备能力**，可立即验收。
> - **P1**：tushare 接口已在 ingest 层定义（`services/ingest/.../tushare/research.py` 的 `sync-research` 数据集清单）但**尚无 serving view / 契约**，属第 2 批（对齐 ADR-007 D5）。
> - **P2**：**当前无数据源**，需代理指标或待采购/外部检索，属第 3 批或更后。

---

## 1. 业务目标

### 1.1 解决的核心问题

market-sense C 端要解决的，是**普通投资者无法低成本、客观地获取结构化的行情/基本面/市场结构数据**这一问题：

1. **信息分散且带营销噪声**：行情、财务、资金、龙虎榜散落在多个平台，且大量页面以"荐股/选股/热点/龙头"包装，用户难以剥离主观判断、看到原始数据。
2. **缺一个"不荐股"的客观数据入口**：市场上绝大多数工具把"数据"与"建议"捆绑。market-sense 的差异化定位恰恰是**只给数据、不给建议**——把判断权完整交还用户。
3. **AI 摘要的可信缺口**：用户需要"把一堆数字快速读懂"，但通用 AI 容易夹带方向性判断。market-sense 的 AI 功能**只做客观归纳**（数据显示/历史统计上），每条结论绑定证据、带 AI 标识与免责，绝不越界成投顾。

### 1.2 产品定位（一句话）

> market-sense C 端是一个 **AI-native 的客观数据展示平台**：提供行情、基本面、市场结构（龙虎榜/资金/两融/北向）的**可追溯、带时点、显式缺口**的数据视图，并在合规红线内提供**客观归纳型** AI 摘要与自选组合复盘。**不荐股、不择时、不预测、不承诺收益。**

### 1.3 非目标（明确不做）

- 不做个股推荐、买卖建议、目标价、涨跌预测、评级、仓位建议（H3-C01/C02/C03/C04/C05/C06）。
- 不做选股招揽/榜单/热点主线（H3-C09）。
- 不做未来预测与收益承诺（H3-C10/C08）。
- 不做适当性匹配（H3-C11）。
- 不接触未公开信息（H3-C12）。
- 不做盘中实时行情（C2=A：不做盘中实时，按延时/收盘后 ≤15min 标注 stale）。
- 不做真实持仓账本（P0 无持仓；复盘仅基于用户自选，且文案只允许"自选组合"）。

---

## 2. 用户画像与场景

### 2.1 目标用户画像

| 画像 | 描述 | 核心诉求 | 合规敏感点 |
|---|---|---|---|
| **U1 数据自查型散户** | 有一定经验，自己决策，只缺一个干净的数据源 | 快速看到某股行情/财务/资金/龙虎榜原始数据 | 易期待"给个结论"，须明确平台不给 |
| **U2 自选管理者** | 持有一篮子关注标的，定期复盘 | 管理自选、看组合区间表现 | 易把"自选复盘"当持仓账本/收益归因，须限定为"自选组合"统计 |
| **U3 市场观察者** | 关注市场整体结构（涨跌停、资金、北向） | 看盘后市场概览、资金结构统计 | 易期待"主线/热点/龙头"，H3-C09 高风险区 |
| **U4 AI 辅助阅读者** | 想快速读懂数字，但不信任营销号 | 用 AI 把数据客观归纳成要点 | AI 越界给建议是最高合规风险，须每条绑证据 + AI 标识 + 免责 |

> **注**：C 端用户默认 `user_type=c_end`（ADR-008 D1）。内部员工（`internal_active`）使用内部工具页，**不在本 BRD 范围**；且 ADR-008 q3 默认 `INTERNAL_AI_ADVICE_MODE=off`，内部亦不得对 C 端复用建议内容。

### 2.2 核心使用场景

| 场景 | 触发 | 用户旅程 | 涉及板块 |
|---|---|---|---|
| **S1 看盘（盘后）** | 收盘后打开首页 | 看市场概览 → 涨跌停梯队 → 涨跌分布 | 行情 |
| **S2 查个股** | 从首页/自选/搜索进入个股页 | 看行情快照 → 分时/K线 → 基本面摘要/估值 → 资金/风险 → AI 客观解读 | 行情 + 基本面 + 研究 + AI |
| **S3 管理自选** | 在个股页点"加自选" | 加/删自选 → 查自选列表 → 看自选组合区间统计 | 自选 |
| **S4 看市场概览** | 进入市场/盘后复盘页 | 指数概览 → 涨跌停梯队 → 资金/两融/北向结构 → 龙虎榜 | 行情 + 研究 |
| **S5 AI 复盘** | 盘后对自选/市场跑一次归纳 | 触发 AI 摘要/复盘 → 读带证据的客观要点 → 看数据缺口 | AI |

> **注（2026-11-06 对齐 H1）**：本表是**业务目标的完整覆盖**，不是本期交付范围。S2/S4 中的分时/K 线/资金/两融/北向/龙虎榜多为 P1/P2（详见 §3.1–§3.3 与 §5），在对应数据接入前，页面以**显式缺口卡**呈现，不得静默省略、也不得用 mock 伪装。本期交付范围以 PRD `docs/requirements/prd-v2.md` §8.3 的 Now/Next/Later 为准；「P0/P1/P2」在本 BRD 内始终只表示**数据就绪度**，不表示交付批次。

---

## 3. 功能需求清单

> 每条需求格式：`ID | 名称 | 描述 | 优先级 | 数据来源 | 合规红线`.
> "合规红线"列：标注该功能**最易触碰**的红线条目（H3-Cxx），以及是否为 AI 生成内容（须带 `ai.generated` + 免责）。**所有功能的硬前提**：不输出 H3-C01..C12 任一被禁内容；数据/能力缺失必须**显式缺口**，不得用 0/空串伪装。

### 3.1 行情板块

| ID | 名称 | 描述 | 优先级 | 数据来源 | 合规红线 |
|---|---|---|---|---|---|
| **MKT-01** | 证券基础信息 | 单只证券的 canonical 基础信息（代码/交易所/简称/板块/类型/上市状态）。契约 `getInstrument` | **P0** | tushare `stock_basic`（已接）；serving `serving_instrument` | 无（客观数据）；退市标的保留、list_status=delisted |
| **MKT-02** | 个股行情快照 | 最新一次成功快照（last/prev_close/change/change_pct/volume/amount/涨跌停状态/停牌）。停牌价格允许 null、禁用 0 冒充。契约 `getInstrumentQuote` | **P0** | tushare `daily`（已接）；serving `serving_quote_latest`；C2=A 延时 | 无（客观数据）；须带 as_of/staleness + disclaimer |
| **MKT-03** | 历史日线 K 线 | 按复权口径（none/qfq/hfq）返回日线序列，has_more 分页。契约 `listInstrumentBars` | **P0** | tushare `daily` + `adj_factor`（已接）；serving `serving_bar_daily` | 无（客观数据）；停牌日不合成 bar、禁 0 填充 |
| **MKT-04** | 收盘涨跌停梯队 | 按板块规则从日线推导涨停/跌停/连板梯队（ST 排除并显式列 excluded_st）。契约 `getLimitLadder`（B1-02） | **P0** | 现由 market-wide `daily` 规则推导；精确口径待 tushare `stk_limit`（ingest 已定义，P1 精确化） | **H3-C09 高风险**：不得升级为"龙头/连板龙头/值得关注"；只呈现梯队事实，禁止任何"强弱/后续"措辞 |
| **MKT-05** | 个股页五段骨架 + 缺口卡 | 返回 quote/fundamental/valuation/capital/risk 五段可用性骨架，无数据段显式 gap/pending/restricted。契约 `getInstrumentPageSummary`（B1-03） | **P0** | 组合 market/fundamental 已授权模块；确定性聚合、不调 LLM | 无（结构性数据）；核心价值即"显式缺口、不伪装" |
| **MKT-06** | 指数概览 | 主要指数（上证/深证/创业板/科创/北证等）收盘点位与涨跌幅 | P1 | tushare `index_daily`（ingest 已定义，需 index_codes 列表；**无 serving view/契约**） | 无（客观数据）；不得做"大盘走势判断" |
| **MKT-07** | 全市场涨跌分布 | 涨/跌/平家数、涨跌停家数、分板块涨跌分布等市场宽度统计 | P1 | tushare `daily` 全市场聚合 + `stk_limit`（精确涨跌停）；**缺口码 MARKET_BREADTH_PENDING 已在契约预留** | 无（市场级汇总）；禁止转化为"市场情绪/方向"结论 |
| **MKT-08** | 分时走势（盘中） | 盘中分时线（tick/分钟线） | **P2（当前无数据源）** | tushare 现无分时接口（仅日线）；需额外采购或确认 mirror 是否提供分钟级 | 无（客观数据）；若引入须重估 C2=A"不做盘中实时"裁定 |

### 3.2 基本面板块

| ID | 名称 | 描述 | 优先级 | 数据来源 | 合规红线 |
|---|---|---|---|---|---|
| **FUN-01** | 最新一期财务摘要 | 最近一期（按 announced_at）营收/净利/同比/EPS/ROE/毛利率/总资产，带 statement_basis（reported/restated 双口径）。契约 `getFundamentalSummary` | **P0** | tushare `income` + `fina_indicator`（已接）；serving `serving_fundamental_summary`；**当前仅少量标的** | 无（客观数据）；仅最新一期，不得做"业绩趋势预测" |
| **FUN-02** | 估值指标 | PE/PB/市值/换手率/量比等每日指标 | P1 | tushare `daily_basic`（ingest 已定义；**无 serving view/契约**）；page-summary valuation 段当前 gap | **H3-C04 边界**：只呈现当前估值分位/绝对值，**禁止**给"低估/高估/合理价位"判断 |
| **FUN-03** | 成长性指标 | 营收/净利同比、环比、多期增速（历史事实） | P1 | tushare `fina_indicator`（or_yoy/netprofit_yoy 已接字段）+ 多期 `income`；page-summary 成长段 | **H3-C10 边界**：只呈现**历史已披露**增速，禁止外推未来增长 |
| **FUN-04** | 盈利质量指标 | 毛利率/净利率/ROE/ROA 等比率及其历史分位 | P1 | tushare `fina_indicator`（已接多字段）；**无独立 serving view** | 无（客观数据）；只做历史统计分位，禁止"盈利能力将持续" |

### 3.3 研究板块

> 研究板块整体属 ADR-007 第 2 批（数据先接、规则后置、AI 文案第 3 批）。**全部为"客观数据 + 历史统计"呈现，严禁升级为选股/跟随/主线判断（H3-C09/C02/C10）。**

| ID | 名称 | 描述 | 优先级 | 数据来源 | 合规红线 |
|---|---|---|---|---|---|
| **RSR-01** | 龙虎榜明细 | 每日龙虎榜上榜标的、上榜原因、买卖金额、净额 | P1 | tushare `top_list`（ingest 已定义，2000 分；**无 serving view/契约**） | **H3-C09 最高风险**：只呈现上榜事实，禁止"游资/机构抢筹/重点关注" |
| **RSR-02** | 龙虎榜席位统计 | 席位（营业部/机构）N 日上榜统计：上榜后 1/2/3/5/10 日历史买入次数/平均涨幅/上涨概率（**历史统计**） | P1 | tushare `top_list` + `top_inst`（5000 分特色）；方法论参考 `research/intel/2026-11-05-longhubang-youzi-seat-stats.md` | **H3-C09/C02/C10/C07**：所有数字必须是**已发生历史统计**且标注窗口；**严禁**"高胜率席位值得跟/推荐营业部/行业轮动"；不得把研报机构观点当事实 |
| **RSR-03** | 资金流（主力/大中小单） | 个股/市场资金流向、主力净流入 | P1 | tushare `moneyflow`（ingest 已定义，2010 起；**无 serving view**） | **H3-C02/C09**：只呈现资金方向事实，禁止"主力进场看多/资金抱团" |
| **RSR-04** | 融资融券 | 两融余额（交易所维度 SSE/SZSE/BSE）、个股融资余额变化 | P1 | tushare `margin`（ingest 已定义；**无 serving view**） | **H3-C02**：只呈现杠杆水平变化，禁止"杠杆资金看涨" |
| **RSR-05** | 北向持股（沪深股通） | 港交所源沪深股通持股明细、增减持 | P1 | tushare `hk_hold`（ingest 已定义；**无 serving view**） | **H3-C02/C09**：只呈现持股变动，禁止"北向加仓荐股" |
| **RSR-06** | 基金持仓 | 公募基金持仓个股明细 | **P2（当前无数据源，需代理指标）** | tushare `fund_portfolio`（**ingest 尚未定义**）；季度披露、滞后 | **H3-C09**：禁止"跟着基金买"；数据滞后须显式标注报告期 |
| **RSR-07** | 宏观政策 / 经济指标 | GDP/CPI/PMI/货币政策、政策日历与文件要点 | **P2（当前无数据源，需代理指标）** | tushare **无此数据集**；需外部检索（Web Search，经 A23 research-intel 流程 + A16/H3 终审）或另行采购 | **H3-C02/C10/C07 最高风险**：宏观解读**极易**滑向"政策利好→看涨"因果归因/预测。**C 端只呈现政策原文/事实/时间点**，禁止任何"利好/利空/影响/有望"表述；宏观 AI 内容须走 A16 初筛 + H3 终审 |
| **RSR-08** | 大宗交易 / 解禁 / 股东户数 / 质押 / 回购 | 筹码与风险类数据 | P1 | tushare `block_trade`/`share_float`/`stk_holdernumber`/`pledge_*`/`repurchase`（**ingest 尚未定义**，列 ADR-007 2-6 批）；page-summary risk 段当前 gap | 无/低（客观数据）；只呈现事实，禁止"解禁砸盘/质押爆仓"方向判断 |

### 3.4 AI 板块

> AI 板块所有功能**硬门禁**（ADR-007 D3 P7 / H3 m02666）：`ai.generated=true` + `content_version` + label「AI 生成·仅供参考」+ disclaimer；badge/免责不可关闭/折叠，复制导出须携带；无 `as_of` 时 badge 与数值同时不渲染。**上线前 ADR-007 条件 1（隐式标识/留痕）未闭环期间，不得对任何用户展示模型生成的可见内容。** 每条结论须绑 ≥1 个 evidence_id、过 P5 合规过滤（命中即 block，禁自动改写）、P6 只允许"数据显示/历史统计上"前缀。

| ID | 名称 | 描述 | 优先级 | 数据来源 | 合规红线 |
|---|---|---|---|---|---|
| **AI-01** | 个股 AI 客观解读 | 对个股五段数据做**客观归纳**（数据显示…/历史统计上…），每条绑证据。`kind=stock_interpretation` | P1（生成层，依赖 B2-07 + 网关；**第 1 批仅 UI/缺口卡**） | 组合 instrument/quote/bars/fundamental（已授权）+ 第 2 批估值/资金/风险 | **全红线**：禁 H3-C01/C02/C03/C04/C05/C06/C07/C08/C09/C10/C11；缺口文案由 API 常驻、**C 端不生成 data_gaps**（policy 白名单已排除） |
| **AI-02** | 自选组合 AI 复盘叙述 | 对自选组合区间统计做**事实归纳**，不承诺收益、不做收益归因。`kind=watchlist_review` | P1（生成层；确定性统计见 WAT-04） | watchlist + bars（已接） | **H3-C07/C08/C06**：禁止"因为你选得好/组合跑赢是因为…"归因与任何收益承诺 |
| **AI-03** | 盘后市场 AI 归纳 | 对涨跌停梯队/资金/两融/北向做市场级**客观归纳**。`kind=post_market_review`/`capital_features` | P2（依赖第 2 批研究数据 + 网关） | 第 2 批 RSR 数据集 | **H3-C02/C05/C09/C10**：禁止"市场情绪偏多/主线/资金轮动"等方向性/择时表述 |
| **AI-04** | AI 对话入口 | 全局对话（工具调用、SSE、受限数据 403、多轮）。`POST /v1/ai/chat` | P1（B3-01；INF-01/02 已落盘） | 经 tool registry 调只读工具 | **全红线**：P5 fail-closed；不给买卖建议/目标价（ADR-007 D4/D8） |
| **AI-05** | 多因子筛选语言化解读 | 解释筛选出的特征/分位（只解释、不给建议）。`kind=factor_screen` | P2 | 第 2 批 daily_basic + 因子 | **H3-C01/C09/C11**：禁止把筛选结果表述为"推荐/适合/首选" |

> **AI 板块统一约束**：AI 结果禁止跨 entitlement 缓存、`/v1/ai/*` 一律 no-store；供应商/模型名/内部 tier 不得出现在任何用户可见字段。

### 3.5 自选板块

| ID | 名称 | 描述 | 优先级 | 数据来源 | 合规红线 |
|---|---|---|---|---|---|
| **WAT-01** | 加自选（幂等） | 添加自选，重复添加返回现有条目、added_at 不变。契约 `addWatchlistItem` | **P0** | 平台私有数据 `platform.watchlist`；需登录态（OIDC bearer） | 无；只做新增、无"清空/批量覆盖" |
| **WAT-02** | 删自选（幂等） | 移除自选，不存在同样 204。契约 `removeWatchlistItem` | **P0** | 同上 | 无 |
| **WAT-03** | 自选列表 | 按加入时间倒序返回。契约 `getWatchlist` | **P0** | 同上 | 无；空列表 200+[]、不 404 |
| **WAT-04** | 自选组合区间统计（复盘） | 等权组合区间收益/波动/最大回撤/单标的区间统计（确定性，只读 bars，**不含 LLM**）。契约 `getWatchlistReview`（B1-01） | **P0** | 内部只读 watchlist + bars + quote；source=platform_eod | **H3-C08/C06/C07**：**只允许"自选组合"命名，禁"真实持仓/持仓账本"**；只做统计、不构成组合建议；基准对比待 index_daily（BENCHMARK_PENDING） |

---

### 3.6 合规展示（横切必备，非板块）

> **本节为 2026-11-06 H1 对齐补入**：原 BRD 只有 §4「合规边界（负面清单）」，缺「必须有」的展示类硬需求，而 PRD §6.3 已把下列四项列为 P0 不可配项。缺这一节会导致"红线写了不许说什么，却没写必须显示什么"，验收无锚点。
> 四项均为**不可配项**：运营中台无入口、管理后台无开关、agent 无权修改（对应 PRD 的 `LOCKED_CONFIG_AREAS`）。

| ID | 名称 | 描述 | 优先级 | 数据来源 | 合规红线 |
|---|---|---|---|---|---|
| **CMP-01** | 免责声明常驻 | 每个页面可见免责文本 + 版本号（`disclaimer.text` / `disclaimer.version`）；**不可关闭、不可折叠、不可降低对比度**；导出/分享携带 | **P0** | `services/api copy.ts` 唯一持有（`COPY_VERSION`）；契约 `meta.disclaimer` | §4 硬前提；缺失即整页不展示价格（宁可不展示，不可无免责展示） |
| **CMP-02** | AI 内容标识 | 任何 `ai.generated=true` 内容必带 `AI 生成 · 仅供参考` 徽标 + AI 免责；无关闭、无折叠、无透明度；无 `as_of` 时徽标与数值同时不渲染 | **P0** | 契约 `ai{}` 段 + policy `ai-content-policy`；由 API/A5 强制注入 | §4.1 第 4 条；AI 内容复制/导出同样携带 |
| **CMP-03** | as_of 时点与来源标识 | 每个数值旁标注 `as_of` + 来源中文标签（`sourceLabel` 受控映射）；`staleness_ms>900000` 显示延时/陈旧标记；复权口径单独标注 | **P0** | 契约 `meta.source{source,as_of,staleness_ms}` / `meta.adjustment` | 「可追溯」原则；缺失值显示 `—`，禁 `0` 冒充 |
| **CMP-04** | 退订入口 | 全站常驻且可点的退订入口（页脚 + 「我的」页置顶）；不可被运营隐藏、不可藏三级 | **P0** | 静态合规入口（P0 不依赖后端）；§4 相关 | 不可配项；存在性本身是验收项 |

> 验收口径：CMP-01..04 的失败不是"体验缺陷"，而是**合规失败**，任一缺失即 P0 不通过（与 §6.1 F1 授权门禁同等级）。

---

## 4. 合规边界（逐条对应 redline H3-Cxx）

> C 端为**无牌平台**，H3-C01..C12 全部**硬禁止**。下表逐条列出"该红线是什么 + C 端具体不能做什么 + 本 BRD 哪些功能最易触碰"。

| 红线 | 主题 | C 端**不能做**（负面清单） | 本 BRD 高风险功能 |
|---|---|---|---|
| **H3-C01** | 荐股 / 买卖建议 | 不得出现"荐股/推荐(该)股票(标的)/建议(推荐)买入(卖出/加仓/减仓/建仓/清仓/持有)";不得输出任何买卖信号 | AI-01..AI-05、RSR-01/02、WAT-04 |
| **H3-C02** | 方向性结论 | 不得出现"看多/看空/看涨/看跌"、"将(会/有望/预计)上涨(下跌/走高/反弹/突破)"、"上涨(下跌)趋势/空间/概率" | MKT-06/07、RSR-03/04/05/07、AI-03 |
| **H3-C03** | 评级 | 不得出现"买入/卖出/增持/减持/中性评级" | AI-01、FUN-* |
| **H3-C04** | 目标价 | 不得出现"目标价(位)/目标市值/上调(下调)目标价" | FUN-02（估值）、AI-01 |
| **H3-C05** | 买卖时点 / 择时 | 不得出现"择时/抄底/逃顶/逢低买入/低吸/打板/追涨/(买入卖出)时机已到" | AI-03、RSR-02 |
| **H3-C06** | 仓位建议 | 不得出现"仓位(建议/配置)/满仓/重仓/轻仓/加仓(减仓)/止损(止盈)/定投/分批/网格" | AI-02、WAT-04 |
| **H3-C07** | 因果归因 | 不得出现"导致/造成/引发/推动/拖累/受益于/归因于/因为/由于/受…影响"（对涨跌的因果解释） | AI-02、RSR-02/07 |
| **H3-C08** | 收益承诺 / 保本 | 不得出现"保证/保本/稳赚/无风险/收益承诺/不会亏/必涨(必跌)/翻倍/一定上涨" | WAT-04、AI-02 |
| **H3-C09** | 选股招揽 / 榜单 | 不得出现"值得关注/可关注/重点关注/建议关注/首选/不容错过/排名/榜单/榜首/最优/主线/龙头/轮动/题材/热点" | **MKT-04（涨跌停梯队）、RSR-01/02/06、AI-03/05** |
| **H3-C10** | 未来预测 | 不得用"预计/预测/有望/未来/将/大概率"+ 任何涨跌/增长数字外推（除已披露历史） | FUN-03（成长）、RSR-07（宏观）、AI-01/03 |
| **H3-C11** | 适当性匹配 | 不得出现"适合/适配/风险承受能力/稳健型/激进型/保守型" | AI-05 |
| **H3-C12** | 未公开信息 | 不得出现"内幕/未公开信息/内部消息/小道消息/提前获知"（且**技术上**不得接入未公开数据） | 全局（数据接入层须保证仅公开数据） |

### 4.1 AI 内容专项合规要求（横切）

1. **白名单**：C 端 AI 只允许输出 `objective_fields / metrics / quantiles / statistics / historical_facts / timestamps`（**不含 data_gaps**，缺口文案由 API 常驻）。
2. **结论前缀**：只允许"数据显示"（须 numeric 证据）/"历史统计上"（须 historical_statistical 证据），前缀须与证据类型匹配。
3. **P5 命中即 block**，禁止自动改写中性表述；记录命中类别与原文 hash 供 A16 复核。
4. **标识/免责不可关闭**：label「AI 生成·仅供参考」+ disclaimer 常驻；复制/导出携带；无 as_of 不渲染。
5. **降级**：后处理 P2–P5 失败时，非对话类降级为**确定性数据卡**（无 LLM 文案、仍带 AI 标识）；对话类返回"当前无法生成"，**绝不透传模型原始输出**。
6. **数据缺口显式**：无数据不得编造，page-summary/limit-ladder/review 的 gap 码（如 `MARKET_BREADTH_PENDING`/`BENCHMARK_PENDING`/`PARTIAL_HISTORY`）必须显式呈现。

---

## 5. 数据依赖

> 频率口径：**延时** = 收盘后 ≤15min 可得（C2=A，页面须标 stale，`staleness_ms>900000` 触发延时标注）；**日频** = 每交易日盘后更新；**财报频** = 披露期更新；**滚动** = 上游实时滚动页（须记录抓取 as_of）。"额外采购"= tushare mirror 当前不覆盖或需特色积分/外部来源。

| 功能 ID | 所需数据字段 | 来源（tushare 接口 / 其他） | 更新频率 | 额外采购 / 状态 |
|---|---|---|---|---|
| MKT-01 | ts_code/exchange/name/board/security_type/list_status/listed_at | `stock_basic`（已接）；`serving_instrument` | 日频（基础信息低频变更） | 否（已具备） |
| MKT-02 | last/prev_close/change/change_pct/open/high/low/volume/amount/suspended/limit_status | `daily` + `suspensions`（已接）；`serving_quote_latest` | 延时（收盘后 ≤15min） | 否（已具备） |
| MKT-03 | OHLCV/amount/trade_date + adj_type(none/qfq/hfq) | `daily` + `adj_factor`（已接）；`serving_bar_daily` | 日频 | 否（已具备） |
| MKT-04 | instrument_id/name/board/consecutive_boards/close/prev_close/change_pct + rule | 现：market-wide `daily` 规则推导；精确化：`stk_limit`（ingest 已定义） | 日频 | 精确涨跌停价待 `stk_limit` 接入（P1，不额外采购） |
| MKT-05 | 五段 availability + data_refs + summary + gaps | 组合 market/fundamental 已授权模块 | 随各段 | 否（已具备） |
| MKT-06 | index ts_code/close/change_pct | `index_daily`（ingest 已定义，需 index_codes） | 日频 | 否（P1 接入） |
| MKT-07 | 全市场涨跌家数/涨跌停家数/分板块分布 | `daily`（全市场）+ `stk_limit` + `index_classify`（ingest 已定义） | 日频 | 否（P1 接入；`index_classify` 行业分类较粗，概念标签缺口需 H4 确认） |
| MKT-08 | 分钟级 OHLCV / tick | **tushare mirror 现无分时接口** | 实时/分钟 | **是（需额外采购或确认 mirror 能力）** |
| FUN-01 | revenue/net_profit/yoy/eps/roe/gross_margin/total_assets/report_period/announced_at/statement_basis | `income` + `fina_indicator`（已接）；`serving_fundamental_summary` | 财报频 | 否（已具备，**当前仅少量标的**） |
| FUN-02 | pe/pb/total_mv/float_mv/turnover_rate/量比 | `daily_basic`（ingest 已定义） | 日频 | 否（P1 接入） |
| FUN-03 | or_yoy/netprofit_yoy + 多期 income | `fina_indicator`（已接字段）+ `income` 多期 | 财报频 | 否（P1 接入） |
| FUN-04 | roe/grossprofit_margin/netprofit_margin + 历史分位 | `fina_indicator`（已接） | 财报频 | 否（P1 接入） |
| RSR-01 | 龙虎榜上榜标的/原因/买卖额/净额 | `top_list`（ingest 已定义，2000 分） | 日频（盘后 16:00–18:00） | 否（P1 接入） |
| RSR-02 | 席位 + 上榜后 1/2/3/5/10 日历史统计 | `top_list` + `top_inst`（5000 分特色） | 日频（滚动窗口） | **特色积分 `top_inst`（5000 分）成本需 H4 确认** |
| RSR-03 | 主力/大中小单净流入 | `moneyflow`（ingest 已定义，2010 起） | 日频 | 否（P1 接入） |
| RSR-04 | 两融余额（SSE/SZSE/BSE） | `margin`（ingest 已定义） | 日频 | 否（P1 接入） |
| RSR-05 | 沪深股通持股明细/增减持 | `hk_hold`（ingest 已定义，港交所源） | 日频 | 否（P1 接入） |
| RSR-06 | 公募基金持仓个股/权重 | **`fund_portfolio` 未定义** | 季度（滞后） | **是（当前无数据源，需代理指标或采购）** |
| RSR-07 | GDP/CPI/PMI/货币政策/政策文件 | **tushare 无此数据集**；需 Web Search（经 A23+A16+H3）或采购宏观库 | 月频/事件驱动 | **是（当前无数据源，需代理指标）** |
| RSR-08 | 大宗/解禁/股东户数/质押/回购 | `block_trade`/`share_float`/`stk_holdernumber`/`pledge_*`/`repurchase`（**ingest 尚未定义**，ADR-007 2-6 批） | 日频/事件驱动 | 否（P1，按数据集接入） |
| AI-01..05 | 上述各域已授权数据（经 tool registry 只读工具） | 同各底层数据域 | 随底层 | 依赖 LLM provider（**外部依赖，H2 批准**）+ `top_inst` 特色积分 |
| WAT-01..03 | instrument_id/added_at | 平台私有 `platform.watchlist` | 实时（用户操作） | 否（已具备） |
| WAT-04 | 区间复权收盘价 → 区间收益/波动/最大回撤/等权组合 | watchlist + bars + quote（已接） | 延时 | 基准对比待 `index_daily`（BENCHMARK_PENDING，P1） |

### 5.1 数据依赖总结

- **已具备（P0 基线，无需新增采购）**：`stock_basic`/`daily`/`adj_factor`/`calendar`/`suspensions`/`income`/`fina_indicator` + 5 个 serving view → 支撑 MKT-01..05、FUN-01、WAT-01..04。
- **P1（ingest 已定义、需建 serving view + 契约）**：`daily_basic`/`index_daily`/`top_list`/`top_inst`/`moneyflow`/`margin`/`hk_hold`/`stk_limit`/`index_classify`。
- **P1（ingest 尚未定义，列 ADR-007 2-6 批）**：`block_trade`/`share_float`/`stk_holdernumber`/`pledge_*`/`repurchase`。
- **P2 当前无数据源，需代理指标或采购**：分时（MKT-08）、基金持仓（RSR-06，`fund_portfolio` 未接）、宏观政策（RSR-07，tushare 无、需外部检索/采购）。
- **外部依赖**：AI 板块依赖 LLM provider（H2 批准）；`top_inst` 特色积分（5000 分）成本需 H4 确认。

---

## 6. 全局非功能与上线门禁（摘要）

1. **F1 授权门禁**：C 端商用/再分发书面授权未落地前，`tier=internal_eval`、`is_entitled=false`，**行情与财务接口恒 403**（403 = 无权展示）。**AI 不走 403**：AI 能力未上线/未过门禁时前端呈 `unavailable` 缺口卡（"能力未就绪"≠"无权展示"，两者不可混用）。**不得以 mock 伪装面客。**
2. **不做盘中实时（C2=A）**：所有价格类按延时/收盘后展示，页面显式标 stale。
3. **缺口显式**：任何数据缺失用 gap 码 + 中性文案，禁 0/空串伪装，禁伪装全市场覆盖。
4. **AI 上线门禁**：ADR-007 条件 1–4 + H3 policy_version 签字 + A16 抽样通过后才可开放 C 端 AI。
5. **审计/留痕**：AI 生成留痕（模型/版本/时间/输入口径）≥3 年；`policy_version` 与审计一致。

---

## 变更记录

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-11-06 | v1.0 | 初版：业务目标/画像场景/功能清单（5 板块 29 条：MKT-01..08 / FUN-01..04 / RSR-01..08 / AI-01..05 / WAT-01..04，其中 P0 10 条）/合规边界（H3-C01..C12 逐条）/数据依赖 | A20 + A21 |
| 2026-11-06 | v1.1 | **H1 对齐 PRD-v2**：①§2.2 加注「场景≠本期范围、P0/P1/P2 只表数据就绪度」②新增 §3.6 合规展示 CMP-01..04（P0，补 BRD 缺的"必须显示什么"）③§6.1 修正 AI 语义（未上线=unavailable，非 403）④变更记录计数纠偏（6 板块 26 条 → 5 板块 29 条）。映射与裁定见 `docs/requirements/prd-v2.md` §8.2 | H1 |
