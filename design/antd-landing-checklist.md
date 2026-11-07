# antd / antd-mobile 落地实施清单（M1 出方案，owner 确认后 A6 落地）

- 归属：M1（UI/UX）｜日期：2026-11-06｜状态：**方案（不改 package.json，等 owner 确认）**
- 依据：`design/antd-component-mapping.md`（59 条映射）、`design/token-integration.md`（404 行，S1–S3 路线）、`packages/design-tokens/`（tokens.json 单源 + 4 产物，生成器 46/46 对比度已过）
- 版本基线：antd **5.29.x**（console）、antd-mobile **5.43.x**（h5）、React 19.3、Vite 7（两端现状）
- 席位分工（新编制口径）：M1 方案+token（本文）→ H2/A0 依赖与体积评估回执 → **owner 确认 package.json** → A6 落地（旧编制 A7=h5 / A8=console 的实现职责现归 A6 前端席）。

## 0. 一句话结论

**同一个 `tokens.json` 真值、三条消费路径**（antd 吃 `dist/antd-theme.mjs` 对象、antd-mobile 吃 `dist/adm-tokens.css` 的 `--adm-*`、自研吃 `dist/tokens.css` 的 `--ms-*`+旧名别名）。两端不能共用 Provider 代码（antd-mobile 5.43 `ConfigProvider` **无 theme 属性**）。首屏 200KB gzip 硬预算下，h5 只按需引入 12 个组件，估算消耗 30–50KB，图表库是最大不确定项。

## 1. 版本锁定建议（给 owner 确认的 dependency 提案，M1 不代改）

| 包 | 装到 | 建议声明 | 锁定策略 | 备注 |
|---|---|---|---|---|
| `antd` | web/console | `"antd": "~5.29.3"` | **锁 5.x minor**（~），不上 6.x；pnpm-lock.yaml 随 commit 入库 | 全量 dist ≈510 KiB gzip，必须按需 |
| `@ant-design/v5-patch-for-react-19` | web/console | `"~1.0.2"` | 同上 | **必需**：React 19 移除 ReactDOM.render，不装则 `message/Modal.confirm` 路径报错 |
| `@ant-design/icons` | web/console | `"~5.6"` | 同上 | antd 依赖自带，显式声明由 H2 定 |
| `antd-mobile` | web/h5 | `"antd-mobile": "~5.43.0"` | 锁 minor；**计入 200KB 池** | 无 theme API，主题走 `--adm-*` |
| `antd-mobile-icons` | web/h5 | `"~0.3.x"`（以 npm 最新 0.3 patch 为准，H2 回执确认） | 同上 | antd-mobile **不内置**图标包；TabBar/NavBar 需要 |
| 图表库 | 待定 | **先报 gzip 体积再选型**（mapping #31） | 选型前不装 | antd 生态无官方分时/K 线组件 |

锁定纪律：
1. 精确到 minor（`~`）+ lockfile 入库；禁 `^5` 跨 minor 漂移，禁自动升 6.x（映射表按 5.29/5.43 源码核对过，含 `backArrow` 废弃、`ScrollRow` 不存在等勘误）。
2. 升级触发重验：mapping §7 验收 8 条 + `check-budget` + 对比度断言。
3. `pnpm-workspace.yaml` 现状不动；装依赖走 `pnpm add`（由获 owner 授权者执行），不手改 lockfile。

## 2. 体积影响评估（200KB gzip 硬门禁，不可上调）

### 2.1 基线（2026-11-06 实测，未含新依赖）

```bash
pnpm -C web/h5 check:budget
# vendor-react 67.1 + index 14.1 + vendor 2.6 = 83.7 KB gzip / 200 KB
# PASS，剩余 116.3 KB
```

### 2.2 预算消耗预测（h5，按需引入口径）

| 项 | 估算（gzip） | 依据 |
|---|---|---|
| antd-mobile 按需（首屏 12 件：TabBar/NavBar/SearchBar/Card/List/Tag/Button/Segmented/Skeleton/Empty/PullToRefresh/InfiniteScroll） | **30–50 KB** | mapping §6.1「十几–几十 KiB」；组件样式随 es 模块按需进 CSS（不占 JS 预算，check-budget 只算 .js） |
| `antd-mobile-icons`（TabBar/NavBar 实际用到的 5–8 个） | 1–3 KB | 图标组件按个引入 |
| `@market-sense/design-tokens` 产物 | **0 JS** | tokens.css ≈5.6KB + adm-tokens.css ≈1.6KB raw，纯 CSS |
| 图表库（分时/K 线，未选型） | **未知，最大风险** | 选型必须先报 gzip，计入同一池 |
| **合计预测** | **31–53 KB + 图表库** | 剩余约 **63–85 KB** 给图表库 |

