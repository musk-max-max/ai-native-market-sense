# market-sense 产品需求文档（PRD v2）

- 文档编号：PRD-v2
- 归属：H1 产品负责人（PM）
- 面向读者：H5 / Console 开发、UI 设计、前端 QA、服务端接口负责人
- 版本日期：2026-11-06（v2.1：回填 §8 BRD 映射、新增 §9 antd 产品影响）
- 状态：可实施（实现级）。**C 端页面节已经 H1 按 BRD 数据就绪度重排批次，见 §8.3。**
- 关联决策：ADR-007《AI 功能层》、`agents/decisions.md`、`docs/requirements/brd-c-end.md`（BRD-CEND-001 v1.0）、`docs/design/system-v2.md`、`docs/design/c-end-h5-v2.md`。
- 上游关系：**BRD 定义业务需求与数据就绪度（P0/P1/P2 三级），本 PRD 定义交付批次（Now/Next/Later）与实现级交互。**两套口径不可混用，统一规则见 §8.0。

> 阅读约定：本文所有文案（含 403/404/空态/加载态）均为**可直接交付 UI 与开发**的最终中文文案，不含「类似」「等等」。凡带 `data-testid` 的元素必须由开发实现且不得改名（供自动化验收）。

---

## 1. 产品定位

**一句话**：market-sense 是一个 AI-native 的 A 股客观数据工具，向个人投资者提供带来源、带 `as_of` 时点、带合规免责的行情与基本面事实，以及可追溯的确定性数据摘要；它不荐股、不择时、不给目标价、不预测涨跌。

**目标用户**

| 用户 | 场景 | 核心诉求 |
| --- | --- | --- |
| 个人投资者（C 端 H5） | 盘后复盘、查个股基本面、维护自选 | 看到可核验的事实数据，明确知道数据是什么时点、来自哪里、是否受权 |
| 数据运营（运营中台） | 配置首页信息流/Banner、看配置生效状态 | 草稿→校验→审批→发布单一链路，发布历史不可变 |
| 合规/风控（合规中台） | 审计谁在何时改了什么、AI 内容是否合规标识 | 人类与 agent 事件可区分；不可配项无入口 |
| 管理员（管理后台） | 审批变更、回滚版本 | agent 无终审权，二次确认 + 授权审计 |
| 客户成功（CRM） | 跟进规则配置（P2 起接入名单） | 不伪造客户数据，契约未就绪即显示待接入 |

**核心价值（客观工具，非荐股）**

1. **可核验**：每一条数值都绑定 `source` + `as_of`（+ 必要时 `staleness_ms` / `adjustment` 复权口径），来源以中文标签直接展示在数值旁。
2. **受权语义清晰**：无权展示的数据以 **HTTP 403** 表达，页面显示统一「无权展示」文案并隐藏价格；**绝不**用 `200 + is_entitled=false` 充当受权判断（见 §6.3、§7 gap-2）。
3. **AI 可辨**：任何模型生成内容必须带 `ai.generated` 标识徽标 + 不可关闭的免责声明；未满足 ADR-007 H3 四条件期间，**不得向任何用户展示模型生成的可见内容**。
4. **合规边界硬编码**：C 端页面不出现荐股/择时/目标价/涨跌预测；免责、AI 标识、as_of、退订入口、风险提示、话术白名单为**不可配项**，运营/管理/agent 均无开关。

---

## 2. 信息架构

### 2.1 C 端 H5（移动优先）

目标导航为**底部 5 个 tab**（当前实现仅有顶部 3 链接，属待补 gap，见 §7 gap-1）。tab 顺序固定，文案固定：

| # | tab | 文案 | 路由 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 行情 | `行情` | `/`（首页即行情入口） | 已有 `HomePage`，但无价格、无 tab |
| 2 | 自选 | `自选` | `/watchlist` | 已有 `WatchlistPage` |
| 3 | 组合 | `组合` | `/review/portfolio` | 已有 `PortfolioReviewPage` |
| 4 | AI | `AI` | `/ai` | **未实现**（AI 仅作为个股页内一个 section，无独立 tab） |
| 5 | 我的 | `我的` | `/me` | **未实现** |

完整页面树（`web/h5`）：

```
/                       行情首页 HomePage
├─ /watchlist           我的自选 WatchlistPage
├─ /review/portfolio    自选组合复盘 PortfolioReviewPage
├─ /review/limits       涨跌停概览 LimitLadderPage（二级，自组合/首页进入，非 tab）
├─ /stocks/:id          个股页 StockPage（id = instrument_id，形如 SSE:600519）
│   └─ AI 解读 section  AiInterpretation（granted 时内嵌，ADR-007 B1-03 五段骨架）
├─ /ai                  AI 动态/解读列表（Now：页面壳；Next：生成层，§3.6，待建）
├─ /me                  我的（登录态/自选同步/退订/免责版本，§3.7，待建｜Now）
└─ *                    notFound 未找到页面
```

路由解析规则（沿用 `web/h5/src/lib/router.tsx`）：`instrument_id` 仅大写交易所前缀 + 去空格，**不做交易所猜测**；`/stock/:id` 与 `/stocks/:id` 为别名。

### 2.2 中后台四中台（Console，base `/console`）

分组标签（`App.tsx` GROUP_LABEL）：`ops=运营`、`admin=管理`、`compliance=合规`、`crm=CRM`。

```
/console/overview      配置看板（运营中台）          group=ops       DEFAULT_ROUTE
/console/config        配置编辑器（运营中台）        group=ops
/console/approvals     审批队列（管理后台）          group=admin     侧栏带 pendingCount 徽标
/console/compliance    合规与审计（合规中台，只读）  group=compliance
/console/crm           客户跟进（CRM，P2 占位）      group=crm
```

完整页面树（`web/console`）：五条路由 + 侧栏导航 + 二次确认弹层（`DoubleConfirm`）+ 变更预览（`DiffViewer`）。

> **命名对齐说明**：用户口述的「四中台 = 运营/合规/管理/CRM」与 Console 现有「配置看板/配置编辑器/审批队列/合规与审计/客户跟进」的映射为——运营=overview+config；管理=approvals；合规=compliance；CRM=crm。本文按此映射撰写。

---

## 3. 页面级需求

> 每节固定结构：页面目标 / 入口 / 关键元素（带数据字段）/ 交互流程 / 空态·加载态·错误态 / 埋点 / API 对齐。
> 通用态文案（全 C 端复用，见 §5 组件 `PageState`）：
> - **加载态**：`加载中…`
> - **403（无权展示）**：title `数据暂不可用`；body `当前版本暂不提供该标的行情数据，本页不会展示任何价格数字。`；**无重试按钮**（`retry=null`）。403 展示的 title/detail **直接取 API Problem 的 `title`/`detail` 原文**，前端不改写、不拼接提示。
> - **404（无数据）**：`未找到该证券`
> - **401（登录失效）**：`登录状态已失效`
> - **400**：`请求参数有误`　**429**：`请求暂时无法处理`　**5xx**：`服务暂时不可用`　**网络**：`网络连接不可用`　**未知**：`未知错误`
>
> 403 与 404 的区分是**硬约束**：403 = 有这个标的但你无权看价格；404 = 没有这个标的。两者文案、图标、后续动作（403 无重试 / 404 可返回首页）均不同。

### 3.1 行情首页 `/`（HomePage）

- **页面目标**：作为「行情」tab 落地页与证券检索入口。**刻意不展示任何价格数字**（价格仅在个股页 granted 后展示）。
- **入口**：底部 tab「行情」；未登录直达根路径。
- **关键元素**（均带 `data-testid`，沿用 `web/h5/src/lib/testids.ts`）：

| 元素 | 字段 / 文案 | testid |
| --- | --- | --- |
| Hero 眉题 | `A 股 · 数据工具` | — |
| Hero 主标题 | 两行标题（运营中台 `ops.home-banner` 可配 Banner 时叠加） | — |
| Hero 导语 | lede 文案（copy.hero.lede，见 `copy.ts`） | — |
| 检索输入框 | label `证券代码`；placeholder `SSE:600519`；校验正则 `/^[A-Z]{2,6}:\S+$/`；非法提示 `inputInvalid`（copy 持有） | 检索按钮 `查看` |
| 快捷链接 ×4 | `示例标的`、`我的自选`、`自选组合复盘`、`涨跌停概览` | 各链路 |
| 数据说明卡（4 条） | `收盘快照非实时` / `as_of 时点标注` / `来源标识` / `免责不可关闭` | — |

- **交互流程**：输入 `SSE:600519` → 前端正则校验 → 通过后 `normalizeInstrumentId`（仅大写交易所+trim）→ 路由跳 `/stocks/SSE:600519` → 触发个股页 API（§3.3）。非法输入 → 红色 inline 提示，不跳转。
- **空/加载/错误态**：首页为静态 hero + 检索，无数据依赖，故**无空态/加载态**；检索校验失败即错误态（inline）。
- **埋点**：`page_view {route:'home'}`。
- **API 对齐**：无（纯静态 + 本地校验）。Banner 区若接入运营配置则调 `GET /v1/internal/configs/ops.home-banner`（中后台写入、C 端只读），P0 不阻塞。
- **本期范围裁定（H1，2026-11-06）**：设计 v2（`docs/design/c-end-h5-v2.md` §1.2）把首页扩为「指数概览 / 涨跌分布 / 成交额前列 / 资讯流」四板块，**本期不上**，理由逐条见 §9.3——四板块所需的 `index_daily`（MKT-06，P1）、全市场宽度（MKT-07，P1）均无 serving view/契约，「成交额前列」无 BRD 功能条且属 H3-C09 榜单风险区，「资讯流」无数据源且涉转载授权（H3/H4）。**本期首页仍是「检索入口 + 数据说明」，不展示任何价格数字**；不上四个缺口卡占位（一屏四张缺口卡等于废页，缺口信息在个股页与概览页表达即可）。

### 3.2 我的自选 `/watchlist`（WatchlistPage）

- **页面目标**：展示用户自选列表，作为组合复盘与个股页的集合入口。**列表项不展示价格数字。**
- **入口**：底部 tab「自选」；首页快捷链接「我的自选」；空态引导。
- **关键元素**：

| 元素 | 字段 / 文案 | testid |
| --- | --- | --- |
| 页标题 | `我的自选` | — |
| 自选条目 | 每条 `instrument_id`（可点 → `/stocks/:id`）；标题右侧状态徽标 | `watchlist-state` |
| 加入/移除按钮 | 位置：**个股页 NavBar 右侧**（设计 v2 新增，原写在正文区）；文案 `☆ 加自选` / `★ 已自选`（mini Button）；`aria-pressed` 承载状态 | `watchlist-toggle` |

