# T6 紧急回滚：三处冲突待 H5 裁定（一页版）

> 呈送：H5（安全运维与发布签字）｜发起：A15 admin-approver｜日期：2026-11-06
> 关联：`configs/rbac/approval-rule-engine.md` §2.6 / §4（C-01、C-02、C-13）
> 状态：**已裁（H5，2026-11-06）**。§1–§5 为呈送原文（保留事实与选项）；裁定见 §7。A15 不裁定，只落判据。

## 0. 为什么要现在裁

规则引擎设计把 T6 的绿档标为**不可用**（approval-rule-engine.md:224），P0 运行态已按「生产回滚一律人审」执行，因此**不裁也能安全运行**。但三处冲突不裁决，T6 永远无法进入任何自动化/绿档；且回滚与 L20 的交互会在真实事故中把「回滚」变成「二次回退」。请按 C-01 / C-02 / C-13 分别给结论。

## 1. C-01：T6「唯一免审批」vs 生产回滚必须 H5 书面 `APPROVAL_REF`

**事实（双方都有已签来源）**
- `agents/decisions.md:147`：T6 紧急回滚是七类审批流中「**唯一免审批**」。
- `docs/runbook/release-rollback.md`（RB-REL-001）：A13 唯一执行者、H5 唯一批准人；**生产回滚必须先取得 H5 书面确认（`APPROVAL_REF`）**，`rollback.sh` 缺失直接拒绝；A13 不自批。
- `agents/decisions.md:640-650`（L51）+ `services/identity/migrations/001_identity.sql:42-58`：`approval_ref` 必须是 `apr_<uuidv7>`，且由审批 API 建单事务生成；compliance 侧 `entitlement_events` 的 `approval_ref` 有形态 CHECK（`services/compliance/migrations/001_audit_entitlement_events.sql:84`），`tier_switch` 还有唯一索引（`:146-147`）。

**矛盾点**：「免审批」意味着没有申请人、没有审批人、没有 `approval_ref`；但生产回滚若伴随 tier/发布状态变更，落库与审计又要求 `approval_ref` 和审批人字段。二者不能同时成立。

**候选选项（请选一或改写）**
- (a) 免的是「回滚前审批」：H5 **事后补签** `APPROVAL_REF`。需明确补签时限、补签是否倒填时间、超时未补是否按未授权处理。
- (b) H5 **预授权** kill switch / 回滚预案（书面化：触发条件、范围、有效期、执行者），触发即执行、事后补单。需明确预授权书谁保管、有效期多长、覆盖哪些故障类型。
- (c) 仅 dev/preview 免审批，**prod 一律 H5 书面确认**（等于确认 runbook 优先）。

**需回答**：选 a / b / c；若选 b，预授权的有效期、覆盖范围与失效条件。

## 2. C-02：T6 回滚 vs L20「未留痕 tier 变更立即 fail-closed」的时序

**事实**
- `agents/decisions.md:236`（L20）：未留痕的 tier 变更按未授权处理，**立即 fail-closed 回 `internal_eval`**；机制 = `tier_state_observed` 与 `deploy` 事件对不上即回退；部署事件分**执行者/审批者**两字段。
- RB-REL-001：含不可逆迁移（DB schema/回填）**禁止 helm rollback**，转前滚修复并升级 H5；冻结窗口交易日 9:15–15:00，紧急发布需 H5 明确批准。

**矛盾点**：T6 回滚会改变部署/tier 状态。若回滚动作写不出 `deploy` 事件（或事件与 `tier_state_observed` 对不上、或审批者字段为空），L20 会把 T6 判成「未授权变更」并再次回退 → 回滚与回退互相打架，形成振荡；而「不可逆迁移禁止回滚」又要求紧急恢复走前滚。

**候选选项（请选一或改写）**
- (i) **先写 `deploy` 事件、再执行回滚**（回滚动作本身也走 L20 留痕）。
- (ii) 回滚先执行、在 **N 分钟窗口内**补写 `deploy` 事件，补写前不触发 L20 回退。需定 N、补写失败怎么办。
- (iii) 仅当回滚**不改 tier** 时才免 L20 事件；改 tier 的回滚一律按 (i)。

**需回答**：顺序选 i / ii / iii；若 ii，补写窗口 N；回滚无人类审批人时 `deploy` 的「审批者」字段填什么（`SYSTEM_ROLLBACK`？空值+原因码？）；不可逆迁移场景下 L20 回退与前滚修复的先后。

## 3. C-13：冻结窗口紧急发布 vs T6 免审批边界

**事实**
- RB-REL-001：冻结窗口（交易日 9:15–15:00）禁止非紧急发布；**紧急发布需 H5 明确批准并记录原因**。
- `agents/decisions.md:147`：T6 只讲「紧急回滚」，未讲「紧急前滚发布」。

**矛盾点**：「T6 免审批」是否被误读为覆盖紧急发布？若不覆盖，紧急前滚发布是否仍需 `approval_ref`？

**需回答**：T6 是否覆盖「紧急前滚发布」；若否，紧急前滚是否仍须 H5 书面 `APPROVAL_REF`。

## 4. 现行 fail-closed 临时处置（不依赖裁定，可继续运行）

1. 生产回滚一律按 RB-REL-001：H5 书面确认 + `APPROVAL_REF`；不按 T6「免审批」放行。
2. 不自动回滚；A13 执行、H5 批准、A15 只记录/路由/催办。
3. 紧急前滚发布按 runbook 要 H5 明确批准，不按 T6 放行。
4. 回滚后按 L20 核对 `tier_state_observed` 与 `deploy` 事件；对不上即升级 H5，不回退掩盖。

