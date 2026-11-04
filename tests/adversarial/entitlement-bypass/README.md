# entitlement-bypass（A19 红队动态用例）

「未授权时 C 端看不到任何行情数字」的对抗性验证。11-12 门禁 #7（前端不存在可绕过的开关）的动态部分。
结论与逐条证据见 [`REPORT.md`](./REPORT.md)；机器可读结果见 `artifacts/results.json`。

## 前置

- Node ≥ 22（本轮 v23.11.0），pnpm 依赖已安装（workspace 根、`services/api`、`web/h5`、`tests/e2e` 均有 `node_modules`）。
- 本地 PG 16 监听 `127.0.0.1:55432`，能连 `postgresql://ms@localhost:55432/market_sense`（只读合成 fixture 作为数据源）。
- `web/h5/dist` 已由**当前源码**构建（`cd web/h5 && pnpm exec vite build`）。dist 比 `web/h5/src` 旧时先重建，否则测的是旧前端。
- Playwright Chromium 已安装（通过 `tests/e2e/package.json` 解析 `@playwright/test`）。

## 运行

```bash
cd /Users/leiyu/Documents/deepseek-harness/default-workspace

# 1) 首次 / 需要重置隔离库时：重建 market_sense_a19（只 drop/create 这个库）
tests/adversarial/entitlement-bypass/provision-db.sh

# 2) 全量攻击（自动起停隔离栈；含 120 秒的到期转换窗口，约 2.5–3 分钟）
node tests/adversarial/entitlement-bypass/run.mjs

# 3) 只复跑 R4 一条（修完 trustProxy 后使用；约 20–40 秒，只需 DB + 18186）
node tests/adversarial/entitlement-bypass/run.mjs --only=R4
```

退出码：`0` = 全部 BLOCKED（`--only=R4` 时 = 配置层拒绝 loopback CIDR 或伪造 XFF 不换桶）；`1` = 存在 FAIL（BYPASS/LEAK）；`2` = harness/preflight 失败（环境问题，不是产品结论）。`--only=R4` 的单条结果写 `artifacts/results-r4.json`，不覆盖全量 `artifacts/results.json`。

**run-scoped 证据（L75）**：每次 run 生成唯一 `runId`（UTC 时间戳），transcript 写 `artifacts/http-attempts-<runId>.jsonl`，实例日志写 `artifacts/logs/<runId>/`；创建用 `wx`，目标已存在直接报错，**永不 truncate 历史证据**。runner 退出前自检 transcript 非空、行数等于 `http()` 调用数、每行含 `method/url/status/headers`，不通过即 `exit 2`。

G3 需要**真实部署形态**：`APP_PROFILE` 缺省（=prod）+ 流水线注入 `DEPLOYMENT_UID` + 无任何 E2E env（`E2E_MODE`/`E2E_AUTH_TOKEN` 都不设），期望 healthz 200 → `Bearer dev-token` 访问 `/v1/watchlist` 返回 401。若漏 `DEPLOYMENT_UID`，实例会被 L65 守卫拒绝启动——那是"配置不全拒启"，不是 G3 的"固定身份入口关闭"。

隔离边界：只监听 `127.0.0.1:18182-18187`/`3200`/`3201`，只连 `market_sense_a19`；不碰 lead 的 8081/3000、生产、真实用户数据。端口被占时 preflight 直接失败，不会复用别人的进程。

## 覆盖的检查

