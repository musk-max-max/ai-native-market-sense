# E2E RUNBOOK —— 首跑定位手册

Owner: A12 qa-e2e。目标：让首跑失败 = 5 分钟内定位到「哪一跳、归谁」，而不是从头读代码。
入口约定不变：真栈 docker-compose + tushare 录播 fixture；CI 禁真实外呼；不为过测试改断言。

## 0. 先说清楚：容器构建**未验证**（Dlv-4 如实标注）

`docker compose build` / `docker compose up` **一次都没在真实 docker 上跑过**：本机没有容器运行时（且只剩 5.9GiB
磁盘，装 colima + 拉镜像会压到临界），仓库也还没接远端。已做的是**等价命令**验证（A0 多阶段构建命令、A1 CLI
冒烟、A12 的 compose 静态 82/82 断言）——**不等于镜像能构建、能起**。

所以：看到「10 passed / 1 skipped」时不要理解为「真栈可用」；首跑（远端接上后）第一条请跑
`tests/e2e/ci/BUILD-SMOKE.md` 的 `docker compose build` 冒烟，预期失败点与归属清单都在那里。**一条 skip 的
可信度，取决于别人是否知道它是 skip。**

## 1. 第一条命令与预期输出

在有 docker 的机器上，从仓库根目录：

```bash
# restricted 矩阵（F1 否决线，默认栈）：默认栈固定 internal_eval，没有任何 tier 环境变量 override
E2E_ENTITLEMENT_MATRIX=restricted bash tests/e2e/scripts/up.sh

# normal 矩阵（P0 主旅程）：加载已授权档 override，独立 project + 独立宿主端口（仅 127.0.0.1）
E2E_COMPOSE_OVERRIDE=docker-compose.entitlement-positive.yml \
E2E_COMPOSE_PROJECT=e2e-ent-positive \
E2E_API_PORT=8091 E2E_WEB_PORT=3011 E2E_REPLAY_PORT=18091 \
E2E_ENTITLEMENT_MATRIX=normal \
bash tests/e2e/scripts/up.sh
# 已授权档 override 配齐 c_end_display / HOLD_CHECK=1 / AUDIT=1 /
# ENTITLEMENT_CONFIG_EXPECTED_SHA256 / ENTITLEMENT_EXPIRES_AT=2030-12-31T00:00:00Z；
# 见 docker-compose.entitlement-positive.yml 与 README §授权矩阵。
#
# 注意：positive override 把 app-net 翻成非 internal。原因是 compose v5 在 internal 网络上
# 不落地宿主端口映射（容器有 PortBindings、宿主 curl 000，KD-ENT-01 v2 实证）。发布端口仍全部
# 127.0.0.1（loopback-only，公网不可达）；默认栈保持 internal:true，不因此改默认拓扑。
# 证据：tests/e2e/evidence/kd-ent-01-runtime-v2-20261104T1243Z/
```

预期输出（按顺序）：

1. （静默）`validate_compose.py --quiet` 退出 0 —— 82 项 compose 静态断言全过；失败会打印断言 ID、期望值与实际值。
2. `==> 启动基础设施（postgres / redis / tushare-replay）`
3. `==> 一次性 ingest（真实 adapter + 录播回放 → PG）`（`--no-seed` 可跳过；将扩为 ingest → load →
   质量报告三步，seed 失败时 api/web 仍会启动但 `/healthz` 报 `data_ready=false`，契约见 `docs/INGEST-ONCE-CONTRACT.md`）
4. `==> 启动 api / web`
5. `==> preflight`，每行格式 `PASS|WARN|FAIL|SKIP  <CHECK_ID>  <说明>`，结尾：

```
DECISION: READY (exit 0)
状态文件：tests/e2e/.e2e-status.json
栈已就绪：web=http://127.0.0.1:3000 api=http://127.0.0.1:8081 replay=http://127.0.0.1:18081
```

预期退出码 **0 (READY)**。
**78 (SKIP)** = 栈起了但实现/录播未就绪，用例会 skip（不是 pass）；**1 (FAIL)** = E2E 资产本身有缺陷。
若看到 `ERROR: 本机没有 docker`：环境问题，找 A13/Lead，不要改 compose 绕过。

然后跑用例：

```bash
cd tests/e2e && pnpm install --ignore-workspace && npx playwright install chromium && npx playwright test
```

预期：13 条 `E2E-P0-00..12`（serial；P0-11 hold 默认 skip 除非 `E2E_HOLD_ENABLED=1`；P0-12 fail-closed 仅 `E2E_FAILCLOSED_SCENARIO=1` 的受限档整栈运行）。失败信息都带 `[hop:web|api.market|api.fundamental|api.watchlist|db]` 标签，报告在 `tests/e2e/playwright-report/`。