红线执行：
- 引入后由 A6 重跑 `node web/h5/scripts/check-budget.mjs` 记录实测；**超 200KB 砍组件，不上调上限，且不砍免责/as_of/数据来源标识**（check-budget.mjs 头注即此规则）。
- 若图表库 + antd-mobile 合计逼近剩余量：砍 `Segmented`/`InfiniteScroll` 等非首屏组件到二级页懒加载；`Skeleton` 可退回自研 `LoadingBlock`（mapping #21）。
- antd **不进 h5**（mapping §6.1 明令）。

### 2.3 console（无 200KB 约束，但要控体积）

- antd 按需：Vite 7 + ESM 直接 `import { Button } from 'antd'` 即可 tree-shake；不需要 unplugin-babel，除非构建实测发现全量带入（H2 验证 `rollup` 产物 chunk）。
- `@ant-design/v5-patch-for-react-19` 极小；`cssVar: true`（antd ≥5.12 满足）输出 `--ant-*` 变量便于深色切换。
- 构建产物目标：console 首屏 JS 建议自查 ≤ 500KB gzip（M1 建议值，非门禁；等 H2/A0 回执定正式值）。

## 3. 迁移步骤（S0–S5，可回滚）

### S0（已完成，M1）
- [x] `design/antd-component-mapping.md` 59 条映射（含 6 处文档勘误、11 个自研保留组件）
- [x] `design/token-integration.md` token 真值/三条消费路径/对比度断言
- [x] `packages/design-tokens/`：tokens.json + `src/build.mjs`（零依赖）+ 4 产物（contrast-report 46/46 pass）

### S1（owner 确认 + 装依赖，H2/A0 + owner）
- [ ] H2/A0 出依赖评估回执：实测各包 gzip、构建耗时、tree-shaking 结论、`antd-mobile-icons` 最新 0.3 patch 号
- [ ] **owner 确认后**改两个 package.json（§1 表；谁改由 owner 指定，M1 不改）+ `pnpm install`
- [ ] 装完立即跑 `pnpm -C web/h5 check:budget` 记录实测增量（此时应还没有组件引用，增量≈0，作为依赖本体基线）

### S2（token 切换，A6，一次 commit，零 JSX 改动）
- [ ] `web/h5/src/styles/tokens.css`、`web/console/src/styles/tokens.css` 改为引入 `@market-sense/design-tokens/dist/tokens.css`（含旧名别名 `--accent`/`--bg`/`--up`…，切换零改动）
- [ ] 深色选择器统一到 `html[data-prefers-color-scheme='dark']`（+ `@media` 兜底），消除「自研深色、组件库浅色」错位（token-integration §6.3）
- [ ] 验收：视觉 diff 只出现「违规色被修正」；E2E/testid 全绿；`contrast-report.json` 全 pass
- [ ] 回滚：还原两份 tokens.css 即回（保留原文件一版）

### S3（console 引 antd，A6）
- [ ] 根节点：`<ConfigProvider theme={lightTheme|darkTheme} locale={zhCN}><App>…</App></ConfigProvider>`（theme 对象 import `dist/antd-theme.mjs`，**不手写**）
- [ ] 静态方法统一 `App.useApp()`（禁 `message.xxx`/`Modal.confirm` 静态调用——拿不到 theme/locale）
- [ ] 迁移顺序：`Layout/Sider/Menu` 骨架 → `Table`（审计/配置列表）→ `Form`+控件（`FormField` 保留为包装层）→ `Modal/Tag/Badge`
- [ ] **自研组件外壳全保留**（mapping §2 的 11 个）：组件名、props、`data-testid` 逐字不变，只换内部实现
- [ ] 输入框边界：`components.Input/Select/DatePicker/InputNumber.colorBorder = #8a929c`（3.15:1）或 `variant="filled"` 二选一并截图
- [ ] 验收：mapping §7 1–8 条（唯一 primary 按钮、回滚 ghost-danger+DoubleConfirm、审批 Modal diff 固定渲染、审计表分页固定 20、agent 行 2px 左边条）

