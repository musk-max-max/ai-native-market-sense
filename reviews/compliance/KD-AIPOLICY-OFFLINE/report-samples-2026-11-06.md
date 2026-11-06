# A16 离线抽样复核报告（KD-AIPOLICY-OFFLINE）

- 生成时间：2026-11-06T00:32:44.759Z
- 复核对象：`rules/ai-content-policy.json` / `@market-sense/ai-policy` 的 `runAiPolicy`（P2–P6）
- policy_version：`ai-content-policy/1.1.0`；H3 签字状态：`pending`
- 样本集：`KD-AIPOLICY-OFFLINE/2`，共 32 条（正 7 / 负 12 / 边界 13）
- 覆盖度：负样本已覆盖 12 类 reason_code（全部命中）；正样本已覆盖白名单 7 类（objective_fields 由 C 端样本 POS-07 覆盖）。
- **本报告不构成放行结论**：H3 未签 `policy_version` 前，任何「复核通过」只对实现行为成立，不对策略内容生效；A16 无终审权。

## 汇总

| 类别 | 条数 | 与期望一致 |
|---|---|---|
| positive | 7 | 7 |
| negative | 12 | 12 |
| boundary | 13 | 13 |
| **合计** | **32** | **32** |

## 逐条结果

| ID | 类别 | 覆盖点 | audience | decision（期望/实际） | claim action | reason_codes（实际） | 一致 |
|---|---|---|---|---|---|---|---|
| POS-01 | positive | metrics（内部白名单） | internal | passed / passed | allow | — | ✅ |
| POS-02 | positive | quantiles（内部白名单） | internal | passed / passed | allow | — | ✅ |
| POS-03 | positive | statistics（内部白名单，P6 redact 路径） | internal | passed / passed | redact | conclusion_unqualified | ✅ |
| POS-04 | positive | historical_facts（内部白名单） | internal | passed / passed | allow | — | ✅ |
| POS-05 | positive | data_gaps（内部白名单 + caveat） | internal | passed / passed | caveat | data_gap | ✅ |
| POS-06 | positive | timestamps（内部白名单） | internal | passed / passed | allow | — | ✅ |
| POS-07 | positive | objective_fields（C 端白名单） | c_end | passed / passed | allow | — | ✅ |
| NEG-01 | negative | investment_advice | c_end | blocked / blocked | block | investment_advice | ✅ |
| NEG-02 | negative | directional_conclusion | c_end | blocked / blocked | block | directional_conclusion | ✅ |
| NEG-03 | negative | rating | c_end | blocked / blocked | block | rating | ✅ |
| NEG-04 | negative | target_price + P4 自算数字 | c_end | blocked / blocked | block | numeric_mismatch,target_price | ✅ |
| NEG-05 | negative | market_timing | c_end | blocked / blocked | block | market_timing | ✅ |
| NEG-06 | negative | position_advice | c_end | blocked / blocked | block | position_advice | ✅ |
| NEG-07 | negative | causal_attribution | c_end | blocked / blocked | block | causal_attribution | ✅ |
| NEG-08 | negative | guarantee | c_end | blocked / blocked | block | guarantee | ✅ |
| NEG-09 | negative | selection_solicitation（1.1.0 新增） | c_end | blocked / blocked | block | selection_solicitation | ✅ |
| NEG-10 | negative | future_prediction（1.1.0 新增） | c_end | blocked / blocked | block | future_prediction | ✅ |
| NEG-11 | negative | suitability_advice（1.1.0 新增） | c_end | blocked / blocked | block | suitability_advice | ✅ |
| NEG-12 | negative | nonpublic_information（1.1.0 新增） | c_end | blocked / blocked | block | nonpublic_information | ✅ |
| BND-01 | boundary | 允许前缀 pass | internal | passed / passed | allow | — | ✅ |
| BND-02 | boundary | data_gap → caveat（internal） | internal | passed / passed | caveat | data_gap | ✅ |
| BND-03 | boundary | audience 缺省（任务单写「抛错」，实现为取更严 c_end） | (缺省) | passed / passed | allow | — | ✅ |
| BND-04 | boundary | 非白名单前缀 → redact 补「数据显示，」（证据含数字） | internal | passed / passed | redact | conclusion_unqualified | ✅ |
| BND-05 | boundary | P6 无证据不补出处（被 P3 先拦） | internal | blocked / blocked | block | evidence_binding_failed,numeric_mismatch | ✅ |
| BND-06 | boundary | P6 证据类型与允许前缀不匹配 → block（H3 S2） | internal | blocked / blocked | block | conclusion_unqualified | ✅ |
| BND-07 | boundary | C 端 class=data_gaps → 白名单拒绝（H3 S1） | c_end | blocked / blocked | — | class_not_allowed | ✅ |
| BND-08 | boundary | claim.class 缺失 → P2 blocked（H3 S1） | internal | blocked / blocked | — | class_missing | ✅ |
| BND-09 | boundary | 未声明 audience → 抛 AiPolicyConfigError(unsupported_audience) | public | throw:unsupported_audience / throw:unsupported_audience | — | — | ✅ |
| BND-10 | boundary | P2 结构：既无 sections 也无 claims | internal | blocked / blocked | — | structure_invalid | ✅ |
| BND-11 | boundary | causal 在 data_gap 语境豁免（H3 m01300） | internal | passed / passed | caveat | data_gap | ✅ |
| BND-12 | boundary | ISO 日期时间戳 → P4 误伤（白名单 timestamps 无法通过） | internal | blocked / blocked | block | numeric_mismatch | ✅ |
| BND-13 | boundary | data_gaps 无允许前缀 + 无数字证据（P6 对 data_gaps 豁免） | internal | passed / passed | caveat | data_gap | ✅ |

