# C 端 H5 方案 v2（c-end-h5-v2）

> 基准 **390 × 844**，组件库 antd-mobile 5，版式参照东方财富移动端。
> 现状基线：`web/h5/src`（`App.tsx` 顶部 NavBar + 4 链接；`pages/` 6 页；`styles/tokens.css` 临时 token）。

---

## 1. 信息架构

### 1.1 底部 TabBar（5 项，固定）

```
┌─────────────────────────────────────────────┐
│  行情       自选       组合       AI      我的  │
│  ●         ☆         ▦        ✦        ◉      │
└─────────────────────────────────────────────┘
  /          /watchlist /review/  /ai      /me
                        portfolio
```

| Tab | 路由 | 承载 | 合规要点 |
| --- | --- | --- | --- |
| 行情 | `/` | 指数概览 / 热门个股 / 涨跌分布 / 资讯流 | 仅**市场级聚合**数据，带来源 + as_of；不出现个股推荐位 |
| 自选 | `/watchlist` | 自选列表（现有） | 行情数值仅 authorized 时展示；未登录显式说明 |
| 组合 | `/review/portfolio` | 自选组合复盘（现有 `PortfolioReviewPage`） | 一律称「自选组合」，禁「我的持仓」；相对基准走缺口卡 |
| AI | `/ai` | AI 解读聚合入口（新） | 每条带 `AiGeneratedBadge`；无数据走缺口卡 |
| 我的 | `/me` | 账户、权限（entitlement）、退订、免责全文 | **退订入口在此置顶**，不得藏三级 |

> **改动说明**：现有 `App.tsx` 是顶部 3 链接（首页/自选/复盘）+ 底部无 TabBar，`LimitLadderPage`（涨跌停梯队）靠首页裸链接进入。v2 把它收进「行情」Tab 的二级段控（`聚合汇总 / 涨跌停梯队`），不再作为首页游离入口——减少一屏内的并列入口数（克制原则）。

### 1.2 「行情」首页版式（多板块）

参照东方财富移动端首页的自上而下信息密度：

```
┌─ 390 ─────────────────────────────────────┐
│ NavBar: MS 行情          [🔍 搜索代码/名称] │  ← 搜索固定顶部，吸顶
├───────────────────────────────────────────┤
│ ① 指数概览（横滑 3 卡）                     │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐        │
│ │上证指数  │ │深证成指  │ │创业板指  │ →     │
│ │3125.60  │ │9876.42  │ │2043.18  │       │
│ │+0.82% 红│ │−0.31% 绿│ │+1.24% 红│       │
│ │收盘·15:00│ │收盘·15:00│ │收盘·15:00│      │
│ └─────────┘ └─────────┘ └─────────┘        │
├───────────────────────────────────────────┤
│ ② 涨跌分布（市场级，非个股）                │
│ 涨停 42 家 · 跌停 8 家 · 最高连板 5 天       │
│ 连板分布 ▁▃▅▂▁  (口径 v2026.11 · provisional)│
│ [查看涨跌停梯队 →]                          │
├───────────────────────────────────────────┤
│ ③ 热门个股（客观榜单，非推荐）               │
│  标题右侧固定标注：「按成交额排序 · 非推荐」   │
│  1  贵州茅台  SSE:600519   1685.00 +0.62%  │
│  2  宁德时代  SZSE:300750  198.42  −1.13%  │
│  …                                        │
├───────────────────────────────────────────┤
│ ④ 资讯流（无限滚动）                        │
│ ┌─────────────────────────────────────┐   │
│ │ [标题] 某公司发布三季度财报            │   │
│ │ 平台资讯 · 2026-11-06 14:02  [AI摘要] │   │  ← AI 摘要带标识
│ └─────────────────────────────────────┘   │
│        …下拉到底 InfiniteScroll…           │
├───────────────────────────────────────────┤
│ ⑤ 页脚：免责摘要（不可折叠）· as_of · 退订   │
└───────────────────────────────────────────┤
│  行情    自选    组合    AI     我的         │
└───────────────────────────────────────────┘
```

**板块 ③「热门个股」合规改造（本方案最关键的一处）**：
东方财富的「热门/涨幅榜」是**编选 + 排序榜**，直接照搬会触碰「排序榜 / 诱导」红线。v2 的处理：

