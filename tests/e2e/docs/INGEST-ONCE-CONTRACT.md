# ingest-once 契约（A12 定；A1/A2/A3/A13 按此实现）

状态：接口约定已定稿（2026-11-04）；A2 `warehouse.load` 已落地，接线剩余项见 §1b（A1 seed 命令/证据参数、Dockerfile 构建验证）。
Owner: A12（`tests/e2e/` 写域）。任何一方要改语义，先改本文档并通知 A12，否则 E2E 会按旧语义判红。

## 1. seed 流水线（Lead m01015 定稿：单职责镜像，A12 编排，任一非零整栈 fail）

| 步骤 | 服务/命令 | 职责 | 退出码 |
|---|---|---|---|
| 0 migrate | `docs`+compose `db-migrate`：`sh infra/db/bootstrap.sh --env dev` + `sh infra/scripts/db-migrate.sh --env dev` | A13/A2：DWD/serving 底座 + `services/compliance/migrations/*`（含 `audit.*`，A5 唯一真源）+ `20_grants`/`90_verify`；**禁止 compose 手写 DDL** | 0 成功；非 0 = 迁移失败（整栈 fail） |
| 1 ingress | `sh /e2e/ingress_once.sh`（A1 镜像，A12 脚本） | A1：录播回放 → ODS `display/`+`internal/` + audit manifest；写 `/state/step-ingest.json` | 0 成功；21 配额/限流；22 网络/上游 5xx；其他非 0 未分类 |
| 2 load | `sh /e2e/warehouse_load_once.sh`（A2 `warehouse/Dockerfile`，A12 脚本） | A2：`python -m warehouse.load` ODS → DWD/serving 幂等 upsert；写 `quality.json` + `/state/step-load.json` | 0 成功；1 质量红/黑拒绝写库；2 env/DB/schema；3 输入缺失/为空 |
| 3 report | `python3 /e2e/ingest_report.py`（`python:3.12-slim`，A12 脚本） | 聚合 1/2 步退出码 + `quality.json`，原子写 `ingest-report.json` | 0 写成功；30 质量报告缺失/不合法 |
| 4 api/web | 正常 `up -d` | 无论 seed 成败都启动；`/healthz` 200 + `data_ready=false` 供观测 | preflight 判定 |

整体退出码（`up.sh`）：取 seed 链**第一个非零**（0/10/20/30 不再由单容器给出；`up.sh` 直接透传各步 rc），
seed 全 0 才取 preflight 的码。**非零 = 门禁**：`api`/`web` 仍启动（§4），`up.sh` 最终非零。
21/22 是**可选细化**（A1 低成本时给）：只影响 `failed_reason` 排障细节，不改变「第 1 步失败」的状态。
若 A1 不实现，wrapper 记 `INGEST_FAILED:ingest:UNKNOWN` —— 不为此增加额外状态。

## 1b. 容器可写路径与入口（A1 Dockerfile 契约）

| 路径 | 用途 | 挂载 |
|---|---|---|
| `/data/ods` | ODS 批次根，**父目录下含 `display/` 与 `internal/` 两个渠道子目录**（L34）；ingest 写、A2 读父目录 | 具名卷 `ingest-data:/data` |
| `/data/ingest.db` | A1 SQLite 台账（raw/DLQ/checkpoint/quota） | 同上 |
| `/data/audit` | manifest / terms / snapshots 审计根（H4：生产必须 PVC/对象存储，否则不是审计证据） | 同上 |
| `/state/ingest-report.json` | A12 写的报告（§3），api 只读挂载 | `./.state:/state`（ingest-once 可写） |

- 入口固定 `python -m market_ingest <子命令>`（A1 镜像 ENTRYPOINT）；compose `ingress` 服务用 `entrypoint: ["/bin/sh", "/e2e/ingress_once.sh"]` 覆盖（只读挂载 `tests/e2e/scripts/ingress_once.sh`）。
- **2026-11-04 更新（A1 m00920/m00969）**：`MARKET_NOW`（ISO 8601，必须带时区）已落地并覆盖全部时间源；seed 默认 pin
  `2026-11-04T15:00:00+08:00`（与 19 条合成录制 `end_date=20261104` 对齐）。seed 命令**不带 `--synthetic`**（H4：
  synthetic 批次 `display_safe` 恒 false，C 端会被隐藏；e2e 走真实执行路径，`--synthetic` 只留 samples 复现）。
- 镜像内必须有 `config/ingest.yaml`：`services/ingest/Dockerfile:30-31` 已显式
  `COPY services/ingest/config /app/services/ingest/config`（另 `COPY services/ingest` 本身也包含 config，
  显式那层是防裁剪的双保险）；镜像内路径 `/app/services/ingest/config/ingest.yaml`。不再是待修项。
