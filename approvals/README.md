# 审批账本（`approvals/`）· 结构草案 v0.1

> **状态：结构草案，未生效，无实现。** 本目录只放「append-only 账本的事件结构与投影规则」，供 A4 在 `services/approval/` 实现时消费；**不含代码、不含真实审批数据、不被任何服务加载**。
> 账本本身当前**不存在**：`services/approval/` 目录未建，identity 的 `approve` 只覆盖内部员工申请，`/v1/internal/approvals/*` 契约已落但无实现（P0 缺口 **C-09**，见 `configs/rbac/approval-rule-engine.md` §0）。
>
> - Owner：A9（2026-11-06 17 席重建，原 A15 审批管理员域并入）｜实现：A4（`services/approval/`，本目录只给结构）
> - 权威真源优先级：`agents/decisions.md` / ADR > `rules/` 已签文件 > `contracts/approval/openapi.yaml` > 本文。冲突时本文作废并升级，不得反向改判真源。
> - 相关：`configs/rbac/approval-rule-engine.md`（判定模型 §1.3 输出 → 本账本投影）、`configs/rbac/console-mapping.md`（中后台字段对照）、`contracts/approval/openapi.yaml`（API 契约）。

## 0. 结论摘要

1. **账本 = 唯一留痕真源，只追加、不改、不删。** 审批单的「当前状态」不是独立真值，而是按 `seq` 折叠事件的投影；任何回滚/撤回都是新事件，不是改旧事件。
2. **谁做的决定必须留在事件里**：`actor{kind,id,model_version,run_id}` + `decision.reason`（≥8 字）+ 判据来源 `evaluation.source_refs[]`。**agent 与 A9 永不出现在 `approved/rejected` 事件的 `decided_by` 里**（R6、C1=A）。
3. **`approval_ref` 只有 A4 建单事务能生成**（`apr_<uuidv7>`，跨环境可带 `prod:`/`staging:` 前缀，L51）；申请人/UI/A9 都不得预填或代填。console mock 里 `console/cr-1`、`seed/initial-release`、`rollback/<releaseId>` 这类自造 ref **不合规**，见 §5 缺口 G-02。
4. **P0 全黄**：规则引擎未实现 → 只有 `evaluated(yellow_route)` + `routed` + 人类 `approved/rejected` 三类会真实发生；`auto_passed` 事件类型先定义，不可产生。

## 1. 事件结构（`schema/ledger-event.schema.json`）

一行一个 JSON 事件（`events.example.jsonl` 为形状示例，非真实数据）：

| 字段 | 必需 | 说明 |
|---|---|---|
| `event_id` | 是 | 全局唯一，建单事务生成；`approved/rejected` 事件不可复用（R9） |
| `seq` | 是 | 单笔审批内从 1 递增，连续无洞；投影按此排序 |
| `prev_event_hash` | 是（首条为 `null`） | 上一条事件的 `event_hash`，哈希链防篡改（H5 基线「审计不可篡改」） |
| `event_hash` | 是 | `sha256:` + 64 hex，覆盖本行规范化 JSON（含 `prev_event_hash`） |
| `approval_ref` | 是 | 形态校验：`^((prod|staging):)?apr_<uuidv7>$`，与 `services/identity/src/domain/approval-ref.ts:26` 同源 |
| `type` | 是 | `created` / `evaluated` / `routed` / `auto_passed` / `approved` / `rejected` / `expired` / `cancelled` |
| `at` | 是 | ISO 时间戳 |
| `actor` | 是 | 事件来源：人类 / agent（带 `model_version`）/ `rule_engine`（仅 `auto_passed`）|
| `evaluation` | 按类型 | `evaluated`、`auto_passed` 必填；字段与契约 `ApprovalEvaluation` 一致 |
| `decision` | 按类型 | `approved` / `rejected` 必填；`decided_by.kind` 只能是 `human` |
| `note` | 否 | 撤回/过期原因、驳回理由摘要等（人类可读） |

**类型 → 谁产生 → 可否缺**

| `type` | 产生方 | 必需附带 | 现状 |
|---|---|---|---|
| `created` | A4 建单事务 | `actor`=申请人 | 实现未落（C-09） |
| `evaluated` | 规则引擎（A15 调度器触发，UI 无入口） | `evaluation`；未实现时必须 `yellow_route`，不得伪造绿 | 不可用（引擎未实现） |
| `routed` | A4/A9 路由 | `evaluation.route_to` 对应席位 | 待引擎 |
| `auto_passed` | A4 审批事务（记录绿档） | `evaluation.decision=green_auto_pass`；`actor.kind=rule_engine` | **不可产生**（绿集合=∅） |
| `approved` / `rejected` | 人类审批人（token 主体） | `decision`（reason ≥8） | 契约已定义，实现未落 |
| `expired` | 定时任务 | `note` | 待裁（有效期无来源 → 缺口 G-05） |
| `cancelled` | 申请人撤回 | `note` | 契约 `ApprovalEvent.type` **缺此枚举** → 缺口 G-04 |

