# 契约终审记录：contracts/config + contracts/approval（2026-11-06）

- 审阅人：H2（架构与技术负责人，人席终审，veto:True）
- 审阅对象：`contracts/config/openapi.yaml`（info.version 0.1.0，约 1166 行）、`contracts/approval/openapi.yaml`（0.1.0，约 631 行）
- 依据：`docs/adr/ADR-001-contract-standard.md`（shared 0.2.3 词表、内部信封例外）、`agents/decisions.md` L51（approval_ref 形态）/L128（T6 裁定）/L130（policy 分区签发）/L1506（预授权字段依赖）、A11 `INTERNAL_DOMAINS`、`web/console/src/mocks/CONTRACT-MAP.md`
- 方法：全文通读 + 门禁实测（2026-11-06）：`tests/contract` 全量 pytest **69 passed**（1 条 `response-body-all-of-removed` 为 ADR-001 ⑨ allOf→直引字段的预期观察项）；`npx @redocly/cli lint` 两文件 **valid**。
- 结论：**有条件通过（conditional sign-off）**。结构、信封、红线口径整体正确；M1–M3 为必改项，须在两域进 v1 基线冻结前落地；修订均为描述级/additive，非破坏。落地建议与 A4 在途的 L1506 预授权字段补丁同批（同文件避免写冲突），由 Lead 定序。
- 署名口径：git 历史中「H2 会签/追认」标注（93e6d36、6bc0ade、`tests/contract/openapi_lib.py:41-52` 注释、ADR-001 ⑨⑪ 等）由前任会话 Lead 落笔，非现任 H2 本人签署（参见 042ef82「L83 署名更正」先例）。**自本记录起，两契约终审结论以本记录为准**；历史标注与本记录不冲突处视为事实描述，冲突处以本记录为准。

## 通过项（核对清单）

| 项 | 依据 | 结论 |
|---|---|---|
| 内部信封例外：成功响应直返资源（OpsConfigDocument/Approval/Release/ValidationReport），不套 {data, meta} | ADR-001 ⑩ 双条件（INTERNAL_DOMAINS 注册 + 全路径 /v1/internal/） | ✓ |
| 无 data/meta、无 shared ResponseMeta/disclaimer；`OpsConfigDocument.meta` 为内部 SystemMeta | ⑩ | ✓ |
| 全 schema `additionalProperties:false`；409 扩展体直引 shared Problem properties（无 allOf） | ⑨ | ✓ |
| 不收客户端预填 approval_ref；createApproval/decideApproval 带 Idempotency-Key（同 key 重试返同单，不重复建单/决定） | L51、⑪ | ✓ |
| 乐观锁 If-Match `"v<n>"`（pattern 含引号）+ 三点 diff（base/current/submitted） | 既定 | ✓（触发矩阵见 M1） |
| publish：approval_ref 必带可解析、canary_percent 1–10、无全量参数 | ⑧ | ✓ |
| rollback：切 release 指针不改历史、需新 approval_ref 不得复用 | L128 C-01/C-02 口径 | ✓ |
| decideApproval：人类单条决定、不可复用（已决定/已失效 → 409）、reason minLength 8；A15 不入 decided_by | 决策 #5、⑧ | ✓ |
| 审批事件 append-only；green_auto_pass 由审批事务记录 auto_pass，不伪装人类 | ⑧ | ✓ |
| enum 全 lowercase（9e85839 修复）；environment query 为路由键，与 body 不一致 → 400 VALIDATION_ERROR 以 query 为准 | ⑪ | ✓ |
| 内部客户端独立入口 `packages/api-client/src/internal/`；CI 禁入 ApiPaths | ⑩、30f7263 | ✓ |
| 错误码词表含 CONFLICT/PRECONDITION_FAILED；错误统一 problem+json + shared Problem 单一真源 | ⑨ | ✓（openapi_lib 注释口径待 A11 按 M1 同步） |
| RankingStrategy.window 封闭 d1/d5/d20；ImpactScope 封闭 6 值 | ⑧ | ✓ |
| Idempotency-Key 语义写入 description；decideApproval「仅人类」服务端强制 | 决策 #5 精神 | ✓（见 N1） |

## 必改项（进 v1 基线前，均为描述级/additive）

