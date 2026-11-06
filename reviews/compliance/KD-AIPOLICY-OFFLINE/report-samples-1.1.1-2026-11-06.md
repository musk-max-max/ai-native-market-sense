# A16 离线抽样复核报告（KD-AIPOLICY-OFFLINE）

- 生成时间：2026-11-06T00:00:00Z
- 复核对象：`rules/ai-content-policy.json` / `@market-sense/ai-policy` 的 `runAiPolicy`（P2–P6）
- policy_version：`ai-content-policy/1.1.1`；H3 签认状态：**已生效（ref m01561）**（翻转前内容 sha 与当前文件 diff 仅 status/note/definition_refs[2]）
- **签认内容 sha256**（H3 m01561 签字绑定，翻转前）：`eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293`
- **最终文件 sha256**（翻转 status 后、进部署 pin；fixtures 绑定此值）：`3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`
- 生效状态：H3 签认已生效（ref m01561）；A16 仍不写「合规通过/放行」结论。
- 运行命令：`packages/ai-policy/node_modules/.bin/tsx reviews/compliance/KD-AIPOLICY-OFFLINE/run-samples.ts`
- 样本集：`KD-AIPOLICY-OFFLINE/3`，共 36 条（正 7 / 负 12 / 边界 17）
- 覆盖度：负样本已覆盖 12 类 reason_code（全部命中）；正样本已覆盖白名单 7 类（objective_fields 由 C 端样本 POS-07 覆盖）。
- **本报告只记录实现行为证据，不构成放行或合规结论；A16 无终审权，复核结论由 H3 在文末签署栏填写。**

## 汇总

| 类别 | 条数 | 与期望一致 |
|---|---|---|
| positive | 7 | 7 |
| negative | 12 | 12 |
| boundary | 17 | 17 |
| **合计** | **36** | **36** |

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
| BND-03 | boundary | audience 缺省 → 抛 AiPolicyConfigError(audience_required)（H3 F3 整改后） | (缺省) | throw:audience_required / throw:audience_required | — | — | ✅ |
| BND-04 | boundary | 非白名单前缀 → redact 补「数据显示，」（证据含数字） | internal | passed / passed | redact | conclusion_unqualified | ✅ |
| BND-05 | boundary | P6 无证据不补出处（被 P3 先拦） | internal | blocked / blocked | block | evidence_binding_failed,numeric_mismatch | ✅ |
| BND-06 | boundary | P6 证据类型与允许前缀不匹配 → block（H3 S2） | internal | blocked / blocked | block | conclusion_unqualified | ✅ |
| BND-07 | boundary | C 端 class=data_gaps → 白名单拒绝（H3 S1） | c_end | blocked / blocked | — | class_not_allowed | ✅ |
| BND-08 | boundary | claim.class 缺失 → P2 blocked（H3 S1） | internal | blocked / blocked | — | class_missing | ✅ |
| BND-09 | boundary | 未声明 audience → 抛 AiPolicyConfigError(unsupported_audience) | public | throw:unsupported_audience / throw:unsupported_audience | — | — | ✅ |
| BND-10 | boundary | P2 结构：既无 sections 也无 claims | internal | blocked / blocked | — | structure_invalid | ✅ |
| BND-11 | boundary | causal 在 data_gap 语境豁免（H3 m01300） | internal | passed / passed | caveat | data_gap | ✅ |
| BND-12 | boundary | ISO 日期时间戳 → P4 排除日期 token 后通过（H3 F4 整改后） | internal | passed / passed | allow | — | ✅ |
| BND-13 | boundary | data_gaps 无允许前缀 + 无数字证据（skip_p6_classes 策略声明） | internal | passed / passed | caveat | data_gap | ✅ |
| BND-14 | boundary | 日期+时刻（HH:mm）token 排除 → timestamps 通过 | internal | passed / passed | allow | — | ✅ |
| BND-15 | boundary | YYYY年M月D日 token 排除 → timestamps 通过 | internal | passed / passed | allow | — | ✅ |
| BND-16 | boundary | 证据外数字仍 block（P4 未被日期排除削弱） | internal | blocked / blocked | block | numeric_mismatch | ✅ |
| BND-17 | boundary | 模型生成 section.title → P2 blocked（H3 m01470 词表旁路） | internal | blocked / blocked | — | model_generated_title_not_allowed | ✅ |

## 配置 fail-closed 检查