## 2. 首跑最可能暴露的三类命名差异

### A. API 路由（最常见）

症状：preflight `SKIP STACK_API`（`/healthz` 非 200），或 spec 里 `apiJson()` 拿到 404/502；若错误体 `code=INSTRUMENT_NOT_FOUND` 说明路由通了但 id 形态不同。

```bash
docker compose -f tests/e2e/docker-compose.yml logs --tail=60 api
curl -sS -o /dev/null -w '%{http_code}  %{url_effective}\n' \
  http://127.0.0.1:8081/healthz \
  'http://127.0.0.1:8081/v1/instruments/SSE:600519/quote'
```

定位：404 → 路径前缀/段名不一致（`/health` vs `/healthz`、`/quotes` vs `/quote`、`/v1` 缺失、`{id}` 段名）；502/503 → api 连不上 PG/replay。
真源是 `contracts/*/openapi.yaml`（A0），不是实现也不是 spec；**spec 不向实现让路**，改实现或改契约（A0 拍板）。

### B. 字段名 / 响应结构

症状：`QuoteResponse.meta 缺失`、`UI 价格 X 不在 API data 数值中`、as_of/stale 不一致、免责版本对不上。

```bash
curl -sS 'http://127.0.0.1:8081/v1/instruments/SSE:600519/quote' | python3 -m json.tool | head -80
curl -sS 'http://127.0.0.1:8081/v1/instruments/SSE:600519/fundamental-summary' | python3 -m json.tool | head -60
```

定位：确认 `meta` 里 `data_source`（或 `source`）的 `as_of`、`staleness_ms`、`entitlement` 落在 shared 契约位置；`data` 字段名 E2E 不预设（价格按数值集合交叉校验，允许展示精度舍入），但 as_of/stale/免责/基本面字段名是契约。
不一致归 A3（api 响应组装）或 A1（adapter→canonical 映射）；E2E 不放宽。

### C. test-id

症状：preflight `FAIL TESTIDS`（spec 引用了 testids.json 未定义的 id），或 `TESTIDS` 报非 kebab-case/重复；P0-00 报 `data-testid=xxx 期望 1 个实际 0`。

```bash
curl -sS 'http://127.0.0.1:3000/stocks/SSE:600519' | grep -o 'data-testid="[^"]*"' | sort -u
docker compose -f tests/e2e/docker-compose.yml exec -T web \
  sh -lc 'grep -rhoE "data-testid=[^,}[:space:]]*" /app | sort -u | head -40'
npx playwright test --grep 'E2E-P0-00' --reporter=line   # 看真实命中的 locator
```

定位：SPA 用 curl 可能拿不到渲染后的 DOM，以 Playwright 输出的 locator 为准。常见差异：属性名 `data-test` vs `data-testid`、camelCase 值、把 `stock-page` 挂在布局 div 的 `id` 上。
契约单一真源：`tests/e2e/testids.json` + `tests/e2e/docs/TESTID-CONVENTION.md`；改契约必须 A7 与 A12 同时改，**不许 spec 迁就实现**。

## 3. SKIP(78) / FAIL(1) / 503 FIXTURE_MISSING 的含义与归属

