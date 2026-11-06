# AI 内容策略落点与消费契约（A5）

> 依据：ADR-007 D3（P2–P6 / P8）、L126（H2 会签第 0 批）、ADR-007 P5/P6（H2 会签 `1cb103a`）、L3、H3 m01300（1.0.0 拒签整改）、m01470/m01502（1.1.0 复核后 -> 1.1.1）、m01732（`rules/redline-basis.json` 机读草稿）。
> H3 定义规则文本；A5 只实现，不自行放宽阈值。

## 文件与职责

| 路径 | 职责 | 是否 I/O |
|---|---|---|
| `rules/ai-content-policy.json` | 单一真源：按 audience 白名单、12 类禁用词表、允许结论前缀/证据类型、`skip_p6_classes`、data_gap caveat、`policy_version` | 文本 |
| `rules/redline-basis.json` | 红线依据单一真源：`H3-C01..C12` → policy category、三档依据、双 policy sha pin、文件版本（H3 m01732） | 文本 |
| `packages/ai-policy/` | P2–P6 无 I/O 纯函数包（`@market-sense/ai-policy`）；A3 在线与 A16 离线共用 | 否 |
| `services/compliance/src/ai-content-policy.ts` | 唯一只读 loader（`loadAiContentPolicy()` / `loadRedlineBasis()`），校验 `canonical_source_of_truth` 与 policy↔redline 双向一致 | 是（仅文件读取） |
| `services/ai/src/postprocess/` | A3 在线执行宿主：调用包并落 `audit.ai_generation_events` | 由 A3 实现 |
| A16 离线复核 | 同一包 + 同一策略文件跑同一批样本；禁止另写判定脚本 | 由 A16 实现 |

## 包导出（A3 / A16 消费面）

```ts
parseAiContentPolicy(raw: unknown, options?: { sourceSha256?: string }): AiContentPolicy // fail-closed；生产要求 version+sha256 双 pin 与 signed
compileAiContentPolicy(policy): CompiledAiContentPolicy
runAiPolicy(input: {
  policy: AiContentPolicy;
  draft: { sections?: {title?: string; claims: Claim[]}[]; claims?: Claim[] };
  evidence: { id: string; text: string; numbers?: number[] }[];
  audience?: "c_end" | "internal";
}): PolicyResult

// 阶段原语（供逐步测试/审计）
validateStructure(draft, evidence, policy?, audience?): PolicyViolation[]   // P2（含 Claim.class 白名单）
bindEvidence(claims, evidence): PolicyViolation[]                          // P3
checkNumericConsistency(claims, evidence): PolicyViolation[]               // P4
filterCompliance(text, claimIndex, policy, options?): PolicyViolation[]    // P5（options.exemptCategories）
qualifyConclusion(text, claimIndex, policy, citedEvidence): {violations, rewrittenText?} // P6
collectClaims(draft): Claim[]
extractNumericTokens(text): string[]
canonicalJson(value: unknown): string        // P8 hash 用，与 DB audit.canonical_json 同构
hashCanonicalJson(value: unknown): string    // sha256(UTF-8 canonical JSON)
parseRedlineBasis(raw, { policy, expectedVersion?, expectedPolicySignedContentSha256?, expectedPolicyDeployedFileSha256?, requireSigned? }): RedlineBasis // H3 红线依据校验
computeInputEvidenceHash(input): string      // input_evidence_hash canonical
computeOutputHash(claims): string            // passed 的 output_hash canonical
computeBlockedDraftHash(draft): string       // blocked 的 output_hash（与 blocked_draft 同一份 draft）
```

`Claim.class` 必填（`OutputClass` 7 值）。`PolicyResult`：`decision: passed|blocked`、`claims[].{text,action,violations}`、`caveats`、`reason_codes`、`policy_version`。
决策由 `decision_mapping` 消费（`block`→`blocked`；`redact`/`caveat`→`passed`）；缺 action 映射时抛 `AiPolicyConfigError`，不默认放行。

## P2–P6 口径（1.1.0）

