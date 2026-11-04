# A19 红队报告：前端绕过 403 / 未授权读行情数字（11-12 门禁 #7）

- 执行：A19（red-team）；执行时间 2026-11-04 09:00:54–09:03:04（Asia/Shanghai）
- 目标：证明／证伪「未授权时 C 端读不到任何行情数字」；重点为前端自行放行、API 绕过、字段泄漏、缓存/SSR、限流绕过、固定身份/越权写入。
- 结论：**未发现 BYPASS。** 46 项攻击检查 = **44 BLOCKED / 1 LEAK（条件性，P2，不产出行情数值）/ 1 INFO**。
  - 门禁 #7「前端不存在可绕过的开关」（decisions.md:390）的动态验证：**未被绕过**。
  - 唯一 LEAK 是限流桶条件性绕过（R4），不构成"未授权读到数值"的路径；但它与 L36「限流桶：伪造 XFF 不换桶」的验收点相关（见 §6）。
- 判定口径：
  - `BYPASS`：未授权用户能读到行情数值（P0）。
  - `LEAK`：没读到行情数值，但泄漏了不该给的信息或能力（如换限流桶、内部原因码）。
  - `BLOCKED`：按预期拒绝，附实际响应与手法。
- 本报告只呈现攻击与证据，**未修改代码、未提出修复方案**（按 lead 要求）。

## 1. 复现环境（隔离副本，非生产）

| 组件 | 地址 / 值 | 用途 |
| --- | --- | --- |
| API 受限态 | `http://127.0.0.1:18182`（`ENTITLEMENT_TIER=internal_eval`） | 攻击面 2/3/4 主目标 |
| API 到期态 | `http://127.0.0.1:18183`（`c_end_display`，`ENTITLEMENT_EXPIRES_AT=now+120s`） | 有效→到期 fail-closed |
| API 默认限流 | `http://127.0.0.1:18184`（默认 `ipBurst=10`） | 攻击面 5 |
| API 配置攻击 | `18185`（`TRUST_PROXY=true`）、`18186`（`TRUST_PROXY=127.0.0.0/8`）、`18187`（后门 guard/裸启动） | 攻击面 5/6 |
| Web | `http://127.0.0.1:3200`（→18182）、`http://127.0.0.1:3201`（→18183） | 前端攻击面 1/4 |
| DB | `postgresql://ms@localhost:55432/market_sense_a19`（PG 16） | 独立副本，合成 fixture |
| 前端产物 | `web/h5/dist`（index.html mtime `2026-11-04T09:00:21+08:00`） | 当前源码构建，非旧 dist |
| 运行时 | Node v23.11.0；Chromium 156.0.8078.4（Playwright） | — |

隔离边界：只监听 `127.0.0.1:18182-18187` 与 `127.0.0.1:3200/3201`；只连 `market_sense_a19`；不触碰 lead 的 8081/3000、生产环境与真实用户数据。DB 由 `provision-db.sh` 从本地合成 fixture 重建（2 只标的，行情为 2024-01-04 收盘快照）。

复现命令（workspace 根目录）：

```bash
# 首次/重置隔离库（只在 55432 上 drop/create market_sense_a19）
tests/adversarial/entitlement-bypass/provision-db.sh
# 全量攻击（自动起停隔离栈，约 2.5 分钟，含 120 秒到期窗口）
node tests/adversarial/entitlement-bypass/run.mjs
```

### 环境声明（避免误读证据）

lead 提供的 `127.0.0.1:8081` 在本轮实测**不是未授权态**：其进程 env 为 `ENTITLEMENT_TIER=c_end_display`、`E2E_MODE=1`、`E2E_AUTH_TOKEN=dev-token`、`APP_PROFILE=e2e`、`ENTITLEMENT_EXPIRES_AT=2030-12-31T00:00:00Z`，`GET /v1/instruments/SSE:600519/quote` 返回 200 + `last_price=10.3`。它可作"有效态对照"，不能作为本条门禁的未授权证据；本报告所有判定均来自上表的隔离副本。

