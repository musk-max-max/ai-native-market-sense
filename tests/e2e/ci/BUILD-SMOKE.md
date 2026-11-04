# 真栈镜像构建冒烟（`docker compose build`）—— 交付 A13，接远端 CI 第一条

状态：**未验证（Dlv-4 如实标注）**。本机没有 docker，远端未接，所以 `docker compose build` /
`docker compose up` **一次都没跑过**。已做过的是等价命令验证（A0 多阶段命令、A1 CLI 冒烟、A12 compose 静态
44/44 断言），但**没有任何一次真实 build**。在远端第一次跑通之前，禁止把它写成「真栈可用」。

## 1. 前置

- 有 docker + docker compose v2 的机器（或 colima）；远端 CI runner 自带。
- 磁盘 ≥ 4 GiB 可用（镜像 `node:22-alpine`×2 阶段、`python:3.12-slim`×2、`postgres:16-alpine`、
  `redis:7-alpine`，层去重后约 1.8–2.5 GiB；构建缓存另算）。本机只剩 5.9GiB，装 colima + 拉镜像会压到临界，
  因此本机不跑——这是环境事实，不是取舍。
- 从仓库根执行（compose 文件里 `build.context: ../..` 指向仓库根）。

## 2. 冒烟命令（按顺序，第一条先跑这个）

```bash
# 0) 纯静态：变量插值/服务图/端口/卷。不需要镜像。
docker compose -f tests/e2e/docker-compose.yml config -q

# 1) 逐镜像构建（哪个先炸就定位哪个，别一上来 build 全部）
docker compose -f tests/e2e/docker-compose.yml build --pull tushare-replay
docker compose -f tests/e2e/docker-compose.yml build --pull ingest-once
docker compose -f tests/e2e/docker-compose.yml build --pull api
docker compose -f tests/e2e/docker-compose.yml build --pull web

# 2) 全部构建 + 记录大小（CI 里贴进日志，用于磁盘预算）
docker compose -f tests/e2e/docker-compose.yml build --pull
docker image ls --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | sort

# 3) 基础设施起来（真栈最短路径；此步不需要 seed 成功）
docker compose -f tests/e2e/docker-compose.yml up -d --wait postgres redis tushare-replay
docker compose -f tests/e2e/docker-compose.yml ps

# 4) 录播代理自检（记录 19 条合成录制，应 200；未录制应 503）
curl -fsS http://127.0.0.1:18081/__health | python3 -m json.tool

# 5) seed（**预期失败**，见 §3：A1 seed 两步/证据参数/固定时钟未接线；失败时记录输出，不判 build 失败）
for svc in db-migrate ingress warehouse-load ingest-report; do
  docker compose -f tests/e2e/docker-compose.yml --profile seed run --rm "$svc"
  echo "$svc rc=$?" >> seed-rcs.txt
done || true

# 6) 起 api/web 并看 healthz（data_ready=false 是合法状态：SKIP(78) DATA_NOT_READY，不是 build 失败）
docker compose -f tests/e2e/docker-compose.yml up -d --wait api web
curl -fsS http://127.0.0.1:8081/healthz | python3 -m json.tool

# 7) 收尾
docker compose -f tests/e2e/docker-compose.yml down -v
```

## 3. 预期失败点清单（首跑最可能炸这 9 条）

