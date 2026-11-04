# services/market —— A3 行情/内容域插件

按 `contracts/{market,fundamental,watchlist}/openapi.yaml`（0.2.0）实现，导出 Fastify plugin 由 `services/api` 外壳挂载。
**不拥有** Fastify 实例、全局错误映射、进程入口；`/healthz` 的存活语义归 A0，本域只通过 `marketPlugin.health()`
贡献 `data_ready` / `data_ready_reason` / `data_quality` 三个字段（见下文「数据就绪」）。**不直接读** `warehouse/` 的 dwd/dim 表（只读 A2 的 `serving.*` view）。

## 路由（外壳统一挂到 `/v1`）

| 方法 | 路径 | 授权（F1） | 数据来源 |
| --- | --- | --- | --- |
| GET | `/instruments/{instrument_id}` | `200 + meta.entitlement`（restricted=internal_eval/false，不整体 403） | `serving.serving_instrument` |
| GET | `/instruments/{instrument_id}/quote` | 已收录：normal 200 / restricted **403 ENTITLEMENT_RESTRICTED**；未收录先 404 | `serving.serving_quote_latest` + 最近成功快照降级 |
| GET | `/instruments/{instrument_id}/bars` | 同上 | `serving.serving_bar_daily`（adj_type 已固化，TS 不复权） |
| GET | `/instruments/{instrument_id}/fundamental-summary` | 同上 | `serving.serving_fundamental_summary`（P0 常无数据 → 404 NOT_FOUND） |
| GET/POST/DELETE | `/watchlist[/{instrument_id}]` | bearerAuth；恒 `platform_user_data/true`，不参与 F1 矩阵 | 本域表 `watchlist_items`（迁移 `migrations/001_watchlist.sql`） |

403 Problem 的人类可读层为中性产品语言（`title=行情数据暂不可用`、`detail=当前版本暂不提供该标的行情数据`），**不得出现「授权/未取得/法律」等定性**；`code=ENTITLEMENT_RESTRICTED` 保持不变（机器可读、契约冻结，A11/A12 断言依赖）。契约未要求客户端回显该码，前端如塞进 DOM 属性属二次暴露（A7 在改）。

错误码与判定顺序（A0/shared 0.2.1 + Lead m00443）：**先确认标的存在性**（`INSTRUMENT_NOT_FOUND`=标识不存在/未收录）→ **再判 entitlement**（`ENTITLEMENT_RESTRICTED`=已收录但 tier 无权看内容）→ **再取数**（`NOT_FOUND`=存在但无行情/财报/路由）。`VALIDATION_ERROR`=参数非法/自选上限/数值字段格式非法；`UNAUTHENTICATED`=自选无凭据。错误体一律 `application/problem+json`，由外壳注入 `trace_id`。

## 挂载方式（A0 接线）

```ts
// services/api/src/domains.ts
import { marketPlugin } from '../../market/src/plugin.js';
export const domainPlugins = [marketPlugin];
```

`marketPlugin` 已带 `Object.assign(..., { domain: 'market', contractVersion: '0.2.0' })`；插件自建 `pg.Pool`（`DATABASE_URL`）并在 `onClose` 中 `pool.end()`。单测用 `createMarketPlugin({ config, servingRepo, watchlistRepo, authenticate })` 注入假实现。

