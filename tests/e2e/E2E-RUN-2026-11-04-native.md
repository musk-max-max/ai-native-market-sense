# E2E 首跑记录：无 docker 原生栈（2026-11-04）

> **结论：首次真跑 8 通过 / 1 失败（脚手架耦合，已修）/ 2 未运行；修复后 10 passed / 1 skipped；
> 2026-11-04 起 replay 代理 + 19 条合成录制后 **11 passed / 1 skipped（4.8s）**，P0-10 已转绿
> （skip=P0-11 hold 未开，不假绿）。** 仍**不是** docker 真栈/CI 证据：本轮全部用原生进程，
> 镜像构建未验证（Dlv-4），不能替代 `ci/BUILD-SMOKE.md` / 真栈首跑。

> **容器构建未验证（Dlv-4）**：本轮没有任何一次 `docker compose build` / `up`；镜像只在等价命令下验证过。
> 首跑前先看 `ci/BUILD-SMOKE.md` 与 RUNBOOK §0，别把 10 passed 读成「真栈可用」。

环境：macOS 本机，**没有 docker / docker compose**。
Lead 用原生进程拼出真栈，首次让 11 条用例打到真实产品上。

## 1. 环境构成（Lead 手工搭建）

| 组件 | 形态 |
|---|---|
| PostgreSQL | 本机 `postgresql@16`，数据目录 `.state/pgdata`，端口 **55432**；手工执行 `warehouse/dwd/schema.sql` + `serving/schema.sql` |
| 数据 | A1 的 `ods-smoke` 灌 ODS，再跑**真** `warehouse.load` 写库（不是 fixture 造数） |
| api | 真 `services/api`，端口 **8081** |
| web | 真 `web/h5/server.mjs`（构建产物 `dist/`），端口 **3000**，`/v1` 反代 api，`/healthz` 200 |
| 登录态 | `E2E_AUTH_TOKEN=dev-token`；web 读 `localStorage['e2e_token']` 并在请求层带 Bearer |
| 准入 | `E2E_SKIP_PREFLIGHT=1`（绕过 preflight；当时状态文件靠手工写 `{"decision":"READY","reasons":[]}` 才跑起来） |

执行命令：

```bash
E2E_SKIP_PREFLIGHT=1 E2E_AUTH_TOKEN=dev-token npx playwright test
```

## 2. 用例结果

| 用例 | 结果 | 说明 |
|---|---|---|
| E2E-P0-00 首屏 6 元素 / 数据来源 | ✅ 通过 | 390×844 首屏无滚动可见（当时用文本断言；data-source 属性断言随后补上） |
| E2E-P0-01 打开个股页 | ✅ 通过 | 标题/代码与路由一致 |
| E2E-P0-02 行情价格/涨跌幅 | ✅ 通过 | 价格 >0、带币种、来自 API 数值；涨跌幅 `^[+-]\d+(\.\d+)?%$` |
| E2E-P0-03 as_of 严格一致 | ✅ 通过 | UI 文本与 API `source.as_of` 字符串严格相等 |
| E2E-P0-04 stale 双向一致 | ✅ 通过 | `staleness_ms` ≤15min 不标；>15min 必标 |
| E2E-P0-05 免责常驻/版本一致 | ✅ 通过 | 不可关闭，版本与 API meta 一致 |
| E2E-P0-06 restricted 矩阵 403 | ✅ 通过 | 403 + Problem `ENTITLEMENT_RESTRICTED`；基础信息 200 且无行情数字 |
| E2E-P0-07 基本面摘要 | ✅ 通过 | `report_period` / `statement_basis` 来自 API（当时 A2 财务切片已落） |
| E2E-P0-08 加自选 UI+API+DB | ❌→✅ 首跑失败 / 修复后通过 | 首跑：`dbQuery` 写死 `docker compose exec`，无 compose 抛错；产品侧当时是对的（`POST /v1/watchlist` 200，`watchlist_items` 有行）。修法：`dbQuery` 支持 `E2E_PG_DSN`/`PG_DSN`/`DATABASE_URL` 直连 `psql`。复跑走 `psql <dsn>`，UI + API + DB 三处一致。 |
| E2E-P0-09 刷新后自选仍在 | ✅ 通过（复跑） | 依赖 P0-08 的 DB 断言；复跑一并转绿 |
| E2E-P0-10 未录制请求显式失败 | ⏸ **BLOCKED(no recordings)**（首跑时）→ 资产已就绪，待复跑 | 首跑时 replay 未启动且 `recordings/` 为 0 条（缺资产 ≠ 缺环境）。**L32 后已有 19 条合成录制**（`SYNTHETIC-*`/`9999.99`，不落真实报文），P0-10 已改为「已录制→200 回放、未录制→503 `FIXTURE_MISSING`」三段断言，起 replay 即可复跑 |

