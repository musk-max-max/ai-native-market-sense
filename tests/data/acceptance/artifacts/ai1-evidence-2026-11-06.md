# AI-1 闭环判据证据记录（2026-11-06）

- 席位：A3（后端·行情/内容/研究域，模型 SenseNova）
- 任务：实现 `/v1/ai/*` 业务路由并产出 AI-1 闭环判据证据（P0，阻塞 C 端 go-live）
- 基线：`reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md` H3 签发记录（AI-1 三判据此前「不放行」）
- 契约真源：`contracts/ai/openapi.yaml` v0.1.0（未改）

> 命名澄清：AI-CARD 文字表述为「`meta.ai` 六字段」，契约真源把 `AiMeta` 放在 `AnalysisResult.ai`，
> 信封为 `AiAnalysisResponse = { data: AnalysisResult, meta: ResponseMeta }`，故六字段实际落在
> **`data.ai`**；`meta` 是共享 `ResponseMeta`（source/entitlement/disclaimer）。本记录按契约真源取证。

---

## 实现清单（写域内）

| 文件 | 作用 |
| --- | --- |
| `services/ai/src/domain/analyses.ts` | 业务编排：校验(400)→P1 证据探测→全受限 403（调 LLM 前，D4.3）→模型生成/不可解析降级确定性数据卡→P2–P8 postprocess+审计→装配信封 |
| `services/ai/src/routes/analyses.ts` | POST /v1/ai/analyses、GET /v1/ai/analyses/{analysis_id} |
| `services/ai/src/generation.ts` | prompt 构造、模型 draft 解析（P2 入口）、确定性数据卡 fallback |
| `services/ai/src/evidence.ts` | P1 证据端口（透传用户 Bearer 给 market；受限/不可得区分） |
| `services/ai/src/plugin.ts` | `aiPlugin`（domain='ai'、contractVersion='0.1.0'、health）；缺 `AI_DATABASE_URL` 且未注入 audit → fail-closed 启动失败 |
| `services/api/src/domains.ts` | `domainPlugins` 数组第三位挂 `aiPlugin` |

未改（禁改清单遵守）：`contracts/`、`rules/`、`package.json`（根）、`agents/`、`docs/design/`。

---

## 判据 1：/v1/ai/analyses 路由上线 + 契约响应字段齐全

### 路由上线
- `services/ai/src/routes/analyses.ts:73` — `app.post('/ai/analyses', ...)`（挂 /v1 前缀即 POST /v1/ai/analyses）
- `services/ai/src/routes/analyses.ts:87` — `app.get<{ Params: { analysis_id: string } }>('/ai/analyses/:analysis_id', ...)`
- 接线：`services/api/src/domains.ts:17` — `export const domainPlugins: DomainPlugin[] = [identityPlugin, marketPlugin, aiPlugin];`

### 真实响应 `data.ai` 六字段（generated=true + 五 version 非空）
实现位置：`services/ai/src/domain/analyses.ts:505-510`

```ts
const aiMeta: Record<string, unknown> = {
  generated: true,
  label_version: contentVersion,
  content_version: contentVersion,
  model_family: this.options.provider.modelFamily,
  prompt_version: promptVersion,
  policy_version: this.options.policyEvaluator.policyVersion,
};
```

### `as_of` 必有
`services/ai/src/domain/analyses.ts` 装配处把 `as_of`（取自证据 primarySource）写入 `AnalysisResult.as_of`；
契约 `AnalysisResult` required 含 `as_of`，additionalProperties:false。

### 门禁证据（判据 1）
- `services/ai` 单独 typecheck：EXIT 0
- `services/ai` 全测试：**42 passed / 0 fail**，其中判据 1 用例：
  - `run 成功路径：meta.ai 六字段 + as_of + disclaimer + P8 审计闭环`（services/ai/test/analyses.test.ts）
  - `run 全受限：调 LLM 前 403 ENTITLEMENT_RESTRICTED，不落半条审计`
  - `run is_entitled=false 的 200 数据：C 端 displayAllowed=false → 403（D4.6）`

---

## 判据 2：一次真实请求落 audit.ai_generation_events 行（可复核样本）

