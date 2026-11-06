# C 端 AI 展示卡 AI-1/2/3 签发记录（2026-11-06）

- 记录编号：H3-SIGNOFF-AI-CARD-2026-11-06-v1（append-only；一经签发不再改写，变更以新记录追加）
- 签发人：H3（合规负责人兼 DPO）
- 签发时间：2026-11-06（Asia/Shanghai）
- 分区：**c_end 仅**。internal 分区不在本记录范围（按 L130：internal 由 owner 本人签，H3 只出复核意见，不代签）。
- 政策版本：`ai-content-policy/1.1.2`（c_end 分区 H3 签，内容 sha `aae8032a…`）；红线依据 `redline-basis.json` v1.0.2（内容 sha `f071cbc9…`）。
- 关联交付：`reviews/compliance/ai-display-visual-spec-1.0.md`（sha256 `aaebca611172fec689f422dbed83fe2d819633c42b6ae01c2cc14553100c3349`，H3 已签）。
- 关联门禁表：`docs/release/copy-export-scan.md:35-37`（AI-1/2/3 当前均 OPEN）。

## 一、结论摘要

| 卡 | 结论 | 所依红线 | 阻塞主因（缺什么证据） |
|---|---|---|---|
| AI-1 元数据 + 留痕 | **不放行（不签）** | H3-C01/C02/C10 + 红线④ | 无运行时 AI 业务路由与真实响应/留痕样本 |
| AI-2 时点真实 | **不放行（不签）** | H3-C02/C10 + 红线④ | 无 AI 展示路径与 A11/A12 测试对象 |
| AI-3 标识/免责/导出 | **不放行（不签）** | H3-C01/C02 + 红线④ | 无 computed-style/E2E；现有字号不达 13px 下限；无复制/导出能力可验 |

**签了什么**：视觉规格 v1.0（上表关联文档，作为 A6/M1 实现与 A7 验收的唯一依据）。
**没签什么**：AI-1/2/3 展示放行；本记录不构成任何 C 端 AI 生成内容可展示的许可。
**go-live 卡点状态**：保持 **OPEN**，直到下表「闭环判据」全部由对应 owner 提交证据并经 H3 复核签字。

## 二、逐卡裁定与依据

### AI-1（响应元数据 + 服务端生成/展示留痕 ≥3 年）— 不签

- 已具备（不足以放行）：
  - 契约层：`contracts/ai/openapi.yaml:332-357` `AiMeta` required = `[generated, label_version, content_version, model_family, prompt_version, policy_version]`，`generated` 为 `const true`（隐式标识，ADR-006 D7 条件 1）；`AnalysisResult` required 含 `as_of`/`meta`。
  - 留痕实现层：`services/ai/src/postprocess/audit.ts:172` `AI_GENERATION_INSERT_SQL`；`services/ai/src/postprocess/host.ts:181` 注入 audit 时写 `ai_generation_events`；DDL `services/compliance/migrations/003_ai_generation_events.sql` 含 append-only + 哈希链 + ≥3 年保留注释。
- 缺证（为什么不能签）：
  1. `services/ai/src/app.ts:15-16` 明写「不暴露业务路由；业务路由（/ai/analyses、/ai/chat）由后续批次接入」，`services/api/src/domains.ts:14` 只注册 identity/market 两个 domain——**没有 /v1/ai 路由**，「响应真的带 `meta.ai.generated=true`+`content_version`+模型标识」只有契约与单测，没有真实响应证据。
  2. 没有一次真实请求写出的 `audit.ai_generation_events` 行样本（含 `policy_version`/`content_version`/`model_family`/`as_of`/`request_id`），无法验证「生成留痕」；「展示留痕」（用户实际看到的内容 hash 与 analysis_id 关联）实现路径也未见。
- 所依红线：
  - H3-C01/C02/C10：模型输出若无可追溯标识与版本，无法判断是否构成推荐/方向性/预测性表述，也无法在事后复核；
  - 红线④：AI 内容必须带标识 + 不可关闭免责 + as_of（AI-1 是隐式标识的机制底座）。
- 闭环判据（owner：A0/A3/A4）：
  1. `/v1/ai/*` 路由上线并通过契约测试，真实响应 `meta.ai` 六字段齐全、`generated=true`、`content_version`/`model_family`/`policy_version` 非空；
  2. 一次真实请求落 `audit.ai_generation_events` 行（含上述字段与 `as_of`），提供可复核样本（只读查询输出）；
  3. 展示留痕路径明确（哪个字段记录用户可见内容的 hash/analysis_id），给出实现位置；
  4. 以上证据提交后由 H3 复核签字（本卡解除）。

### AI-2（时点真实：无 as_of 时数值/badge/disclaimer 均不渲染）— 不签

- 已具备（不足以放行）：
  - 行情侧 as_of 语义成立：`web/h5/src/components/QuoteBlock.tsx:65-68` 原样展示 `source.asOf`（`quote-as-of`），`web/h5/src/lib/format.ts:8` 注释明确「不做前端时区换算（AC-2 严格相等）」。
- 缺证（为什么不能签）：
  1. **没有 AI 展示路径**：`web/h5/src/App.tsx` 仅 6 条路由（home/watchlist/portfolio/limitLadder/stock/notFound），无 `/ai` 页；`AiInterpretation` 每段 `AiTextSlot content={null}`，页面不渲染任何模型生成文本——A11/A12 要求的「无 as_of 不渲染」测试对象不存在；
  2. AI 卡内 as_of 节点（`AiInterpretation.tsx:124-126`）无 testid（无 `ai-as-of`），无法机器定位，且字号 11/12.5px 不达 13px 下限（`app.css:1244-1252`）；
  3. 无「无效/缺失 as_of」「刷新失败保留旧 as_of」「跨时区」用例证据。