## 2b. 修复后复跑（同一原生栈，Lead 2026-11-04）

```bash
E2E_BASE_URL=http://127.0.0.1:3000 E2E_AUTH_TOKEN=dev-token \
E2E_PG_DSN='postgresql://ms@localhost:55432/market_sense' E2E_SKIP_PREFLIGHT=1 \
npx playwright test
→ 10 passed, 1 skipped (5.2s)
```

- P0-08 / P0-09 转绿，DB 断言首次真正落到 PG（不再是「生产侧手验」旁证）。
- P0-10 skipped：`replay ready=false`（代理未起、录制 0 条）。当时语义记 **BLOCKED(no recordings)**：
  先有录制资产，再起代理才有意义。**后续**：合成录制已入库（19 条，L32），起 replay 后 P0-10 可复跑
  （`FIXTURES_DIR=tests/fixtures/tushare PORT=18081 python3 tests/e2e/tushare-replay/server.py`）。
- 开场日志 `已写 READY（bypass）… replay ready=false`，bypass 语义可读、不再静默 skip。

## 2c. 全量复跑：含 replay 代理与合成录制（A12 2026-11-04）

```bash
# 三个原生进程（本机无 docker）
FIXTURES_DIR=tests/fixtures/tushare PORT=18081 python3 tests/e2e/tushare-replay/server.py
PORT=8081 HOST=127.0.0.1 DATABASE_URL=postgresql://ms@localhost:55432/market_sense E2E_MODE=1 \
  APP_PROFILE=e2e E2E_AUTH_TOKEN=dev-token ENTITLEMENT_TIER=c_end_display \
  ENTITLEMENT_EXPIRES_AT=2030-12-31T00:00:00Z RATE_LIMIT_IP_PER_MIN=600 RATE_LIMIT_IP_BURST=120 \
  DATA_SOURCE_MODE=replay TUSHARE_API_URL=http://127.0.0.1:18080 node services/api/dist/services/api/src/server.js
cd web/h5 && PORT=3000 HOST=127.0.0.1 API_BASE_URL=http://127.0.0.1:8081 WEB_DIST_DIR=dist node server.mjs

cd tests/e2e && E2E_BASE_URL=http://127.0.0.1:3000 E2E_AUTH_TOKEN=dev-token \
  E2E_PG_DSN=postgresql://ms@localhost:55432/market_sense E2E_SKIP_PREFLIGHT=1 \
  E2E_REPLAY_URL=http://127.0.0.1:18081 npx playwright test
→ 11 passed, 1 skipped (4.8s)
```

- **P0-10 转绿**：已录制 daily 500 回放 200 且 `data.items` 非空；未录制 688981.SH → 503
  `FIXTURE_MISSING` 无 `data`；产品层未录制标的非 200 + Problem + error-banner 不渲价格。
  资产是 L32 合成录制（19 条，`SYNTHETIC-*`/`9999.99`），**不是真实 tushare 报文**。
