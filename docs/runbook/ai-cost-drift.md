# AI 成本 / 输出质量 / 模型漂移

- runbook_id: RB-AI-001
- owner: A13（执行）· A9（AI/模型）· A3（api）· H4（指标口径）· H5（发布批准）
- 最后演练: 待 S1 首次演练（date TBD）
- 关联告警: `TokenCostSpike`、`OutputAnomalyRateHigh`、`HumanTakeoverRateHigh`、`ModelDriftAfterChange`
- 关联 SLO: agent_first_token、agent_anomaly_rate、agent_takeover_rate

## 症状

1. `TokenCostSpike`：`agent_cost_usd_per_hour` 超过 7 日同时段基线 2 倍，持续 15 分钟。
2. `OutputAnomalyRateHigh`：输出异常率 > 1%（SLO 阈值），或解析失败/空输出/超长截断激增。
3. `HumanTakeoverRateHigh`：人工接管率 > 5%，或某模型/prompt 版本接管率显著高于其他版本。
4. `ModelDriftAfterChange`：模型或 prompt 版本变更后 1 小时内，核心指标（首 token、异常率、接管率、成本/请求）相对变更前漂移超阈。
5. 用户侧反馈：AI 摘要/解读内容明显变差、答非所问、格式破坏。

## 影响

- 成本：token 成本失控会直接吃掉毛利（预算见 `infra/monitoring/slo.yaml` 的 cost guardrail）。
- 质量：异常输出与高接管率违反 AI 四条护栏，可能误导投资判断，需按 P1/P2 处理。
- 漂移：模型/prompt 变更后的隐性漂移最难发现，必须在变更窗口内主动对比。

## 判断（≤10 分钟）

1. 确认版本：`market_sense_build_info{prompt_version,model_version}`，比对最近一次配置发布记录。
2. 分模型/分档位看：`agent_cost_usd_total`、`agent_requests_total`、`agent_output_anomaly_total`、`agent_human_takeover_total` 的 `rate()`，定位是全局还是单版本。
3. 看首 token：`agent_first_token_seconds` P95 是否同时劣化（区分「模型慢」与「prompt 变长」）。
4. 看上游模型供应商状态与限流/降级返回（429/5xx/内容过滤）。
5. 若有 golden 评测集：跑一次离线评测（A9 提供命令），与上一版本对比。

## 止血

1. 回滚 AI 配置：把 prompt/model 版本从 `published` 回退到上一版本（走配置发布流程；生产需 H5 批准，A13 执行）。
2. 若成本突增来自重试风暴：启用熔断（`AI_MAX_RETRIES=1`、`AI_TIMEOUT_MS=8000`）并限制单用户并发。
3. 若异常率来自某模型供应商：切到备用模型（已登记的 model routing 配置），并记录切换时间与版本。
4. 若接管率升高但成本正常：优先降级为「模板 + 规则」确定性输出，关闭 AI 解读入口（feature flag），等待修复。
5. 恢复判据：异常率 ≤1%、接管率 ≤5%、成本/小时回到基线 1.5 倍内，且连续 30 分钟稳定。

禁止：直接改线上 prompt 文本、绕过配置发布流程改模型路由、为了降成本静默降低输出质量而不记录。

## 升级

- 成本 > 预算 120% 或异常率 > 5% → P1，升级 H5 + A9 + lead。
- 涉及用户可见错误内容 → H5 决定是否公告/下线入口；合规风险同步 F2/F3 跟踪人。
- 模型供应商侧故障 → A9 对接，A13 只执行降级/切换。

## 复盘

- 24 小时内：给出成本增量归因（请求量 vs token/请求 vs 重试）、质量指标对比表。
- 48 小时内：把本次场景加入 golden 评测与告警阈值校准；prompt 变更必须附离线评测报告。
- 每月复核一次成本基线，防止「基线漂移掩盖持续上涨」。

## AI 四项监控对照

| 监控项           | 指标                                 | 告警                    | 阈值                 |
| ---------------- | ------------------------------------ | ----------------------- | -------------------- |
| token 成本       | `agent_cost_usd_total`               | `TokenCostSpike`        | > 2× 7 日基线        |
| 输出异常率       | `agent_output_anomaly_total`         | `OutputAnomalyRateHigh` | > 1%                 |
| 人工接管率       | `agent_human_takeover_total`         | `HumanTakeoverRateHigh` | > 5%                 |
| 模型/prompt 漂移 | `market_sense_build_info` + 上述四项 | `ModelDriftAfterChange` | 变更后 1h 漂移 > 30% |
