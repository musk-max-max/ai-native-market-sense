# 发布前置证据状态（H5 四件套 / KD-ENT-01）— 2026-11-04

> 维护：A13。用于 11-06 12:00 / 11-12 签字前对账。**状态只用 PASS / PARTIAL / BLOCKED / NO-ENV / UNVERIFIED，不用「应该没问题」**。

| #   | 证据                                                                            | 状态                   | 现有材料                                                                                                                                                            | 阻塞 / 下一步                                                                                                                                                                         | owner         | 截止                    |
| --- | ------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- |
| 1   | 具名值班表（primary/backup/时段/联系方式）                                      | **BLOCKED**            | `infra/ops/oncall-roster.md`（结构、班次、升级路径、SLA 已定）                                                                                                      | 缺人类值班姓名、手机号、寻呼通道；A13 不得编造。Lead/H5 提供后 1 小时内补齐并登记 manifest                                                                                            | Lead/H5 → A13 | 11-06 12:00             |
| 2   | 寻呼/告警回执（时间戳/接收人/ack）                                              | **BLOCKED**            | `infra/monitoring/alertmanager/alertmanager.yaml` 仅 webhook 占位；无真实电话/短信通道                                                                              | 需 Lead/H5 提供寻呼通道与一名愿意接测试告警的人类；A13 出脚本/取证，人签收                                                                                                            | Lead/H5 → A13 | 11-06 12:00             |
| 3   | staging 15min 未确认 → 自动 `internal_eval` 演练                                | **NO-ENV**             | runbook：`docs/runbook/entitlement-hold-drill.md`；自动降级代码/条件已在 A3 侧                                                                                      | 无 staging 集群/域名；**不拿 E2E 合成环境冒充**。残项：owner A13+A3，staging 到位后演练；若 11-12 前仍无环境按 residual 记录并由 H5 升级                                              | A13/A3        | 11-12（依赖环境）       |
| 4   | 外部 `/healthz`、`/metrics` 404 + Pod 内 200 + helm 静态 + NetworkPolicy 真集群 | **PARTIAL**            | 静态：`infra/evidence/exposure-static-guard-20261104T0615Z.txt`；模板：`infra/evidence/tools/capture-exposure.sh`；runbook：`docs/runbook/exposure-verification.md` | 缺公网 ingress host/网络可达与 k8s 权限（建 Pod/exec）或由有权限方执行；11-06 12:00 入口决策点，无入口则 PARTIAL + 升级                                                               | A13/H5/Lead   | 11-06 12:00（入口决策） |
| 5   | KD-ENT-01 运行时四观测证据包 v2                                                 | **BLOCKED（v1 拒收）** | v1 冻结于 `tests/e2e/evidence/kd-ent-01-runtime-20261104T1237Z/`（manifest 标 `historical/rejected-before-sign`）                                                   | v2 单次 run：transcript 含 hold_id 原始输出 + raise 前/clear 后 `docker inspect`(Id/RestartCount/StartedAt)，README 由 transcript 生成，新目录+`supersedes`；A12 重取证、A13 核验登记 | A12 → A13     | 11-06 12:00             |

## 明确不可用为证据的项

- E2E 合成 fixture / E2E_MODE 栈的「授权正常」结果：只能标 `drill`，不得进签字包（H5 m02905/m03190）。
- 未到人的 webhook 200：是链路可达，不是「到人」。
- `ms-nginx` 临时层：Lead 部署失误的暴露面，已停；其 404/401 记录 `authority: drill`。

## 需要 Lead/H5 的输入（阻塞 1/2）

1. 值班 primary/backup 的**姓名 + 手机号**（或工号+手机），覆盖交易日 08:30–15:30/15:30–22:00/夜间/周末；抄送 H3/H5。
2. 寻呼通道：Alertmanager `sre-pager` 指向的真实电话/短信网关（或替代：值守手机号 + 短信 API），以及一名愿意接收测试告警并回 ack 的人类。
3. 11-06 12:00 入口结论：staging 域名+安全组 / kubeconfig（含建 Pod/exec 权限）/ 明确拿不到（则 #4 记 PARTIAL、由 H5 升级，不拖到 11-12）。
