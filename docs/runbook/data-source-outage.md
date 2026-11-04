# 数据源不可用 / 行情 stale（tushare）

- runbook_id: RB-DATA-001
- owner: A13（执行）· H4（数据负责人）· A1（ingest）
- 最后演练: 待 S1 首次演练（date TBD）
- 关联告警: `DataSourceUnavailable`、`IngestLagHigh`、`QuoteStalenessHigh`、`DailyCloseRefreshMissed`、`StalePageNotMarked`
- 关联 SLO: quote_latency、asof_freshness、availability_trading

## 症状

满足任一条即进入本流程：

1. Alertmanager 收到 `DataSourceUnavailable`（tushare 连续 5 分钟成功率 < 90%）。
2. `market_quote_age_seconds` > 300s，或盘中行情 P95 延迟 > 300ms 持续 10 分钟。
3. ingest 的 `ingest_records_total{status="error"}` 速率突增，或 worker 日志出现 `429`、`5xx`、`timeout`、`积分不足`。
4. 15:15 后 `DailyCloseRefreshMissed`（收盘刷新任务 15 分钟未成功）。
5. 上线后 `StalePageNotMarked` 触发：页面数据已超 15 分钟但 `market_page_stale_flag=0`（这是 C2=A 的违规状态，必须当 P1 处理）。

## 影响

- 交易时段用户看到旧价，可能据此下单 → **误导风险**，属最高优先级（P1）。
- 行情 P95 ≤ 300ms 与「收盘后 ≤15min」两个 SLO 同时在烧预算；99.9% 月度预算仅 43 分钟。
- 页面未显式标 stale 时，用户无法区分「数据旧」与「数据错」，合规与口碑风险放大（C2=A 红线）。

## 判断（≤5 分钟）

按顺序定位，每步记录时间戳：

1. `curl -s localhost:9090/api/v1/query?query=market_quote_age_seconds` 看年龄与 feed 标签。
2. 看 tushare 官方状态：`https://tushare.pro/` 公告、API 返回码（-2001 权限、-2002 频率、-2003 积分）。
3. 查配额：当日调用量 / 10000 积分档位的每分钟上限（A1 维护的 quota 表）。
4. 查网络出口：`curl -sv https://api.tushare.pro`（DNS、TLS、egress 白名单）。
5. 区分单 feed 还是全 feed：`market_quote_age_seconds{feed=~".+"}`。
6. 查最近 30 分钟是否有发布：`market_sense_build_info` + 发布记录（灰度阶段停留在 1/10 时优先怀疑发布）。

## 止血

目标：**5 分钟内让页面要么有新鲜数据，要么明确标 stale**。

1. 打开降级开关（IaC 管理，`infra/helm/market-sense/values-*.yaml` 的 `ingest.fallback=last_good`）：保留 last-known-good 数据并强制 `market_page_stale_flag=1`，页面顶部显示 stale 横幅与数据时间。
2. 若为频率限制：把 ingest 退避到 `INGEST_MIN_INTERVAL`（默认 60s）并暂停非关键回补任务（jobs 中 `backfill` 类全部暂停）。
3. 若为单域数据坏：只关该域的读路径（feature flag `FEATURE_<DOMAIN>=off`），其余域继续。
4. 若为上游全挂：切备用源仅限已获授权的数据源；**未获 tushare 商用授权前不得切换或缓存转售**（F1 未关闭，H4 书面回复为准）。
5. 若确认是本次发布引入：立即转 `docs/runbook/release-rollback.md`，先回滚再排查。
6. 在状态页/客服话术里同步「行情延迟」；H5 决定是否对外公告。

禁止：手工改生产 Deployment/Pod、手工改数据库、绕过 pipeline 直接 `kubectl exec` 补数据。

## 升级

- 5 分钟未止血 → 升级 H4 + A1 + lead，并拉 incident 频道（P1）。
- 15 分钟未恢复 → 升级 H5（对外沟通/是否停推）与人类值班。
- 涉及授权/合规（转售、缓存、展示范围）→ 立即升级 H5 + F1/F3 跟踪人，不得自行判断。
- 生产操作只能 A13 执行且需 H5 确认；A13 不批准自己的操作。

## 复盘

- 24 小时内出时间线（检测→止血→恢复），标注 SLO 燃烧分钟数与影响用户量。
- 48 小时内补：新增/修正告警、runbook 增补、回归测试（fixtures 加该故障场景）。
- 追踪项登记到 `docs/metrics/` 的 SLO 事故表；未关闭前该告警不得调低阈值。

## 验证命令（恢复判据）

```bash
# 1) 数据年龄回到阈值内（交易时段 < 60s，收盘后 < 15min）
curl -s localhost:9090/api/v1/query --data-urlencode 'query=market_quote_age_seconds' | jq '.data.result'
# 2) 页面 stale 标记与实际年龄一致
curl -s localhost:9090/api/v1/query --data-urlencode 'query=market_page_stale_flag' | jq '.data.result'
# 3) 收盘刷新成功时间
curl -s localhost:9090/api/v1/query --data-urlencode 'query=time()-batch_job_last_success_timestamp_seconds{job="daily-close-refresh"}' | jq '.data.result'
# 4) ingest 错误率回落
curl -s localhost:9090/api/v1/query --data-urlencode 'query=rate(ingest_records_total{status="error"}[5m])' | jq '.data.result'
```