### 方法
本地临时起 Postgres 16.15（`initdb` + `pg_ctl`，unix socket），按序执行
`services/compliance/migrations/001_audit_entitlement_events.sql` → `002_audit_gap.sql` →
`003_ai_generation_events.sql`；用真实 `pg` Pool + 真实 `createAiGenerationAuditWriter`
（`services/ai/src/postprocess/audit.ts:172` AI_GENERATION_INSERT_SQL）驱动一次真实 `AnalysesService.run()`。
表 `audit.ai_generation_events` 共 **24 列**。证据脚本已用后删除（临时，不入 CI）。

### 样本 A — decision=passed（只读查询输出，逐字段真实值）

```json
{
  "request_id": "req-e2e-passed",
  "analysis_id": "an-f36a3986-793d-4f1d-b6df-c6e1ccce97aa",
  "audience": "c_end",
  "user_id": "331105ce08d5401ee8dbad343527002b557a9b2447d613845c5b9c2c6726a51b",
  "kind": "stock_interpretation",
  "model_family": "fake-v1",
  "prompt_version": "analyses-v1",
  "policy_version": "ai-content-policy/1.1.2",
  "content_version": "2026.11.5.ac875c9d9237",
  "label_version": "2026.11.5.ac875c9d9237",
  "input_evidence_hash": "15899ea044bc8ec157afb54899f2fb655b285aacd9246ad22b45657fc4adba2b",
  "output_hash": "d97a549ae6a69b08dd8c50e6d9bb52264b46111537ca53115e8ec437f72b1e47",
  "postprocess_actions": [],
  "blocked_draft": null,
  "decision": "passed",
  "trace_id": "req-e2e-passed",
  "as_of": "2026-11-06T18:00:00+08:00"
}
```
响应侧：`RUN_DECISION=passed`、`RESPONSE_STATUS=succeeded`、
`META_AI_KEYS=generated,label_version,content_version,model_family,prompt_version,policy_version`。

### 样本 B — decision=blocked（策略 fail-closed 演示，P4 数值一致性）

```json
{
  "request_id": "req-e2e-blocked",
  "analysis_id": "an-bb7d1939-5961-47dc-a1b6-9cc3eee3a597",
  "audience": "c_end",
  "user_id": "331105ce08d5401ee8dbad343527002b557a9b2447d613845c5b9c2c6726a51b",
  "kind": "stock_interpretation",
  "model_family": "fake-v1",
  "prompt_version": "analyses-v1",
  "policy_version": "ai-content-policy/1.1.2",
  "content_version": "2026.11.5.ac875c9d9237",
  "label_version": "2026.11.5.ac875c9d9237",
  "input_evidence_hash": "15899ea044bc8ec157afb54899f2fb655b285aacd9246ad22b45657fc4adba2b",
  "output_hash": "8f6c299607a9766187e3d745b0409c58337e49204322b68e1e4d603f37d5e230",
  "postprocess_actions": [{ "code": "numeric_mismatch", "stage": "P4", "action": "block", "matched": "7%", "claim_index": 0, "original_text": "7%" }],
  "blocked_draft": { "sections": [{ "claims": [{ "text": "数据显示，区间收益 7%", "class": "metrics", "evidence_ids": ["ev:market_quote"] }] }] },
  "decision": "blocked",
  "trace_id": "req-e2e-blocked",
  "as_of": "2026-11-06T18:00:00+08:00"
}
```

判据 2 要求的必含字段核对（两样本均满足）：
`policy_version`（ai-content-policy/1.1.2）、`content_version`（2026.11.5.ac875c9d9237）、
`model_family`（fake-v1）、`as_of`（2026-11-06T18:00:00+08:00）、`request_id`（req-e2e-*）全非空。
`user_id` 为 HMAC(key,'user-e2e-1') 受控标识（禁明文，符合 003 COMMENT）。
`prev_hash`/`hash` 由 003 BEFORE INSERT 触发器权威计算（应用未传，触发器覆盖）。

---

## 判据 3：展示留痕路径（用户可见内容 hash / analysis_id 关联）

