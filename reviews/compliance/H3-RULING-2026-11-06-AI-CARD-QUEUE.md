# H3 裁定书：C 端 AI 卡待裁队列（2026-11-06）

- 文档编号：H3-RULING-AI-CARD-QUEUE-2026-11-06-v1
- 签发：H3（合规负责人兼 DPO），2026-11-06（Asia/Shanghai）
- 分区：**c_end 仅**（internal 分区事项不适用，按 L130 owner 签）
- 依据（只读引用）：`reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md`、`reviews/compliance/ai-display-visual-spec-1.0.md`（H3-SPEC-AI-DISPLAY-1.0）、`rules/ai-content-policy.json` 1.1.2、`rules/redline-basis.json` v1.0.2、`docs/design/system-v2.md` §1/§2.1/§5.5、`security/findings/RT-AICARD-REDTEAM-2026-11-06.md`、`docs/design/ai-display-visual-acceptance-2026-11-06.md`（M1）、`tests/data/acceptance/artifacts/ai1-evidence-2026-11-06.md`（A3）、`tests/data/acceptance/artifacts/ai23-evidence-2026-11-06.md`（A7）
- 效力：本裁定为 H3 书面裁定，自签发时生效；判据从严不放宽；不构成 AI-1/2/3 放行（三卡维持 OPEN）。

---

## 裁一（队列①）：`ai-badge-bg` token 冲突 —— 采用青绿 #0b6357，禁用东财红 #e63e31

**裁定：AI 标识方块底色 = `#0b6357`（暗色 `#7fd6c4`），即 `--accent` 系（= 已签规格 §5 表「`--brand-emphasis` 暂 = `--accent`」口径转正）。不采用 `#0f5fd6`。`#e63e31` 东财红自本裁定起禁止用于任何 AI 标识/中性语义用途。**

理由：

1. `packages/design-tokens/tokens.json:116-119` `semantic.brand-emphasis` = `{primitive.red-600}`（#e63e31），role 自述「东财红，品牌强调位（首页顶部指数涨/TabBar 激活点）**+ AI 方标底**」——红底 AI 方标与「涨」语义同色（`docs/design/system-v2.md:27-32` 红涨绿跌、`--up-strong` = #e63e31），违反 system-v2 §1「不出现诱导性视觉暗示」与 §2.1「颜色只承载涨/跌/中性/危险四种语义」，触碰红线②荐股语义污染（红=涨暗示）。M1 提案方向正确。
2. 已签规格 §5 表明文 AI 标识方块底 = `--brand-emphasis`（暂 = `--accent`，#0b6357 / 暗色 #7fd6c4）；采用 #0b6357 与已签规格一致，**无需规格升版重签**。采用 `#0f5fd6`（brand-strong 蓝）与已签规格冲突、需升 v1.1 重签且无合规必要，**不采**。
3. 对比度实算（本裁定附验）：白字压 #0b6357 = **7.15:1**（≥3:1 ✓）；暗色 #7fd6c4 底 + `--accent-contrast` #06201b 字 = **10.01:1** ✓；（对照：白字压红 #e63e31 仅 4.12:1，且语义违规，双重不取。）

实施口径（owner 分工）：

- **M1**（`packages/design-tokens/tokens.json` 写域）：`aiContent.ai-badge-bg` 改指 accent 系（`{semantic.accent…}` 或独立字面值 #0b6357/#7fd6c4）；`semantic.brand-emphasis.role` 删除「+ AI 方标底」职责，注明「东财红限涨/强调语义，禁 AI 标识」；改后跑 `node src/build.mjs` 留证（对比度+黑名单）。
- **A6**（web 写域）：`web/h5/src/styles/tokens.css:47` `--brand-emphasis: var(--accent)` 即本裁定合规值（暂用值转正），`.ai-badge__mark` 现状已合规，无需改；待 `@market-sense/design-tokens` 产物切换（S1）后核对派生值同为青绿。
- 东财红 #e63e31 保留用途：首页顶部指数涨、TabBar 激活点、审计行左边条等强调位（不得出现在 AI 标识、缺口、中性状态）。

## 裁二（队列②）：N4「合规文字」口径澄清 —— 按语义口径，4 观察项均不豁免（并构成规格 v1.1 修订，H3 重签）

