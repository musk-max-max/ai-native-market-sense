# Mock 适配层 ↔ 契约映射（A8）

`web/console/src/mocks/` 目前是纯内存实现，让中后台在设计系统/交互层先跑起来。
页面只依赖 `src/mocks/ports.ts` 的 `ConfigServicePort` / `ApprovalServicePort` / `AuditPort`，
契约到位后新增 HTTP 适配器替换 `MockBackend`，页面不改。

> 2026-11-06 更新：A0 的 `contracts/config/openapi.yaml`、`contracts/approval/openapi.yaml`
> 已出现在工作区（未提交），下表映射到真实 path/operationId；Port 命名暂不跟随契约
> （`itemId` vs `config_id`），等契约评审通过后在 adapter 层做映射，避免改 UI。

| Port 方法 | Mock 行为 | 真实契约（A0） | 状态 |
| --- | --- | --- | --- |
| `ConfigServicePort.list/get` | 从内存 + `DEFAULT_VALUES` 读取 | `contracts/config/openapi.yaml`：`GET /v1/internal/configs`（`listOpsConfigs`）、`GET /v1/internal/configs/{config_id}` | 契约已在工作区，未提交/未评审 |
| `ConfigServicePort.saveDraft` | 校验 `expectedVersion`（If-Match）→ 409 + 三点 diff；存 draft | `PUT /v1/internal/configs/{config_id}`（If-Match `"v<n>"`，409 → base/current/submitted diff）；成功后 version+1 | 同上 |
| `ConfigServicePort.validate` | 本地校验：类型/范围/必填/枚举/交叉字段 | `POST /v1/internal/configs/{config_id}/validate` | 同上 |
| `ConfigServicePort.submitForApproval` | 校验 `diffAcknowledged` → 生成 ChangeRequest | `POST /v1/internal/configs/{config_id}/submit`（生成审批单） | 同上 |
| `ConfigServicePort.publish` | 状态机 + 发布门禁 → 不可变 release（version+1） | `POST /v1/internal/configs/{config_id}/publish`（需可解析 `approval_ref`，生成不可变 release + `content_hash`；灰度 `canary_percent` 1–10，**无全量参数**） | 同上 |
| `ConfigServicePort.rollback` | 人类 + 二次确认 + 原因 → 追加新 release | `POST /v1/internal/configs/{config_id}/rollback`（切换 release 指针，不改历史 release） | 同上 |
| `ConfigServicePort.listReleases` | 内存 releases 反序 | `GET /v1/internal/releases`、`GET /v1/internal/releases/{release_id}` | 同上 |
| `ApprovalServicePort.listPending` | 单条列表（无 batch 方法） | `GET /v1/internal/approvals` | 同上（A4 的 HTTP 审批入口此前被刻意锁住，随审批契约一起开） |
| `ApprovalServicePort.approve/reject` | 人类终审 + `approval_ref`；agent 一律拒绝 | `POST /v1/internal/approvals/{approval_ref}/decision`；`POST .../evaluate` 供调度器/规则引擎；`GET .../events` 审计 | 同上 |
| `AuditPort.listAudit` | 记录 `actor{kind,id,modelVersion,runId}` + action | identity.AuditSink（来源唯一真源）+ approval events | 契约未见 audit 列表，等 A4/A0 |

## 契约 ↔ Mock 的已知差异（适配器层处理，不改 UI）

- 契约主键是 `config_id`（字符串，如 `ops.home-feed`）+ `environment`；Mock 只用了 `itemId`，
  没有 environment/canary。HTTP adapter 需要补 `environment` 参数与 `canary_percent`（固定 1–10）。
- 409 三点 diff 契约字段是 `base_version/current_version/submitted_version + changes/conflicts`；
  Mock 的 `SaveDraftOutcome.conflict{base,mine,theirs,currentVersion}` 在 adapter 里映射成
  `ConflictView`（base/current/submitted → 前端「基线/线上当前/我的草稿」）。
- 审批契约按 `approval_ref` 寻址（=`config_id`/release 维度），Mock 按 `changeRequestId`；
  适配器需要把 submit 返回的 approval_ref 存到 ChangeRequest，并在 decision 时回传。
- 规则引擎自动放行走 `POST /v1/internal/approvals/{approval_ref}/evaluate`；UI 不提供该入口，
  由 A15 调度器触发，发布 actor 必须是 agent（与 `checkPublishGate` 一致）。

## 契约裁定与 adapter 必做（A0 2026-11-06 回复；契约含 9e85839 后的待提交修订）

- **config_id 映射**：UI key 不能直接当 config_id（pattern `^ops_[a-z0-9_]{3,48}$` 不允许点）。
  adapter 必须用 `listOpsConfigs` 返回的 canonical `config_id`，本地维护 UI key→config_id 映射；
  seed ID 以 A14 registry 为准（不要自行推导，如 `ops.home-feed` 可能是 `ops_home_feed` 但待确认）。
  `market.sentiment-thresholds`、`crm.followup` 不属于 ops-config 契约：P2 console 先隐藏或标
  「未接契约」，不要塞进 config service；后续独立契约再开。