- **未登录态（对齐裁定，2026-11-06）**：原正文内联文案 `登录后可加自选` 在 NavBar mini Button 里放不下。改为——按钮文案固定 `☆ 加自选`、可点；未登录时点击**不写自选**，弹出提示 `登录后可加自选` 并引导登录（`Toast` 或 `login` 入口），列表页（`/watchlist`）仍按状态矩阵显示 `登录后可加自选` 并隐藏列表。**禁止**把该提示做成按钮 disabled 的 title/aria-label 了事（触屏无 hover）。
- **反馈纪律**：`Toast` 仅作附加反馈（`已加入自选` / `已移除自选`），**不得替代可访问状态**——`aria-pressed` 与 `data-testid` 仍是自动化与读屏的唯一真源，E2E 不断言 Toast。

- **交互流程**：进入 → `useWatchlistList()` → `GET /v1/watchlist` → 渲染列表（每条仅 `instrument_id`）→ 点击 → 跳个股页。在个股页加/删自选：`POST /v1/watchlist` body `{instrument_id}` / `DELETE /v1/watchlist/{instrument_id}` → 成功后 `watchlist_toggle` 埋点并更新徽标。
- **状态矩阵**：

| 态 | 条件 | 文案 / 行为 |
| --- | --- | --- |
| 加载 | 请求中 | `加载中…` |
| 匿名 | `GET /v1/watchlist` 返回 401 | `登录后可加自选`，不展示列表 |
| 空 | 200 且列表为空 | `暂无自选` + 引导链接 `示例标的` → `/stocks/...` |
| 错误 | 非 401 失败 | `errorCopy(status)` + 重试 |
| 就绪 | 有数据 | 列表 |

- **埋点**：`page_view {route:'watchlist'}`；`watchlist_toggle {instrumentId, uiState:add|remove}`。
- **API 对齐**：`GET /v1/watchlist`、`POST /v1/watchlist`、`DELETE /v1/watchlist/{instrument_id}`（契约：watchlist）。

### 3.3 个股页 `/stocks/:id`（StockPage）

- **页面目标**：单标的事实页 —— 基础信息 + 受权后的行情快照 + 基本面摘要 + 免责 + AI 解读（五段骨架）。这是**唯一**允许出现价格数字的 C 端页面。
- **入口**：首页检索、自选条目点击、AI tab 条目、涨跌停概览（仅聚合并未下钻）。
- **关键元素**：

| 区块 | 字段（缺失一律 `—`，MISSING） | testid |
| --- | --- | --- |
| 面包屑 | `← 首页` | — |
| 证券头 | `name`、`instrument_id`、`exchange`、`board`、`securityType`、`listStatus`、`listedAt` | `stock-name`/`instrument-id`/`stock-exchange`/`stock-board`/`stock-security-type`/`stock-list-status`/`stock-list-date` |
| 行情块（granted） | `tradeDate`、`lastPrice`、`prevClose`、`change`、`changePct`、`suspended`、`limitStatus`；来源标签 + `as_of` + staleness 徽标 + `adjustment` | `quote-price`/`quote-change`/`quote-as-of`/`quote-source`/`quote-stale-badge`/`quote-adjustment` |
| 受权提示（restricted+Problem） | API Problem `title`/`detail` 原文 | `entitlement-notice` |
| 自选切换 | 见 §3.2 | `watchlist-toggle` |
| 免责声明 | `disclaimer.text` + `disclaimer.version`；`closable=false`（无关闭按钮，AC-4） | `disclaimer`/`disclaimer-text`/`disclaimer-version` |
| 基本面摘要 | `reportPeriod`、`statementBasis`(reported/restated)、`revenue`、`netProfit`、`revenueYoyPct`、`netProfitYoyPct`、`eps`、`roePct`、`grossMarginPct`、`totalAssets` + 来源/as_of | `fundamental-summary`/`fundamental-report-period`/`fundamental-statement-basis` |
| AI 解读（仅 granted） | 五段 valuation/growth/earningsQuality/capitalFlow/risk + AI 标识 + AI 免责 | `ai-interpretation`/`ai-generated-badge`/`ai-disclaimer`/`ai-segment-*` |
| 数据缺口卡 | `gap reason` ∈ pending_batch/permission/upstream_missing/not_integrated/no_coverage | `data-gap-card`/`data-gap-reason` |

- **交互流程（数据装配，`apiGateway.getStockPage`，按序 3 次调用）**：
  1. `GET /v1/instruments/{instrument_id}` → 基础信息。**此接口不因授权缺失整体 403**（契约明确：`meta.entitlement` 仅为预判，不得替代 quote/bars/fundamental-summary 的 403）。
  2. `GET /v1/instruments/{instrument_id}/quote` → 行情快照。授权门控：`meta.entitlement.is_entitled === true` 才 `access='granted'` 并展示价格；否则 `access='restricted'` 且 `quote=null`。
  3. `GET /v1/instruments/{instrument_id}/fundamental-summary` → 基本面。
- **受权/合规判定（硬约束）**：
  - 收到 **403** → `restricted`，页面**不展示价格**，展示 `EntitlementNotice`（Problem 原文），**无重试按钮**。
  - 防御分支：**收到 200 但 `is_entitled=false`** → 同样按 `restricted` + `quote=null` 处理（AC-5），**但此情形应视为契约违规上报**，不是正常路径。
  - granted 但缺 `disclaimer` / `source` / `as_of` 任一 → 视为**结构性错误**，整页不展示价格（宁可不展示，不可无免责展示）。
- **空/加载/错误态**：
  - 加载 → `LoadingState`；错误 → `ErrorState`（`errorCopy(status,network)`，403 时 `retry=null`）+ 底部 `instrumentId` 脚注。
  - restricted 且**无 Problem**（异常）→ 整页中性错误，不展示半页价格。
  - 基本面缺失 → `fundamentalState='missing'`，基本面区显示缺口卡（reason=`no_coverage`）；接口报错 → reason=`upstream_missing`。基本面缺失**不影响**行情展示。
- **埋点**：`stock_page_view {instrumentId, uiState: ready|restricted}`；错误时 `ui_state {route:'stock', uiState:'error'}`。
- **API 对齐**：`GET /v1/instruments/{id}`、`GET /v1/instruments/{id}/quote`、`GET /v1/instruments/{id}/fundamental-summary`、`GET /v1/instruments/{id}/page-summary`（五段骨架+缺口，ADR-007 B1-03；当前由前端 AiInterpretation 本地推导，目标改为消费该端点）、`POST/DELETE /v1/watchlist`。

### 3.4 自选组合复盘 `/review/portfolio`（PortfolioReviewPage）

- **页面目标**：展示**自选组合的绝对表现**（非真实持仓、非收益承诺）。
- **入口**：底部 tab「组合」；首页快捷链接；涨跌停概览互链。
- **关键元素**：周期 tab `1m/3m/6m/1y`（默认 `3m`，`aria-pressed`）；范围说明 `scopeNote`=`自选组合绝对表现，非真实持仓`。

| 指标 | 字段 | 说明 |
| --- | --- | --- |
| 区间收益 | `periodReturnPct` | — |
| 年化波动 | `annualizedVolPct` | — |
| 最大回撤 | `maxDrawdownPct` | — |
| 等权基准收益 | `equalWeightReturnPct` | 自选等权，非市场基准 |
| 标的数量 | `instrumentCount` | — |

- 数据溯源：每值 `source` + `as_of` + `staleness_ms`。demo/mock 数据带 `demo` 横幅。
- **交互流程**：进入 → `getPortfolioReview(period)` → 目标消费 `GET /v1/watchlist/review?period=...`（ADR-007 B1-01）→ 切周期 tab 重取。
- **状态矩阵**：加载 / 空（→`/watchlist` 引导）/ 匿名（`loginRequired`）/ 不可用（`unavailable` 文案 + `DataGapCard` reason）/ 错误（`ErrorBlock` + 重试）/ 就绪（5 指标 + 溯源 + `templateNote`）。`null` 指标显示 `—`，**不用 0 填充**。
- **待接入维度**：`benchmark`（相对基准对比）、`sector`（板块对比）当前 `pending_batch`，用 `DataGapCard` 展示，不出现在主指标表。
- **埋点**：`page_view {route:'portfolio'}`。
- **API 对齐**：`GET /v1/watchlist/review`（`period` ∈ 1m/3m/6m/1y）。

### 3.5 涨跌停概览 `/review/limits`（LimitLadderPage）

- **页面目标**：以**聚合口径**展示收盘涨跌停梯队（家数/最高连板/连板分布），**C 端禁止下钻到单只个股**（`instrumentRows` 仅内部评测）。
- **入口**：首页快捷链接「涨跌停概览」；组合复盘互链。
- **关键元素**：临时口径横幅（`provisional-banner`）；`stExclusion`=`ST / *ST 标的已排除`（含已排除数量）；聚合卡 `up涨停家数`/`down跌停家数`/`maxStreak最高连板` + 连板分布 bucket 列表；`caliberVersion口径版本` + `as_of` + `source`。

- **交互流程**：进入 → `getLimitLadder()` → 目标消费 `GET /v1/market/limit-ladder`（ADR-007 B1-02；可选 `trade_date` `YYYY-MM-DD`、`lookback` 1–10 默认 10）。
- **空/加载/错误/不可用态**：加载 / 空（200 + 空列表 → 空态，**不返回 404**）/ 不可用（`unavailable` + 缺口卡）/ 错误（`ErrorBlock` + 重试）/ 就绪（聚合卡）。整页 `data-mode="aggregate"`。
- **合规边界**：不展示个股名称/代码/涨跌幅的个体榜单（防变相荐股）；仅家数与分布。
- **埋点**：`page_view {route:'limits'}`。
- **API 对齐**：`GET /v1/market/limit-ladder`。

### 3.6 AI tab `/ai`（待建｜**Now：仅页面壳；Next：生成层**）

- **批次裁定（对齐 BRD，2026-11-06）**：BRD §3.4 的 AI-01..AI-05 全部为 **P1/P2（生成层）**，故本节拆两段——**Now** 只交付页面壳：`AI` tab 路由、列表空态、每条的 `AiGeneratedBadge` 与缺口卡（`unavailable`），不接生成；**Next** 才接 `POST /v1/ai/analyses` 与 SSE。原版本节标「P0 目标」与 BRD 冲突，已改。

