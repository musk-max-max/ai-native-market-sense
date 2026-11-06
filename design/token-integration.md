# token 接入方案（token-integration）

> 归属：A10（UI/UX）｜状态：v1（方案，待 A0 评估依赖、A7/A8 落地）
> 真值来源：`docs/design/system-v2.md` §2–§4｜配套：`design/antd-component-mapping.md`
> 版本基线：antd **5.29.x**、antd-mobile **5.43.x**、React 19.3。
> 本文不写生成器实现、不改 `package.json`、不改 `app.css`（A7/A8 写域），只定方案与验收。

---

## 0. 结论：混合方案（单一真值 → 三条消费路径）

**不要**在「ConfigProvider theme」和「CSS 变量」之间二选一——两端的组件库能力不同，必须分开接，但共享同一份 token 真值。

```
packages/design-tokens/tokens.json          ← 唯一真值（light + dark，含对比度要求元数据）
        │  node 生成（零依赖脚本）
        ├── dist/tokens.css        --ms-* 变量（自研 CSS 消费；含 legacy 别名）
        ├── dist/antd-theme.mjs    antd 5 ThemeConfig 对象（中后台 ConfigProvider 消费）
        ├── dist/adm-tokens.css    --adm-* 覆盖（antd-mobile 消费，唯一可行方式）
        └── dist/contrast-report.json  对比度断言结果（CI 用）
```

三个关键决策：

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **中后台用 `ConfigProvider theme`，C 端用 `--adm-*` 覆盖** | antd 5 有完整 token 算法（seed→map→component）；**antd-mobile 5.43 的 `ConfigProvider` 没有 `theme` 属性**（`Config` 只含 locale/图标插槽），CSS 变量是它唯一官方主题方式。见 `antd-component-mapping.md` §0.1 |
| D2 | **主色分两个 token：`--ms-brand`（图形/装饰）与 `--ms-brand-strong`（文本/按钮底）** | `#1677ff` 白字仅 4.10:1、白底文字也 4.10:1，**正文不达标**；`#0f5fd6` 白底 5.79:1、白字 5.79:1 达标。antd `colorPrimary` 同时作用于文字链接与主按钮底，只能取达标值 |
| D3 | **规范名 `--ms-*`，同时生成旧名别名（`--accent`/`--bg`/`--up`…）** | 现有 `app.css` 已用旧名（h5 1452 行、console 827 行；`--accent` 分别 23/11 处）。别名让 token 切换**零 JSX/CSS 改动**落地，旧名在下一轮逐步删除；否则一次性重命名会与 A7/A8 在途改动冲突 |

> 一句话：**同一个 JSON 真值，antd 吃对象、antd-mobile 吃 `--adm-*`、自研吃 `--ms-*`；三者不允许各自手写色值。**

---

## 1. 现状盘点（为什么必须换）

两份临时 `tokens.css` 数值互相冲突，且未做对比度断言：

| token | `web/h5/src/styles/tokens.css`（临时） | `web/console/src/styles/tokens.css`（临时） | system-v2 真值 |
| --- | --- | --- | --- |
| 背景 | `--bg #f4f6f8` | `--bg #f5f7fa` | `#f4f6f8` |
| 品牌 | `--accent #0b6357`（青绿） | `--accent #2f6bff` | `#1677ff` / `#0f5fd6` |
| 涨 | `--up #b3261e` | `--up #d64545` | `#d92b20` |
| 跌 | `--down #0f6b3d` | `--down #1f9d55` | `#00804a` |
| 正文 | `--text #14171c` | `--text #1f2329` | `#1f2329` |
| 次要文本 | `--text-muted #4a5563` | `--text-muted #5c6370` | `#5c6370` |
| 微弱文本 | `--text-subtle #5c6876` | 无 | `#6b7280`（仅白底） |
| 圆角 | 14/10/999 | 8/4 | H5 14/10/999；中后台 8/4 |
| 间距 | 无 space 变量 | 4/8/12/16/24 | 4/8/12/16/24/32 |

