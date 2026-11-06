# A16 复核包 — `ai-content-policy/1.1.2`（H3 直接签署）

- 提交人：A16 compliance-reviewer（无终审权；本包只提供证据与待签文本）
- 提交日期：2026-11-06
- 复核对象：`rules/ai-content-policy.json`（`policy_version=ai-content-policy/1.1.2`，部署文件 sha256 `7fead8cd2e5cf7cc1b06caa11216e873f55e0b13b839be1485b1b1f2d9520ed3`）与 `@market-sense/ai-policy` 的 `runAiPolicy`（P2–P6）
- 运行命令：`packages/ai-policy/node_modules/.bin/tsx reviews/compliance/KD-AIPOLICY-OFFLINE/run-samples.ts reviews/compliance/KD-AIPOLICY-OFFLINE/fixtures-1.1.2.json`
- 样本：`fixtures-1.1.2.json`（fixture_set `KD-AIPOLICY-OFFLINE/4`）正 7 / 负 12 / 边界 17 = 36 条；配置 fail-closed 检查 8 项
- 结果：**36/36 与期望一致；8/8 配置检查通过**（仅为实现行为证据；不写「合规通过」，结论见 §4 签署栏）

## 1. 复核包构成

| # | 文件（本目录） | sha256 | 说明 |
|---|---|---|---|
| 1 | `review-package-H3-1.1.2-r3.md` | （本文件） | 索引 + 待签文本 + 签署栏 |
| 2 | `report-samples-1.1.2-2026-11-06.md` | `a68cdca6fc3ddf71e09200d1672b89423774bce523ed18685f5237ad930f49bc` | 签字后复核实测（人读） |
| 3 | `report-samples-1.1.2-2026-11-06.json` | `bac06cf017d06a87ad387669f6c2d91f613c1e74e874d9df79f566d2c96dea74` | 机读结果（含每样本输入/期望/实际/diff） |
| 4 | `fixtures-1.1.2.json` | `6f9365adc200345aba95d9dfffc457f82e6169e5a1fc11888ba5db5523bc8d87` | 36 条样本，绑定部署文件 sha（改名后字段）与 c_end 签认内容 sha |
| 5 | `run-samples.ts` | `4e1234eed6952fdd152a9ca591e243de5fbee2817f226a6670df56ffeec72ed8` | 复跑脚本（只调用 ai-policy，不复制判定逻辑） |
| 6 | `mapping-draft-R1-R19.md` | `f78a8e18454e7dceb9c7b099ebdd90f99157f2f93a4d96f54bce33da92d22857` | H3-C01–C12 ↔ 12 category 映射（H3-C 体系） |
| 7 | `determinism-evidence-1.1.2.json` | `571ca7f479598fe4d289b1cd48b592fbeecc4654223e9d4e523bf9344851a45a` | 两次连跑一致证据（md/json 逐字节相同） |

复跑方式：仓库根执行 §头部运行命令（应与 `report-samples-1.1.2-2026-11-06.json` 的 36/36、8/8 一致）。报告头分两行写「c_end 签认内容 sha256」与「最终文件 sha256（部署 pin）」，并含 `policy_version + 运行命令`。

## 1.1 确定性复跑证据

- 运行 `node reviews/compliance/KD-AIPOLICY-OFFLINE/determinism-check.mjs reviews/compliance/KD-AIPOLICY-OFFLINE/fixtures-1.1.2.json determinism-evidence-1.1.2.json`（内部连跑两次 `run-samples.ts`），两次输出 sha256 **逐字节一致**：
  - run #1：md `a68cdca6fc3ddf71e09200d1672b89423774bce523ed18685f5237ad930f49bc`；json `bac06cf017d06a87ad387669f6c2d91f613c1e74e874d9df79f566d2c96dea74`
  - run #2：md `a68cdca6fc3ddf71e09200d1672b89423774bce523ed18685f5237ad930f49bc`；json `bac06cf017d06a87ad387669f6c2d91f613c1e74e874d9df79f566d2c96dea74`
- 确定性来源：报告时间戳固定取 `fixtures-1.1.2.json` 的 `report_generated_at=2026-11-06T00:00:00Z` / `report_date=2026-11-06`（不取系统时钟）、键顺序固定、固定换行。
- 结论：H3 复跑不会改变报告字节，§1 表内报告 sha 可作冻结绑定；本文件后续任何字节变更须重跑并出新 rN。

## 2. 签署绑定信息