- **页面目标**：AI 解读/动态的集合入口，集中呈现带标识、带免责、带溯源的 AI 输出；**未满足 ADR-007 H3 条件前不展示任何模型生成可见内容**。
- **入口**：底部 tab「AI」。
- **关键元素**：
  - 列表项：`analysis_id`、`kind`（封闭枚举，如 `stock_interpretation`/`watchlist_review`/`post_market_review`）、`subject`、`as_of`、AI 标识徽标 `AI 生成 · 仅供参考`。
  - AI 免责（服务端注入，`services/api copy.ts` 唯一持有，前端不硬编码）：`本内容由 AI 生成，基于页面标注时点的市场数据整理，仅供参考，不构成投资建议，也不构成任何买卖依据。`
- **交互流程**：进入 → `POST /v1/ai/analyses`（或列表聚合）→ 短任务 200 / 长任务 `202 + analysis_id` → 轮询 `GET /v1/ai/analyses/{analysis_id}` 或订阅 `GET /v1/ai/analyses/{analysis_id}/events`(SSE) → 渲染 `sections[].claims` + `caveats` + `compliance.decision`。`compliance.decision='blocked'` → 仅展示 blocked 说明，不展示被拦内容。
- **空/加载/错误态**：加载 / 空（无分析记录）/ 匿名（需登录）/ 不可用（AI 服务未冻结/未上线 → `unavailable` + 缺口卡）/ 错误 / 就绪（每 section 带标识+免责+`data_refs`）。
- **合规红线（强）**：每个 AI 输出块必须同时满足——① `ai.generated=true` 徽标；② AI 免责且不可关闭；③ `data_refs[].as_of` 时点；④ 措辞不得含荐股/择时/目标价/涨跌预测。`compliance.reason_codes` 供合规中台审计。
- **埋点**：`page_view {route:'ai'}`；AI 内容曝光 `ai_content_view {analysisId, kind}`。
- **API 对齐**：`POST /v1/ai/analyses`、`GET /v1/ai/analyses/{id}`、`GET /v1/ai/analyses/{id}/events`(SSE)、`POST /v1/ai/chat`(SSE, P0-AI-01)。

### 3.7 我的 `/me`（待建｜Now：页面壳 + 退订入口 + 免责版本）

- **页面目标**：登录态、自选同步、退订入口、免责版本、数据说明。
- **入口**：底部 tab「我的」。
- **关键元素**：用户标识/登录状态；`我的自选` 入口；`退订` 入口（**不可配项** `unsubscribe.entry`，必须存在且可点，不可被运营隐藏；位置**置顶**，不得藏三级）；免责声明当前 `version`；数据来源说明；`COPY_VERSION` 文案版本。
- **全站常驻免责（设计 v2 新增，H1 认可）**：每页 footer 固定渲染 `DisclaimerSummary`（免责摘要，**不可折叠、不可关闭**）+ `UnsubscribeEntry`（退订入口）。个股页 footer 之外仍保留原文区（§3.3 `disclaimer`）。**约束**：footer 不占首屏 6 元素区（个股页首屏 6 元素仍须免滚动可见，AC-10 口径不变）。
- **交互流程**：进入 → 读取登录态 → 展示退订入口与免责版本 → 点退订走退订流程（契约待定）。
- **空/加载/错误态**：加载 / 未登录（`登录后可加自选` 语义）/ 错误。
- **埋点**：`page_view {route:'me'}`。
- **API 对齐**：登录态（`lib/auth.ts` Bearer）；退订入口为静态合规入口（P0 不依赖后端）。

### 3.8 未找到页面 `*`（notFound）

- **页面目标**：兜底路由。文案 `未找到该证券`（复用 404 语义）；提供 `返回首页` 链接。不触发 `page_view`（与现实现一致）。

---

### 3.9 配置看板 `/console/overview`（运营中台）

- **页面目标**：运营一屏看清配置项全貌、待审批数、不可配项（合规锁定）、审计事件。
- **入口**：`/console` 默认路由。
- **关键元素**：4 张统计卡 `可配置项` / `待审批` / `不可配项（合规锁定）` / `审计事件`；「配置项状态」表（列：配置项(标题+id) / 等级 `LevelBadge` / 已发布v / 草稿状态 `StatusBadge` / 待审批数 / 最近发布；行点击→配置编辑器）；「最近审计」表（列：时间 / 操作者 `ActorBadge` / 动作 / 配置项 / 明细）。
- **交互流程**：进入 → `Promise.all(list(), listPending(), listAudit())` → 目标消费 `GET /v1/internal/configs`、`GET /v1/internal/approvals`、`GET /v1/internal/approvals/events` → 点击配置行 → `/console/config`。
- **状态**：加载 `加载中…`；空表 `emptyText`；错误 `c-alert is-danger`。
- **埋点**：控制台埋点（`page_view {route:'console/overview'}`，agent 触发带 `modelVersion`/`runId`）。
- **API 对齐**：`GET /v1/internal/configs`、`GET /v1/internal/approvals`、`GET /v1/internal/approvals/events`。**现状为 MockBackend，契约未接（gap-3）。**

### 3.10 配置编辑器 `/console/config`（运营中台）

- **页面目标**：草稿→校验→审批→发布单一链路；员工手动与 agent 走同一链路。
- **入口**：看板行点击；侧栏。
- **关键元素**：左侧可配置项导航（`LevelBadge`）+ 不可配项说明 `免责声明 / AI 标识 / as_of / 退订入口 / 风险提示 / 话术白名单为不可配项，不提供任何入口。`；右侧表单（`FormField` per `item.fields`）；动作条 `校验草稿`/`保存草稿`/`查看 diff 并提交审批`；`DiffViewer`（before/after + impacts + 勾选确认 + `确认并提交审批`）；发布历史表（版本/发布时间/发布者/授权/回滚到此版本）；`DoubleConfirm` 回滚弹层。
- **可配置项（当前 4 项，registry.ts `CONFIG_ITEMS`）**：

| id | 等级 | 字段 |
| --- | --- | --- |
| `ops.home-feed` 首页信息流 | C2 | `rank_strategy`(热度/时效/均衡)、`page_size`(1–50)、`pinned_count`(0–10)、`enable_quick_watchlist`(bool)；影响 H5 首页/feed |
| `ops.home-banner` 运营 Banner | C3 | `title`、`link_url`(允许 `/` 或 https)、`enabled`、`start_at`、`end_at` |
| `market.sentiment-thresholds` 市场情绪阈值 | C1 | `hot_threshold`(0–100)、`cold_threshold`、`sample_window`(5–250) |
| `crm.followup` 客户跟进规则 | C1 | `remind_days`(1–30)、`auto_archive_days`(7–365)、`tier`(标准/重点/观察) |

- **不可配项（`LOCKED_CONFIG_AREAS` 6 项，无入口、无开关）**：`compliance.disclaimer` 免责声明、`ai.label` AI 标识、`market.as_of` as_of 时间戳、`unsubscribe.entry` 退订入口、`risk.warning` 风险提示、`copy.whitelist` 话术白名单条目。
- **交互流程**：选配置项 → 加载草稿 → 编辑 → `保存草稿`（`PUT /v1/internal/configs/{config_id}`）→ `校验草稿`（`/validate`）→ `查看 diff 并提交审批`（`/submit`）→ 409 冲突走三点合并（base/mine/theirs）→ 审批通过后发布（`/publish`）→ 不可变 release；`/rollback` 追加新 release，历史保留。
- **状态**：`pending_approval` → 锁定编辑 `草稿已提交审批（… 提交），等待审批期间不能编辑。`；409 → 冲突横幅；校验失败 → 红色字段 + `草稿有校验错误，请修正后重试。`
- **埋点**：`page_view {route:'console/config'}`。
- **API 对齐**：`GET/PUT /v1/internal/configs`、`/{config_id}`、`/validate`、`/submit`、`/publish`、`/rollback`、`/diff`、`GET /v1/internal/releases`。

### 3.11 审批队列 `/console/approvals`（管理后台）

- **页面目标**：人类终审。**agent 无终审权**，agent 发起必须人类审批。
- **入口**：侧栏（带 `pendingCount` 徽标）。
- **关键元素**：待审批表（变更单/配置项/等级/发起人/提交时间/状态，**单条审批无批量**）；详情 `DiffViewer`（before/after + impacts + 勾选确认 + `通过并发布（需二次确认）`）；`approval_ref` 输入（写入授权审计）；驳回原因**必填**（为空时驳回按钮禁用）；`DoubleConfirm` 发布二次确认（`confirmWord`）。
- **交互流程**：选中待审批 → 查 diff → 填 `approval_ref` → `通过并发布`（= approve + publish，`POST /v1/internal/approvals/{ref}/decision` 后 `/publish`）或 `驳回`（原因必填）。agent 发起项显示 `必须人类终审` 警告。
- **状态**：空（无待审批）/ 错误 / 就绪。
- **埋点**：`page_view {route:'console/approvals'}`。
- **API 对齐**：`POST/GET /v1/internal/approvals`、`GET /v1/internal/approvals/{approval_ref}`、`/evaluate`、`/decision`、`/events`。

### 3.12 合规与审计 `/console/compliance`（合规中台，只读）

- **页面目标**：只读审计。证明 AI 内容合规标识、免责不可配、as_of 由数据链路生成、人类与 agent 事件可区分。
- **入口**：侧栏。
- **关键元素**：3 张统计卡 `锁定项` / `审计事件` / `agent 来源事件`（含 `modelVersion`/`runId`）；不可配项表（项/名称/锁定依据/说明/操作 `不可配（无入口）`）；AI 内容标识要求告警（`ai.generated` + `AI 生成·仅供参考` 由 contracts/ai 与 A5 强制注入，**无开关**）；键值对（AI 标识 locked / 免责声明 locked / as_of 只读）；审计来源表（时间/动作/对象/来源 `ActorBadge`/详情）。
- **交互流程**：进入 → `GET /v1/internal/approvals/events` + 配置审计 → 只读渲染，**无编辑入口**。
- **状态**：加载 / 空 / 错误。
- **埋点**：`page_view {route:'console/compliance'}`。
- **API 对齐**：`GET /v1/internal/approvals/events`、`GET /v1/internal/configs`（只读）、发布历史 `GET /v1/internal/releases`。

### 3.13 客户跟进 `/console/crm`（CRM，P2 占位）