### M1 409/412 触发矩阵矛盾（阻塞 A11 断言与 A8 错误处理确定性）

现状矛盾：
- `contracts/config/openapi.yaml:20-21`（info）与 `:132-134`（PUT 描述）：「PUT 必须带 If-Match…冲突返回 409 + 三点 diff」；`:1124-1127` ConfigConflictProblem：「409 冲突响应…（由 PUT 的 If-Match/版本冲突触发）」
- 对撞：`:527-528` PreconditionFailed：「If-Match 与当前版本不一致（412）」；`tests/contract/openapi_lib.py:41-42` 注释：「PRECONDITION_FAILED（412：If-Match 不匹配）」
- `:226`（submit 描述）：「draft 的 expected_version 必须与当前版本一致，否则 409」，但 submit 的 409 声明体是 ApprovalConflictProblem（`:246-247`，不带 diff，语义归属错误）
- publish（`:289-292`）同时声明 409 ApprovalConflict + 412 PreconditionFailed，无触发归属说明

**H2 裁定（契约终审权限，must_decide）——触发矩阵：**

| 触发 | 状态码/响应体 | 理由 |
|---|---|---|
| PUT If-Match 与当前版本不符 | **409 + ConfigConflictProblem（三点 diff）** | 契约三处文本 + CONTRACT-MAP + Console mock 一致；409=需 rebase 的冲突，diff 是解决冲突的输入（对 RFC 9110「If-Match→412」的有意偏离，此处记录为例外） |
| submit/publish 的 body expected_version 与当前版本不符 | **412 + PreconditionFailed** | body 前置条件不满足；与 shared 0.2.3「412 = If-Match/前置条件不满足」对齐；412=客户端状态过期，刷新重试即可，无需 rebase |
| approval_ref 不可解析 / 非 approved / 与 config_id+version 绑定不符 / 重复决定 / 重复建单 | **409 + ApprovalConflictProblem**（可带 approval_ref/current_status） | ⑧/⑨ 既定，不变 |
| approval 域一切状态冲突 | 409 + ApprovalConflictProblem；**禁止 412** | ADR-001 D5 既定，不变 |

落地修订：
1. `:527-528` PreconditionFailed 描述改为：「前置条件不满足：submit/publish 的 expected_version 与当前版本不一致。PUT 的 If-Match 不符走 409 + 三点 diff（见 ConfigConflictProblem）。」
2. `:226`「否则 409」改「否则 412」；submit 响应增 `'412': PreconditionFailed`（现 409 ApprovalConflict 保留为审批状态冲突）。
3. publish operation description 写明 409（审批状态/绑定冲突）与 412（expected_version 不符）各自触发条件。
4. `tests/contract/openapi_lib.py:42` 注释同步（A11 写域）。
5. ADR-001 D5 补一句口径注记（H2 随后落笔）。

**落地状态（2026-11-06，L0 批复 L135.3，H2 落笔）**：①②③已落契约文本（config openapi.yaml：PreconditionFailed 描述、submit 描述+412 响应、publish 描述 409/412 归属）；④A11 已落地并经 H2 核验一致（openapi_lib.py:41-48，含 RFC 9110 偏离注记）；⑤ADR-001 D5 补注待办（H2）。

### M2 approval_ref pattern 未锁 UUIDv7（对齐 decisions L51）

现状：多处 `pattern: '^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`（config L836/924/945/968/1005 等；approval 的 ApprovalRefPath/ApprovalDecision/ApprovalApplication/ApprovalEvent）接受任意 UUID（含 v4），与 L51「apr_<uuidv7>、DB CHECK 拒非 UUIDv7、约束落在值形状」不一致；approval Location 头 `^/v1/internal/approvals/apr_[0-9a-f-]{36}$` 同样未锁版本位。

