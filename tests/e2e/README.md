# E2E（A12 qa-e2e）

P0 唯一用户旅程的 E2E 证据链：**打开个股页 → 行情 → as_of → 免责 → 基本面摘要 → 加自选 → 刷新仍在**。
硬约束（roster A12）：真栈 `docker-compose` + tushare **录播 fixture**；CI 结构上无法直连真实接口；
空实现时用例 **skip** 而非 fail；但「栈+实现就绪、fixture 缺失」必须 **FAIL**，不允许静默放行。

## 目录

```
tests/e2e/
├── docker-compose.yml          # 真栈：postgres/redis/tushare-replay/api/web + seed 链（db-migrate/ingress/warehouse-load/ingest-report；app-net internal）
├── docker-compose.record.yml   # 本地录制 override（唯一允许出网 + 持 token，CI 拒用）
├── tushare-replay/             # tushare HTTP 边界录播代理（含 8 条自测）
├── scripts/
│   ├── validate_compose.py     # 无需 docker 的结构断言（37 项）
│   ├── preflight.py            # 准入判定 READY/SKIP(78)/FAIL(1)，产出 .e2e-status.json
│   ├── up.sh                   # 一条命令起真栈（含一次性 ingest 与 preflight）
│   └── record-fixtures.sh      # 本地「录一次真实响应」（CI 拒绝执行）
├── lib/harness.js              # 准入、test-id、API、DB、断言辅助
├── specs/p0-stock-page.spec.js # 11 条关键路径（P0-00..10）
├── testids.json                # test-id 单一真源（交接 A7）
├── docs/TESTID-CONVENTION.md   # test-id 命名约定
├── quarantine.json             # flaky 记录（expires_at 必填，>24h 未处置 preflight FAIL）
├── ci/e2e-job.yml.snippet      # 提案给 A13 的 CI job 片段（不直接改根 CI）
└── package.json                # 独立测试包；根 package.json 归 A13
tests/fixtures/tushare/         # 录播工件 + 场景文件（说明见其 README）
```

## 环境要求

- **docker + docker compose v2**：真栈必需（本机当前无 docker，见 §已知限制）
- Node 20+：Playwright（`npm ci` 后 `npx playwright install --with-deps chromium`）
- Python 3.11+：preflight / compose 静态断言 / 录播代理（仅标准库 + PyYAML）

## 快速开始

```bash
# 1) 起真栈（构建 → seed ingest → api/web → preflight）
bash tests/e2e/scripts/up.sh

# 2) 单独看准入结论（不跑用例）
python3 tests/e2e/scripts/preflight.py          # --offline 可跳过网络探针
cat tests/e2e/.e2e-status.json

# 3) 跑 E2E
cd tests/e2e && npm ci && npx playwright install chromium && npx playwright test

# 4) 合成录制（L32 默认路径：不需要 token/外网，值全伪造、一眼可辨）
python3 tests/fixtures/tushare/synthetic/build_recordings.py

# 4b) 真实上游录制：默认禁用；只有 H4 书面批准后才允许（Lead L32，F1 再分发条款）
#     A12_ALLOW_REAL_TUSHARE=1 H4_APPROVAL_REF=<审批记录> TUSHARE_TOKEN=*** bash tests/e2e/scripts/record-fixtures.sh
```

## 准入判定（preflight）与 skip 语义

| 情形 | decision | exit | 用例行为 |
|---|---|---|---|
| api `/healthz` 不可达 / web 不可达（栈未起） | SKIP | 78 | 全部 skip，报告写 `ENV_STACK_DOWN` |
| `/healthz` 可达但 `data_ready=false` | SKIP | 78 | 全部 skip（`DATA_NOT_READY:<reason>`），不把数据未落算成产品 bug |
| 个股页 404（实现缺失） | SKIP | 78 | 全部 skip；原因里显式带 `FIXTURES_PENDING`，不掩盖缺口 |
| 缺 `E2E_AUTH_TOKEN` | SKIP | 78 | 自选两条 skip；其余照跑 |
| **录播代理（replay）不可达 / 录制 0 条** | READY（带注记） | 0 | **只有 P0-10 skip**，其余 11 条照跑（Lead 2026-11-04 裁定：replay 只是 P0-10 前置） |
| 录制损坏 / key 不一致 / quarantine 过期 | **FAIL** | 1 | 不跑，先修 E2E 资产 |
| 全部就绪 | READY | 0 | 真跑，失败即产品缺陷 |