- **页面目标**：P2 占位，**不伪造客户数据**。
- **入口**：侧栏。
- **关键元素**：统计卡 `跟进规则v`（来自 `crm.followup` publishedVersion）/ `待接入名单`（待 A16 CRM Service 契约）；`crm.followup` 卡（`打开配置` → config）；`EmptyState` 文案 `客户名单与跟进记录 P2 接入`，hint `待 /v1/internal/crm 契约`。
- **交互流程**：进入 → 读 `crm.followup` publishedVersion → 展示占位空态。
- **埋点**：`page_view {route:'console/crm'}`。
- **API 对齐**：`GET /v1/internal/configs/crm.followup`；客户名单契约 `/v1/internal/crm` **未定义**（P2）。

---

## 4. API 对齐总表

> 所有响应均含 `meta`（`source{source,as_of,staleness_ms}` / `adjustment` / `entitlement{is_entitled,tier}` / `disclaimer{text,version,closable=false}`）。错误一律 Problem（`EntitlementRestricted`/`TooManyRequests`/`BadRequest`/`InternalError`/`ProblemResponse`）。

| 页面 | Endpoint | 方法 | 关键请求字段 | 关键响应字段 | 受权/错误语义 |
| --- | --- | --- | --- | --- | --- |
| 个股页 | `/v1/instruments/{instrument_id}` | GET | path `instrument_id` | name/exchange/board/securityType/listStatus/listedAt + meta | 基础信息**不因授权缺失 403** |
| 个股页 | `/v1/instruments/{id}/quote` | GET | path | tradeDate/lastPrice/prevClose/change/changePct/suspended/limitStatus + meta | 403=`EntitlementRestricted`；数据源不可用按 A3 返回最近快照 + `staleness_ms` |
| 个股页 | `/v1/instruments/{id}/bars` | GET | path、`adjustment` 复权口径 | 日线序列 + meta | 403 同上 |
| 个股页 | `/v1/instruments/{id}/fundamental-summary` | GET | path | reportPeriod/statementBasis/营收/净利/YoY/eps/roe/grossMargin/totalAssets + meta | 缺失→缺口卡，不 403 |
| 个股页 | `/v1/instruments/{id}/page-summary` | GET | path | 五段骨架 quote/fundamental/valuation/capital/risk，各 `availability=gap/pending/restricted` | 不存在→404 `INSTRUMENT_NOT_FOUND`；整体 403 仅页面级阻断 |
| 自选 | `/v1/watchlist` | GET/POST | POST body `{instrument_id}` | 列表 `instrument_id[]` | 401→匿名态 |
| 自选 | `/v1/watchlist/{instrument_id}` | DELETE | path | — | — |
| 组合 | `/v1/watchlist/review` | GET | `period`∈1m/3m/6m/1y | periodReturn/vol/maxDD/equalWeight/instrumentCount + source/as_of | 无数据→200 空态；401→匿名 |
| 涨跌停 | `/v1/market/limit-ladder` | GET | `trade_date`、`lookback`(1–10,默认10) | upCount/downCount/maxStreakDays/streakBuckets/stExcludedCount/caliberVersion/provisional | 无数据→200+空列表+gaps（**不 404**）；403=`EntitlementRestricted` |
| AI | `/v1/ai/analyses` | POST | `kind`(封闭枚举)、subject | 短任务 200 / 长任务 `202+analysis_id` | — |
| AI | `/v1/ai/analyses/{analysis_id}` | GET | path | sections/claims/data_refs/caveats/compliance/ai/meta | — |
| AI | `/v1/ai/analyses/{id}/events` | GET(SSE) | path | 事件流 | — |
| AI | `/v1/ai/chat` | POST(SSE) | 会话 | 流式输出（P0-AI-01） | — |
| 配置 | `/v1/internal/configs`(+`/{config_id}`) | GET/PUT | itemId/values/actor/expectedVersion | 配置项+草稿+发布版本 | 409→三点合并 |
| 配置 | `/validate` `/submit` `/publish` `/rollback` `/diff` | POST | itemId/actor/diffAcknowledged | 校验 issues / changeRequest / release | — |
| 发布 | `/v1/internal/releases`(+`.{release_id}`) | GET | itemId | 不可变 release 列表 | — |
| 审批 | `/v1/internal/approvals`(+`/{approval_ref}`) | POST/GET | itemId/diff/actor | 待审批列表 / 单条 | agent 发起需人类终审 |
| 审批 | `/evaluate` `/decision` `/events` | POST/GET | approval_ref / decision | 评估 / 决定 / 事件流 | — |
| CRM | `/v1/internal/crm` | — | — | — | **契约未定义（P2）** |

---

## 5. 组件清单（给 UI）

### 5.1 C 端 H5（`web/h5/src/components`，全部复用）

| 组件 | 复用性 | 职责 / 关键 props |
| --- | --- | --- |
| `QuoteBlock` | 高（个股页唯一价格区） | 价格/涨跌/来源标签/as_of/stale 徽标/复权；granted+合规才渲染 |
| `EntitlementNotice` | 高（403 专用） | 展示 Problem title/detail 原文，无重试 |
| `DisclaimerNotice` / `DisclaimerUnavailable` | 高 | 免责文本+版本，`closable=false`；缺失→不可用态 |
| `FundamentalSummary` | 高 | 基本面 dl；missing→缺口卡 |
| `AiInterpretation` | 高 | 五段骨架 + AI 标识 + AI 免责；仅 granted 渲染 |
| `AiGeneratedBadge` | 高（跨页面） | `AI 生成 · 仅供参考` 徽标 |
| `AiTextSlot` | 高 | AI 文本槽，`content=null` → 仅「待接入」 |
| `DataGapCard` | 高 | 数据缺口卡，`reason` ∈ 5 值枚举 |
| `WatchlistToggle`(+`useWatchlistList`) | 高 | 加/删自选 + 状态徽标 |
| `PageState`（`ErrorBlock`/`EmptyBlock`/`LoadingBlock`） | **最高** | 全端三态；文案由 `errorCopy` 驱动 |
| `States`（`ErrorState`/`LoadingState`） | 高 | 整页级加载/错误 |

### 5.2 Console（`web/console/src/design-system`，全部复用）

| 组件 | 复用性 | 职责 |
| --- | --- | --- |
| `AppShell` | 框架 | 侧栏 + 分组标签 + approvals 徽标 |
| `DataTable`(`Column`) | **最高** | 通用表格（看板/审批/审计/发布历史） |
| `StatusBadge` / `LevelBadge` / `ActorBadge` | 高 | 草稿状态 / 配置等级 / 操作者（人类·agent 可区分） |
| `DiffViewer` | 高 | before/after + 冲突三点合并 + impacts + 确认勾选 |
| `DoubleConfirm` | 高 | 危险操作二次确认（发布/回滚），`confirmWord` |
| `EmptyState` | 高 | 占位空态（CRM/未选配置项） |
| `FormField` | 高 | 配置字段表单 + 校验 issues |
| `ImpactPanel` | 高 | 影响面面板 |

### 5.3 待建组件（本文档新定义，交 UI）

| 组件 | 页面 | 职责 |
| --- | --- | --- |
| `TabBar` | 全 C 端 | 底部 5 tab（行情/自选/组合/AI/我的），固定顺序文案，可访问性 `nav` role + `aria-current`。**实现层用 antd-mobile `TabBar` 包装**，`data-testid` 挂在每个 item 的包装元素上（antd-mobile 不接受 `data-testid` 透传到 DOM，直接传会丢 E2E 锚点，见 §9.1） |
| `AppFooter` | 全 C 端 | 全站常驻：`DisclaimerSummary`（不可折叠）+ `UnsubscribeEntry`；不占首屏 6 元素区 |
| `AiAnalysisList` | `/ai` | AI 分析列表项（analysis_id/kind/subject/as_of + AI 徽标） |
| `AiContentBlock` | `/ai` | 单条 AI 输出：sections/claims + data_refs(as_of) + caveats + 标识+免责；blocked→仅说明 |
| `MePanel` | `/me` | 登录态 + 退订入口 + 免责版本 + 数据说明 |

**关键组件总数**：现有可复用 17（H5 10 + Console 7）+ 本文新定义 6（`TabBar`/`AppFooter`/`AiAnalysisList`/`AiContentBlock`/`MePanel`/antd 状态适配层 `AntdStateAdapter`——把 antd 的 `Empty`/`Skeleton`/`Toast` 映射到本 PRD 的三态纪律，见 §9.1）= **23**。

---

## 6. 非功能需求

### 6.1 性能
- 行情页核心数值接口 **P95 < 3ms（已达成）**，作为回归基线。
- **首屏 JS 预算 200 KB gzip（不许上调）**：门禁脚本 `web/h5/scripts/check-budget.mjs`（已接 CI）。antd-mobile 引入后必须重跑；超限时先砍非必需组件（`Toast`/`PullToRefresh`/`InfiniteScroll` 可退回原生实现），**不接受以提高上限换取组件便利**（H1 veto 项：预算上限）。
- 涨跌停概览按聚合口径返回，避免个体榜单大列表。
- AI 长任务走 `202 + analysis_id` + 轮询/SSE，不阻塞页面渲染。

### 6.2 可访问性
- 正文与背景对比度 **≥ 4.5:1**。
- 周期 tab 用 `aria-pressed`；底部 `TabBar` 用 `nav` role + `aria-current="page"`；表格 `<th scope="col">`。
- 缺失值统一 `—`，不使用空字符串或 0 冒充。

### 6.3 合规展示（硬约束）
- **免责声明**：不可关闭（`closable=false`，无关闭按钮），版本随 `disclaimer.version` 展示；导出/分享携带。
- **AI 标识**：任何 `ai.generated=true` 内容必须带 `AI 生成 · 仅供参考` 徽标 + AI 免责；由 `services/api copy.ts` 唯一持有文案，前端不硬编码；**无运营开关**。
- **as_of**：每条数值旁标注时点 + 来源中文标签；`staleness_ms` 超阈值显示 stale 徽标；`adjustment` 复权口径标注。
- **退订**：`/me` 退订入口为不可配项，必须存在且可点。
- **403 语义**：无权展示 = **HTTP 403**，禁用 `200 + is_entitled=false` 作为受权判断的正常路径（防御分支仅容错并上报）。
- **C 端内容禁区**：荐股 / 择时 / 目标价 / 涨跌预测 / 个体涨跌停榜单下钻，一律不得出现。
- **话术白名单**：`copy.whitelist` 为不可配项；用户可见文案单一来源 `copy.ts`（`COPY_VERSION`）。

### 6.4 隐私与埋点
- 埋点白名单 sanitize；DEV console.debug，prod 静默，**不发送网络、不写 cookie**。

---

## 7. 与现有实现的最大 gap（交开发排期）