| 信号（preflight / 日志 / 页面） | 含义 | 不是 | 找谁 |
| --- | --- | --- | --- |
| 退出 78 + `ENV_STACK_DOWN` | api `/healthz` 或 web 不可达 | 数据未落、E2E 资产坏 | 先起栈：`up.sh`（docker）或 §6 原生栈（无 docker）；A13 负责环境 |
| 退出 78 + `IMPL_ABSENT`（reasons 带 `FIXTURES_PENDING`） | 页面/接口 404 未实现，且录播还空 | E2E 资产坏 | A7（web）/ A3（api）/ A1（adapter） |
| 退出 1 + `CONTRADICTION` | `/healthz.data_ready` 与 `ingest-report.json`/判定自相矛盾 | 数据未就绪 | A12（报告生成/判定）；若 healthz 字段错→A3 |
| 用例 `E2E-P0-07` 红（`fundamental-summary` 404/500） | **数据未落，不是 A3 实现缺陷**：A2 财务数据 pending，A1 正给切片 3–5 个标的落最小 `fina_indicator` | 实现坏 | A1/A2 数据落地；不要翻 market 插件代码 |
| 退出 78 + `DATA_NOT_READY:<reason>`（healthz `data_ready=false`） | 栈起来了但数据没进来（ingest/load/质量门禁失败或未 seed） | 栈故障、E2E 资产坏 | 看 `tests/e2e/.state/ingest-report.json` 的 `failed_step`：ingest→A1，load/质量红→A2；缺 report→A12 |
| 退出 1 + `IMPL_MISSING_DATA_READY` | `/healthz` 缺 `data_ready` 字段，A3 未实现契约 | 数据没进来 | A3（见 `docs/INGEST-ONCE-CONTRACT.md` §4） |
| 退出 1 + `INGEST_REPORT_INVALID` | `ingest-report.json` schema 不合法/自相矛盾 | 数据没进来 | A12（报告生成）/ A2（quality.json） |
| 退出 78 + `AUTH_MISSING`（`E2E_AUTH_TOKEN` 为空） | 自选的两条用例 skip，其余可跑 | 失败 | 导出 `E2E_AUTH_TOKEN`，或 CI 注入（A13） |
| P0-06 / P0-12 红（受限档）且 `getByTestId('disclaimer')` not found | 403 无 disclaimer 元数据时走了 `DisclaimerUnavailable` 兜底块，但该块缺 `data-testid=disclaimer`（A7 写域一行修复）；**不要**用「元素存在但没 testid」放宽断言 | 实现缺陷 | A7：`web/h5/src/components/DisclaimerNotice.tsx` 的兜底块补 `TID.disclaimer` |
| P0-00..05 第 3 条起红且 429 | E2E 栈用了生产限流（单 IP 60/min、burst 10）；serial 套件会撞限流，非产品缺陷 | 环境配置 | A12：起 api 时带 `RATE_LIMIT_IP_PER_MIN=600 RATE_LIMIT_IP_BURST=120`（compose 已默认） |
| 退出 78 + `REPLAY` / `FIXTURES` 0 条 | **只影响 P0-10**：录播代理不可达或没有录制；其余 10 条照跑（READY + `P0-10_SKIP` 注记） | 全部用例不可跑 | A12：合成录制已在仓库（19 条），先起 replay（§4b）；仍 0 条再查 fixtures 路径 |
| 退出 78 + `DATA_NOT_READY:INGEST_FAILED:ingest:QUOTA/UPSTREAM` | 第一步 ingest 失败且可细分原因（配额/限流 vs 网络/上游 5xx） | 实现缺陷 | A1（adapter/CLI）；看 `ingest-report.json` 的 `failed_reason`，`UNKNOWN` 表示 A1 未给子码 |
| 退出 1 + `FAIL:ENTITLEMENT:CONTRACT_MISSING_403` | 契约该接口未声明 403（预期内红灯） | 实现缺陷 | A0 契约 bump；修好重跑，别改断言 |
| 退出 1 + `FAIL:ENTITLEMENT:IMPL_WRONG_STATUS` | 契约已声明 403，实现返回错状态/缺 `ENTITLEMENT_RESTRICTED` | E2E 问题 | A3（quote/bars/fundamental-summary 的 403 分支） |
| 退出 1 + `CONFIG_TIER_FAIL_CLOSED` | 默认栈固定 `internal_eval`（fail-closed），但矩阵按 normal 校验 | 实现缺陷 | 不是 bug：按上面 normal 命令加载 `docker-compose.entitlement-positive.yml` 重起 normal 栈；默认栈刻意禁止 tier override（A13/H5 防 fail-open） |
| 退出 1 + `FAIL:ENTITLEMENT:IMPL_LEAKS_F1_NUMBERS` | restricted 下基础信息响应含行情数值字段 | 展示格式问题 | A3（名字可显示、数字不可显示） |
| 退出 1 + `COMPOSE_STATIC`/`SCENARIO`/`TESTIDS`/`QUARANTINE`/`FIXTURES_CORRUPT`/`FIXTURES_MISSING` | E2E 资产或配置真缺陷：结构退化、引用不存在的 id、flaky 超 24h、录制损坏、栈就绪还缺 fixture | 产品 bug、可选项 | A12；flaky 条目必须 24h 内修或删，禁止「先放放」 |
| 页面/接口 503 `FIXTURE_MISSING`（replay 日志 `FIXTURE_MISSING api_name=... key=...`，error-banner 也可能带 code） | adapter 发出了一次**未录制**的 tushare 调用（api_name 或 params 与录制时不同） | 网络故障、tushare 挂了、E2E 环境坏 | A12 与 A1 比对实际请求参数；响应含 `key`/`api_name`/`available_api_names`。**不要录真实报文**（L32）：改合成生成器补齐对应调用，或让 A1 对齐参数 |
| 录制键每天变（`adj_factor` 的 `end_date` = 当天） | adapter 锚点用 `market_now()`，合成录制按固定 `end_date` 生成 | 录制文件损坏 | A1 加固定时钟注入（契约 §1b）；在此之前 E2E 不能稳定跨天跑 |

