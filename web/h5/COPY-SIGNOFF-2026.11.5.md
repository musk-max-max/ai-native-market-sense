# 2026.11.5 前端文案签字清单（一次性 · H3）

- COPY_VERSION：`2026.11.5`（f56 → f57）
- 完整快照：`docs/release/copy-snapshots/2026.11.5.2dfd627b35c1.frontend.json`
- hash：`2dfd627b35c1d6c884b1d6ba185d287e8a63bafb945c6c94a8a4dbeafea777a3`（规范化文案清单 sha256，与 `copy-snapshot.mjs --check` 一致）
- manifest：`docs/release/copy-version-manifest.md` 已 append `B1-P0` 行（旧行未改；backend 2026.11.5 由 A0 配对）
- 覆盖范围：KD-AIP0-B1 第 1 批（INF-07 / B1-01 / B1-02 / B1-03），共 **69** 条新增用户可见文案

## 一、按 H3 格式的逐条清单（11 列）

| copy key | 原文全文 | 类型 | 出现位置（页面+组件+DOM testid） | 触发条件 | 常驻/可关闭 | 是否插值数据字段 | 是否 AI 生成内容 | 目标受众 | 变更 | 合规理由 |
|---|---|---|---|---|---|---|---|---|---|---|
| `copy.app.navReview` | 复盘 | 导航项 | 全局 App / 顶栏导航 | 任意页面常驻 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 导航标签，无信息判断 |
| `copy.home.reviewLink` | 自选组合复盘 | 首页入口 | 首页 HomePage / home__links | 进入首页时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 功能入口标签，无个股指向 |
| `copy.home.limitLink` | 涨跌停概览 | 首页入口 | 首页 HomePage / home__links | 进入首页时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 功能入口标签，无个股指向 |
| `copy.quote.changeLabel` | 涨跌幅 | 数据标签 | 个股页 QuoteBlock / quote-change | 已授权行情展示时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 客观数值字段标签 |
| `copy.ai.sectionTitle` | AI 解读 | 区块标题 | 个股页 / AiInterpretation / ai-interpretation | 个股页已授权且行情数据完整时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | AI 解读骨架标题，不含任何投资判断 |
| `copy.ai.sectionNote` | 五段结构（估值/成长/盈利质量/资金/风险）：本批只有成长、盈利质量两段展示已接入的确定性财报字段；估值、资金、风险无数据来源，用缺口卡显式标注；AI 文本尚待接入。 | 正文说明 | 个股页 / AiInterpretation / ai-interpretation | 同上 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 明示本批只有确定性字段、无模型生成文案 |
| `copy.ai.deterministicNote` | 以下为确定性数据摘要，不是模型生成内容。 | 正文说明 | 个股页 / AiInterpretation / ai-interpretation 底部 | 同上 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 区分确定性数据摘要与模型生成内容 |
| `copy.ai.pendingText` | AI 解读待接入，本段不展示模型生成文案。 | 占位文案 | 个股页 / AiTextSlot（AI 文本位） | AI 文本位无服务端内容时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 如实说明待接入，不放假 AI 文案 |
| `copy.ai.segmentsAria` | AI 解读分段落 | 无障碍标签 | 个股页 / AiInterpretation / ai-interpretation aria-label | 键盘/读屏用户访问时 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 可访问性标签，不含信息内容 |
| `copy.ai.segments.valuation` | 估值 | 段落标题 | 个股页 / AiInterpretation / 五段 ai-segment-* | 个股页已授权且行情数据完整时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定五段分类名，仅客观分类，不含判断或排序 |
| `copy.ai.segments.growth` | 成长 | 段落标题 | 个股页 / AiInterpretation / 五段 ai-segment-* | 个股页已授权且行情数据完整时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定五段分类名，仅客观分类，不含判断或排序 |
| `copy.ai.segments.earningsQuality` | 盈利质量 | 段落标题 | 个股页 / AiInterpretation / 五段 ai-segment-* | 个股页已授权且行情数据完整时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定五段分类名，仅客观分类，不含判断或排序 |
| `copy.ai.segments.capitalFlow` | 资金 | 段落标题 | 个股页 / AiInterpretation / 五段 ai-segment-* | 个股页已授权且行情数据完整时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定五段分类名，仅客观分类，不含判断或排序 |
| `copy.ai.segments.risk` | 风险 | 段落标题 | 个股页 / AiInterpretation / 五段 ai-segment-* | 个股页已授权且行情数据完整时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定五段分类名，仅客观分类，不含判断或排序 |
| `copy.ai.gapTitle` | 维度数据缺口 | 缺口卡标题 | 个股页 / DataGapCard（ai-segment-* 内） | 某维度无数据来源时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 显式披露缺口，不隐藏 |
| `copy.ai.notGeneratedNote` | 本段当前不含模型生成文本；AI 标识与免责仅在服务端注入后随内容展示。 | 正文说明 | 个股页 / AiInterpretation 底部 | 同上 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 明示当前无模型生成文本 |
| `copy.ai.quoteContext` | 行情上下文 | 小节标题 | 个股页 / AiInterpretation / ai-interpretation | 已授权个股页显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 行情数据上下文标签，数值仍来自行情契约 |
| `copy.gap.title` | 数据缺口 | 缺口卡标题 | B1-01/B1-02/B1-03 缺口位置 / DataGapCard / data-gap-card | 对应维度无数据或未接入时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 显式披露数据缺口 |
| `copy.gap.footnote` | 缺口按受控类别显式标注，不用 0、样例值或推测值填充。 | 正文说明 | 缺口区域底部 / DataGapCard 所在区块 | 存在缺口卡时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 说明不用 0 或样例值填充 |
| `copy.gap.reasons.pending_batch` | 该维度数据计划在第 2 批接入，当前不展示。 | 缺口类别文案 | B1-01/B1-02/B1-03 缺口位置 / DataGapCard / data-gap-reason | 对应缺口类别触发时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 如实说明当前版本不提供该类数据，不使用承诺性引导 |
| `copy.gap.reasons.permission` | 当前版本不提供该维度数据。 | 缺口类别文案 | B1-01/B1-02/B1-03 缺口位置 / DataGapCard / data-gap-reason | 对应缺口类别触发时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 如实说明当前版本不提供该类数据，不使用承诺性引导 |
| `copy.gap.reasons.upstream_missing` | 上游尚未提供该维度数据。 | 缺口类别文案 | B1-01/B1-02/B1-03 缺口位置 / DataGapCard / data-gap-reason | 对应缺口类别触发时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 如实说明当前版本不提供该类数据，不使用承诺性引导 |
| `copy.gap.reasons.not_integrated` | 该功能尚未接入，本页不展示占位结果。 | 缺口类别文案 | B1-01/B1-02/B1-03 缺口位置 / DataGapCard / data-gap-reason | 对应缺口类别触发时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 如实说明当前版本不提供该类数据，不使用承诺性引导 |
| `copy.gap.reasons.no_coverage` | 该标的暂无已披露数据。 | 缺口类别文案 | B1-01/B1-02/B1-03 缺口位置 / DataGapCard / data-gap-reason | 对应缺口类别触发时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 如实说明当前版本不提供该类数据，不使用承诺性引导 |
| `copy.review.portfolio.title` | 自选组合复盘 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.subtitle` | 按自选列表等权汇总，固定模板；仅反映自选标的的组合表现，不代表真实持仓。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.scopeNote` | 自选组合绝对表现，非真实持仓；不等同于真实账户收益。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-scope-note | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.templateNote` | 固定模板：区间涨跌、年化波动、最大回撤、等权组合表现；不包含选股或收益承诺。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.periodLabel` | 统计区间 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.periods.1m` | 近 1 月 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.periods.3m` | 近 3 月 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.periods.6m` | 近 6 月 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.periods.1y` | 近 1 年 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.metricsTitle` | 组合表现 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-metrics / portfolio-metric | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.metrics.periodReturn` | 区间涨跌 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-metrics / portfolio-metric | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.metrics.volatility` | 年化波动 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-metrics / portfolio-metric | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.metrics.maxDrawdown` | 最大回撤 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-metrics / portfolio-metric | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.metrics.equalWeight` | 等权组合表现 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-metrics / portfolio-metric | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.metrics.instrumentCount` | 标的数量 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-metrics / portfolio-metric | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.demoNote` | 本地演示数据（mock），仅用于界面开发，不代表真实计算结果。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.loading` | 正在计算自选组合表现… | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-review-loading | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.empty` | 自选列表为空，先添加标的后再查看组合复盘。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-review-empty | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.emptyLink` | 去添加自选 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-review-empty | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.loginRequired` | 登录后可查看自选组合复盘。当前为未登录状态，页面不会伪造组合数据。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.unavailable` | 自选组合复盘尚未接入汇总接口，本页不展示占位数值。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.gapsTitle` | 待接入维度 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / data-gap-card | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.gaps.benchmark` | 相对基准对比 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / data-gap-card | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.gaps.sector` | 板块对比 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / data-gap-card | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.gapFootnote` | 这两项依赖第 2 批研究数据，当前用缺口卡显式占位。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.portfolio.error` | 组合复盘暂时无法加载。 | 页面/区块文案 | 自选组合复盘页 / PortfolioReviewPage / portfolio-review-error | 进入 /review/portfolio 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 固定模板的客观标签/说明，不含评价性表述、归因或预测 |
| `copy.review.limits.title` | 涨跌停概览 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.subtitle` | 按板块规则从日线汇总涨停/跌停家数与连板分布；只展示市场级计数，不含个股名单；ST 标的先排除并显式标注。 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.provisional` | 涨跌停口径为临时近似规则（provisional），后续随数据校准调整；连板分布从首板（1 板）起逐档统计至最高连板，全部分段展示、不截断。 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-provisional-banner | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.stExclusion` | ST / *ST 标的已排除，不进入统计。 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-st-exclusion | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.stExcludedLabel` | 已排除数量 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-st-exclusion | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.countUnit` | 家 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.overviewTitle` | 市场级汇总 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.counts.up` | 涨停家数 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-up-count | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.counts.down` | 跌停家数 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-down-count | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.counts.maxStreak` | 最高连板 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-max-streak | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.counts.distribution` | 连板分布 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-streak-distribution | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.aggregateNote` | 本页只展示市场级汇总计数，不展示个股名称、代码或排序名单；口径与排除规则见上方说明。 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-streak-distribution | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.emptyList` | 当前无可统计的涨跌停样本。 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-streak-distribution | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.demoNote` | 本地演示数据（mock），仅用于界面开发，不代表真实计算结果。 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.loading` | 正在加载涨跌停概览… | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-ladder-loading | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.unavailable` | 涨跌停概览尚未接入汇总接口，本页不展示占位数值。 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.error` | 涨跌停概览暂时无法加载。 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page / limit-ladder-error | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.caliberVersionLabel` | 口径版本 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |
| `copy.review.limits.streakUnit` | 板 | 页面/区块文案 | 涨跌停概览页 / LimitLadderPage / limit-ladder-page | 进入 /review/limits 且处于对应状态时显示 | 常驻（无关闭入口） | 否 | 否（本批无模型文本；AI 内容上线前逐条预审） | C 端 | 新增 | 市场级汇总口径说明，不含个股名单、排序或评价性表述 |

