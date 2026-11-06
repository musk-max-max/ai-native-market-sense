# G-03 判定材料：services/approval/ 写路径实现评估（只读勘察）

- 快照时间：2026-11-06 18:50:50（Asia/Shanghai）
- 勘察者：A4（a4-backend-identity-approval-crm）
- 勘察方式：**只读**（glob/read/grep + `tsc --noEmit`），对 services/approval/ 零写入（遵 L136 写域仲裁）
- 供 H2 判定 G-03（原记录：「services/approval/ 写路径未实现，契约在、实现缺」）

---

## 0. 结论摘要（给 H2）

1. **G-03 原命题已不成立**：旧编制残存会话自 18:14:53 起连续产出，截至 18:50:50，
   services/approval/ 写路径（审批单 6 操作 + 配置/发布 10 操作 + Fastify HTTP 插件 +
   Memory/PG 双存储 + DDL）**已在源码层面全部落地**。
2. **L51（approval_ref 唯一生成点）符合**：全链路只复用 identity 域
   `services/identity/src/domain/approval-ref.ts` 的 `generateApprovalRef()`，
   请求体携带 approval_ref 被拒绝（INVALID_SYSTEM_FIELD），消费侧只读校验不生成。证据见 §4。
3. **但尚未达到可验收状态**（快照时点）：
   - `npm run typecheck` **红**：8 个类型错误（原文见 §6），且出错文件仍在被改写；
   - `test/` 目录**不存在**，0 测试，`npm test` 无法执行；
   - 产出仍在进行（最新写入 18:50:12，距快照 38 秒），**快照非终态**。
4. **建议裁定**：G-03 改判为「**实现已落地、待接管验收**」——最终判定按 L136 等
   services/approval/ 静默 ≥15min 后，由 A4 执行接管 review + typecheck + test，
   以带 commit 锚的证据包回补 H2。本材料为过程证据，不替代接管验收。

---

## 1. 文件清单与产出时间线（untracked，git 未入库）

| 时间 | 文件 | 规模 |
|---|---|---|
| 18:14:53 | package.json / tsconfig.json | — |
| 18:15:29 | migrations/001_approval.sql | 226 行 |
| 18:16:15–18:17:45 | src/domain/{canonical,errors,evaluation}.ts | — |
| 18:26:56 | src/domain/ledger.ts / src/ports/stores.ts | — |
| 18:27:06 | src/adapters/memory-store.ts | 232 行 |
| 18:34:27 | src/domain/{validation,diff}.ts | 550/115 行 |
| 18:37:17 | src/services/approval-service.ts | 508 行 |
| 18:39:37 | node_modules/ 安装（@types/node、pg 就位 → TS2688 已消） | — |
| 18:44:29 | src/domain/types.ts（改写） | — |
| 18:45:55 | src/services/config-service.ts | 629 行 |
| 18:48:37 | src/plugin.ts（HTTP 层） | 398 行 |
| 18:50:00 | src/adapters/pg-store.ts | 493 行 |
| 18:50:12 | src/index.ts（导出入口） | 70 行 |

**快照时点缺失**：`test/` 目录（0 测试）。
**接线缺口**：`services/api/src/domains.ts:17` 仍为
`[identityPlugin, marketPlugin, aiPlugin]`，approvalPlugin/configPlugin 尚未注册（A0 owns）。

---

## 2. 写路径实现对照（契约 vs 实现）

### 2.1 approvals（contracts/approval/openapi.yaml，6 操作）

| 契约 operationId（行锚） | 实现 | 备注 |
|---|---|---|
| createApproval（:44，POST /v1/internal/approvals） | approval-service.ts `create()` + plugin.ts:179 | Idempotency-Key 必填（plugin.ts:130 校验 8–128）；201+Location |
| listApprovals（:88） | `list()` + plugin.ts:194 | query 六过滤 + limit/cursor |
| getApproval（:152） | `get()` + plugin.ts:216 | — |
| evaluateApproval（:182） | `evaluateApproval()` + plugin.ts:223 | 恒 yellow_route（evaluation.ts，规则引擎未实现不假绿） |
| decideApproval（:219） | `decide()` + plugin.ts:230 | 403 approver_not_human / self_approval；幂等重放在状态检查前 |
| listApprovalEvents（:263） | `events()` + plugin.ts:244 | seq 游标分页 |

