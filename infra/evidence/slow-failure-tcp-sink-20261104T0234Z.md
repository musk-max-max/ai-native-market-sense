# 11-12 门禁 #4 慢故障（L77）：TCP sink 黑洞复跑

- **artifact**: `infra/evidence/slow-failure-tcp-sink-transcript-20261104T0234Z.txt`（原始 transcript，未编辑）
- **sha256**: `568c35a589a876f0373a4faddd37975b071899aa86b2f7b485115812685bbdc2`
- **recompute**: A13 / 2026-11-04T02:36Z / `sha256sum` 输出一致 / 结果=一致
- **authority**: authoritative（注入工具源码同目录落盘，可重放；不是量产环境的 DROP）
- **phase**: post-fix（A3 已补 connectionTimeoutMillis=1000 / query_timeout=1000 / statement_timeout=1000 + control 读 1s 超时）
- 方法：TCP sink（无 root）：`infra/evidence/tools/tcp-blackhole-proxy.py`
  - `drop` = 接受连接、缓冲、不转发（对已建立连接同样是双向丢包）→ 模拟网络分区/DB 卡死；
  - `pass` = 把缓冲字节转发真实 PG 并双向 splice；
  - 工具 sha256 `6a1a92aa9cb50de90bf3b174970587083c167fcf296c9e6752c72f53d4d2fec3`。
- 环境：Darwin 26.5.1 / node v23.11.0 / PG 16.15（127.0.0.1:55432，库 market_sense）/ API `services/api/src/server.ts`（tsx）/ PORT=18098；APP_PROFILE=test，ENTITLEMENT_HOLD_CHECK=1，ENTITLEMENT_AUDIT=0，tier=internal_eval。

## 四个 number
1. **超时配置（静态 + 解析实测）**：`services/market/src/plugin.ts:104-107` = `connectionTimeoutMillis: 1000`、`query_timeout: 1000`、`statement_timeout: 1000`、`options: '-c statement_timeout=1000'`；control 读 `withTimeout(..., controlTimeoutMs=1000)`（`entitlement-gate.ts:166`）。
   - **connect_timeout = 1000ms（≤1s）PASS**
2. **DROP 期间 quote（20 样本）**：全部 `403`，`cache-control: no-store` 20/20；**P95 = 1005.3ms（阈值 1500ms）PASS**。
3. **熔断后 P95**：第二组 20 样本仍全部 `403`，**P95 = 1011.3ms（阈值 50ms）→ FAIL**。
   - 原因（代码事实）：`services/market/src/routes.ts:196-205` 先 `loadInstrument()` 再 `requireEntitled()`；即使 gate 已判 blocked，每条请求仍要付 serving 读的 1s query_timeout（`routes.ts:160-168` 读失败后转 403）。控制面熔断没有覆盖 serving 读路径。
4. **撤除黑洞恢复**：切回 `pass` 后同进程（pid 不变、未重启）首条 quote **14.9ms**，随后请求均为毫秒级 → **≤30s 自愈 PASS（进程级）**；`/healthz` 响应体不含 DSN/主机名/端口（实测 `dsn=False hostname=False port=False`）PASS。
   - 但 **`/healthz` 的 `entitlement_degraded_reason=control_unavailable` 未出现**：整个黑洞期间 healthz 均为 `entitlement_degraded:false`，API 日志也没有 `[market] entitlement 已降级` 告警。这与 A3 旧证据（unreachable 时 reason 存在）不一致，**记 UNVERIFIED 并交 A3 定位**（可能 control breaker 未进入，或 healthz 读到的 gate 状态与请求路径不是同一实例）。

## 判定
- #4 四证：**#1 PASS、#2 PASS、#4 PASS；#3 FAIL**（慢故障下仍每请求付 1s，未实现"快速失败"）。另 #4 的 `/healthz reason=control_unavailable` 证据缺失（UNVERIFIED）。
- 未使用 ECONNREFUSED 数据；无 root DROP 不可构造的限制已在 v1 记录（`slow-failure-timeouts-20261104.txt`），本文件是 post-fix 的 TCP sink 复跑。

## 复算
`sha256sum infra/evidence/slow-failure-tcp-sink-transcript-20261104T0234Z.txt infra/evidence/tools/tcp-blackhole-proxy.py`