补充：SKIP 的详细原因都在 `tests/e2e/.e2e-status.json` 的 `reasons` 和 `checks` 里，先看这个文件再问人。

## 4. 更新录播

### 4a 合成录制（默认路径，L32：不落真实 tushare 报文）

```bash
python3 tests/fixtures/tushare/synthetic/build_recordings.py          # 重新生成
python3 tests/fixtures/tushare/synthetic/build_recordings.py --check  # 只校验
```

- 值全伪造且一眼可辨（`SYNTHETIC-甲/乙/丙`、`9999.99`、常量量额）；字段名/结构镜像公开文档。
- 覆盖 P0-00..09 实际打到的 5 个接口（`trade_cal/daily/adj_factor/fina_indicator/income`，共 19 条）。
- 生成后 preflight 的 `FIXTURES_CORRUPT`/`FIXTURES_MANIFEST` 会校验 key/结构/无 token；**不要手改录制**。
- 新增上游调用时：先在 adapter/seed 里跑出实际 `api_name + params`，再让生成器补一条（参数不同 = 不同 key）。

### 4b 起 replay（P0-10 前置；原生栈/无 docker 也可用）

```bash
FIXTURES_DIR=tests/fixtures/tushare PORT=18081 python3 tests/e2e/tushare-replay/server.py &
curl -s http://127.0.0.1:18081/__health | python3 -m json.tool     # recordings>0 才 ready
```

只跑 P0-10：`npx playwright test --grep "E2E-P0-10"`（`E2E_REPLAY_URL` 默认 `http://127.0.0.1:18081`）。

### 4c 真实上游录制（默认禁用，只有 H4 书面批准后才允许）

```bash
A12_ALLOW_REAL_TUSHARE=1 H4_APPROVAL_REF=<审批记录> TUSHARE_TOKEN=*** \
  bash tests/e2e/scripts/record-fixtures.sh
```

- Lead L32：真实报文落仓库 = 上游数据再分发（F1 个人非商业条款），默认路径不用它。
- 未显式 opt-in / 无 `H4_APPROVAL_REF` / `CI=1` 时脚本**拒绝执行**（退出 2），不会静默打真接口。
- `tests/e2e` 不在 pnpm workspace：装依赖必须 `pnpm install --ignore-workspace`（A13 在 CI 固化）。
- 流程：record 模式栈（app-net 开外网）→ 真实产品跑 `scenarios/p0-stock-page.json` 的调用序列 → 代理落盘到 `tests/fixtures/tushare/recordings/`。
- 落盘文件是 raw-source 工件（允许出现 `ts_code` 的目录之一，见 ADR-002 豁免节）。
- **不要用系统时间**：凡「取当前时间」处（`market_now()`、adapter 的 `_clock`）都必须能被显式注入
  （`MARKET_NOW` / `--now`），否则录制会随日期失效、表现为「数据不一致」而非「时钟问题」。

## 5. 无 docker 本机能跑什么

```bash
python3 tests/e2e/scripts/validate_compose.py                     # 45 项静态断言
python3 tests/e2e/scripts/preflight.py --offline                  # 预期 SKIP(78)
python3 -m pytest tests/e2e/tushare-replay/test_server.py tests/e2e/scripts/test_preflight.py
node --check tests/e2e/lib/*.js tests/e2e/specs/*.js tests/e2e/*.config.js
```

有 docker 时首跑走 `bash tests/e2e/scripts/up.sh`（P0 默认路径）；没有 docker 的机器走 §6 原生栈。
两条路径的**准入语义相同**：`/healthz` 可达 + `data_ready=true` 即可测。

## 6. 无 docker 原生栈（A13/A7 已定；Lead 2026-11-04 首跑验证过）

真 PG + 真 `services/api` + 真 `web/h5/server.mjs`，不依赖 compose。断言查库走 `E2E_PG_DSN`，不绑 docker：

