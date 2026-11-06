# A16 复核包 — `ai-content-policy/1.1.1`（H3 直接签署）

- 提交人：A16 compliance-reviewer（无终审权；本包只提供证据与待签文本）
- 提交日期：2026-11-06
- 复核对象：`rules/ai-content-policy.json`（`policy_version=ai-content-policy/1.1.1`，最终文件 sha256 `3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`）与 `@market-sense/ai-policy` 的 `runAiPolicy`（P2–P6）
- 运行命令：`packages/ai-policy/node_modules/.bin/tsx reviews/compliance/KD-AIPOLICY-OFFLINE/run-samples.ts`
- 样本：`fixtures.json`（fixture_set `KD-AIPOLICY-OFFLINE/3`）正 7 / 负 12 / 边界 17 = 36 条；配置 fail-closed 检查 8 项
- 结果：**36/36 与期望一致；8/8 配置检查通过**（仅为实现行为证据；不写「合规通过」，结论见 §4 签署栏）

## 1. 复核包构成

| # | 文件（本目录） | sha256 | 说明 |
|---|---|---|---|
| 1 | `review-package-H3-1.1.1.md` | （本文件） | 索引 + 待签文本 + 签署栏 |
| 2 | `report-samples-1.1.1-2026-11-06.md` | `9f313d161074888bf3c5ecf54604c4b927805d46366aa8600ae318365debfe09` | 签字后复核实测（人读） |
| 3 | `report-samples-1.1.1-2026-11-06.json` | `4e44c8cf91b67ec56ae16ef4d6df09b900bea4e0616320891fe5053f8b79bf1b` | 机读结果（含每样本输入/期望/实际/diff） |
| 4 | `fixtures.json` | `2ede028922074a395650e0b7dca996dfa366c0667b920aee0a6b9917d77cba8a` | 36 条样本，绑定最终 content sha |
| 5 | `run-samples.ts` | `984c0b1b4161bf8db7a99fea978f8c40aa63292ca308007e0dcd557ed639f602` | 复跑脚本（只调用 ai-policy，不复制判定逻辑） |
| 6 | `mapping-draft-R1-R19.md` | `f78a8e18454e7dceb9c7b099ebdd90f99157f2f93a4d96f54bce33da92d22857` | H3-C01–C12 ↔ 12 category 映射（H3-C 体系） |

复跑方式：仓库根执行 §头部运行命令（`fixtures.json` 与 `report-samples-1.1.1-2026-11-06.json` 生成结果应为 36/36、8/8）。报告头分两行写「签认内容 sha256」与「最终文件 sha256」，并含 `policy_version + 运行命令`；`fixtures.json` 的 `policy_content_sha256_expected` 绑定**最终文件 sha**——文件字节变动时脚本直接报 `policy content sha256 不一致`。

## 2. 签署绑定信息

- **签认内容 sha256**（H3 m01561 签字绑定，翻转前）：`eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293`
- **最终文件 sha256**（A5 翻转 `sig.status`/`note`/`definition_refs[2]` 后、进部署 pin）：`3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`
- 差异范围：仅 `authority.h3_policy_version_signature.status`（pending→signed）、`.note`（写入签字 ref m01561 / 签认内容 sha）、`authority.definition_refs[2]`（ADR-007 P5/P6 文本修订说明）；H3 已复算确认。
- **生效状态**：H3 签认**已生效（ref m01561）**——H3 已回滚复算，翻转差异仅 `status`/`note`/`definition_refs[2]`；A16 仍不写「合规通过/放行」结论，报告只对上述最终 sha 的实现行为负责；任何后续字节变更需重跑。

## 3. 覆盖清单（概要）

- **正样本 7**：POS-01 metrics / POS-02 quantiles / POS-03 statistics（P6 redact）/ POS-04 historical_facts / POS-05 data_gaps+caveat / POS-06 timestamps / POS-07 objective_fields（C 端）。
- **负样本 12**：NEG-01…12 逐一覆盖 12 类 `reason_code`（investment_advice … guarantee），全部 block。
- **边界样本 17**：BND-01 允许前缀 pass；BND-02 data_gap→caveat；BND-03 audience 缺省抛错（`audience_required`，F3）；BND-04 非白名单前缀 redact；BND-05 P3 先拦；BND-06 P6 证据类型不匹配→block；BND-07 C 端 data_gaps 拒绝；BND-08 class 缺失→block；BND-09 未声明 audience 抛错；BND-10 P2 结构畸形；BND-11 causal 在 data_gap 语境豁免；BND-12 ISO 日期 timestamps 通过（F4）；BND-13 data_gaps 无前缀通过 + `skip_p6_classes` 机读断言（F2）；BND-14 `YYYY-MM-DD HH:mm` 通过；BND-15 `YYYY年M月D日` 通过；BND-16 证据外数字仍 block（`numeric_mismatch`）；BND-17 模型生成 `section.title` 拒绝（`model_generated_title_not_allowed`，H3 m01470）。
- **配置 fail-closed 8**：CFG-01 生产未签拒绝；CFG-02 version 不一致拒绝；CFG-06 sha256 不一致拒绝；CFG-07 缺少 version/sha 双 pin 拒绝；CFG-08 `skip_p6_classes` 策略声明机读断言；CFG-03 前缀映射缺失拒绝；CFG-04 非法正则拒绝；CFG-05 非生产 pending 可加载（联调）。

