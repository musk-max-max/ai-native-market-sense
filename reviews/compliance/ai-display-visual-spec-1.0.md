# C 端 AI 展示合规视觉规格 v1.0（免责 / AI 标识 / as_of）

- 文档编号：H3-SPEC-AI-DISPLAY-1.0
- 签发：H3（合规负责人兼 DPO），2026-11-06，状态：**已签（规格层）**
- 适用分区：**c_end 仅**（C 端 H5，390×844 基准，最小宽 375）。internal 分区不适用本规格（按 L130 由 owner 定）。
- 重要边界：**本规格签认 ≠ AI-1/2/3 展示放行**。三张卡仍为「不放行」，见 `reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md`。本规格只定义「一旦放行，视觉必须长什么样、机器怎么验」。
- 上游依据（只读引用，不改写）：
  - `rules/redline-basis.json` v1.0.2（H3 签，内容 sha `f071cbc9…`）：H3-C01..C12
  - `rules/ai-content-policy.json` 1.1.2 c_end 分区（H3 签，内容 sha `aae8032a…`）
  - ADR-006 D7（AI 标识/留痕四条件）、ADR-007 P5/P6（违规输出阻断）
  - `docs/design/system-v2.md` §2.1/§5.2/§5.5/§7（字号下限、Card header as_of、AI Badge 表、评审 checklist）
  - `design/token-integration.md` §7.3/§9（组件层断言、改样式须 H3 签）
  - `docs/design/c-end-h5-v2.md` §3/§4（刷新与 as_of 语义、合规落点表）
  - `design/antd-component-mapping.md` 第 25 条 / §6（免责自研、不得换可关闭组件）

## 0. 不可协商条款（NO-GO 级，任一不满足即不得展示 AI 内容）

| # | 条款 | 机器判据 |
|---|---|---|
| N1 | 免责声明不可关闭、不可折叠、不可隐藏、不得延迟出现 | DOM 中不存在 `data-testid="disclaimer-close"`；`.disclaimer` 无 `[hidden]`、无父级 `display:none`、无 Collapse/Accordion 结构 |
| N2 | AI 标识与生成内容同块，且在内容**上方**可见；每个模型生成内容块都要有（对话页每条 AI 回复都要有） | 含 `ai-generated-badge` 的容器内同时有生成文本；标识节点先于文本节点；对话页回复数 = 标识数 |
| N3 | as_of 与数值同卡、与 API 严格相等（原样 ISO8601，含 `+08:00`）；无有效 as_of 时不渲染数值/标识/免责 | `ai-as-of`/`quote-as-of` 的 `textContent` 与响应 `as_of` 字符串逐字相等；缺失场景断言三类节点均不存在 |
| N4 | H5 合规文字字号 ≥ 13px（`--fs-caption`），不得用 11px 级 tag 弱化 | `getComputedStyle` 的 `font-size` 数值 ≥ 13（见 §6 选择器清单） |
| N5 | `opacity === 1`；无 `aria-hidden="true"` 祖先；对比度 ≥ 4.5:1；无闪烁/渐隐/脉冲/方向性动效 | computed `opacity`/`color`/`font-size` 断言 + 源码扫描无 `animation`/`@keyframes` 命中合规选择器 |
| N6 | 文案只来自服务端 P7 注入（`meta.disclaimer` / `copy`），前端零硬编码 fallback | 源码级：合规组件不 import `copy`；除 `copy.ts` 外无中文字面量（既有 `compliance.test.ts` 已覆盖） |

## 1. AI 生成标识（AiGeneratedBadge）

- 组件：`web/h5/src/components/AiGeneratedBadge.tsx`（硬合规组件；props `label`、`disclaimer` 均必填、无 optional、无 `onClose`/`closable`/`button`）。
- 位置：
  - 个股页 AI 卡（`AiInterpretation`）：卡片 header 之下、五段内容之上；
  - `/ai` 对话页：**每条** AI 回复块内部顶部（不是页面底部放一次）；
  - 不得移入 footer、tooltip、popover、折叠区、需要滚动才出现的区域。
- 结构（不得增删合规节点）：
  `div.ai-generated` → `p.ai-badge[role=note][data-testid=ai-generated-badge]` → `span.ai-badge__mark[aria-hidden=true]`（"AI"）+ `span.ai-badge__text`（label）；紧随 `p.ai-disclaimer[data-testid=ai-disclaimer]`。
- 视觉（M1 可直接落 token / A6 可直接落 CSS）：