- 所依红线：H3-C02（方向性结论）/H3-C10（未来预测）+ 红线④ as_of；无时点的市场陈述不可证、不可复核。
- 闭环判据（owner：A6 实现 / A11、A12 测试 / A7 E2E）：
  1. `/ai` 页与 `AiInterpretation` 模型文本路径存在（可 mock 响应），每个生成块带 `ai-as-of`；
  2. 无/无效 as_of 用例：断言 `ai-generated-badge`、`ai-disclaimer`、数值节点均不存在，仅受控不可用状态；
  3. as_of 与 API 响应严格相等（含 `+08:00`），刷新失败保留旧数据 + 「未更新」标记；
  4. A11/A12 证据 + A7 E2E 报告提交后 H3 复核。

### AI-3（badge/disclaimer 不可关闭/折叠；复制/导出携带 label+disclaimer；无硬编码 fallback）— 不签

- 已具备（不足以放行）：
  - `AiGeneratedBadge.tsx`：`label`/`disclaimer` 必填、无 `onClose`/`closable`/`button`；`AiTextSlot.tsx`：三者同联合类型，`content===null` 只显示「待接入」；
  - `DisclaimerNotice.tsx`：`disclaimer`/`disclaimer-text`/`disclaimer-version`，无折叠/关闭；
  - `web/h5/test/ai-modules.test.ts` 已有源码级断言（无关闭控件、不 import copy、文案来自服务端）。
- 缺证（为什么不能签）：
  1. **视觉强度不达设计下限**（H5 合规文字 ≥13px）：`.ai-disclaimer` 10.5px（`web/h5/src/styles/app.css:1346`）、`.ai-badge` 11.5px（:1324）、`.disclaimer__meta` 11.5px（:532）、`.quote__meta dt` 11px / `dd` 12.5px（:422/:428）、`.ai-context__item dt` 11px / `dd` 12.5px（:1244/:1249）——按本规格 N4 不合格；
  2. 只有源码级证据，**没有 computed-style/E2E 证据**（字号/opacity/对比/无 aria-hidden 祖先/深色模式）；
  3. 复制/导出能力未实现（H5 无 clipboard/导出入口），「复制/导出携带 label+disclaimer」无法验证；一旦新增而只复制正文即直接违反本卡；
  4. 无 `/ai` 对话页，无法验证「每条 AI 回复都带标识 + 免责」。
- 所依红线：红线④ + H3-C01/C02——标识/免责被弱化（小字、灰化、可关闭）= 用户无法识别 AI 生成内容，等同于无标识。
- 闭环判据（owner：A6 实现 / A7 验收+E2E）：
  1. 视觉规格 v1.0 §6 全部条目在 390×844 浅色+深色通过（font-size ≥13px、opacity=1、无 aria-hidden 祖先、color 允许列表、无 disclaimer-close）；
  2. 复制/导出若存在必须携带 label+disclaimer+as_of；无此能力期间不得提供任何「复制正文」入口；
  3. 对话页每条 AI 回复带标识+免责；
  4. A7 验收 + E2E 报告提交后 H3 复核。

## 三、分区纪律声明（L130）

- 本记录只覆盖 **c_end**。未对 internal 分区的任何 AI 展示/内容做签认，也不引用 owner 的 internal decision（m06899 等）作为 c_end 依据。
- 若后续出现「internal 产物外溢到 C 端/外部」，按 L115/L116 回 H3 重新评估；internal 侧 H3 只出复核意见，不代签。

## 四、给 H1 / A6 的修改要求（已发送，抄送 L0）

1. **A6（web/h5）**：
   - 按 `reviews/compliance/ai-display-visual-spec-1.0.md` §1–§3 修复字号/颜色/强度：`app.css` 上述选择器全部 ≥13px、`opacity:1`、颜色仅 `--text`/`--text-muted`；
   - `AiInterpretation` 的 as_of 加 `data-testid="ai-as-of"`（`web/h5/src/lib/testids.ts` 注册），值原样等于 `source.asOf`；
   - `/ai` 页与对话回复按规格逐条落 badge+disclaimer+as_of；不得新增只复制正文的入口；
   - 补源码级断言（`web/h5/test/ai-modules.test.ts`）与 DOM 断言（`web/h5/scripts/check-dom-compliance.mjs` 扩展）。
2. **H1（PM/PO）**：
   - 把本规格设为 task-3/task-9 的验收依据（视觉规格 v1.0），AI-1/2/3 保持 go-live OPEN，不得以「文案已签」表述为已放行；
   - PRD v2 的 go-live 卡点清单中，AI-1/2/3 责任人写 A0/A3/A4、A7/A11/A12、A6/A7，H3 只做复核签字；
   - A7 的 E2E 范围加：`ai-as-of`、无 as_of 不渲染、每条对话回复带标识+免责、深色模式复跑。
3. **A7（QA）**：`tests/e2e/testids.json` 注册 `aiAsOf` 并加入 `aiInterpretation` 必含集合（与 A6 同步）。

## 五、不变项（避免误读）

- 文案侧签认保持有效：backend `2026.11.5.ac875c9d9237.backend.json`、frontend `2026.11.5.2dfd627b35c1.frontend.json`（H3 m02810/m02823），文案签认 ≠ AI 展示放行。
- AI-4（「免责即定性」措辞、`非投资建议` 不豁免 40 号文）维持 DONE，不因本记录回退。
- 政策 1.1.2 两分区签认与生产门禁放行只解决规则加载；AI 内容展示仍需本记录三卡闭环。