其他事实：

- `packages/design-tokens/` 目前**只有 `.gitkeep`**，无 `package.json`、无生成脚本。
- `web/h5`、`web/console` 的 `package.json` 均**未安装** `antd` / `antd-mobile`（React 19.3）。
- 现有 `@media (prefers-color-scheme: dark)` 只切换自研变量，与 antd-mobile 的 `html[data-prefers-color-scheme="dark"]` 不同源，会出现「自研深色、组件库浅色」的错位。

---

## 2. 唯一真值：`packages/design-tokens/tokens.json`

三层结构，**只放值，不放样式规则**：

```jsonc
{
  "$meta": { "version": "2.0.0", "wcag": "2.1 AA", "minBodyContrast": 4.5 },
  "primitive": {                       // 原始色，只允许 semantic 层引用
    "blue-500": "#1677ff", "blue-600": "#0f5fd6",
    "red-500": "#d92b20",  "red-600": "#e63e31",
    "green-500": "#00804a","green-600": "#00a854",
    "gray-900": "#1f2329", "gray-600": "#5c6370", "gray-500": "#6b7280"
  },
  "semantic": {                        // 应用只消费这一层
    "text": {
      "value": { "light": "{primitive.gray-900}", "dark": "#e7eaee" },
      "contrast": { "against": ["surface", "bg"], "min": 4.5 }
    },
    "up-weak-text": {
      "value": { "light": "#c5302b", "dark": "#ff8b82" },
      "contrast": { "against": ["up-weak"], "min": 4.5 }
    }
  },
  "component": {                       // 仅两端组件库对接用，例如
    "antd": { "colorPrimary": "{semantic.brand-strong}", "colorError": "{semantic.danger}" },
    "adm":  { "color-weak": "{semantic.text-muted}", "radius-l": "14px" }
  }
}
```

命名规则：

- 变量名统一 `--ms-<role>[-<variant>]`：`--ms-text`、`--ms-text-muted`、`--ms-up-weak-text`、`--ms-brand-strong`。
- **禁止**在 `app.css` 里写十六进制色值（新增代码）；存量色值随 A7/A8 迁移逐步替换。
- 每个语义 token 必须带 `contrast` 元数据（对哪些底、最小比值），生成器据此跑断言（§7）。
- `component` 层只允许指向 `semantic`，不允许出现新的原始色。

---

## 3. 生成产物（4 个文件）

| 产物 | 内容 | 消费者 | 说明 |
| --- | --- | --- | --- |
| `dist/tokens.css` | `:root { --ms-*: …; --bg/--surface/--text/--accent/--up…: var(--ms-*) }` + 深色块 | 自研 CSS（h5/console） | 旧名别名**生成**，不手写；深色选择器见 §6.4 |
| `dist/antd-theme.mjs` | `export const lightTheme = { token, components }` / `darkTheme` | console `<ConfigProvider theme>` | 纯对象，无副作用；antd 版本升级时只改生成模板 |
| `dist/adm-tokens.css` | `:root { --adm-color-primary: …; --adm-radius-l: … }` + 深色块 | h5（import 在 antd-mobile 全局样式**之后**） | antd-mobile 无 theme API，只能如此 |
| `dist/contrast-report.json` | 每个语义 token 对每个声明的底的实际比值 + pass/fail | CI / 审计 | 失败即 `process.exit(1)`，见 §7 |

构建约束：

- 生成器放 `packages/design-tokens/src/build.mjs`，Node 原生 ESM、零依赖（不引 color 库，WCAG 公式 10 行内）。
- **产物提交进仓库**（便于 `@market-sense/design-tokens` 直接 import），CI 跑一次 `node build.mjs && git diff --exit-code packages/design-tokens/dist`，防止手改产物。
- 包名 `@market-sense/design-tokens`，`"exports": { "./tokens.css": …, "./antd-theme": …, "./adm-tokens.css": … }`。

---

## 4. `--ms-*` 语义 token 表（核心色板）

