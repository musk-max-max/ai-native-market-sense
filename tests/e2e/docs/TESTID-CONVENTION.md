# E2E test-id 约定（A12 → A7 web/h5）

> 目的：E2E 只通过「语义化、稳定」的 test-id 定位元素。选择器写死在测试里，页面实现随意重构，
> 只要 test-id 不变，用例就不该坏。反过来，**test-id 是交接契约**：改名 = 破坏 E2E，必须同步
> `tests/e2e/testids.json` 并通知 A12。

## 规则

1. **属性**：web/h5 用 `data-testid="..."`；值用 kebab-case（`quote-price`，不是 `quotePrice`、`Quote_Price`）。
2. **语义化**：id 描述「这是什么」（`disclaimer-version`），不描述「长什么样」或「在哪」（禁止 `left-panel`、`div3`、`row-2-col-1`）。
3. **禁止序号/布局选择器**：测试禁止 `nth-child`、`:nth-of-type`、`div > span` 这类结构依赖；页面重排不得导致用例失败。E2E 代码里出现 `nth-child` 视为 review 阻塞项。
4. **一个语义节点一个 id**：id 加在承载语义的最内层元素上。不要把 id 加在包裹层再在测试里 `querySelector` 往下钻——断言目标必须就是 id 所在节点。
5. **状态与内容分离**：loading / error / empty 用独立 id（`stock-page-loading` / `stock-page-error` / `stock-page-empty`），不要复用业务 id + 文案匹配。异步状态断言不依赖时序。
6. **同一 id 在页面内唯一**：重复 id 会让 Playwright strict mode 直接报错；若列表项需要 id，带稳定业务键（如 `watchlist-item-SSE:600519`），不用数组下标。
7. **文案不是契约**：测试可断言文案存在/格式（免责版本号、as_of 格式），但定位必须走 test-id；`getByText` 只允许用于「必须出现的产品文案」断言。
8. **数值断言要带单位/格式化依据**：价格、涨跌幅、staleness 的可见文本要标 `data-testid`，且数值范围断言用契约里的 quirk（价格 > 0；staleness > 900000 必现 stale badge）。
9. **免责不可折叠**：`disclaimer` 节点必须常驻且可读（`closable=false` 来自契约）；不提供关闭后隐藏的 test-id 语义。
10. **未授权不渲染数值**：`is_entitled=false` 时，`quote-price` 节点要么不存在，要么文本为空/掩码；E2E-P0-06 会断言「页面上不出现任何形如价格的数字」——这是 F1 否决线，不要用 `--` 占位绕过（占位不是可判读数值，允许，但不得出现真实数值）。
11. **首屏六元素（AC-1）**：`stock-name`、`quote-price`、`quote-change`、`quote-as-of`、`quote-source`（数据来源）、`disclaimer` 必须首屏可见且无需滚动。`quote-source` 于 2026-11-04 由 A12 注册（回应 A7 的契约缺口），文本取自 API `meta.data_source.source`，文案不设死，但不得为空/`undefined`。

12. **重复组件必须带业务键属性**：同一 test-id 允许在页面内重复，**当且仅当**每个节点带稳定业务键属性，测试用
    `[data-testid="data-gap-card"][data-gap-key="valuation"]` 这类「id + 键」定位，禁止列表下标。已登记的重复语义：
    - `data-gap-card` 必须带 `data-gap-key`（缺口业务键，如 `valuation` / `capital-flow`）；卡内可见原因文本用
      `data-gap-reason`（同一 key 作用域内唯一），机器可读 reason code 放 `data-gap-code` 属性，不单独占 testid。
    - `portfolio-metric` / `portfolio-metric-value` 必须带 `data-metric-key`（如 `interval-return` / `volatility` /
      `max-drawdown` / `equal-weight-benchmark`）；值节点嵌在对应 metric 内。
    - `limit-ladder-row` 必须带 `data-limit-key`（方向+梯队，如 `up-1` / `down-2`），不得用 `nth`。
    - `limit-st-exclusion` 若逐标的标注，必须带 `data-instrument-id`（`SSE:600519` 形式）。
13. **AI 段位用固定 key**：五段固定为 `ai-segment-valuation`（估值）、`ai-segment-growth`（成长）、
    `ai-segment-earnings-quality`（盈利质量）、`ai-segment-capital-flow`（资金）、`ai-segment-risk`（风险）。
    段位状态放 `data-segment-status="filled|gap|pending"` 属性；**禁止**前端动态拼 `ai-segment-${任意字符串}`，
    新增段必须先在本文件与 `testids.json` 登记。第 1 批只要求骨架 + 缺口显式，估值段缺口位即 `ai-segment-valuation`
    内嵌 `data-gap-card[data-gap-key="valuation"]`。
14. **AI 标识/免责不可关**：`ai-generated-badge`（「AI 生成」标识）与 `ai-disclaimer`（「信息整合非投资建议」+
    免责声明）常驻；文案由 API `copy.ts` 注入（ADR-007 P7），前端不得硬编码、不得提供关闭后隐藏的 testid 语义。
    第 1 批若 API 尚未注入文案，节点可不渲染，但 testid 契约先登记；一旦渲染，二者必须在 `ai-interpretation` 内可见。
15. **新页面状态 id 独立**：`portfolio-review-page` 与 `limit-ladder-page` 的 loading/error/empty 分别用
    `portfolio-review-loading|error|empty`、`limit-ladder-loading|error|empty`；禁止复用页面根 id + 文案判断。
    `portfolio-scope-note` 用于「自选组合绝对表现，非真实持仓」的口径说明（ADR-007 B1-01），属产品文案，可断言存在；
    持仓口径不得命名为 `portfolio-holdings` 之类暗示真实账本的 id。


## 第 1 批 P0 三切片登记（2026-11-05，KD-COPY-REG-01）

| 切片 | 页面/组件 | testid |
|---|---|---|
| B1-03 个股 AI 解读骨架 + 缺口卡 | `ai-interpretation`（容器）、五段 `ai-segment-{valuation,growth,earnings-quality,capital-flow,risk}`、`ai-generated-badge`、`ai-disclaimer` | `data-gap-card` + `data-gap-key`、`data-gap-reason` |
| B1-01 持仓复盘（自选组合绝对表现） | `portfolio-review-page`、`portfolio-metrics`、`portfolio-metric` + `portfolio-metric-value`（带 `data-metric-key`）、`portfolio-scope-note` | 页面态：`portfolio-review-loading|error|empty` |
| B1-02 涨跌停梯队切片 | `limit-ladder-page`、`limit-ladder-table`、`limit-ladder-row`（带 `data-limit-key`）、`limit-provisional-banner`、`limit-st-exclusion` | 页面态：`limit-ladder-loading|error|empty` |

命名调整：A7 候选名全部保留（不制造无谓改名）；补充 17 个 = AI 五段 5 + AI 免责/缺口内部 3 + 组合指标键/口径/页面态 5 +
梯队表/行/页面态 4。这些是**登记**，不是实现完成；页面未落地前对应 E2E 用例保持 skip。

## 当前 P0 id 集合

见 `tests/e2e/testids.json`（单一真源）。`preflight.py` 会扫描 spec 中 `tid('...')` 的引用并与该文件比对，
出现未定义 id 直接 FAIL（防止测试与页面各自漂移）。

## 新增 id 的流程

1. 在 `testids.json` 增加条目（附中文语义注释/分组），2. web 实现 `data-testid`，3. spec 用 `tid()` 引用。
缺任何一步，preflight 的 TESTIDS 检查会失败。
