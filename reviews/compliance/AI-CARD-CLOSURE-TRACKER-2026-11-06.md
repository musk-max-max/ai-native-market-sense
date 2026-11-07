# C 端 AI 展示卡 AI-1/2/3 闭环判据跟踪表（2026-11-06）

- 记录编号：H3-TRACKER-AI-CARD-2026-11-06-v1
- 建立人：H3（合规负责人兼 DPO）；建立时间：2026-11-06（Asia/Shanghai）
- 依据签发记录：`reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md`（H3-SIGNOFF-AI-CARD-2026-11-06-v1，结论：AI-1/2/3 均不签）
- 性质：**状态台账**。闭环判据逐字取自上述签发记录，不新增、不放宽、不改写签发记录本身；状态变更一律走文末「状态流水」追加。
- 分区：**c_end 仅**（L130：internal 分区 owner 签，H3 只出复核意见，不代签）。
- go-live 卡点：保持 **OPEN**，直至下列全部判据经 owner 提交证据、H3 复核签字。

## 一、逐卡跟踪主表

### AI-1（响应元数据 + 服务端生成/展示留痕 ≥3 年）— 状态：OPEN（不签）

- owner：**A3**（/v1/ai/* 路由 + 留痕实现，本轮在途）、**A4**（契约/审计落库）；签发记录口径 A0/A3/A4。
- 所依红线：H3-C01/C02/C10 + 红线④（`rules/redline-basis.json` v1.0.2、`rules/ai-content-policy.json` 1.1.2）。

| # | 闭环判据（签发记录原文口径） | 验收口径（H3 复核怎么算过） | 缺证现状（2026-11-06 建表时） | 状态 |
|---|---|---|---|---|
| AI1-1 | `/v1/ai/*` 路由上线并通过契约测试，真实响应 `meta.ai` 六字段齐全、`generated=true`、`content_version`/`model_family`/`policy_version` 非空 | 契约测试通过记录（命令+结果数字）+ 一份**真实响应 JSON 样本**：`AiMeta` 六字段（generated/label_version/content_version/model_family/prompt_version/policy_version）齐全，`generated===true`，后三者非空；`policy_version` 须与 `rules/ai-content-policy.json` 当前版本（`ai-content-policy/1.1.2`）一致；`AnalysisResult` 含 `as_of`/`meta` | 未满足：`services/ai/src/app.ts:15-16` 仍注释「不暴露业务路由」；`services/api/src/domains.ts:14` 只注册 identity/market——无 `/v1/ai` 路由 | OPEN |
| AI1-2 | 一次真实请求落 `audit.ai_generation_events` 行（含上述字段与 `as_of`），提供可复核样本（只读查询输出） | 只读 SQL/查询输出样本：行含 `policy_version`/`content_version`/`model_family`/`as_of`/`request_id` 与生成时间戳；**`request_id` 与 AI1-1 样本响应同一请求闭环对得上**；落库实现位置可指认（`services/ai/src/postprocess/audit.ts:172` / `host.ts:181` 一带） | 未满足：无任何一次真实请求写出的行样本 | OPEN |
| AI1-3 | 展示留痕路径明确（哪个字段记录用户可见内容的 hash/analysis_id），给出实现位置 | 实现位置（文件:行）+ 样本行中该字段取值能与用户可见内容对应（hash 可复算或 analysis_id 可关联）；「展示留痕」与「生成留痕」区分清楚 | 未满足：展示留痕实现路径未见 | OPEN |
| AI1-4 | 以上证据提交后由 H3 复核签字（本卡解除） | AI1-1..3 全部 PASS 后，H3 追加签发记录解除本卡 | — | BLOCKED-BY-AI1-1..3 |

### AI-2（时点真实：无 as_of 时数值/badge/disclaimer 均不渲染）— 状态：OPEN（不签）

- owner：**A6**（实现）、A11/A12（测试）、**A7**（E2E）。
- 所依红线：H3-C02/C10 + 红线④ as_of。

| # | 闭环判据（签发记录原文口径） | 验收口径（H3 复核怎么算过） | 缺证现状（2026-11-06 建表时） | 状态 |
|---|---|---|---|---|
| AI2-1 | `/ai` 页与 `AiInterpretation` 模型文本路径存在（可 mock 响应），每个生成块带 `ai-as-of` | 路由/组件实现位置 + `data-testid="ai-as-of"` 注册于 `web/h5/src/lib/testids.ts`，值原样等于 `source.asOf`（含 `+08:00`，不做前端时区换算）；A11/A12 可用 mock 响应跑通 | 未满足：`web/h5/src/App.tsx` 仅 6 条路由无 `/ai`；`AiTextSlot content={null}` 不渲染模型文本；`AiInterpretation.tsx:124-126` 无 testid | OPEN |
| AI2-2 | 无/无效 as_of 用例：断言 `ai-generated-badge`、`ai-disclaimer`、数值节点均不存在，仅受控不可用状态 | A11/A12 测试证据（用例清单+断言+结果数字）：缺失/无效/空串 as_of 各至少 1 例，三类节点全部断言不存在 | 未满足：测试对象（AI 展示路径）不存在 | OPEN |
| AI2-3 | as_of 与 API 响应严格相等（含 `+08:00`），刷新失败保留旧数据 + 「未更新」标记 | 测试证据含：严格相等断言、跨时区用例、刷新失败用例（旧 as_of 保留 + 「未更新」标记可见） | 未满足：无此类用例 | OPEN |
| AI2-4 | A11/A12 证据 + A7 E2E 报告提交后 H3 复核 | 两份报告齐、结论与 AI2-1..3 逐条对应 → H3 追加签发解除 | — | BLOCKED-BY-AI2-1..3 |

### AI-3（badge/disclaimer 不可关闭/折叠；复制/导出携带 label+disclaimer；无硬编码 fallback）— 状态：OPEN（不签）

- owner：**A6**（实现）、**A7**（验收 + E2E）。
- 所依红线：红线④ + H3-C01/C02。

| # | 闭环判据（签发记录原文口径） | 验收口径（H3 复核怎么算过） | 缺证现状（2026-11-06 建表时） | 状态 |
|---|---|---|---|---|
| AI3-1 | 视觉规格 v1.0 §6 全部条目在 390×844 浅色+深色通过（font-size ≥13px、opacity=1、无 aria-hidden 祖先、color 允许列表、无 disclaimer-close） | A7 **computed-style/E2E 证据**（非源码级）逐条覆盖规格 §6，浅+深色各一份；已知不达标选择器须先修复并留证：`.ai-disclaimer` 10.5px（`web/h5/src/styles/app.css:1346`）、`.ai-badge` 11.5px（:1324）、`.disclaimer__meta` 11.5px（:532）、`.quote__meta dt` 11px/`dd` 12.5px（:422/:428）、`.ai-context__item dt` 11px/`dd` 12.5px（:1244/:1249），全部 ≥13px | 未满足：字号不达 13px 下限；只有源码级断言无 computed-style/E2E | OPEN |
| AI3-2 | 复制/导出若存在必须携带 label+disclaimer+as_of；无此能力期间不得提供任何「复制正文」入口 | E2E/源码断言证明当前无「复制正文」入口；若新增复制/导出，须有携带三件套（label+disclaimer+as_of）的测试证据 | 未满足：无复制/导出可验（H5 无 clipboard/导出入口）；须防「新增而只复制正文」 | OPEN |
| AI3-3 | 对话页每条 AI 回复带标识+免责 | E2E 逐条断言：每条 AI 回复节点含 badge+disclaimer（不可关闭/折叠），深色模式复跑 | 未满足：无 `/ai` 对话页 | OPEN |
| AI3-4 | A7 验收 + E2E 报告提交后 H3 复核 | 报告齐、与 AI3-1..3 逐条对应 → H3 追加签发解除 | — | BLOCKED-BY-AI3-1..3 |

## 二、证据收件登记（预期交付清单）

| 证据编号 | 对应判据 | 提交 owner | 路径/形态 | 状态 | H3 复核结论 |
|---|---|---|---|---|---|
| E-AI1-01 | AI1-1..3 全部 | A3 | `tests/data/acceptance/artifacts/ai1-evidence-2026-11-06.md` | **在途**（A3 实现 /v1/ai/* 路由+留痕，2026-11-06） | 待复核 |
| E-AI2-01 | AI2-1..3 | A6/A11/A12 | 测试证据（待定形态） | 未提交 | — |
| E-AI2-02 | AI2-4 | A7 | E2E 报告（含 `ai-as-of`、无 as_of 不渲染、深色复跑） | 未提交 | — |
| E-AI3-01 | AI3-1..3 | A6/A7 | computed-style/E2E 报告（390×844 浅+深） | 未提交 | — |

复核程序：证据到件 → H3 逐条对照「验收口径」列 → 通过则在「状态流水」追加结论行并更新状态；任一条不通过 → 列明缺口退回 owner，**不签**。AI-1 解除由 H3 以新签发记录追加（不改写 AI-CARD-SIGNOFF-2026-11-06.md）。

## 三、建表时代码基线（观测记录，2026-11-06）

- `services/ai/src/app.ts:15-16`：注释仍写「不暴露业务路由；业务路由（/ai/analyses、/ai/chat）由后续批次接入」——无 `/v1/ai/*`。
- `services/api/src/domains.ts:14`：`domainPlugins = [identityPlugin, marketPlugin]`——无 ai domain。
- `tests/data/acceptance/artifacts/`：`ai1-evidence-2026-11-06.md` 尚未存在。
- 契约与留痕底座（已具备，不足以放行）：`contracts/ai/openapi.yaml:332-357` `AiMeta`；`services/ai/src/postprocess/audit.ts:172` `AI_GENERATION_INSERT_SQL`；`services/compliance/migrations/003_ai_generation_events.sql`（append-only + 哈希链 + ≥3 年保留）。

## 四、状态流水（append-only，只增不改）

- 2026-11-06 H3：建表。AI-1/2/3 = **OPEN（均不签）**；go-live 卡点保持 OPEN。E-AI1-01（A3）在途登记。
- 2026-11-06 18:40 H3：L0 待裁队列五项处置完成，裁定书 `reviews/compliance/H3-RULING-2026-11-06-AI-CARD-QUEUE.md`（裁一 token 冲突=青绿 #0b6357；裁二 N4 语义口径、4 观察项不豁免、规格 v1.1 修订；裁三 RT-08 复制/截屏/流式三分法+首帧规则）。E-AI1-01（A3）、E-AI2-02+E-AI3-01（A7）三份到件复核：**均收件、均维持不签**——签发前置 P-1/P-2/P-3 未消解（详见裁定书附一/附二）。勘误与行号回填见 §六，证据收件补登见 §六A，签发前置与判据收紧见 §七。AI-1/2/3 = OPEN，go-live = OPEN。
- 2026-11-06 18:43 H3：lead L0 回执（m00122）：A3 请裁的仓库级 typecheck 归因已裁（L135.2，归 A4 域）且 **A4 已修复**（typecheck 全量 EXIT 0、tests/contract 69 passed）→ 该项消解，AI-1 签发核验按「**仓库级绿**」口径直接核。五项裁定已转派 A6/M1/A3 执行；规格 v1.1 重签待 A6 落地后复核；AI2-3 覆盖缺口已转 A7 复跑清单；RT-04/05/06/07 收紧项维持 §七 跟踪。

## 五、不变项与纪律（防误读）

- 文案侧签认保持有效（backend `2026.11.5.ac875c9d9237.backend.json`、frontend `2026.11.5.2dfd627b35c1.frontend.json`）；**文案签认 ≠ AI 展示放行**。
- AI-4 维持 DONE，不因本表回退。
- 政策 1.1.2 两分区签认只解决规则加载；AI 内容展示仍需本表三卡闭环。
- 本表判据变更须 H3 重新签发新记录；internal 分区事项不入本表（owner 签）。

## 六、勘误与行号回填（2026-11-06 18:40 追加，队列③；对应 RT-09）

- **引用规则变更**：判据/缺证引用一律以**符号锚**（选择器/组件/函数名）为主锚；行号仅作辅助且必须带观测时间。此前裸行号已失效。
- **「App.tsx 无 /ai」过时更正**（主表 AI2-1 缺证行）：`web/h5/src/App.tsx:48-49`（2026-11-06 18:40 观测）已有 `route.name==='ai'` → `AiHomePage`，全表 8 个 route name。**但** AiHomePage 为骨架页（DataGapCard+占位，无模型文本、不发 `/v1/ai/*` 请求），AI2-1「模型文本路径 + 每生成块 ai-as-of」实质仍不满足（RT-09 结论一致），缺证行实质结论不变、引用修正。
- **行号漂移回填**（`web/h5/src/styles/app.css`，2026-11-06 18:40 观测；M1 报告 §1 为同日早前快照、RT-09 为基线 01e079e 快照，均已被本次观测取代）：

| 选择器（符号锚） | 建表时引用 | 18:40 实测行 | 值状态 |
|---|---|---|---|
| `.ai-badge` | :1324 | :1401 | **已修复** `var(--fs-caption)`=13px、color `--text-muted` |
| `.ai-disclaimer` | :1346 | :1423 | **已修复** 13px、color `--text` |
| `.disclaimer__meta` | :532 | :609 | **已修复** 13px、color `--text-muted` |
| `.quote__meta dt` / `dd` | :422/:428 | :499/:505 | **已修复** 13px |
| `.ai-context__item dt` / `dd` | :1244/:1249 | :1321/:1326 | **已修复** 13px |
| `.ai-badge__mark` | —（RT-07 漏检） | :1411 | 9px→**10px**（达规格 §1 ≥10px） |
| `.ai-slot--pending` | 观察项 | :1387 | 11.5px + `--text-subtle`（裁二纳入，待修） |
| `.ai-section__footnote` | 观察项 | :1436 | 11.5px（裁二纳入，待修） |
| `.ai-section__meta` | 观察项 | :1443 | 11px + `--text-subtle`（裁二纳入，待修） |
| `.quote__stale` | 观察项 | :512 | 12px（裁二纳入，待修） |

- **数值断言更新**：主表 AI3-1 缺证行的「五处 <13px」为修复前快照——A6 字号/颜色修复已生效（`web/h5/src/styles/tokens.css:45` `--fs-caption: 13px` 已定义；A7 E2E 24 节点浅+深复证九选择器 ≥13px）。主清单字号缺证改为「**已修复待 E2E 终验**（badge/disclaimer 四选择器因 R1 未渲染记 GAP）」；未决缺证 = 裁二 4 选择器 + RT-07 祖先断言 + 颜色违例 2 处（`.ai-slot--pending`/`.ai-section__meta` 的 `--text-subtle`）。

## 六A、证据收件登记（2026-11-06 18:40 追加；结论详见裁定书附二）

| 证据编号 | 对应判据 | 提交 owner | 路径/形态 | 状态 | H3 复核结论 |
|---|---|---|---|---|---|
| E-AI1-01 | AI1-1..3 | A3 | `tests/data/acceptance/artifacts/ai1-evidence-2026-11-06.md` | 已收件 | **部分满足**：路由+六字段+审计双样本+展示留痕路径实现侧达标（services/ai 42/42、typecheck EXIT 0；六字段落 `data.ai` 按契约真源成立）；缺 P-1（无 commit/CI/sha 锚、证据脚本已删不入 CI）、P-2（无 1:1 对账/链复算）、P-3（model_family=fake-v1 无真实来源）、RT-04「且」口径 → **AI-1 不签** |
| E-AI2-02 | AI2-1..3 | A7 | `tests/data/acceptance/artifacts/ai23-evidence-2026-11-06.md` | 已收件 | **部分满足**：AI2-1 stock 路径绿（ai-as-of 严格相等）；AI2-2 = 1 绿 2 红 3 BLOCKED（R2 TypeError 悬挂、R3 非法 as_of 11 处数值照渲=fail-closed 红线缺口，A6 优先修）；AI2-3 未覆盖；生成块域被 R1 阻塞 → **AI-2 不签** |
| E-AI3-01 | AI3-1..3 | A7 | 同上（双报告合一） | 已收件 | **部分满足**：AI3-1 浅+深 24 节点全绿但 4 GAP + 裁二 4 选择器 + RT-07 断言待补；AI3-2 反向证据绿（转常绿断言）；AI3-3 无页可验 → **AI-3 不签** |

## 七、签发前置与判据收紧（2026-11-06 18:40 追加，队列⑤；全量口径以裁定书附一为准）

- **签发前置（三卡共同，must 消解才进 H3 签字）**：P-1 证据三锚（commit sha / CI run id 或等价锚 / 证据文件 sha256，tracker 哈希锚清单 RT-10）；P-2 AI-1 增 requests↔events 1:1 对账 + prev_hash 全链复算 + CI 实跑样本；P-3 「真实响应」provider 非 Fake 证明（现两样本 fake-v1，不计入真实响应判据）。
- **判据收紧**：AI-1 AI1-3「或」→「且」（canonical hash 输入 + 渲染文本逐字比对用例）；AI-2 增 as_of↔数据所属期对账 + prose 内嵌数字用例 + 受控不可用状态机定义（RT-05/06）；AI-3 增无 transform/zoom/filter 祖先断言 + `.ai-badge__mark` 入清单 + 颜色违例 2 处入缺证（RT-07）。
- **RT-08 裁定后果**（裁三）：AI3-2 口径扩充——产品复制/分享/导出与原生选择复制均须三件套（copy 事件追加 或 AI 正文 user-select:none 二选一）；截屏/打印/系统分享不设判据；流式 badge+disclaimer 首帧在场、完成前不渲数值、不能保证则关流式。A7 增补用例清单见裁定书裁三-B 验证段。
