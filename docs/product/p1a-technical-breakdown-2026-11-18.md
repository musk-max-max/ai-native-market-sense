# P1a 技术拆解（L0 落地计划）

- **日期**：2026-11-18
- **作者**：L0 (lead)
- **上游**：
  - docs/product/p1a-requirements-2026-11-18.md (300 行，PM)
  - docs/product/finance-expert-theme-input-2026-11-18.md (155 行，finance-expert，已逐条收敛 PM §7 6 问)
- **状态**：**待 owner 审 → 未启动编码**（m08028 owner 指令 C：完全暂停 P1a 前端编码，等文档到位）
- **本文档用途**：把 PM + finance-expert 已收敛需求翻译成 commit 粒度的技术拆解，给 owner 审完需求文档后直接按此推进

---

## 0. 需求收敛摘要（PM + finance-expert 已对齐）

### 0.1 三主题定稿（finance-expert 已拍板）

| 主题 Key | 主题名 | 数据集 | 用户问题 | 冷热 |
|---|---|---|---|---|
| `T1 fin-health` | 财务健康 | fina_indicator + income | 赚钱能力 / 现金 / 暴雷 | 以冷为主（季频），热区仅最新一期 |
| `T2 valuation-price` | 估值与价格 | daily_basic + daily | 贵不贵 / 走势 | 以热为主（日频），冷区做 1 年分位 |
| `T3 money-sentiment` | 资金与情绪 | moneyflow + top_list + margin + stk_limit（市场级） | 大钱方向 / 情绪 | 以热为主（近 30 日） |

P1a 锁定 3 主题；股东筹码（hk_hold）/ 技术面 → P1b。

### 0.2 字段层级（finance-expert 已拍板）

- **P（一眼区）**：≤3 个大数字 + 一句人话结论（只描述不处方向，HARD-002）
- **S（核心明细）**：5–8 个卡片，2 列网格
- **T（下钻）**：懒加载，冷路径容忍分钟级延迟
- **下钻深度**：T1 近 8 季 / T2 近 1 年 / T3 近 30 日（不加长）

### 0.3 T1 P 层一眼三数字（finance-expert 定稿）

- **P1** ROE（fina_indicator.weight_roe / roe）
- **P2** 营收同比（income.total_revenue 同比 / fina_indicator.or_yoy）
- **P3** 资产负债率（fina_indicator.debt_to_assets）

> income 列名**不锁代码列名**，前端落地时以 `warehouse/dwd/schema.sql` 实际列名为准。

### 0.4 T2 独立（finance-expert 定稿）

T2 独立成主题，不并入 T1。理由：季频冷（T1）与日频热（T2）节奏差异大，合并会冷热混杂；散户心智「值不值」= 质量 × 价格两步。T1↔T2 通过 EPS / PE 软关联。

### 0.5 T3 情绪框架（finance-expert 定稿）

- **P3 情绪温度三件套**（均市场级）：涨停家数 / 跌停家数 / 涨跌家数比 / 最高连板数
- **北向 hk_hold** → P1b（旬频 + 境外口径波动 + 数据不稳）
- **同业对比**：P1a 仅作 T3 行业资金流向对比；财务/估值同业 → P1b

### 0.6 HARD-002 措辞清单（finance-expert §4.1）

- **可接受**：「近 8 季 ROE 中位数 12%，最新 15%，处于近两年偏高水平」
- **不可接受**：「值得买入 / 建议增持 / 目标价 / 评级 / 预计 / 看涨 / 看跌 / 即将突破 / 低吸 / 抄底 / 止盈 / 止损」
- **判定**：结论句只能是「历史/当期数据是什么」（描述），不能是「所以该怎么办」（处方向）

### 0.7 路由（PM §3）

| 路由 | 处理 |
|---|---|
| `/metrics`（首页） | **保留并改造**：overview 下方新增「按主题看」宫格（3 张卡） |
| `/stocks/:id/metrics` | **保留作全部指标兜底**，新增 `/stocks/:id/themes/:themeKey` 作默认首屏 Tab |
| `/stocks/:id/themes/:themeKey` | **核心新路由**，themeKey ∈ {fin-health, valuation-price, money-sentiment} |

### 0.8 频控降级 UX（PM §4）

- **5min LRU 缓存**（同 userId+themeKey+instrumentId+coldFieldSet+period 命中返回，UI 显示「缓存 · X 分钟前」）
- **429 限频**：黄色降级卡 + Retry-After 倒计时禁自动重试 + stale-while-error 回退旧缓存标时间
- **超时**：灰色骨架 + 错误卡 + 30s 客户端节流
- **5xx**：红色错误卡 + 30s 节流
- **热字段永不被冷失败拖垮**（错误边界隔离）