- **policy 版本**：`ai-content-policy/1.1.2`
- **c_end 分区（H3 签，signed）**：签认内容 sha256 `aae8032a1423566d7d3f0355326a891ee88d8236959ebe5605557da57291a2bd`；sign_at 2026-11-06T03:27:11Z；签字 ref 跨席不可解析（`ref_resolvable: false`，以 sha 绑定为准）
- **internal 分区（owner 签，signed）**：ref `m06899`；signed_at 2026-11-06T03:59:17Z；依据 `owner decision 2026-11-06 (m06899)`
- **部署文件 sha256**（两分区签认后、生产 pin）：`7fead8cd2e5cf7cc1b06caa11216e873f55e0b13b839be1485b1b1f2d9520ed3`
- **归档**：`rules/archive/ai-content-policy/7fead8cd2e5cf7cc1b06caa11216e873f55e0b13b839be1485b1b1f2d9520ed3.json`（内容寻址，字节与部署文件一致）；入库 commit `dab6842`
- **生产门禁**：`loadAiContentPolicy` PASS（两分区均 signed）；生产环境仍按 version+sha256 双 pin 加载
- **basis 依据**：`rules/redline-basis.json` v1.0.2（H3 签封版 `cfe50982…`，commit `6d25b57`）；1.0.1 已被取代、归档保留；绑定为 policy_version + c_end 内容 sha 跨文件一致，部署字节 sha 仅作观测值
- **1.1.1 历史**：已签字节未入库/未归档（evidence gap 见登记簿 E-0003），r2 作为当时记录继续有效但不可复现；1.1.1 签署包（r2）保留在目录中，作留痕不删

## 3. 覆盖清单（概要）

- **正样本 7**：POS-01 metrics / POS-02 quantiles / POS-03 statistics（P6 redact）/ POS-04 historical_facts / POS-05 data_gaps+caveat / POS-06 timestamps / POS-07 objective_fields（C 端）。
- **负样本 12**：NEG-01…12 逐一覆盖 12 类 `reason_code`（investment_advice … guarantee），全部 block。
- **边界样本 17**：BND-01 允许前缀 pass；BND-02 data_gap→caveat；BND-03 audience 缺省抛错（`audience_required`，F3）；BND-04 非白名单前缀 redact；BND-05 P3 先拦；BND-06 P6 证据类型不匹配→block；BND-07 C 端 data_gaps 拒绝；BND-08 class 缺失→block；BND-09 未声明 audience 抛错；BND-10 P2 结构畸形；BND-11 causal 在 data_gap 语境豁免；BND-12 ISO 日期 timestamps 通过（F4）；BND-13 data_gaps 无前缀通过 + `skip_p6_classes` 机读断言（F2）；BND-14 `YYYY-MM-DD HH:mm` 通过；BND-15 `YYYY年M月D日` 通过；BND-16 证据外数字仍 block（`numeric_mismatch`）；BND-17 模型生成 `section.title` 拒绝（`model_generated_title_not_allowed`，H3 m01470）。
- **配置 fail-closed 8**：CFG-01 生产未签拒绝；CFG-02 version 不一致拒绝；CFG-06 sha256 不一致拒绝；CFG-07 缺少 version/sha 双 pin 拒绝；CFG-08 `skip_p6_classes` 策略声明机读断言；CFG-03 前缀映射缺失拒绝；CFG-04 非法正则拒绝；CFG-05 非生产 pending 可加载（联调）。

## 4. 待签文本 + 签署栏（由 H3 填写；A16 不出结论）

> H3 签认 `policy_version=ai-content-policy/1.1.2`（c_end 分区，签认内容 sha256=`aae8032a1423566d7d3f0355326a891ee88d8236959ebe5605557da57291a2bd`）；internal 分区由 owner 签认（ref `m06899`）；部署文件 sha256=`7fead8cd2e5cf7cc1b06caa11216e873f55e0b13b839be1485b1b1f2d9520ed3`。
> 签认范围：audience 分档白名单、H3-C01–C12 词表与依据（`rules/redline-basis.json` v1.0.2）、允许前缀仅「数据显示/历史统计上」且与证据类型绑定、P6 改写后重跑 P5、P5 命中即 block、data_gaps 豁免经策略声明。
> **不构成对 C 端 AI 生成内容展示的放行**：AI-1（隐式标识 + 3 年留痕机制）/AI-2/AI-3 未闭环前不得展示。

