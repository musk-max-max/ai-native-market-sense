# 越权用例集（EXC-*）设计稿

> 状态：**设计稿 v1（2026-11-05）**。执行方 A19（红队用例）/ A12（E2E 固化）/ A11（门禁口径）；A9 只定 id、字段与可判定式。
> **不写「越权测试全绿」**：主机管理面（H5 门禁 ⑤）未通过前，本文所有用例状态不得汇总为 PASS。
> 关联：`../findings/register.md`（SEC-004/005/006）、`../gate/release-gate-block-2026-11-05.md` §4、A19 artifact `370c6bb`。

## 1. 命名与字段（A19 已对齐）

- **ID**：`EXC-<SURFACE>-<NN>`，`SURFACE ∈ {API, HOST, TUNNEL, RATE, AUDIT, DATA}`。不用 `H-` 前缀（与人类席位 H1–H6 冲突）。
- **一条一例**，字段固定（YAML front-matter 或表格均可）：

```yaml
case_id: EXC-HOST-01
title: 主机层 root/docker → Postgres 直读绕过 API 403
surface: HOST
severity_expected: bypass          # informational | bypass | amplification
preconditions: [目标主机 SSH 可达, 有 docker 执行权, API 侧 quote 返回 403]
steps: [ ... ]
oracle: "api_quote_status == 403 AND db_rows > 0"   # 必须可机器判定
evidence_fields: [vantage, command, status, row_count, sample, staleness_ms, entitlement_env, audit_event_count, ts]
safety: 只读 SELECT；不写库/不改容器；窗口结束 kill 隧道并记录 0 监听
authorization: >-
  H5 书面授权 + A19_HOST_LAYER_APPROVED=1；当前 H5 已令停掉对 ECS 的主动测试 → blocked
owner: A19（执行）/ A9（口径）
status: blocked                    # design | blocked | run | pass | fail
```

- **oracle 必须是可判定式**（返回布尔或枚举），不得写「人工观察/符合预期」。同一用例在不同 tier 下若判定不同，写成两条。

## 2. 用例清单

| ID | 标题 | surface | oracle（判定式） | 现状 | 依据 |
|---|---|---|---|---|---|
| EXC-API-01 | 未认证访问受授权接口 | API | `status==401 OR (status==403 AND body 无大写数值)` | 现有 | A19 I 系列：quote=403、watchlist=401 |
| EXC-API-02 | 无效/过期 token（`dev-token`） | API | `status==401` | 现有 | A19：dev-token 仍 401 |
| EXC-API-03 | `internal_eval` 下行情数值不可见 | API | `status==403 AND body 无 price/close/open/high/low/pct_chg 数值 AND cache-control 含 no-store` | 现有 | A19：403 + no-store + 中性 detail |
| EXC-API-04 | 403 后 DOM 不残留数值 | DATA | `quotePriceNodes==0 AND 无小数/货币/9999` | 现有 | A19 Playwright 实测 |
| EXC-API-05 | hold 生效期全量 403、基础信息 200 且无数值 | API | `quote/bars/fundamental==403 AND instrument==200 AND instrument.body 无行情字段` | **blocked**（运行态 `HOLD_CHECK=0`） | SEC-003；task-8 |
| EXC-API-06 | 事件可回指且幂等 | AUDIT | `hash 链连续 AND event_key 唯一 AND 重放后行数不变` | **blocked**（`audit.events` 0 行） | SEC-003；门禁第 6 条；task-8 |
| EXC-HOST-01 | 主机层→DB 直读（root/docker） | HOST | `api_quote_status==403 AND db_rows>0` → `BYPASS`；若 `audit_event_count==0` 附 `audit_gap=1` | **blocked**（H5 停 ECS 主动测试） | SEC-004；A19 H-DB-01 草案 |
| EXC-TUNNEL-01 | 隧道二次转发给第三人 | TUNNEL | 第三人 vantage 可取 web/行情（`status∈{200,403}`）且服务端日志**无主体区分** → `AMPLIFICATION` | **blocked** | SEC-006；A19 H-TUN-01 草案 |
| EXC-RATE-01 | 共享 bucket 单用户 DoS 同侪 | RATE | 用户 A 打满 burst 后，用户 B 请求 `429` | design（需身份才能构造两用户） | SEC-005 |
| EXC-AUDIT-01 | 审计关闭时是否可被门禁发现 | AUDIT | `ENTITLEMENT_AUDIT==0 AND healthz 显示健康` → `SILENT_DEGRADE` | design | SEC-003；`/healthz entitlement_degraded=false` |

> `EXC-API-05/06`、`EXC-HOST-01`、`EXC-TUNNEL-01` 是「越权测试全绿」的前置：前两条证明**授权生效**，后两条证明
> **授权边界不只在 API 层**。缺任一条，「全绿」不成立（见 gate 文档 §4）。

## 3. 两条新增用例的取证约束（A9 口径）

**EXC-HOST-01**
1. 只读：仅 `SELECT count(*)` + 单列样本（如 `close`、`as_of`），**不 dump 全表**（证据充分性 + 数据最小化）。
2. 同时记录：API 侧 status/body 摘要、`ENTITLEMENT_AUDIT`/`HOLD_CHECK` 运行值、`audit.entitlement_events` 计数、`staleness_ms`。
3. 「读到数据」不是唯一结论：**若 `audit_event_count==0`，必须同时记 `audit_gap=1`**——这正是 SEC-003 的证据。
4. 禁止：写库、改容器、改配置、`docker start` 任何容器。

**EXC-TUNNEL-01**
1. vantage 分层（可信度递增）：① 本地隔离栈 + 同 LAN **第二台机器**（证明跨主机第三人可达）；② 无第二台机器时用同主机
   one-shot 客户端容器，并在证据里**显式标注**这只是「绑定存在性」、不构成第三人可达结论；③ 真实目标仅在 H5 书面授权 +
   `A19_HOST_LAYER_APPROVED=1` 时跑。
2. 记录两跳命令、vantage、`status`/body 摘要、源 IP、`X-Forwarded-For`、`trustProxy` 实际值、服务端 audit 计数与日志中是否存在主体标识。
3. 结束：`kill` 隧道并记录 0 监听（A19 T1 口径）。
4. 判定不得写成「第三人看到了 403 所以安全」—— 403 只能证明当前 tier；tier 合法切到 `c_end_display` 后第三人即无身份看到数值，
   结论应写「入口可达 + 无主体区分 → 再分发放大」。

## 4. 执行前置（硬）

- 门禁 ⑤ 主机管理面 **未通过前**：不得在 ECS 跑 EXC-HOST-01/EXC-TUNNEL-01（H5 已令停掉 ECS 主动测试）。
- 所有真实目标用例必须带 `authorization` 字段且可追溯到 H5 书面授权记录；缺授权 = `blocked`，不是 `skip`。
- 用例结果证据落 `infra/evidence/` 并登记 manifest（authoritative 才可用于门禁；demo/synthetic 只作机制冒烟）。
- 任何用例发现新的高危 → 按 roster：立即升级 H5，修复前阻断相关用例，**不得「记录待修」**。
