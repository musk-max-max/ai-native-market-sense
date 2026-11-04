# S0 状态快照（2026-11-04 08:45，Lead 亲验）

> 本文件只写**我本人执行过命令验证过**的事实。agent 自报未复核的，标注「自报」。

## 一、当前可运行的东西

| 层 | 状态 | 证据 |
|---|---|---|
| 数据链路 | ODS → DWD → 质量门禁 → serving → API → H5 | 坏数据 quality 80/black，`load` 退出 3 且**不连库**；好数据 100/green |
| 真栈 | 本机 Postgres 16 + API 8081 + Web 3000 | `/healthz` 200，`/v1/instruments/SSE:600519/quote` 200 |
| E2E | **10 passed / 1 skipped**（5.2s） | 点自选 → 刷新 → 仍在；UI/API/DB 三处一致 |
| 单测 | `258 passed, 1 skipped`（根，Lead 2026-11-04 亲跑 13.7s）+ `133 passed`（ingest） | `pytest tests/contract tests/data warehouse/tests` |
| 类型 | `pnpm -r typecheck` 5/5 Done | api / market / web-h5 / ingest / api-client |
| 契约 | 4 域 OpenAPI + 生成客户端 | oasdiff 无破坏性变更，redocly 0 error |

## 二、必须说清的三条限制（别读成"完成了"）

1. **M2 演示用的是合成数据。** 截图里 `SSE:600519` 收盘 10.30，来自 `data/golden/p0_bars20.yaml:32`；真实 2024-01-04 收盘约 1685。M2 证明的是**链路通 / 契约一致 / 护栏生效**，不证明数据正确。
2. **F1 数据授权未取得**（时间盒 2026-11-12）。当前 `entitlement.tier=internal_eval`，C 端不渲染行情。11-12 后仍未取得 → 服务端拒答，不是降级。
3. **CI 从未在真实 runner 跑过**（仓无 git remote）。5 个 workflow 只过 actionlint；`helm` 渲染与 oasdiff 破坏性 diff 两处 skip 属环境缺件。

## 三、11-12 门禁（8 + 4 条，H5 按此签）

**entitlement**：①到期 fail-closed（quote/bars/fundamental 三路径分别断言）②配置非法→启动失败（退出码≠0 且端口未监听）③`(c)` 白名单 7 字段 ④hold/stale 生效 + 403 不可复用 + 凡含 `meta.entitlement` 的响应 `no-store` ⑤渲染无占位、四原因文案一致 ⑥事件可回指且幂等（含 hold set/clear 与 deploy）⑦前端无可绕开关（A19 攻击必须失败）⑧裸启动 → 403 + `internal_eval`

**限流**：①第 61 次 429 + `Retry-After` 整数 ≥1s ②problem+json `RATE_LIMITED` ③伪造 XFF 不换桶 ④文案不露内部码

当前：PASS 4.5 条；FAIL 1（no-store）；BLOCKED 3（hold/stale、事件、限流）。

## 四、唯一硬依赖

| 依赖 | owner | 卡住什么 |
|---|---|---|
| `audit.entitlement_events` / `control` 迁移 | A13（A5/H3 review） | A3 写事件、A11 三条断言、H5 签字 |
| api 出口层两件套（no-store + 限流） | A0 | 门禁 #4 与限流桶 |

## 五、等用户决定

1. **11-12 授权主体**：以哪个主体签、有没有资质。
2. **是否接 git remote**：不接则 CI 永远「未验证」，H5 不签发布。

## 五、今天新增的裁定（`agents/decisions.md`）

| 编号 | 一句话 |
|---|---|
| L41 | `ioredis` 批准（限流须跨副本共享）；oasdiff 报不出"删 optional response property"是门禁的洞 |
| L42 | `display_safe` 不许路径信任，改证据式合取派生，默认 false |
| L43 | manifest 完整性由**读取方**验证（`prev_hash`/`head` 链），不由写入方声明 |
| L44 | hash 只能脚本重算；`E2E_MODE` 生产拒启；清单不得代人签字 |
| L45 | 不自写 differ，用 oasdiff `--severity-levels`；两处门禁口径必须同一个文件 |
| L46 | `APP_PROFILE` 缺省 prod，开发必须显式声明；`NODE_ENV` 退出安全判定 |
| L47→L48→L49 | `reason` 最终单列 6 值；我改判两次，教训写在 L49 末尾 |

## 六、唯一硬依赖（等决策）

`entitlement.tier` 停在 `internal_eval` ⇒ 恒 403 ⇒ **C 端页面为空**（连证券名称都取不到，基础信息还须来源解耦）。
时间盒 2026-11-12。三条路：A 拿 tushare 商用+再分发授权 / B 找持牌数据商转授权（8–30 万/年）/ C 降级为非行情工具。

## 门禁 #7 红队（2026-11-04）

- 结果：46 checks → 44 BLOCKED / 1 LEAK（R4，条件性）/ 1 INFO；**无 BYPASS**。
- **状态：#7 = `PENDING-H5`**，不记 PASS。R4（`TRUST_PROXY` 覆盖直连 IP 时 XFF 可换桶，429→403，不产出行情数值）须 H5 判风险接受或按 `L69` 三条件修完复跑后方可转 PASS。
- 证据口径：受限态判定只认隔离栈（18182–18187/3200–3201）+ 独立库 `market_sense_a19`；本机 8081 为有效态 demo，不得作未授权证据。