```bash
# 1) PG 16（A13 的 .state/pgdata，端口 55432；库/用户按本机情况）
#    建表：warehouse/dwd/schema.sql + serving/schema.sql
# 2) 真写库：python -m warehouse.load（A1 的 ods-smoke 可先灌 ODS）
# 3) api（healthz 要带 data_ready）
DATABASE_URL=postgres://...@127.0.0.1:55432/... PORT=8081 ... <启动 services/api>
# 4) web：先构建，再从 web/h5 起零依赖静态服务
cd web/h5 && pnpm build
PORT=3000 HOST=127.0.0.1 API_BASE_URL=http://127.0.0.1:8081 WEB_DIST_DIR=dist node server.mjs
#    （从仓库根启动必须显式 WEB_DIST_DIR=web/h5/dist；cwd 不对会 404）
# 5) 跑用例：DB 断言直连 DSN，不需要 compose
cd tests/e2e
E2E_BASE_URL=http://127.0.0.1:3000 E2E_AUTH_TOKEN=dev-token E2E_PG_DSN=postgres://...@127.0.0.1:55432/... npx playwright test
```

- `E2E_SKIP_PREFLIGHT=1`：`global-setup` 会写一份 `READY`（含 `replay.ready` 探测），**不会静默 skip**；
  只用于已手工验证环境的排障，不作为 CI 证据。
- `E2E_PG_DSN`（或 `PG_DSN` / `DATABASE_URL`）：有则直连 `psql <dsn>` 查 `watchlist_items`；没有才回退 `docker compose exec`。
  `psql` 不在 PATH 时用 `E2E_PSQL` 指绝对路径。两条路径查同一张表，断言不依赖编排方式。
- 登录态：web 只读 `localStorage['e2e_token']`（`E2E_AUTH_STORAGE_KEY` 可覆盖），请求头自动带
  `Authorization: Bearer <token>`；`E2E_AUTH_TOKEN` 一设，P0-08/09 即可跑。
- 录播代理（replay）只有 P0-10 需要；不启动时 P0-10 会 skip，其余照跑。

## 7. H4 #5 证据包（fail-closed DOM + 页面文案逐字节）

已交付一份 run-scoped 证据（v2，H5/H4 复核后单次 run 重采），可直接作为复跑模板：

`tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/`
- 五场景：`expired` / `unauthorized_config` / `hold_active` / `hold_stale` / `restricted_malformed_403`，
  每个 verdict `PASS`（本机原生栈，非 docker 真栈）；`PACKAGE.sha256` 绑定
  `README.tar.gz`（`5f866116…`）与 `evidence-manifest.json`（`885f2aa0…`）。
- 一次 run 全量采集 + 打包：`python3 tests/e2e/scripts/run_f1_dom_evidence_batch.py`
  （自动新 run 目录、拒绝覆盖；任一场景非 PASS 不打包）。
- 旧 v1 `tests/e2e/evidence/11-12-f1-dom-20261104T1049Z/` 已被 H5 拒收并**原字节冻结**：
  不要再引用、重生成或添加任何文件；rejected 由外部台账记录。
- 复跑单个场景：`EVIDENCE_WEB_URL=... EVIDENCE_API_URL=... EVIDENCE_LABEL=<label> EVIDENCE_SCENARIO=<label>
  EVIDENCE_OUT_DIR=... python3 tests/e2e/scripts/collect_f1_dom_evidence.py`。
- `restricted_malformed_403` 必须加 `EVIDENCE_MALFORMED_403=1`（浏览器网络层注入 403，不碰真实 API）。
- 新建 run 根目录时用新时间戳，**不要覆盖旧 run**；hold 场景造数用 admin DSN 调 `audit.raise_hold/clear_hold`，
  采集后把控制行恢复 `hold=false`。
- 打包/重打包**只从逐场景 verdict.json 生成**（禁止手工拼）：`python3 tests/e2e/scripts/build_f1_evidence_package.py
  --run-dir tests/e2e/evidence/<run> --run-started-at <iso> --run-finished-at <iso>`。脚本会拒绝非 PASS 场景、
  run_id 不一致、per-scenario 带 coverage；生成 `evidence-manifest.json`（repo-relative + sha256 + size）、
  `TRANSCRIPTS.md`（索引，不得与 README 同文）、包外 `PACKAGE.sha256`。
- **路径归一化规则（H5 m02105，写进台账）**：`evidence-manifest.json` 里是 **repo-relative** path，
  `README.tar.gz` 里是 **包相对** path；两者做集合比对时必须先去掉 `manifest.run_root + '/'` 前缀
  （builder 自己就是这样校验的）。用裸字符串比会对每个文件误报「tar 多出来」，A11 打 v4 整包时按这条执行。
- **签收后不可改**：已签字分发的 run 目录禁止重生成/编辑；任何内容变化新建 run 目录 + 新 `PACKAGE.sha256`，
  旧包原样保留。
- 合成数据边界：replay 录制是 L32 合成样本，**不进 release note/对外材料，不作 DA 组证据**；
  真栈/镜像构建另见 §0 与 `ci/BUILD-SMOKE.md`。
