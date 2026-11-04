# 监控 / SLO / 告警（A13 维护）

本目录是 SLO 与告警的**单一真源**，CI 门禁 `pnpm ci:runbooks`（`infra/ci/check-runbooks.mjs`）强制：

- 每条告警必须有 `annotations.runbook_url`，且指向 `docs/runbook/` 下存在的文件；
- 每个 SLO 必须给出 `runbook`；
- AI 四项（token 成本 / 输出异常率 / 人工接管率 / 模型漂移）必须有告警；
- C2=A 专项 `StalePageNotMarked` 必须存在（数据 >15min 且页面未标 stale = 违规）。

## 文件

| 路径                               | 作用                                               |
| ---------------------------------- | -------------------------------------------------- |
| `slo.yaml`                         | 9 条 SLO + 发布冻结/灰度/成本护栏策略（C2=A 口径） |
| `alerts/market-sense.rules.yaml`   | Prometheus recording + alerting 规则，18 条告警    |
| `dashboards/market-sense-slo.json` | Grafana 看板（SLO + AI 四项 + 发布）               |
| `alertmanager/alertmanager.yaml`   | 路由/抑制骨架（critical 立即、warning 工作时间）   |

## 指标契约（app / ingest / worker 负责暴露，A13 负责校验）

| 指标                                                                                             | 类型      | 标签                                                 | 语义                                       |
| ------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------- | ------------------------------------------ |
| `http_requests_total`                                                                            | counter   | job, route, code                                     | API 请求；5xx 计入错误预算                 |
| `http_request_duration_seconds_bucket`                                                           | histogram | route                                                | 请求延迟（含非行情路由）                   |
| `market_quote_latency_seconds_bucket`                                                            | histogram | feed                                                 | 行情服务端耗时（SLO P95≤300ms）            |
| `market_quote_age_seconds`                                                                       | gauge     | feed                                                 | 最新行情数据年龄                           |
| `market_asof_age_seconds`                                                                        | gauge     | page                                                 | 页面数据年龄（C2=A 判定用）                |
| `market_page_stale_flag`                                                                         | gauge     | page                                                 | 页面是否显式标 stale（1=已标）             |
| `ingest_records_total`                                                                           | counter   | source, status                                       | ingest 成功/失败记录数                     |
| `batch_job_last_success_timestamp_seconds`                                                       | gauge     | job                                                  | 批次任务最后成功时间                       |
| `quality_gate_status`                                                                            | gauge     | gate                                                 | 1=绿，0=红（质量门禁）                     |
| `market_sense:quality_score_current` / `_median7d`                                               | gauge     | —                                                    | gold 层质量分与 7 日中位数                 |
| `agent_requests_total`                                                                           | counter   | model, prompt_version                                | AI 请求数（异常率/接管率分母）             |
| `agent_first_token_seconds_bucket`                                                               | histogram | model, prompt_version                                | AI 首 token 延迟（SLO P95≤2s）             |
| `agent_output_anomaly_total`                                                                     | counter   | model, prompt_version                                | 解析失败/空输出/截断等异常                 |
| `agent_human_takeover_total`                                                                     | counter   | model, prompt_version                                | 人工接管次数                               |
| `agent_cost_usd_total`                                                                           | counter   | model, prompt_version                                | token 成本（按版本化价格表折算）           |
| `market_sense_model_rollout_age_seconds`                                                         | gauge     | model / prompt_version                               | 当前模型/prompt 版本已上线秒数（漂移判定） |
| `market_sense_build_info`                                                                        | gauge     | version, git_sha, env, model_version, prompt_version | 构建/版本信息（发布与漂移关联）            |
| `release_gray_stage` / `release_gray_stage_dwell_seconds`                                        | gauge     | service, stage                                       | 灰度档位与停留时长                         |
| `deploy_in_progress` / `deploy_rollback_in_progress` / `deploy_rollback_start_timestamp_seconds` | gauge     | service                                              | 发布/回滚状态（回滚 SLO）                  |
| `up`                                                                                             | gauge     | job                                                  | Prometheus 抓取存活                        |

命名约定：`market_sense:` 前缀是 recording rule 产物；原始指标不带前缀。所有指标必须由 `/metrics` 暴露（Prometheus 拉取），禁止 push 绕过。

## 部署方式

1. Prometheus 抓取由 Helm chart 的 `monitoring.prometheusRule.enabled` 与 ServiceMonitor 控制（`infra/helm/market-sense`）。
2. 规则文件通过 ConfigMap/`PrometheusRule` CRD 下发；本地校验用固定版本 `promtool`（CI 固定 3.0.1）：
   ```bash
   promtool check rules infra/monitoring/alerts/market-sense.rules.yaml
   ```
3. Grafana 看板导入 `dashboards/market-sense-slo.json`（数据源变量 `DS_PROMETHEUS`）。
4. Alertmanager 路由：`critical` → 值班（A13）立即；`warning` → 工作时间。**所有**告警带 `runbook_url`。

## C2=A 口径（必须一致）

- **不**承诺盘中 `as_of ≤ 60s`；承诺「收盘后 ≤15min 可查」。
- 页面在数据超 15min 时必须显式标 stale；`StalePageNotMarked` = 违规（critical）。
- 大盘/个股页展示数据时间与 stale 状态是产品验收项，不是可选项。

## 变更流程

改 SLO/阈值/告警 = 改本目录 PR，必须 H5（SLO/发布）+ H4（指标口径）评审；A13 执行合并。
禁止在 Alertmanager/Grafana UI 上手改生产规则（会被下次部署覆盖，且违反「生产只走 IaC」）。
