// A16 生成 review-package-H3-1.1.2-r3.md（1.1.2 两分区签认后的签字后复核包）。
// 用法（仓库根）：node reviews/compliance/KD-AIPOLICY-OFFLINE/build-package-r3.mjs
// 约束：所有 sha 由本脚本计算，禁止手抄；生成后自检表内 sha == 磁盘 sha。
// 治理：evidence-register.md 登记「r3 冻结 sha」后本脚本进入 check-only（拒绝写入，仅校验）；
// 签署栏必须是空模板（H3 要求新 rN 不得预填结论/签字）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const sha256 = (p) => {
  if (!existsSync(p)) throw new Error(`missing file: ${p}`);
  return createHash("sha256").update(readFileSync(p)).digest("hex");
};
const digest = (name) => sha256(path.join(here, name));

const r3Name = "review-package-H3-1.1.2-r3.md";
const files = {
  md: "report-samples-1.1.2-2026-11-06.md",
  json: "report-samples-1.1.2-2026-11-06.json",
  fixtures: "fixtures-1.1.2.json",
  runner: "run-samples.ts",
  mapping: "mapping-draft-R1-R19.md",
  determinism: "determinism-evidence-1.1.2.json",
};
const sha = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, digest(f)]));

const registerPath = path.join(here, "evidence-register.md");
const r3Path = path.join(here, r3Name);
if (existsSync(registerPath)) {
  const reg = readFileSync(registerPath, "utf8");
  const frozenMatch = reg.match(/r3 冻结 sha[^`\n]*`([0-9a-f]{64})`/);
  if (frozenMatch) {
    const frozen = frozenMatch[1];
    if (!existsSync(r3Path)) {
      console.error("check-only：r3 冻结于 register，但文件缺失");
      process.exit(1);
    }
    const problems = [];
    const actual = sha256(r3Path);
    if (actual !== frozen) problems.push(`r3 磁盘 sha ${actual} != 冻结 sha ${frozen}`);
    const written = readFileSync(r3Path, "utf8");
    const rows = [...written.matchAll(/\| \d+ \| `([^`]+)` \| (?:`([0-9a-f]{64})`|（本文件）) \|/g)];
    for (const [, name, listed] of rows) {
      if (!listed) continue;
      const disk = digest(name);
      if (disk !== listed) problems.push(`${name}: 表内 ${listed} != 磁盘 ${disk}`);
    }
    console.log(`check-only 模式：r3 已冻结（${frozen.slice(0, 16)}…），拒绝写入，仅校验`);
    if (problems.length) {
      console.error("校验失败：\n" + problems.join("\n"));
      process.exit(1);
    }
    console.log(`OK：r3 文件 sha == 冻结 sha；§1 表 ${rows.filter((r) => r[2]).length} 行 sha == 磁盘`);
    process.exit(0);
  }
}

const evidence = JSON.parse(readFileSync(path.join(here, files.determinism), "utf8"));
if (evidence.identical !== true || evidence.runs.length !== 2) {
  throw new Error("determinism-evidence-1.1.2.json 未显示两次连跑一致，拒绝生成 r3");
}
const policyJson = JSON.parse(readFileSync(path.join(root, "rules/ai-content-policy.json"), "utf8"));
const sig = policyJson.authority.h3_policy_version_signature;
const owner = policyJson.authority.owner_policy_version_signature;
const deployedSha = sha256(path.join(root, "rules/ai-content-policy.json"));
const archiveName = `rules/archive/ai-content-policy/${deployedSha}.json`;

const content = `# A16 复核包 — \`ai-content-policy/1.1.2\`（H3 直接签署）

- 提交人：A16 compliance-reviewer（无终审权；本包只提供证据与待签文本）
- 提交日期：2026-11-06
- 复核对象：\`rules/ai-content-policy.json\`（\`policy_version=ai-content-policy/1.1.2\`，部署文件 sha256 \`${deployedSha}\`）与 \`@market-sense/ai-policy\` 的 \`runAiPolicy\`（P2–P6）
- 运行命令：\`packages/ai-policy/node_modules/.bin/tsx reviews/compliance/KD-AIPOLICY-OFFLINE/run-samples.ts reviews/compliance/KD-AIPOLICY-OFFLINE/fixtures-1.1.2.json\`
- 样本：\`fixtures-1.1.2.json\`（fixture_set \`KD-AIPOLICY-OFFLINE/4\`）正 7 / 负 12 / 边界 17 = 36 条；配置 fail-closed 检查 8 项
- 结果：**36/36 与期望一致；8/8 配置检查通过**（仅为实现行为证据；不写「合规通过」，结论见 §4 签署栏）

## 1. 复核包构成

| # | 文件（本目录） | sha256 | 说明 |
|---|---|---|---|
| 1 | \`${r3Name}\` | （本文件） | 索引 + 待签文本 + 签署栏 |
| 2 | \`${files.md}\` | \`${sha.md}\` | 签字后复核实测（人读） |
| 3 | \`${files.json}\` | \`${sha.json}\` | 机读结果（含每样本输入/期望/实际/diff） |
| 4 | \`${files.fixtures}\` | \`${sha.fixtures}\` | 36 条样本，绑定部署文件 sha（改名后字段）与 c_end 签认内容 sha |
| 5 | \`${files.runner}\` | \`${sha.runner}\` | 复跑脚本（只调用 ai-policy，不复制判定逻辑） |
| 6 | \`${files.mapping}\` | \`${sha.mapping}\` | H3-C01–C12 ↔ 12 category 映射（H3-C 体系） |
| 7 | \`${files.determinism}\` | \`${sha.determinism}\` | 两次连跑一致证据（md/json 逐字节相同） |

复跑方式：仓库根执行 §头部运行命令（应与 \`${files.json}\` 的 36/36、8/8 一致）。报告头分两行写「c_end 签认内容 sha256」与「最终文件 sha256（部署 pin）」，并含 \`policy_version + 运行命令\`。

## 1.1 确定性复跑证据

- 运行 \`node reviews/compliance/KD-AIPOLICY-OFFLINE/determinism-check.mjs reviews/compliance/KD-AIPOLICY-OFFLINE/fixtures-1.1.2.json determinism-evidence-1.1.2.json\`（内部连跑两次 \`run-samples.ts\`），两次输出 sha256 **逐字节一致**：
  - run #1：md \`${evidence.runs[0].md}\`；json \`${evidence.runs[0].json}\`
  - run #2：md \`${evidence.runs[1].md}\`；json \`${evidence.runs[1].json}\`
- 确定性来源：报告时间戳固定取 \`fixtures-1.1.2.json\` 的 \`report_generated_at=2026-11-06T00:00:00Z\` / \`report_date=2026-11-06\`（不取系统时钟）、键顺序固定、固定换行。
- 结论：H3 复跑不会改变报告字节，§1 表内报告 sha 可作冻结绑定；本文件后续任何字节变更须重跑并出新 rN。

## 2. 签署绑定信息

- **policy 版本**：\`ai-content-policy/1.1.2\`
- **c_end 分区（H3 签，signed）**：签认内容 sha256 \`${sig.content_sha256_at_signoff}\`；sign_at ${sig.sign_at}；签字 ref 跨席不可解析（\`ref_resolvable: false\`，以 sha 绑定为准）
- **internal 分区（owner 签，signed）**：ref \`${owner.ref}\`；signed_at ${owner.signed_at}；依据 \`${policyJson.basis_scope.internal_basis}\`
- **部署文件 sha256**（两分区签认后、生产 pin）：\`${deployedSha}\`
- **归档**：\`${archiveName}\`（内容寻址，字节与部署文件一致）；入库 commit \`dab6842\`
- **生产门禁**：\`loadAiContentPolicy\` PASS（两分区均 signed）；生产环境仍按 version+sha256 双 pin 加载
- **basis 依据**：\`rules/redline-basis.json\` v1.0.2（H3 签封版 \`cfe50982…\`，commit \`6d25b57\`）；1.0.1 已被取代、归档保留；绑定为 policy_version + c_end 内容 sha 跨文件一致，部署字节 sha 仅作观测值
- **1.1.1 历史**：已签字节未入库/未归档（evidence gap 见登记簿 E-0003），r2 作为当时记录继续有效但不可复现；1.1.1 签署包（r2）保留在目录中，作留痕不删

## 3. 覆盖清单（概要）

- **正样本 7**：POS-01 metrics / POS-02 quantiles / POS-03 statistics（P6 redact）/ POS-04 historical_facts / POS-05 data_gaps+caveat / POS-06 timestamps / POS-07 objective_fields（C 端）。
- **负样本 12**：NEG-01…12 逐一覆盖 12 类 \`reason_code\`（investment_advice … guarantee），全部 block。
- **边界样本 17**：BND-01 允许前缀 pass；BND-02 data_gap→caveat；BND-03 audience 缺省抛错（\`audience_required\`，F3）；BND-04 非白名单前缀 redact；BND-05 P3 先拦；BND-06 P6 证据类型不匹配→block；BND-07 C 端 data_gaps 拒绝；BND-08 class 缺失→block；BND-09 未声明 audience 抛错；BND-10 P2 结构畸形；BND-11 causal 在 data_gap 语境豁免；BND-12 ISO 日期 timestamps 通过（F4）；BND-13 data_gaps 无前缀通过 + \`skip_p6_classes\` 机读断言（F2）；BND-14 \`YYYY-MM-DD HH:mm\` 通过；BND-15 \`YYYY年M月D日\` 通过；BND-16 证据外数字仍 block（\`numeric_mismatch\`）；BND-17 模型生成 \`section.title\` 拒绝（\`model_generated_title_not_allowed\`，H3 m01470）。
- **配置 fail-closed 8**：CFG-01 生产未签拒绝；CFG-02 version 不一致拒绝；CFG-06 sha256 不一致拒绝；CFG-07 缺少 version/sha 双 pin 拒绝；CFG-08 \`skip_p6_classes\` 策略声明机读断言；CFG-03 前缀映射缺失拒绝；CFG-04 非法正则拒绝；CFG-05 非生产 pending 可加载（联调）。

## 4. 待签文本 + 签署栏（由 H3 填写；A16 不出结论）

> H3 签认 \`policy_version=ai-content-policy/1.1.2\`（c_end 分区，签认内容 sha256=\`${sig.content_sha256_at_signoff}\`）；internal 分区由 owner 签认（ref \`${owner.ref}\`）；部署文件 sha256=\`${deployedSha}\`。
> 签认范围：audience 分档白名单、H3-C01–C12 词表与依据（\`rules/redline-basis.json\` v1.0.2）、允许前缀仅「数据显示/历史统计上」且与证据类型绑定、P6 改写后重跑 P5、P5 命中即 block、data_gaps 豁免经策略声明。
> **不构成对 C 端 AI 生成内容展示的放行**：AI-1（隐式标识 + 3 年留痕机制）/AI-2/AI-3 未闭环前不得展示。

- 复核结论（通过 / 不通过 / 附条件，由 H3 填写）：________________
- 条件（如附条件，由 H3 填写）：________________
- 依据：本包 §1 证据（36/36 样本、8/8 配置检查、H3-C01–C12 映射）；H3 可独立复跑。
- H3 签字：________________　日期：________________
- 签署绑定：\`policy_version=ai-content-policy/1.1.2\`；c_end 签认内容 sha256 \`${sig.content_sha256_at_signoff}\`；部署文件 sha256 \`${deployedSha}\`。
- 冻结声明：本文件签署后冻结，任何修改须重签；后续版本用新文件名。
- 备注：A16 无终审权；本包为离线抽检证据，不替代 H3 对策略内容的签认；H3 可要求补样本或复跑。

## 5. 遗留事项（非实现缺陷，不阻断签认）

1. \`agents/decisions.md:141\` 红线编号记录自相矛盾（「禁止 7 条」列 10 个编号），由 Lead/H1 更正；A16 只引用 H3-C 主题编号，R1–R19 仅历史别名。
2. ADR-007 P5/P6 文本修订（P5 改为「命中即 block」、P6 前缀仅「数据显示/历史统计上」）由 A0/H2 同步，policy 文件为准。
3. ADR-008 D8 状态行仍 \`OWNER-DECISION-PENDING\`；A16 对内部只判「未越 L3」，不判 q3。
4. AI-1（隐式标识 + 3 年留痕）/AI-2/AI-3 上线门禁未闭环，本包不构成 C 端展示放行。
5. 留痕表 \`audit.ai_generation_events\` 抽查待 Lead 正式指派（口径先报 H3）；A16 只有 \`audit_reader\`（SELECT），无写权限。
6. 1.1.2 签认 note 中「ref 以 A16 登记簿 E-0003 记录」为笔误，应为 E-0004；签名字节不改，以登记簿 E-0004/E-0005 为准（E-0005 记录更正）。
7. internal 分区 owner 签认 note 仍保留「等待 owner 签 internal 分区」措辞（签名字节不改）；以 status=signed / ref \`${owner.ref}\` / signed_at ${owner.signed_at} 为准，A16 已在 E-0005 记录该文本不一致。
8. \`fixtures.json\`（1.1.1 轮）字段 \`policy_content_sha256_expected\` 在 1.1.2 轮已改名为 \`policy_deployed_file_sha256_expected\`（语义 = 部署文件 sha）；旧文件保留以保 r2 check-only。
`;

writeFileSync(r3Path, content, "utf8");

const written = readFileSync(r3Path, "utf8");
const rows = [...written.matchAll(/\| \d+ \| `([^`]+)` \| (?:`([0-9a-f]{64})`|（本文件）) \|/g)];
const problems = [];
for (const [, name, listed] of rows) {
  if (!listed) continue;
  const actual = digest(name);
  if (actual !== listed) problems.push(`${name}: table=${listed} disk=${actual}`);
}
if (problems.length) {
  console.error("r3 自检失败：\n" + problems.join("\n"));
  process.exit(1);
}
console.log("r3 生成并自检通过（表内 sha == 磁盘 sha）");
console.log(`  ${r3Name} sha256 = ${sha256(r3Path)}`);
console.log(`  md=${sha.md}\n  json=${sha.json}\n  fixtures=${sha.fixtures}\n  runner=${sha.runner}\n  determinism=${sha.determinism}`);