## 4. 待签文本 + 签署栏（由 H3 填写）

> H3 签认 `policy_version=ai-content-policy/1.1.1`，最终文件 sha256=`3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`。
> 签认范围：audience 分档白名单、H3-C01–C12 词表与依据、允许前缀仅「数据显示/历史统计上」且与证据类型绑定、P6 改写后重跑 P5、P5 命中即 block、data_gaps 豁免经策略声明。
> **不构成对 C 端 AI 生成内容展示的放行**：AI-1（隐式标识 + 3 年留痕机制）/AI-2/AI-3 未闭环前不得展示。

- 复核结论（由 H3 填写）：**附条件通过（仅规则层）**——`ai-content-policy/1.1.1` 的规则内容与其实现行为，可作为 C 端 AI 内容管线的合规基线；条件未满足前不得据此放行任何用户可见展示。
- 条件（附条件通过之条件，逐条可核）：
  1. `agents/decisions.md:141` 的 R 编号计数矛盾由 Lead/H1 更正；现行编号只用 H3-C01–C12，R1–R19 仅历史别名。
  2. ADR-007 P5/P6 文本由 A0/H2 修订；完成后 A5 在下一 policy 版本**同批**更新 `definition_refs` 引用，不得只改 ADR、不改 policy 依据。
  3. C 端展示放行仍卡 **AI-1**（隐式标识元数据 + 生成/展示留痕 ≥3 年）、**AI-2**（时点真实）、**AI-3**（不可关闭/折叠隐藏、复制导出携带 label+disclaimer、前端无硬编码 fallback）；三者按 ADR-006 D7 留证并经 H3 书面放行前，模型输出不得对用户可见。
  4. `audit.ai_generation_events` 留痕抽查待 003 migration 落地后由 Lead 指派 A16 执行；抽检口径（样本量、失败处置）先报 H3 确认。
  5. `fixtures.json` 字段 `policy_content_sha256_expected` 实际绑定**最终文件 sha**（部署 pin）；为免歧义下一轮改名 `policy_file_sha256_expected`，本次不改以免重签，语义以本行注记为准。
- 依据：本包 §1 证据（36/36 样本、8/8 配置检查、H3-C01–C12 映射）；H3 已独立复跑 `run-samples.ts` 得 36/36、8/8，并抽检 mapping 全文与样本 NEG-01、BND-13、BND-17、POS-07。
- H3 签字：H3（合规负责人 / DPO）　日期：2026-11-06
- 签署绑定：`policy_version=ai-content-policy/1.1.1`；签认内容 sha256 `eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293`；最终文件 sha256 `3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`。签署消息 ref 由 A16 在合规证据台账登记，不回写本文件。
- 冻结声明：本文件签署后冻结，任何修改须重签；后续版本用新文件名。
- 备注：A16 无终审权；本包为离线抽检证据，不替代 H3 对策略内容的签认；H3 可要求补样本或复跑。

## 5. 遗留事项（非实现缺陷，不阻断签认）

1. `agents/decisions.md:141` 红线编号记录自相矛盾（「禁止 7 条」列 10 个编号），由 Lead/H1 更正；A16 已不再引用 R 编号。
2. ADR-007 P5/P6 文本修订（P5 改为「命中即 block」、P6 前缀仅「数据显示/历史统计上」）由 A0/H2 同步，policy 文件为准。
3. ADR-008 D8 状态行仍 `OWNER-DECISION-PENDING`；A16 对内部只判「未越 L3」，不判 q3。
4. AI-1（隐式标识 + 3 年留痕）/AI-2/AI-3 上线门禁未闭环，本包不构成 C 端展示放行。
5. 留痕表 `audit.ai_generation_events` 抽查待 H3 签版 + 003 migration 落地后由 Lead 正式指派（A16 尚未开工）。