设计要点：**skip 只表示「没东西可测」**，绝不表示「测了但坏了」。
「可测」的定义是 **`$E2E_API_URL/healthz` 可达且 `data_ready=true`**（Lead 2026-11-04 裁定），
不是「compose 起来了」——本机原生 PG + 真 api + 真 web（无 compose）同样应该可测。
replay 只是 P0-10 的前置，不达标只让 P0-10 skip，不拖累其余用例。
`preflight` 的 FAIL 会在 Playwright `globalSetup` 里直接抛出，避免 11 条用例各自超时。
`E2E_SKIP_PREFLIGHT=1` 时 `global-setup` 会写一份 `READY` 状态文件（含 `replay.ready` 探测），
不会静默 skip；状态文件缺失时 `harness.status()` 直接抛错（不再默认 skip）。

## 录播 fixture（核心设计）

录制点在 **tushare HTTP 边界**，不在 adapter 输出：adapter 的 tushare→canonical 映射是最容易错、
最需要 E2E 兜底的一跳，mock 掉它等于没测。CI 中 `app-net: internal=true`，容器无外网出口，
「禁止真实接口」是网络结构保证，不是口头约定。详见 `tests/fixtures/tushare/README.md`。

- 键 = `sha256(规范化 {api_name, params(去 token), fields(排序去空)})`；token 永不落盘。
- 未录制请求 → 代理 503 `FIXTURE_MISSING`（含 key/api_name），绝不返回伪造空数据。
- **L32 裁定（Lead 2026-11-04）：不落真实 tushare 报文。** 真实报文落仓库等于上游数据再分发，先违约，
  「测试用」不是抗辩。E2E 录制由 `tests/fixtures/tushare/synthetic/build_recordings.py` 生成：字段名/结构
  镜像公开文档，**值全伪造且一眼可辨**（`SYNTHETIC-甲/乙/丙`、`9999.99`、常量量额），覆盖 P0-00..09 实际
  打到的接口（`trade_cal/daily/adj_factor/fina_indicator/income`，共 19 条），不贪全。
- `record-fixtures.sh`（真实上游录制）**默认禁用**：必须 `A12_ALLOW_REAL_TUSHARE=1`、`H4_APPROVAL_REF`
  非空且本地非 CI 才能跑；README 与脚本头都写明需 H4 书面批准。
- 合成录制同样走键匹配：P0-10 用「已录制→200 回放、未录制→503 `FIXTURE_MISSING`」证明链路不静默造假。
- **fail-closed DOM 口径（H4 门禁 #5 / Lead m01294）**：价格类 testid 必须「不存在或无文本」，不接受
  `display:none`/`visibility:hidden`/`opacity:0` 冒充；占位 `0.00`/`--`/骨架屏与伪元素数字一律算泄露。
  实现见 `specs/p0-stock-page.spec.js` 的 `assertNoNumericLeak()`；P0-06 受限分支与 P0-12 共用。
- **A1 的 `seed_synthetic.sh` 分支**：由 `services/ingest` 单测覆盖（`--synthetic` 事件
  `display_safe=false`、不产 `manifest.head` 等），**不在 E2E 复跑**（E2E seed 走真实执行路径）。
- C01 豁免边界（Lead 裁定）：tushare 原生标识（`ts_code`/`600519.SH`）只允许出现在
  `services/ingest/adapters/**`、`warehouse/ods/` 的 raw 列、`tests/fixtures/tushare/**` 与
  `tests/e2e/tushare-replay/recordings/**`；DWD 及以上、`contracts/`、`web/`、API 响应出现即红灯。
- **已知时间炸弹**：`adj_factor` 录制按固定 `end_date` 生成，而 adapter 锚点是 `ANCHOR_START → market_now()`；
  跨天 seed 会 miss。需 A1 提供固定时钟注入（env/`--now`）后，录制才长期稳定（已报 A1）。

## test-id 契约（交接 A7）

`testids.json` 是单一真源；web 用 `data-testid="<value>"`。规则见 `docs/TESTID-CONVENTION.md`：
kebab-case、语义化、稳定，**禁止 nth-child/布局选择器**；spec 中硬编码 selector 视为 review 阻塞。
`preflight` 会扫描 spec 的 `tid('...')` 与 `testids.json` 比对，未定义即 FAIL。