---

## 1. 红线（实现阶段不可协商）

| # | 红线 | 出处 |
|---|---|---|
| ① | AKshare 数据永不进 C 端；冷代理只走 tushare | m07735 |
| ② | 冷数据永不持久化（不写 PG / ingest / warehouse） | m07727 |
| ③ | C 端 limit ladder 只允许市场级/板块级汇总计数，禁止个股梯队明细行 | H3 m02407 |
| ④ | 主题页仅登录用户；未登录拦截 | m07736 |
| ⑤ | HARD-002：不输出评级/目标价/买卖信号/未来预测 | docs/HANDOFF §1 硬约束 2 |
| ⑥ | 冷查询仅对 A 类时序数据集开放（~35 个） | m07735 |
| ⑦ | 数据层不区分 C 端 vs 内部（同一套 serving 视图） | m07736 |
| ⑧ | AI 解读 / 选股是功能级门，叠在数据之上，与热冷/频控解耦 | m07736 + PM §5.2 |

---

## 2. 后端技术拆解（services/market）

### 2.1 M1 — serving 视图扩展（warehouse/serving/c-end-metrics.sql）

**目的**：现有 serving 视图只覆盖 stock_metrics / market_overview / limit_ladder 三视图；P1a 需要 T1（财务）+ T2（估值派生）+ T3（资金/龙虎/两融）字段。

**新视图（建议命名）**：

- `serving.v_cend_theme_fin_health`：fina_indicator + income join on (instrument_id, report_period)，按 report_period 倒序，暴露 P/S 字段（roe / or_yoy_pct / debt_to_assets / grossprofit_margin / netprofit_margin / netprofit_yoy_pct / total_revenue / n_income / current_ratio）。**只暴露近 8 季**（季频 × 8 = 2 年，超 30 天旧季度走冷代理，但**视图本身仍存 8 季**——热/冷在 API 层裁剪，不在视图层裁剪）
- `serving.v_cend_theme_valuation_price`：daily_basic + dwd_stock_bar_daily join on (instrument_id, trade_date)，暴露 P/S 字段（close / pct_change_pct / pe_ttm / pb / total_market_value / dividend_yield_ttm_pct）+ 派生（close_5d/20d/60d_pct / ma20）。**只暴露近 30 日热数据**（1 年冷序列走代理）
- `serving.v_cend_theme_money_sentiment`：moneyflow + top_list + margin join on (instrument_id, trade_date) + stk_limit 市场级汇总（聚合子查询），暴露 P/S 字段（net_inflow_amount / financing_balance / securities_balance / lhb_net_amount / buy_sell 分档 / **市场级 count 派生**）。**只暴露近 30 日**

**约束**：
- 视图**不暴露 AKshare 字段**（红线①）
- 视图**不暴露个股级 stk_limit 明细**（红线③），stk_limit 只在视图内做 `count(*) GROUP BY trade_date, limit_status` 市场级聚合
- 视图**只暴露近 30 日 + 近 8 季**，更早历史走冷代理

**commit 粒度**：M1a（serving/c-end-metrics.sql 加 3 视图） + M1b（warehouse/tests/test_serving_*.py 加视图存在性 + 字段 smoke） + M1c（手动 psql apply 到 ECS + 验证行数）

### 2.2 M2 — /v1/c-end/* API 扩展（services/market/src/routes-c-end-metrics.ts + adapters/pg-c-end-metrics-repo.ts）

**新路由**（在现有 /v1/c-end/overview / stocks/:id/metrics / limits 基础上扩展）：

- `GET /v1/c-end/stocks/:id/themes/fin-health`：返回 T1 P/S 字段（热，近 30 日 + 最新季）+ 冷序列入口（`?cold=8q` 触发冷代理）
- `GET /v1/c-end/stocks/:id/themes/valuation-price`：返回 T2 P/S 字段（热，近 30 日）
- `GET /v1/c-end/stocks/:id/themes/money-sentiment`：返回 T3 P/S 字段（热，近 30 日）+ 市场级 stk_limit count
- `GET /v1/c-end/stocks/:id/themes/:themeKey/cold`：**冷代理入口**（`?field=roe&period=8q` / `?field=pe_ttm&range=1y` / `?field=net_inflow&range=30d`），后端实时代理 tushare → 处理 → 返回，**不落库**

**冷代理实现**（`services/market/src/adapters/tushare-cold-proxy.ts`，新文件）：
- 读 tushare endpoint + token from env（同 ingest adapter）
- 仅允许 A 类时序数据集（白名单 hard-code 在 `services/market/src/ports/c-end-cold-datasets.ts`）
- **5min LRU 缓存**（内存 Map，key = userId+themeKey+instrumentId+field+period，TTL=300s）
- **429 Retry-After 透传**（tushare 返回 429 时透传 Retry-After header 给前端）
- **永不写 PG / ingest / warehouse**（红线②）