**H2 裁定**：统一收紧为
`^apr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
（版本位 7 + 变体位 [89ab]），Location 头同步收紧。v1 基线前收紧=非破坏；基线后=破坏性，须走 D5/D6 + H2 签字。DB CHECK 兜底不变，契约先行。

**落地状态（2026-11-06，L0 批 L135.3，H2 落笔）**：config 6 处（L842/930/951/974/1011/1039）+ approval 4 处（L308/513/532/570）+ approval Location 头（L68）已全部收紧为上述 pattern。连锁：tests/contract/specimens/*.json（17 文件）样例 ref `apr_12345678-1234-1234-1234-123456789abc` 非 UUIDv7 被新 pattern 正确拒绝（pytest 6 failed 同根：provider 报文校验 + impl gate 自检/CLI 全部指向该样例值）——待 A7 换 v7 形态样例（例 `apr_12345678-1234-7abc-8def-123456789abc`）后重跑全绿；tests/ 写权属 A7，H2 不代改。

### M3 L51 跨环境分段前缀（prod:/staging:）与 wire pattern 冲突的裁定

现状：pattern 不允许冒号前缀；若 wire 允许 `prod:apr_…` 则与 L51 形态一致，但现有 pattern/ApprovalRefPath/Location 全部拒绝。

**H2 裁定**：**wire 层只走裸 `apr_<uuidv7>`**；环境语义由 `subject.environment` / `environment` query 承载（listApprovals 已支持过滤）；带分段前缀形态仅限 DB/审计域内部存储（如确需），前后缀转换在服务端处理、不上契约。请 A4 在 L1506 补丁中以 description 注记「wire=裸 ref；跨环境前缀不上 wire」；若审计事件确需前缀形态上 wire，另行提请 H2 修订 pattern。

**落地状态（2026-11-06，L0 批 L135.3，H2 落笔）**：config/approval 两域 info.description 已加「wire=裸 ref（pattern 已锁版本位/变体位）；跨环境前缀不上 wire，环境语义由 environment 字段承载」注记。Console 侧对齐见 N4。

## 应改/观察项

- **S1**：PUT 幂等 upsert 与 404 语义并存模糊（PUT 404 已声明但「config_id 不存在时创建 or 404」未写明）——A4 定实现语义后由 H2 补注 description。
- **S2（已知缺口，非本次阻塞）**：T6 紧急通道 break_glass/event_key 与预授权字段（valid_from/valid_until/confirm_deadline/signoff_state/incident_id，L1506）未入契约——A4 在途补丁范围；补丁完成后回签 H2 终审（同文件增量）。
- **S3**：ApprovalEvaluation.policy_snapshot 是否记录 policy 双分区 sha（L130 分区签发后 c_end + internal 两份 sha）——待 H3/A4 确认需求后 additive 加字段。
- **N1**：decideApproval「仅人类」无 schema 级强制手段，靠 description + 服务端强制（符合决策 #5 精神）；A11 以服务端测试断言 agent 调用 403。
- **N2**：CONTRACT-MAP config_id「ops.home-feed」点号示例与 pattern 不允许点的差异，MAP 已注明 adapter 映射（`:38`）——无需契约改动。
- **N3**：署名口径更正见文首；前任标注的「H2 追认」以本记录替代。
- **N4**：C-APP-01 裁案 b（Console 删 approval_ref 输入框）——与 M2/M3 wire 口径一致，**裁定来源 L135.4（L0，2026-11-06）**，此处备查标注。

## 下一步（供 Lead 定序）

1. ~~M1–M3 落地~~ **已完成**（L0 批 L135.3，H2 落笔者；见变更记录 v1.1）；specimen fixture 换 v7 样例（A7）后重跑 tests/contract + redocly 确认全绿；两域进 v1 基线后按 D5/D6 挂 oasdiff。
2. ~~A11 同步 openapi_lib.py 注释~~ **已完成并经 H2 核验**（M1 第 4 点）。
3. ADR-001 D5 口径注记（H2，待办）。
4. S2 补丁（A4 增量文本：break_glass/event_key + 预授权字段）到齐后同批落笔并回签 H2 终审。
5. ownership.yaml L134 补录复核结论已移交 L0（`crm/` 未建目录必改；`design/` 双登记与 design/docs-design reviewer 不一致为观察项）。

## 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-06 | v1.0 | 现任 H2 终审：有条件通过；M1（409/412 触发矩阵裁定）、M2（UUIDv7 pattern 收紧）、M3（wire 裸 ref 裁定）必改；署名口径更正 |
| 2026-11-06 | v1.1 | M1①②③+M2+M3 落笔（L0 批 L135.3，落笔者 H2）；M1④ A11 完成并核验；N4 C-APP-01 裁案 b 注记（来源 L135.4）；specimen fixture 连锁待 A7 |