对比度已复算（WCAG 2.1，`#fff` 底 / 声明底）；**任何新 token 必须与此表同格式登记**。

| token | light | dark | 对比度（light） | 使用约束 |
| --- | --- | --- | --- | --- |
| `--ms-text` | `#1f2329` | `#e7eaee` | 15.78 / 白 | 正文、标题 |
| `--ms-text-muted` | `#5c6370` | `#9aa3ad` | 6.05 / 白；5.34 / surface-2；5.58 / bg | 次要文本、说明、as_of 标签 |
| `--ms-text-subtle` | `#6b7280` | `#8a93a0` | 4.83 / **白** | **仅白底**；压 `--bg` 4.46、压 `--surface-2` 4.27 → 不达标，禁用于非白底 |
| `--ms-text-disabled` | `#9aa3ad` | `#5c6370` | 2.56 / 白 | 仅禁用态（WCAG 1.4.3 豁免）；**免责/AI 标识/as_of 永不用此 token** |
| `--ms-bg` | `#f4f6f8` | `#0b0f14` | — | 页面底 |
| `--ms-surface` | `#ffffff` | `#131a22` | — | 卡片底 |
| `--ms-surface-2` | `#eef1f5` | `#1b2430` | — | 缺口卡/分组底 |
| `--ms-border` | `#d7dde5` | `#2a3542` | 1.37 / 白（非文本） | 仅装饰性分隔（卡片边界可由底色区分） |
| `--ms-border-strong` | `#aab6c4` | `#465463` | 2.06 / 白 | hover / 选中描边（非文本） |
| `--ms-border-control` | `#8a929c` | `#8a929c` | **3.15 / 白**；5.57 / 深底 `#131a22` | **输入框/可交互控件边界**（WCAG 1.4.11 需 3:1）；新增 token，antd 默认 `#d9d9d9` 不达标 |
| `--ms-brand` | `#1677ff` | `#5b8cff` | 4.10 / 白 | **仅图形/装饰**：选中条、图标、进度（3:1 非文本，达标）；**不做正文/链接文字** |
| `--ms-brand-strong` | `#0f5fd6` | `#5b8cff` | **5.79 / 白**；5.09 / brand-weak；5.34 / bg | 链接文字、主按钮底、TabBar 选中文字（antd `colorPrimary`/`colorLink`） |
| `--ms-brand-weak` | `#e8f1ff` | `#10233f` | 文字只能用 brand-strong（5.09）/ 4.98（dark） | 选中底、tag 底；**不可**用 `--ms-brand` 压它（3.61 不达标） |
| `--ms-brand-contrast` | `#ffffff` | `#ffffff` | 白字压 brand-strong 5.79 | 主按钮文字 |
| `--ms-up` | `#d92b20` | `#ff8b82` | 4.86 / 白；7.73 / 深底 | 涨：正文数值、涨跌幅 |
| `--ms-up-strong` | `#e63e31` | `#ff8b82` | **4.12 / 白（仅 ≥24px bold 或 ≥18.66px bold）** | 只允许大字/图形；**正文字号禁用** |
| `--ms-up-weak` | `#fdecea` | `#3a1c1a` | 文字用 up-weak-text | 涨胶囊底；**不可**用 `--ms-up #d92b20` 压它（4.25 不达标） |
| `--ms-up-weak-text` | `#c5302b` | `#ffc9c4` | 4.79 / up-weak；10.58 / 深色 weak | 涨胶囊文字唯一可用色 |
| `--ms-down` | `#00804a` | `#3ddc97` | 5.02 / 白；9.91 / 深底 | 跌：正文数值、涨跌幅 |
| `--ms-down-strong` | `#00a854` | `#3ddc97` | **3.12 / 白（正文不达标，仅大字）**；对 down-weak **2.79 禁用** | 只允许大字/图形；文档中「仅大字达标」须标注此项 |
| `--ms-down-weak` | `#e6f6ec` | `#102e20` | 文字用 down-weak-text | 跌胶囊底 |
| `--ms-down-weak-text` | `#00794a` | `#b8f0d0` | **4.89** / down-weak；5.48 / 白 | 跌胶囊文字唯一可用色；对 `--ms-down` 4.48 临界不达标，勿混用 |
| `--ms-warning-text` | `#7a4d00` | `#ffd693` | 6.82 / warning-bg；12.76 / 深底 | 合规锁定说明、警示文字 |
| `--ms-warning-bg` | `#fff7e6` | `#33240c` | — | 警示底 |
| `--ms-danger-text` | `#a12622` | `#ffb4ae` | 6.53 / danger-bg；7.46 / 白 | 错误、危险确认标题、回滚 |
| `--ms-danger-bg` | `#fdecec` | `#351717` | — | 错误底 |
| `--ms-success-text` | `#1c6b3d` | `#7ee2a8` | 5.92 / success-bg；6.52 / 白 | 发布成功等状态文字 |
| `--ms-success-bg` | `#eaf7ef` | `#1c3326` | — | 成功底 |
| `--ms-focus` | `#0f5fd6` | `#5b8cff` | 同 brand-strong | 键盘焦点环（2px，与底色 3:1） |
| `--ms-shadow` | 同现有 | 同现有 | — | 阴影不是对比度要素，允许保留 |