## 2. 结果总览（**修复前首轮**；R4 修复后复跑见 §11，post-fix 全量见 §12）

| 攻击面 | 手法（实际尝试） | 检查项 | 结果 |
| --- | --- | --- | --- |
| 1 前端自行放行 | 13 个存储键注毒、sessionStorage/cookie、`window.__ENTITLEMENT__/__MS_TIER__/__USER__`、`?mock=1`、`?mock=normal`、`?data_mode=mock`、`?tier=…&is_entitled=true&debug=1`、`?demo=1&entitled=1`、`#entitled`、运行时二次注毒后 reload | S1/S2/S3、C1–C6、C7–C12 | **BLOCKED** |
| 2 API 绕过 | 21 组伪造/扩展头（含 `X-Entitlement-Tier`、`X-Entitlement`、`X-Debug`、XFF 双地址、`X-Real-IP`、`X-Original-URL`、`X-Rewrite-URL`、`X-HTTP-Method-Override`、`Bearer dev-token/admin`、`Instrumentation`、`X-Entitlement-Expires-At`、`Accept: text/html`、组合伪造）；10 组 query；8 组路径变异；5 种写方法；bars/fundamental-summary 备用端点 | H1–H5、H9–H11、E1–E2 | **BLOCKED** |
| 3 受限接口字段泄漏 | 递归扫描 `price/volume/amount/close/open/high/low/pct_chg/change/turnover/quote/lot_size`；403 problem body 内查找 `expired/hold/stale/internal_eval/unauthorized` 等内部原因码 | H6、H9 | **BLOCKED** |
| 4 缓存与 SSR | `If-None-Match`（含 `*`）、`If-Modified-Since`、`Cache-Control: only-if-cached,max-stale=600`、`Pragma`；SSR 首屏 HTML；SW/CacheStorage；bfcache 回退、reload、CDP 缓存来源、Resource Timing | H10、H11、S4/S4b/S5/S6、C4、C6、C8–C12 | **BLOCKED** |
| 5 限流绕过 | 默认桶连发；桶耗尽后 4 个伪造 XFF；`TRUST_PROXY=true` 启动；`TRUST_PROXY=127.0.0.0/8` 下 XFF 换桶；`limit=600 / 500 / offset=1001` | R1–R4、V3 | **BLOCKED（R1/R2/R3/V3）**；**R4 = LEAK（条件性）** |
| 6 越权写入 / 固定身份 | 无 token/伪造 token watchlist；dev-token 的 GET/POST/DELETE；管理/诊断路径 11 条；`APP_PROFILE` 缺省时的 E2E 后门；生产 profile 下的 dev-token；裸启动（无任何 `ENTITLEMENT_*`） | H7、H8、G1–G4 | **BLOCKED**（H7 的 E2E 可写为 INFO，见 §7） |

## 3. 关键原始响应（BLOCKED 证据）

### 3.1 受限态 quote 403（H1/H9/H10/H11）

```
HTTP/1.1 403 Forbidden
content-type: application/problem+json; charset=utf-8
cache-control: no-store

{"type":"https://errors.market-sense.invalid/entitlement-restricted","title":"行情数据暂不可用","status":403,"code":"ENTITLEMENT_RESTRICTED","trace_id":"req-1y","detail":"当前版本暂不提供该标的行情数据"}
```

- 21 种伪造头上全部 403；5 种条件请求（`If-None-Match` 等）全部 403，且响应**无 ETag / 无 Last-Modified**，不会出现 304 复用。
- 经 web 反代（3200）同样 403 且 `cache-control: no-store, no-cache, must-revalidate`。
- 代码依据：`services/market/src/routes.ts:166`（`throw entitlementRestricted()`）、`:172-175`（`requireEntitled` 统一 fail-closed）；`services/market/src/plugin.ts:141-142`、`services/api/src/app.ts:45-47`、`web/h5/server.mjs:88-95`（三层 no-store）。