## 配置（env，仅本域）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ENTITLEMENT_TIER` | **`internal_eval`** | **缺省=最小授权**（绝不默认最大授权）；E2E normal 显式设 `c_end_display` |
| `APP_PROFILE` | **`prod`** | L46：只有显式 `dev`/`test`/`e2e` 才允许 E2E 后门；未设/空串/拼错一律按 `prod`，与 `E2E_MODE=1`/`E2E_AUTH_TOKEN`/`WATCHLIST_DEV_AUTH=1` 并存时**拒绝启动**。E2E compose 必须显式设 `APP_PROFILE=e2e` |
| `ENTITLEMENT_EXPIRES_AT` | — | **`tier != internal_eval` 时必填**；缺失=拒绝启动（fail-closed 时间盒，不是"不启用"）。ISO8601 带时区；到点后行情/财务 403 `ENTITLEMENT_RESTRICTED`（不降级成空数据），`meta.tier` 回显 effective `internal_eval` |
| `DATABASE_URL` | — | `serving.*` 只读角色 + 自选表读写（E2E compose 已提供） |
| `DISCLAIMER_VERSION` | `2026.11.1` | 必须匹配 `^[0-9]{4}\.[0-9]{2}\.[0-9]+$`；文案最终由 A5/H3 定稿（`DISCLAIMER_TEXT` 可覆盖，当前为占位） |
| `DISCLAIMER_TEXT` | 占位免责文案 | **占位，非 A5 正式 rule_version**（Lead m00677 允许保留到 E2E）；A5 定稿后由 `DEFAULT_DISCLAIMER_TEXT`/env 替换，`test/market-plugin.test.ts` 的占位断言会变红提醒 |
| `WATCHLIST_LIMIT` | `100` | 单用户自选上限（超限 400） |
| `WATCHLIST_TABLE` / `E2E_WATCHLIST_TABLE` | `watchlist_items` | 合法 SQL 标识符 |
| `E2E_MODE=1` | — | 开启 dev bearer token（`E2E_AUTH_TOKEN`）与启动兜底建表（幂等） |
| `E2E_AUTH_TOKEN` / `E2E_AUTH_USER_ID` | — / `e2e-user` | 仅 E2E/本地；生产无此入口（401） |
| `MARKET_NOW` | — | 固定时钟（测试/演练用）；**L73：prod 设置即拒启**（可让时间盒提前到期判定失效），仅显式 dev/test/e2e 允许 |
| `ENTITLEMENT_CONFIG_EXPECTED_SHA256` | — | 流水线注入的配置指纹（64 位小写 hex，`sha256("${tier}|${expiresAt ?? ''}")`，expires 取 `toISOString()`）。**tier≠internal_eval 时生产必填，缺失=拒绝启动**；仅 `E2E_MODE=1` 可豁免；不一致时 effective=internal_eval + 写 `unauthorized_config` 事件 |
| `ENTITLEMENT_HOLD_CHECK` | E2E 默认关 / 生产默认开 | 读 `audit.entitlement_hold_state` control 行（`market_app` 仅视图 SELECT）；**L73：prod 设 `0` 直接拒启**（放行 flag），仅显式 dev/test/e2e 可关 |
| `ENTITLEMENT_AUDIT` | E2E 默认关 / 生产默认开 | 写 `audit.entitlement_events`（A3 只 INSERT 4 类事件）；**L73：prod 设 `0` 直接拒启**（等于关掉整条审计链），仅显式 dev/test/e2e 可关 |
| `INGEST_REPORT_PATH` | `/state/ingest-report.json` | ingest-once 报告路径（`/healthz` 数据就绪字段来源，只读） |
| `EVENT_PAYLOADS_PATH` | 仓库 `docs/reference/event-payloads.json`（镜像内 `/app/docs/reference/event-payloads.json`） | L70 事件 payload 键集唯一真源；prod 缺文件/坏 JSON 拒启，非 prod 告警跳过校验 |

## 数据就绪（/healthz 贡献，A12 INGEST-ONCE-CONTRACT §4）

`marketPlugin` 与 `createMarketPlugin` 都带 `health()`（见 `src/health.ts`），外壳把它合并进 `/healthz` 200 响应体：

```json
{ "data_ready": false, "data_ready_reason": "INGEST_FAILED:load", "data_quality": "yellow" }
```

- 报告缺失 → `INGEST_REPORT_MISSING`；损坏/自相矛盾 → `INGEST_REPORT_INVALID`；`quality_level=red` → `QUALITY_RED`；
- `data_ready=true` 时**不输出** `data_ready_reason`（否则 preflight 判 CONTRADICTION）；
- 读文件/解析失败一律收敛为 `data_ready=false`，绝不让 `/healthz` 500。

## 授权闸门（H4/H5 + Lead L27）

每请求顺序：① **本地时间盒**（`now >= expires_at`，不依赖 PG，到期即 403）→ ② **control 行**
（`audit.entitlement_hold_state`（视图列 `hold_reason AS reason`）：`hold=true` → 403；`last_reconciled_at` 缺失或 >15 分钟 → 403；缓存 30s）→ ③ **env tier**
（仅 `c_end_display` 放行）。`meta.entitlement.tier` 永远回显 **effective tier**（降级时为 `internal_eval`）。

- **确定性配置错误**（`42P01` 表不存在 / `42501` 权限不足 / schema 不匹配）→ 启动直接失败（crashloop，L27）；
- **瞬态故障**（连接断/超时/PG 不可用）→ 不 crash：`degraded_unauthorized`，行情/财务 403、基础信息照常、`/healthz`
  输出 `entitlement_degraded: true`，5s 负缓存 + 3 次失败熔断 30s，恢复后回 env tier；