- P0-11 skip：hold 控制未开（`E2E_HOLD_ENABLED!=1`），符合「不假绿」约定。
- 两处本机环境修复（非用例缺陷，已写进 RUNBOOK §6）：
  1. 原生 PG schema 旧，缺 `display_safe` 列（api 500 `column "display_safe" does not exist`）。
     修：`psql $DSN -f infra/db/migrations/002_display_safe.sql` → `DROP VIEW IF EXISTS serving.serving_instrument;`
     → `psql -f warehouse/serving/schema.sql` → `bash infra/db/seed-serving-fixture.sh --dsn "$DSN"`
     （直接 `CREATE OR REPLACE VIEW` 会报 `cannot change name of view column "source" to "display_safe"`）。
  2. A0 限流（单 IP 60/min、burst 10）让 serial 套件第 3 条 P0-02 撞 429：E2E 栈需
     `RATE_LIMIT_IP_PER_MIN=600 RATE_LIMIT_IP_BURST=120`；compose api 已显式放宽（生产默认不变），
     `validate_compose.py` 68/68 含该项断言。

## 2d. fail-closed DOM（H4 门禁 #5）：严格口径已上线

- `specs/p0-stock-page.spec.js` 新增 `assertNoNumericLeak(page)`：价格/涨跌 testid 存在且带文本即
  **失败**（不再用 `toBeHidden()` 把「藏起来」当「没有」）；扫描整个 DOM（含 hidden / 骨架屏 /
  数字类 class / `::before`、`::after` content），占位 `0`、`0.00`、`--`、`—`、`NaN`、`undefined`、
  `null` 一律算泄露；免责 + 不可用提示必须可见。挂到 P0-06 受限分支与新增 `E2E-P0-12`。
- 受限档实跑（api :8082 `ENTITLEMENT_TIER=internal_eval` + web :3001）暴露一个**真缺口**：
  `web/h5/src/components/DisclaimerNotice.tsx` 的 `DisclaimerUnavailable`（403 无 disclaimer 元数据时的
  兜底块）没有 `data-testid={TID.disclaimer}`，页面上看得到但测试契约拿不到 → P0-06/P0-12 红。
  修在 A7 写域（一行），断言不放宽；修后这两条应转绿。

## 3. 本次暴露的问题与处置

1. **`dbQuery` 绑定编排方式**（Lead 裁定：断言不应依赖 docker）。
   处置：`lib/harness.js` 增加 `E2E_PG_DSN` / `PG_DSN` 直连 `psql` 分支；无 DSN 才回退
   `docker compose exec`；两条路径查同一张表。失败时给明确错误，不静默返回 false。
2. **preflight 把「compose 起来了」当成「系统可测」**。
   处置：STACK 判定改为「api `/healthz` 可达且 `data_ready=true`」；replay 单独判定，只影响 P0-10，
   不达标时其余 10 条照跑（READY + `P0-10_SKIP` 注记）。
3. **`E2E_SKIP_PREFLIGHT=1` 静默跳过**：global-setup 直接 return，状态文件不存在 → harness 默认 skip 全部。
   处置：bypass 时 global-setup 写 `READY` 状态（含 `replay.ready` 探测）；状态文件缺失时
   `harness.status()` 直接抛 `STATUS_FILE_MISSING`，不再默认 skip。
4. **数据来源断言锚文案**：改为锚 `data-source` 属性（A7 DOM 契约），文案不再进断言。

## 4. 后续待办

- [x] 用 `E2E_PG_DSN` 路径重跑 P0-08/09（真栈原生，无 compose），确认 DB 三处一致（10 passed / 1 skipped）。
- [x] P0-10 录制资产：L32 合成录制 19 条（`tests/fixtures/tushare/synthetic/build_recordings.py`，非真实报文）。
- [x] P0-10 复跑：原生 replay + 合成录制 → 11 passed / 1 skipped（§2c）。
- [ ] P0-11 hold 复跑：`E2E_HOLD_ENABLED=1` + 已授权矩阵 + E2E 库跑过 A13 `db-migrate`（A5 迁移）后跑 `--grep E2E-P0-11`；
  未开 hold 时该条 skip（不假绿）。迁移路径统一走 `infra/scripts/db-migrate.sh`，禁止 compose 手写 DDL；
      前置需 A1 固定时钟（否则 `adj_factor` 录制按天失效）。
- [ ] 记录本机真实环境变量与版本，供 A13 的 no-docker CI 参考。
- [ ] 在 docker 真栈上整套重跑，作为 CI 形态的首跑记录（本记录不能替代）。