## 5. 回执格式（请回 A15 与 Lead）

```
C-01: 选项(a|b|c) + 补充约束
C-02: 选项(i|ii|iii) + N 分钟 + deploy 审批者字段取值
C-13: T6 是否覆盖紧急前滚发布（是/否）+ 是否仍需 APPROVAL_REF
生效范围：prod / staging / dev-preview 分别适用情况
```

## 6. 依据索引

| 事实 | 位置 |
|---|---|
| T6 唯一免审批；七类审批流 | `agents/decisions.md:147` |
| L20 未留痕 tier 变更 fail-closed；deploy 双字段 | `agents/decisions.md:236` |
| L51 审批 id 契约（`apr_<uuidv7>`、建单事务） | `agents/decisions.md:640-650` |
| 回滚 runbook（A13/H5、`APPROVAL_REF`、冻结窗口、不可逆迁移） | `docs/runbook/release-rollback.md` RB-REL-001 |
| identity `approval_ref` CHECK | `services/identity/migrations/001_identity.sql:42-58` |
| compliance `approval_ref` CHECK / `tier_switch` 唯一索引 | `services/compliance/migrations/001_audit_entitlement_events.sql:84,146-147` |

## 7. H5 裁定（2026-11-06 回执，A15 收件摘要）

> 本节作为 `approval-rule-engine.md` §2.6 的来源；正式决策入库（`agents/decisions.md`）由 Lead 决定。

**C-01：选 (b)**——「唯一免审批」= 免**事前逐单**审批，**不免审批人、不免 `approval_ref`**。
- 预授权单：A4 审批 API 建单、H5 批准；`approval_ref` 建单即生成（`prod:apr_<uuidv7>`）。
- 范围写死：env、服务、from→to revision（仅限回滚到**已部署过的 known-good**）、三类已签触发条件、执行者 A13、kill switch、有效期 ≤7 天或本次发布被取代即失效。
- 触发即执行、不再建单；deploy 事件引用预授权 ref。执行后 H5 在事故单**事后签收**（`confirm_at` 单列，**不倒填** `approved_at`）：交易时段 2h、非交易 4h；24h 未签收 → A15 升级 user + **阻塞下一次生产发布**，但本次回滚不追溯为未授权。
- 无有效预授权：prod 按 (c) 逐次 H5 书面 ref；H5 ≥10min 不可达 → A13 **不执行**，Lead→user 升级，先 `READ_ONLY_MODE` 降级。
- 禁止：A13 自批、A15 代填/造 ref、事后补发预授权覆盖已发生回滚、预授权用于不可逆迁移/前滚/扩权/改 `c_end_display`、跨环境复用。

**C-02：选 (i) + 窄 break-glass（N=15）**——先写 deploy 事件，再执行回滚。
- 事件字段：`deployment_uid`（回滚目标用新 uid、不复用旧）、`approval_ref`、`executor=A13`、`approver=H5`（真人主体）、`incident_id`、`target_revision`、`target_tier`；回滚改 tier 另写 `tier_switch`（同 `approval_ref`）；写完再 `helm rollback`。
- 执行失败不自动重试；observed 与 deploy 对不上 → L20 落 `internal_eval`，由 H5 决定前滚/再回滚（不振荡）。
- 审批者字段必须填预授权单上的 H5；**禁止** `SYSTEM_ROLLBACK`/空值；没有人类审批人就不执行需要 deploy 事件的变更（dev 一样，除非 A4 dev 预授权单）。
- break-glass：仅 `ServiceDown`/P1 **且审计库不可用**、且预授权单明确允许；执行后 **15min 内**回写 deploy 事件，超时 L20 生效 + P1 升级。
- 不可逆迁移：仍禁 `helm rollback`；顺序 = 先权限面 fail-closed（`internal_eval`），再前滚修复并写 deploy（H5 紧急发布批准），不得走 T6。

**C-13：否**——T6 只覆盖「回滚到上一已知可用版本」，**不覆盖紧急前滚发布**；冻结窗口内紧急前滚仍须 H5 书面批准并记录原因，`approval_ref` 由 A4 建单生成，T6 预授权不得用于前滚。

**生效范围**：prod = (b) + 事后签收、无预授权按 (c)、L20 按 (i)；staging 同 prod（预授权可 2h 异步确认）；dev/preview 免事前审批，但 deploy 事件若写必须挂 A4 dev 预授权单。

**前置事实（H5 点名）**：A4 建单实现未落地（契约 `contracts/approval/openapi.yaml` 0.1.0 已于 b73c293 落盘，实现待 A4）→ 生成不了 `approval_ref` → **T6 自动化/绿档继续不可用**；prod 回滚仍按 RB-REL-001 人审 + 只读降级兜底，不得用「临时 ref」绕 DB CHECK。A15 只校验预授权 ref/范围/有效期/执行者/`incident_id`，不合格即红；不审批、不代填、不造单。

**机器可判字段（H5 2026-11-06 补充）**：预授权单须带 `valid_from` / `valid_until` / `confirm_deadline`（执行时刻 + 2h/4h，按交易时段规则）/ `signoff_state ∈ {pending,signed}` / `incident_id`；「24h 未签收」= `now > confirm_deadline + 24h && signoff_state=pending`。事件表 **append-only + `event_key` 唯一**：正常路径 deploy 事件在 rollback 前只写一次、写完即最终；break-glass 15min 内补写**这一条**（`event_key=deploy|<deployment_uid>`、`break_glass: true`、原 `approval_ref`、同一 `deployment_uid`），不写第二条、不改写；超时 L20 生效 + A15 报 P1。
