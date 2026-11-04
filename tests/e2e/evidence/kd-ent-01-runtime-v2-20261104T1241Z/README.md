# KD-ENT-01 运行时四观测 v2（A12，单次干净 run）

**结论：四观测全部 PASS，且 hold_id 与「未重启」均有机器证据。**
本目录由 `tests/e2e/scripts/build_kd_ent_runtime_readme.py` 从 transcript / meta.env / 原始 payload
生成（禁止手打 id；生成时校验 hold_id 三方一致、inspect 前后 Id/StartedAt 不变、RestartCount=0）。

- run_id：`kd-ent-01-runtime-v2-20261104T1241Z`
- run 窗口：2026-11-04T20:41:27+08:00 → 2026-11-04T20:42:55+08:00
- 执行人：A12 qa-e2e（ssh root@47.120.16.239）
- 宿主/工具：`heyuan`（Alibaba Cloud ECS 47.120.16.239），Docker 29.9.3，Docker Compose v5.7.0
- 仓库：ECS `/opt/market-sense` @ `/opt/market-sense`；
  compose 规格来自 A12 commit `0a6beba`（`docker-compose.a12.yml` = `tests/e2e/docker-compose.yml`）
- 隔离：project `e2e-ent-positive`，端口 api `127.0.0.1:8091` / web `127.0.0.1:3011` / replay `127.0.0.1:18091`；
  默认 project `market-sense-e2e` 只做只读 curl（8081），未改配置、未重启
- 镜像：`e2e-ent-positive-api:latest`（`sha256:87852ba940e7780b6f24e25e35f30855c5e3457aa6f4a5fd9d2e3503992ae2af`，ECS 上用当前 services 源码重建）
- fixture：`tests/fixtures/tushare` **合成录制**（L32；`SYNTHETIC-*`、`last_price=9999.99`），非真实 tushare 报文

## 四观测（原始 payload 均在目录内）

| 观测 | 结果 | 证据 |
|---|---|---|
| positive `/healthz` | 200，`data_ready=true`、`data_quality=green`、`entitlement_degraded=false` | `healthz-positive.json` / `.headers` |
| positive quote | HTTP/1.1 200 OK，`meta.entitlement={tier:'c_end_display',is_entitled:true}`、`last_price=9999.99`（合成 fixture）、`Cache-Control: no-store` | `quote-positive-200.json` / `.headers` |
| `raise_hold('hold_active','tc-e2e-kdent01')` 后（35s） | HTTP/1.1 403 Forbidden `application/problem+json` `code=ENTITLEMENT_RESTRICTED`、`title=行情数据暂不可用`、`Cache-Control: no-store`（403 无 meta，契约即 Problem） | `quote-hold-403.json` / `.headers` |
| hold 期间 `GET /v1/instruments/SSE:600519` | 200，`meta.entitlement={tier:'internal_eval',is_entitled:false}`（H5 指定 meta.tier 观测点） | `instrument-hold-200.json` / `.headers` |
| `clear_hold` 后恢复 | HTTP/1.1 200 OK 于 **t+0s**（≤30s，recovered=1）、`Cache-Control: no-store` | `quote-recovered-200.json` / `.headers`、transcript `poll recovery` |
| default project（固定 `internal_eval`）同 quote | HTTP/1.1 403 Forbidden `code=ENTITLEMENT_RESTRICTED`、`Cache-Control: no-store` | `quote-default-403.json` / `.headers` |
| 容器未重启（机器证据） | raise 前/clear 后各一次 `docker inspect`：Id `dddb6c299ec37c95b327d5fed2b1d5fa2e94d40eaafc81e5e08652120c9473c5` 相同、`RestartCount=0`、`StartedAt=2026-11-04T12:42:06.613113748Z` 未变、Status=running | `api-inspect-before.json` / `api-inspect-after.json`（原文） |

## 关键 id 与原始输出（同一 run）

- `raise_hold` 返回 hold_id：`59ad583a-b96f-4616-8b6a-a77c0398cd01`（uuid，不是 ticket）；ticket `tc-e2e-kdent01` 由调用方给定
- `raise_hold.out` 原文：`59ad583a-b96f-4616-8b6a-a77c0398cd01`
- transcript 中 `HOLD_ID=59ad583a-b96f-4616-8b6a-a77c0398cd01`（唯一一次出现）
- `clear_hold` 原文见 `clear_hold.out`；恢复轮询见 transcript `poll recovery`

