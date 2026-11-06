# Identity 审计表评估：并入 001 还是独立（A5 评估，2026-11-06）

> 触发：Lead m00960 第 4 项。A4 已交付 `6b44b60`（ADR-008 S1 identity domain），其审计实现为**独立 `identity.audit_events` + `AuditSink` 端口**；`internal_approval` / `internal_access` 两类事件不在 `audit.entitlement_events`（001）的 `event_type` CHECK 白名单内。要求 A5 给结论 + 理由，**不得自行改 001**。

## 结论

**维持 A4 的独立 identity 审计表。不建议并入 001。** 但 A4 需在下一迁移补 append-only 与哈希链（见 §4），这是独立表自身的完整性缺口，不是并入 001 的理由。

## 事实基线

- 001 `audit.entitlement_events`：已签封版（sha `c8116e4f…`，被 A11 CI_MOUNT §7.4、A3 真栈、H4 证据表引用）；`event_type` 9 类 + 002 的 `audit_gap`；append-only + 哈希链 + `verify_entitlement_chain()`；H4/H5/A11 读取；保留 ≥3 年、无 PII 列（H3 六条件未过不得加 `subject_ref`）。
- A4 `identity.audit_events`：`event_id text PK`；`event_type` 9 类（`identity_registration` / `internal_registration` / `identity_login` / `identity_login_denied` / `internal_approval` / `internal_rejection` / `internal_tier_change` / `account_disabled` / `approval_denied`）；`actor_kind` + `actor_model_version`；`subject_user_id` / `subject_application_id` 外键；`before_state` / `after_state`；`reason`；`approval_ref`。**当前无哈希链、无 UPDATE/DELETE 触发器**（append-only 只是应用层约定）。
- 读/写主体：001 = 数据负责人 H4/H5 + A11 抽样；identity = H5/A9 安全审计 + 身份域运维。

## 不并入 001 的理由

1. **001 是已签封版，且被外部证据逐字节引用**。改 `event_type` CHECK 必须重写已执行迁移/新增 additive 迁移，触发 H4/H5 重签与证据表 sha 更新；在 11-12 窗口内属于高成本、低收益变更。
2. **语义与读主体不同**。001 回答“授权/持有/tier/复核等数据访问资格的历史”；identity 回答“人/agent 身份、审批、准入控制的历史”。合并会让同一张表的读者同时持有两类敏感信息，扩大权限面。
3. **保留/删除规则不同**。001 是 ≥3 年留痕且不得带 PII；identity 事件带 `subject_user_id` 等受控标识，注销（H3 §2.3：15 个工作日删除）与数据主体请求需要更细的删除/匿名化机制。独立表可独立演进，避免 001 的 append-only 与 identity 的删除义务互相冲突（当前 001 已硬拦 DELETE）。
4. **写入端隔离**。A4 的 `AuditSink` 端口与 identity 事务同库同事务，独立表写入不改动 001 的写角色（market_app/ci_deploy_writer）；并入后要么让 identity 进程获得 001 的 INSERT 列权限（审计面扩大），要么再开一个角色，复杂度更高。
5. **量级/分区/归档策略不同**。identity 事件随登录/审批增长，与授权状态事件的生命周期不同。

## 若未来出现“必须单一链”的监管要求

不应改 001，而应新增**独立的 identity 链表**（例如 `audit.identity_events_v2`）或为 identity 表加链并做一次性重锚；两者都需 H4/H5 签字。属于 P1+ 的架构决策，不在本次范围。

## 建议 A4 的补强（独立表内部）

| 项 | 建议 | 理由 |
|---|---|---|
| append-only | 加 `BEFORE UPDATE` / `BEFORE DELETE` 触发器 RAISE（与 001 同模式） | 当前无 DB 级保护，A4 integration 文档只说明了“独立表” |
| 哈希链 | 加 `prev_hash` / `hash`（整行 canonical；首条 64 个 0）+ BEFORE INSERT 触发器 + advisory lock + `verify_identity_audit_chain()` | 审计留痕需可举证；可复用 001 的 `audit.iso_utc` / `canonical_json` 函数 |
| 保留期 | 明确保留年限与注销删除流程（删除需签批迁移/受控作业，不得由应用直接 DELETE） | 与 H3 §2.3 的 15 工作日删除对齐 |
| 授权 | identity 写入角色只 `INSERT`；读角色只 `SELECT`；`90_verify_privileges.sql` 加断言 | 与 001 的“检查在读”口径一致，避免只靠 REVOKE |

**Owner**：A4 实施，A5 复核 DDL/断言，H5/A9 签字。A5 本次只交付评估，不改 A4 文件、不改 001。

## 与 AI 审计表的关系

`audit.ai_generation_events`（003，A5）同样独立于 001，理由与此一致（量级、读主体、保留期不同）；三张表各自链、各自角色，互不复用 `audit.entitlement_events`。