排版/尺度 token（由同一 JSON 生成）：

- 字号：`--ms-font-display 28px`、`--ms-font-title 18px`、`--ms-font-body 15px`、`--ms-font-body-compact 14px`、`--ms-font-caption 13px`（**免责/as_of 下限**）、`--ms-font-tag 11px`（仅标签，不承载合规文案）。
- 数字：`--ms-font-numeric`（DIN Alternate 回退栈）+ `font-variant-numeric: tabular-nums`。
- 间距：`--ms-space-1..6 = 4/8/12/16/24/32`；H5 `--ms-page-gutter 16`、`--ms-card-gap 12`；中后台 `--ms-sidebar 232`、`--ms-topbar 56`。
- 圆角：`--ms-radius-lg 14px`（H5 卡片）/ `8px`（中后台）、`--ms-radius-sm 10px`/`4px`、`--ms-radius-pill 999px`。

> **合规红线**：免责声明、AI 标识、as_of 三处的可见性不能由 token 值单独保证，还需组件契约（不可折叠/不可关闭/无 opacity）；token 侧只负责「文字 ≥13px 且 ≥4.5:1、背景不吞色」。

---

## 5. 中后台：antd 5 `ConfigProvider theme`

### 5.1 token 映射（seed → antd）

| antd token | 取值 | 依据 |
| --- | --- | --- |
| `colorPrimary` | `#0f5fd6`（`--ms-brand-strong`） | 白字 5.79；**不能**用 `#1677ff`（白字 4.10） |
| `colorError` | `#a12622`（`--ms-danger-text`） | 白字 7.46；语义=失败/危险，**不是涨** |
| `colorWarning` | `#b45309` | 白字 5.02；与 `--ms-warning-text #7a4d00`（文字）分工 |
| `colorSuccess` | `#1c6b3d`（`--ms-success-text`） | 白字 6.52 |
| `colorInfo` | `#0f5fd6` | 同 primary |
| `colorTextBase` | `#1f2329` | — |
| `colorBgBase` | `#ffffff` | — |
| `colorBgLayout` | `#f4f6f8` | — |
| `colorBgContainer` | `#ffffff` | — |
| `colorBorder` | `#d7dde5` | 装饰边界 |
| `colorBorderSecondary` | `#eef1f5` | — |
| `colorText` | `#1f2329` | 15.78 |
| `colorTextSecondary` | `#5c6370` | 6.05（antd 默认 `.65`≈#595959 7.00，可用；统一到我们的灰） |
| `colorTextTertiary` | `#5c6370` | **antd 默认 `.45`≈#8c8c8c 对白 3.36 不达标**，必须覆盖 |
| `colorTextQuaternary`（禁用） | `#9aa3ad` | 仅禁用态 |
| `borderRadius` | `8` | 中后台卡片圆角 8（H5 是 14，仅 C 端） |
| `borderRadiusLG` / `SM` | `8` / `4` | — |
| `fontSize` | `14` | 中后台正文 14（C 端 15） |
| `fontFamily` | `--ms-font-sans` | — |
| `controlHeight` | `32` | 紧凑中后台 |
| `wireframe` | `false` | — |
| `motionDurationMid` | `0.24s` | system-v2 §6：240ms 一次性 |
| `motion` | 保留 | 不关闭 antd 展开动画；但业务列表**禁止**涨跌动效/脉冲（组件层自律） |