**gap-1｜C 端导航未达 5 tab（高优先）**
现状 `web/h5/src/App.tsx:27-76` 顶部仅 3 链接（首页/自选/复盘），无底部 `TabBar`，无「组合/AI/我的」tab。本文 §2.1 要求 5 tab（行情/自选/组合/AI/我的）。
→ 需新建 `TabBar` 组件 + `/ai`、`/me` 两条路由与页面（§3.6、§3.7），并把 `portfolio` 从「复盘」二级提升为独立「组合」tab。

**gap-2｜AI tab 页面缺失 + 五段骨架未消费 page-summary（高优先）**
现状 AI 仅作为个股页内 `AiInterpretation` section（五段本地推导），无 `/ai` tab；且未消费 `GET /v1/instruments/{id}/page-summary`（ADR-007 B1-03）。
→ 需新建 `/ai` 列表页（`AiAnalysisList`/`AiContentBlock`），个股页五段改为消费 `page-summary`（`availability=gap/pending/restricted`），并接入 `POST /v1/ai/analyses` + 轮询/SSE。**H3 四条件未满足前不展示模型生成可见内容**（现实现 production AI 恒 unavailable，符合）。

**gap-3｜Console 仍为 MockBackend，四中台契约未接（中优先）**
现状 `ConsoleServices = MockBackend`（`seedDemoApprovals`），overview/approvals/compliance/config 均未连 `/v1/internal/*`。
→ 按 §4 总表接 `configs`/`releases`/`approvals` 契约；`/console/crm` 等待 `/v1/internal/crm`（P2）。

**gap-4｜antd 组件迁移可能打断既有验收契约（高优先，产品侧必须钉死）**
现状两 package.json 均无 `antd`/`antd-mobile` 依赖（已核）；设计 v2 与 owner 决策要求引入。风险不在"能不能用"，在**迁移会顺手改掉被自动化验收锚定的交互**：`data-testid` 透传丢失、403 语义被 antd `Empty` 吃掉、自选状态只剩 `Toast`、搜索框 `onFocus` 改跳转、首屏 6 元素被 TabBar 挤出视口。
→ 详见 §9；§9.2 三条为不可破红线，A7/A8 落地前须逐条对照。

**次要 gap（记录，不阻塞 P0）**
- 运营配置 `ops.home-feed`/`ops.home-banner` 影响面声明为「H5 首页 /feed」，但 H5 router 无 `/feed` 路由 —— 运营配置与 C 端页面尚未对齐。
- `LOCKED_CONFIG_AREAS` 共 16 项（C0–C4），当前仅落 4 可配 + 6 锁定。
- `/review/limits` 目标消费 `GET /v1/market/limit-ladder`、`/review/portfolio` 消费 `GET /v1/watchlist/review`，当前 production 仍 `unavailableReviewGateway`，待端点冻结后切换。

---

## 8. BRD 章节映射与一致性对齐

> 回填日期 2026-11-06（H1）。上游：`docs/requirements/brd-c-end.md`（BRD-CEND-001 v1.0，A20 + A21）。BRD 已在归档状态（A20/A21 不常驻），故 BRD 侧的修订由本席按 §8.2 直接落地并在 BRD 变更记录留痕。

### 8.0 两套优先级口径必须分开（先定术语，否则后面全错）

| 口径 | 出处 | 含义 | 用法 |
| --- | --- | --- | --- |
| **P0 / P1 / P2** | BRD §1「优先级定义」 | **数据就绪度**：P0 = 现有 contracts + `warehouse/serving/ports.yaml` 5 个 serving view 已具备；P1 = ingest 已定义但无 serving view/契约；P2 = 当前无数据源 | **只在 BRD/ADR/数据依赖语境使用**。不得用于表达「本期是否交付」 |
| **Now / Next / Later** | 本 PRD（§8.3） | **交付批次**：Now = 本期必须交付并验收；Next = 下一批，等契约/数据/签字就绪；Later = 未排期 | **本 PRD 描述范围只用这一套** |

裁定（H1）：**一个词不能同时表示"数据有没有"和"这期做不做"**——BRD 标 P0 不等于本期必须上线（例：MKT-05 page-summary 数据具备，但五段骨架消费进 Next）；BRD 标 P1 也不等于本期欠交付（例：AI-01..05 全 P1，本期只交付页面壳）。二者混用会同时制造"范围膨胀"和"验收口径漂移"两类事故，故本 PRD 全文改用 Now/Next/Later。

### 8.1 页面 ↔ BRD 章节/功能条 映射总表

| PRD 节 | 页面/能力 | BRD 章节 / 功能 ID | BRD 就绪度 | 本期批次 | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| §3.1 | 行情首页（检索入口） | §2.2 S1/S4；§3.1 MKT-01（检索入口）；MKT-06（指数概览）、MKT-07（涨跌分布）未纳入 | P0 / P1 / P1 | **Now**（仅检索 + 数据说明）；指数概览/涨跌分布 **Next** | 部分覆盖：BRD 首页市场概览依赖 P1 数据，见 §9.3 |
| §3.2 | 我的自选 `/watchlist` | §3.5 WAT-01 加自选、WAT-02 删自选、WAT-03 自选列表 | P0 | **Now** | 覆盖 |
| §3.3 | 个股页 `/stocks/:id` | §3.1 MKT-01 基础信息、MKT-02 行情快照、MKT-03 日线、MKT-05 五段骨架+缺口；§3.2 FUN-01 财务摘要；§3.4 AI-01 个股 AI 解读；§4 合规 | P0×5 + P1（AI-01） | **Now**（行情/基本面/免责/缺口卡）；五段骨架消费 `page-summary`、AI 生成层、K 线段控 **Next** | 覆盖（含 1 条 Next） |
| §3.4 | 自选组合复盘 `/review/portfolio` | §3.5 WAT-04 自选组合区间统计 | P0 | **Now**（收益/波动/回撤/等权/标的数）；基准对比 **Next**（`BENCHMARK_PENDING`） | 覆盖 |
| §3.5 | 涨跌停概览 `/review/limits` | §3.1 MKT-04 收盘涨跌停梯队（+MKT-07 全市场宽度 P1） | P0 | **Now**（聚合口径，禁个股下钻） | 覆盖 |
| §3.6 | AI tab `/ai` | §3.4 AI-01..AI-05；§4.1 AI 内容专项合规 | P1 / P2 | **Now** 仅页面壳 + 缺口卡；生成层与对话 **Next/Later** | 部分覆盖：BRD 全列 P1，PRD 原标"P0 目标"已改（§8.2 #3） |
| §3.7 | 我的 `/me` | §6 F1 授权门禁 + §3.6 CMP-01..04（本次补入 BRD） | P0 | **Now** | 覆盖（BRD 原缺合规展示条，已补，§8.2 #5） |
| §3.8 | 未找到 `*` | 无 | — | **Now** | 无 BRD 对应：路由兜底，非业务功能 |
| §3.9–§3.13 | Console 五页（运营/管理/合规/CRM） | **无**（BRD 范围仅 C 端 c_end audience） | — | **Now**（overview/config/approvals/compliance 接真实契约）；CRM **Later** | 无 BRD 对应，由本 PRD 独立承载；不要求 BRD 补 |
| §4 | API 对齐总表 | §5 数据依赖（字段/来源/频率） | — | — | 覆盖：端点→字段，BRD 提供数据来源与缺口码 |
| §6.3 | 合规展示硬约束 | §4 合规边界（H3-C01..C12 逐条）、§4.1 AI 专项、§6 上线门禁 | P0 | **Now** | 覆盖（逐条对齐，见 §8.2 #4/#5） |
| §5 | 组件清单 | 无 | — | — | 实现层，BRD 不覆盖 |
| §7 | gap 清单 | §5.1 数据依赖总结（已具备/P1/P2） | — | — | 覆盖 |

### 8.2 已裁定并对齐的不一致（12 条）

| # | 不一致 | 错在哪边 | H1 裁定 | 已改动位置 |
| --- | --- | --- | --- | --- |
| 1 | 优先级同名不同义：BRD 的 P0/P1/P2 = 数据就绪度；PRD 的"P0 目标" = 交付批次 | 两文档都缺术语约束 | 统一为 §8.0 两套口径，PRD 只用 Now/Next/Later | PRD 头部 + §8.0 |
| 2 | PRD 头部写"本文不引用 BRD，独立成文" | PRD（成稿时 BRD 未就绪，现已过期） | 改为引用 BRD 并声明映射关系 | PRD 头部 |
| 3 | PRD §3.6 AI tab 标"P0 目标"；BRD §3.4 AI-01..05 全 P1/P2 | PRD | AI 页面壳 **Now**，生成层 **Next**；PRD 不得标 P0 | PRD §3.6 |
| 4 | BRD §6.1 写"行情/财务/**AI 恒 403**" | BRD（语义错） | **403 = 无权展示（entitlement），AI 未上线 = unavailable（能力未就绪）**，两者不可混。AI 不走 403，走缺口卡 `unavailable` | BRD §6.1 |
| 5 | BRD 功能清单无「免责声明 / AI 标识 / as_of / 退订入口」四条（PRD §6.3 全列 P0 不可配项） | BRD（缺条） | BRD 补 §3.6 合规展示板块 CMP-01..04，全部 P0 | BRD §3.6（新增） |
| 6 | BRD §2.2 场景 S1/S2/S4 把分时/K线/资金/龙虎榜写进用户旅程，但这些是 P1/P2 | BRD（旅程与就绪度脱节） | 加注：P1/P2 板块在接入前以缺口卡呈现，不进入本期旅程 | BRD §2.2 注 |
| 7 | PRD §3.1 首页"刻意不展示任何价格数字" vs 设计 v2 首页四板块 | 设计 v2 超前于数据 | 本期维持零数值；四板块 Next/Later（§9.3） | PRD §3.1 + §9.3 |
| 8 | 设计 v2 首页「成交额前列」榜单 vs H3-C09 禁"榜单/排名/排序" | 设计 v2 | **本期不做**；进 Next 前须 H3 书面认定（红线解释权不在 H1） | PRD §9.3 |
| 9 | 设计 v2 个股页段控默认「分时」 vs BRD MKT-08 = P2 无数据源 + 已裁 C2=A 不做盘中实时 | 设计 v2 | 默认改「日K」（MKT-03 契约已在）；分时在数据接入且 C2=A 重估前**不出现** | PRD §9.3 |
| 10 | 设计 v2 `SearchBar onFocus → navigate('/search')` 但 router 无 `/search` 路由（已核：`web/h5/src/lib/router.tsx` Route 仅 home/watchlist/portfolio/limitLadder/stock/notFound） | 设计 v2 | 本期保「输入 + 查看」形态（`onFocus` 不跳转）；`/search` 页 **Next** | PRD §9.1 |
| 11 | 设计 v2 自选按钮进 NavBar mini Button；PRD §3.2 原写内联文案 `登录后可加自选` | 两边都要改 | 位置改 NavBar 右置；未登录点击后引导 + 提示，不塞内联文案；`Toast` 不替代 `aria-pressed` | PRD §3.2 |
| 12 | BRD 变更记录写"6 板块 26 条"，实际 5 板块（行情/基本面/研究/AI/自选）29 条、P0 10 条 | BRD（笔误） | 按实际计数改 | BRD 变更记录 |