- 内部原因只进日志/health/事件，对外 403 文案统一中性；**不发 `X-Entitlement-Cause` 响应头**（H3 m01357 / Lead L56：
  响应头属客户端可达出口，不做单一原因区分；诊断靠事件 + `trace_id` 反查）。`control_stale`/`control_unavailable`
  只活在 `DegradedReason` 内部，不进任何 HTTP 出口；
- 到期降档与留痕同一件事（L20/L59）：启动时先算 effective tier（到期→`internal_eval`）→ 写
  `entitlement_expired`（reason=`expires_at_passed`，event_key=`exp|<tier>|<expiresAt UTC 毫秒 ISO>|<reason>`，
  不含 boot_id，重启幂等）→ 才开始服务；写失败保持低权限并记 degraded，不回滚；
- 事件只写 A3 的 4 类（`tier_state_observed`/`entitlement_expired`/`entitlement_flip`/`unauthorized_config`；
  `hold_set`/`hold_clear` 由 A5 的 `audit.raise_hold`/`audit.clear_hold` 函数写，`tier_switch` 由 CI 写），
  schema owner=A5、迁移/GRANT=A13；reason 词表按 L49 的 6 值，runtime degrade reason（control_*/hold_active）只进日志/health。

## 响应缓存（H4 m00830/m00840）

凡响应体含 `meta.entitlement`（**包括 getInstrument 的 200**）与所有 403 一律 `Cache-Control: no-store`；
防止 CDN/ingress 在授权到期后继续缓存并"渲染"已拒绝内容。SSR/预渲染不得把行情数值烤进 HTML（A7 负责）。

## 授权到期 fail-closed（H3 时间盒 / ADR-004）

`ENTITLEMENT_EXPIRES_AT` 到点后（`now >= expires_at`，边界按已过期处理）：quote/bars/fundamental-summary
返回 403 `ENTITLEMENT_RESTRICTED`（不返回 data、不降级快照、不返回空串）；`getInstrument` 仍 200，但
`meta.entitlement.is_entitled=false`。判定点在 `src/domain/entitlement.ts:isEntitlementExpired`，单测用
`loadMarketConfig` 真实解析 env 后驱动（见 `test/market-plugin.test.ts` 的「授权到期 fail-closed」）。

## getInstrument 正向白名单（H4 基础信息口径）

**C 端受众（L30）**：`serving.serving_instrument.display_safe=false` 的标的不进 C 端结果集（repo 层按
`audience='c_end'` 过滤，标识不存在/未收录 → 404 `INSTRUMENT_NOT_FOUND`），内部评测态仍可读取。

`getInstrument` 只输出 `instrument_id / name / exchange / board / security_type / list_status / listed_at`
（`INSTRUMENT_PUBLIC_FIELDS`，`src/domain/build.ts`），**默认拒绝**其他字段：`price/volume/change_pct/lot_size`
等一律不返回，也不得用 `0`/`"--"` 占位。`assertInstrumentWhitelist` 在运行时兜底，往响应里多塞一个字段会抛
`ServingDataError`（500 Problem，不静默丢弃）。

## 缓存降级（system_prompt 硬规则 #2）

- 进程内 `SnapshotCache`（LRU 500，**不新增 Redis**——加缓存层属架构变更，已按 `must_escalate` 边界处理）；
- 读 `serving.*` 成功 → 缓存完整响应；读失败 → 返回最近成功快照：`data` 原样、`meta.source.source="platform_snapshot"`（`staleness_ms>900000` 时 `"platform_degraded"`）、保留原 `as_of`、按当前时刻重算 `staleness_ms`；命不中快照才抛 500 Problem（绝不 200+空 data）；
- 页面据 `platform_snapshot`/`platform_degraded` / `staleness_ms>900000` 展示「数据截至 X」与 stale 标记（E2E-P0-04/05）。

## 自选持久化

`watchlist_items(user_id, instrument_id, added_at)`，主键 `(user_id, instrument_id)`，`ON CONFLICT DO NOTHING` 实现幂等（重复 POST 返回首次 `added_at`），DELETE 不存在也 204。
执行点：E2E/本地 `E2E_MODE=1` 启动时幂等建表；**生产迁移归 A13 发布流水线**（A0 明确不代跑迁移脚本），A3 交付 `migrations/001_watchlist.sql`。

