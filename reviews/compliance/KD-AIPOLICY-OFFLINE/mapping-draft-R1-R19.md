# H3-C01–C12 ↔ 12 类 category 映射（H3 签认版；A16 起草）

- 起草/复核：A16 compliance-reviewer（无终审权；本文件是「H3 可签署的复核包」的一部分，不是已批准件）
- 日期：2026-11-06（v3，对齐 `policy_version=ai-content-policy/1.1.1`，最终文件 sha256 `3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`）
- 依据三档：①〔2012〕40 号文对证券投资咨询的定义（为投资人提供证券**分析、预测或建议**等有偿服务，H3 m00298 引）；②`agents/decisions.md` L3「五不」+ L114；③ADR-007 P5/P6（文本修订由 A0/H2 同步，policy 文件为准）。
- **R1–R19 编号不再使用**：正文不在仓库、`decisions.md:141` 自相矛盾，R 编号只作历史别名并标注「正文缺失、不可引用」；编号体系改用 H3-C（H3 m00298 裁定）。

## 1. H3-C 主题 ↔ category ↔ 依据

| H3-C | 红线主题 | category（= reason_code） | 依据（H3 m00298 指定三档） | 覆盖样本 |
|---|---|---|---|---|
| H3-C01 | 荐股 / 买卖建议 | `investment_advice` | 40 号文「建议」+ L3 | NEG-01 |
| H3-C02 | 方向性结论 | `directional_conclusion` | 40 号文「分析、预测」+ L3 | NEG-02 |
| H3-C03 | 评级 | `rating` | L3（分析意见的定性形态） | NEG-03 |
| H3-C04 | 目标价 | `target_price` | 40 号文「具体证券的分析意见」+ L3 | NEG-04 |
| H3-C05 | 买卖时点 / 择时 | `market_timing` | 40 号文「买卖时机建议」 | NEG-05 |
| H3-C06 | 仓位建议 | `position_advice` | 40 号文「选择建议」+ L3 | NEG-06 |
| H3-C07 | 因果归因 | `causal_attribution` | 40 号文「分析」+ 对外表述红线 | NEG-07（豁免对照 BND-11） |
| H3-C08 | 收益承诺 / 保本保收益 | `guarantee` | L3「无收益承诺」+ 获利要件 | NEG-08 |
| H3-C09 | 选股招揽 / 榜单 | `selection_solicitation` | 40 号文「选择建议」（值得关注/可关注/首选/榜单） | NEG-09 |
| H3-C10 | 未来预测 | `future_prediction` | 40 号文「预测」 | NEG-10 |
| H3-C11 | 适当性匹配 | `suitability_advice` | 适当性匹配（平台无适当性义务履行能力）+ L3 | NEG-11 |
| H3-C12 | 未公开信息 | `nonpublic_information` | 信息来源合法性（内幕/未公开信息），条号待法务 | NEG-12 |

说明：C01–C12 与 `rules/ai-content-policy.json` 的 12 个 category **一一对应**。40 号文「第四项」仓库未列明，A16 不臆造；具体条号待法务。

## 2. 白名单侧（非红线）

| audience | 允许 class | 依据 | 样本 |
|---|---|---|---|
| internal | objective_fields / metrics / quantiles / statistics / historical_facts / timestamps / data_gaps | 客观事实呈现，不落 40 号文四项（与 ADR-004 对行情快照判定同一逻辑，H3 m00298）；L114 内部白名单 | POS-01…06、BND-13 |
| c_end | 前 6 类（无 data_gaps） | 缺口文案由 `services/api/src/copy.ts` 常驻（H3 S1） | POS-07、BND-07 |

## 3. R1–R19 历史别名（正文缺失，不可引用）

`agents/decisions.md:141` 只记「可做 3 / 需改造 9 / 禁止 7」，并列出 10 个「禁止」编号（R3/R4/R5/R6/R8/R9/R10/R14/R15/R16），与「禁止 7 条」矛盾；逐条正文不在仓库。A16 不按编号推测内容。该记录由 Lead/H1 更正（H3 m00298 指派）。

## 4. 边界问题落实状态（H3 m00298 裁定 + 1.1.1 实测）