### 3.2 受限态 instrument 200（H6）：7 字段白名单、无行情字段

```
GET /v1/instruments/SSE:600519  → 200
cache-control: no-store

{"data":{"instrument_id":"SSE:600519","exchange":"SSE","name":"贵州茅台","board":"main","security_type":"stock","list_status":"listed","listed_at":"2001-08-27"},"meta":{"source":{"source":"platform_eod","as_of":"2026-11-04T08:23:59+08:00","staleness_ms":2048545,"source_id":"tushare"},"entitlement":{"tier":"internal_eval","is_entitled":false}}}
```

字段集合恰为 7 个白名单字段（`services/market/src/domain/build.ts:132-142`），递归扫描无任何价格类字段；`meta` 不含内部原因码。

### 3.3 前端注毒/URL/mock 全部无效（C1/C2/S1/S2）

受限页 DOM 观测（C1）：`priceCount=0`、`priceVisible=false`、无货币数字形态、`entitlement-notice` 可见；页面文案为中性句「数据暂不可用 / 当前版本暂不提供该标的行情数据，本页不会展示任何价格数字」。C2 的 8 个变体（含 runtime 二次注毒后 reload）全部不渲染、不出现有效价格 `10.3`。

代码依据：`web/h5/src/data/apiGateway.ts:196`（唯一放行条件 `quoteMeta.entitlement.is_entitled`）、`:215-216`；`web/h5/src/data/index.ts:14-19`（`useMock = import.meta.env.DEV && DATA_MODE==='mock'`，生产 `DEV=false`）；dist bundle 静态扫描无 `ALLOW_/BYPASS_/FORCE_/SKIP_AUTH/mockGateway` 等开关（S1/S2/S3）。

### 3.4 缓存 / SSR / bfcache / DOM 残留（H10/H11/C4/C6/C8–C12）

- 受限态 4 条 HTML（`/`、`/stocks/SSE:600519` × 3200/3201）全部为纯 SPA shell：无价格数字、无 `__INITIAL_STATE__`、无股票名、`cache-control: no-store`（S4/S4b）；server.mjs 无 SSR/注入标记（S5）；dist/index.html 无数字（S6）。
- 浏览器无 Service Worker、无 CacheStorage、无 manifest（C4）。
- 到期后 phase B：`history.back()` 未从 bfcache 复用旧价格（`persisted=false`，C8）；reload 后 `priceCount=0`、无旧价格（C9）；页面内 quote 请求 CDP 观测为 `status=403`、`fromDiskCache/Memory/SW=false`、`cache-control` 仍 no-store（C10）；Resource Timing `transferSize>0`（C11）；React 树无 `quote-price` 节点残留（C12）。

### 3.5 有效态对照与到期 fail-closed（V1/V2/E1/E2）

有效态 200 原文节选：

```
{"data":{"instrument_id":"SSE:600519","trade_date":"2024-01-04","last_price":10.3,"prev_close":10.5,"change":-0.2,"change_pct":-1.9048,"volume":100000,"amount":5000000,...},"meta":{"entitlement":{"tier":"c_end_display","is_entitled":true}}, ...}
cache-control: no-store
```

到期后（同一实例）quote 变 403、instrument 200 但 `meta.entitlement={tier:internal_eval,is_entitled:false}`；8 条伪造头均不能恢复行情（E1/E2）。前端在到期后 reload 仍 fail-closed（C9），说明不是"前端本来就没数据"的假阴性。

## 4. 唯一 LEAK：R4 条件性限流桶绕过（P2）

- 条件：部署把 `TRUST_PROXY` 配成**覆盖客户端直连 IP 的 CIDR**（复现用 `TRUST_PROXY=127.0.0.0/8`，loopback 直连）。
- 操作与原始响应：