## 交接依赖（实现侧需要对齐的点）

| 依赖方 | 契约 | 用途 |
|---|---|---|
| **A1** ingest | api/ingest 读 `TUSHARE_API_URL`、`DATA_SOURCE_MODE=replay`、`FIXTURES_DIR`；tushare 调用全部发往 `TUSHARE_API_URL`（默认 compose 已注入 `http://tushare-replay:18080`） | 录播注入点；缺一则录制/回放都断 |
| **A3** api | `GET /healthz` 200；market/fundamental/watchlist 按 `contracts/`；`meta.data_source {as_of, staleness_ms}` 必现；错误体为 `Problem{type,title,status,code}`；未录制上游错误映射为 5xx + Problem code（不得 200 + 空 data） | preflight 探针、用例断言 |
| **A3** api | 自选落库表 `watchlist_items(instrument_id text, ...)`（表名可用 `E2E_WATCHLIST_TABLE` 覆盖） | P0-08/09 的 DB 三处一致校验 |
| **A3** api | `ENTITLEMENT_TIER` 生效：受限层级下 `entitlement.is_entitled=false` 且不返回可判读数值；E2E 栈必须显式 `APP_PROFILE=e2e`（decisions.md L46，缺省=prod 会 fail-closed 拒启动，compose 已写） | P0-06 F1 否决线 / api 启动 |
| **A7** web | 个股页路由 `/stocks/{instrument_id}`（`SSE:600519`；`/stock/*` 仅为别名，E2E 不测）；`/` 200；DOM 渲染 `testids.json` 中全部 id（首屏 6 元素含 `quote-source` 数据来源）；`watchlistToggle` 加自选后 `aria-pressed="true"`；`watchlistState` 文本含「已自选」；从 `localStorage[e2e_token]` 读取 E2E 登录态 | 全部 web 用例 |
| **A2** warehouse | `warehouse/Dockerfile`（单职责镜像）+ `python -m warehouse.load` 幂等 upsert + 质量门禁；原子写 `quality.json`（schema §2）；退出码 0/1/2/3 见 [docs/INGEST-ONCE-CONTRACT.md](docs/INGEST-ONCE-CONTRACT.md) | seed 链第 2 步 `warehouse-load`（质量红/黑必须让栈起不来） |
| **A3** api | `/healthz` 增加 `data_ready` / `data_ready_reason` / `data_quality`（读 `INGEST_REPORT_PATH`）；与 `ingest-report.json` 契约见 [docs/INGEST-ONCE-CONTRACT.md](docs/INGEST-ONCE-CONTRACT.md) | 区分「栈没起来」与「数据没进来」 |
| **A13** CI | 采纳 `ci/e2e-job.yml.snippet`；CI 不注入 `TUSHARE_TOKEN`；录制脚本在 CI 直接退出 2；`pnpm install --ignore-workspace`（tests/e2e 不在 workspace） | 硬约束落地 |

## seed 链 / data_ready

seed 链（`up.sh` 编排，单职责镜像）：`db-migrate` → `ingress` → `warehouse-load` → `ingest-report`，任何一步非零即整栈 fail；
seed 失败时 api/web
仍然启动，`/healthz` 报 `data_ready=false`，preflight 用 `SKIP(78) DATA_NOT_READY:<reason>` 区分「栈没起来」。
接口约定（退出码、`ingest-report.json` schema、`quality.json` schema、preflight 判定、`/data` 路径与确定性时钟）见
[docs/INGEST-ONCE-CONTRACT.md](docs/INGEST-ONCE-CONTRACT.md)。A2 `warehouse.load` 已落地；剩余接线：A1 seed
两步命令/证据参数、Dockerfile 需补 `config/ingest.yaml`、A1 固定时钟（见契约 §1b）。

## P0 用例（11 条，每条带 hop 便于定位断点）

