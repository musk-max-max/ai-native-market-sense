// 追加 E-0006（append-only；一次性脚本，重跑会因已存在 E-0006 而中止）。
// 同时按 H3 裁定在规则区新增「signature note 不得含签认状态陈述」规则（规则区改动记前版 sha）。
// 所有 sha 由本脚本从磁盘计算，禁止手抄。用法（仓库根）：
//   node reviews/compliance/KD-AIPOLICY-OFFLINE/append-e0006.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const digest = (name) => sha256(path.join(here, name));

const registerPath = path.join(here, "evidence-register.md");
let register = readFileSync(registerPath, "utf8");
if (register.includes("## E-0006")) {
  console.error("E-0006 已存在，append 中止（append-only）");
  process.exit(1);
}
const priorSha = sha256(registerPath);
if (priorSha !== "9d7c2e61b5b225b0c914df107070d0266bef9c5b8d761bbd21e6254f80e7b57c") {
  console.error(`前版 sha 不一致：${priorSha} != 9d7c2e61…（拒绝 append）`);
  process.exit(1);
}

const r3Signed = digest("review-package-H3-1.1.2-r3.md");
if (r3Signed !== "80434b8bf117293578992049a6a6e9c72c034c724728df84e61e1d35fafd2748") {
  console.error(`r3 签署版 sha 不一致：${r3Signed}`);
  process.exit(1);
}
const r3Frozen = "c0eb15dc02206d0f44898fb78f7a639b6348ed72dec9dded45403f32814f3fa5";
const md = digest("report-samples-1.1.2-2026-11-06.md");
const json = digest("report-samples-1.1.2-2026-11-06.json");
const fixtures = digest("fixtures-1.1.2.json");
const runner = digest("run-samples.ts");
const determinism = digest("determinism-evidence-1.1.2.json");
const policySha = sha256(path.join(root, "rules/ai-content-policy.json"));
const redlineSha = sha256(path.join(root, "rules/redline-basis.json"));

// 规则区新增规则（H3 裁定；规则区改动须在当条 entry 记前版 sha）。
const rulesAnchor =
  "> 治理：每次 append 后由 **H5 或 H3** 抽核一次（重算 sha + 核对只追加 diff），**A16 不得自写自证**；H3 每季度全量抽核。\n";
const newRule =
  "> signature note 规则（E-0006，H3 裁定）：任何 signature 分区 note 不得包含签认状态陈述；翻转时若原 note 会变假，须在同一 diff 内改 note 或改写为中性措辞（1.1.1 不实陈述与 1.1.2 owner note 的共同根因）。\n";
if (!register.includes(rulesAnchor)) {
  console.error("规则区锚点缺失，append 中止");
  process.exit(1);
}
register = register.replace(rulesAnchor, rulesAnchor + newRule);