| # | 问题 | H3 裁定 | 1.1.1 状态（A16 实测） |
|---|---|---|---|
| F1 | P5「命中即 block」vs ADR-007 P5「改写中性表述」 | 以实现为准：P5 命中即 block，禁止自动改写；ADR-007 P5 文本由 A0/H2 修订；A16 判据用 policy 文件 | **已关闭**（无代码改动；NEG-01…12 实测 block） |
| F2 | engine 对 data_gaps 跳过 P6 但策略未声明 | `skip_p6_classes: ["data_gaps"]` 写入 `scope.rewrite_rules`，engine 读策略；版本升 1.1.1 并重报 sha | **已整改**：BND-13 + CFG-08 机读断言通过 |
| F3 | audience 缺省静默取 c_end | 必须抛错，禁止静默默认；补测试 | **已整改**：BND-03 实测 `AiPolicyConfigError(audience_required)` |
| F4 | ISO 日期被 P4 拆 token | 排除日期/时刻 token（ISO 8601、YYYY-MM-DD、YYYY年M月D日、HH:mm）；timestamps 正例通过、证据外数字仍 block | **已整改**：BND-12/14/15 通过，BND-16 仍 block（`numeric_mismatch`） |
| F5 | 删「存在」前缀与 ADR-007 P6 冲突 | 以 1.1.0 为准；ADR-007 P6 由 A0/H2 修订；修订前 A16 用 policy | **已关闭**（prefixes 仍仅「数据显示/历史统计上」，POS-03 实测 redact） |
| F6 | P6 改写后重跑 P5 分支不可达 | 防御代码，无行为风险 | **记录**（不阻断） |
| F7 | policy 引 q3=A 与 ADR-008 状态冲突 | 不成立：q3 决策权按 L115 不在 H3；A5 删 q3=A 引用，改「内部 AI 建议决策 pending…不构成放行」；A16 对内部只判「未越 L3」 | **已整改**：definition_refs[0] 已改为 pending 口径，A16 复核未引用 q3=A |
| F8 | decisions:141 计数矛盾 | 随编号体系替换消解，由 Lead/H1 更正 | 待 Lead/H1 |
| F9 | R1–R19 正文缺失 | 不回填；不要求 H3 凭记忆补正文 | **已关闭**（映射以 H3-C 为准） |

补充实测发现（1.1.1 新增，已覆盖）：**模型生成 `section.title` 被 P2 拒绝**（`model_generated_title_not_allowed`，H3 m01470，标题由 copy.ts 常驻）——BND-17 覆盖。

## 5. 签认与生效状态

- **H3 m01561 已签认内容**：`policy_version=ai-content-policy/1.1.1`，签认内容 sha256 = `eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293`（翻转前）。
- **最终文件 sha256** = `3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`（翻转 status 后、进部署 pin；fixtures 绑定此值）。A5 仅改 `sig.status`/`sig.note`/`definition_refs[2]`（H3 m00367 允许的 diff）。
- **生效状态**：H3 签认**已生效（ref m01561）**——H3 已回滚复算，翻转差异仅 `status`/`note`/`definition_refs[2]`；A16 仍不写「合规通过/放行」结论。
- 签认范围：audience 分档白名单、H3-C01–C12 词表与依据、允许前缀仅「数据显示/历史统计上」且与证据类型绑定、P6 改写后重跑 P5、P5 命中即 block、data_gaps 豁免经策略声明。**不构成对 C 端 AI 生成内容展示的放行**：AI-1（隐式标识 + 3 年留痕）/AI-2/AI-3 未闭环前不得展示。
- A16 复核结论：**不出结论**；36/36 样本与期望一致 + 8/8 配置检查通过（实现行为证据），结论位由 H3 签署栏填写。

## 6. 当前证据（1.1.1 签字后复核实测）

- `report-samples-1.1.1-2026-11-06.md` / `.json`：36/36 样本与期望一致、配置 fail-closed 8/8；报告头含 `policy_version + 最终 content sha256 + 运行命令`，附边界样本可独立复跑输入。
- `fixtures.json`（fixture_set `KD-AIPOLICY-OFFLINE/3`）：正 7 / 负 12 / 边界 17，绑定最终 content sha256。
- 运行命令：`packages/ai-policy/node_modules/.bin/tsx reviews/compliance/KD-AIPOLICY-OFFLINE/run-samples.ts`
- 包单测：`cd packages/ai-policy && node --import tsx --test test/*.test.ts`（1.1.1 版本；A5 侧 21+ 通过）。

## 7. 交付清单

| 文件 | 说明 |
|---|---|
| `review-package-H3-1.1.1.md` | 复核包索引 + 待签文本 + H3 签署栏 |
| `fixtures.json` | 36 条样本（正 7 / 负 12 / 边界 17），绑定最终 sha |
| `run-samples.ts` | 只调用 `@market-sense/ai-policy`；覆盖度/配置/哈希机读断言 |
| `report-samples-1.1.1-2026-11-06.md/.json` | 签字后复核实测（证据，无结论） |
| `mapping-draft-R1-R19.md` | 本文件（H3-C 映射，文件名沿用） |