### 字段 → 实现位置
- **`audit.ai_generation_events.output_hash`** = 用户可见 claim 的 canonical sha256（`computeOutputHash`）。
  实现：`services/ai/src/postprocess/host.ts:222-231`
  ```ts
  outputHash =
    blocked && blockedDraft !== undefined
      ? computeBlockedDraftHash(blockedDraft)
      : computeOutputHash([...(verdict.outputClaims ?? [])]);
  ```
  即：passed 用 P2–P6 过滤/改写后的最终 claim（用户可见文本）算 hash；blocked 用完整被阻断 draft
  （`computeBlockedDraftHash`），保证与 P5 原文指向同一份内容。
- **`audit.ai_generation_events.input_evidence_hash`** = 本轮模型可见证据集 hash。
  实现：`services/ai/src/postprocess/host.ts:216`（`requiredAuditField(context.inputEvidenceHash, 'input_evidence_hash')`），
  由取数方经 `computeInputEvidenceHash()` 预算（`services/ai/src/domain/analyses.ts:456`）。
- **`audit.ai_generation_events.analysis_id`** 与用户可见响应 `data.analysis_id` 同源（`an-<uuid>`），
  实现绑定：`services/ai/src/postprocess/host.ts:235`
  ```ts
  ...(context.analysisId !== undefined ? { analysisId: context.analysisId } : {}),
  ```
  写入落库：`services/ai/src/postprocess/audit.ts:172-175`（AI_GENERATION_INSERT_SQL 含
  `request_id, analysis_id, ..., input_evidence_hash, output_hash, postprocess_actions, blocked_draft, decision, trace_id, as_of`）。

### 关联语义（复核口径）
一次生成 = 一条事件。审计侧 `analysis_id` / `output_hash` ↔ 展示侧 `data.analysis_id` / 用户可见 claim 文本
一一对应：可用 `output_hash` 反查该次展示的确切可见文本（passed）或被阻断原文（blocked），
用 `analysis_id` 关联同一次会话内的 sections/caveats，用 `trace_id`(=requestId) 关联跨服务调用链。

---

## 验收门禁结果

| 门禁 | 结果 | 归因 |
| --- | --- | --- |
| `services/ai` typecheck（`tsc -p`） | **EXIT 0（通过）** | — |
| `services/ai` test（42 用例） | **42 passed / 0 fail** | — |
| 契约测试（`tests/contract` pytest） | 68 passed / 1 failed | 失败项 `test_c01_source_format.py::test_canonical_layer_has_no_source_format` 为**既有失败**：git stash 掉本席改动后基线同样 1 failed，根因是 `services/ingest/var/akvenv/.../akshare`（Python venv，A-infra 域，非本席写域）。AI 域契约测试仅 non-destructive WARN（response-property-max/min-length/pattern-unset），无破坏性变更，未降 |
| 仓库级 `node infra/ci/typecheck.mjs` | **EXIT 1（未绿）** | 失败集中在**本席写域之外**：`services/approval`（`TS2688: Cannot find type definition file for 'node'`，未跟踪目录，疑 A4 新建）、`services/identity`/`services/market`/`services/api` 因 `services/identity/src/service/identity-service.ts` 报 `Property 'recordApprovalDenied' does not exist`（该文件 +109 行非本席改动）。已用 git stash 验证基线仍 EXIT 1，确认非本席引入 |

**契约测试不降**：满足（AI 域无破坏性变更；唯一 failed 项与 AI 无关且为既有失败）。

---

## 阻塞 / 待复核

1. **职责冲突（已报 lead）**：仓库级 typecheck EXIT 1 来自其他席并发改动
   （`services/identity/.../identity-service.ts` 的 `recordApprovalDenied`、未跟踪 `services/approval/`）。
   按「遇职责冲突停下报 lead、不自行扩权」约束，本席未改这些文件。需 lead 裁决：等他席修复后跑全量门禁，
   或接受「services/ai 单独 typecheck+test」作为 AI-1 门禁证据、仓库级失败归因他席。
2. **待 H2 复核**：`services/api/src/domains.ts` 接入 `aiPlugin`（该文件 A0 owns），按任务要求注明**待 H2 复核**。
3. **git push / 部署**：本席无远程凭证/部署权限，仅本地改动（未 push、未部署）。

