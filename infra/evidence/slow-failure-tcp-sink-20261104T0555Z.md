# 11-12 门禁 #4 慢故障（L77）复跑 v3：A3 短路修复后

- **artifact**: `infra/evidence/slow-failure-tcp-sink-transcript-20261104T0555Z.txt`（原始 transcript，未编辑）
- **sha256**: `cebf4f22a3a2863f5f0030411cf76267b6ea4614bfdfbc18713735f3a52544a3`
- **recompute**: A13 / 2026-11-04T05:55Z / `sha256sum` 输出一致 / 结果=一致
- **authority**: authoritative（post-fix；工具源码在 `infra/evidence/tools/tcp-blackhole-proxy.py`，可重放）
- **phase**: post-fix（A3 已改路由顺序：evaluate → requireEntitled → loadInstrument；gate blocked 时 403 不碰 serving）
- 方法：TCP sink（无 root）：`drop` = 接受连接、缓冲、不转发；`pass` = splice 转发到真实 PG 127.0.0.1:55432（库 market_sense）；模式文件热切换。
- 环境：Darwin 26.5.1 / node v23.11.0 / PG 16.15 / API 源码 tsx `services/api/src/server.ts` / PORT=18107；
  `APP_PROFILE=test`、`ENTITLEMENT_TIER=c_end_display`、`ENTITLEMENT_EXPIRES_AT=2030-12-31T00:00:00Z`、`ENTITLEMENT_HOLD_CHECK=1`、`ENTITLEMENT_AUDIT=0`、`DEPLOYMENT_UID=dbg-v4`。
  （用 c_end_display 是为了让 gate 真正读 control；internal_eval 档位下 gate 不读库，黑洞不可见——见"口径"第 3 条。）
- 端点白名单（H4 m02472）：**只含 quote / bars / fundamental-summary 的受限 403**；`getInstrument` 必须读 serving，不计入 #3。

## 四个 number
1. **超时配置**：`services/market/src/plugin.ts` Pool = `connectionTimeoutMillis: 1000`、`query_timeout: 1000`、`statement_timeout: 1000`、`options: '-c statement_timeout=1000'`；control 读 = `withTimeout(..., 1000)`（`entitlement-gate.ts`）。**connect_timeout = 1000ms（≤1s）PASS**。
2. **DROP 期间 quote（20 样本）**：20/20 `403`，`cache-control: no-store` 20/20，**P95 = 2.7ms（阈值 1500ms）PASS**。
3. **熔断后 P95（whitelist 30 样本：quote 20 + bars 5 + fundamental-summary 5）**：30/30 `403`、no-store 30/30，**P95 = 1.0ms、max 1.3ms（阈值 50ms）PASS**。
   （上一版 v2 的 1011ms 是"先 loadInstrument 再 requireEntitled"导致；A3 修复后消失。）
4. **撤除黑洞恢复**：切回 pass 后 **2.04s** 首个 quote=200、healthz `entitlement_degraded:false`；同进程未重启（本测量未 kill/restart）；healthz 响应体不含 DSN/主机名/端口（实测四项 False）**PASS（≤30s）**。
- **healthz（黑洞期间、发请求后）**：200，`entitlement_degraded:true`、`entitlement_degraded_reason:"control_unavailable"`，响应体无 `postgresql://` / `55432` / `market_sense` / `@127.0.0.1`。

## 口径与边界
- #3 只统计受限 403；`getInstrument`（SSE:600519 基础信息）仍会读 serving，按 H4 归入 #4 的 1500ms 口径，不进 #3。
- **不能写"403 永久先于 404"**：A3 语义是"降级档 403 短路；正常档仍 404→403→取数 404"（H4 m02472）；契约/ADR 文案由 Lead+A0 同步，本报告不改变契约语义。
- 本证据证明的是 **API 进程 + 真 PG + TCP sink** 的行为，不证明集群/网络策略（UNVERIFIED，责任人 H5）。

## 复算
```
sha256sum infra/evidence/slow-failure-tcp-sink-transcript-20261104T0555Z.txt
```