- **2026-11-04（A1 m01742，经 Lead 授权改 A12 脚本）**：`sync-bars` 必须带
  `--instruments "${INGEST_BARS_INSTRUMENTS:-SSE:600519,SZSE:000001}"`。原因：合成录制是 **per-instrument**
  的（`daily` 的 params 含 `ts_code/start_date/end_date`），不带 `--instruments` 时 CLI 走 market-wide
  （params 只有 `trade_date`），键不匹配 → `503 FIXTURE_MISSING`。只取 2 个标的：`SSE:601398` 只在
  fixture、不在 `base_info.csv`；补进 CSV 会破坏「未录制标的非 200」用例，不补则触发 A2 CONS-02
  （bar 必须有 instrument 主数据）。换标的集用同一 env 覆盖，不要改脚本逻辑。
- 确定性：`sync-bars` 的 `adj_factor` 锚点 = `ANCHOR_START` 到「今天」（`market_now()`）。E2E 合成录制按固定
  `end_date` 生成，依赖**固定时钟注入** `MARKET_NOW`（A1 已落地，见上条）；不 pin 则录制跨天失效（时间炸弹）。

## 2. A2 `warehouse.load` 的输出契约

- 幂等：重复执行不产生重复行（upsert）；E2E 会重启/重跑，重复执行必须安全。
- 环境变量：`DATABASE_URL`（必填）、`ODS_DIR`（可选，默认为 A2 自己的 ODS 路径）、
  `QUALITY_REPORT_PATH`（默认 `/state/quality.json`）。
- 质量门禁：`quality_level=red`（或黑名单）时**禁止写库**，退出 1；绿色/黄色可写库并退出 0。
- 质量报告（JSON，原子写 tmp+rename）：

实际调用（A2 已落地的 CLI）：`python -m warehouse.load --ods-root <root> --manifest-root <manifest> --dsn <DATABASE_URL>`（default profile=prod）。

```json
{
  "schema_version": 1,
  "level": "green",
  "score": 0.98,
  "checked_at": "2026-11-04T00:00:00Z",
  "counts": {"dwd_rows": 34, "serving_rows": 34},
  "reasons": []
}
```

`level ∈ {green, yellow, red}`；`score ∈ [0,1]`；`reasons` 为人类可读字符串数组（红/黄时非空）。

## 3. A12 `ingest-report.json`（preflight 读取的唯一真源）

路径：容器 `/state/ingest-report.json`，宿主 `tests/e2e/.state/ingest-report.json`
（可用 `E2E_INGEST_REPORT` 覆盖宿主侧读取路径）。

```json
{
  "schema_version": 1,
  "ready": true,
  "failed_step": null,
  "failed_reason": null,
  "quality_level": "green",
  "quality_score": 0.98,
  "steps": {
    "ingest": {"exit_code": 0, "ok": true},
    "load": {"exit_code": 0, "ok": true},
    "quality": {"exit_code": 0, "ok": true}
  },
  "counts": {"dwd_rows": 34, "serving_rows": 34},
  "checked_at": "2026-11-04T00:00:00Z"
}
```

- `ready = (三步全 0) and (quality_level != "red")`；`failed_step ∈ {null, "ingest", "load", "quality"}`。
- `failed_reason`（`ready=false` 时非空，供 `/healthz.data_ready_reason` 与排障直接引用）：
  `INGEST_FAILED:ingest:QUOTA|UPSTREAM|UNKNOWN`、`INGEST_FAILED:load:QUALITY_RED|ENV|INPUT_MISSING`、
  `INGEST_FAILED:quality:REPORT_INVALID`。
- 原子写（tmp+rename），避免 preflight 读到半截文件。
- 缺失 `quality.json` → 第 3 步退出 30，`ready=false`、`failed_step="quality"`。

## 4. 失败时 `api`/`web` 是否启动 —— 裁定：**启动**

失败有两种，必须可区分，不能都表现为 404：

- **栈没起来**（容器/端口/health 失败）→ preflight `SKIP ENV_STACK_DOWN`。
- **栈起来了但数据没进来**（ingest/load/quality 非零）→ `api /healthz` 仍 200，但 `data_ready=false`，
  preflight `SKIP(78) DATA_NOT_READY:<reason>`；报告与日志直接指到失败步骤。

A3 `/healthz` 响应体（新增字段，200 语义不变）：

```json
{
  "status": "ok",
  "service": "api",
  "domains": ["market"],
  "data_ready": false,
  "data_ready_reason": "INGEST_FAILED:load",
  "data_quality": "red"
}
```

- 数据来源：读 `INGEST_REPORT_PATH`（默认 `/state/ingest-report.json`，compose 只读挂载）。
- `data_ready` 缺失 = 契约未实现；preflight 判 `FAIL:IMPL_MISSING_DATA_READY`（归 A3），不猜。
- reason 取值：`INGEST_REPORT_MISSING`、`INGEST_FAILED:<step>[:DETAIL]`（DETAIL 见 §3 的 `failed_reason`，
  如 `INGEST_FAILED:ingest:QUOTA`）、`QUALITY_RED`、`INGEST_REPORT_INVALID`。