| # | 症状 | 最可能原因 | 归属 | 分类 |
|---|---|---|---|---|
| 1 | `failed to solve: … python:3.12-slim / node:22-alpine` 拉取失败 | runner 无外网/镜像代理未配；`--pull` 强制拉新 | A13（CI 网络） | 环境 |
| 2 | `ERR_PNPM_OUTDATED_LOCKFILE` / `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`（api 或 web） | 根 `pnpm-lock.yaml` 与 workspace 成员 package.json 不齐；`--frozen-lockfile` 拒绝 | A13/各域 owner（锁文件由根维护） | 构建缺陷 |
| 3 | api 构建中 `pnpm --filter @market-sense/api build` 报 TS 错误 | 根 workspace 未包含 `services/market`/`packages/*`；`tsconfig.build.json` 引用越界 | A3/A0 | 构建缺陷 |
| 4 | api 运行期 `Cannot find module dist/services/api/src/server.js` | multi-stage `tsc` outDir 与 CMD 路径不一致（Dockerfile 写死该路径） | A3/A0 | 运行缺陷（build 能过） |
| 5 | web 构建 `pnpm --filter @market-sense/h5... build` 找不到 `@market-sense/api-client` 产物 | api-client 需要先 build（dist 被 `**/dist` 忽略，镜像内未生成）或 workspace COPY 漏项 | A7/A13 | 构建缺陷 |
| 6 | ingest 构建 COPY 失败：`data/instruments/base_info.csv` 不存在 | A1 Dockerfile `COPY data/instruments` 与实际路径不一致 | A1 | 构建缺陷 |
| 7 | ingest 运行期 `FileNotFoundError: config/ingest.yaml` / `load_config()` 失败 | Dockerfile 未 COPY `config/ingest.yaml`（已知，A12 已报 A1） | A1 | 运行缺陷（build 能过） |
| 8 | `up -d --wait` 超时：`api`/`web` unhealthy | HEALTHCHECK 路径/端口与实现不一致（api 8080 `/healthz`、web 3000 `/`）；`start-period` 太短 | A3/A7 | 运行缺陷 |
| 9 | 构建上下文异常大/含本机数据（`.state/pgdata`、`tests/e2e/.state`） | 根 `.dockerignore` 未忽略 `.state`；`**/node_modules` 已忽略 | A13（根文件，已补 `.state`/`**/.state`） | 环境/泄密风险 |
| 10 | api 容器起不来：`MarketConfigError` / `E2E 模式在生产不可用（L44/L46）` | compose api 服务漏写 `APP_PROFILE: e2e`（`APP_PROFILE` 缺省=prod，E2E_MODE 后门被拒；**表现不是报错而是拒启**） | A12（write-scope：tests/e2e/docker-compose.yml，已加 `APP_PROFILE: "e2e"` + validate_compose 断言） | 配置缺陷 |

补充（不是 build 失败，但会被误读）：
- seed 链任一步失败（db-migrate/ingress/warehouse-load/ingest-report）→ 先看 `seed-rcs.txt` 与 `.state/ingest-report.json` 的 `failed_step/failed_reason`；load 失败还可能是 `quality.json` 不合法（A2）或迁移未跑（A13），属 **KNOWN_PENDING**，不是 E2E 通过；
- `healthz.data_ready=false` → 数据没进来，`preflight` 会 `SKIP(78) DATA_NOT_READY`，**不是**「栈没起来」；
- 录制 key 跨天失效（`adj_factor` 锚点取 `market_now()`）→ 表现为 FIXTURE_MISSING/数据不一致，先查时钟注入。

## 4. CI 判定

- `docker compose build` 失败 = **FAIL**（真实构建缺陷，不是环境噪声；先看 §3 归类）。
- `docker compose config -q` 失败 = **FAIL**（compose 文件/变量插值坏了）。
- `__health` 200 但 `recordings=0` = **FAIL**（合成录制应已入库）。
- 第 5/6 步（seed、healthz data_ready）在 A1 接线完成前：记录输出 + 标 `KNOWN_PENDING`，**不要**用 `|| true` 静默吞掉整步——把退出码写进 job summary。
- 上传日志：`docker compose logs --no-color`（全部服务）、镜像大小、`.e2e-status.json`。

## 5. 建议的 CI job 片段

见 `tests/e2e/ci/e2e-job.yml.snippet` 的 `e2e-build-smoke`（A13 接进 workflow；先 `workflow_dispatch`，
稳定后再挂 PR）。