| ID | 覆盖 | 期望 | 实际 | 一致 |
|---|---|---|---|---|
| CFG-01 | S4 生产环境未签版拒绝加载 | throw policy_not_signed_for_production | throw policy_not_signed_for_production | ✅ |
| CFG-02 | S4 部署清单版本不一致拒绝加载（1.1.1 version+sha256 双 pin） | throw policy_version_mismatch | throw policy_version_mismatch | ✅ |
| CFG-06 | S4 生产内容哈希与部署清单不一致拒绝加载 | throw policy_sha256_mismatch | throw policy_sha256_mismatch | ✅ |
| CFG-07 | S4 生产缺少 version/sha 双 pin 拒绝加载 | throw policy_pin_missing | throw policy_pin_missing | ✅ |
| CFG-08 | F2 data_gaps 跳过 P6 由策略声明（机读断言） | ok | ok | ✅ |
| CFG-03 | S2 每个允许前缀必须有证据类型映射 | throw missing_rewrite_rule | throw missing_rewrite_rule | ✅ |
| CFG-04 | 非法正则拒绝加载 | throw invalid_regex | throw invalid_regex | ✅ |
| CFG-05 | 非生产环境 pending 可加载（联调形态） | ok | ok | ✅ |

## 复核发现（实现行为 vs 书面口径）

- 本轮未发现实现行为与 1.1.1 策略文本 / H3 m00298 签认范围的新增不一致（36/36、8/8）。

## 遗留事项（非实现缺陷，由 H3/A0/H1 处理）

1. `agents/decisions.md:141` 红线编号记录自相矛盾（「禁止 7 条」列 10 个编号）；A16 不再引用 R 编号，更正由 Lead/H1 负责。
2. ADR-007 P5/P6 文本修订（P5 改为「命中即 block」、P6 前缀仅「数据显示/历史统计上」）由 A0/H2 同步，policy 文件为准。
3. ADR-008 D8 状态行仍 `OWNER-DECISION-PENDING`；policy 已删除 q3=A 引用，A16 对内部只判「未越 L3」。
4. AI-1（隐式标识 + 3 年留痕）/AI-2/AI-3 上线门禁未闭环；本报告不构成 C 端展示放行。

## 快照（复核时刻只读哈希，报告正文事实以此为准）

| 文件 | sha256(前 16 位) |
|---|---|
| `rules/ai-content-policy.json` | `3e03535efd02cb99` |
| `packages/ai-policy/src/engine.ts` | `6ddb94100fbf9625` |
| `packages/ai-policy/src/policy.ts` | `7a66470569bd8591` |
| `packages/ai-policy/src/types.ts` | `da194cc029c2cfe7` |
| `packages/ai-policy/src/canonical.ts` | `d16b7cb37b583ce7` |
| `packages/ai-policy/src/index.ts` | `81d8b7df1fb5a785` |

## 边界样本输入（可独立复跑）