**输入框边界**：`colorBorder` 在 antd 中同时用于输入框描边，而 `#d7dde5` 对白 1.37:1，不满足 1.4.11。两选一（推荐 a）：

- a) `components.Input` / `Select` / `DatePicker` / `InputNumber` 显式 `colorBorder: '#8a929c'`（`--ms-border-control`，3.15:1）；
- b) 输入框改用 `variant="filled"`（底色差区分），boundary 不依赖描边。A8 落地时二选一并截图验收。

### 5.2 主题对象形态

```ts
// 由 packages/design-tokens 生成，console 侧只 import，不手写
import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

export const lightTheme: ThemeConfig = {
  cssVar: true,              // 输出 --ant-* 变量，便于深色切换与调试；需 A0 确认 antd>=5.12
  hashed: false,
  token: { /* §5.1 表 */ },
  components: {
    Layout:   { headerBg: '#ffffff', siderBg: '#ffffff', bodyBg: '#f4f6f8', headerHeight: 56 },
    Menu:     { itemHeight: 40, itemSelectedBg: '#e8f1ff', itemSelectedColor: '#0f5fd6',
                itemActiveBg: '#eef1f5', itemBorderRadius: 6 },
    Table:    { headerBg: '#f4f6f8', rowHoverBg: '#f0f4f8', cellPaddingBlock: 12,
                borderColor: '#eef1f5', headerSplitColor: 'transparent' },
    Button:   { fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
    Modal:    { titleColor: '#1f2329', contentBg: '#ffffff', headerBg: '#ffffff' },
    Breadcrumb: { itemColor: '#5c6370', lastItemColor: '#1f2329' },
    Pagination: { itemSize: 32, itemActiveBg: '#e8f1ff' },
  },
};

export const darkTheme: ThemeConfig = {
  ...lightTheme,
  algorithm: theme.darkAlgorithm,
  token: { /* §5.1 的深色列；必须显式覆盖，不依赖算法的派生色 */ },
};
```

三处「生成而不手写」的理由：antd 的 map token 会从 seed 派生（如 `colorPrimaryBg`、`colorErrorBg`），手写 CSS 覆盖只能盖住一部分，且深色算法会再把派生色算一遍；用 `theme` 对象 + `components` 才能覆盖完整链路。

### 5.3 深色与运行时切换

- console 根节点：`<html data-theme="light|dark">`；主题选择由 `theme.darkAlgorithm` 决定，同时 `tokens.css` 的深色块用 `[data-theme='dark']` 选择器（与 antd 切换同一时刻，无闪烁）。
- 首次加载兜底：`@media (prefers-color-scheme: dark)` 且无 `data-theme` 时也应用深色块（SSR/首屏）。
- **不要**用两套 `ConfigProvider` 嵌套做局部深色；中后台局部深色会破坏审计表格的对比度基线。

### 5.4 静态方法

`message.xxx` / `Modal.confirm` / `notification.xxx` 的静态调用**拿不到** ConfigProvider 的 theme、locale、前缀，antd 官方明确警告。console 统一用：

```tsx
<App>…</App>          // antd App 组件，包在 ConfigProvider 内
const { message, modal, notification } = App.useApp();
```

现状：console 的 `DoubleConfirm` 是自研 `role="dialog"`，可继续保留；新代码禁止静态 `Modal.confirm`。

---

## 6. C 端：antd-mobile `--adm-*` 覆盖