**裁定：N4 按语义口径解释。凡承载以下五类语义的用户可见文字，一律 ≥13px（`--fs-caption`），不得以 11px 级 tag 弱化：①免责/不可关闭说明；②AI 生成标识；③as_of/时点真实性（含「未更新」标记）；④数据来源与口径；⑤AI 内容缺失/不可用状态说明。**

4 观察项逐一定性（**全部纳入，无一豁免**）：

| 选择器 | 承载语义（实证） | 定性 |
|---|---|---|
| `.ai-slot--pending`（`AiTextSlot.tsx:27` → `copy.ai.pendingText`） | ⑤ AI 缺失状态 | 纳入，≥13px |
| `.ai-section__footnote`（`AiInterpretation.tsx:189` → `copy.gap.footnote`） | ④ 数据缺口口径 | 纳入，≥13px |
| `.ai-section__meta`（`AiInterpretation.tsx:190` → `copy.ai.notGeneratedNote`） | ⑤ AI 未生成说明 | 纳入，≥13px；且颜色 `--text-subtle` 违 §6.2 允许列表，改 `--text-muted` |
| `.quote__stale`（`QuoteBlock.tsx:91`「未更新」role=status） | ③ 刷新失败时点真实性标记 | 纳入，≥13px |

边界（防口径无限扩张）：导航、操作按钮、列表装饰性次要元信息等**不承载上述五类语义**的文字不入 N4，维持现状。`.ai-slot--pending` 另有 `color: var(--text-subtle)`（app.css:1389），同 §6.2 允许列表违例，一并改 `--text-muted`。

**规格版本**：依规格 §7（修改升 minor、H3 重签），本裁二构成 **H3-SPEC-AI-DISPLAY v1.0 → v1.1（minor）** 修订：(a) N4 条目增补语义释义（上列五类+边界）；(b) §6.1.4 断言清单增补 `.ai-slot--pending`、`.ai-section__footnote`、`.ai-section__meta`、`.quote__stale` 四选择器；(c) 依 RT-07 增补 `.ai-badge__mark`（字形 ≥10px 专则，规格 §1）入断言清单。v1.0 原文不改写，v1.1 以本裁定文书为修订载体合并解读，H3 签认（本签）。修复 owner=A6，复测 owner=A7（E2E 逐选择器过 §6.2）。

## 裁三（队列④）：RT-08 —— 原生复制/截屏/流式边界裁定

背景（RT-AICARD-08）：AI3-2「复制导出须带 label+disclaimer+as_of」未界定原生选择复制/系统分享/截屏/打印是否在范围；流式生成中间态 badge/disclaimer 起渲染时点未定义。依 A16 禁自裁升级 H3。A16 暂行从严口径（原生复制在内/截屏不在内/首 token 起标识）方向保留，补充实现口径与降级规则如下。

**裁三-A 复制/分享/导出三分法：**

1. **产品提供的复制/分享/导出**（含产品注入的长按菜单项、分享卡片、图片/打印样式生成）：**在范围内**，必须携带 `label` + `disclaimer` + `as_of` 三件套（文本/图片/卡片同规则）。E2E-AI3-2A/B 反向断言保持**常绿断言**：任何新增入口自动转硬红，直到三件套用例转绿。
2. **原生文本选择复制**（用户选择 + 系统复制）：**在范围内**。理由：AI 内容外带传播是荐股违规（H3-C01/C02）主通道，copy 事件是产品可干预面。实现口径二选一，A6 择一并留证，E2E 以剪贴板内容含三件套为验收：
   - (a) 首选：`copy` 事件对 AI 生成文本统一在剪贴板文本尾部追加三件套（不禁用选择、不阻断复制）；
   - (b) 替代：AI 生成正文 `user-select: none`（仅限 AI 生成正文节点，不得整页生效，不得影响无障碍朗读）。
3. **系统截屏/打印/系统分享面板/无障碍朗读**：**不列入放行判据**（H5 技术不可控，不虚设控制、不设不可验证判据）。但：产品不得以生成图片/卡片/打印样式的方式导出 AI 内容而不带三件套（那归第 1 类）。

**裁三-B 流式生成中间态：**