- 标题**不写**「热门」「机会」「涨幅榜」，改写为**「成交额前列」（按客观指标排序）**；
- 副标题固定渲染「按成交额排序 · 系统生成 · 非推荐」；
- 与 `LimitLadderPage` 的口径一致：**ST / \*ST 排除必须显式标注**（`stExcludedCount`），不静默过滤；
- 每行带来源 + as_of（复用 `sourceLabel` + `source.asOf`）；
- 行尾 `data-source` 保留原始枚举值，便于 E2E 与审计（现有 `QuoteBlock` 约定）。

**板块 ①②④** 均为**市场级聚合**，与现有 `LimitLadderPage`「C 端只允许市场级汇总计数」的裁定同源，不引入个股编选。

### 1.3 个股页版式

保留现有 P0 契约（首屏 6 元素无需滚动：名称 / 最新价 / 涨跌幅 / as_of / 来源 / 免责），在其下扩展：

```
┌─ 390 ─────────────────────────────────────┐
│ ← 贵州茅台                          [☆ 自选]│  NavBar + 自选按钮右置
├───────────────────────────────────────────┤
│ A. 行情卡（antd-mobile Card）               │
│   贵州茅台   SSE:600519  [沪市主板][股票]    │
│   1685.00        +10.42   +0.62%           │  ← 大号 --up-strong / --up
│   平台行情(收盘) · as_of 2026-11-06 15:00   │  ← 来源+as_of 必带
│   今开 1678.00  最高 1690.00  最低 1672.50  │
│   成交额 42.6亿  换手 0.31%                 │
│   [分时 | 五日 | 日K | 周K | 月K]  段控      │
│   ⚠ 若 staleness>15min → 显示「延时数据」标记 │
├───────────────────────────────────────────┤
│ B. 基本面摘要（现有 FundamentalSummary）      │
│   报告期 2026Q3 · 口径 reported             │
│   营收 1263亿  净利 528亿  营收同比 +8.2%    │
│   ROE 28.4%  毛利 91.2%  EPS 42.06 元       │
│   财报 as_of · 来源 平台财报数据 · 公告日 …   │  ← 与行情 as_of 分开
├───────────────────────────────────────────┤
│ C. AI 分析摘要（现有 AiInterpretation 五段）  │
│  [AI 生成 · 仅供参考]  ← AiGeneratedBadge   │  ← 无关闭
│  估值      ◇ 待接入（pending_batch）         │
│  成长      ● 营收同比 +8.2% / 净利同比 +9.1%  │  ← 确定性字段
│  盈利质量   ● 毛利 91.2% / ROE 28.4%         │
│  资金      ◇ 待接入                          │
│  风险      ◇ 待接入                          │
│  本节数字来自财报字段，未使用模型生成内容       │
├───────────────────────────────────────────┤
│ D. 免责声明（不可折叠·不可关闭）             │
│   本页内容不构成投资建议… 版本 v2026.11       │
└───────────────────────────────────────────┘
```

**新增「分时」交互的合规边界**：分时图只画已成交价格折线 + 昨收水平虚线；**不画支撑/压力线、不画买卖点箭头、不加「金叉」标注**（技术分析暗示属诱导）。纵轴数值与 `quote` 同源，图上固定水印 `as_of` 时间戳，防止截图脱离口径传播。

### 1.4 受限 / 缺失态（沿用现有 P0 契约，v2 视觉升级）

| 情形 | 展示 |
| --- | --- |
| `entitlement.is_entitled === false`（403） | 行情区渲染 `EntitlementNotice`（API Problem 文案原样），**零数值**，无骨架、无 `0.00` |
| 免责缺失 | `DisclaimerUnavailable`：显式说明缺失，不伪造合规文案 |
| 基本面未接入 | `DataGapCard reason="no_coverage"` |
| 财报/行情时点不一致 | 两个 as_of 分开渲染（现有约定），并在 `card__hint` 说明「财报时点与行情时点不同」 |

---

## 2. 关键组件代码片段（antd-mobile）

> 片段是**规范示例**，非最终实现。文案一律走 `lib/copy.ts`；`data-testid` 走 `lib/testids.ts`（现有 E2E 契约不破坏）。

### 2.1 TabBar + 吸顶搜索