## 红线自查
- 403=无权展示：全受限在调 LLM 前 403 ENTITLEMENT_RESTRICTED，未产生 200+is_entitled=false。
- AI 输出必带标识+不可关闭免责+as_of：`data.ai.generated=true`、`meta.disclaimer.closable=false`、`data.as_of` 必填。
- C 端禁荐股表述：输出层 P1–P6 策略未绕过（blocked 样本即策略拦截演示）。
- ai 不跑 gate：entitlement 由 market 数据侧判定后传入，ai 只消费（L126）。

---

## 增量补证（A3 接管后，2026-11-06 22:1x，L138 写权归位；本节不改上文历史记录）

### ① SSE 与轮询运行时真实响应证据（补原缺口 1）

- **实现**：`services/ai/src/routes/analyses.ts` GET `/ai/analyses/:analysis_id/events`（SSE 重放
  status → section* → caveat* → done，每帧 `{analysis_id, event, …}`；越权/不存在在**建流前**按 GET 同语义
  404 Problem JSON，不建流、不泄露存在性）。GET `/ai/analyses/:analysis_id`（轮询）此前已实现。
- **证据**：`tests/data/acceptance/artifacts/ai1-sse-evidence-2026-11-06.json` —— **32 checks / all_passed=true**，
  真实 HTTP：POST → GET 轮询 → GET SSE → 越权 404（含 raw SSE 文本、audit 行读回、input/output hash 复算）。
  关键闭环：GET `data.analysis_id` ↔ POST 同值（#10）；SSE 每帧 `analysis_id` 同值（#16）、首帧 status=响应
  status（#17）、section 帧数=sections 数（#18）；audit `request_id`/`trace_id`/`analysis_id` 三闭环（#20-22）。
- **采集脚本**：`services/ai/test/evidence-ai1.ts`（进程内 buildApp 壳 + marketPlugin 真库 + aiPlugin audit 真库，
  PG `127.0.0.1:55432/market_sense`；`model_family=fake-v1` 即 **FakeProvider 合成生成**，报告 `stack` 字段已标注；
  market 证据为真库 fixture 数据）。
- **采集前提**：共享 PG `audit.entitlement_hold` 超 15min 会 control_stale 降档（H5），采集前调用
  `audit.control_heartbeat('a3-evidence-run')` 保活（`services/compliance/migrations/004_control_heartbeat_observed.sql` 函数）。
- 附带修复：`request_id` 每次采集唯一（`event_key=ai|generation|<request_id>` 全局唯一，固定值重跑会撞已有行被
  23505 幂等吞掉、查不到本次 `analysis_id` 的审计行）。

### ② 判据 2 五字段复核（AI-CARD-SIGNOFF:32，补原缺口 2）

audit 行读回（json 内 `audit_row`，check #29 全非空）：
`policy_version=ai-content-policy/1.1.2`、`content_version=2026.11.5.ac875c9d9237`、
`model_family=fake-v1`、`as_of=2026-11-06T13:54:15+08:00`、`request_id=ai1-sse-req-mw51x01d`。

### ③ 门禁（2026-11-06 22:11 重跑，全绿）

| 门禁 | 结果 |
| --- | --- |
| `node infra/ci/typecheck.mjs` | **EXIT 0，10/10 workspace 工程** |
| `pnpm -C services/ai test` | **42 passed / 0 fail** |
| `pnpm -C services/market test` | **153 passed / 0 fail** |

（上文「仓库级 typecheck EXIT 1」为 18:3x 历史快照，已修复，以本表为准。）

### ④ commit 锚

- `152c017` feat(ai): AI-1 SSE events 路由 + 轮询/SSE 真栈证据（A3）——含 SSE 路由、`src/plugin.ts`/
  `src/generation.ts`/`src/domain/analyses.ts`/`test/analyses.test.ts` untracked 实现入库（修 HEAD 一致性：
  `domains.ts` 已 import `ai/src/plugin.js`）、证据采集脚本与本 JSON 证据。
- 本 md 随下一 commit 入库。
- 未做（非本席可为）：AI1-4 H3 复核签字、chat SSE operation（契约第 4 条，本轮 L0 任务清单未列）。
