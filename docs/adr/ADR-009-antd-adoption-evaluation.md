# ADR-009：antd 全家桶引入评估（web/h5 = antd-mobile，web/console = antd）

- 状态：**评估稿（Proposed）——只出评估不改**。任何 package.json 改动须 owner 明示确认后另行落笔。
- 日期：2026-11-06；作者：H2（架构与技术负责人）
- 背景：Lead 提议 web/h5 加 antd-mobile、web/console 加 antd。硬约束：首屏 JS 预算 200KB gzip（`web/h5/scripts/check-budget.mjs`，AC-9，**不可上调**；超限砍组件，不得砍免责声明/as_of/数据来源等合规标识）；改 package.json 须 owner 确认；引入版本须锁定。
- 真栈：web/h5 = React 19.3.1 + Vite 7.1.0；web/console = React 19.3.1 + Vite 7.3.7。

## 1. 版本锁定方案（若引入）

- 精确版本、无范围符：`"antd-mobile": "5.43.0"`（h5）、`"antd": "6.7.0"`（console）；lockfile 必须提交。不另引 @ant-design/icons 等旁路包（antd 6 自带 `@ant-design/icons ^6.3.4` 依赖）。
- 理由：① gzip 预算对 minor/patch 波动敏感，`^` 会让预算静默漂移；② 供应链投毒风险（锁版本 + integrity 可审计）；③ 构建可复现。
- 升级路径：版本升级=独立 PR + check-budget 门禁 + A7 回归 + H2 复核；不自动合入自动升级。

## 2. 兼容性（React 19 / Vite 7）

| 维度 | antd 6.7.0（console） | antd-mobile 5.43.0（h5） |
|---|---|---|
| React 19 | ✓ 原生（peer `react >=18`；v6 起移除 v5 的 `@ant-design/v5-patch-for-react-19` 需求） | ⚠ peer 含 `^19.0.0`，但官方文档《React 19 兼容》要求入口挂 `unstableSetRender` 兼容配置（react-dom 导出变更影响 Toast/Modal 命令式渲染），并声明「该兼容方式将在下一个 major 移除」 |
| Vite 7 | ✓ es module + 运行时 cssinjs（@ant-design/cssinjs ^2.1.2），无需 Vite 插件；antd 自身已用 Vite 8 构建 | ✓ es module；无构建插件需求 |
| tree-shaking | ✓ `sideEffects: ["*.css"]`，按需导入可摇 | ⚠ `sideEffects` 含 **`"./es/index.js"`（根入口标记为副作用）**：`import { X } from 'antd-mobile'` 根导入**不可摇、等于全量**；必须组件深导入（`antd-mobile/es/components/...`） |

技术债标记：h5 需在入口集中放 `unstableSetRender` shim；antd-mobile v6 发布后迁移并移除 shim。

## 3. 体积影响（预算数学）

数据来源：bundlephobia 全量导入成本（含传递依赖），2026-11-06 取数：

| 包 | 全量 JS gzip | CSS | 说明 |
|---|---|---|---|
| antd-mobile@5.43.0 | **148.0 KB** | 18.5 KB gzip（独立 CSS） | 含 rc-field-form/@react-spring/ahooks/icons 等 20 个传递依赖 |
| antd@6.7.0 | **460.8 KB** | 无独立 CSS（运行时 cssinjs） | 全量 UMD 上限 449KB gzip（官方 size-limit） |

h5 预算数学（实测，2026-11-06）：
- 现状：vendor-react 67.1 + index 14.1 + vendor 2.6 = **83.7 KB gzip / 200 KB 预算，PASS 余量 116.3 KB**（`check-budget.mjs` 口径：dist/assets/*.js gzip 合计）。
- antd-mobile **全量引入：83.7 + 148 ≈ 232 KB > 200 KB，直接破预算，不可行**。
- 按需深导入子集（如 Button/List/Popup/Tabs/Toast 白名单）预计 30–60 KB gzip——**必须 spike 分支实测**，以 `check-budget.mjs` 为唯一验收门；超限=砍组件，**不上调预算**。
- console 无首屏预算门（内部工具），但全量 460KB gzip 不可取：按需导入 + 路由级 code-splitting，桌面内网可接受 200–300KB 初始包。

合规门禁不因 UI 库让步：引入后 `check-budget` / `check-bundle-compliance` / `check-dom-compliance` / `check:testids` 全部重跑（AI 标识、免责、as_of、来源组件不得被 UI 迁移砍掉）。

## 4. 引入方案建议（若 owner 批准）

- **h5 优先方案 = 不引入**：现有自建 TabBar + 五 tab 已 83.7KB PASS；UI 库收益主要是表单/弹层开发速度。若后续表单/Picker 场景增多再引入，且必须：锁 5.43.0 + 入口 shim + 组件深导入白名单（禁 `from 'antd-mobile'` 根导入，lint 约束）+ CI 预算门禁兜底。
- **console 建议引入 antd 6.7.0**（原生 React 19、无 shim）：按需导入 + 路由分割，替代自建 Table/Form/Modal；不影响 CONTRACT-MAP 的 ConfigServicePort UI↔契约解耦。
- 落地前置：① owner 明示确认改 package.json（红线）；② h5 spike 实测子集过 200KB 门；③ A7 回归 + A6 console 用例；④ H2 复核锁版本与体积。

## 5. 风险与待签

| 风险 | 缓解 | Owner/状态 |
|---|---|---|
| h5 破 200KB 预算 | 全量引入已量化不可行；按需深导入 + 门禁强制；超限砍组件不上调 | H2/A7，门禁强制 |
| antd-mobile React 19 shim 技术债（v6 将移除） | shim 集中入口一处；v6 发布即迁移 | A6/H2 |
| 根导入不可摇（es/index.js 副作用） | 深导入白名单 + lint 禁根导入 | A6 |
| 依赖供应链/版本漂移 | 精确锁版本 + lockfile + 升级走 PR 门禁 | H2 |
| 合规标识被 UI 迁移误砍 | budget/compliance/testids 门禁清单强制 | A7 |
| package.json 改动无 owner 确认 | 本 ADR 只评估不改；批准前不落任何依赖 | owner PENDING |

## 数据来源

- [npm registry: antd-mobile@5.43.0](https://registry.npmjs.org/antd-mobile/latest)（peer/副作用声明）
- [npm registry: antd@6.7.0](https://registry.npmjs.org/antd/latest)（peer/size-limit）
- [bundlephobia: antd-mobile@5.43.0](https://bundlephobia.com/package/antd-mobile@5.43.0)（148KB JS + 18.5KB CSS gzip）
- [bundlephobia: antd@6.7.0](https://bundlephobia.com/package/antd@6.7.0)（460KB gzip）
- [antd-mobile React 19 兼容文档](https://raw.githubusercontent.com/ant-design/ant-design-mobile/master/docs/guide/v5-for-19.zh.md)（unstableSetRender）
- [antd React 19 兼容 FAQ](https://faq.ant-design-next.pages.dev/docs/react/v5-for-19-cn)（v5 patch 包、v6 移除）

## 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-06 | v1.0 | H2 评估稿：antd-mobile 5.43.0 / antd 6.7.0 锁定方案；React 19/Vite 7 兼容结论（h5 需 shim、根导入不可摇）；体积数学（全量 148KB/460KB gzip；h5 全量破预算、按需子集须 spike）；只评估不改 |