| 项 | 规格 | token | 允许/禁止 |
|---|---|---|---|
| mark 尺寸 | 20×20，圆角 5px，字形 ≥10px | `--brand-emphasis` 底（M1 交付前暂用 `--accent`，#0b6357 / 暗色 #7fd6c4） | 禁止 9px 字形、禁止缩到 16px 以下 |
| label 字号 | ≥13px（`--fs-caption`），字重 700 | 颜色 `--text-muted`（#4a5563 / 暗色 #b3bdc9） | 禁止 `--text-subtle`、禁止 ≤11.5px |
| disclaimer 字号 | ≥13px，line-height ≥1.55 | 颜色 `--text`（#14171c / 暗色 #e8edf4） | **当前 10.5px 不合格**（`web/h5/src/styles/app.css:1346`） |
| 强度 | `opacity:1`，无半透明/灰化/模糊；不得 `display:none` 直到交互 | — | 禁止 `filter`、禁止 `animation-delay` |
| 文案 | 服务端 P7 注入；`copy.ai.label` 当前 `AI 生成 · 仅供参考` | — | 前端不得改写、不得截断、不得自造 fallback |

## 2. 免责声明（DisclaimerNotice）

- 组件：`web/h5/src/components/DisclaimerNotice.tsx`（+ `DisclaimerUnavailable` 缺元数据时显式说明缺失，不伪造）。
- 位置：个股页 D 区常驻；`/ai` 页每条回复内（与标识同块）+ 页面级常驻；任何 AI 生成内容所在页面必须有常驻免责，不得 modal-only。
- 结构/testid 保持：`disclaimer` / `disclaimer-text` / `disclaimer-version`；版本号必须可见（`copy.disclaimer.versionLabel` + `TID.disclaimerVersion`）；「不可关闭」说明可见（`copy.disclaimer.notClosable`）。
- 字号：`disclaimer__heading`、`disclaimer__text`、`disclaimer__meta` **全部 ≥13px**（当前 meta 11.5px、`app.css:532` 不合格）。
- 颜色：heading/text `--text`；meta `--text-muted`；背景 `--surface`；边框 `--border-strong`；对比 ≥4.5:1、`opacity:1`。
- 禁止：`Collapse`/`Accordion`/`NoticeBar`（自带关闭×）/ 任何隐藏、折叠、关闭、滚动后加载、sticky 遮挡；文案不得被替换/截断；版本必须来自 API `meta.disclaimer.version`（或 copy 版本轴），不得前端硬编码。

## 3. as_of（时点真实）

- 语义：`as_of` = **数据截止时间（北京时间，UTC+08:00）**，不是请求时间、生成时间、模型作答时间；不得用请求时间伪装实时。
- 展示：
  - `<dt>数据截止（北京时间）</dt><dd><time dateTime={asOf} data-testid=...>{asOf}</time></dd>`；
  - 值**原样**展示 API 返回的 ISO8601 字符串（含 `+08:00`），前端不做时区换算、不格式化成「x 分钟前」、不省略时区；契约暂无 display 字段前不得自造格式化；
  - 字号 ≥13px、颜色 `--text-muted`；位于卡片 header 右侧或数据上下文区，与数值同卡。
- testid：
  - 行情卡 `quote-as-of`（已有）；
  - AI 卡/ `/ai` 页新增 `ai-as-of`：A6 在 `web/h5/src/lib/testids.ts` 注册；A7 在 `tests/e2e/testids.json` 注册，并把 `aiAsOf` 加入 `aiInterpretation` 必含集合。
- 无/无效 as_of：**不渲染数值、`ai-generated-badge`、`ai-disclaimer`**，只渲染受控不可用状态（文案取自既有 `copy`；新增文案须先走 H3 文案签认，不得自造）。
- 刷新：下拉刷新必须更新所有可见卡片 as_of；失败保留旧数据 + as_of 旁「未更新」标记，绝不静默；不得把旧数据标成新时点。
- 时区：跨时区用户仍展示 `+08:00` 与「北京时间」label；不得换算成本地时区后省略时区后缀。

## 4. 复制/导出

- 当前 H5 **无**复制/导出入口（grep `clipboard`/`导出`/`download` 无命中）。因此不得新增只复制数值/只复制正文的复制、分享、导出能力。
- 一旦实现：必须同时携带 `label` + `disclaimer` + `as_of`（文本、图片、分享卡片同规则），并新增 H3 复核位（本规格升 minor 重签）。