## 配置 fail-closed 检查

| ID | 覆盖 | 期望 | 实际 | 一致 |
|---|---|---|---|---|
| CFG-01 | S4 生产环境未签版拒绝加载 | throw policy_not_signed_for_production | throw policy_not_signed_for_production | ✅ |
| CFG-02 | S4 部署清单版本不一致拒绝加载 | throw policy_version_mismatch | throw policy_version_mismatch | ✅ |
| CFG-03 | S2 每个允许前缀必须有证据类型映射 | throw missing_rewrite_rule | throw missing_rewrite_rule | ✅ |
| CFG-04 | 非法正则拒绝加载 | throw invalid_regex | throw invalid_regex | ✅ |
| CFG-05 | 非生产环境 pending 可加载（联调形态） | ok | ok | ✅ |

## 复核发现（实现行为 vs 书面口径，供 H3 裁定 / A5 修复）

- `BND-03`：【复核发现】engine.ts:439 `input.audience ?? "c_end"`：缺省不抛错而是取更严 audience；任务单描述与实现不一致，需 H3/A5 明确口径。
- `BND-12`：【复核发现】NUMERIC_TOKEN 把 ISO 日期拆成 2026 / -11 / -05；evidenceTextMatches 的前后界断言使 -11、-05 无法在证据文本中被找到 → 白名单 timestamps 类样本被 P4 误判 blocked。证据文本与 claim 完全一致仍失败，属实现缺陷（A5 域），需修复或 H3 确认。
- `BND-13`：【复核发现】当前 engine 对 class=data_gaps 显式跳过 P6（否则纯缺口描述会因无允许前缀/无数字证据被 block，与「缺口显式」冲突）；但该豁免只存在于 engine.ts 实现，rules/ai-content-policy.json 未声明——策略内容单一真源（rules/）与实现出现分叉，需 A5/H3 决定是否回写策略文本并纳入签字版。

## 快照（复核时刻只读哈希，报告正文事实以此为准）

| 文件 | sha256(前 16 位) |
|---|---|
| `rules/ai-content-policy.json` | `c61c04bb4c1603d0` |
| `packages/ai-policy/src/engine.ts` | `3712cfecdf36aa0f` |
| `packages/ai-policy/src/policy.ts` | `414f35886fa2b82b` |
| `packages/ai-policy/src/types.ts` | `1f78e9eb44433760` |
| `packages/ai-policy/src/canonical.ts` | `d16b7cb37b583ce7` |
| `packages/ai-policy/src/index.ts` | `34cf1f40c4849247` |

## 样本设计说明

- 正样本覆盖白名单类别：内部 audience 覆盖 6 类客观类别 + data_gaps，C 端覆盖 6 类（无 data_gaps）；每条带 evidence 与数字/历史统计绑定。
- 负样本覆盖 policy 1.1.0 全部 12 类默认 block（含 H3 m01300 新增 selection_solicitation / future_prediction / suitability_advice / nonpublic_information）。
- 边界样本覆盖：允许前缀 pass、data_gap→caveat、causal 在 data_gap 语境豁免、audience 缺省、非白名单前缀 redact、P6 证据类型不匹配、class 白名单（缺失/C 端 data_gaps）、P2 结构畸形、未声明 audience、ISO 日期时间戳。

## 待 H3 签字前需裁定（摘要，详见 mapping-draft-R1-R19.md）

1. P5 实现为「命中即 block」，而 ADR-007 P5 写「命中即改写中性表述；不可改写→阻断」——须裁定 policy_version 口径。
2. 白名单已按 claim.class 机器化（H3 S1 已修），但 P5 的 12 类默认 block 是否即为「内部白名单只输出客观字段」的完整执行点，需 H3 确认。
3. `audience` 缺省取 `c_end` 而非抛错（任务单描述为抛错）——须确认产品口径（BND-03）。
4. ISO 日期在 P4 被拆 token 且无法绑定（BND-12），白名单 timestamps 类无法通过——A5 修复或 H3 确认。
5. data_gaps 类在 engine.ts 中被特殊豁免 P6（claim.class === "data_gaps" 跳过 P6），但 rules/ai-content-policy.json 未声明该豁免——策略单一真源与实现分叉，须 A5/H3 决定是否回写策略文本（BND-13）。
6. 1.1.0 删除「存在」前缀，但 ADR-007 P6 仍写「存在…特征」——ADR 与 policy 文本不一致，需 H3 裁定改哪侧。
7. R1–R19 条文正文仓库内不存在，映射只能等 H3 提供原文后回填。