## 运行命令（原样，含 rc）

见 `transcript.log`（`=== <时间>` 分段 + `CMD:` + `rc=`）。主链路：

```sh
C="docker compose -p e2e-ent-positive -f docker-compose.a12.yml \
   -f docker-compose.entitlement-positive.yml -f /tmp/a12-images2.override.yml"
$C down -v --remove-orphans
$C up -d --wait postgres redis tushare-replay
$C --profile seed run --rm db-migrate
$C --profile seed run --rm ingress
$C --profile seed run --rm warehouse-load
$C --profile seed run --rm ingest-report
$C up -d --wait api web
docker inspect e2e-ent-positive-api-1 --format '{{json .}}'   # 见 api-inspect-before.json
curl -sS http://127.0.0.1:8091/healthz
curl -sS http://127.0.0.1:8091/v1/instruments/SSE:600519/quote -H "Authorization: Bearer dev-token"
$C exec -T postgres psql -U market -d market -Atc "SELECT audit.raise_hold('hold_active','tc-e2e-kdent01');"
sleep 35
curl -sS -D - http://127.0.0.1:8091/v1/instruments/SSE:600519/quote -H "Authorization: Bearer dev-token"
curl -sS http://127.0.0.1:8091/v1/instruments/SSE:600519 -H "Authorization: Bearer dev-token"
$C exec -T postgres psql -U market -d market -Atc "SELECT audit.clear_hold('tc-e2e-kdent01','e2e-signer',repeat('a',64));"
# 轮询 quote 至 200（t+0s）
docker inspect e2e-ent-positive-api-1 --format '{{json .}}'   # 见 api-inspect-after.json
```

## 配置偏差与 caveats（如实标注）

- `app-net.internal=false` 仅出现在 positive *e2e run* override 中：compose v5 在 internal 网络上不落地宿主端口映射；
  发布端口仍全部 `127.0.0.1`，公网不可达；**默认栈未改**（仍 `internal:true`）。
- 本 run 验证运行时配置/授权链，**不是镜像构建 provenance**：api 镜像在 ECS 用当前源码重建成功，
  但未走 A13 的 build-smoke job。
- ECS checkout 为 `0c78433`，compose 规格来自本地 commit `0a6beba`；运行前临时覆盖的 POSIX
  `infra/db/bootstrap.sh` / `infra/scripts/db-migrate.sh` 已在跑完后 `git checkout --` 还原。
- 默认栈 `/healthz` 的 `uptime_s=23791` 是长跑实例的累计值，只说明其 healthz 正常，不参与四观测判定。
- 合成 fixture 仅覆盖形状/异常路径，不作 DA 证据、不进 release note/对外材料（H1 口径）。
- 旧 v1 目录 `kd-ent-01-runtime-20261104T1237Z/` 保持原字节冻结（rejected 由外部台账/manifest 记录）。

## 与 v1 的关系

本目录 **supersedes** v1 `kd-ent-01-runtime-20261104T1237Z/` 的 tarball `0cfd1c4f3342c29f1fca065db0b5c1e8e54446f5da445ec35536391531ff5047`。v1 被 H5 拒收（README 手写 hold_id 与 transcript 不一致、缺 inspect 机器证据），已由 A13 标 `historical / rejected-before-sign`，**旧目录原字节冻结、不修改**；行为层四观测在 v2 中重跑复核。

## 文件与校验

- `transcript.log`：host/工具链/仓库/命令/exit code/时间戳 + 原样 stdout（含 `raise_hold` 原始输出行）
- `api-inspect-before.json` / `api-inspect-after.json`：容器 Id/RestartCount/StartedAt/Image 原文
- `healthz-positive.json`、`quote-positive-200.*`、`quote-hold-403.*`、`instrument-hold-200.*`、
  `quote-recovered-200.*`、`quote-default-403.*`、`healthz-default.json`、`raise_hold.out`、`clear_hold.out`
- `meta.env`：run 元数据与 hold_id（由 transcript 同一 run 写入）
- `runtime-evidence.tar.gz` + `PACKAGE.sha256`：打包与外部校验值（README 不内嵌自身 hash）