| 用例 | hop | 断言要点 |
|---|---|---|
| E2E-P0-00 | web-dom | DOM 契约：test-id 齐全且唯一 |
| E2E-P0-01 | web | 页面打开、标题/代码与路由一致 |
| E2E-P0-02 | web+api.market | 价格 > 0 且来自 API 数值集合（禁止前端自算）；涨跌幅匹配 `^[+-]\d+(\.\d+)?%$`、价格带币种（AC-8）；受限矩阵下显式 skip |
| E2E-P0-03 | api.market+web | `SourceRef.as_of` 存在；UI as_of 与 API `source.as_of` **字符串严格相等**（AC-2） |
| E2E-P0-04 | web+contract | stale badge 与 `staleness_ms > 900000` **双向**一致 |
| E2E-P0-05 | web+contract | 免责常驻、`closable=false`、版本与 API `meta.disclaimer.version` 一致 |
| E2E-P0-06 | web+api（F1 否决线） | `is_entitled=false` 时提示可见、`quote-price` 隐藏/null；禁止货币+数字/两位小数/0、骨架屏/占位/`::before|::after` 数字、数字类名空叶子；7 类基础信息（名称/代码/交易所/板块/security_type/上市状态/上市日期）必须可见；true 时价格可见 > 0 |
| E2E-P0-07 | api.fundamental+web | `report_period` 格式、`statement_basis` 枚举、UI 展示一致 |
| E2E-P0-08 | web+api.watchlist+db | UI 状态、watchlist API、PG 行三处一致 |
| E2E-P0-09 | web+db | reload 后 UI 状态/API/DB 仍在（服务端真相） |
| E2E-P0-10 | api→replay | 已录制载荷回放 200 且 `data.items` 非空（不造假）；未录制 → 503 `FIXTURE_MISSING` 且无 `data`；产品层未录制标的非 200 + Problem，UI 错误横幅可见且不显价格 |
| E2E-P0-12 | web+api F1 fail-closed | 受限档整页 DOM：价格/涨跌 testid 不存在或文本为空；`0`/`0.00`/`--`/`—`/`NaN`/`undefined`/`null`/骨架屏/伪元素数字一律失败；**不用 `toBeHidden()` 判没有**（hidden 里的价格 devtools 一改就出来）；免责+不可用提示可见。仅 `E2E_FAILCLOSED_SCENARIO=1` 的受限档整栈运行 |
| E2E-P0-11 | api.compliance+db+web | hold 冻结：`audit.raise_hold` 后 quote 403 `ENTITLEMENT_RESTRICTED`、instrument 200+`is_entitled=false` 且无行情数值字段（F1）、页面 notice 可见；`clear_hold` 后立即恢复 200+true。**默认 skip**，仅 `E2E_HOLD_ENABLED=1` 且 E2E 库已跑 A13 `db-migrate`（A5 迁移）时断言——不静默跳过成假绿 |

## hold（合规冻结，P0 纳入）

hold 是控制面能力，依赖 A5 的 `services/compliance/migrations/001_audit_entitlement_events.sql` 与 A13 的 `infra/scripts/db-migrate.sh`；
E2E 库必须走同一迁移路径，**禁止 compose 手写 DDL**。api 需 `ENTITLEMENT_HOLD_CHECK=1`（+ `ENTITLEMENT_AUDIT=1`）显式开，默认 0。
`E2E_HOLD_ENABLED=1` 才跑 `E2E-P0-11`；未开启时 skip 并在报告里带原因，不冒充通过。

## 授权矩阵（A12 口径；契约 `Entitlement.tier` 已写死语义）

- **normal（`E2E_ENTITLEMENT_MATRIX=normal`）**：**必须显式** `E2E_ENTITLEMENT_TIER=c_end_display`
  （compose 默认是 `internal_eval`，fail-closed，见 A13/H5 2026-11-04；裸跑会以 `CONFIG_TIER_FAIL_CLOSED`
  失败——这是配置提示，不是产品 bug）。A3 的 fail-closed 还要求非 `internal_eval` 档带到期时间盒，
  compose 默认留空（默认栈不需要），normal 矩阵必须同时显式传
  `E2E_ENTITLEMENT_EXPIRES_AT=2030-12-31T00:00:00Z`。
  quote / bars / fundamental-summary / instrument 均为 `200 + tier=c_end_display + is_entitled=true`；watchlist 恒
  `200 + tier=platform_user_data + is_entitled=true`。P0-02 价格/涨跌幅断言必须真跑。