| 阶段 | 包内实现 | 失败处置 |
|---|---|---|
| P2 结构 | sections/claims 形态、claim.text/evidence_ids、evidence id 唯一；**claim.class 必填且 ∈ 当前 audience 白名单**（C 端无 data_gaps）；**禁止模型生成 section.title**（`model_generated_title_not_allowed`） | `blocked`（确定性数据卡） |
| P3 证据绑定 | claim 必须引用存在且非空的 evidence_ids | `blocked` |
| P4 数值一致 | claim 中数字必须能在引用证据的 text/numbers 找到；数字 token 排除日期/时刻（ISO、`YYYY-MM-DD`、`YYYY年M月D日`、`HH:mm`），避免误伤 timestamps | `blocked` |
| P5 合规过滤 | 12 类词法命中（H3 词表）；`data_gap` 语境下的 `causal_attribution` 先豁免 | `blocked` + 事件 |
| P6 结论定性 | 仅当 claim.class ∈ 白名单 且 **不在 `skip_p6_classes`**（当前仅 data_gaps）且 evidence_ids 非空 且 前缀与证据类型匹配（numeric→数据显示 / historical_statistical→历史统计上）才允许 redact；否则 `conclusion_unqualified` block | `blocked` 或 `redact`（改写后重跑 P5） |
| data_gap | 文本含 缺失/不可得/未获取/无权限/受限/缺口 → caveat；`skip_p6_classes` 声明该类不跑 P6 | `passed` + caveat |

## fail-closed 要求

- 策略文件不可读、JSON 非法、正则非法、`policy_version` 缺失、audience/白名单/映射缺失 → 抛 `AiPolicyConfigError`；调用方必须阻断请求/样本判红，不得回退“无过滤”。
- 生产环境（`NODE_ENV=production` 或 `APP_PROFILE=prod`）下 `status != signed`、`AI_CONTENT_POLICY_EXPECTED_VERSION`/`AI_CONTENT_POLICY_EXPECTED_SHA256` 缺失或不一致 → 拒绝启动（H3 S4/m01470；sha 为策略文件原始字节 sha256）。
- `status = pending` 期间只允许联调；按 H3 m02810 条件 1，满足留痕/标识门禁前不得对用户展示 AI 可见内容。
- `runAiPolicy` 的 `audience` 必须显式传入，缺省抛 `AiPolicyConfigError code="audience_required"`（禁止静默默认 c_end）。
- 审计写入失败 → 请求失败（P8）；不得返回未留痕的生成内容。
- P8 `postprocess_actions` 每条 item 必含 `stage/action/matched`；block/redact 必含 `original_text` 或 `original_hash`；redact 另需 `rewritten_text` 或 `rewritten_hash`（DDL JSONPath CHECK 强制）。
- P8 `blocked_draft`（H2 ADR-007 P5/P6 执行条件）：`decision=blocked` 时必填被阻断的**完整 draft**（不是命中片段），只落 `audit.ai_generation_events` 受限列；`decision=passed` 必须为 NULL（DDL CHECK）；不得进 API/C 端/SSE/普通日志/缓存/provider 日志，保留 ≥3 年。此时 `output_hash` 必须等于 `computeBlockedDraftHash(blocked_draft)`，保证 P8 输出 hash 与 P5 原文 hash 指同一份 draft。

## 版本与变更

见 `rules/README.md`：任何规则/阈值/类别变化须 H3 书面签字并升 `policy_version`；A5 不得为了让样本通过而放宽阈值。A3/A16 升级依赖时同步校验 `policy_version`。

## 生效记录（H3 签认生效）

- `policy_version=ai-content-policy/1.1.1`；H3 签字 ref `m01561`；签字内容 sha256 `eee14c62…`；最终文件（部署 pin）sha256 `3e03535e…`。
- 生产 `AI_CONTENT_POLICY_EXPECTED_VERSION` / `AI_CONTENT_POLICY_EXPECTED_SHA256` 必须同时设置且匹配，否则加载失败。
- 签认仅覆盖规则层；C 端 AI 生成内容展示仍卡 AI-1（标识/留痕）、AI-2（时点）、AI-3（不可关闭/导出携带/无 fallback），未闭环前只可联调、不得对用户可见。
- 任何规则/词表/前缀/白名单变动须升版本并由 H3 重新签字，禁止同版本改字节。
- `rules/redline-basis.json`：`version=1.0.0`（H3 m01732，signed=true）；映射/档位/口径任改须升版并 H3 重签；policy 升版必须同批复核（可不变，但复核记录要留）。