### 8.3 本期范围表（H1 拍板，2026-11-06）

**Now（本期必须交付并通过验收）**
1. C 端 6 页：行情首页（检索形态）/ 自选 / 个股页（行情+基本面+免责+缺口卡）/ 组合复盘 / 涨跌停概览 / 我的。
2. 全局：底部 5 tab `TabBar`、全站 `AppFooter`（免责摘要 + 退订入口）、`/ai` 页面壳。
3. Console 4 页接真实契约（overview / config / approvals / compliance）；`/console/crm` 保持占位。
4. 合规硬约束全部生效：403=无权展示（零数值、无重试）、AI 标识 + 不可关闭免责、as_of 必带、退订入口不可隐藏。

**Next（等契约/数据/签字就绪）**
1. 首页指数概览（需 `index_daily` + serving view + 契约，BRD MKT-06）。
2. 首页涨跌分布（MKT-07，`MARKET_BREADTH_PENDING` 已预留）。
3. 个股页 K 线段控（MKT-03 契约已在，但需 `bars` 端点接入 UI）+ 五段骨架改消费 `page-summary`（MKT-05）。
4. AI 生成层（AI-01/02/04）——须 ADR-007 条件 1–4 闭环 + H3 policy 分区签字。
5. `/search` 独立搜索页；组合基准对比（`BENCHMARK_PENDING`）。
6. 首页「成交额前列」——**前置条件：H3 书面认定不触 H3-C09**；H3 不认则不做。

**Later（未排期，随数据采购/裁定推进）**
1. 分时/五日（MKT-08，需先重估 C2=A「不做盘中实时」裁定）。
2. 研究板块 RSR-01..08（龙虎榜/资金流/两融/北向/大宗等，均 P1 且需 serving view）。
3. 基金持仓（RSR-06）、宏观政策（RSR-07）——无数据源。
4. 资讯流——BRD 无功能条、无数据源，且涉资讯转载授权（H3 版权/H4 数据源），不进 Next。

> 范围纪律：**Next/Later 的任何一项都不得以"顺手做了"的名义挤进 Now 的验收**；Now 的验收只看 §8.3 第 1–4 条。要加范围，走 H1 重排并更新本节。
---

## 9. 组件迁移的产品影响（antd-mobile / antd 引入）

> 背景：owner 拍板正式引入 antd 全家桶（`web/h5` → antd-mobile 5，`web/console` → antd 5）。设计侧规范见 `docs/design/system-v2.md`、`docs/design/c-end-h5-v2.md`；分工见 `docs/roster-division-2026-11-06.md` §三。
> 本节只回答产品问题：**换组件库之后，用户看到的交互变没变、已经写死的验收契约会不会被打断、要不要因此改范围。** 技术选型细节（版本锁定、Vite7 兼容、tree-shaking 配置）不属本席，交 A0/A7/A8。

### 9.1 逐条交互影响（C 端）

| # | 交互/页面 | 现状 | antd 迁移后 | 产品影响与裁定 |
| --- | --- | --- | --- | --- |
| 1 | 导航结构 | 顶部 3 裸链接（首页/自选/复盘） | 底部 5 tab `TabBar`（行情/自选/组合/AI/我的） | **IA 变更，已认可**。三条连带约束：①`/review/limits` 归入「行情」tab，激活态映射必须显式（`tabKeyForRoute`），否则深链进入概览页会无高亮；②每个 tab 的 `data-testid` 与 `aria-current="page"` 必须由包装层输出，antd-mobile 的 `TabBar.Item` 不透传 `data-testid`；③TabBar 占高 50 + `safe-area`，**首屏可视高度减少**，个股页"6 元素免滚动可见"须实测复核（见 9.2 第③条） |
| 2 | 首页检索 | 输入框 + `查看` 按钮；前端正则校验后跳个股页 | `SearchBar`，设计稿 `onFocus → navigate('/search')` | **不接受 focus 即跳转**。router 无 `/search` 路由（已核 `web/h5/src/lib/router.tsx`），跳转会落在 404；且跳走后再输码，等于把"输码→校验→进详情"的一步流程拆成两页。**本期保原形态**：`SearchBar` 只作输入控件，`onFocus` 不跳转，保留 `查看` 提交与非法输入 inline 提示（§3.1）。`/search` 独立页列 **Next**（需热股/拼音/联想的数据源，属 P1 之外） |
| 3 | 个股页加自选 | 正文区普通按钮；未登录显示 `登录后可加自选` | NavBar 右侧 mini `Button` + `Toast` | 位置变更**认可**（拇指可达）。但 mini 按钮放不下内联登录提示：改为按钮固定 `☆ 加自选`、未登录点击引导登录（§3.2 已改）。**`Toast` 只作附加反馈**，状态真源仍是 `aria-pressed` + `data-testid`，E2E 不得断言 Toast |
| 4 | 行情卡 | 手写 `.card` 三段（价格/来源/as_of/免责） | antd-mobile `Card`（无 footnote 段） | `Card` 默认只有 header/content：**来源 + as_of + 免责必须落在自定义 footnote 区**，不得因为组件没有该槽位就并入正文小字。免责/as_of 字号下限 13px、对比度按 `system-v2` §2.1——这是合规硬约束，不是视觉偏好 |
| 5 | 下拉刷新 | 无 | `PullToRefresh` | **新增交互，需要补契约**：刷新后所有可见卡片的 as_of/来源必须同步更新；刷新失败**保留旧数据**并在 as_of 旁加「未更新」标记，不得静默用旧值冒充新值；restricted（403）态下刷新**仍为零数值**，不得因刷新把 `EntitlementNotice` 换成 antd `Empty` |
| 6 | 上滑加载 | 无 | `InfiniteScroll` | 本期仅自选列表可能用到（资讯流不在 Now）。底部态文案 `加载中` / `没有更多内容了`；失败用常驻「加载失败，点击重试」行，不用会自动消失的 `Toast`（用户会错过） |
| 7 | 加载 / 空 / 错误三态 | 自研 `PageState`/`States`，语义严格 | antd `Skeleton`/`Empty`/`ErrorBlock` | **不许直接替换**。必须经 `AntdStateAdapter` 映射：403 → `EntitlementNotice`（Problem 原文、零数值、无重试）；DataGap → 缺口卡（虚线中性）；Empty 只用于"确无数据"；Loading 不出现在个股页首屏 6 元素区。antd `Empty` 的默认插图与「暂无数据」文案**不得**用于 403 或缺口 |
| 8 | 个股页 K 线段控 | 无 | 段控 `分时/五日/日K/周K/月K`（默认分时） | **默认值必须改「日K」**：分时 MKT-08 = P2 无数据源，且已裁 C2=A 不做盘中实时；默认落在无数据的能力上 = 首屏即缺口卡。分时在数据接入 + C2=A 重估前不出现（§9.3） |
| 9 | 免责与退订 | 个股页内 `DisclaimerNotice` + `/me` 退订 | 全站 footer `DisclaimerSummary` + `UnsubscribeEntry` | **认可并升级为全局约束**：免责摘要不可折叠、不可关闭，退订入口全站常驻且不可被运营隐藏。但仍受首屏约束——footer 不得把 6 元素挤出首屏（见 9.2 第③条） |
| 10 | 深色模式 | 无 | antd-mobile 默认主题 + `system-v2` 深色 token 双轨 | 两套主题并存会出现"涨跌色在深色下不达标"。**以 `system-v2` §2.1 为唯一真源**，antd 主题变量须覆盖到同一组色值；验收按深色全档 4.5:1 |

### 9.2 三条不可破的验收契约（迁移前逐条对照，破一条即 P0 不通过）

1. **`data-testid` 与 `aria-*` 不得丢。**仓库已有门禁 `web/h5/scripts/check-testids.mjs`：`tests/e2e/testids.json` 里的每个 id 必须出现在 `web/h5/src`，而 `disclaimer-close` 必须**不**出现（无关闭控件）。antd 组件不透传 `data-testid` 到 DOM，故**所有 antd 组件必须经包装层挂 testid**；改名/漏挂会同时打断 E2E 与该门禁。
2. **403 语义不得被组件默认态吃掉。**`403 = 无权展示（entitlement 拒绝）`，`404 = 无数据`，`unavailable = 能力未就绪`——三者在文案、图标、后续动作（403 无重试 / 404 可返回首页）上都不同。禁止用 antd `Empty`/`Result` 统一糊成"暂无数据"。
3. **个股页首屏 6 元素（名称 / 最新价 / 涨跌幅 / as_of / 来源 / 免责）在 390×844 下必须免滚动可见。**新增 NavBar（44 + 状态栏）+ TabBar（50 + safe-area）+ 全站 footer 会挤压竖向空间。**裁定：AC-10 口径不变**；若放不下，砍的是卡片上方装饰、间距与次级信息，**不砍这 6 个元素，也不把免责折叠进"更多"**。A7 须在 390×844 真机/模拟器实测并留图，实测结果写进 AC-10 证据。

### 9.3 设计 v2 中超出本期数据能力的板块（范围裁定）

| 设计 v2 板块 | 依赖 | 就绪度 | 裁定 |
| --- | --- | --- | --- |
| 首页①指数概览 | `index_daily` + serving view + 契约 | P1（BRD MKT-06，无 serving view） | **Next**。本期不做，也不做缺口卡占位（首页不放四个缺口卡） |
| 首页②涨跌分布 | 全市场 `daily` 聚合 + `stk_limit` | P1（MKT-07，`MARKET_BREADTH_PENDING` 已预留） | **Next**，同上 |
| 首页③成交额前列（客观榜单） | 全市场成交额排序 | 无 BRD 功能条；排序榜属 H3-C09 风险区 | **本期不做**。进 Next 的前置条件：**H3 书面认定该榜不触 H3-C09**（红线解释权归 H3，H1 不代判）。设计稿的「按成交额排序 · 系统生成 · 非推荐」是必要不充分条件 |
| 首页④资讯流 | 资讯源 + 转载授权 + AI 摘要（AI-03 P2） | 无数据源；涉版权/许可（H3）与数据源（H4） | **Later**，且需 H3/H4 分别出结论；不做"先抓公开网页顶上" |
| 个股页分时/五日 | 分钟级数据 | P2（MKT-08 当前无数据源）+ 已裁 C2=A 不做盘中实时 | **Later**，前置为 C2=A 重估（H1 签） |
| 个股页日K/周K/月K | `daily` + `adj_factor` | P0（MKT-03 契约已在） | **Next**（页面消费 `bars` 端点即做） |

