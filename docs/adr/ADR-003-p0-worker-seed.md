# ADR-003 P0 worker：one-shot seed job（不做常驻调度）

- **状态**：Accepted（依据 Lead 2026-11-04 指令与决策 #3「模块化单体：api + worker 两进程」、#8「P0 只做个股页竖切片」、C2「不做盘中实时」）；**H2 签字**：PENDING（随 PR；数据侧 H4 会签）
- **起草**：A0 arch-contract（2026-11-04）；**批准人**：H2（H4 会签）；**影响面**：A1（jobs/seed、services/ingest）、A2（warehouse/quality）、A3（读侧）、A11（e2e/conformance）、A13（Helm/CI/runbook）、A14（配置）
- **关联**：决策 #3（api+worker；单 PG/Redis）、#8（P0 竖切片）、C2（收盘后 ≤15min、不做盘中实时）、ADR-002（DataSourcePort + 20 条 conformance）、F1（tushare 授权未定）

## 背景

决策 #3 已定「模块化单体：api 与 worker 两进程」，但 P0 的范围只有**个股页竖切片**（决策 #8）：一条可验证的数据链路（tushare → ODS → DWD → serving → API → H5），配一个能在本地/CI 复现的数据集。

若 P0 就引入常驻 worker（调度循环、常驻消费者、内部重试队列、分布式锁续租），会新增一类必须 7×24 稳定运行的进程与配套告警/升级链路；而 P0 还没有第二个数据源、没有盘中时效要求（C2）、也没有多租户调度需求。常驻调度在竖切片阶段只增加故障面，不增加可验证价值。

另一面：P0 必须有**可重复、可审计、可失败退出**的数据装载动作，供 A11/A12 契约与 e2e 测试固定使用，也为 P1 调度化保留同一入口。

## 决策

**P0 的 worker 形态 = one-shot seed job（ingest-once），不部署常驻调度进程、不装 CronJob。**

- **入口**：`jobs/seed`（A1 拥有），执行一次「拉取 → 校验 → 幂等 upsert → 产出批次记录 → 退出」。
  - 同一二进制/镜像内保留未来 worker 模式的入口，但 P0 只调用 one-shot 子命令（例如 `seed --since ...`）。
  - 退出码语义：`0`=成功；`非 0`=失败（不得吞错）。失败必须落结构化日志 + 批次记录（批次 id、开始/结束、行数、拒绝行数、失败阶段）。
- **触发**：显式触发，三条等价途径供不同角色使用：
  1. 本地/CI：`pnpm`/容器命令直接跑（A11 e2e、A12 回放、A13 CI）；
  2. 发布流程：Helm 部署后的一次性 Kubernetes `Job`（A13 维护 manifest，`restartPolicy: Never`，`backoffLimit` 有界）；
  3. 运维手工：按 A13 runbook 重跑同一 `Job`/命令。
- **不引入**：CronJob、常驻 loop、消息队列、分布式调度器（Airflow/Celery 等）、基于时间的自动重试。
- **幂等与并发**：重复执行必须结果一致（ADR-002 C15 幂等 upsert）；并发/重入用单个数据库 advisory lock 或批次唯一键防护，第二个实例立即以非 0 退出并告警，**不得**排队等待或双写。
- **失败处理**：不做进程内无限重试；适配层允许有界网络重试（ADR-002 端口错误分类），最终失败即非 0 退出；拒绝行落 DLQ 并告警，不静默丢弃（ADR-002 D5）。
- **数据新鲜度与 H5 语义**：P0 的 `meta.source.as_of` 以 seed 运行所对应的数据市场时点为准；H5 必须展示 `as_of`，`staleness_ms > 900000` 按 stale 展示（C2、ADR-001 D4）。**「收盘后自动刷新」属 P1 调度能力，P0 不承诺自动刷新，用显式 seed 满足演示/测试；H5 不得暗示盘中实时。**
- **可观测性**：批次记录（PG 表）+ 结构化日志 + Job 退出码 + 最近一次成功 seed 时间指标；A13 看板/告警基于「最近成功 seed 时间」而不是常驻进程心跳。
- **部署约束**：`infra/helm/` 的 P0 values 中不包含常驻 worker `Deployment`/`CronJob`；只包含一次性 `Job`（或由发布脚本 `kubectl create job` 触发）。