```
GET /v1/instruments/SSE:600519/quote            → 429 RATE_LIMITED（桶已耗尽）
GET 同一 URL + X-Forwarded-For: 8.8.8.8         → 403 ENTITLEMENT_RESTRICTED（换桶成功，重新进入处理链）
```

- 影响：不产生行情数值（仍是 403），但攻击者可借伪造 XFF 换桶，绕过每 IP 限流/审计节流；与 decisions.md L36「限流桶：伪造 XFF 不换桶」的验收点在上述部署前提下冲突。
- 默认配置（`TRUST_PROXY` 未设，`trustProxy=false`）时 R2 实测 4 个 XFF 全部 429，不换桶；`TRUST_PROXY=true` 会在配置层被拒绝启动（R3，日志含 `TRUST_PROXY=true 被禁止`）。即该 LEAK 只在"信任网段覆盖了直连客户端"时成立。
- 复现：`node tests/adversarial/entitlement-bypass/run.mjs`（R4 自动起 `18186`；本轮日志 `artifacts/logs/20261104T023750101Z/api-trustproxy-cidr.log`，修复前基线日志 `artifacts/logs/api-trustproxy-cidr.log`）。

## 5. 为什么"没绕过"不等于"没试"（可核对清单）

所有尝试的请求原文落在 run-scoped 的 `artifacts/http-attempts-<runId>.jsonl`（post-fix 本轮 `http-attempts-20261104T023750101Z.jsonl`，176 条，每行含 seq/note/method/url/status/headers/响应体前 2000 字节；修复前那轮 `http-attempts-20261104T012350680Z.jsonl`，175 条，均保留）；每条检查的 observed/attempt 在 `artifacts/results.json`。根目录 `artifacts/http-attempts.jsonl` 是旧 truncate bug 留下的 0 字节墓碑（sha256 `e3b0c442…`），不要使用。逐类清单：

- H1：21 组头（baseline、`X-Entitlement-Tier`、`X-Entitlement`、`X-Debug`、XFF×2、`X-Real-IP`、`X-Original-URL`、`X-Rewrite-URL`、`X-Forwarded-Host/-Proto`、`X-HTTP-Method-Override`、`Bearer dev-token`、`Bearer admin`、Cookie、`X-User-Tier`、`X-Admin`、`Instrumentation`、`X-Entitlement-Expires-At`、`Accept: text/html`、组合伪造）。
- H2：`tier / entitlement / is_entitled / entitled / debug / mock / demo / include / format / e2e` 10 组 query。
- H3：trailing slash、`%3A` 编码冒号、大小写、分号、`..`、双斜杠、`%20` 等 8 组路径变异（结果 403/404，无双斜杠 404 响应无 no-store 的边界记录）。
- H4：`POST/PUT/PATCH/DELETE/OPTIONS` 5 种写方法。
- H5：`bars` 与 `fundamental-summary` 两条备用数据端点（`/v1/instruments/:id/fundamental-summary` 为正确路由）。
- H8：`/openapi.json /docs /metrics /v1/admin /v1/internal/entitlement /v1/entitlement /v1/config /healthz /v1/healthz /.env /debug/pprof`。
- 前端：C1–C12 共 12 项（含 8 种 URL/存储变体、拦截重放、bfcache、CDP 缓存、DOM 残留）。
- 限流：R1–R4、V3（`limit=600→400 VALIDATION_ERROR`、`limit=500→200 且 rows=3`、`offset=1001→400`，为拒绝而非 clamp 放行）。
- 后门/身份：G1–G4（原始启动日志见 §7）。

## 6. 唯一 INFO（不计入缺陷）

- **C5（契约行为，非缺陷）**：在浏览器网络层用 CDP 完全替换 quote 响应为"200 + 完整行情 + `is_entitled=true` + disclaimer"时，页面会渲染价格；但这是"攻击者已完全控制自身浏览器/网络"的等价场景，不是服务端放行。对照：200 但 `is_entitled=false` 或删除 disclaimer 时均不渲染（C5 的 restricted/missingDisclaimer 分支）。
- **H7（仅 E2E 环境）**：`E2E_MODE=1` 下 `dev-token` 可读写 watchlist（401 只对无/伪造 token）。G3 证明生产 profile（无 E2E env）下 dev-token 返回 401；G1/G2 证明 `APP_PROFILE` 缺省时 E2E env 会让进程拒绝启动。
- **S7**：构建产物清单（INFO）。

