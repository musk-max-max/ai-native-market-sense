# @market-sense/design-tokens

设计 token **单一真值**与三条消费路径。唯一直接读源是 `tokens.json`，**禁止**在 `app.css`、组件或主题文件里手写色值。

- 单源：`tokens.json`
- 生成器：`src/build.mjs`（Node 原生 ESM，**零依赖**，WCAG 公式内置 10 行内）
- 产物：`dist/tokens.css` / `dist/antd-theme.mjs` / `dist/adm-tokens.css` / `dist/contrast-report.json`（**产物提交进仓库**）
- 规范依据：`docs/design/system-v2.md` §2–§6、`design/token-integration.md`
- 组件映射：`design/antd-component-mapping.md`

> 归属 M1（UI/UX）。本包只出 token 与生成物，**不写 React/TS 实现代码、不改 package.json**（A6 落地、依赖安装走 owner 确认）。

---

## 0. 一句话结论

**同一个 JSON 真值，antd 吃对象、antd-mobile 吃 `--adm-*`、自研吃 `--ms-*`；三者不允许各自手写色值。**

| 消费端 | 主题方式 | 原因 |
| --- | --- | --- |
| 中后台 antd 5 | `<ConfigProvider theme={lightTheme}>`（对象） | antd 5 有完整 seed→map→component 算法 |
| C 端 antd-mobile 5.43 | `--adm-*` CSS 变量覆盖 | **`ConfigProvider` 无 `theme` 属性**（只有 locale/图标插槽），CSS 变量是唯一官方方式 |
| 自研 CSS（两端） | `--ms-*` 变量 + 旧名别名 | 单源 + 零 JSX 改动落地 |

---

## 1. 生成

```bash
cd packages/design-tokens
node src/build.mjs
```

成功输出：`对比度断言 N/N pass，黑名单回归 12 组 mismatch=0 → PASS`。
任一语义 token 不达标或黑名单比值漂移 → `process.exit(1)`（CI 红）。

CI 防手改产物：

```bash
node src/build.mjs && git diff --exit-code packages/design-tokens/dist
```

---

## 2. A6 如何消费

### 2.1 中后台（`web/console`，antd 5）

```ts
// console 根节点
import { ConfigProvider, App } from 'antd';
import { lightTheme, darkTheme } from '@market-sense/design-tokens/antd-theme';
import zhCN from 'antd/locale/zh_CN';

<ConfigProvider theme={isDark ? darkTheme : lightTheme} locale={zhCN}>
  <App>   {/* 静态 message/Modal.confirm 拿不到 theme，必须 App.useApp() */}
    …
  </App>
</ConfigProvider>
```

要点：
- `darkTheme` 已内置 `algorithm: theme.darkAlgorithm` + **显式覆盖**深色 token（不依赖算法再派生一遍）。
- 输入框边界 antd 默认 `#d9d9d9`(1.37:1) 不达标；生成器已在 `components.Input/Select/DatePicker/InputNumber.colorBorder` 注入 `--ms-border-control`（浅 `#8a929c` 3.15:1 / 深 `#a3abb5` ≥3:1）。
- **深色切换**：`<html data-theme="dark">` 与 `tokens.css` 深色块同一时刻切换，无闪烁。中后台不要做局部深色（会破坏审计表对比度基线）。
- 消费 `antd-theme.mjs` 前需安装 `antd`；**改 package.json 须 owner 确认**（P1-4，H2 评估单 → owner）。

### 2.2 C 端（`web/h5`，antd-mobile 5.43）

**import 顺序不能反**（`--adm-*` 覆盖必须晚于组件库全局样式，后导入者胜）：

```ts
import 'antd-mobile/es/global';                       // ① 组件库默认变量
import '@market-sense/design-tokens/tokens.css';      // ② --ms-*（含深色块）
import '@market-sense/design-tokens/adm-tokens.css';  // ③ 覆盖 --adm-*
import './styles/app.css';                            // ④ 自研样式最晚
```