> 一句话结论：**设计 v2 的版式可以照搬（东财式信息密度是对的），但它假设的数据能力比现有多 3 个批次。**版式 Next 复用，板块按上表分批，不许"先摆 UI 再补数据"——摆上就得显示缺口卡，一屏缺口卡的首页不如现在这个干净的检索页。

### 9.4 包体积（AC-9 是硬门禁，不因组件库上调）

- 门禁 `web/h5/scripts/check-budget.mjs`：`dist/assets/*.js` gzip 合计 ≤ 200 KB（`BUDGET_BYTES = 200*1024`），脚本注释已明确"超预算优先砍功能，不允许砍免责声明、as_of、数据来源"。
- 接入 antd-mobile 前该门禁实测 **79.1 KB gzip / 200 KB 上限**（本轮实跑）。引入后必须重跑并留数。
- **H1 立场**：200 KB 上限是我的 veto 项，**不上调**。若超限，砍的顺序是：`Toast`/`PullToRefresh`/`InfiniteScroll` 退回原生实现 → 只在需要的页面按需引入 → 砍动效；**最后才动合规要素，而动合规要素直接否决**。

### 9.5 Console 侧（antd）产品约束

| # | 现状 | antd 迁移后 | 约束 |
| --- | --- | --- | --- |
| 1 | 自研 `AppShell`（侧栏 + 分组 + 审批徽标） | antd `Layout`/`Menu` | 分组标签 `运营/管理/合规/CRM` 与 `pendingCount` 徽标不得丢；`<1200px` 收图标栏、`<992px` 提示桌面端（`system-v2` §4） |
| 2 | `DataTable` 自研表格 | antd `Table` | 审计表列序 `时间/动作/对象/操作者/详情/结果` 固定；分页 `pageSize=20` 固定、关闭 `showSizeChanger`（审计导出口径不能漂）；human/agent 必须可区分（`ActorBadge` + agent 行 2px 竖条） |
| 3 | `DoubleConfirm` 两步（勾选影响面 + 输危险词） | antd `Modal.confirm`/`Popconfirm` | **不许退化**成一次点击确认。发布/回滚/驳回一律两步；审批通过 Modal 顶部**固定渲染 `DiffViewer`**，不允许折叠成"查看详情" |
| 4 | `DiffViewer` 三点合并（base/mine/theirs） | 沿用 | 409 冲突必须给三点合并，不得简化为"覆盖/放弃" |
| 5 | `LevelBadge`/`StatusBadge`/`ImpactPanel` | antd `Tag`/`Badge` | 色只取自 `system-v2` §2.4；禁止白字压浅底 |

### 9.6 需要 A7 / A8 / A10 回我的四件事

1. **A7**：390×844 下新增 NavBar+TabBar+footer 后，个股页首屏 6 元素是否仍免滚动可见？给截图 + DOM 尺寸。若不可，先提方案给我，别自行调整 6 元素（§9.2 第③条）。
2. **A7**：antd-mobile 包装层的 `data-testid` 落点清单（哪些 item 需要 wrapper）+ `check-testids.mjs` 跑通截图。tab 深链激活映射的实现位置（`tabKeyForRoute`）。
3. **A7**：引入 antd-mobile 后 `check-budget.mjs` 实测值，按页面拆出组件体积，超 200 KB 时给我砍单。
4. **A8/A10**：Console 审计表在 antd `Table` 下的 human/agent 区分形态是否保留（`ActorBadge` + agent 行竖条），以及 `DoubleConfirm` 是否仍为两步——这两条是审批留痕的验收面，不能靠"组件默认样式"。

---

## 10. P1 四条主线验收标准（17 席编制重建后，2026-11-06）

> 本节回答：**P1 四条主线（P1-4 组件库 / P1-5 五 tab / P1-6 Console 真实契约 / P1-7 行情真实数据）做到什么程度算「做完」，用什么命令能验。** 本节只把 §8.3 Now 的验收面写实，不扩范围、不新增功能；验收证据的「证据等级」沿用 `docs/p0-acceptance.md` §4b。

### 10.0 编号与术语（先读，防混用）

- `P1-4` … `P1-7` 是**编制重建后的 P1 主线条目号**（H1 backlog 编号，承接本轮任务板编号），**不是** BRD 数据就绪度 P1（§8.0 硬规则），也不是 §8.3 的批次名。本节一律写「P1-4 组件库」这类全称，不写「P1 组件库」。
- 与 §8.3 Now 的映射：

| 条目号 | 主线 | §8.3 Now 对应 | 主要责任席位 | 验收门禁 owner |
| --- | --- | --- | --- | --- |
| P1-4 | 组件库引入（H5 → antd-mobile 5；Console → antd 5） | Now#2 全局导航 / Now#3 Console | M1 映射产物、H2 评估、A6 实施、A8 构建 | H1 定产品验收面；A7 落门禁 |
| P1-5 | C 端 5 tab + `/ai` + `/me` 页面壳 | Now#1 六页、Now#2 导航 | A6 | A7 |
| P1-6 | Console 四中台接真实 `/v1/internal/*` | Now#3 | A6（Console）+ A4（后端面） | A7 + A4 契约测试 |
| P1-7 | 行情/基本面换真实数据源 + `as_of` 口径 | Now#1 行情/个股页的数据前提 | A1 取数、A2 serving、A3 接口 | A7 + A3 单测 |

- 证据等级：**A** = 自动化门禁已接入可跑且实跑通过；**B** = 命令可复跑但未接 CI（报告须附本次输出/截图）；**C** = 未测量（必须写「未验证 + 原因」，不得声称通过）。
- 一条不通过 = 该条目不通过；不因其他条目绿而豁免。范围纪律见 §8.3 尾注。

### 10.1 P1-4 组件库引入（antd-mobile 5 / antd 5）

H1 只定「用户看到的交互与已写死的验收契约不能变」；版本锁定、tree-shaking、构建配置归 H2/A8（`docs/adr/` 评估单）。

| AC | 验收标准（机器可验优先） | 验证方式（命令 / 断言） | 等级 | 责任 |
| --- | --- | --- | --- | --- |
| AC-P14-1 | 依赖锁定：`web/h5` 含 `antd-mobile@5.43.x`，`web/console` 含 `antd@5.29.x`（以 H2 评估单版本为准；偏差须 H2 书面变更）；`pnpm-lock.yaml` 同步；除评估单列明项外不新增运行时依赖 | `node -e "const v=require('./web/h5/package.json').dependencies?.['antd-mobile'];process.exit(v&&v.startsWith('5.43')?0:1)"`；console 同法；`git diff --stat pnpm-lock.yaml` | B | H2→A6 |
| AC-P14-2 | 200KB 硬门禁：`check-budget.mjs` PASS，`dist/assets/*.js` gzip 合计 ≤ 200KB；报告写实测值（接入前基线 79.1KB）与按页拆分 | `pnpm -C web/h5 build && node web/h5/scripts/check-budget.mjs` | B（CI 未接，AC-9=B） | A6/A8 |
| AC-P14-3 | 验收锚点不丢：`check-testids.mjs` 通过；`tests/e2e/testids.json` 既有 id 只增不删不改名；`disclaimer-close` 必须不存在 | `node web/h5/scripts/check-testids.mjs`；`git diff tests/e2e/testids.json` 只允许新增行 | B | A6/A7 |
| AC-P14-4 | 403 语义不被组件库吃掉：`ENTITLEMENT_RESTRICTED` 渲染 `EntitlementNotice`（Problem 原文、零数值、无重试）；不得用 antd `Empty`/`Result` 糊成「暂无数据」；契约层无 `200 + is_entitled=false` | 复用受限档 E2E（`E2E-P0-06`/`E2E-P0-12`，2026-11-04 复跑 2 passed）+ 契约测试 | B | A6/A7 |
| AC-P14-5 | 首屏 6 元素不破（AC-10 口径不变）：390×844（`tests/e2e/playwright.config.js` 已固定该 viewport）下，名称/最新价/涨跌幅/as_of/来源/免责 6 元素 `boundingBox` 底部 ≤ 844，初始 `scrollY=0` 且无需滚动；留截图 | `pnpm -C tests/e2e test` 中新增 `specs/p1-*.spec.js`（A7 写）：断言每个 6 元素 `box.y + box.height <= 844` | B | A7 |
| AC-P14-6 | 深色模式对比度：以 `docs/design/system-v2.md` §2.1 为唯一真源；正文/背景 token 对 WCAG 2.1 ≥ 4.5:1（大字 ≥ 3:1），涨跌色深色档同标 | 需 A7 建可复跑对比度脚本（当前无 → 记 **C**，脚本落 `tests/` 后升 B） | C→B | A7/M1 |
| AC-P14-7 | Console 不退化（§9.5）：审计表列序 `时间/动作/对象/操作者/详情/结果`、`pageSize=20` 固定、human/agent 可区分；`DoubleConfirm` 仍两步；409 仍三点 `DiffViewer` | `pnpm -C web/console test`（断言上述 DOM/行为） | B | A6/A7 |

### 10.2 P1-5 C 端 5 tab（`/ai` + `/me` 页面壳）

现状（2026-11-06 亲验）：`web/h5/src/App.tsx` 仅顶部 3 个 Link（`/`、`/watchlist`、`/review/portfolio`），无 TabBar、无 `/ai`、无 `/me`。