### S4（h5 引 antd-mobile，A6）
- [ ] 样式导入顺序**不可反**（token-integration §6.4）：`antd-mobile/es/global` → `@market-sense/design-tokens/tokens.css` → `adm-tokens.css` → `app.css`
- [ ] 组件顺序：`NavBar`+`TabBar`（P1-5 五 tab：首页/自选/复盘/`/ai`/`/me`）→ `Card`（行情卡/指数卡）→ `Tag`（涨跌胶囊，**禁箭头 icon**）→ `List`（榜单 `arrowIcon={false}`）→ `PullToRefresh`/`InfiniteScroll` → 表单控件
- [ ] **合规组件零迁移**（mapping #25–28）：`AiGeneratedBadge`/`DisclaimerNotice`/`DataGapCard`/`EntitlementNotice` 自研外壳不动；禁用 `Collapse`/`NoticeBar`/`Tooltip` 承载免责/as_of
- [ ] 下拉刷新必须更新全部可见卡片 as_of；失败保留旧数据 + 「未更新」标记（`.quote__stale`）
- [ ] 每步跑：`pnpm -C web/h5 test` + `check:budget` + `check:testids`；testid 迁移前后逐字一致
- [ ] 顺手完成 AI 卡视觉差距修复（`docs/design/ai-display-visual-acceptance-2026-11-06.md` §1/§2/§4：7 选择器 ≥13px、mark 字形 ≥10px、3 处字色、`ai-as-of` testid）——规格明文允许直接落 CSS
- [ ] 回滚：每次只换一个组件，antd-mobile 可整体移除（自研组件不删）

### S5（验收与留证，A6 自验 + H2/A0 复核 + H3 合规位）
- [ ] `pnpm -C web/h5 typecheck && pnpm -C web/h5 test && pnpm -C web/h5 check:compliance && pnpm -C web/h5 check:budget`
- [ ] computed-style/E2E（390×844 浅+深）：免责/AI 标识/as_of 字号 ≥13px、opacity=1、无 aria-hidden 祖先、颜色允许列表、无 `disclaimer-close`（视觉规格 §6.2）
- [ ] `cd packages/design-tokens && node src/build.mjs && git diff --exit-code packages/design-tokens/dist`（防手改产物）
- [ ] grep 门禁：`ScrollRow` 0 命中、`Card block` 0 命中、收尾时 `--accent` 裸调用 0 命中（别名生命周期终点）

## 4. 风险表（摘自 token-integration §9 + 本轮补充）

| 风险 | 缓解 |
|---|---|
| antd 5 静态方法在 React 19 报错 | `@ant-design/v5-patch-for-react-19` 必装（§1） |
| antd-mobile 默认色 3 处不达标（weak #999 2.85:1、border #eee 1.16:1、danger #ff3141） | `adm-tokens.css` 已生成覆盖值，导入顺序守 §6.4 |
| 免责/AI 标识被组件默认样式改变透明度/字号 | 自研外壳不迁移 + computed-style 断言；样式降级须 H3 签 |
| 图表库体积黑洞 | 选型前报 gzip，计入 200KB 池；未定前不装 |
| `--accent` 等旧名调用点漂移 | 别名生成 + 收尾 grep 门禁 |
| **AI 标识底色 token 冲突**（`ai-badge-bg=#e63e31` 东财红 vs 视觉规格 §5 暂用青绿） | M1 提案改 `tokens.json` 指向青绿系（红=涨色不可污染），H3 过目后落（验收报告 §6.1） |
| 深色选择器两套（`prefers-color-scheme` vs `data-prefers-color-scheme`） | S2 一次性统一 |

## 5. 与 P1 主线的关系

- P1-4 antd 引入：本文即 M1 交付物（映射+token 已完成），下一步卡在 **H2/A0 体积回执 + owner 确认 package.json**。
- P1-5 五 tab：S4 的 NavBar/TabBar 步骤即其载体，`/ai`、`/me` 页面壳随迁。
- P1-6/P1-7 不在本文范围（契约对接/行情源），但 console 的 Table/Form 迁移应与 P1-6 的 `/v1/internal/*` 接入同轮做，避免 Mock 与真契约各写一遍组件。