要点：
- 深色统一挂 `html[data-prefers-color-scheme="dark"]`（antd-mobile 内建开关同源）。**必须替换**现有 `web/h5/src/styles/tokens.css` 里的 `@media (prefers-color-scheme: dark)`，否则「页面深色、TabBar 浅色」错位。
- 组件级变量（Card 圆角/List 字号/Button 圆角/Tag 胶囊）见 `token-integration.md` §6.2，仍在 `app.css` 层覆盖。
- 涨跌胶囊文字**只能**用 `--ms-up-weak-text`/`--ms-down-weak-text`，禁用 `--ms-up`/`--ms-down` 压彩底（4.25/4.48 不达标）。

### 2.3 旧名别名

`dist/tokens.css` 末尾生成 `--accent`/`--bg`/`--text`/`--up`… 旧名 → `var(--ms-*)`，使现有 `app.css`（h5 1452 行 / console 827 行，`--accent` 23/11 处）**零改动**切到新色。旧名在下一轮逐步删除；删除前 `grep -r "--accent" web/` 必须为 0。

---

## 3. 体积预算结论（首屏 JS ≤200KB gzip，不可上调）

预算门禁：`node web/h5/scripts/check-budget.mjs`（H1 veto）。**引入 antd-mobile 后重跑；超了砍组件，不上调上限。**

| 项 | 量级 | 结论 / 归属 |
| --- | --- | --- |
| antd 全量 dist | ≈510 KiB gzip | **只能进中后台**（console 不受 H5 首屏预算约束）；A6 需按需引入 / unplugin，禁全量 `import { … } from 'antd'` |
| antd 5 tree-shaking 后 | 按所用组件计（TabBar/NavBar/Card/List/Form/Table…） | A6 落地后实测回填 |
| antd-mobile | 十几 KiB–几十 KiB gzip（按需） | 计入 H5 首屏 200KB 预算 |
| antd-mobile-icons / @ant-design/icons | 个位 KiB | 图标必须真实组件，禁 emoji/方向箭头 |
| `@ant-design/v5-patch-for-react-19` | 极小 | React 19 下 antd 静态方法必需 |
| **design-tokens 本体** | `tokens.css` ≈5.6KB raw / `adm-tokens.css` ≈1.6KB raw（**纯 CSS，不进 JS 预算**） | gzip 后 ≈1–2KB，对首屏 JS 预算**零影响** |

**本包结论**：design-tokens 是纯 CSS + 纯对象，**不占用首屏 JS 预算**。真正吃预算的是 `antd-mobile` 运行时；因此：

1. **C 端按需引入 antd-mobile 组件**，首屏只 import 首页实际用到的（TabBar/NavBar/SearchBar/Card/List/Tag/Button/Segmented/Skeleton/Empty/PullToRefresh/InfiniteScroll）；`Table`/`Form` 等只在详情/二级页用。
2. 分时/K 线**图表库另做选型**（antd 不提供），选型必须先报 gzip 体积，计入同一 200KB 池（归属 A6 + 图表选型 owner）。
3. 引入后由 A6 重跑 `check-budget.mjs` 记录实测值；**阈值 200KB 不可上调**（硬红线 6）。

> 当前 H5 `dist/` 实测基线（2026-11-06，antd/antd-mobile 尚未安装）：
> `合计 273.6 KB raw / 83.7 KB gzip（预算 200 KB）→ PASS，剩余 116.3 KB`。分片 `vendor-react` 67.1 + `index` 14.1 + `vendor` 2.6 KB gzip。
> **结论**：剩余 116.3KB gzip 池即将被 antd-mobile（按需十几–几十 KB）+ 图表库吃掉，余量偏紧。引入后必须由 A6 重跑并记录；**阈值 200KB 不可上调**，超了砍组件。

---

## 4. 签发状态

| 项 | 状态 |
| --- | --- |
| 色板/字号/间距/圆角/阴影/动效 token 数值 | M1 已定（源自 system-v2 §2–§6） |
| AI 标识 / 免责 / as_of 视觉样式 **数值口径** | M1 已定（`aiContent` 分区：≥13px、≥4.5:1、无关闭/折叠/opacity） |
| AI 标识 / 免责 **文案与 C 端放行** | **待 H3 签发**（`rules/ai-content-policy.json` v1.1.2；签认≠C 端放行） |
| 改 `package.json` / 装依赖 | **待 owner 确认**（P1-4） |
| 首屏体积实测 | 待 A6 落地后回填 |

M1 只定视觉数值口径，**不动合规文案**；合规文案与放行一律 H3。