## 7. E2E 后门 guard 原始证据（G1–G4）

- G1（`APP_PROFILE` 缺省 + `E2E_MODE=1` + `E2E_AUTH_TOKEN=dev-token`）进程退出，日志：

```
MarketConfigError: E2E 模式在生产不可用（L44/L46）：APP_PROFILE=""（缺省=prod）下禁止 E2E_MODE=1、E2E_AUTH_TOKEN
    at assertNoE2EBackdoorInProduction (.../services/market/src/config.ts:158)
```

- G2（仅 `E2E_AUTH_TOKEN`）：同样退出，日志点名 `E2E_AUTH_TOKEN`。
- G3（生产 profile）：**首轮 FAIL → post-fix PASS；两段因果都保留，不把 FAIL 事后改成 PASS。**
  - 首轮（run `20261104T012350680Z`）：`started:false`，G3 = **FAIL**；唯一日志 `artifacts/logs/api-prod-profile.log`（sha256 `a8b25550…`）单行即 `生产必须配置 DEPLOYMENT_UID（audit_gap 去重键与审计归属，L65）`（`services/market/src/config.ts:205`）。这是 **L65 启动守卫按预期触发**——"配置不全拒绝启动"，不构成"实例健康、dev-token 被拒"的证据，故不能记 PASS。机器结果存档 `artifacts/results-prefix-g3-20261104T012350680Z.json`（sha256 `46dac615…`）。
  - post-fix 重跑（H5 条件：prod profile + 流水线注入 `DEPLOYMENT_UID` + **无 E2E env**）：实例 healthz `200`；`GET /v1/watchlist` 带 `Authorization: Bearer dev-token` → **`401 UNAUTHENTICATED`**，body 无内部原因码；G3 = **PASS**。证据：`artifacts/results-g3-postfix-20261104T023750101Z.json`（sha256 `ac945d2e…`）、service log `artifacts/logs/20261104T023750101Z/api-prod-profile.log`（sha256 `2563a9c9…`）、transcript `artifacts/http-attempts-20261104T023750101Z.jsonl`（sha256 `b2e6875a…`，176 行，自检 行数=`http()` 调用数）。
  - 该隔离库未建 audit schema，日志有 `entitlement_audit_write_failed / audit_write_misconfigured` 警告；与 G3 的 401 判定无关（不影响响应），如实保留在 service log 中。
- G4（裸启动：不设任何 `ENTITLEMENT_*`）：正常启动；quote 403 `ENTITLEMENT_RESTRICTED`；instrument 200 且 `meta.entitlement={tier:"internal_eval",is_entitled:false}`（对应 decisions.md:391 第 8 条）。

## 8. 未覆盖（明确列出，避免"没试"与"试了没绕过"混淆）

- 真实 CDN/Ingress 层（本机无 CDN；只验证了应用与反代层 no-store 及浏览器缓存行为）。
- 移动端 WebView / 真实浏览器扩展（React DevTools）改 state——本地 headless 无扩展；但已在契约层验证"客户端状态不能替代服务端 `is_entitled`"（C5）。
- 多租户横向越权、真实用户数据、生产环境、破坏性压测（按 A19 硬边界不碰）。
- React DevTools 篡改属于"攻击者控制自己的浏览器"，与 C5 的 CDP 全量替换同类，不产生新的服务端放行路径。

## 9. 附件