**鉴权**：
- 所有 /v1/c-end/* 路由要求登录（401 fail-closed），复用现有 identity authenticator
- 数据层不区分 C 端 vs 内部（红线⑦）

**commit 粒度**：M2a（路由骨架 + 3 主题热路径） + M2b（冷代理 adapter + 5min LRU） + M2c（429 Retry-After 透传 + 30s 客户端节流 header） + M2d（鉴权 + 401 fail-closed）

### 2.3 M3 — 测试（services/market/test/）

- 单测：路由 smoke（3 主题 × 热路径 200 + 冷路径 200/429/5xx）
- 单测：冷代理 LRU 命中（同 key 5min 内返回缓存，不打代理）
- 单测：429 透传 Retry-After
- 单测：未登录 401 fail-closed
- 单测：AKshare 字段不出现（红线①守门）
- 单测：个股级 stk_limit 字段不出现（红线③守门）

**commit 粒度**：M3（test 文件 + 全绿）

---

## 3. 前端技术拆解（web/h5）

### 3.1 F1 — copy.ts 文案键（PM §4.4）

**新增键**（`web/h5/src/copy.ts`，命名空间 `cold` + `theme`）：

- 冷路径降级：coldThrottleTitle / coldThrottleBody / coldThrottleRetryIn / coldThrottleRetryMax / coldThrottleRetryAction
- 超时：coldTimeoutTitle / coldTimeoutBody / coldTimeoutRetryAction
- 错误：coldErrorTitle / coldErrorBody / coldErrorRetryAction
- stale 缓存：coldStaleBadge（插值 {minutes}）
- 加载态：coldLoading
- 热冷角标：dataBadgeHot / dataBadgeCold
- 兜底：coldUnavailable
- 主题名：themeFinHealth / themeValuationPrice / themeMoneySentiment
- 主题 Tab：themeTabFinHealth / themeTabValuationPrice / themeTabMoneySentiment / themeTabAllMetrics

**约束**：
- compliance.test 单一来源门禁：所有中文字面量必须迁 copy.ts（src 无中文字面量）
- copy.ts 改动必须重算 hash + 生成快照 + 补 manifest + 删旧快照（compliance.test 严格断言）

**commit 粒度**：F1（copy.ts + 快照 + manifest）

### 3.2 F2 — 主题页路由 + 骨架（web/h5/src/App.tsx + pages/）

**新路由**：`/stocks/:id/themes/:themeKey`（themeKey ∈ {fin-health, valuation-price, money-sentiment}）

**新页面**（`web/h5/src/pages/`）：
- `ThemePage.tsx`：主题页骨架（股票头 + 主题 Tab 条 + P/S/T 三层 + 冷数据提示条 + as_of 角标 + 底部声明）
- `themes/FinHealthTheme.tsx`：T1 P/S/T 字段渲染
- `themes/ValuationPriceTheme.tsx`：T2 P/S/T 字段渲染
- `themes/MoneySentimentTheme.tsx`：T3 P/S/T 字段渲染（**stk_limit 仅市场级 count，禁止个股行**）

**改造**：
- `MetricsOverviewPage.tsx`：overview 下方新增「按主题看」宫格（3 张卡）
- `StockMetricsPage.tsx`：顶部新增主题 Tab 条（财务健康 / 估值 / 资金 / 全部指标），默认落在第一个主题 Tab

**路由守卫**：未登录 → 跳登录（复用现有 authenticator）

**commit 粒度**：F2a（ThemePage 骨架 + 路由） + F2b（T1 FinHealthTheme） + F2c（T2 ValuationPriceTheme） + F2d（T3 MoneySentimentTheme + 市场级 count） + F2e（MetricsOverviewPage 宫格 + StockMetricsPage Tab 改造）

### 3.3 F3 — 冷数据降级 UX（web/h5/src/components/）

**新组件**（`web/h5/src/components/cold/`）：
- `ColdDataWrapper.tsx`：冷字段包裹器（loading / 429 / timeout / error 四态）
- `ColdThrottleCard.tsx`：429 降级卡（黄色 + Retry-After 倒计时 + 禁自动重试）
- `ColdTimeoutCard.tsx`：超时卡（灰色骨架 + 30s 节流）
- `ColdErrorCard.tsx`：错误卡（红色 + 30s 节流）
- `ColdStaleBadge.tsx`：stale-while-error 旧缓存标注（{minutes} 插值）

**客户端节流**：`web/h5/src/data/coldThrottle.ts`（30s 客户端节流逻辑，避免连点）

**错误边界**：`ColdDataWrapper.tsx` 用 React ErrorBoundary 隔离，冷失败不拖垮热字段

**commit 粒度**：F3a（ColdDataWrapper + 四态组件） + F3b（30s 客户端节流逻辑） + F3c（stale-while-error 回退）

### 3.4 F4 — 数据网关（web/h5/src/data/）

**新网关**（`web/h5/src/data/themeGateway.ts`）：
- `ThemeGateway` 接口（3 主题 × 热路径 + 冷路径）
- `HttpThemeGateway`：调 `/v1/c-end/stocks/:id/themes/:themeKey` + `/v1/c-end/stocks/:id/themes/:themeKey/cold`
- `MockThemeGateway`：DEV mock 模式（`VITE_DATA_MODE=mock`）

**测试**（`web/h5/test/theme-gateway.test.ts`）：6–8 例（3 主题热路径 + 冷路径 200/429/5xx）

**commit 粒度**：F4（themeGateway + test）

### 3.5 F5 — 快照 + manifest + 合规

- copy.ts hash 重算 + 快照生成 + manifest B1-P0-N 行补
- h5 生产构建 budget（85.1KB → 预计 +15KB，仍 <200KB）
- F1 detection 扫描（L179 修复后的 regex，不含半角括号）
- compliance.test 全绿（除 copy.ts 外 src 无中文字面量）

**commit 粒度**：F5（快照 + manifest + budget 更新）

---

## 4. 推进顺序（commit 链）

按依赖顺序，建议 **M1 → M2 → M3 → F1 → F4 → F2 → F3 → F5**：

| 阶段 | commits | 说明 |
|---|---|---|
| **后端先行** | M1a/M1b/M1c | serving 视图 + 测试 + ECS apply |
| | M2a/M2b/M2c/M2d | API 路由 + 冷代理 + 鉴权 |
| | M3 | 后端测试全绿 |
| **前端跟进** | F1 | copy.ts 文案键（含快照 + manifest） |
| | F4 | themeGateway + test |
| | F2a–F2e | 主题页路由 + 3 主题 + 首页/个股改造 |
| | F3a/F3b/F3c | 冷数据降级 UX |
| | F5 | 快照 + manifest + budget |

**预估 commit 数**：~16 个。**预估工期**：后端 1–2 天 + 前端 2–3 天 = **3–5 天**（不含 owner 审文档 + 业务员复核）。

---

## 5. 待 owner 裁定的开放项

1. **T3 P3 情绪温度**：finance-expert 建议补「涨跌家数比 + 最高连板数」（均市场级 count）→ 是否纳入 P1a？还是只做涨停家数 + 跌停家数？
2. **T2 历史分位**：finance-expert 建议作 S1（近 1 年 / 近 3 年 PE 历史分位）→ 需要冷代理支持 `?range=1y` 和 `?range=3y`，是否纳入 P1a？还是只做近 1 年？
3. **income 列名对齐**：finance-expert 说「不锁代码列名，以 schema.sql 实际列名为准」→ L0 在 M1a 时按 schema.sql 实际列名落地，是否需要 owner 确认列名映射表？
4. **冷代理 tushare endpoint**：当前 ECS .env 用 `TUSHARE_API_URL=https://tuaremax.top`（m07077 owner 提供的第三方代理）→ services/market 冷代理是否也用同一个 endpoint？还是用官方 api.tushare.pro？
5. **鉴权 token 形态**：现有 /v1/c-end/* 在 ECS 上是 401 UNAUTHENTICATED（ECS 无 dev-token authenticator）→ P1a 上线前是否需要补 token issuer / 登录态接入？
6. **P1b 范围预告**：finance-expert 说股东筹码（hk_hold）/ 同业对比 / 北向 → P1b，是否需要在 P1a 落地后立即启动 P1b，还是先观察 P1a 用户反馈？

---

## 6. L0 下一步行动

**m08028 owner 指令 C**：完全暂停 P1a 前端编码，等需求文档到位。

**L0 现在做的事**：
1. ✅ 读 PM 300 行 + finance-expert 155 行，验证覆盖 owner 边界
2. ✅ 出本文档（技术拆解 + commit 粒度 + 开放项）
3. ⏸ **不启动编码**，等 owner 审两份文档 + 回 6 项开放项
4. ✅ 将本文档 + 两份需求文档一并 commit + push（docs 变更，非编码）

**owner 审完文档 + 回 6 项开放项后**：L0 按 §4 推进顺序启动 M1a，逐 commit 推进，每 commit 过门禁（typecheck + workspace test + warehouse test）。
