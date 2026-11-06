# E2E 首跑记录：无 docker 原生栈（2026-11-04）

> **结论：首次真跑 8 通过 / 1 失败（脚手架耦合，已修）/ 2 未运行；逐步修复后 10 passed / 1 skipped；
> replay 代理 + 19 条合成录制后 P0-10 转绿；A13 在原生库跑完 `db-migrate`（A5 control 表）后，
> **2026-11-04 全量 11 passed / 2 skipped（35.9s）**：P0-00..09 + P0-11 hold 全绿，
> skip = P0-10（本机 replay 未起）/ P0-12（仅受限档整栈运行）。** 仍**不是** docker 真栈/CI 证据：
> 本轮全部用原生进程，镜像构建未验证（Dlv-4），不能替代 `ci/BUILD-SMOKE.md` / 真栈首跑。

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
- 受限档实跑（api :8082 `ENTITLEMENT_TIER=internal_eval` + web :3001）曾暴露一个**真缺口**：
  `DisclaimerNotice.tsx` 的 `DisclaimerUnavailable`（403 无 disclaimer 元数据时的兜底块）缺
  `data-testid={TID.disclaimer}`，页面上看得到但测试契约拿不到 → P0-06/P0-12 红。A7 已让兜底块与
  正常块共用 `disclaimer` / `disclaimer-text` id（无 version 不渲染），并给个股页 loading/error 分支
  补了 `stock-page`、自选空态接 `state_id=stock-page-empty`。
- **复跑结果（2026-11-04，A7 修复后）**：受限档 `E2E-P0-06|E2E-P0-12` → **2 passed（2.4s）**；
  正常档全量 → **11 passed / 2 skipped（5.5s）**（skip=P0-11 hold 未开、P0-12 仅受限档运行）。
  DOM 口径不变：价格 testid 存在且带文本即失败，hidden/占位/骨架屏/伪元素一律算泄露。

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
- [x] P0-11 hold 复跑：A13 在原生库执行 `db-migrate`（A5 control 表 + `20_grants`）后，
  `E2E_HOLD_ENABLED=1 E2E_ENTITLEMENT_MATRIX=normal` 全量 **11 passed / 2 skipped**；
  P0-11 实测 raise_hold → 403 + 基础信息 200 无行情字段 + 页面降级提示，clear 后 200 + `is_entitled=true`。
  注意 gate 对正常放行态 control 行有 30s 缓存，raise 后需轮询等生效（用例已改为 40s 内轮询，不放宽断言）。
- [x] H4 #5 fail-closed DOM + 页面文案证据包 v2：`tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/`
  （单次 run 全量重采，5 场景 PASS：expired / unauthorized_config / hold_active / hold_stale /
  restricted_malformed_403；详见 §6 与包内 `TRANSCRIPTS.md`）。
  v1 `11-12-f1-dom-20261104T1049Z/` 因拼代际/coverage 错位/README=TRANSCRIPTS 被 H5 拒收，
  自 2026-11-04 13:55 起**原字节冻结**（不加 changelog、不重生成），rejected 由外部台账记；其内容不得再引用。
- [ ] 记录本机真实环境变量与版本，供 A13 的 no-docker CI 参考。
- [ ] 在 docker 真栈上整套重跑，作为 CI 形态的首跑记录（本记录不能替代）。

## 5. 2026-11-04 复跑：hold 转绿 + H4 #5 证据（原生栈，非 docker 真栈）

命令（已授权矩阵 + hold + admin PG DSN；web :3004 → api :8084 反代 /v1）：

```bash
cd tests/e2e
E2E_BASE_URL=http://127.0.0.1:3004 E2E_AUTH_TOKEN=dev-token \
E2E_PG_DSN='postgresql://ms@localhost:55432/market_sense' E2E_SKIP_PREFLIGHT=1 \
E2E_HOLD_ENABLED=1 E2E_ENTITLEMENT_MATRIX=normal E2E_REPLAY_URL=http://127.0.0.1:18081 \
npx playwright test --reporter=line
→ replay 起：12 passed, 1 skipped (33.5s)（skip=P0-12 仅受限档整栈运行）
→ replay 未起：11 passed, 2 skipped（skip 再加 P0-10）
```

- P0-11 第一次跑是真红：`raise_hold` 返回的是 `hold_id`（uuid），用例原来断言返回值含 ticket → 已改为
  「返回值是 uuid + `audit.entitlement_events` 最新 `hold_set` 带 ticket」；另发现 gate 对「未 hold」行有 30s 缓存，
  raise 后立即断言会假红 → 用例改为 40s 内轮询等生效（真实语义，不是放水）。
- skip 说明：replay 未起时 P0-10 跳过（前置缺失）；P0-12（`E2E_FAILCLOSED_SCENARIO=1` 仅受限档整栈运行）在正常档永远 skip。
  replay + 合成录制同跑：**12 passed / 1 skipped**，P0-00..11 全绿。
- H4 #5 证据包：`tests/e2e/evidence/11-12-f1-dom-20261104T1049Z/`（run-scoped，不覆盖旧 run；H4 数据侧 2026-11-04 定版接受，
  绑定 `README.tar.gz` sha256 `419d8f32…` / `evidence-manifest.json` sha256 `8df28469…`，此后不可改动；#5 PASS 由 H5 记）。
  5 个场景 verdict 全 PASS，含 transcript（host/工具链/命令/exit code）、`api.json`、DOM 扫描、截图/HTML；
  `restricted_malformed_403` 在浏览器网络层注入无 title/detail 的 403，页面走整页中性错误态。