## 开发/自测

```bash
pnpm --filter @market-sense/market typecheck   # tsc --noEmit（依赖 A0 修 packages/api-client/src/index.ts 的 SharedComponents 编译错误）
pnpm --filter @market-sense/market test        # node:test + fastify.inject，86 条，无需 PG
```

测试覆盖：F1 三接口 403 / instrument 200+internal_eval / watchlist platform_user_data、存在性 404 先于 403、
quote 停牌三态、bars 口径回显与参数校验、404 语义、来源词表映射（platform_eod/fundamental/watchlist、source_id 溯源）、
降级快照与无快照 500、自选鉴权/幂等/上限、H3 红线字段扫描、授权到期 fail-closed、**fail-open 默认值（缺省
tier=internal_eval、非 internal 缺 expires/期望指纹拒绝启动、effective tier）**、ingest-report → data_ready 解析、
getInstrument 白名单、**no-store、display_safe 受众过滤、control hold/stale/缺失/瞬态降级/熔断、指纹不一致、
事件重试与上报、copy.ts 中性文案**。

## 真栈验证脚本（task-8 / A11 复跑）

`scripts/real-stack-audit.ts`：在本地 PG16（已应用 dwd/serving/A5 audit migration `c8116e4f…` + `20_grants.sql`；fixture 由脚本幂等自种，无需外部 seed）上验证
hold 生效→quote/bars/fundamental 403（无 `X-Entitlement-Cause`）、getInstrument 200 且递归无行情字段、
清 hold 后下一请求立即 200、事件写库/重放幂等（`event_key` 唯一）/hash 链连续。

```bash
# 应用角色（market_app）与管理员连接串；schema 由迁移负责，fixture 脚本自种
MARKET_TEST_DATABASE_URL=postgresql://market_app@127.0.0.1:55432/market_a3_test \
MARKET_TEST_ADMIN_DATABASE_URL=postgresql://ms@127.0.0.1:55432/market_a3_test \
node --import tsx scripts/real-stack-audit.ts
```

最近一次输出（2026-11-04，A5 001 sha `c8116e4f…`）：`normal quote 200 instrument 200 cache no-store`；
`hold quote/bars/fundamental 403 403 403 codes ENTITLEMENT_RESTRICTED ...`；
`hold instrument 200 entitlement {"tier":"internal_eval","is_entitled":false}`，`market-field leaks []`；
`after clear (immediate) quote 200`；`hold_set 1 / hold_clear 1 / tier_state_observed 1`；重放后 observed 仍 1；
`chain problems 0`；`expired startup quote 403 events 1 key exp|c_end_display|2026-10-31T16:00:00.000Z|expires_at_passed`（到期降档留痕，重启幂等）。

## 已知外部依赖（非本包代码可解）

1. **A0**：已接线完成（`DomainPlugin.health?` + `/healthz` 合并 + `services/api/Dockerfile` 已存在）；A3 已用 `buildApp + createMarketPlugin` 端到端 inject 验证：报告正常→`data_ready:true, data_quality:green`；报告缺失→200 + `data_ready:false, data_ready_reason:INGEST_REPORT_MISSING`（不 500）。
2. **A2**：`warehouse/serving/*` view 必须先于本服务就绪（E2E bootstrap 顺序 dwd → serving）；只读角色只 GRANT `serving` schema。
3. **A5/H3**：免责文案定稿（当前 env 占位）。
4. **A5**：`audit.entitlement_events` + `audit.entitlement_hold` DDL 已落 `services/compliance/migrations/001_audit_entitlement_events.sql`
   （DL 唯一真源；`audit.entitlement_hold_state` 只读视图、event_key 触发器权威计算）；**A13**：真栈迁移执行、`20_grants.sql`
   （events 列级 INSERT-only、hold 视图 SELECT、bootstrap seed）、指纹共享测试向量。E2E 需显式 `ENTITLEMENT_HOLD_CHECK=1`/`ENTITLEMENT_AUDIT=1` + `APP_PROFILE=e2e`。
5. **Lead/A1/A11**：E2E-P0-07 与 M06 pending-data 冲突（fundamental-summary P0 恒 404）——本实现不造假数据。
6. **A12**：E2E fixtures 录制（空 recordings 导致 FIXTURES_PENDING）与 compose bootstrap 中执行 `migrations/001_watchlist.sql`（或依赖 `E2E_MODE=1` 自动建表）。