- `artifacts/results.json`：**post-fix 全量** 46 项检查（attempt/expectation/observed/status/severity），`verdict=NO_BYPASS`；修复前首轮存档 `artifacts/results-prefix-g3-20261104T012350680Z.json`（`verdict=BYPASS_FOUND` 仅因 R4）。
- `artifacts/http-attempts-20261104T023750101Z.jsonl`：post-fix 原始 HTTP 往返（176 条；每行 `seq/note/method/url/status/headers/body`）；修复前 `artifacts/http-attempts-20261104T012350680Z.jsonl`（175 条）保留；根目录 `http-attempts.jsonl` 为 0 字节墓碑，勿用。
- `artifacts/results-g3-postfix-20261104T023750101Z.json`：G3 post-fix 专项结果（含 command/exitCode/observed/log/transcript）。
- `artifacts/logs/<runId>/`：本次 run 的隔离实例日志（run-scoped，不覆盖历史）；`artifacts/logs/*.log` 为历史 run 日志，全部保留。
- `artifacts/evidence-manifest-<runId>.json`：**证据清单**，逐文件 `path / sha256 / bytes / mtime / caseIds / run`（A11 v4 机械校验用；manifest 按 L82 不内嵌自身哈希）。
- `artifacts/run-stdout-20261104T023750101Z.log`：runner 完整 stdout/stderr（命令与逐项结果，`EXIT:0`）。
- `artifacts/*.png`：`c1-restricted-baseline.png`、`c2-poisons.png`、`c5-interception.png`、`c7-valid.png`、`c9-expired-reload.png`。
- 代码：`lib.mjs`、`run.mjs`、`cases/static.mjs`、`cases/api.mjs`、`cases/client.mjs`、`provision-db.sh`。

## 10. 附：条件 1 黑盒守卫基线（修复前，2026-11-04 09:0x）

lead 对 R4 的裁定要求「`TRUST_PROXY` 只允许 ingress 窄网段；`0.0.0.0/0`、`::/0`、回环、`10.0.0.0/8` 启动时拒启（不是 warn）」。该条件由外部观测，不由实现者自证。

```bash
node tests/adversarial/entitlement-bypass/trustproxy-guard.mjs   # 4 个独立实例，端口 18190-18193
```

当前（修复前）结果 **0/4 PASS**，`artifacts/trustproxy-guard.json`：

| TRUST_PROXY | 外部观测 | 判定 |
| --- | --- | --- |
| `0.0.0.0/0` | 进程退出（exit 1），但原因是 `@fastify/proxy-addr` 抛 `TypeError: invalid range on address: 0.0.0.0/0`（`buildApp` 阶段），日志无 `TRUST_PROXY` 校验文案 | FAIL（依赖崩溃式拒启，非启动校验；换依赖/写法可能重新放行） |
| `::/0` | 同上，`TypeError: invalid range on address: ::/0` | FAIL（同上） |
| `127.0.0.0/8` | 启动成功，`/healthz` 200，无 warn | FAIL（回环未被拒） |
| `10.0.0.0/8` | 启动成功，`/healthz` 200，无 warn | FAIL（宽网段未被拒） |

- 即：条件 1 **尚未实现**；且四个里有两个只是依赖库在 `buildApp` 崩溃，不是 config 层校验——不能算"启动时校验通过"。
- 修复后复跑同一命令：只有「进程退出 + 日志点名 TRUST_PROXY + 从未监听健康端口」才记 PASS；`healthz 200`、warn-only、依赖 TypeError 崩溃均记 FAIL。退出码 `0`=4/4 配置层拒启，`1`=仍有放行。
- 日志：`artifacts/logs/api-trustproxy-guard-*.log`。

## 11. 附：A0 修复后复跑（2026-11-04 09:14，外部观测）

同一命令、同一隔离库 `market_sense_a19`、同一端口；唯一变化是 A0 的 fix（services/api/src/config.ts，mtime 09:09）。

### 11.1 条件 1：`node trustproxy-guard.mjs`（修前 → 修后）

