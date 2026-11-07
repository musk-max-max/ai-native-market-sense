# RT-AICARD 红队抽核记录（AI 卡签认与闭环判据 · 对抗式抽查）

- 席位：A11（宏观研究+合规复核红队，含旧 A16/A19）；抽核人：a11-research-macro-audit
- as_of：2026-11-06 17:40 +08:00；代码基线：HEAD=01e079e（"chore(rebuild): 17席编制重建台账+5tab/Console骨架/AI卡签认记录；门禁全绿"，2026-11-06 17:04:33 +0800）
- 抽核对象：
  - reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md（H3-SIGNOFF-AI-CARD-2026-11-06-v1，签发 2026-11-06T15:26+08:00）
  - reviews/compliance/AI-CARD-CLOSURE-TRACKER-2026-11-06.md（H3-TRACKER-AI-CARD-2026-11-06-v1）
- 方法：对抗式抽查——逐条判据构造"合规但无效"的绕过路径、核对引用与代码实况、审查缺证清单是否低估；辅以文件哈希/源码实证。
- **性质：抽核记录，不构成放行、不构成终审。** 依 A16 规则我无终审权、不自写自证；标注「⚠H3待裁」的条目为边界案例，**禁止自行裁定，必须升级 H3**。依 A19 规则高危发现不对外公开，先私下升级 H5 与 A9。
- 判定图例：🟢 有效控制（对抗后未被打穿）｜🟡 判据可绕过/缺证低估｜🔴 判据失效或证据可伪造｜⚠H3待裁。

---

## 0. 经对抗验证的有效控制（正面清单）

| # | 控制 | 实证 | 判定 |
|---|---|---|---|
| G1 | 政策加载 fail-closed | packages/ai-policy/src/policy.ts parseAiContentPolicy：生产未签拒载；sourceSha256 与 AI_CONTENT_POLICY_EXPECTED_SHA256 部署 pin | 🟢 |
| G2 | 签认-红线双哈希互绑 | packages/ai-policy/src/redline.ts parseRedlineBasis 强制 `redline.policy_signed_content_sha256 === policy.authority.h3_policy_version_signature.content_sha256_at_signoff`，不匹配 fail policy_sha_mismatch；signed=true 时 content_sha256_at_signoff/sign_at 缺失 fail signature_incomplete | 🟢 |
| G3 | 签发记录本体锚定 | AI-CARD-SIGNOFF-2026-11-06.hash.json 锚定 signoff（b114f42baa4085887c691cc7adb33ef4e67661bcebf741795715587da3ced7b6）+ visual spec（aaebca61…349）两文件 sha256；视觉规格现文件哈希与签发记录一致✓ | 🟢 |
| G4 | 审计表防篡改设计 | services/compliance/migrations/003_ai_generation_events.sql：append-only、独立哈希链（prev_hash NOT NULL + CHECK 64hex）、硬拦 DELETE、保留≥3年（:11）、event_key/prev_hash/hash 由 BEFORE INSERT 触发器权威计算并覆盖应用传入值（:26）、"每请求一条"（:45）；services/ai/src/postprocess/audit.ts:172 `AI_GENERATION_INSERT_SQL`、host.ts 注入 audit（options.audit，:148） | 🟢（设计），但见 RT-02/RT-03 的证据要求缺口 |
| G5 | 签后变更仅限 internal 分区 | rules/ai-content-policy.json（7f795503→7fead8cd，diff 仅 status pending→signed + signed_at 2026-11-06T03:59:17Z）、rules/redline-basis.json（f071cbc9→cfe50982，diff 仅 signed 翻转 + sign_at 2026-11-06T03:34:19Z）；c_end 内容未变。签前快照归档 rules/archive/…/aae8032a….json 与 …/f071cbc9….json（文件名=自身 sha256，已验算✓） | 🟢 |
| G6 | 前端无自造标识/无复制入口 | web/h5/test/ai-modules.test.ts 7 个 test：断言无 onClose/closable/button、"AI 标识文案由服务端 P7 注入，前端不 import copy 自造"；web/h5/src 无 clipboard/navigator.share/export 入口✓ | 🟢 |
| G7 | 分区纪律 | 签发记录分区 c_end 仅（L130）；docs/release/copy-export-scan.md:35-37 AI-1/2/3 均 OPEN、AI-4 DONE 与签发一致✓ | 🟢 |