1. badge + disclaimer 必须**先于或伴随首个可见模型生成字符**渲染（首帧在场、同块顶部）；任何中间态可见模型文本都在标识+免责之下。
2. 流式完成前**不渲染数值节点**（防半截数字、防 as_of 与内容错配）；`ai-as-of` 在首帧即渲染（其值 = `source.asOf`，生成前已知，原样展示）。
3. 实现无法保证首帧在场时，**降级口径 = 关闭流式展示**，改为完整生成后一次性渲染（fail-safe）；不得以「技术限制」接受中间态裸奔。
4. 无有效 as_of → 整块不渲染模型文本（受控不可用状态），流式与否同规则。

**验证（A7 增补用例清单）**：流式首 token 前 badge/disclaimer 已存在；中间态数值节点不存在；选 (a) 则剪贴板内容含三件套，选 (b) 则 AI 正文 user-select=none 且选择复制得三件套或不可得；新增入口三件套用例。裁定前 A16 从严暂行口径记录在案有效，本裁定为其正式替代。

## 附一（队列⑤）：签发前置消解项（P-1..P-3）+ 判据收紧 —— AI-1/2/3 签发均以此为准

**三卡共同签发前置（must 全部消解后才进入 H3 签字流程）：**

| # | 前置（来源） | 消解口径 |
|---|---|---|
| P-1 | **RT-01 证据锚定**：证据与代码基线解耦 | 每份证据收件登记强制三锚：①commit sha ②CI run id/日志哈希（或 lead 书面接受的等价锚）③证据文件自身 sha256；tracker 建哈希锚清单文件（RT-10）。**现状不满足**：A3/A7 证据均无锚；工作树脏（HEAD=01e079e 与证据所测状态不一致）；A3 证据脚本「已删不入 CI」不可复现 |
| P-2 | **RT-02 单样本不证覆盖** | AI-1 增补：抽样区间 requests↔events **1:1 对账断言** + 全量 **prev_hash 链复算**脚本输出 + 样本由 **CI 实跑**产生（run id 绑定）；证据生成脚本入库进 CI。**现状不满足** |
| P-3 | **RT-03 provider 来源证明**：FakeProvider 默认 | 「真实响应」须证明 provider 非 FakeProvider（配置/来源证明），或显式声明 fake 模式且该样本**不计入**「真实响应」判据；验收识别 FakeProvider 样本并拒收。**现状不满足**：ai1-evidence 两样本 `model_family="fake-v1"` |

**判据收紧（并入对应卡验收口径，依 RT 结论补漏）：**

- **AI-1**（RT-04）：AI1-3 的 hash/analysis_id「或」→「**且**」：`output_hash` 输入须为 canonical 文本序列化，配**渲染文本逐字比对用例**（HTML 转义/空白差异样本必须能分辨）；analysis_id 关联并列保留。
- **AI-2**（RT-05/06）：增补 as_of 与**数据所属期**（dataset coverage window）一致性对账断言（早于/晚于所属期样本必须失败）；增补「模型文本内嵌数字未带 as_of 上下文」用例；定义受控不可用状态机（入口/文案/恢复条件，文案取自既有 `copy`）。
- **AI-3**（RT-07）：E2E 增补「无 transform/zoom/filter 祖先干预」断言；`.ai-badge__mark` 入断言清单（≥10px）；缺证清单补颜色违例（`.ai-section__meta`、`.ai-slot--pending` 的 `--text-subtle`，见裁二）。

## 附二：证据复核结论（2026-11-06 到件三份）

### E-AI1-01（A3，`tests/data/acceptance/artifacts/ai1-evidence-2026-11-06.md`）—— 收件，**AI-1 仍不签**