## 被否选项及原因

| 选项 | 否决原因 |
|---|---|
| P0 常驻 worker（loop/scheduler 进程） | 需要 7×24 稳定性、心跳告警、优雅退出、锁续租、积压监控；P0 只有一个数据源、无盘中时效要求（C2），只增故障面与运维成本 |
| P0 用 CronJob 每日定时 ingest | 等效引入调度语义（时区、错过执行、并发策略、失败通知），且“每日自动刷新”不是竖切片的验收条件；一旦上线就被误认为 P1 已完成 |
| 引入 Airflow/Celery/Kafka 等外部编排 | 违反 P0 最小化原则（决策 #8）与模块化单体（决策 #3）；运维面、权限面、成本都不成比例 |
| 只写本地脚本、无 Kubernetes Job | 无法在发布环境留下可审计运行记录，也无法让 A13 runbook/CI 复用同一路径；一次性 Job 是零常驻成本的可审计替代 |
| seed 进程内自建重试队列并常驻拉起重试 | 把失败恢复做成第二个进程；P0 用退出码 + 幂等重跑即可，失败恢复由触发方（CI/runbook）负责 |

## 后果

- P0 数据是「seed 时刻的数据」，所有页面/接口必须如实展示 `as_of`/`staleness`；测试对固定 seed 数据集断言，结果可重复。
- 数据刷新是显式动作：演示前跑 seed；CI/e2e 每次跑 seed 或从固定快照恢复。
- 失败恢复 = 重新触发（幂等保证安全）；没有后台自动补采，P1 调度化时再定义 SLA/重试策略。
- 入口、退出码、批次记录、幂等语义都是 P1 常驻 worker 可复用的稳定接口；P1 只需加「何时触发」的循环，不改数据路径与契约。

## 可逆性评估

- **可逆性高**：P1 引入 CronJob/常驻 worker 时，复用同一 seed/ingest 子命令与幂等语义即可；不改变 API、契约、canonical 模型。
- 若 P0 后期需要每日自动刷新，只需增加调度器与告警，属新增而非推翻；但 H5 的 stale 展示与 `as_of` 契约不得回退。
- 风险点：P0 数据陈旧可能被误读为实时——由 H5 显式 stale 徽标与 `as_of` 兜底（ADR-001 D4），并在发布说明标注「P0 数据为 seed 数据集」。

## 验收与守卫（A11/A13）

- A11：`tests/e2e/` 至少一条「seed 两次 → API 响应一致、行数不变」的用例（C15 幂等）；失败注入（源不可用）断言非 0 退出且不写半成品。
- A11/A13：`tests/contract/` 增加 C01–C20 的 seed 链路覆盖；A12 用固定快照，不依赖实时 tushare。
- A13：Helm P0 values 守卫——`infra/helm/` 下 P0 不应出现常驻 worker 的 `Deployment`/`CronJob`：

```bash
# P0 范围检查：出现常驻 worker 部署或 CronJob 即失败（P1 引入时需先改本 ADR）
if rg -n --glob 'infra/helm/**' -e 'kind:\s*CronJob' -e 'worker.*replicas' . ; then
  echo 'ADR-003 violation: resident worker/scheduler found in P0 Helm values' >&2
  exit 1
fi
```

- A13：runbook（`docs/runbook/` 归 A13）写明 seed 触发、幂等重跑、失败判读与数据时点说明。

## 待定项

- P1 调度形态（CronJob vs 常驻 worker + 队列）与触发时点：待数据源数量、盘中需求（C2 是否升级）、F1 授权范围明确后由 H2/H4 决策；本 ADR 不改写 C2。
- seed 的初始数据范围（个股页竖切片所需的证券清单/日期窗口）由 A1/A2 在实现时确定，需覆盖 A11/A12 夹具。