---

## 1. 抽核发现（RT-AICARD-01 … 11）

### RT-AICARD-01 🔴 证据与代码基线解耦：判据未绑定 commit sha / CI 运行

- 复现：签发记录与 tracker 只写"代码基线=当次提交"，未钉 commit sha（01e079e）；E-AI1-01 等证据文件（tests/data/acceptance/artifacts/）可被任意后续提交替换，无 CI 运行号/日志锚定。
- 影响面：全部 12 条闭环判据的证据都可以"事后改文件+补哈希"方式凑数；tracker 的 append-only 状态流水约束的是 tracker 文档，不约束证据文件本体。
- 风险等级：**高**。
- 建议修复：每份证据收件登记强制记录 ①commit sha ②CI run id/日志哈希 ③证据文件自身 sha256；tracker 增加哈希锚文件（见 RT-10）。
- 验证方法：给定任意证据文件，能在 30 秒内用 git + CI 复现其产生于哪次提交哪次运行。

### RT-AICARD-02 🔴 AI1-2 单样本证存在不证覆盖：无 1:1 覆盖断言、无哈希链校验、输出可伪造

- 复现：AI1-2 判据只要求"audit.ai_generation_events 真实行样本"（收件 E-AI1-01）；DDL 注释明言"每请求一条"（migrations/003:45），但判据未要求 ①请求↔事件 1:1 覆盖断言（如 `requests count == events count` 对账）②哈希链（prev_hash/hash）复算校验 ③样本行来源真实性。一条 `SELECT *` 输出可以是手填 JSON/静态 SQL fixture——无 CI 执行锚、无行级哈希复算。
- 影响面：AI-1 的核心承诺（每请求留痕≥3年、可审计）可被"一行样例"永久满足；漏记/丢失请求不被任何判据发现。
- 风险等级：**高**。
- 建议修复：判据改为"抽样区间内 requests↔events 1:1 对账断言 + 全量 prev_hash 链复算脚本输出 + 样本来自 CI 实跑（run id 绑定）"。
- 验证方法：删一条事件或断一环链，验收必须失败。

### RT-AICARD-03 🔴 "真实响应/真实请求"无 provider 来源证明（FakeProvider 默认）

- 复现：services/ai/src/app.ts 默认 `options.provider ?? createFakeProvider()`；判据只说"/v1/ai 路由真实响应"，未要求证明 provider 非 Fake。用默认 FakeProvider 跑一遍即得"真实响应"。
- 影响面：AI-1/AI-2 的"真实"要求被整体架空。
- 风险等级：**高**。
- 建议修复：证据须包含 provider 构造方式（env/配置截图+provider 标识），或判据明确"响应 header/审计字段标记 provider 类型，fake 产线拒收"。
- 验证方法：FakeProvider 下的请求在验收中被识别并拒绝。

### RT-AICARD-04 🟡 AI1-3 "hash 可复算**或** analysis_id 可关联"——"或"字弱分支

- 复现：判据双分支任取其一即可；analysis_id 关联分支无需 hash，且 hash 复算无 canonical 口径对齐"实际渲染文本"（HTML 渲染的空白/转义可使复算与展示文本不一致）。
- 影响面：展示留痕可仅凭 ID 跳转满足；哈希分支可复算"与展示无关的字节流"。
- 风险等级：**中**。
- 建议修复："或"改"且"至少在高危场景；明确定义 hash 输入为 canonical 文本序列化 + 渲染文本逐字比对用例。
- 验证方法：构造 HTML 转义差异用例，验收必须能分辨。

### RT-AICARD-05 🟡 AI-2 窄化为 as_of 存在+相等渲染

- 复现：判据 = "无 as_of 不渲染"（AI2-1）+ 渲染文本 as_of == 输入 as_of（AI2-2）；无 as_of 与**数据所属期**一致性对账（as_of=1970-01-01 也可渲染）。AiInterpretation.tsx:124-126 仅 `<time dateTime={source.asOf}>` 渲染，无 testid。
- 影响面：时点真实性承诺被窄化为格式合规；旧数据可披新 as_of 外衣。
- 风险等级：**中**。
- 建议修复：增加 as_of 与数据源所属期区间（dataset coverage window）对账断言 + ai-as-of testid（tracker 已列但判据未含一致性）。
- 验证方法：喂 as_of 早于/晚于数据所属期的样本，验收必须失败。