```tsx
// App.tsx（v2 形态）
import { TabBar, NavBar, SearchBar, SafeArea } from 'antd-mobile';
import { useRoute, navigate } from './lib/router';

const TABS = [
  { key: 'market', title: '行情', path: '/' },
  { key: 'watchlist', title: '自选', path: '/watchlist' },
  { key: 'portfolio', title: '组合', path: '/review/portfolio' },
  { key: 'ai', title: 'AI', path: '/ai' },
  { key: 'me', title: '我的', path: '/me' },
] as const;

export function App() {
  const route = useRoute();
  const activeKey = tabKeyForRoute(route);   // review/limits 归到 market
  return (
    <div className="app">
      <header className="app-header">         {/* 吸顶：position:sticky; top:0 */}
        {/* antd-mobile 5.43：back 默认渲染返回图标，back={null} 隐藏；backArrow 已废弃 */}
        <NavBar back={isStockPage(route) ? undefined : null} onBack={() => history.back()}>
          {titleForRoute(route)}
        </NavBar>
        {route.name === 'home' && (
          <SearchBar
            placeholder={copy.home.searchPlaceholder}   // 「代码 / 名称 / 拼音」
            onFocus={() => navigate('/search')}
            aria-label={copy.home.searchLabel}
          />
        )}
      </header>

      <main id="main-content" className="app-main" tabIndex={-1}>{renderRoute(route)}</main>

      <footer className="app-footer">
        <DisclaimerSummary />   {/* 免责摘要，不可折叠；展开后为全文 */}
        <UnsubscribeEntry />    {/* 退订入口：合规红线，置顶显眼 */}
      </footer>

      <TabBar
        activeKey={activeKey}
        onChange={(key) => navigate(TABS.find((t) => t.key === key)!.path)}
        safeArea
        className="app-tabbar"
      >
        {TABS.map((t) => (
          <TabBar.Item key={t.key} title={t.title} icon={TAB_ICONS[t.key]} />
        ))}
      </TabBar>
    </div>
  );
}
```

> **TabBar 定位**：antd-mobile 的 `TabBar` **不提供定位与外层布局**（官方 FAQ）。必须补：
> ```css
> .app-tabbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 100; }
> .app-main   { padding-bottom: calc(50px + env(safe-area-inset-bottom)); }
> ```
> 否则 TabBar 会被文档流挤到内容末尾；`safeArea` 只负责底部安全区高度，不负责吸底。

### 2.2 指数概览（横滑卡片）

```tsx
import { Card } from 'antd-mobile';
import { sourceLabel, copy } from '../lib/copy';

function IndexOverview({ indices }: { indices: IndexQuote[] }) {
  return (
    <section className="card" aria-labelledby="idx-heading">
      <h2 id="idx-heading" className="card__title">{copy.home.indicesTitle}</h2>
      {/* 横滑容器为自研：antd-mobile 5.43 没有 ScrollRow 组件 */}
      <div className="scroll-row" role="region" aria-label={copy.home.indicesTitle} tabIndex={0}>
        {indices.map((idx) => {
          const up = idx.changePct > 0;
          const flat = idx.changePct === 0;
          return (
            <Card key={idx.instrumentId} className="index-card">
              <p className="index-card__name">{idx.name}</p>
              <p
                className={`index-card__price ${toneClass(idx.changePct)}`}   // up/down/flat
                data-source={idx.source.source}
              >
                {formatPrice(idx.lastPrice)}
              </p>
              <p className={`chg-pill ${toneClass(idx.changePct)}`}>
                {formatChangePct(idx.changePct)}
              </p>
              <p className="index-card__meta">
                {sourceLabel(idx.source.source)} · <time dateTime={idx.source.asOf}>{idx.source.asOf}</time>
              </p>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
```

> `.scroll-row`：`display:flex; gap:10px; overflow-x:auto; scroll-snap-type:x mandatory; padding-inline:16px;`，`::-webkit-scrollbar{display:none}`。`Card` 无 `block` 属性（antd-mobile 5.43 `CardProps` 不含），宽度由 CSS 控制；圆角走 `--adm-card-border-radius: 14px`。

要点：`toneClass()` 只返回 `up` / `down` / `flat` 三类；涨跌胶囊底用 `--up-weak`/`--down-weak`，文字用 **`--up-weak-text` / `--down-weak-text`**（满足 4.5:1，见 system-v2 §2.1）。

### 2.3 成交额榜单（客观榜）