- **OpsSpec 编辑（P2 范围）**：PUT 必须提交**完整** `OpsConfigWrite`（columns/content_items/
  strategies 三数组均 required），即使只改一个标量。P2 只做标量子集：columns[].title/subtitle/
  visible/order；content_items[].display_title/summary/visible/target_route；strategies[].limit/
  enabled/title_template；数组增删/排序留 P3。UI 字段**直接绑定 JSON Pointer**
  （`/spec/columns/{i}/title`、`/spec/content_items/{i}/display_title`、`/spec/strategies/{i}/limit`），
  不要扁平化成 values；服务端 400 的 `errors[].path` 即 JSON Pointer，按 path 定位字段错误；
  索引在加载后固定，增删后重排需重算 index。
- **Ports 收敛**：`submitOpsConfig` 返回 `ApprovalSubmission{approval_ref,application_id,flow,
  status,submitted_at}`；之后预览/决定用 approval API 的 `ApprovalApplication.change{keys,before,
  after,diff_hash}`；**删除独立 changeRequest 实体**（mock 的 `cr-N` 只是占位）。
- **decideApproval**：通过/驳回都必填 `reason` ≥8（`ApprovalDecisionRequest.required=
  [decision,reason]`），人类主体、单条；「通过」也要 UI 必填原因（合规留痕），`evidence_refs` 可选。
- **publish**：不递增 version（`Release.version = expected_version` = 已审批 draft 内容版本）；
  `canary_percent` 1–10 必填、无全量字段；同一 version 可有多个 release（不同 canary），
  列表按 `published_at`，行上同时显示 version + release_id + canary；UI 的 vN 来自 config version，
  不要拿 release 序号当 version；一个 approval_ref 只发布一次。
- **rollback**：契约要求 `target_release_id + approval_ref`，即回滚也要先走 T6 审批。P2 按
  「发起回滚审批 → 人类审批 → 调 rollback」建模；mock 阶段可直调 mock 并标 TODO，但 adapter
  接口保留 approval_ref 参数。
- **变更说明表单**：PUT/validate/submit 都必须带 `change_reason`(8–200 字) +
  `impact_scope`(1–6，枚举 column_layout/content_copy/content_placement/ranking/rotation/
  visibility)，UI 必须补表单块。
- **认证/错误**：`/v1/internal/*` Bearer（A4 identity，internal_active + sessionVersion）；
  success 不套 shared `ResponseMeta`；PUT 带 `If-Match: "v<n>"`；approval create/decide 带
  `Idempotency-Key`；400/409/412 均为 Problem(+json)；409 conflict 现在直接在 components 定义
  （非 allOf），`ConfigConflictProblem` required=[type,title,status,code,diff]。
- **待提交修订注意**：`EnvironmentQuery` 与请求体 `environment` 必须一致（以 query 为准，不一致
  400 VALIDATION_ERROR）；`RankingStrategy.window` 枚举是 `d1/d5/d20`（不是 1d/5d/20d）；内部域
  409/412 错误码已定；`ApprovalConflictProblem` 可选带 approval_ref/current_status。

## 硬边界在 mock 里也是真的

- 锁定项（免责声明 / AI 标识 / as_of / 退订入口 / 风险提示 / 话术白名单）在
  `assertConfigurable()` 被二次拒绝，不依赖 UI 是否渲染入口。
- `saveDraft → validate → submitForApproval → publish` 不能跳步；`publish` 要求状态 approved +
  已确认 diff + 合法授权（`human_approval` 或 C0/C1 `rule_engine_auto`），否则抛 `ConfigGateError`
  （`STATE`/`DIFF_NOT_ACKNOWLEDGED` 视门禁而定）。
- `rollback` 人类-only + `diffAcknowledged` + 原因必填；`approve` 人类-only，agent 抛
  `AGENT_CANNOT_FINAL_APPROVE`；`autoReleaseByRule` 只允许 C0/C1，且不属于 UI 可调 Port。
- 所有写操作都落审计（agent 带 `modelVersion/runId`）。

## TODO(A8)

- [ ] 契约评审/提交后：`src/adapters/http-config-service.ts` 实现 `ConfigServicePort`
      （If-Match、409 映射、environment/canary、release 列表）。
- [ ] `src/adapters/http-approval-service.ts` 实现 `ApprovalServicePort`
      （approval_ref 寻址、decision、单条审批；不实现 batch）。
- [ ] 契约测试（A8 gate）：Port 行为对照 `contracts/config`、`contracts/approval` 的请求/响应形状，
      并补 `infra/ci` 的 oasdiff 守护（A13）。
- [ ] 真实身份：`consoleActor` 目前硬编码 `{kind:'human',id:'H2'}`（Mock），接 A4 identity 后
      改为登录态 principal；agent 来源从 AuditSink 读，不由 UI 猜。