| TRUST_PROXY | 修前（09:07） | 修后（09:14） |
| --- | --- | --- |
| `0.0.0.0/0` | 退出 1，但为 `@fastify/proxy-addr` 的 `TypeError: invalid range`（`buildApp`），日志无 TRUST_PROXY 校验文案 → FAIL | 退出 1，`listenedPort=false`，`/healthz` 从未 200；stderr 首行 `[config] 拒绝启动：TRUST_PROXY 网段过宽（/0）：只接受 /24–/32 的 ingress 网段…收到 "0.0.0.0/0"` → **PASS** |
| `::/0` | 同上，`TypeError: invalid range on address: ::/0` → FAIL | 退出 1，`listenedPort=false`；stderr 首行 `[config] 拒绝启动：TRUST_PROXY 不得包含未指定或回环地址: "::/0"` → **PASS** |
| `127.0.0.0/8` | 启动成功，`/healthz` 200，无 warn → FAIL | 退出 1，`listenedPort=false`；stderr 首行 `[config] 拒绝启动：TRUST_PROXY 网段过宽（/8）…收到 "127.0.0.0/8"` → **PASS** |
| `10.0.0.0/8` | 启动成功，`/healthz` 200，无 warn → FAIL | 退出 1，`listenedPort=false`；stderr 首行 `[config] 拒绝启动：TRUST_PROXY 网段过宽（/8）…收到 "10.0.0.0/8"` → **PASS** |

修后合计 **4/4 PASS**（`GUARD_EXIT=0`），`verdict=NO_BYPASS`；证据 `artifacts/trustproxy-guard.json`，修前基线 `artifacts/trustproxy-guard-before-fix.json`。

### 11.2 R4：`node run.mjs --only=R4`（修前 → 修后）

| 观测 | 修前（09:05） | 修后（09:14） |
| --- | --- | --- |
| 实例启动 | 正常启动、监听、`/healthz` 200 | 拒绝启动，exit 1，`listenedPort=false`，`/healthz` 从未 200 |
| 换桶结果 | 桶耗尽后 `beforeSpoof=429`；带 `X-Forwarded-For: 8.8.8.8` → `afterSpoof=403 ENTITLEMENT_RESTRICTED`（换桶成立） | 换桶路径不可达（无 HTTP 响应可发） |
| stderr 首行 | 无（正常服务） | `[config] 拒绝启动：TRUST_PROXY 网段过宽（/8）：只接受 /24–/32 的 ingress 网段（…），收到 "127.0.0.0/8"` |
| 判定 | FAIL / P2 | **PASS**（`R4_EXIT=0`） |

证据：修前 `artifacts/r4-before-fix.json`（429→403）；修后 `artifacts/results-r4.json`（refused=true、exitCode=1、listenedPort=false）；原始日志 `artifacts/logs/api-trustproxy-cidr.log`。

### 11.3 「是否监听端口」的观测方法

- 进程退出：`spawn` 返回的 `child.exitCode !== null`（外部观测，不读实现内部状态）。
- 从未监听：在启动窗口内每 250ms 用 TCP `connect` 探测端口（`portInUse`）并请求 `/healthz`；只要任一轮 `connect` 成功或 `/healthz` 返回 200 即记 `listenedPort=true`，该条不能 PASS。
- 拒启归因：stderr 首行必须出现 `TRUST_PROXY` 配置校验文案、且不能是 warn-only；依赖库 `TypeError` 崩溃（修前 `0.0.0.0/0`/`::/0` 的情况）不算配置层拒启。
- 条件 2/3 仍记「未覆盖」：条件 2 需 staging（本机无 ingress），条件 3 不在攻击环境。


## 12. L75 证据链修复 + G3 post-fix 全量重跑（2026-11-04 10:37–10:40 Asia/Shanghai）

### 12.1 首轮 transcript 丢失（如实记录，不是"一直都有"）

