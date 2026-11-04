# 发布回滚 / 灰度卡点（≤5 分钟）

- runbook_id: RB-REL-001
- owner: A13（唯一执行者）· H5（唯一批准人）· 各服务 owner 协助判断
- 最后演练: 待 S1 首次演练（date TBD）
- 关联告警: `ServiceDown`、`RollbackExceededFiveMinutes`、`GrayStageStuck`、`DeployErrorBudgetBurn`
- 关联 SLO: availability_trading、availability_offhours、gray_stage_dwell、rollback_duration

## 症状

1. `RollbackExceededFiveMinutes`：回滚开始 5 分钟仍未回到上一健康版本。
2. `GrayStageStuck`：某灰度档位停留 > 90 分钟（要求每档 ≥30 分钟且必须推进）。
3. `DeployErrorBudgetBurn`：发布后 30 分钟错误率/延迟燃烧率 > 14.4×。
4. `ServiceDown`：`up{job="api"} == 0` 持续 2 分钟，或核心路由 5xx > 5%。
5. 人工发现：灰度档位页面/接口行为异常、`market_sense_build_info` 版本与预期不符。

## 影响

- 生产可用性直接受损；交易时段（9:15–15:00）发布冻结窗口内出现异常 = P1。
- 回滚超过 5 分钟即违反 SLO，并触发 H5 升级；月度 99.9% 预算仅约 43 分钟。
- 灰度档位卡住会让坏版本停留在部分用户，扩大影响面。

## 判断（≤3 分钟）

1. 看发布记录：`helm history market-sense -n <ns>` 确认 current/previous revision 与时间。
2. 对比 `market_sense_build_info{version,git_sha}` 与预期版本；看 Pod ready 数与重启次数。
3. 看错误是否只在灰度 cohort：`http_requests_total{release_stage=~"1|10"}` 与 100% 桶对比。
4. 判断是否可回滚：本版本是否含**不可逆迁移**（DB schema/数据回填）。含不可逆迁移 → 禁止 `helm rollback`，走前滚修复并升级 H5。
5. 记录：当前 revision、上一 healthy revision、开始回滚时间（用于 SLO 计时）。

## 止血（目标 ≤5 分钟）

1. 冻结灰度：把 `release.paused=true`（Helm values 或发布流水线参数），阻止继续放量。
2. 执行一键回滚（IaC/流水线，禁止手工 kubectl）：

```bash
# 生产：必须先取得 H5 在发布工单/审批通道的书面确认；A13 执行并回报
infra/scripts/rollback.sh production market-sense
# dev/preview 可直接执行
infra/scripts/rollback.sh dev market-sense
```

3. 脚本内固定动作：`helm rollback <release> <上一 healthy revision> --wait --timeout 5m --atomic`，随后跑 3 条 smoke（健康检查、行情接口、自选股接口）。
4. 回滚后确认 `market_sense_build_info` 回到旧版本、错误率回落；在发布工单标注「rolled back at HH:MM，耗时 N 秒」。
5. 若 5 分钟内未回到健康：停止继续回滚尝试，升级 H5 + lead，切到只读降级（feature flag `READ_ONLY_MODE=1`），保全现场。

禁止：手工 `kubectl set image`、手工改 replicas、跳过灰度直接全量、在冻结窗口（9:15–15:00）发布非紧急变更。

## 执行人、降级阈值与证据（H5 验收）

- **执行人**：A13（唯一）；**批准人**：H5（唯一）。生产回滚/发布缺 H5 书面确认 → `rollback.sh` 直接拒绝（`APPROVAL_REF`）；A13 不自批。
- **谁在什么条件下执行**：`RollbackExceededFiveMinutes` / `ServiceDown` / 发布后 30min 燃烧率 >14.4× → A13 立即回滚；含不可逆迁移 → 不回滚，转前滚修复并升级 H5。
- **降级阈值**：5min 未恢复 → 升级 H5 + lead，切只读降级；交易时段 9:15–15:00 非紧急发布一律冻结。
- **入口进程约束**（A11 断言）：健康端口未监听 / 进程退出码非 0 必须由 readiness/liveness 阻断流量，**不得**由 entrypoint 兜底成「500 继续跑」。Helm 不覆盖 command/args（仅 worker 指定 `node dist/worker.js`），镜像行为以 A3 Dockerfile 为准。
- **证据包**：四样证据（本 runbook、具名值班表、寻呼实测回执、staging 15min 自动降级演练）按 RB-ENT-001「证据包」一次性交齐，缺一按未提交。

## 升级

- 回滚启动即通知 H5（批准人）与 lead；5 分钟未完成 → P1，升级人类值班。
- 涉及数据迁移/不可逆变更 → 立即 H5 + A3（api）+ A2（数据），禁止自行决定降级 schema。
- 发布卡点争议（是否继续灰度、是否回滚）→ **不由 A13 自批**，交 H5 裁定。

## 复盘

- 24 小时内复盘：为什么坏版本进入灰度、门禁为何未拦住、回滚耗时分布。
- 48 小时内补自动化：把本次故障场景变成 e2e/契约测试或发布后自动校验（check-runbooks 同步更新）。
- 回滚演练每月 1 次（dev），记录实际耗时；未演练通过的版本不允许首发（A13 gate）。

## 灰度与冻结规则（发布时对照）

| 档位 | 流量 | 最短停留 | 通过条件                      |
| ---- | ---- | -------- | ----------------------------- |
| 1    | 1%   | ≥30min   | 错误率、P95、agent 四项无异常 |
| 2    | 10%  | ≥30min   | 同上 + 无人工接管率上升       |
| 3    | 50%  | ≥30min   | 同上 + H5 确认                |
| 4    | 100% | —        | 全量后 30min 观察期           |

冻结窗口：A 股交易日 9:15–15:00 禁止非紧急发布；紧急发布需 H5 明确批准并记录原因。