- **restricted（F1 否决线，`E2E_ENTITLEMENT_MATRIX=restricted`）**：`E2E_ENTITLEMENT_TIER=internal_eval`
  （或被时间盒判定为过期：`ENTITLEMENT_EXPIRES_AT` 在过去，同样落 403 分支）。
  quote / bars / fundamental-summary 必须 `403 + Problem code=ENTITLEMENT_RESTRICTED`（Lead 2026-11-04 裁定 AC-5：
  **200+is_entitled=false 不得替代 403**，fail-closed）；`GET /v1/instruments/{id}` 基础信息 `200 + tier=internal_eval
  + is_entitled=false` 且不含行情数值（否则页面连证券名都显示不出）；watchlist 不受矩阵影响，恒
  `200 + platform_user_data + true`。只跑 `E2E-P0-06`；价格类用例显式 skip（矩阵语义，不是放宽断言）。

**四种受限来源（A11/H3 L36 第 5 条，只断行为不锚文案）**：`expired`（到期时间在过去）、`hold_active` /
`hold_stale`（合规 hold，等 A3 control 落地后跑）、`unauthorized_config`（`E2E_ENTITLEMENT_TIER=research_only`）。
S0 先跑 `expired` + `unauthorized_config`；hold 两场景待 A3 后补。**裸启动**（不设任何 `ENTITLEMENT_*`）同样
fail-closed，等价于 restricted（可用 `E2E_ENTITLEMENT_TIER=internal_eval` 复用）；prompt 文案逐字节一致，
E2E 只断言 `entitlementNotice` 可见，不把文案当契约。

preflight 的 `ENTITLEMENT` 检查在准入阶段逐接口比对「矩阵期望」与「API 实际返回」，配错直接 FAIL（配置缺陷 ≠ 产品 bug）。
normal 矩阵撞到 fail-closed 默认档时带独立 reason `CONFIG_TIER_FAIL_CLOSED`，直接告诉你「设 `E2E_ENTITLEMENT_TIER=c_end_display`」，不用翻实现。
FAIL 会带独立 reason code，让红灯可归因、不用每天重查：
- `CONTRACT_MISSING_403`：契约未声明 403（预期内红灯，**等待 A0/契约 bump，非实现缺陷**），指向具体接口路径；
- `IMPL_WRONG_STATUS`：契约已声明 403，但实现返回了别的状态/缺 `code=ENTITLEMENT_RESTRICTED` → 找 A3；
- `IMPL_LEAKS_F1_NUMBERS`：restricted 下基础信息响应体含 `price/volume/amount…` 等行情数值字段（F1 否决线）→ 找 A3。
「名字能显示、数字不能显示」有直接断言：E2E-P0-06 递归扫描基础信息响应体的字段名，不只是看 `tier`。
历史修正：此前 README 把两个层级写反（`internal_eval` 是禁止 C 端展示的受限层级，不是正常层级）。

## flaky / quarantine

`quarantine.json` 只用于**观测中的 flaky**，每条必须含 `case`、`reason`、`owner`、`expires_at`（ISO8601 UTC）。
过期未处置 → preflight FAIL（对应 A12 硬约束「flaky 24 小时内处理」）。retries 仅 CI 开启，
重试成功仍会在报告中标出。

## 已知限制（本机无 docker 环境下的验证状态）

本机当前**没有 docker / pnpm / Playwright 浏览器**，因此本轮交付的验证边界是：

- ✅ `validate_compose.py` 69/69 通过（真栈/录播/断网/token/授权矩阵/seed 链/`sh` 迁移脚本结构断言）
- ✅ `pytest tushare-replay/test_server.py tests/e2e/scripts/test_preflight.py` 42 passed
- ✅ 合成录制 19 条 + `build_recordings.py --check` 通过；replay 冒烟：已录制 200（`SYNTHETIC-*` 值）、未录制 503 `FIXTURE_MISSING`
- ✅ `preflight.py --offline` 正确输出 `SKIP(78)` 并落 `.e2e-status.json`
- ✅ 全部 JS/`.sh`/`.py` 通过 `node --check` / `bash -n` / `ast.parse`
- ⏳ 真栈 `up.sh` 与 Playwright 首跑需在有 docker 的机器/CI 上完成（首次运行可能暴露 A1/A3/A7 的接口命名差异，
  这些是交接依赖，不是测试放水）

## 不做的事（review 时会看）

- 不 mock 被验证的环节（adapter 映射、DB、页面渲染都真跑）。
- 不为过用例放宽断言；断言未知展示格式时只放宽「格式」，不放宽语义（价格>0、阈值、版本一致）。
- 不在默认栈出现 token / 真实 tushare 域名 / record 模式（静态断言强制）。
- 不手改 `recordings/`（key 校验会失败）。