antd-mobile 5.43 **没有** `ConfigProvider theme`；主题只能覆盖 CSS 变量。默认值里有 3 个不达标点必须改：

| 默认 | 问题 | 覆盖为 |
| --- | --- | --- |
| `--adm-color-weak: #999999` | 对白 **2.85:1**，占位符/提示文字直接违规 | `#5c6370`（6.05） |
| `--adm-color-text-secondary: #666666` | 5.74 达标但不统一 | `#5c6370` |
| `--adm-color-border: #eeeeee` | 输入/搜索框边界 1.16:1，不满足 1.4.11 | 控件处用 `#8a929c`（3.15）；卡片分隔仍可用 `#eef1f5` |
| 深色 `--adm-color-weak: #808080` | 对 `#1a1a1a` **4.41:1** | `#9aa3ad`（对 `#131a22` 6.86） |
| `--adm-color-primary: #1677ff` | 白字 4.10 / 白底文字 4.10 | `#0f5fd6`（白字 5.79） |
| `--adm-color-danger: #ff3141` | 对白仅 3.9 左右，文字不达标 | `#a12622`（7.46） |
| `--adm-font-size-main: 13px` | 小于正文 15；13 只是 caption 下限 | `15px` |

### 6.1 全局覆盖清单

| `--adm-*` | 值 | 对应 `--ms-*` |
| --- | --- | --- |
| `--adm-color-primary` | `#0f5fd6` | brand-strong |
| `--adm-color-success` | `#1c6b3d` | success-text |
| `--adm-color-warning` | `#b45309` | —（warning 底用 `#fff7e6`） |
| `--adm-color-danger` | `#a12622` | danger-text |
| `--adm-color-text` | `#1f2329` | text |
| `--adm-color-text-secondary` | `#5c6370` | text-muted |
| `--adm-color-weak` | `#5c6370` | text-muted（**替换 #999**） |
| `--adm-color-light` | `#aab6c4` | border-strong（仅禁用色/分割） |
| `--adm-color-border` | `#d7dde5` | border（装饰） |
| `--adm-color-background` | `#ffffff` | surface |
| `--adm-color-box` | `#f4f6f8` | bg |
| `--adm-radius-s / m / l` | `6px / 10px / 14px` | system-v2 H5 圆角 |
| `--adm-font-family` | `--ms-font-sans` | — |
| `--adm-font-size-main` | `15px` | font-body |
| `--adm-font-size-1..3` | `11 / 12 / 13px` | tag / 次级 / caption |
| `--adm-font-size-4..7` | `14 / 15 / 16 / 18px` | body-compact / body / title-sm / title |

### 6.2 落地形态

```css
/* dist/adm-tokens.css —— 必须在 antd-mobile 全局样式之后 import
   （antd-mobile 的 :root 变量与其同优先级，后导入者胜） */
:root {
  --adm-color-primary: var(--ms-brand-strong);
  --adm-color-text: var(--ms-text);
  --adm-color-text-secondary: var(--ms-text-muted);
  --adm-color-weak: var(--ms-text-muted);
  --adm-color-border: var(--ms-border);
  --adm-color-background: var(--ms-surface);
  --adm-color-box: var(--ms-bg);
  --adm-radius-s: 6px; --adm-radius-m: var(--ms-radius-sm); --adm-radius-l: var(--ms-radius-lg);
  --adm-font-size-main: var(--ms-font-body);
}
html[data-prefers-color-scheme='dark'] {
  --adm-color-primary: var(--ms-brand);
  --adm-color-text: var(--ms-text);
  --adm-color-weak: var(--ms-text-muted);
  --adm-color-background: var(--ms-surface);
  --adm-color-box: var(--ms-bg);
  --adm-color-border: var(--ms-border);
}
```

组件级覆盖（`antd-mobile` 官方支持的自定义变量，已核实）：