### 2.2 configs/releases（contracts/config/openapi.yaml，10 操作）

config-service.ts（629 行）实现 list/get/putDraft/validateOnly/submit/publish/rollback/diff/
listReleases/getRelease，全部在 plugin.ts:264–391 挂路由：
- M1 矩阵落地：PUT If-Match 不符 → 409+三点 diff（config-service.ts:117–133）；
  submit/publish expected_version 不符 → 412（:203、:295）；approval 状态冲突 → 409。
- V-01–V-10 语义校验在 domain/validation.ts；V-12 policy_version 发布时硬校验（:301–310）；
  V-13 query environment 为准（:136）。
- submit 建审批单走 `approvals.create()`（:234），binding=purpose config_publish（:257）；
  publish 走 `requireApprovedBinding()` + 一 ref 恰一次消费（:303、:330）；
  rollback `assertApprovedFor` + 复用已用 ref → 409 approval_ref_reuse（:361–365）。

### 2.3 存储与 DDL

- 端口 `src/ports/stores.ts`：DomainStore 单契约，头注「每方法=一个事务边界」。
- `src/adapters/memory-store.ts`（232 行）：全接口实现，hash 链、keyset 游标、append-only。
- `src/adapters/pg-store.ts`（493 行，18:50:00 刚落盘）：**未勘察未验证**（新写出，等接管 review）。
- `migrations/001_approval.sql`：approval_ref UUIDv7 CHECK（M2 内建）、events append-only
  触发器、幂等 PK、ops_configs/versions/releases/release_bindings、audit_events 7 类；
  **status 枚举无 cancelled（G-04 契约缺口仍在，contracts/ 归 H2）**；expired 在枚举但无
  实现（G-05 要求不得实现，符合）。

---

## 3. HTTP 层（plugin.ts，18:48:37）

