# C 端 AI 展示卡视觉验收报告（对照 H3-SPEC-AI-DISPLAY-1.0）

- 验收人：M1（UI/UX，MiMo 多模态）｜日期：2026-11-06
- 依据：`reviews/compliance/ai-display-visual-spec-1.0.md`（视觉规格 v1.0，H3 已签规格层）
- 对象：`web/h5` 现状（源码 + `docs/screenshots/local-2026-11-06/` 截图，2026-11-06 14:01 采集）
- 边界声明：**本验收只判「视觉规格符合性」，不构成 AI-1/2/3 放行**（三卡仍不放行，签认≠放行，见 `reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md`）。

## 0. 总体结论：**不通过（有差距）**

- 规格 N4（H5 合规文字 ≥13px）**不满足**：五处（7 个选择器）低于 13px 下限，最小 10.5px。
- 另有 4 类差距：AI 标识方块字形 9px（规格 §1 禁止）、3 处颜色取值与规格不符、`ai-as-of` testid 未注册、token 真值与规格 §5 表的 `--brand-emphasis` 暂用值冲突（待 H3/M1 对齐）。
- 结构/机制项（N1/N2/N5/N6）源码级核对**通过**；as_of 原样展示（N3 值部分）截图证实通过。
- 与 H3 结论一致：现有证据只有源码级，**无 computed-style / E2E 证据**（规格 §6.2），此项归 A6/A7 补，不在本次验收可闭环范围。

## 1. 五处 <13px 字号（N4 不满足，差距主清单）

> 行号为当前 `web/h5/src/styles/app.css` 实测行（H3 closure tracker 里的 :1346/:1324/:532/:422/:428/:1244/:1249 已因 CSS 增长漂移，请 H3 按本表回填 tracker）。

| # | 选择器 | 当前值（行号） | 规格要求 | 判定 |
|---|---|---|---|---|
| 1 | `.ai-badge`（AI 标识 label） | 11.5px（app.css:1407） | ≥13px（`--fs-caption`），字重 700 | ❌ |
| 2 | `.ai-disclaimer`（AI 卡内免责） | 10.5px（app.css:1426） | ≥13px，line-height ≥1.55（现 1.55 ✅） | ❌ |
| 3 | `.disclaimer__meta`（免责版本/不可关闭行） | 11.5px（app.css:612） | ≥13px | ❌ |
| 4 | `.quote__meta dt` / `dd`（行情卡含 as_of 行） | 11px（app.css:501）/ 12.5px（app.css:507） | ≥13px | ❌ |
| 5 | `.ai-context__item dt` / `dd`（AI 卡行情上下文，含 as_of `<time>`） | 11px（app.css:1323）/ 12.5px（app.css:1328） | ≥13px | ❌ |

合格参照：`.disclaimer__heading`（app.css:596，13px ✅）、`.disclaimer__text`（app.css:604，13px ✅）、`.ai-slot__text`（app.css:1432，13px ✅）。

**修复口径**：以上 7 个选择器全部落 `--fs-caption: 13px`（`packages/design-tokens/dist/tokens.css:52` 的 `--ms-font-caption` / 旧名别名）。规格 §1/§5 明文「M1 可直接落 token、A6 可直接落 CSS」，且修复是**提升**字号/对比，不触发 §7 降级重签；改完由 A6 跑规格 §6.3 命令留证。

## 2. AI 标识区（AiGeneratedBadge）

| 核对项 | 现状 | 判定 |
|---|---|---|
| 结构（`div.ai-generated` → `p.ai-badge[role=note][data-testid=ai-generated-badge]` → mark+text，紧随 `p.ai-disclaimer`） | `AiGeneratedBadge.tsx:22-29` 与规格逐字一致 | ✅ |
| 契约（label/disclaimer 必填、无 onClose/closable/button） | props 全必填、无关闭路径；不 import `copy`（仅 `TID`） | ✅ |
| 位置（卡片 header 之下、内容之上；badge 先于文本节点） | `AiTextSlot.tsx` badge 块先于 `p.ai-slot__text` | ✅ |
| mark 尺寸 20×20、圆角 5px | app.css:1413-1416 ✅ | ✅ |
| **mark 字形 ≥10px（禁止 9px）** | 9px（app.css:1419） | ❌ 规格 §1 明文禁止 |
| label 字色 `--text-muted` | 现 `--accent`（app.css:1406） | ❌ 偏差 |
| disclaimer 字色 `--text` | 现 `--text-muted`（app.css:1425） | ❌ 偏差 |
| opacity=1 / 无 filter / 无 animation | `.ai-badge`、`.ai-disclaimer` 块内无此类声明 | ✅ |