```tsx
import { List } from 'antd-mobile';

function TurnoverLeaders({ rows, stExcludedCount }: { rows: LeaderRow[]; stExcludedCount: number }) {
  return (
    <section className="card" aria-labelledby="leaders-heading">
      <header className="card__header">
        <h2 id="leaders-heading" className="card__title">{copy.home.leadersTitle}</h2>{/* 「成交额前列」 */}
        <span className="card__hint">{copy.home.leadersHint}</span>{/* 「按成交额排序 · 系统生成 · 非推荐」 */}
      </header>

      <List className="leader-list">
        {rows.map((row, i) => (
          // 列表默认右侧箭头是方向符号，违反「禁方向箭头」，必须显式关闭
          <List.Item
            key={row.instrumentId}
            arrowIcon={false}
            onClick={() => navigate(`/stocks/${encodeURIComponent(row.instrumentId)}`)}
            extra={
              <span className={`leader-list__chg ${toneClass(row.changePct)}`} data-source={row.source.source}>
                {formatChangePct(row.changePct)}
              </span>
            }
          >
            <span className="leader-list__rank">{i + 1}</span>
            <span className="leader-list__name">{row.name}</span>
            <span className="leader-list__code mono">{row.instrumentId}</span>
          </List.Item>
        ))}
      </List>

      <p className="card__note">
        {copy.home.stExclusion} {/* 「已排除 ST / *ST」 */}
        <span className="st-exclusion__count">{stExcludedCount} {copy.review.limits.countUnit}</span>
        <span aria-hidden="true"> · </span>
        {copy.home.leadersAsOf} <time dateTime={rows[0]?.source.asOf}>{rows[0]?.source.asOf}</time>
      </p>
    </section>
  );
}
```

### 2.4 自选按钮（StockPage NavBar 右置）

```tsx
import { NavBar, Button, Toast } from 'antd-mobile';
import { useWatchlistToggle } from '../components/WatchlistToggle';

function StockNavBar({ instrumentId, name }: { instrumentId: string; name: string }) {
  const { status, toggle } = useWatchlistToggle(instrumentId);
  const added = status === 'added';
  return (
    <NavBar
      onBack={() => history.back()}
      right={
        <Button
          size="mini"
          fill={added ? 'solid' : 'outline'}
          color={added ? 'primary' : 'default'}
          onClick={async () => {
            await toggle();
            Toast.show({ content: added ? copy.watchlist.removed : copy.watchlist.added });
          }}
          aria-pressed={added}
          data-testid={TID.watchlistToggle}
        >
          {added ? '★ 已自选' : '☆ 加自选'}
        </Button>
      }
    >
      {name}
    </NavBar>
  );
}
```

---

## 3. 交互细节

### 3.1 下拉刷新（`PullToRefresh`）

- 触发：列表顶部下拉 ≥60px；文案「下拉刷新 / 正在刷新 / 刷新完成」。
- 刷新后**必须更新所有可见卡片的 as_of 与来源标识**——不允许价格变了、as_of 还是旧的。
- 刷新失败：`Toast.show({ content: errorCopy(status, network).message })`，保留旧数据但**在其 as_of 旁加「未更新」标记**，绝不静默展示旧值冒充新值。

### 3.2 上滑加载（`InfiniteScroll`）

- 用于资讯流、成交额榜单、自选列表。
- 底部态：`加载中` → `没有更多内容了`；`没有更多` 后**追加一行免责摘要**，保证长列表滚动到底时免责仍在视口附近。
- 加载更多失败：显示「加载失败，点击重试」行（不用 `Toast` 自动消失的形态，避免用户错过）。
- 每页 pageSize 20（与中后台审计表口径一致）。

### 3.3 涨跌动效

- 价格 tick 变化：数字滚动 240ms + 颜色从 `--up-strong`/`--down-strong` 淡出回 `--up`/`--down`，**一次性**。
- 收盘后（`source.source === 'platform_eod'`）**不播放任何涨跌动效**——收盘数据是静态事实，动效会制造「在动」的错觉。
- 分时图十字光标：跟随手指，显示 `时间 / 价 / 涨跌幅`；十字线用 `--border-strong`，数值用 `--text`。
- 禁止（重申 system-v2 §6）：涨停脉冲、闪烁循环、老虎机、方向性弹跳。

### 3.4 分时段控切换

`分时 | 五日 | 日K | 周K | 月K` —— 默认**分时**。切到日K及以上时，若 `source.source` 为延时/收盘，图上固定显示 `platform_delayed` / `platform_eod` 标签，不允许在 K 线模式下隐藏口径。

### 3.5 返回与深链

- 个股页返回用 `history.back()`，若无可回历史（直接深链进入）则回退到 `/`。
- 深链刷新可用（现有 `server.mjs` SPA fallback 保留）。
- 路由保持现有契约：`/stocks/:instrument_id` 主、`/stock/:id` 别名（`router.tsx` 的 `parseRoute` 不改）。

---

## 4. 合规落点清单（H5）