- 双插件 `createApprovalPlugin`（6 路由）/ `createConfigPlugin`（10 路由），前缀 /internal/*，
  由壳 registerDomainPlugins 以 /v1 注册 → 完整路径与契约一致。
- 错误面按 H2 m00177 口径：409/412 含 diff/approval_ref/current_status 扩展在插件内直发
  problem+json（plugin.ts:73–96），其余抛 HttpProblem 走壳统一映射。
- agent 身份经 `x-model-version` 头补 model_version（plugin.ts:118–123）。
- **风险**：`sharedServices` 模块级单例（plugin.ts:39–54），默认 MemoryDomainStore 进程共享；
  PG 由部署注入 DATABASE_URL（pg-store.ts 刚落盘、未验证）。

---

## 4. L51（approval_ref 唯一生成点）符合性证据

1. **唯一生成点复用**：approval-service.ts:12
   `import { generateApprovalRef, uuidv7 } from '../../../identity/src/domain/approval-ref.js'`
   → 与 identity 域同一实现，无第二处生成器。
2. **唯一调用位**：approval-service.ts:261 `const approvalRef = generateApprovalRef();`，
   位于 `create()` 建单事务（`store.insertApplicationWithCreatedEvent` 单方法原子落库）内。
3. **请求体拒绝自造**：approval-service.ts:112 请求键为 approval_ref 时
   issue code=`INVALID_SYSTEM_FIELD`（allowed 列表 :109–111 不含 approval_ref）。
4. **消费侧只读**：config-service.ts:57–58 wire 校验正则 `WIRE_APPROVAL_REF_PATTERN`；
   publish/rollback 只校验并消费请求传入的 ref（:512、:543），不生成；
   submit 不接收 approval_ref（allowed :478），建单时由 `approvals.create()` 生成（:234–255）。
5. **路由层无生成**：plugin.ts 16 条路由无任何 ref 生成调用（全文仅 import 与透传）。
6. **Console 侧（G-02）**：web/console/src/pages/ApprovalQueuePage.tsx:63 仍在自造
   `console/${selectedId}`（快照时点未变）——归 Console adapter 改造（L135 ④案 b），与本域不冲突。

**结论：L51 在 services/approval/ 实现内符合。**

---

## 5. 遗留缺口清单（供 H2 分级）

### A 级（阻断验收）
- A1：`npm run typecheck` 红，8 errors（§6），出错文件 plugin.ts/config-service.ts 在快照后仍在改写。
- A2：`test/` 不存在 → 0 测试；L136 接管条件（review+typecheck+test）目前无法满足 test 半边。
- A3：产出未静默（最新 18:50:12），快照非终态；旧席仍在写。

### B 级（功能/一致性缺口）
- B1：`ledger.verifyChain`（断链停用）从未被调用——approval-service.ts:235–242 注释声称
  「账本完整性自检：断链即停用该单」但 `loadOrThrow` 直接 return，自检未接线。
- B2：多步写非原子：putDraft=3 次 store 调用（:150/:160/:170）、publish=5 次（:329–:336）；
  stores.ts 头注「每方法=一事务边界」但跨方法无 unit-of-work，PG 实现需在接管 review 时核证。
- B3：`services/api/src/domains.ts:17` 未注册 approvalPlugin/configPlugin（A0 owns，需排期）。
- B4：`submit` 幂等键拼入 `uuidv7()`（config-service.ts:253）→ 每次全新，重放保护失效
  （注：contracts/config 未要求 Idempotency-Key，故非违约，属纵深防御缺口）。
- B5：events 游标 `parseInt` 无 NaN 守卫（approval-service.ts events）→ 畸形 cursor 返回空页而非 400。
- B6：memory-store 无 registry 种子 → memory 模式下 putDraft 对未预置 config_id 全 404
  （DDL 仅在 PG 侧 seed ops_home_feed/ops_home_banner）。
- B7：`actorFromPrincipal` 缺 model_version 时落 `'unknown'` 占位（domain/types.ts）——agent
  留痕证据强度弱于 identity 域（identity 缺 modelVersion 走 system 记录员），待 Principal
  身份种类字段后切换。

### C 级（契约/登记缺口，非本域可改）
- C1：G-04 `cancelled` 状态契约未落（contracts/ owner H2，L135 ③）。
- C2：G-05 expired 枚举在但不实现——符合「不得实现」，仅备案。
- C3：PG 真栈未起（GAP-12），pg-store.ts 无法做真库验证。

---

## 6. typecheck 证据（18:48 快照，原文）

`cd services/approval && npm run typecheck`（tsc --noEmit -p tsconfig.json）：

```
src/plugin.ts(74,17): error TS7053: Element implicitly has an 'any' type because expression of type 'number' can't be used to index type '{ readonly 400: ... }'
src/plugin.ts(97,16): error TS2339: Property 'user' does not exist on type 'FastifyRequest<...>'
src/plugin.ts(100,18): error TS2339: Property 'user' does not exist on type 'FastifyRequest<...>'
src/services/config-service.ts(331,59): error TS2345: Argument of type 'string' is not assignable to parameter of type 'Environment'.
src/services/config-service.ts(378,58): error TS2345: Argument of type 'string' is not assignable to parameter of type 'Environment'.
src/services/config-service.ts(585,7): error TS2322: Type 'string[]' is not assignable to type '("column_layout" | ... )[]'.
src/services/config-service.ts(586,7): error TS2322: Type 'unknown' is not assignable to type '{ columns: ... }'.
```

（8 个错误中 TS2339×2/TS7053 属 plugin.ts、TS2345×2/TS2322×2 属 config-service.ts；
原 L135 归因的 TS2688 @types/node 已随 18:39:37 依赖安装消除。注：管道尾部 `EXIT=0`
系 tail 的退出码，tsc 实际非零。）

---

## 7. 后续动作（按 L136）

1. 持续监测 services/approval/ 静默（基线 18:50:12）；静默 ≥15min 后接管：
   review 全量 diff + `npm run typecheck` + `npm test`，证据带 commit 锚回补 H2。
2. 接管后与 A6 对齐 /v1/internal/* 联调（P1 ②，消 G-02 需 Console 侧同批）。
3. identity 域 approval_denied 留痕（45 pass/0 fail，identity-service.ts +113 / test +105）
   保持可提交状态，等 L0 发话 commit；commit 后补跑 `node infra/ci/typecheck.mjs` +
   `pnpm -r test`（L135 ②，H3 签 AI-1 前仓库级门禁必须绿）。