注：当前 AI 文本位一律传 `null`（`AiInterpretation.tsx:71`），页面只显示「AI 解读待接入」占位，**标识区未实际渲染**——上表为组件与 CSS 的静态验收。`/ai` 对话页未建（P1-5），「每条回复一个标识」待页面落地时按 §1 验收。

## 3. 免责区（DisclaimerNotice）

| 核对项 | 现状 | 判定 |
|---|---|---|
| 常驻、不可关闭/折叠/隐藏；无 `disclaimer-close` | `check-testids.mjs` 强制 NOT_RENDERED；源码零命中 | ✅ |
| testid 齐全（`disclaimer`/`disclaimer-text`/`disclaimer-version`） | `DisclaimerNotice.tsx:17/24/29` | ✅ |
| 「不可关闭」说明 + 版本号可见 | `copy.disclaimer.notClosable`/`versionLabel`，截图见「版本 2026.11.1 · 不可关闭」 | ✅ |
| heading/text 字号 ≥13px、字色 `--text` | 13px/13px ✅ | ✅ |
| meta 字号 ≥13px、字色 `--text-muted` | 11.5px、`--text-subtle`（app.css:611-612） | ❌ 字号+颜色双偏差 |
| 背景 `--surface`、边框 `--border-strong`、opacity:1 | app.css:585-592 ✅ | ✅ |
| 覆盖面 | DisclaimerNotice 仅挂 `StockPage.tsx:175-177`；AI 文本所在页目前只有个股页，够用；`/ai` 页落地时须补「每条回复内 + 页面级常驻」（规格 §2） | ✅（前瞻提醒） |

## 4. as_of 展示位（N3）

| 核对项 | 现状 | 判定 |
|---|---|---|
| 值原样展示 API ISO8601（含 `+08:00`），无格式化 | 截图：`数据截止（北京时间）2026-11-06T14:00:47+08:00`；`AiInterpretation.tsx:126` 与 `QuoteBlock.tsx:67` 均 `{source.asOf}` 原样 | ✅ |
| label「数据截止（北京时间）」 | `copy.quote.asOfLabel` | ✅ |
| 与数值同卡（header 右侧或数据上下文区） | 行情卡 `quote__meta` + AI 卡 `ai-context` 行情上下文，同卡 | ✅ |
| `quote-as-of` testid | `QuoteBlock.tsx:67` + `testids.ts:23` | ✅ |
| **`ai-as-of` testid** | `AiInterpretation.tsx:126` 的 `<time>` 无 `data-testid`；`web/h5/src/lib/testids.ts` 未注册 `aiAsOf` | ❌ 规格 §3 要求（A6 注册 testids.ts、A7 注册 tests/e2e/testids.json + aiInterpretation 必含集合） |
| as_of 字色 `--text-muted` | `.ai-context__item dd`/`.quote__meta dd` 未设色（继承 `--text`） | ❌ 偏差（轻） |
| 无有效 as_of 不渲染数值/标识/免责 | `quote && source ?` 守卫 `ai-context`（AiInterpretation.tsx:111）；badge 随内容 null 不渲染 | ✅ |
| 刷新更新 as_of /「未更新」标记 | `PullToRefresh` 未接入（P1 范围）；`.quote__stale` 已有样式但 12px < 13px（app.css:522，观察项） | ⏳ 待下拉刷新落地 |

## 5. 其余机器判据（N1/N2/N5/N6）

- **N1** ✅：DOM 无 `disclaimer-close`；`.disclaimer` 无 `[hidden]`/折叠结构。
- **N2** ✅（组件级）：badge 与生成文本同容器且标识在前；对话页规则待 `/ai` 落地。
- **N5** ✅（源码级）：合规选择器无 `opacity`/`filter`/`animation`；`app.css` 中 opacity 仅出现在 `.watchlist__toggle:disabled`、`.entitlement__meta`、`.error-banner__code`（0.95），animation 仅 skeleton shimmer（非合规区）。深浅色 computed-style 实测**未验证**（需 E2E，原因见 §7）。
- **N6** ✅：`AiGeneratedBadge` 不 import `copy`；DisclaimerNotice 仅用 `copy` 的 `versionLabel`/`notClosable` 静态标签（规格 §2 明文允许），正文来自 API；「除 copy.ts 外无中文字面量」由既有 `compliance.test.ts` 覆盖。