### RT-AICARD-06 🟡 AI2-2 断言枚举不含文本节点 + "仅受控不可用状态"歧义

- 复现：断言枚举为"卡片不渲染/进入受控不可用状态"，未列"prose 文本内嵌数字"路径：模型文本里写"截至11-05"不经 as_of 组件即可绕过枚举；"仅受控不可用状态"未定义状态机（哪个状态、谁触发、可否恢复），可解释为渲染一张"暂不可用"卡即达标而隐藏真实错误。
- 影响面：as_of 检查被文本通道绕过；错误被不可用态掩盖。
- 风险等级：**中**。
- 建议修复：断言明确覆盖"模型文本中出现数据/数字未带 as_of 上下文"用例；定义不可用状态机（入口、文案、恢复条件）。
- 验证方法：prose 内嵌数字用例必须被 E2E 捕获。

### RT-AICARD-07 🟡 AI3-1 computed-style 可被祖先绕过 + .ai-badge__mark 9px 漏检

- 复现（两条绕过）：
  1. E2E 只查 badge/disclaimer 节点 `getComputedStyle().fontSize` ≥13px；祖先 `transform:scale(0.6)` / `zoom` / `filter` 可让视觉字号 <8px 而 computed 不变。
  2. 实证漏检：AiGeneratedBadge.tsx:24 `<span className="ai-badge__mark" aria-hidden="true">`（可见"AI"字样）font-size:**9px**（app.css .ai-badge__mark）；该选择器不在视觉规格 §6 清单（.ai-badge/.ai-disclaimer/.disclaimer__heading/.disclaimer__text/.disclaimer__meta/.quote__meta dt/dd/.ai-context__item dt/dd）——badge 根节点 13px 达标、AI 字样本体 9px 被弱化。另 .disclaimer__meta 用 `color: var(--text-subtle)`，规格 §2/§3 明令"禁止 --text-subtle"，而签发缺证清单只列字号未列颜色——**缺证低估实锤**。
- 影响面：AI 标识"醒目不可弱化"承诺可被两路绕过。
- 风险等级：**中高**。
- 建议修复：①选择器清单补 .ai-badge__mark（或删除该 span 合并字号）②E2E 加"无 transform/zoom/filter 祖先干预"断言 + 视觉截图比对 ③缺证清单补颜色违例。
- 验证方法：scale(0.6) 注入用例失败；.ai-badge__mark 字号入规格基线。

### RT-AICARD-08 ⚠H3待裁（附🟡缺口）AI3-2 复制导出范围未界定 + 流式中间态未定义

- 复现：判据"复制导出须带 label+disclaimer"但未界定**原生文本选择复制、系统分享、截屏、打印**是否在范围；流式生成中间态（badge/disclaimer 何时起渲染）未定义——中间态可无标识展示。
- 影响面：合规适用边界模糊；实现方可各取所需。
- 风险等级：**边界案例（升级 H3）+ 中（缺口）**。
- **处置：依 A16 红线，边界禁止自行裁定，升级 H3 裁定**；裁定前按从严解释记录在案（暂按"原生选择复制在内、截屏不在内、流式首 token 起即渲染标识"为暂行口径，仅供 H3 参考，不作为结论）。
- 验证方法：H3 出书面裁定后补齐对应 E2E 用例清单。

### RT-AICARD-09 🟡 引用失配：路由断言与行号全部过时 + 缺证清单漏项

- 复现（实证，基线 01e079e）：
  1. 签发/tracker 称 App.tsx"仅6条路由无 /ai"，实际 web/h5/src/App.tsx:48-49 已有 `route.name === 'ai' && <AiHomePage />`、`route.name === 'me' && <MePage />`（共 8 route name）——签发断言与其所在 commit 的代码不符（快照过时）。AiHomePage.tsx 确为骨架页（仅 DataGapCard+占位，无模型文本），故 AI2-1 实质仍成立，但**引用链可信度受损**。
  2. app.css 行号全部错位（签发 .ai-disclaimer@:1346/.ai-badge@:1324/.disclaimer__meta@:532/.quote__meta dt@:422 dd@:428/.ai-context__item dt@:1244 dd@:1249；实际 dt=1321/dd=1326、.ai-badge=1401、.ai-disclaimer=1423、.disclaimer__meta=609、dt=499/dd=505）。数值断言（10.5/11.5/11/12.5px）属实。
  3. 缺证清单漏颜色违例（.disclaimer__meta 用 --text-subtle，见 RT-07）。