const entry = `
## E-0006 · 2026-11-06 · E-0005 回执 + r3 签署生效 + owner note 裁定 + 规则区新增 signature note 规则

- 前版登记簿 sha（上一次 H3 回执 \`9d7c2e61…\`，append 前实测）：\`${priorSha}\`。
- **E-0005 回执**：H3 抽核通过，生效 sha = \`9d7c2e61b5b225b0c914df107070d0266bef9c5b8d761bbd21e6254f80e7b57c\`（commit \`7a0e44a\`）。H3 独立核过：前版 \`ae1b3771…\` 接链一致、append +36/0、E-0001..E-0004 未改；作废 E-0004 ②/④ 的依据成立（\`observed_at=03:34:08Z\`、\`observed_head=9ec61566…\`、\`fact_commit=1895c4a\`）；同一观测点 \`git ls-files rules/archive\` 6→9 的分基准写法正确（两个基准不合并为一个数）。回执内容为 **H3 侧复述、非逐字原话**（跨席消息，编号不可解析，不伪造逐字引用）。
- **r3 签署生效**：
  - 冻结版 sha = \`${r3Frozen}\`（E-0005 登记，生成器 check-only 校验通过）
  - **签署版 sha = \`${r3Signed}\`**（H3 在 §4 填结论 + 5 条件，其余未动；diff = 9 插入 / 4 删除）
  - 签署结论：**附条件通过（仅规则层）**——对 \`ai-content-policy/1.1.2\` 的规则层实现（P2–P6 行为、12 类词义与 H3-C01–C12 映射、c_end 分区签认内容）背书；**不构成 C 端 AI 生成内容展示放行**（AI-1/2/3 未闭环），也不构成对 internal 内容的合规背书（owner 职能）。
  - H3 所附 5 条件（要点，原文见 r3 签署版 §4）：
    1. 签认绑定四个独立复算值：r3 冻结 sha \`${r3Frozen}\`、c_end 签认内容 \`aae8032a1423566d7d3f0355326a891ee88d8236959ebe5605557da57291a2bd\`、部署文件 \`${policySha}\`、redline 1.0.2 \`${redlineSha}\`；任一变化即需重签，不得复用本签署。
    2. owner 分区 note 与 \`status=signed\` 不一致：**不改签名字节、不升版本**，按本条裁定处理（见下）；并立规则：任何 signature 分区 note 不得包含签认状态陈述，翻转时如会变假须在同一 diff 内改 note 或改写为中性措辞。
    3. 1.1.2 note 笔误「E-0003」应为「E-0004」：不改签名字节，以 E-0004/E-0005 记录为准。
    4. 签署版 r3 的 sha 与冻结版 \`${r3Frozen}\` 一并入本条；签署后 r3 冻结。
    5. C 端展示门禁（AI-1/2/3）、A12 出口/响应头扫描、\`audit.ai_generation_events\` 留痕抽查按 go-live 门禁另行处理，不随本签认关闭。
  - H3 签署前独立复跑证据（H3 报告，**其消息未给时间戳**；不臆造时间）：HEAD \`7a0e44a\`；\`run-samples.ts\` + \`fixtures-1.1.2.json\` → 36/36、配置 8/8；复跑后 report md \`${md}\` / json \`${json}\` 字节不变（确定性成立）；\`packages/ai-policy\` 41/41、\`services/compliance\` 4/4；r3 §1 表 7 行 sha 与磁盘一致；\`git ls-files rules/archive\` = 9。
  - 签署后 r3 冻结；policy/redline 任何后续字节变化走 \`1.1.3\` + 新 \`r4\`，不复用本签署。
- **owner note 裁定（H3）**：不改签名字节、不升版本；以 \`status=signed\` / \`ref=m06899\` / \`signed_at=2026-11-06T03:59:17Z\` 与 \`agents/decisions.md\` L131 代签授权（用户本轮授权 Lead 代签 internal）为准；note 中「由 owner 本人填写」不成立。A16 只读记录，未改 \`rules/ai-content-policy.json\`。
- **规则区变更**：按 H3 裁定新增规则行「任何 signature 分区 note 不得包含签认状态陈述；翻转时若原 note 会变假，须在同一 diff 内改 note 或改写为中性措辞」；规则区改动前版 sha = \`${priorSha}\`（本条登记，diff 可见仅新增规则行 + 本条 entry）。
- 引用：H3「E-0005 抽核通过、r3 已签」消息（跨席会话，编号不可解析，\`ref_resolvable: false\`）；签署绑定以 r3 两 sha + policy/redline 四值复算为准。
- 本条涉及文件 sha（均为实测）：r3 签署版 \`${r3Signed}\`；报告 md \`${md}\`；json \`${json}\`；fixtures \`${fixtures}\`；runner \`${runner}\`；determinism \`${determinism}\`；policy 部署 \`${policySha}\`；redline \`${redlineSha}\`。
- 登记人：A16 compliance-reviewer；登记时间：2026-11-06。
- 待抽核：本 append 由 H3 或 H5 抽核（重算 sha + 核对只追加 diff；注意规则区新增 1 行）。生效后 r3 以签署版 sha 为准。
`;

writeFileSync(registerPath, register + entry, "utf8");
console.log(`E-0006 appended.`);
console.log(`  prior sha = ${priorSha}`);
console.log(`  new sha   = ${sha256(registerPath)}`);
console.log(`  r3 signed = ${r3Signed}`);
console.log(`  rules area diff: +1 rule line`);
