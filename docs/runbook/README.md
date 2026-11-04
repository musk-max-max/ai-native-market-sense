# Runbook 索引（A13 维护）

规则：**每条告警必须绑 runbook，无 runbook 不许上线**（CI 由 `infra/ci/check-runbooks.mjs` 强制）。
每篇 runbook 必须含六段：症状 / 影响 / 判断 / 止血 / 升级 / 复盘。

| runbook                                        | 覆盖场景                                             | 主要告警                                                                                              | 关联 SLO                                                   |
| ---------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [data-source-outage.md](data-source-outage.md) | tushare 不可用、限流、行情 stale、收盘刷新失败       | DataSourceUnavailable、IngestLagHigh、QuoteStalenessHigh、DailyCloseRefreshMissed、StalePageNotMarked | quote_latency、asof_freshness、availability_trading        |
| [release-rollback.md](release-rollback.md)     | 发布异常、灰度卡点、回滚超时                         | ServiceDown、RollbackExceededFiveMinutes、GrayStageStuck、DeployErrorBudgetBurn                       | availability\_\*、gray_stage_dwell、rollback_duration      |
| [quality-score-red.md](quality-score-red.md)   | 数据质量门禁红、质量分骤降                           | QualityGateRed、QualityGateScoreDrop                                                                  | asof_freshness、availability_offhours                      |
| [ai-cost-drift.md](ai-cost-drift.md)           | token 成本、输出异常率、人工接管率、模型/prompt 漂移 | TokenCostSpike、OutputAnomalyRateHigh、HumanTakeoverRateHigh、ModelDriftAfterChange                   | agent_first_token、agent_anomaly_rate、agent_takeover_rate |
| [db-migration.md](db-migration.md)             | DB bootstrap / 迁移失败、只读权限异常、生产迁移回滚  | 暂无告警（CI job db-bootstrap 红灯触发）                                                              | availability_trading、availability_offhours                |

## 值班表与发布证据状态

- 值班表（具名/班次/升级路径，当前 BLOCKED 待人类姓名与寻呼通道）：[`infra/ops/oncall-roster.md`](../infra/ops/oncall-roster.md)
- 发布前置证据状态（H5 四件套 + KD-ENT-01 v2）：[`infra/ops/release-evidence-status.md`](../infra/ops/release-evidence-status.md)

## 值班约定

- 告警路由：critical → A13 立即；warning → 工作时间 A13；AI 相关 → A13 + A9。
- 升级路径：① A13 执行止血 → ② 5 分钟未止血升级服务 owner + lead → ③ 15 分钟升级 H5/人类值班。
- 生产操作与发布：只由 A13 执行，且必须 H5 人类确认；A13 不批准自己的操作。
- 演练：回滚演练每月 1 次（dev）；演练未通过 → 首发 gate 不通过。