- 复核结论（通过 / 不通过 / 附条件，由 H3 填写）：**附条件通过（仅规则层）**——对 `ai-content-policy/1.1.2` 的规则层实现（P2–P6 行为、12 类词义与 H3-C01–C12 映射、c_end 分区签认内容）背书；**不构成 C 端 AI 生成内容展示放行**（AI-1/2/3 未闭环），也不构成对 internal 内容的合规背书（owner 职能）。
- 条件（如附条件，由 H3 填写）：
  1. 本签认绑定四个独立复算值：r3 冻结 sha `c0eb15dc02206d0f44898fb78f7a639b6348ed72dec9dded45403f32814f3fa5`、c_end 签认内容 `aae8032a1423566d7d3f0355326a891ee88d8236959ebe5605557da57291a2bd`、部署文件 `7fead8cd2e5cf7cc1b06caa11216e873f55e0b13b839be1485b1b1f2d9520ed3`、redline 1.0.2 `cfe5098245ce75a7f0f31c66149198308b1de3ef8960411c81f1e529d67ce77b`；任一变化即需重签，不得复用本签署。
  2. owner 分区 note 与 `status=signed` 不一致（§5-7）：**不改签名字节、不升版本**，由 A16 在 E-0006 记录裁定——以 `status=signed` / `ref=m06899` / `signed_at=2026-11-06T03:59:17Z` 与 `agents/decisions.md` L131 代签授权为准；note 中「由 owner 本人填写」不成立（用户授权 Lead 代签）。并立规则：今后任何 signature 分区 note 不得包含签认状态陈述，翻转时如会变假，须在同一 diff 内改 note 或改写为中性措辞。
  3. 1.1.2 note 笔误「E-0003」应为「E-0004」：不改签名字节，以 E-0004/E-0005 记录为准（§5-6）。
  4. 签署版 r3 的 sha 与冻结版 `c0eb15dc…` 一并入 E-0006；签署后本文件冻结，任何修改须重签并换新文件名。
  5. §5-4/§5-5 的 C 端展示门禁（AI-1/2/3）、A12 出口/响应头扫描、`audit.ai_generation_events` 留痕抽查按 go-live 门禁另行处理，不随本签认关闭。
- 依据：本包 §1 证据，我独立复跑——`run-samples.ts`+`fixtures-1.1.2.json` 36/36、配置 8/8，复跑后 report md `a68cdca6…`/json `bac06cf0…` 字节不变（确定性成立）；HEAD `7a0e44a` 上包 41/41、compliance 4/4；`git ls-files rules/archive` = 9。
- H3 签字：H3（合规负责人 / DPO）　日期：2026-11-06（Asia/Shanghai）
- 签署绑定：`policy_version=ai-content-policy/1.1.2`；c_end 签认内容 sha256 `aae8032a1423566d7d3f0355326a891ee88d8236959ebe5605557da57291a2bd`；部署文件 sha256 `7fead8cd2e5cf7cc1b06caa11216e873f55e0b13b839be1485b1b1f2d9520ed3`。
- 冻结声明：本文件签署后冻结，任何修改须重签；后续版本用新文件名。
- 备注：A16 无终审权；本包为离线抽检证据，不替代 H3 对策略内容的签认；H3 可要求补样本或复跑。

## 5. 遗留事项（非实现缺陷，不阻断签认）

1. `agents/decisions.md:141` 红线编号记录自相矛盾（「禁止 7 条」列 10 个编号），由 Lead/H1 更正；A16 只引用 H3-C 主题编号，R1–R19 仅历史别名。
2. ADR-007 P5/P6 文本修订（P5 改为「命中即 block」、P6 前缀仅「数据显示/历史统计上」）由 A0/H2 同步，policy 文件为准。
3. ADR-008 D8 状态行仍 `OWNER-DECISION-PENDING`；A16 对内部只判「未越 L3」，不判 q3。
4. AI-1（隐式标识 + 3 年留痕）/AI-2/AI-3 上线门禁未闭环，本包不构成 C 端展示放行。
5. 留痕表 `audit.ai_generation_events` 抽查待 Lead 正式指派（口径先报 H3）；A16 只有 `audit_reader`（SELECT），无写权限。
6. 1.1.2 签认 note 中「ref 以 A16 登记簿 E-0003 记录」为笔误，应为 E-0004；签名字节不改，以登记簿 E-0004/E-0005 为准（E-0005 记录更正）。
7. internal 分区 owner 签认 note 仍保留「等待 owner 签 internal 分区」措辞（签名字节不改）；以 status=signed / ref `m06899` / signed_at 2026-11-06T03:59:17Z 为准，A16 已在 E-0005 记录该文本不一致。
8. `fixtures.json`（1.1.1 轮）字段 `policy_content_sha256_expected` 在 1.1.2 轮已改名为 `policy_deployed_file_sha256_expected`（语义 = 部署文件 sha）；旧文件保留以保 r2 check-only。
