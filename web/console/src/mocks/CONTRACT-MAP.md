# Mock 适配层 ↔ 未来契约映射（A8）

`web/console/src/mocks/` 目前是纯内存实现，让中后台在设计系统/交互层先跑起来。
页面只依赖 `src/mocks/ports.ts` 的 `ConfigServicePort` / `ApprovalServicePort` / `AuditPort`，
契约到位后新增 HTTP 适配器替换 `MockBackend`，页面不改。

| Port 方法 | Mock 行为 | 未来契约 / 责任方 | 状态 |
| --- | --- | --- | --- |
| `ConfigServicePort.list/get` | 从内存 + `DEFAULT_VALUES` 读取 | Config Service `GET /v1/internal/configs*`（A0） | 契约未建 |
| `ConfigServicePort.saveDraft` | 校验版本（If-Match）→ 409 + 三点 diff；存 draft | Config Service draft 接口（决策 #6） | 契约未建 |
| `ConfigServicePort.validate` | 本地校验：类型/范围/必填/枚举/交叉字段 | Config Service validate 接口 | 契约未建 |
| `ConfigServicePort.submitForApproval` | 校验 `diffAcknowledged` → 生成 ChangeRequest | Approval API（A0/A4） | HTTP 入口被 A4 刻意锁住 |
| `ConfigServicePort.publish` | 状态机 + 发布门禁 → 不可变 release（version+1） | Config Service publish（决策 #6） | 契约未建 |
| `ConfigServicePort.rollback` | 人类 + 二次确认 + 原因 → 追加新 release | Config Service rollback | 契约未建 |
| `ApprovalServicePort.listPending` | 单条列表（无 batch 方法） | Approval API（单条审批为 API 约束） | 契约未建 |
| `ApprovalServicePort.approve/reject` | 人类终审 + `approval_ref`；agent 一律拒绝 | identity 服务端人类身份校验（H2 补充） | 契约未建 |
| `AuditPort.listAudit` | 记录 `actor{kind,id,modelVersion,runId}` + action | identity.AuditSink（来源唯一真源） | 契约未建 |

## 硬边界在 mock 里也是真的

- 锁定项（免责声明 / AI 标识 / as_of / 退订入口 / 风险提示 / 话术白名单）在
  `assertConfigurable()` 被二次拒绝，不依赖 UI 是否渲染入口。
- `publish/rollback` 必须 `diffAcknowledged=true`，否则抛 `DIFF_NOT_ACKNOWLEDGED`。
- `approve` 人类-only；`autoReleaseByRule` 只允许 C0/C1，且不属于 UI 可调 Port。
- 所有写操作都落审计（agent 带 `modelVersion/runId`）。

## TODO(A8)

- [ ] Config Service 契约落地后：`src/adapters/http-config-service.ts` 实现 `ConfigServicePort`。
- [ ] Approval API 契约落地后：`src/adapters/http-approval-service.ts` 实现 `ApprovalServicePort`。
- [ ] 契约测试（A8 gate）：Port 行为对照 `contracts/**` 的请求/响应形状。