- 实质进展：`/v1/ai/analyses` POST+GET 路由实现并接线 `aiPlugin`（domains.ts:17，待 H2 复核）；`data.ai` 六字段实现（analyses.ts:505-510）+ `as_of` 必填；审计两样本（passed+blocked）24 列字段齐全（HMAC user_id、触发器算 prev_hash/hash）；展示留痕路径明确（`output_hash`=用户可见 claim canonical sha256，host.ts:222-231；`analysis_id` 同源绑定 host.ts:235）；services/ai typecheck EXIT 0 + 42/42 测试绿。命名澄清（六字段落 `data.ai`、`meta` 为 ResponseMeta）**按契约真源成立**，tracker 口径同步。
- **不签理由**：P-1/P-2/P-3 三项前置均未消解（见附一「现状」）；RT-04「且」口径未满足（无渲染文本逐字比对用例）。即：AI1-1 实现侧达标待 P-3；AI1-2 样本字段齐全待 P-1/P-2；AI1-3 路径明确待 RT-04 收紧项。
- 归 lead 事项（非 AI-1 判据）：仓库级 `node infra/ci/typecheck.mjs` EXIT 1 归因他席（`services/identity/.../identity-service.ts` `recordApprovalDenied` +109 行、未跟踪 `services/approval/`）；A3 请求裁决「services/ai 单独门禁 vs 等他席修复」。契约测试 1 failed 为既有失败（akshare venv）已核非本席。

### E-AI2-02（A7，`tests/data/acceptance/artifacts/ai23-evidence-2026-11-06.md`）—— 收件，**AI-2 仍不签**

- 证据质量合格：双目标分栏（L135.1）逐断言标注、GAP 不空转绿、2B 作用域修正有判定记录（判据一条未放宽）。
- 现状：AI2-1 stock 路径绿（`ai-as-of` 注册 + 值原样严格相等），生成块域被 **R1** 阻塞（AiTextSlot 恒 null、页面不发 /v1/ai/* 请求）；AI2-2 = 1 绿 2 红 3 BLOCKED：**R2**（`apiGateway.ts:261` 对 undefined `.trim()` TypeError → 页面悬挂 15s，`StockPage.tsx:42` 无 catch）、**R3**（非法 as_of='not-a-date' 时 11 处数值照渲、ai-as-of 原样显 'not-a-date'——fail-closed 缺口，违 N3/红线④，**红线级，A6 优先修**）；AI2-3（刷新保留+「未更新」）未覆盖（PullToRefresh 未接入）。
- 不签理由：AI2-1 生成块域、AI2-2 红项 R2/R3、AI2-3 未实现 + 附一收紧项（RT-05/06）未补。

### E-AI3-01（A7，同上）—— 收件，**AI-3 仍不签**

- AI3-1：24 节点 × 浅/深 390×844 全条目绿（A6 字号/颜色修复已被 E2E 复证：九选择器 ≥13px、`.disclaimer__meta`→`--text-muted`），但 **4 GAP**（badge/disclaimer 四选择器因 R1 未渲染，待生成块接线后补测）+ 裁二新增 4 观察项选择器 + RT-07 祖先断言/`.ai-badge__mark` 待补。
- AI3-2：反向证据绿（affordance 扫描 + clipboard spy 零写入），转常绿断言（裁三-A 第 1 类）；原生复制口径（裁三-A 第 2 类）用例待 A6 选实现口径后补。
- AI3-3（对话页每条回复标识+免责）：`/ai` 页为骨架（无模型文本），无页可验，维持缺证。

## 附三：tracker 勘误（队列③）—— 已回填至 `AI-CARD-CLOSURE-TRACKER-2026-11-06.md` 勘误段（append-only）

- 「App.tsx 无 /ai」过时更正：`web/h5/src/App.tsx:48-49` 已有 `route.name==='ai'` → `AiHomePage`（8 route name）；但 AiHomePage 为骨架页（DataGapCard+占位、无模型文本、不发 /v1/ai/*），AI2-1 判据实质仍不满足（与 RT-09 结论一致）。
- 行号漂移回填 + 引用规则：**一律用符号锚（选择器/组件/函数名）为主锚，行号仅作辅助并带观测时间**（2026-11-06 18:40 观测值见 tracker 勘误段表）。
- 数值断言更新：七选择器主清单字号已由 A6 修复为 `var(--fs-caption)`=13px（web/h5/src/styles/tokens.css:45 已定义），M1 报告 §1 的 10.5/11.5/11/12.5px 为修复前快照，缺证行按「已修复待 E2E 终验（4 GAP）」更新；`.ai-badge__mark` 9px→10px 已达规格 §1 下限。

---

**不变项**：AI-1/2/3 维持 OPEN（均不签），go-live 卡点保持 OPEN；文案签认、AI-4 DONE、政策 1.1.2 双分区签认均不受本裁定影响；本裁定不放宽任何已签判据。—— H3，2026-11-06