- `BND-01`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，成交额 8.90 亿元。","class":"metrics","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"成交额 8.90 亿元","numbers":[8.9]}]}；期望=passed；实际=passed; actions=allow; codes=—；一致
- `BND-02`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，龙虎榜数据缺失。","class":"data_gaps","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"龙虎榜数据缺失","numbers":[]}]}；期望=passed；实际=passed; actions=caveat; codes=data_gap；一致
- `BND-03`（audience=(缺省)）：{"audience":"(缺省)","claims":[{"text":"数据显示，成交额 8.90 亿元。","class":"metrics","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"成交额 8.90 亿元","numbers":[8.9]}]}；期望=throw audience_required；实际=throw audience_required；一致
- `BND-04`（audience=internal）：{"audience":"internal","claims":[{"text":"成交额 8.90 亿元。","class":"metrics","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"成交额 8.90 亿元","numbers":[8.9]}]}；期望=passed；实际=passed; actions=redact; codes=conclusion_unqualified；一致
- `BND-05`（audience=internal）：{"audience":"internal","claims":[{"text":"成交额 8.90 亿元。","class":"metrics","evidence_ids":[]}],"evidence":[{"id":"e1","text":"成交额 8.90 亿元","numbers":[8.9]}]}；期望=blocked；实际=blocked; actions=block; codes=evidence_binding_failed,numeric_mismatch；一致
- `BND-06`（audience=internal）：{"audience":"internal","claims":[{"text":"估值处于合理区间。","class":"metrics","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"估值数据","numbers":[]}]}；期望=blocked；实际=blocked; actions=block; codes=conclusion_unqualified；一致
- `BND-07`（audience=c_end）：{"audience":"c_end","claims":[{"text":"数据显示，北向资金数据缺失。","class":"data_gaps","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"北向资金数据缺失","numbers":[]}]}；期望=blocked；实际=blocked; actions=—; codes=class_not_allowed；一致
- `BND-08`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，成交额 8.90 亿元。","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"成交额 8.90 亿元","numbers":[8.9]}]}；期望=blocked；实际=blocked; actions=—; codes=class_missing；一致
- `BND-09`（audience=public）：{"audience":"public","claims":[{"text":"数据显示，成交额 8.90 亿元。","class":"metrics","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"成交额 8.90 亿元","numbers":[8.9]}]}；期望=throw unsupported_audience；实际=throw unsupported_audience；一致
- `BND-10`（audience=internal）：{"audience":"internal","claims":[],"evidence":[]}；期望=blocked；实际=blocked; actions=—; codes=structure_invalid；一致
- `BND-11`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，北向资金明细数据缺失，导致该维度无法统计。","class":"data_gaps","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"北向资金明细数据缺失","numbers":[]}]}；期望=passed；实际=passed; actions=caveat; codes=data_gap；一致
- `BND-12`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，数据截至 2026-11-05。","class":"timestamps","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"数据截至 2026-11-05","numbers":[]}]}；期望=passed；实际=passed; actions=allow; codes=—；一致
- `BND-13`（audience=internal）：{"audience":"internal","claims":[{"text":"北向资金明细数据缺失。","class":"data_gaps","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"北向资金明细数据缺失","numbers":[]}]}；期望=passed；实际=passed; actions=caveat; codes=data_gap；一致
- `BND-14`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，数据更新于 2026-11-05 14:30。","class":"timestamps","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"数据更新于 2026-11-05 14:30","numbers":[]}]}；期望=passed；实际=passed; actions=allow; codes=—；一致
- `BND-15`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，数据截至 2026年11月5日。","class":"timestamps","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"数据截至 2026年11月5日","numbers":[]}]}；期望=passed；实际=passed; actions=allow; codes=—；一致
- `BND-16`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，成交额 8.90 亿元。","class":"metrics","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"成交额 9.90 亿元","numbers":[9.9]}]}；期望=blocked；实际=blocked; actions=block; codes=numeric_mismatch；一致
- `BND-17`（audience=internal）：{"audience":"internal","claims":[{"text":"数据显示，成交额 8.90 亿元。","class":"metrics","evidence_ids":["e1"]}],"evidence":[{"id":"e1","text":"成交额 8.90 亿元","numbers":[8.9]}]}；期望=blocked；实际=blocked; actions=—; codes=model_generated_title_not_allowed；一致

## 样本设计说明

- 正样本覆盖白名单类别：内部 audience 覆盖 6 类客观类别 + data_gaps，C 端覆盖 6 类（无 data_gaps）；每条带 evidence 与数字/历史统计绑定。
- 负样本覆盖 policy 1.1.1 全部 12 类默认 block（含 H3 m01300 新增 selection_solicitation / future_prediction / suitability_advice / nonpublic_information）。
- 边界样本覆盖：允许前缀 pass、data_gap→caveat、causal 在 data_gap 语境豁免、audience 缺省抛错（F3）、非白名单前缀 redact、P6 证据类型不匹配、class 白名单（缺失/C 端 data_gaps）、P2 结构畸形、未声明 audience、ISO 日期与 YYYY年M月D日/HH:mm 时刻 token 排除（F4）、证据外数字仍 block、模型生成 section.title 拒绝（H3 m01470）、skip_p6_classes 策略声明（F2）。

## 待签文本（H3 m00298 签认范围；最终 sha 以本报告头为准）

> H3 m01561 签认内容 sha256=`eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293`（翻转前）；最终文件 sha256=`3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`（翻转 status 仅改 sig.status/note/definition_refs[2]，经 H3 m00367 复核 diff 后生效）。
> 签认范围：audience 分档白名单、H3-C01–C12 词表与依据、允许前缀仅「数据显示/历史统计上」且与证据类型绑定、
> P6 改写后重跑 P5、P5 命中即 block、data_gaps 豁免经策略声明。**不构成对 C 端 AI 生成内容展示的放行**：
> AI-1（隐式标识 + 3 年留痕机制）/AI-2/AI-3 未闭环前不得展示。

## 签署栏（由 H3 填写；A16 不出结论）

- 复核结论（通过 / 不通过 / 附条件，由 H3 填写）：________________
- 依据：本报告 36/36 样本实测 + 8/8 配置 fail-closed 检查 + mapping（H3-C01–C12）。
- H3 签字：________________　日期：________________
- 备注：A16 无终审权；本报告样本为离线抽检，不替代 H3 对策略内容的签认。