- 影响面：判据以行号/路由清单为锚的部分需人工换算；漏项使 AI-3 缺证被低估。
- 风险等级：**中**。
- 建议修复：引用一律用符号锚（选择器/组件名）+哈希绑定，不用裸行号；缺证清单补颜色项；tracker 判据列更新。
- 验证方法：按签发行号复核必须全部命中。

### RT-AICARD-10 🟡 tracker 无哈希锚文件

- 复现：signoff 有 AI-CARD-SIGNOFF-2026-11-06.hash.json 锚定（G3），tracker 无对应 .hash.json；tracker 自称 append-only 但无字节完整性保护，状态流水可整体重写。
- 影响面：闭环进度/状态可被改写而不留痕。
- 风险等级：**中**。
- 建议修复：生成 AI-CARD-CLOSURE-TRACKER-2026-11-06.hash.json（与 signoff 同机制），每次状态变更后重锚。
- 验证方法：篡改 tracker 任一字节，哈希校验失败。

### RT-AICARD-11 🟡 AI-1/AI-3 证据无独立复跑人（自证风险）

- 复现：tracker 证据收件登记无"独立复跑人"字段；按 A16"不得自写自证"精神，AI-3 的 E2E/computed-style 由 owner（A6/H1/A7）自产自交即闭环。
- 影响面：与 RT-01 叠加，证据可信度依赖单方。
- 风险等级：**中**。
- 建议修复：tracker 增设"复跑人/复跑时间/复跑结果"列，由非 owner 席位（如 A12/A11 测试通道）复跑 fail-closed 用例。
- 验证方法：任一判据证据在收件表中有第二人复跑记录。

---

## 2. 缺证是否低估——专项结论

签发记录 AI-1/AI-2/AI-3 缺证清单整体**方向正确但低估了三类**：①AI-3 漏颜色违例（--text-subtle）与 .ai-badge__mark 9px 漏检（RT-07/09）；②AI-1 漏"1:1 覆盖+哈希链复算+provider 真实性"三要件（RT-02/03）——单样本被当作充分证据；③AI-2 漏"as_of↔数据所属期一致性"（RT-05）。判据本身在"可被绕过"维度的主要风险是**检查点选择过窄**（只查 computed 字号不查视觉字号、只查枚举通道不查 prose 文本、"或"字分支）。

## 3. 处置与升级

- 依 A19：RT-01/02/03 定级高危，**不对外公开**，随本报告私下升级 H5 与 A9（经 lead 转呈）。
- 依 A16：RT-08 为边界案例，**禁止自行裁定，升级 H3**。
- 本记录为只读抽核留痕，未改动 reviews/compliance/ 任何签认文件；security/findings/ 写域属 H4 owner，本次由 lead 显式派单授权写入（写域冲突已在汇报中标注），register.md 未动。

## 4. 附：验证命令与结果

- `sha256sum rules/ai-content-policy.json rules/redline-basis.json reviews/compliance/ai-display-visual-spec-1.0.md rules/archive/ai-content-policy/aae8032a*.json rules/archive/redline-basis/f071cbc9*.json` → 与签发记录/文件名一致（G2/G5✓）
- `grep -n "route.name === 'ai'" web/h5/src/App.tsx` → :48-49 命中（RT-09 失配实证）
- `grep -n "font-size" web/h5/src/styles/app.css` + `.ai-badge__mark` 块 → 9px 实证（RT-07）
- `grep -n "AI_GENERATION_INSERT_SQL" services/ai/src/postprocess/audit.ts` → :172 ✓；`grep -n "prev_hash" services/compliance/migrations/003_ai_generation_events.sql` → :70 NOT NULL、触发器注释 :26 ✓（G4）
- 未复跑：tests/adversarial/ 36 样本历史套件（不属本轮任务，建议 A12 复跑）。

---
> 生成：A11 红队抽核（A16 初筛口径自查 + A19 发现登记格式）。本记录不构成放行；结论以 H3/H5 裁定为准。
