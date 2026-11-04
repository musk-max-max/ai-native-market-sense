# RB-ENT-001 · 授权 hold / 15 分钟自动降级演练与证据

- **Runbook ID**：RB-ENT-001
- **Owner**：A13（执行）/ H5（签字门禁）/ A3（服务侧 fail-closed 实现）/ A5（审计 DDL）
- **关联**：`docs/runbook/release-rollback.md`、`infra/db/sql/20_grants.sql`、`infra/monitoring/alerts/market-sense.rules.yaml`、`audit.entitlement_hold`、`audit.raise_hold/clear_hold/mark_reconciled`
- **SLO 关联**：availability_trading（降级会影响展示可用性，但**不得**因此放弃 fail-closed）

## 症状

演练 / 真实事故会表现为以下一种或多种：

- `entitlement_reconciler_last_success_timestamp_seconds` 超过 300s 未更新（告警 `EntitlementReconcilerStale`）。
- `audit.entitlement_hold.last_reconciled_at` 超过 15min，服务侧生效 tier 自动降为 `internal_eval`（页面出现受限提示而非行情）。
- `audit.entitlement_hold.hold = true`（reconciler 置 hold：deploy 记录与 observed 状态按 `deployment_uid` 不匹配）。
- 审计事件流出现 `unauthorized_config`（启动自检 sha256(tier|expires_at) 与流水线注入不一致）。
- 发布流水线在 entitlement 门禁处阻断（tier != internal_eval 而 expires 缺失 / approval_ref 无法解析）。

## 影响

- 用户侧：C 端行情从「展示」降为「受限/内部评估」，属**有意的** fail-closed；宁可不可用，不可未授权展示。
- 业务侧：降级期间个股页行情不可用，交易时段计入 availability SLO 消耗；但**不得**以恢复可用性为由绕过 hold。
- 发布侧：hold 未清则不得继续发布；hold 只能人工清，自动对账一致**不会**自动清除（H5 卡点）。
- 合规侧：hold set/clear 与 unauthorized_config 都是审计证据；缺失即视为「未留痕」，按未授权处理。

## 判断

1. 确认降级原因：查 `audit.entitlement_hold`（hold、hold_id、set_by、set_at、last_reconciled_at）与最近 `audit.entitlement_events`（deploy / tier_switch / hold_set / unauthorized_config）。
2. 查 reconciler CronJob 最近成功时间与日志；`last_reconciled_at` >15min = 服务侧应已 fail-closed（H5 认这个 P1 代价）。
3. 查流水线注入的 `ENTITLEMENT_CONFIG_EXPECTED_SHA256` 与服务实际 `sha256(tier|expires_at)` 是否一致；不一致即 `unauthorized_config`。
4. 查错误文案分支：`relation/column does not exist` = 迁移未跑（RB-DB-001）；`permission denied` = 授权/角色问题（90_verify + 20_grants）；两者排障方向不同，不要混。
5. 判断是否可恢复：**只有人**能清 hold；恢复条件 = 根因消除 + T2 工单 + H5 签字 + A13 执行 `audit.clear_hold(ticket, signer, doc_sha)`。

## 止血

- **降级已自动发生**：不要关告警、不要手工把 tier 调回展示档。先确认 hold/unauthorized 原因，再按判断步骤处理。
- **reconciler 停摆**：先恢复 CronJob（镜像/权限/DB 连通性），心跳恢复后 `mark_reconciled` 自动刷新；期间服务保持 `internal_eval`。
- **错误配置下发**：立即回滚到上一版 Helm values（`infra/scripts/rollback.sh <env> <release>`），tier 恢复 `internal_eval`，再补审批流程。
- **清 hold（唯一人工路径）**：T2 工单 → H5 签字（`doc_sha` 记录签字文档）→ A13 以 `human_hold_clear` 角色执行 `audit.clear_hold(...)`，并在事件流留痕；**禁止**直接 UPDATE 表或「下次对账一致自动清」。
- **发布卡住**：发布只由 A13 执行且须 H5 批准；A13 不自批，也不绕过 entitlement 门禁。
- 交易时段（09:15–15:00）非紧急不改授权/不发布；紧急止血优先降级（fail-closed），而不是放宽授权。

## 升级

1. 5min 内未定位 → A3（服务 fail-closed 实现）+ A5（审计 DDL/函数）+ lead。
2. hold 需清除 / 需恢复展示档 → 立即 H5（签字）+ lead；A13 只执行不自批。
3. 疑似未授权展示（tier 应为 internal_eval 却展示了行情）→ 安全事件口径：保留审计证据、通知 H5/H3，禁止先修后补记录。
4. staging 演练失败或证据缺失 → 按「未提交」处理，H5 不签字；不得用 dev 证据替代 staging。

## 复盘

- 记录：时间线（注入→告警→降级→恢复）、`deployment_uid`、tier/expires/expected sha256、manifest hash、hold_id、执行人、SLO 影响。
- 必答：未确认告警是否在 5min 内送达值班手机并有回执？15min 自动 internal_eval 是否生效？是否有任何路径缓存了带 `meta.entitlement` 的响应（ingress/CDN no-store）？
- 产出：新增/修正监控规则、补 `90_verify_privileges.sql` 断言、更新本 runbook；证据包按下方清单一次性归档。

## 证据包（H5 验收，缺一按「未提交」）

| #   | 证据             | 要求                                                                       | 当前状态                                                                                   |
| --- | ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | runbook          | 含回滚步骤、降级阈值、谁在什么条件下执行                                   | ✅ 本文档 + RB-REL-001 已覆盖；待 H5 复核                                                  |
| 2   | 值班表           | **具名** primary/backup + 时段，抄送 H3/H5                                 | ⏳ 待 Lead/H5 提供人员姓名（A13 只有角色位：A13 primary / A1 backup，姓名不能由 agent 编） |
| 3   | 寻呼实测回执     | 含时间戳 + 接收人，不是「发了」                                            | ⏳ 待 H5 指定寻呼通道（alertmanager webhook 目前是占位 sink）                              |
| 4   | staging 演练记录 | 注入未确认告警 → 15min 自动 internal_eval，记录时间戳/操作人/结果/恢复步骤 | ⏳ 待 staging 环境（本机演练不算 staging）；模板见下                                       |

演练记录模板（每次复制一份，归档到 `ops/drills/`，命名 `YYYY-MM-DD-entitlement-hold.md`）：

```text
日期/时段（Asia/Shanghai）：
环境：staging（kube-context / namespace / release）：
注入方式：<未确认 tier 配置 / 停 reconciler / 篡改 expected sha256>
操作人（执行）：A13；批准人：H5（工单/链接）
告警送达：时间戳 / 接收人 / 回执截图或 ID
自动降级生效时间：注入后 __ 分钟（要求 ≤15min）；生效证据：tier=internal_eval / 事件 unauthorized_config
恢复步骤：__；恢复时间：__
结果：通过 / 失败（失败项与根因）
SLO 影响：__
```