## 二、禁词扫描（对清单全文）

扫描词表：`建议/推荐/值得/可关注/机会/买入/卖出/持有/目标价/高估/低估/强势/必涨/避险/为什么/原因`。

扫描对象：主表 69 条新增文案 + 附录 7 条存量修订/保留说明 + 本清单全部文本（脚本逐条 includes）。

结果：**1 命中，已逐条解释**。
- 命中词：`建议`；位置：`copy.app.footerNote` 原文「…不构成投资建议、要约或收益承诺。」及本清单引用该句的行。
- 解释：该词处于否定合规句式「不构成投资建议」中，属于免责声明必要组成部分，不是任何形式的投资建议、推荐或判断；删除会削弱免责。除此之外 0 命中。

## 三、AI 标识与免责（不在前端 copy，需后端 copy 同版本签字）

- 按 ADR-007 D3/P7 与 H3 m02666 定稿，「AI 生成 · 仅供参考」及 AI 免责正文（「本内容由 AI 生成，基于页面标注时点的市场数据整理，仅供参考，不构成投资建议，也不构成任何买卖依据。」）由 services/api 从后端 copy.ts 注入；前端 `AiGeneratedBadge` 只接收必填 `label`/`disclaimer`，渲染 `ai-generated-badge`/`ai-disclaimer`，无关闭/隐藏入口。
- 因此这两段串不进入前端快照；本次 release 的 backend 2026.11.5 快照须同时登记（A0 负责，H3 签字）。
- 本批 AI 文本位全部为 null，只显示「待接入」占位，不涉及模型生成内容；实际生成文案上线前需逐条预审。