- 合成数据边界：replay 录制全部由 `synthetic/build_recordings.py` 生成（L32，无真实 tushare 报文）；
  **本记录不是 DA 组证据，也不得进 release note / 对外材料**。
- 容器构建仍未验证（Dlv-4）：以上全部是原生进程，真栈首跑归 A13 的 `e2e-build-smoke`。

## 6. 2026-11-04 #5 证据包 v2（单次 run 全量重采）

H5（m01941）/H4（m01953/m01963）复核 v1 后指出三处签字件缺陷：coverage 由混合代际 verdict 拼出、
README 文案口径与实现不符（写成 `title + ' ' + detail`，实现为 `title + detail` 无分隔符）、
`TRANSCRIPTS.md` 与 `README.md` 字节相同。v2 一次性重跑五场景并重新打包：

- 证据根目录：`tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/`
- run_id：`11-12-f1-dom-20261104T0557Z-v2`；run 窗口 2026-11-04T13:57:11+08:00 → 13:57:33+08:00
- coverage（**包级 manifest 计算**，per-scenario verdict 不再写跨场景字段）：
  expired / hold_active / hold_stale / restricted_malformed_403 / unauthorized_config 全 PASS
- 绑定值（包外 `PACKAGE.sha256`）：
  - `README.tar.gz` sha256 = `5f8661167cdc7cfc2459aebf2ed5afaf6e21bf072f1fb76722cbeed43da70d9e`
  - `evidence-manifest.json` sha256 = `885f2aa044a03b4d6fbcba2762c25c610d7a0d595c194c5c518530506532d04e`
  - manifest：`schema_version=2`、`assembled=false`、`file_count=36`、36 个文件均 repo-relative + sha256 + size
- `README.md`（报告，4156B）与 `TRANSCRIPTS.md`（五份 transcript 索引，1305B）不同文；
  README 贴实测原文：`title=行情数据暂不可用`、`detail=当前版本暂不提供该标的行情数据`、
  `textContent=行情数据暂不可用当前版本暂不提供该标的行情数据`（无分隔符）、`innerText` 为两段换行（仅人工核对）。
- 采集未改动旧 v1 目录；控制行采集后恢复 `hold=false` 且 `last_reconciled_at` 新鲜。
- 本证据仍为原生进程、L32 合成录制（见 §5 边界）；#5 PASS 由 H5 记，A12 不签。

复跑命令（**会拒绝覆盖已存在的 run 目录**，新 run 自动带 UTC 时间戳）：

```bash
cd /Users/leiyu/Documents/deepseek-harness/default-workspace
python3 tests/e2e/scripts/run_f1_dom_evidence_batch.py
# 前置：api 8082（internal_eval）/8083（expired）/8084（hold）、web 3001/3003/3004，
# 以及 admin PG DSN（hold 控制行）；详情见 RUNBOOK §6 / collect_f1_dom_evidence.py 头部。
```

- **H5 签字（m02105）**：v2 为 #5 DOM 层签字版本——仅 DOM 层 PASS（SSR/PWA/Cache 另验）。
  `README.tar.gz`=`5f866116…`、`evidence-manifest.json`=`885f2aa0…`；36 条逐条 sha256 复算全对，
  tar 37 文件 = 36 条 + manifest 自身；coverage 仅包级。三条 residual 随 PASS 保留。
- **台账规约**：manifest 是 repo-relative path、tar 内是包相对 path，集合比对先去掉 `run_root/` 前缀
  （builder 即按此校验；A11 v4 整包沿用）。v2 之后任何改动开新目录新文件名，不覆盖已签包；v1 的 rejected 记录保持。

## 8. ADR-008 S1 认证后复跑（2026-11-06，A12）

S1（api 外壳 identity preHandler）后 `dev-token` 失效，`E2E_AUTH_TOKEN` 必须是真实 identity JWT；
E2E 侧由 `scripts/seed_e2e_identity.py` + `E2E_AUTH_AUTOSEED=1` 供给（restricted 矩阵写隔离库存量
`internal_eval` 夹具用户，再走真实 `/v1/auth/login` 拿 token；测试不伪造 token）。

- 匿名 401（`E2E-AUTH-01`，新 api build、`internal_eval` 栈）：**2 passed**（AUTH-01 + AUTH-02，1.8s）。
- 已授权档全量（`c_end_display` + expiry 2030，S1 build）：**11 passed / 4 skipped**（5.6s）；
  skip = P0-10（本机 replay 未起）、P0-11（未开 `E2E_HOLD_ENABLED`）、P0-12（仅受限档）、AUTH-02（仅 restricted）。
- 401/403 语义：匿名 7 端点为 401 `UNAUTHENTICATED`；`internal_eval` 认证后 quote/bars/fundamental-summary/
  limit-ladder 为 403 `ENTITLEMENT_RESTRICTED`，instrument 200+`is_entitled=false`（不含行情数值）。
- 注意：该复跑是**原生进程、非 docker 真栈**；identity 夹具用户是 E2E 种子，不构成审批链证据。
