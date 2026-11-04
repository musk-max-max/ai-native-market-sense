# KD-ENT-01 运行时四观测（A12，2026-11-04）

**结论：四观测全部 PASS。** 证据来自 ECS 上独立 project `e2e-ent-positive` 的**单次干净 run**
（`down -v` → 4 步 seed → `up api web` → 四观测），不是拼包；默认 project `market-sense-e2e`
只做了只读 curl（8081），未改其配置、未重启其容器。

- 执行人：A12 qa-e2e（ssh root@47.120.16.239）
- run 窗口：2026-11-04T20:36:40+08:00 → 2026-11-04T20:38:06+08:00（UTC 12:36:40 → 12:38:06）
- run 目录：`tests/e2e/evidence/kd-ent-01-runtime-20261104T1237Z/`
- 宿主/工具：host `heyuan`（47.120.16.239，Ubuntu 5.15），Docker 29.9.3，Docker Compose v5.7.0
- 仓库：ECS `/opt/market-sense` @ `0c78433`；compose 规格来自 A12 commit `7911a03` + 修复 commit `0a6beba`
- 镜像：api `e2e-ent-positive-api:latest`（ECS 上用当前 services 源码重建，20:30 CST）；
  web/replay 复用 `market-sense-e2e-*:latest`；postgres `postgres:16-alpine`、redis `redis:7-alpine`
- 端口：api `127.0.0.1:8091`，web `127.0.0.1:3011`，replay `127.0.0.1:18091`（全部 loopback，公网不可达）
- fixture：`tests/fixtures/tushare` 合成录制（L32；`SYNTHETIC-*`、`last_price=9999.99`），**不是真实 tushare 报文**

## 四观测（原始文件见下）

| # | 观测 | 结果 | 证据 |
|---|---|---|---|
| 1 | positive `/healthz` | 200，`data_ready=true`、`data_quality=green`、`entitlement_degraded=false` | `healthz-positive.json` / `.headers` |
| 2 | positive quote（c_end_display） | 200，`meta.entitlement={tier:"c_end_display",is_entitled:true}`、`last_price=9999.99`、`Cache-Control: no-store` | `quote-positive-200.json` / `.headers` |
| 3 | `audit.raise_hold('hold_active','tc-e2e-kdent01')` 后（等 35s 越过 30s control 缓存） | quote **403** `application/problem+json` `code=ENTITLEMENT_RESTRICTED` + `Cache-Control: no-store`；hold 期间 `GET /v1/instruments/SSE:600519` 200 且 `meta.entitlement={tier:"internal_eval",is_entitled:false}`（meta.tier 观测点） | `quote-hold-403.json` / `.headers`、`instrument-hold-200.json` |
| 4 | `audit.clear_hold('tc-e2e-kdent01','e2e-signer',repeat('a',64))` 后 | **t+0s 恢复 200**（≤30s，满足 H5），api `RestartCount=0`、`StartedAt` 未变（20:37:17 CST），无重启 | `quote-recovered-200.json`、transcript 中 `recovered=1` |
| 5 | default project（固定 `internal_eval`）同 quote | **403** 同 Problem + `Cache-Control: no-store` | `quote-default-403.json` / `.headers`、`healthz-default.json` |

`audit.raise_hold` 返回 hold_id `a530b88d-5d74-4323-8e22-507f961746b3`（uuid，不是 ticket）；
ticket `tc-e2e-kdent01` 由调用方给定。hold 控制行在 clear 后为 `hold=f`、`last_reconciled_at` 已刷新。

## 运行命令（原样，含 rc）