## 5. 组件与依赖约束（M1 / A6）

- 免责、AI 标识、as_of 必须走自研组件与设计 token，不得替换为 antd-mobile / antd 的 `Collapse`、`NoticeBar`、`Tooltip`、`Typography.Text type="secondary"` 等会改变透明度/字号/可关闭性的组件（`design/antd-component-mapping.md` 第 25 条）。
- token 映射（M1 交付 `packages/design-tokens/tokens.json` 时落成；当前 `web/h5/src/styles/tokens.css` 是占位 fallback，未定义 `--fs-caption`/`--brand-emphasis`）：

| 语义 token | 值（H5） | 用途 |
|---|---|---|
| `--fs-caption` | 13px | 免责正文/meta、AI label、as_of label+value |
| `--text` | #14171c / 暗色 #e8edf4 | 免责正文、AI disclaimer |
| `--text-muted` | #4a5563 / 暗色 #b3bdc9 | AI label、as_of、免责 meta |
| `--brand-emphasis` | 暂 = `--accent`（#0b6357 / 暗色 #7fd6c4） | AI 标识方块底色 |
| `--accent-contrast` | #ffffff / 暗色 #06201b | AI 标识方块文字 |

- 任何 token/样式变更若降低上述字号、对比度、透明度，须先经 H3 签认（`design/token-integration.md` §9 must_escalate）；不得以「主题兼容」「antd 默认样式」为由放宽。

## 6. 验收条目（可直接抄成测试）

### 6.1 源码级（`web/h5/test/ai-modules.test.ts` 扩展；node:test）

1. `AiGeneratedBadge` 无 `onClose`/`closable`/`button`/`×`；`label`、`disclaimer` 必填；不 import `copy`。
2. `AiTextSlot` 的 `text`/`label`/`disclaimer` 同联合类型；`text===null` 时不渲染任何模型文本。
3. `AiInterpretation` 渲染 `data-testid="ai-as-of"`，且其 `dateTime`/文本与传入 `source.asOf` **严格相等**。
4. 读取 `app.css`，对下列选择器断言 `font-size ≥13px` 且不含 `opacity`/`filter`/`animation` 声明：
   `.ai-badge`、`.ai-disclaimer`、`.disclaimer__heading`、`.disclaimer__text`、`.disclaimer__meta`、`.quote__meta dt`、`.quote__meta dd`、`.ai-context__item dt`、`.ai-context__item dd`。
5. 源码中不存在 `disclaimer-close`。

### 6.2 DOM / E2E（390×844，浅色+深色各跑一遍）

选择器：`[data-testid=ai-generated-badge]`、`[data-testid=ai-disclaimer]`、`[data-testid=disclaimer]`、`[data-testid=disclaimer-text]`、`[data-testid=disclaimer-version]`、`[data-testid=quote-as-of]`、`[data-testid=ai-as-of]`。

- `getComputedStyle(el).fontSize` ≥ 13px；`opacity === '1'`；`el.closest('[aria-hidden="true"]') === null`；`color` ∈ {`--text`, `--text-muted`} 解析值；对比度 ≥4.5:1。
- `document.querySelector('[data-testid=disclaimer-close]') === null`。
- 无 as_of 的 AI 响应：`ai-generated-badge`、`ai-disclaimer`、数值节点均为 null，仅受控不可用状态。
- 对话页：AI 回复条数 === `ai-generated-badge` 数量；每条都带免责。
- 建议接入：`web/h5/scripts/check-dom-compliance.mjs`（A6 扩展现有按钮级检查）+ `tests/e2e/specs/`（A7）。

### 6.3 命令

```bash
pnpm -C web/h5 typecheck
pnpm -C web/h5 test                 # 含 ai-modules / compliance
pnpm -C web/h5 check:compliance
pnpm -C web/h5 check:dom            # 需先起构建产物页面（BASE_URL）
pnpm -C web/h5 check:budget         # 200KB gzip 硬门禁，不得上调
```

## 7. 变更与签认

- 本规格 v1.0 由 H3 签发；任何修改升 minor（v1.1）并 H3 重签，改号/删条一律 major。
- 本规格签认只解决「视觉规格缺失」，不解除 AI-1/2/3 不放行状态，也不构成 C 端 AI 内容展示的放行。
- 与文案签认的关系：文案正文已由 H3 签（backend `ac875c9d…` / frontend `2dfd627b…`），文案签认与机制/视觉门禁是两个对象，不合并。