| 组件 | 变量 | 值 |
| --- | --- | --- |
| Card | `--adm-card-border-radius` / `--adm-card-padding-inline` | `14px` / `16px` |
| List | `--font-size` / `--header-font-size` / `--padding-left` | `15px` / `13px` / `16px` |
| Button | `--border-radius` | `10px`（`size="mini"` 用 `999px`） |
| Tag | `--border-radius` | `999px`（涨跌胶囊） |
| Segmented | `--segmented-item-selected-color` | `#0f5fd6`（选中段文字，白底 5.79） |

### 6.3 深色

antd-mobile 内建深色开关是 `html[data-prefers-color-scheme='dark']`（**不是** `prefers-color-scheme` 媒体查询）。因此：

- 自研 `tokens.css` 的深色块、`adm-tokens.css` 的深色块、antd-mobile 的深色块**统一挂到 `html[data-prefers-color-scheme='dark']`**（可同时保留 `@media` 兜底，但业务切换走属性）。
- 现状 `web/h5/src/styles/tokens.css` 用的是 `@media (prefers-color-scheme: dark)`，必须替换；否则出现「页面深色、TabBar 浅色」。
- 深色下所有 `--ms-*` 已在 §4 列出并复算通过（最低为 brand-weak 上文字 4.98）。

### 6.4 顺序

```ts
import 'antd-mobile/es/global';        // ① 组件库默认变量
import '@market-sense/design-tokens/tokens.css';    // ② --ms-*（含深色块）
import '@market-sense/design-tokens/adm-tokens.css';// ③ 覆盖 --adm-*
import './styles/app.css';             // ④ 自研样式
```

②③④ 的顺序不能反：`--adm-*` 覆盖必须晚于 antd-mobile 全局样式；`app.css` 最晚以覆盖组件级样式。

---

## 7. 对比度断言（CI 门禁）

### 7.1 断言规则

生成器读 `tokens.json` 的 `contrast` 元数据，逐对计算 WCAG 2.1 比值，规则：

1. 正文/说明/标签文字（`--ms-text*`、`--ms-*-weak-text`、`--ms-*-text`）：**≥4.5:1**；`≥24px` 或 `≥18.66px bold` 的大字可 **≥3:1**，但必须在 token 元数据标 `largeTextOnly: true`（仅 `--ms-up-strong` / `--ms-down-strong`）。
2. 输入框/按钮/可聚焦控件边界：**≥3:1**（`--ms-border-control`）。
3. 焦点环：与相邻底色 **≥3:1**。
4. 禁用态文字不受 4.5 约束，但**禁用 token 不得出现在免责/AI 标识/as_of 的样式里**（组件层断言：`data-testid` 节点的 computed color 必须来自允许列表）。
5. 任一 fail → `process.exit(1)`，CI 红；`contrast-report.json` 入库留痕。

### 7.2 必须失败的黑名单（回归用）

| 组合 | 比值 | 结论 |
| --- | --- | --- |
| `#00a854` / `#ffffff`（正文） | 3.12 | 正文禁用（仅大字） |
| `#00a854` / `#e6f6ec` | 2.79 | 任意字号禁用 |
| `#00804a` / `#e6f6ec` | 4.48 | 临界不达标，改用 `--ms-down-weak-text` |
| `#d92b20` / `#fdecea` | 4.25 | 涨胶囊文字禁用，改用 `--ms-up-weak-text` |
| `#e63e31` / `#ffffff`（正文） | 4.12 | 正文禁用（仅大字） |
| `#1677ff` / `#e8f1ff`（文字） | 3.61 | 选中底文字禁用，改用 `--ms-brand-strong`（5.09） |
| `#6b7280` / `#f4f6f8` | 4.46 | `--ms-text-subtle` 禁用于非白底 |
| `#6b7280` / `#eef1f5` | 4.27 | 同上 |
| `#999999` / `#ffffff`（antd-mobile 默认 weak） | 2.85 | 必须覆盖 |
| `#8c8c8c` / `#ffffff`（antd 默认 tertiary） | 3.36 | 必须覆盖 |
| `#d7dde5` / `#ffffff`（控件边界） | 1.37 | 输入框须用 `--ms-border-control` |
| `#808080` / `#1a1a1a`（antd-mobile 深色 weak） | 4.41 | 必须覆盖 |