```sh
cd /opt/market-sense/tests/e2e
export E2E_API_PORT=8091 E2E_WEB_PORT=3011 E2E_REPLAY_PORT=18091 E2E_AUTH_TOKEN=dev-token
C="docker compose -p e2e-ent-positive -f docker-compose.a12.yml \
   -f docker-compose.entitlement-positive.yml -f /tmp/a12-images2.override.yml"
$C down -v --remove-orphans                               # rc=0
$C up -d --wait postgres redis tushare-replay              # rc=0
$C --profile seed run --rm db-migrate                      # rc=0
$C --profile seed run --rm ingress                         # rc=0
$C --profile seed run --rm warehouse-load                  # rc=0
$C --profile seed run --rm ingest-report                   # rc=0
$C up -d --wait api web                                    # rc=0
curl -sS http://127.0.0.1:8091/healthz
curl -sS http://127.0.0.1:8091/v1/instruments/SSE:600519/quote -H "Authorization: Bearer dev-token"
$C exec -T postgres psql -U market -d market -Atc "SELECT audit.raise_hold('hold_active','tc-e2e-kdent01');"
sleep 35
curl -sS -D - http://127.0.0.1:8091/v1/instruments/SSE:600519/quote -H "Authorization: Bearer dev-token"
$C exec -T postgres psql -U market -d market -Atc "SELECT audit.clear_hold('tc-e2e-kdent01','e2e-signer',repeat('a',64));"
```

完整 stdout/exit code/时间戳见 `transcript.log`；api 启动日志（`Server listening`、hold 403 Problem、
`entitlement 已降级为 internal_eval（reason=hold_active）`）见 `api-startup.log`。

## 本次 run 暴露并已修的四个配置缺陷

这四条不修的话，positive 栈能起但四观测无法全绿；修复已进 commit `0a6beba`。

1. **`app-net internal:true` 在 compose v5 不落地宿主端口**：容器有 PortBindings、宿主无监听（curl 000）。
   修：positive override 把 `networks.app-net.internal` 翻成 `false`（发布端口仍全部 `127.0.0.1`，公网不可达）。
2. **db-migrate 依赖 POSIX 版脚本**：ECS checkout 的 `infra/db/bootstrap.sh` 还是 bash（`Bad substitution`/
   `[[: not found`/`node: not found`），本次运行前用本地 POSIX 版覆盖（运行后已 `git checkout --` 还原）。
3. **`ingest-report.json` 0600 root → api 非 root 读 EACCES**：`/healthz` 报 `data_ready=false
   INGEST_REPORT_INVALID`。修：`tests/e2e/scripts/ingest_report.py` 原子写后 `chmod 0644`（`0a6beba`）。
4. **缺 `DEPLOYMENT_UID` → audit 写入被约束拒绝**：`entitlement_events_observed_required_chk` 要求
   `tier_state_observed` 带 deployment_uid，缺失时 `audit_write_failed` 使 `entitlement_degraded=true`。
   修：默认 compose 加 `DEPLOYMENT_UID: e2e-default`、positive 加 `e2e-ent-positive`（`0a6beba`，validator 82/82）。

## Caveats（如实标注，不夸张）

- 本 run 验证的是**运行时配置/授权链**，不是镜像构建 provenance：api 镜像在 ECS 上用当前源码
  `docker compose build` 重建成功（未发现构建失败），但没有走 A13 的 build-smoke job。
- ECS checkout 是 `0c78433`，不是本地 HEAD；compose 规格（`docker-compose.a12.yml` + positive）来自
  本地 `7911a03`+`0a6beba` 内容；运行后已把临时覆盖的 infra 脚本还原为 checkout 版本。
- 默认栈的 403 观测只做 GET（8081），未做写入/迁移/重启；默认栈本身仍是旧 api 镜像（13:41 构建）。
- 合成 fixture 仅用于形状/异常路径覆盖，不作 DA 证据、不进 release note/对外材料（H1 口径）。
- 旧 v1 DOM 证据目录 `11-12-f1-dom-20261104T1049Z/` 保持原字节冻结，本目录与其无混代际关系。

## 文件与校验

- `transcript.log`：头部 host/工具链/仓库/命令/时间戳 + 原样 stdout 与 exit code
- `healthz-positive.json`、`quote-positive-200.*`、`quote-hold-403.*`、`instrument-hold-200.json`、
  `quote-recovered-200.json`、`quote-default-403.*`、`healthz-default.json`、`api-startup.log`
- `runtime-evidence.tar.gz`：上述文件的打包（不含自身）；`PACKAGE.sha256` 给出 tar 与关键文件 sha256
- 归一化：本 README 中路径均相对仓库根；manifest 登记由 A13（owner）执行，authority=authoritative
