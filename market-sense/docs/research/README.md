# Market Sense 研究文档索引（AI 阶段）

> 本目录是「投资服务场景」阶段的研究交付物，供产品 / 数据 / 各 agent 参考。
> 编制日期：2026-11-05。阅读顺序建议：先数据边界 → 再对标 → 再需求 → 再编制。

## 文档清单

| # | 文档 | 用途 | 读者 |
|---|---|---|---|
| 0 | [eastmoney-data-hierarchy.md](./eastmoney-data-hierarchy.md) | **对标输入**：东方财富 C 端 9 大类数据层级（真实页面抓取） | 产品 / 设计 / 数据 |
| 1 | [tushare-15000-credits-data-boundary.md](./tushare-15000-credits-data-boundary.md) | **数据边界**：15000 积分能提供什么 / 需另购什么 / 无什么 | 数据 / AI 需求 |
| 2 | [data-source-gap-matrix.md](./data-source-gap-matrix.md) | **数据对照（交付物①）**：东方财富层级 × tushare 15000 逐项对照 + 缺口红标 | 产品 / 数据 / 决策 |
| 3 | [ai-native-product-requirements.md](./ai-native-product-requirements.md) | **AI native PRD（交付物②）**：5 板块需求 + 合规护栏 + P0/P1/P2 路线 | 产品 / 研发 / 设计 |
| 4 | [financial-research-agent-proposal.md](./financial-research-agent-proposal.md) | **金融研究子 agent 评估（交付物③）**：新增 A20/A21/A22 三席 + 权限分层 | 架构 / 治理 / 各 agent |

## 一句话脉络

东方财富告诉我们「C 端该展示什么」(文档 0) → tushare 告诉我们「数据实际能拿到什么」(文档 1) → 对照得出「哪些能做、哪些降级、哪些是缺口」(文档 2) → 据此写「AI 在投资服务场景怎么用」(文档 3) → 并评估「需要哪些投研专业 agent 来生产这些 AI 内容」(文档 4)。

## 贯穿全部文档的三条硬约束

1. **不荐股**：所有 AI 输出定位为「信息整合与事实归纳」，不得出现买入/卖出/目标价/值得介入。
2. **as_of 时点**：所有数据展示与 AI 引用必带 `as_of`，禁止把延时数据当实时。
3. **分级展示**：`internal_eval`（内部）/ `c_end_display`（面客）两级，受限档 403，AI 不得在面客侧输出受限原始内容。

## 待决策的开放项（见各文档尾部）

- **私募/著名投资人持仓缺口**：外部采购 / 代理指标 / 标注不可得 —— 三选一，影响「综合形势研判」可行性。
- **盘中实时权限**：采购实时行情（¥200–1000/月）做实时版，或先按日频/延时降级版规划。
- **tushare 接口范围核定**：待 H4 按商用授权套餐核定；红线清单待 H3、数据分级待 H5。