### 7.3 组件层断言（可加进现有 E2E）

- 免责/as_of/AI 标识节点：`getComputedStyle` 的 `color` 必须 ∈ 允许列表，`opacity === 1`，无 `[aria-hidden="true"]` 祖先。
- `data-testid="disclaimer"`、`quote-as-of`、`ai-generated-badge` 的 `font-size ≥ 13px`。
- 深色切换后重跑上述断言（两套主题各跑一遍）。

---

## 8. 迁移路线（3 步，可回滚）

| 步 | 内容 | 负责人 | 验收 | 回滚 |
| --- | --- | --- | --- | --- |
| S1 | 建 `packages/design-tokens`（tokens.json + 生成器 + 断言），生成 4 产物；h5/console 的 `tokens.css` 改为 import 生成文件（保留旧名别名） | A10（本方案落地时） | 视觉 diff 只应出现「违规色被修正」；E2E/testid 全绿；`contrast-report` 全 pass | 保留原 `tokens.css` 一版，`git revert` 即可；无 JSX 改动 |
| S2 | A0 评估并装 `antd` + `@ant-design/v5-patch-for-react-19` + `@ant-design/icons`；A8 在 console 根节点接 `ConfigProvider` + `App`，替换 `AppShell/DataTable/FormField` 等 | A0 → A8 | mapping 文档 §6 验收 1–8；深色切两套 | 移除 Provider 即回到自研组件（自研组件不删） |
| S3 | A0 装 `antd-mobile` + `antd-mobile-icons`；A7 接 H5（顺序见 §6.4），先 TabBar/NavBar/Card/List，再表单控件 | A0 → A7 | mapping §6 验收 1–8；下拉刷新更新 as_of；免责/as_of 不可折叠 | 每次只换一个组件，`antd-mobile` 可整体移除 |

**别名生命周期**：S1 生成 `--accent: var(--ms-brand-strong)`（h5/console 均指向新主色）等旧名；S2/S3 期间 A7/A8 逐步把调用点换 `--ms-*`；最后一轮删别名（删除前 `grep -r "--accent" web/` 必须为 0）。

---

## 9. 风险与移交

| 风险 | 影响 | 缓解 / 归属 |
| --- | --- | --- |
| antd 5 在 React 19 下静态方法报错 | 构建/运行错误 | 必须装 `@ant-design/v5-patch-for-react-19`（A0 评估）；已写入 mapping §5 |
| `cssVar: true` 的行为差异 | 部分组件样式异常 | A0/A8 在 S2 首日验证 4 个核心页；异常则回退 `cssVar: false`，方案不变 |
| antd-mobile `--adm-*` 覆盖被组件级变量覆盖 | 局部仍用旧色 | 组件级变量表已在 §6.2；E2E 抓 computed style |
| 深色选择器不一致（`prefers-color-scheme` vs `data-prefers-color-scheme`） | 深浅错位 | §6.3 统一为 `html[data-prefers-color-scheme='dark']`；S1 一次性替换 |
| `--accent` 23/11 处调用点漂移 | 品牌色不一致 | 别名 + 收尾 grep 门禁 |
| 免责/AI 标识被 antd 组件默认样式改变（透明度、字号、颜色继承） | **合规** | 组件契约保留自研（mapping §2）；E2E 断言 §7.3；改样式须走 H3 签（must_escalate） |
| 体积（antd 全量 ≈510 KiB gzip + antd-mobile） | 首屏 | A0 评估按需引入/unplugin；H5 首屏只引用到组件 |
| token 真值与文档漂移 | 对比度回退 | 生成器只读 tokens.json；文档数值由 `contrast-report.json` 反填；改色须 A10 + 复核 |

**移交**：`packages/design-tokens` 生成器与 `design/` 文档由 A10 维护；依赖安装与体积评估交 A0；console 接入交 A8；h5 接入交 A7。改 `package.json` / 依赖版本一律走 A0 评估 + owner 确认。