## 四、形态边界声明

- **B1-02**：C 端仅市场级汇总计数（涨停/跌停/最高连板/连板分布 + ST 排除数量），**不含个股名称/代码/排序名单**；个股明细分层仅保留类型供将来内部评测，C 端渲染路径不读取。
- **B1-01**：只展示客观数值（区间涨跌、年化波动、最大回撤、等权表现），不含推荐/归因/预测；相对基准与板块对比为缺口卡占位。
- **B1-03**：本批只签「标题 + 待接入占位 + 缺口」，不构成对将来生成内容的放行。

## 附录：存量文案修订（本批一并清，H3 m02565 §B/§C）

| copy key | 原文全文 | 类型 | 出现位置（页面+组件+DOM testid） | 触发条件 | 常驻/可关闭 | 是否插值数据字段 | 是否 AI 生成内容 | 目标受众 | 变更 | 合规理由 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ERROR_COPY.unknown.message` | 数据暂时不可用。 | 错误态文案 | 所有整页/区块错误态 / ErrorBlock / error-banner | 非网络、非映射状态码的协议异常（如响应体缺 data/meta、未知状态） | 状态性（仅错误时） | 否 | 否 | C 端 | 存量修订（原含「请稍后重试」） | 确定性契约缺口重试无意义；实际不用于缺口卡或 403 授权路径（403 走 UNAVAILABLE_BODY） |
| `ERROR_COPY.status5xx.message` | 行情数据暂时无法获取。 | 错误态文案 | 行情相关整页错误态 / ErrorBlock / error-banner | 仅真实 5xx 响应 | 状态性（仅错误时） | 否 | 否 | C 端 | 存量修订（去「服务」暗示与重试引导） | 避免把服务方关系透给用户；403 授权路径不复用该文案 |
| `copy.disclaimer.unavailable` | 本次响应未携带免责声明元数据，当前版本暂不展示行情数据。 | 免责兜底文案 | 个股页免责区 / DisclaimerUnavailable / disclaimer、disclaimer-text | 行情 2xx 但缺 disclaimer 元数据（本应 500） | 常驻（不可关闭） | 否 | 否 | C 端 | 存量修订（删除「稍后重试或联系服务方」） | 确定性契约缺口，重试无意义；不暴露服务方关系 |
| `copy.app.footerNote` | 本平台为客观数据工具，展示市场公开披露数据与平台自有数据，不构成投资建议、要约或收益承诺。 | 全站合规声明 | 所有页面页脚 / App / footer | 全站常驻 | 常驻（不可关闭） | 否 | 否 | C 端 | 存量修订（「公开数据源」→「市场公开披露数据」） | 授权未落地时不用「公开」为数据权利背书 |
| `ERROR_COPY.status429.message`（保留） | 当前请求暂时无法完成，请稍后重试。 | 错误态文案 | 429 错误态 / ErrorBlock | HTTP 429（配合 Retry-After） | 状态性 | 否 | 否 | C 端 | 保留 | 真可重试场景 |
| `copy.watchlist.error`（保留） | 自选列表暂时无法加载，请稍后重试。 | 错误态文案 | 自选页/自选状态 / WatchlistPage / watchlist-state | 平台自有数据瞬态失败 | 状态性 | 否 | 否 | C 端 | 保留 | 瞬态可重试 |
| `copy.watchlist.noticeFailed`（保留，说明触发场景） | 操作未成功，请稍后重试。 | 操作反馈 | 自选切换失败提示 / WatchlistToggle / notice | 非 401 的未知异常兜底（网络/5xx/协议异常）；输入类确定失败在入口校验，不会走到此文案 | 状态性（仅失败时） | 否 | 否 | C 端 | 保留 | 未知异常兜底可保留；未用于授权/缺口路径 |

## 观测项（H3 m02683，非文案、不阻塞签字）

`[88] copy.watchlist.noticeFailed` 保留现措辞，但该兜底路径在服务端/前端事件中必须能区分：

- **真瞬态**：网络异常、真实 5xx —— 属于可用「稍后重试」消化的场景；
- **确定性缺陷**：响应缺 `data`/`meta`、协议形状异常等 —— 重试不会自愈，必须单独告警，不得靠用户重试消化。

前端数据层已保留区分信号：`GatewayError { status: number | null; network: boolean }`，`status === null && network === true` 为网络类，非空 `status` 为服务端状态类，模型层可据此分流事件。该项记入 11-12 前观测项，由 A0/H5 接；本文案不变。