- 事实：`artifacts/http-attempts.jsonl` 在 09:14 变为 **0 字节**（sha256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，即空文件；HEAD `363cbdc` 内也是 0 字节）。
- 根因：旧 `cases/api.mjs` 的 `initRawLog()` 每次 run 用 `fs.writeFileSync(file,'')` 清空；09:14 的 `--only=R4` 复跑把 09:01–09:03 首轮的 100+ 条原始往返覆盖。结论文字没错，但"原始证据"确实被自己的复跑删掉。
- 修复（L75）：transcript 与实例日志均改为 **run-scoped 文件/目录**（`http-attempts-<runId>.jsonl`、`logs/<runId>/`），创建用 `fs.writeFileSync(..., {flag:'wx'})`，目标已存在即报错拒绝覆盖；`http()` 每次实际出发自动追加一条（`seq/note/method/url/status/headers/body`），runner 自检 `transcript 行数 === http() 调用数` 且每行含 `method/url/status/headers`，`results.json.meta.rawHttpLog` 指向当次文件、`meta.rawHttpLogEvidence` 记 bytes/lines/sha256。
- 重建：post-fix 全量 `node tests/adversarial/entitlement-bypass/run.mjs` → `EXIT:0`；transcript `artifacts/http-attempts-20261104T023750101Z.jsonl`（176 行、135,663 字节、sha256 `b2e6875a70067f78731d8eebb9aefc6ba6a362396b86adfc3569ecd0bb50824f`）。首轮那轮在修复前另有独立文件 `http-attempts-20261104T012350680Z.jsonl`（175 行、sha256 `9ed2b522…`），未被覆盖。

### 12.2 G3 判定链（守卫触发 → 重跑，不是改结论）

首轮 `results.json` 里 G3=FAIL（`started:false`）是 **L65 启动守卫按预期拒绝**（prod 缺 `DEPLOYMENT_UID`），保存为 `results-prefix-g3-20261104T012350680Z.json`；post-fix 按真实部署形态（`APP_PROFILE` 缺省=prod + `DEPLOYMENT_UID` 注入 + 无 E2E env）重跑，G3=PASS（healthz 200 → dev-token 401、body 无内部码）。两段结果并列在 §7 与 `results-g3-postfix-20261104T023750101Z.json`。

### 12.3 post-fix 全量结果与证据清单

- `summary = { total: 46, pass: 45, fail: 0, info: 1, verdict: "NO_BYPASS" }`；R4 修复态见 §11（实例拒启，换桶不可达）。
- 证据清单：`artifacts/evidence-manifest-20261104T023750101Z.json`（revision 3，39 个文件条目，逐项 path/sha256/bytes/mtime/caseIds；含 27 个 `.log`、两轮 transcript、G3 专项、guard/R4 修前修后、runner stdout、报告本身；不内嵌 manifest 自身哈希）。0 字节墓碑 `artifacts/http-attempts.jsonl` 不登记为证据，移入 manifest `tombstones` 字段（保留文件、不删除）。
- 命令/退出码/监听：`node tests/adversarial/entitlement-bypass/run.mjs` → `EXIT:0`；G3 实例 `healthz=200`（即监听成功），G1/G2 为"退出码 1 且从未监听"，端口监听观测方法见 §11.3。
- 0 字节日志处理（A11 m00663）：`logs/<runId>/` 中 `api-restricted/api-expiring/api-limited/api-bare-start` 因 `LOG_LEVEL=warn` 无输出；已各补**一行 provenance 头**（runId/service/command/cwd/port/runStartedAt/runFinishedAt/termination/exitCode=not-captured/备注"未伪造输出"），现均 >0 字节。`spawnService.cleanup()` 已改为对空日志自动补同样 provenance，后续 run 不再产生 0 字节证据。
- 根目录历史日志（pre-L75 run，09:23）同样有 4 个 0 字节文件（`artifacts/logs/{api-restricted,api-expiring,api-limited,api-bare-start}.log`），已各补 provenance 头（注明 runId 未知、文件 mtime、未伪造输出），现 455–458 字节；manifest 中全部 `.log` 均 bytes>0。