## 2. 投影规则（账本 → 审批单当前状态）

```
status = last(events).type 映射：
  created|routed → submitted/routed（作 routed）
  evaluated(yellow_route) → routed
  evaluated(red_block)   → rejected（blocked 视同终止，不可再决定）
  approved|rejected → 终态，不可再 append 决定事件（409）
  expired|cancelled → 终态
```
- 同一 `approval_ref` 的 `seq` 必须连续；出现洞/哈希断链 → 视为账本损坏，停用该单并上报 H5（默认拒绝 R0）。
- `GET /v1/internal/approvals/{approval_ref}` 返回的 `evaluation`、`decision` 取**该类型最后一条**事件，不重算、不改写历史。
- API 响应按 `contracts/approval/openapi.yaml` 的 `ApprovalEvent`（`additionalProperties: false`）投影，存储态独有字段 `seq`/`prev_event_hash`/`event_hash` 在响应层剔除；是否放开到契约由 A0/H2 定（缺口 G-01）。

## 3. 硬边界（实现时不得放松）

- **append-only**：账本表只允许 `INSERT`；无 `UPDATE`/`DELETE` 授权（DB 层 grant 收口，H4/A4 落地）。更正用新事件 + `note` 指向原事件，不改旧行。
- **agent 不批 agent**：`approved/rejected` 的 `actor.kind` 必须是 `human`；agent 只能 `created`；`auto_passed` 只能由确定性规则引擎产生（不是 LLM）。
- **A9 不进入决定**：A9 只做预审/填单/路由/催办；任何事件里不得出现 A9 作为决定者。
- **不可复用**：撤回/驳回/过期后 `approval_ref` 与 `event_id` 均不得复用；重提 = 新建单（R9）。
- **越权与批量**：批量决定、自批（`applicant == approver`）、利益关联未回避 → 不产生 `approved`，按红处理并上报 A9 + H5（R2/R3/R10）。
- **来源留痕**：人类审批人来自 token 主体，不取请求体；agent 来源必须带 `model_version`（H5「模型版本绑定」）。UI 仅展示、不得让操作者手写 `approval_ref`。

## 4. 与规则引擎的衔接

`configs/rbac/approval-rule-engine.md` §1.3 的判定输出字段 → 本账本字段：

| 规则引擎输出 | 账本字段 |
|---|---|
| `decision` | `evaluation.decision` |
| `rule_id` + `rule_version` | `evaluation.rule_id` / `rule_version` |
| `source_refs[]` | `evaluation.source_refs[]`（≥1，可回指 decisions 行号/L 编号/ADR 章节/rules sha） |
| `policy_snapshot{version,sha256}` | `evaluation.policy_snapshot`；与加载版本不一致 → 红，不得 append `auto_passed` |
| `input_hash` | `evaluation.input_hash`（`^sha256:[0-9a-f]{64}$`，可复算） |
| `reason_codes[]` | `evaluation.reason_codes[]` |
| `route_to` | `evaluation.route_to`（黄档必填） |
| `required_reviews[]` | `evaluation.required_reviews[]` |
| `approval_ref` | 原样透传，不得重生成 |
| `decided_by` | 绿=`rule_engine:<rule_id>`；黄=人类席位；A9 永不出现 |

## 5. 缺口清单（按严重度）

| # | 严重度 | 缺口 | 责任方 |
|---|---|---|---|
| G-01 | P1 | 存储态 `seq`/`prev_event_hash`/`event_hash` 是否进契约 `ApprovalEvent` 未定（现契约 `additionalProperties:false`，只能内部存） | A0/H2 |
| G-02 | **P0** | console 用自造 `approval_ref`（`console/<id>`、`seed/initial-release`、`rollback/<releaseId>`）调 approve/rollback，违反 L51，服务端实现后必 400；UI 应改为**只读展示**后端返回的 ref | A6（`web/console/src/pages/ApprovalQueuePage.tsx:63`、`src/mocks/backend.ts:91,343`） |
| G-03 | P0 | `services/approval/` 未建：建单/账本/事件查询/决定全无实现 → T6 绿档不可用、账本无真数据 | A4 |
| G-04 | P2 | 契约 `ApprovalEvent.type` 无 `cancelled`（撤回是 L51/R9 明确场景）；`ApprovalStatus` 亦无 | A0 |
| G-05 | P2 | 审批单有效期/过期判定（`expired`）无签定来源，不得实现 | H6/H5 裁定 |
| G-06 | P2 | 契约 `ApprovalEvent.actor` 可选，无法表达「来源必填」；本 schema 按类型强制，服务端需自行校验 | A4 |

## 6. 目录

| 路径 | 内容 |
|---|---|
| `README.md` | 本文：账本原则、事件结构、投影规则、硬边界、缺口 |
| `schema/ledger-event.schema.json` | 单事件 JSON Schema（2020-12）：字段形状 + 按类型条件必填 + 人类决定硬约束 |
| `events.example.jsonl` | 形状示例（示例数据，`approval_ref` 为虚构 uuidv7，不指向真实单） |