## 5. preflight 判定（A12 实现）

新增 `DATA_READY` 检查：

- healthz 不可达 → 既有 `SKIP ENV_STACK_DOWN`；
- 200 + `data_ready=true` → PASS；
- 200 + `data_ready=false` → `SKIP(78) DATA_NOT_READY:<reason>`（环境/数据未就绪，不是产品缺陷）；
- 200 但缺 `data_ready` → `FAIL IMPL_MISSING_DATA_READY`（A3）；
- report 存在但 `schema_version≠1` / `ready` 与 `steps` 不一致 / `ready=true` 却带 `failed_step` 或 `quality_level="red"` → `FAIL INGEST_REPORT_INVALID`（A12/A2）。

**矛盾检查（报告可信度，比单用例失败严重）**：

- `/healthz.data_ready=true` 却带 `data_ready_reason` → `FAIL:CONTRADICTION`。
- `/healthz.data_ready=true` 但 `ingest-report.json` 缺失 → `FAIL:CONTRADICTION`（报告文件不可信/挂载错）。
- `ingest-report.ready` 与 `/healthz.data_ready` 不一致 → `FAIL:CONTRADICTION`。
- `data_ready=true` 但最终 decision 仍为 `SKIP` 且理由是数据类（`FIXTURES_PENDING` / `FIXTURE_MISSING` /
  `DATA_NOT_READY` / `INGEST_REPORT*`）→ `FAIL:CONTRADICTION`（与数据无关的 `IMPL_ABSENT` / `AUTH_MISSING` 不算矛盾）。
- `data_ready=false` 但 decision 为 `READY` → `FAIL:CONTRADICTION`。

CI 门禁在 `up.sh`（seed 非零即 job 失败）；preflight 的 `SKIP` 只用于本地/无 seed 场景，**不作为 CI 通过理由**。

## 6. compose / up.sh 接线（A12，已落地）

- `db-migrate`（`postgres:16`，仓库根 ro 挂载）：**必须用 `sh`** 调 `sh infra/db/bootstrap.sh --env dev` → `sh infra/scripts/db-migrate.sh --env dev`（postgres:16 只有 dash、无 bash/node；A13 commit f269240 已把两脚本 POSIX 化，`infra/ci/check-posix-scripts.mjs` 防回退）；
  A13 的同一迁移路径（含 `services/compliance/migrations/001_audit_entitlement_events.sql`）。
- `ingress`（A1 `services/ingest/Dockerfile`，entrypoint 覆盖为 `sh /e2e/ingress_once.sh`）：`MARKET_NOW` pin
  `2026-11-04T15:00:00+08:00`；`/data` 具名卷；`/state` rw；写 `step-ingest.json`。
- `warehouse-load`（A2 `warehouse/Dockerfile`，entrypoint `sh /e2e/warehouse_load_once.sh`）：`QUALITY_REPORT_PATH=/state/quality.json`；
  写 `step-load.json`；`restart:"no"`。
- `ingest-report`（`python:3.12-slim`）：聚合 4 步写 `/state/ingest-report.json`；**无论前几步成败都跑**。
- `api`：`./.state:/state:ro` + `INGEST_REPORT_PATH=/state/ingest-report.json`。
- `up.sh`：按 0→1→2→3 顺序 `run --rm`，捕获每一步 rc；**即使失败也继续**跑 report 与起 api/web；
  最终退出码 = seed 链第一个非零，否则 preflight 的码。

**已解除阻塞**：A2 已补 `quality.json` 原子写 + exit 0/1/2/3（m01063）；A2 `warehouse/Dockerfile` 已存在但**未构建验证**（本机无容器运行时）。
**仍待**：A13 的 build smoke 首次真构建；`up.sh` 的 `db-migrate` 在真实库首跑（迁移幂等性）。

## 6b. 历史建议（保留）

- `ingress`：`/state` rw 挂载与 `ingress_once.sh` 只读挂载；entrypoint 覆盖为 `sh /e2e/ingress_once.sh`；
  保留 `${INGEST_ONCE_CMD:-...}` 覆盖能力。镜像需含 A2 load 的 python 依赖（pg 驱动）。
- `api`：增加 `../.state:/state:ro` 与 `INGEST_REPORT_PATH=/state/ingest-report.json`。
- `up.sh`：`run --rm ingest-once` 捕获 rc；**即使 rc≠0 也继续** `up -d --wait api web`（要能观测 `data_ready=false`）；
  打印 report 摘要（失败步骤/质量分）。
  **最终退出码 = 三步里第一个非零的 rc（通常就是 ingest-once 的 10/20/30）；只有 seed 全 0 时才取 preflight 的退出码。**
  不许用 `|| true` 把 seed 失败吞成 preflight 的 SKIP(78)。

## 7. 已知坑

- `tests/e2e` 不在 pnpm workspace：安装依赖必须 `pnpm install --ignore-workspace`，否则会被上溯到根、
  `@playwright/test` 装不进来。CI 由 A13 固化。