| 分组 | ID | 内容 |
| --- | --- | --- |
| 静态审计 | S1–S7 | bundle 开关、源码 env、`is_entitled` 唯一放行、4 条 HTML 的 SSR/数值、server.mjs 无 SSR、dist 清单 |
| API 受限态 | H1–H11 | 21 组伪造头、10 组 query、8 组路径变异、5 种写方法、bars/fundamental、7 字段白名单、watchlist 认证、诊断路径、403 中性文案、反代 no-store、条件请求/缓存探测 |
| 限流/trustProxy | R1–R4 | 默认桶 429、XFF 不换桶、`TRUST_PROXY=true` 拒绝启动、可信 CIDR 下的条件性换桶（LEAK） |
| 后门/身份 | G1–G4 | `APP_PROFILE` 缺省时 E2E env 拒绝启动、生产 profile 拒 dev-token、裸启动默认 internal_eval |
| 有效态基线 | V1–V3 | quote 200 + no-store、反代 200 + no-store、分页越界 400 拒绝而非 clamp |
| 浏览器受限态 | C1–C6 | 存储/URL/`?mock=` 注毒、运行时二次注毒、SW/CacheStorage、网络层重放 |
| 到期后 phase B | C7–C12 | 有效态对照、bfcache 回退、reload fail-closed、CDP 缓存来源、Resource Timing、DOM 残留 |
| 到期态 | E1–E2 | 到期后伪造头 / instrument 白名单 |

## 常用环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `A19_DATABASE_URL` | `postgresql://ms@localhost:55432/market_sense_a19` | 隔离库 |
| `A19_WEB_DIST` | `web/h5/dist` | 前端产物目录 |
| `A19_EXPIRY_LEAD_MS` | `120000` | 到期转换窗口（秒级可调，过小会来不及跑 phaseA） |
| `A19_PORT_RESTRICTED_API` / `..._EXPIRING_API` / `..._LIMITED_API` / `..._TRUSTPROXY_API` / `..._TRUSTPROXY_CIDR_API` / `..._BACKDOOR_API` | `18182`–`18187` | API 端口 |
| `A19_PORT_RESTRICTED_WEB` / `..._EXPIRING_WEB` | `3200` / `3201` | Web 端口 |

## 产物

- `artifacts/results.json`：**当次**运行的 checks（attempt/expectation/observed/status/severity）与 meta（含 `runId`、`rawHttpLog`、`rawHttpLogEvidence`）。
- `artifacts/http-attempts-<runId>.jsonl`：当次原始 HTTP 往返（每行 `seq/note/method/url/status/headers/body`，`note` 可 grep）；历史 run 的文件全部保留。
- `artifacts/logs/<runId>/`：当次隔离实例日志（含 G1/G2 拒绝启动原文、运行失败栈）；`artifacts/logs/*.log` 为历史 run 日志。
- `artifacts/results-g3-postfix-<runId>.json`：G3 post-fix 专项结果（command/exitCode/observed/log/transcript）。
- `artifacts/evidence-manifest-<runId>.json`：证据清单，逐文件 `path/sha256/bytes/mtime/caseIds/run`（manifest 本身不内嵌自身哈希）。
- `artifacts/run-stdout-<runId>.log`：runner 完整 stdout/stderr。
- `artifacts/http-attempts.jsonl`：旧 truncate bug 的 0 字节墓碑，**不要使用**。
- `artifacts/*.png`：受限/注毒/拦截/有效态/到期刷新截图。

## 维护提示

- post-fix 全量 `results.json` 为 `verdict=NO_BYPASS`（45 PASS / 0 FAIL / 1 INFO）；修复前首轮存档 `results-prefix-g3-20261104T012350680Z.json` 的 `verdict=BYPASS_FOUND` 仅因 R4，R4 修复后见 `REPORT.md` §11。
- 检查只使用公开契约（HTTP + 浏览器 DOM/CDP），不 import 产品源码；产品实现变动不需要改用例，改的是预期响应形态。
- 若报 `column "display_safe" does not exist` 或 preflight 失败：先跑 `provision-db.sh` 重建隔离库（warehouse schema 可能已更新）。
- 若报端口被占：确认没有残留的 A19 实例（`lsof -nP -iTCP:18182-18187 -sTCP:LISTEN`）；harness 正常退出会 SIGTERM 清理自己起的进程。