## 6. 附加发现（规格外/上游不一致，需对齐）

1. **token 值冲突（须 H3/M1 对齐后再落 CSS）**：规格 §5 表写 `--brand-emphasis` 暂 = `--accent`（#0b6357 青绿）作 AI 标识方块底；但 `packages/design-tokens/tokens.json` 的 `ai-badge-bg` 指向 `brand-emphasis` = **#e63e31（东财红）**（`dist/tokens.css:92`）。红底 AI 标与「涨」色语义冲突（system-v2 涨跌色独立原则）。建议：AI 标识底改指 `--ms-accent`/`--ms-brand-strong` 系青绿（#0b6357/#0f5fd6），东财红保留给审计行左边条等 emphasis 用途；此为 token 值级变更，M1 提案、请 H3 过目后 M1 改 `tokens.json`（在写域内）。
2. **`web/h5/src/styles/tokens.css` 仍是占位**（82 行 fallback），未含 `--fs-caption`/`--brand-emphasis`（规格 §5 已预告）；S1 切换到 `@market-sense/design-tokens` 产物后自动补齐（`tokens.css` 文件属 A6 写域，M1 不动）。
3. **观察项（建议一并修或请 H3 澄清 N4「合规文字」口径）**：`.ai-slot--pending` 11.5px（app.css:1390）、`.ai-section__footnote` 11.5px（app.css:1439）、`.ai-section__meta` 11px（app.css:1446）、`.quote__stale` 12px（app.css:522）——均承载数据口径/免责语义文字，若 N4 按语义解释也在 13px 下限内；按 §6.1 字母解释则不在断言清单。
4. H3 closure tracker（`AI-CARD-CLOSURE-TRACKER-2026-11-06.md` AI3-1）与 SIGNOFF 的 app.css 行号已漂移，建议按 §1 表回填（tracker 归 H3 写域，M1 不代改）。

## 7. 验证命令与结果（本次实跑）

```bash
pnpm -C web/h5 test            # 25 pass / 0 fail（含 ai-modules、compliance）
pnpm -C web/h5 check:compliance# 10 pass / 0 fail
pnpm -C web/h5 typecheck       # 0 错
pnpm -C web/h5 check:testids   # PASS，59 id 对齐
pnpm -C web/h5 check:budget    # 83.7 KB gzip / 200 KB PASS（与 antd 清单共享基线）
cd packages/design-tokens && node src/build.mjs   # 对比度 46/46 pass，黑名单 12 组 mismatch=0
```

**未验证（原因）**：规格 §6.2 的 computed-style / E2E（390×844 浅+深）需要起 Web@3000；本轮真栈 PostgreSQL@55432 / API@8081 / Web@3000 均未运行（curl 连接拒绝），按席位纪律不擅起共享环境，改用当日 `docs/screenshots/local-2026-11-06/` 截图（home/stock-000001/stock-600519/watchlist）+ 源码级核对完成本报告。截图证实：as_of 原样 ISO8601 展示、免责常驻含「版本 2026.11.1 · 不可关闭」、AI 卡五段+占位语义正确、无任何诱导性视觉。computed-style 证据由 A6/A7 在修复字号后补（本报告 §1 修复口径）。

## 8. 差距修复归属（下一步）

| 差距 | 归属 | 动作 |
|---|---|---|
| 7 选择器字号 ≥13px、mark 字形 ≥10px、3 处字色、ai-as-of testid | A6（H5 前端） | 按规格 §1–§3 直接落 CSS + `testids.ts` 注册；A7 同步 `tests/e2e/testids.json` |
| computed-style / E2E 证据（浅+深） | A6/A7 | 规格 §6.2 清单 + `check-dom-compliance.mjs` 扩展 |
| token 值冲突（ai-badge-bg 红 vs 青绿） | M1 提案 → H3 过目 → M1 改 tokens.json | 见 §6.1 |
| tracker 行号回填 | H3 | 见 §6.4 |