| AC | 验收标准 | 验证方式 | 等级 | 责任 |
| --- | --- | --- | --- | --- |
| AC-P15-1 | 5 tab 文案与顺序固定：`行情 /`、`自选 /watchlist`、`组合 /review/portfolio`、`AI /ai`、`我的 /me`；5 路由直达均渲染对应页（非 404） | e2e 逐路由 + 断言 TabBar 5 项文案顺序 | B | A6 |
| AC-P15-2 | 深链激活：任一路由直达/刷新后对应 tab `aria-selected="true"`；二级页归属 `tabKeyForRoute`：`/stocks/:id`→行情、`/review/limits`→组合 | `tabKeyForRoute` 单测 + e2e 断言 `[data-testid=tabbar] [aria-selected=true]` | B | A6 |
| AC-P15-3 | `/ai` 壳（§3.6 Now）：列表空态、每条 `AiGeneratedBadge`（文案「AI 生成 · 仅供参考」）、不可关闭 AI 免责（服务端注入，前端不硬编码）、`as_of` 展示位、`unavailable` 缺口卡；**不接生成、不出现任何模型生成可见内容** | e2e + `check-testids.mjs`；免责无关闭控件（`disclaimer-close` 不存在） | B | A6/A7 |
| AC-P15-4 | `/me` 壳（§3.7 Now）：登录态、我的自选入口、**退订入口置顶且不可隐藏**（`unsubscribe.entry` 不可配项）、免责版本、数据来源说明 | e2e 断言元素存在且退订可点 | B | A6 |
| AC-P15-5 | 小屏与深色：375×667 下 `document.documentElement.scrollWidth ≤ 375`（无横向滚动），5 tab 不换行不重叠；`prefers-color-scheme: dark` 下可用 | e2e 375 viewport + 深色 emulation | B（对比度部分见 AC-P14-6=C） | A6/A7 |
| AC-P15-6 | 回归不降：既有 E2E 基线 **11 passed / 1 skipped**（正常档，`tests/e2e/E2E-RUN-2026-11-04-native.md` §2c）不得下降；P1 新增用例后 passed 只增不减，skip 变化须逐条写明环境缺件 | `pnpm -C tests/e2e test` | B | A7 |

### 10.3 P1-6 Console 四中台接真实 `/v1/internal/*`

**前置缺口（2026-11-06 亲验，必须先说清，否则验收会假绿）**：

- `services/identity/src/plugin.ts` 目前只注册 `POST /v1/internal/auth/register`；`/v1/internal/configs*`、`/v1/internal/approvals*` 的**契约在**（`contracts/config/openapi.yaml:44-431`、`contracts/approval/openapi.yaml:42-259`），**实现未见**（services 下无 approval 服务目录）。
- 合规审计（`reviews/compliance`）与审计表**无 openapi 契约**（`contracts/` 无对应文件）——属契约缺口，须 H2 定、A4 实现；缺口关闭前该子项记「未验证 + 原因」，**不得用 Mock 充当通过**。
- 因此 P1-6 验收对 A4 后端面（task-5）**存在硬依赖**；A6 可先按契约实现数据层，但「打通」类 AC 必须真栈。

| AC | 验收标准 | 验证方式 | 等级 | 责任 |
| --- | --- | --- | --- | --- |
| AC-P16-1 | 默认数据源真实化：`web/console/src/App.tsx` 默认分支不再 `new MockBackend(...)`（现为 `App.tsx:20`），默认走 HTTP adapter（如 `src/adapters/http-config-service.ts`）；mock 仅显式开关（`?mock=1` 或 `VITE_CONSOLE_MOCK=1`） | 单测断言默认 services 为 HTTP 实现；`grep -n "new MockBackend" web/console/src/App.tsx` 不得出现在默认分支 | A/B | A6 |
| AC-P16-2 | 三条读路径真栈打通：`GET /v1/internal/configs`、`GET /v1/internal/approvals` 返回 200 且过 schema 校验；合规审计只读路径在契约就绪后同验 | 真栈 `curl -s -o /dev/null -w '%{http_code}'` 两条；`pnpm -C web/console test` | B | A6/A4 |
| AC-P16-3 | 写路径乐观锁：写操作带 `If-Match`；409 返回三点 diff（base/mine/theirs）且 UI 渲染 `DiffViewer`，不得简化为「覆盖/放弃」 | 单测注入 409 → 断言 DiffViewer 三段；契约测试断言 409 Problem 结构 | B | A6/A4 |
| AC-P16-4 | 越权与 403：C 端 token 访问 `/v1/internal/*` 必拒（403/401）；业务无权 → 403 + `ENTITLEMENT_RESTRICTED`，禁止 `200 + is_entitled=false` | 契约测试（`pytest tests/contract`，基线 63 passed 不得下降） | B | A4 |
| AC-P16-5 | 构建不破：`pnpm -C web/console typecheck` 与 `pnpm -C web/console build` 通过；除 H2 评估单批准项外不新增依赖 | 命令输出 | B | A6 |
| AC-P16-6 | 审批留痕不退化（§9.5 #2/#3）：审计表列序/分页固定、human/agent 区分、`DoubleConfirm` 两步、审批 Modal 顶部固定 `DiffViewer` | `pnpm -C web/console test` | B | A6/A7 |

### 10.4 P1-7 行情 / 基本面真实数据 + `as_of` 口径

现状（2026-11-06 亲验）：`services/market/src/adapters/pg-serving-repo.ts` 已从 PG serving view 取数，`as_of` 取自行值（`:145-170` 以 `Asia/Shanghai` 格式化）；`services/market/src/routes.ts:8` 明确快照降级「保留原始 as_of、按当前时刻重算 staleness_ms」。**工程口已开始真实化；风险在数据质量、配额与授权，不在代码骨架。**

| AC | 验收标准 | 验证方式 | 等级 | 责任 |
| --- | --- | --- | --- | --- |
| AC-P17-1 | 无 fixture 兜底冒充真实：生产路径不得有内存 fixture 价格；未命中 serving → 快照降级（保留原始 `as_of`），快照也未命中 → 5xx Problem | 单测（命中/降级/双缺三态）+ `grep -rn "fixture" services/market/src` 为空 | B | A3 |
| AC-P17-2 | `as_of` 严格来自数据批次：间隔 ≥1s 两次请求 `as_of` 不变；`as_of ≤` 请求时刻；与 serving 行值严格相等（AC-2 口径） | 单测注入批次时间 T → 断言响应 `as_of == T`；e2e 间隔请求断言不变 | B | A3/A7 |
| AC-P17-3 | 403 矩阵与顺序不回归：`requireEntitled` 先于 `loadInstrument`（`routes.ts:168`），历史 1011ms 熔断缺陷不回潮；现场 P95 记录（§6.1） | 单测 spy 顺序断言 + 现场 P95 统计 | B | A3 |
| AC-P17-4 | 数据质量：golden 30/30（21 正 + 9 负）；质量分只计 blocker（H4 会签前以 `tests/data/quality_policy.yaml` 的 `score_counts: blocker_rules` 为准，不另立口径）；bars 带 `source`/`as_of`/`adj_type` | `pytest warehouse/tests data/golden` 类既有命令输出 | B | A2 |
| AC-P17-5 | 限流与降级：第 61 次 429 + `Retry-After` 整数 ≥1s + `RATE_LIMITED` Problem；配额耗尽降级快照（`platform_degraded`）不 500 | 单测注入 429/配额错误 + 契约用例 | B | A3 |
| AC-P17-6 | 适配层边界：`services/market/src`、`services/api/src`、`packages/` 内 0 处 `tushare`/`akshare` 代码标识（H1 2026-11-06 grep 为空）；AKshare 依赖当前 `python3 -c "import akshare"` = `ModuleNotFoundError` → A1 须落 pin 可安装，或明确改用 mirror 适配器并写进报告 | `grep -rn "tushare\|akshare" services/market/src services/api/src packages`（仅注释允许）；`python3 -c "import akshare"` | B（AKshare 未装 = 当前 C） | A1 |
| AC-P17-7 | 工程验收 ≠ 授权放行：本条通过只证明「技术上是真实数据」，不证明「有权分发」；放行判定见 G1/G3 | 引用 `docs/requirements/go-live-blockers.md` | — | H1/H4 |

### 10.5 明确不做项（本期 Now 内不做；做了也不算验收通过）

| # | 不做项 | 理由 / 批次 | 依据 |
| --- | --- | --- | --- |
| 1 | 荐股、评级、目标价、择时、收益预测 | 证券投资咨询红线，**永久不做** | 红线②（H3-C01..C12）、`rules/redline-basis.json` |
| 2 | 盘中实时 / 分时 / 五日线 | MKT-08 数据 P2 + C2=A「不做盘中实时」重估前不排 | §9.3 |
| 3 | 首页指数概览、涨跌分布 | 缺 serving view，**Next** | §8.3 Next#1/#2、§9.3 |
| 4 | 首页成交额前列（客观榜） | 需 H3 书面认定不触 H3-C09，否则不做 | §9.3 |
| 5 | 首页资讯流 | 无数据源 + 转载授权未决，**Later** | §9.3、§8.3 Later#4 |
| 6 | `/search` 独立搜索页、组合基准对比 | **Next** | §8.3 Next#5 |
| 7 | C 端 AI 生成层（`POST /v1/ai/analyses`、SSE、对话） | **Next**；须 ADR-007 条件 1–4 闭环 + G2 签发 | §3.6、§8.3 Next#4 |
| 8 | `/console/crm` 真实化 | **Later**，Now 保持占位 | §8.3 Now#3 |
| 9 | 新增运行时依赖（antd/antd-mobile 及 H2 评估单列明项除外） | 体积与供应链纪律 | §9.4、AC-P14-1 |
| 10 | 上调 200KB 首屏预算 | H1 veto 项，不批准 | 红线⑥、§9.4 |
| 11 | `403 → 200 + is_entitled=false` 任何降级 | 红线③，**永久禁止** | §6.3、p0-acceptance AC-5 |
| 12 | 免责/AI 标识可关闭、可折叠、可被运营隐藏 | 红线④，**永久禁止**（含「更多」里折叠） | §3.7、§9.2 |
| 13 | 「先摆 UI 再补数据」（摆上即缺口卡） | 已否：一屏缺口卡的首页不如干净检索页 | §9.3 |
| 14 | App / 小程序 / 桌面端 | 不在本期（仅 H5 + Console） | 本 PRD 定位 |
| 15 | 用「顺手做了」把 Next/Later 挤进 Now 验收 | 直接打回，走 H1 重排 | §8.3 尾注 |

### 10.6 证据与回执要求

- 每个 AC 的通过证据 = **命令 + 输出/截图 + 执行时间 + 执行席位**；未跑写「未验证 + 原因 + 预计可验条件」。
- 新增/改动门禁脚本须落 `tests/`（A7 write scope），不得写进业务包；证据落 `tests/e2e/evidence/` 或 `docs/release/`（A7/A13 域，H1 只引用不代写）。
- 本节 AC 与 §9.2 三条不可破契约冲突时，**以 §9.2 为准**（veto 级）。
- 工程验收（本节）与放行判定（`docs/requirements/go-live-blockers.md` 的 G1/G2/G3）是两个对象：**本节全绿 ≠ 可上线**；反之，放行也须本节全绿。