| 红线 | v2 落点 |
| --- | --- |
| 免责显眼不可删 | 每页 footer `DisclaimerSummary` + 个股页 D 区全文；无折叠、无关闭 |
| AI 标识 `ai.generated` | `AiGeneratedBadge` 原样沿用；资讯流 AI 摘要、AI Tab 每条均带 |
| as_of 口径 | 每个行情/基本面数值旁 `sourceLabel + asOf`；分时图水印 |
| 退订入口 | 「我的」Tab 置顶 + 全站 footer 常驻 |
| 无诱导性暗示 | 榜单标题改「成交额前列」+「非推荐」；无方向箭头；无动效劫持 |
| 来源标识 | `sourceLabel` 受控映射，`data-source` 保留枚举 |
| 涨跌色 4.5:1 | 正文用 `--up:#d92b20`/`--down:#00804a`；彩底用 `--*-weak-text` |
| 缺失值 | `—` + 说明；禁 `0` 冒充 |
| 移动端基准 | 390×844；TabBar 50 + safe-area；左右边距 16 |

---

## 5. 对比分析（现有方案 vs v2）

现有基线：`web/h5/src/App.tsx`（顶部 3 链接 NavBar + 底部无 TabBar）、`pages/`（Home/Stock/Watchlist/PortfolioReview/LimitLadder/NotFound）、`styles/tokens.css`。

| # | 现状 | v2 改进 | 价值 |
| --- | --- | --- | --- |
| 1 | **无底部 TabBar**，导航靠顶部 3 个裸链接（首页/自选/复盘），`LimitLadder` 靠首页游离链接进入 | 5 项 TabBar（行情/自选/组合/AI/我的）+ 吸顶搜索 | 移动端拇指可达；信息架构有归属；东财式一屏多板块成为可能 |
| 2 | **首页刻意零行情数值**（`HomePage` 注释：避免示例数字被误读为真实行情） | 首页改为指数概览/涨跌分布/成交额前列/资讯流，**每块带来源+as_of** | 从「说明页」变成可用的行情首页；误读风险由 as_of + 来源标识消除，而非靠留白回避 |
| 3 | 无个股列表入口，除手动输代码外无发现路径 | 新增「成交额前列」客观榜单（按成交额排序 · 系统生成 · 非推荐 · 显式 ST 排除计数） | 给出合规的个股发现路径——用**客观指标**替代东财的「热门/涨幅榜」编选，绕开排序榜红线 |
| 4 | 个股页无分时/走势，只有静态 QuoteBlock 数值 | 新增分时段控（分时/五日/日K/周K/月K），**禁**支撑压力线/买卖点箭头/金叉标注，图上水印 as_of | 补齐行情卡「分时」能力；技术分析暗示被显式排除，守住客观定位 |
| 5 | 导航层级浅，免责只在个股页 footer 出现 | 全站 footer 常驻 `DisclaimerSummary`（不可折叠）+「我的」Tab 置顶退订入口 | 免责/退订从「个股页才有」升级为全站常驻（硬约束 1） |
| 6 | 自选按钮 `WatchlistToggle` 是页面内一个普通按钮 | 上移到 StockPage NavBar 右侧，`☆ 加自选 / ★ 已自选` + Toast 反馈 | 高频操作到拇指区；状态用填充色区分，不用颜色暗示涨跌 |
| 7 | AI 解读五段**全部走缺口卡**（`AiTextSlot content={null}`），页面「不像 AI 的话」 | 保留五段骨架 + 缺口卡纪律，但归入「AI」Tab 形成聚合入口，每条带 `AiGeneratedBadge` | AI 能力有明确入口，且「待接入」诚实占位不伪造，合规与产品力兼得 |
| 8 | 涨跌色用 `--up:#b3261e`/`--down:#0f6b3d`（偏暗、不像行情色），且彩底无专用文字色 | 正文 `#d92b20`/`#00804a`，大字 `#e63e31`/`#00a854`，彩底用 `--*-weak-text` | 东财式行情母语 + 全档 4.5:1 达标（详见 system-v2 §2.1、§8） |
| 9 | 资讯流不存在；`NotFound`/`LimitLadder` 是并列顶层页 | 资讯流进「行情」Tab（InfiniteScroll，底部追加免责摘要）；`LimitLadder` 收为行情 Tab 二级段控 | 长内容有标准滚动/加载形态；并列入口收敛（克制原则） |
| 10 | token 是 h5 本地临时占位，`--accent:#0b6357` 青绿主色与东财观感不符 | 接入 system-v2 统一 token：`--brand:#1677ff`、`--brand-emphasis:#e63e31`、涨跌色见 #8 | 与中后台共用一把尺；东财观感到位，跨端一致 |
