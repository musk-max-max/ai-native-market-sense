// 追加 E-0005（append-only；一次性脚本，重跑会因已存在 E-0005 而中止）。
// 所有 sha 由本脚本从磁盘计算，禁止手抄。用法（仓库根）：
//   node reviews/compliance/KD-AIPOLICY-OFFLINE/append-e0005.mjs
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const digest = (name) => sha256(path.join(here, name));

const registerPath = path.join(here, "evidence-register.md");
const before = readFileSync(registerPath, "utf8");
if (before.includes("## E-0005")) {
  console.error("E-0005 已存在，append 中止（append-only）");
  process.exit(1);
}
const priorSha = sha256(registerPath);
if (priorSha !== "ae1b377100de9910cf217396e50414512bc70017da6550e69867c2860557b9ea") {
  console.error(`前版 sha 不一致：${priorSha} != ae1b3771…（拒绝 append）`);
  process.exit(1);
}

const policySha = sha256(path.join(root, "rules/ai-content-policy.json"));
const archivePath = path.join(root, "rules/archive/ai-content-policy", `${policySha}.json`);
const archiveSha = sha256(archivePath);
const redlineSha = sha256(path.join(root, "rules/redline-basis.json"));

const r3 = digest("review-package-H3-1.1.2-r3.md");
const md = digest("report-samples-1.1.2-2026-11-06.md");
const json = digest("report-samples-1.1.2-2026-11-06.json");
const fixtures = digest("fixtures-1.1.2.json");
const runner = digest("run-samples.ts");
const determinism = digest("determinism-evidence-1.1.2.json");
const mapping = digest("mapping-draft-R1-R19.md");

const entry = `
## E-0005 · 2026-11-06 · \`ai-content-policy/1.1.2\` 两分区签认 + redline 1.0.2 取代 + r3 冻结 + 作废 E-0004 ②/④

- 前版登记簿 sha（上一次 H3 回执 \`ae1b3771…\`，append 前实测）：\`${priorSha}\`。
- 对象 1：\`ai-content-policy/1.1.2\`（两分区均 signed；部署文件 sha256 \`${policySha}\`）
  - c_end 分区（H3 签）：签认内容 sha256 \`aae8032a1423566d7d3f0355326a891ee88d8236959ebe5605557da57291a2bd\`；sign_at \`2026-11-06T03:27:11Z\`；签字 ref 跨席不可解析——\`ref_source\` = H3「c_end 分区签认生效」消息（跨席会话，编号不可解析），\`ref_resolvable: false\`，以 sha 绑定为准。
  - internal 分区（owner 签，Lead 代签经用户本轮授权）：ref \`m06899\`；signed_at \`2026-11-06T03:59:17Z\`；依据 \`owner decision 2026-11-06 (m06899)\`。
  - 归档：\`rules/archive/ai-content-policy/${policySha}.json\`（内容寻址；实测归档字节 sha = 部署文件 sha = \`${policySha}\`，两者一致）。
  - 入库 commit：\`dab6842\`（diff = \`rules/ai-content-policy.json\` 4 行 owner \`status\`/\`signed_at\` + 新增归档 267 行；观测基准见下）。
  - 生产门禁：\`loadAiContentPolicy\` PASS（两分区 signed）；生产仍按 version+sha256 双 pin 加载。
- 对象 2：redline \`1.0.1\` → \`1.0.2\` 取代关系（H3 签）
  - \`1.0.1\`：content \`8e8ef728…\` / 部署 \`51d06e3d…\`，已签并归档，被 \`1.0.2\` 取代；目的：解除「policy 签名分区变更 → 部署 pin 漂移 → redline 重签」循环。
  - \`1.0.2\`：H3 签 \`content_sha256_at_signoff=f071cbc91710671d330dc1272558ca05436b9b4db21c2690388534dbe5ef53e6\`，最终/部署文件 sha \`cfe5098245ce75a7f0f31c66149198308b1de3ef8960411c81f1e529d67ce77b\`（实测 \`rules/redline-basis.json\` = \`${redlineSha}\`），commit \`6d25b57\`；绑定改为 \`policy_version\` + c_end 内容 sha（\`policy_signed_content_sha256=aae8032a…\`），\`policy_deployed_file_sha256_observed_at_signoff=7f795503…\` 为观测值、非门禁。
  - \`1.0.1\` 与 \`1.0.2\` 归档均保留；README 记取代关系。
- 对象 3：复核包 r3（\`1.1.2\` 签署后复核实测，H3 直接签署；签署栏为**空模板**，A16 不预填结论/签字）
  - \`review-package-H3-1.1.2-r3.md\` — **r3 冻结 sha \`${r3}\`**（生成器重建两次逐字节一致；本条登记后 \`build-package-r3.mjs\` 进入 check-only，拒绝写入）。
  - 实测报告：\`report-samples-1.1.2-2026-11-06.md\` — \`${md}\`；\`report-samples-1.1.2-2026-11-06.json\` — \`${json}\`。
  - 样本：\`fixtures-1.1.2.json\`（fixture_set \`KD-AIPOLICY-OFFLINE/4\`，36 条；字段 \`policy_content_sha256_expected\` → \`policy_deployed_file_sha256_expected\`，另绑 \`policy_content_sha256_at_signoff=aae8032a…\`）— \`${fixtures}\`。
  - 复跑脚本：\`run-samples.ts\` — \`${runner}\`。
  - 确定性证据：\`determinism-evidence-1.1.2.json\` — \`${determinism}\`（两次连跑报告 md/json sha 逐字节一致）。
  - 映射：\`mapping-draft-R1-R19.md\` — \`${mapping}\`（本轮未改）。
  - 实测：36/36 样本与期望一致；8/8 配置 fail-closed 检查通过；A16 不出结论，r3 待 H3 填签署栏并签认。
- **作废 E-0004 ②/④**（该处陈述在提交时已不成立）：
  - E-0004 ② 写「\`rules/archive/\` 尚未入库（未跟踪）」、④ 写「未入库前…工作树状态、无版本控制保护」——commit \`1895c4a\`（\`2026-11-06T03:32:13Z\` / 11:32:13 +0800）已把 \`rules/archive/**\`、\`packages/ai-policy/test/archive.test.ts\`、policy/redline/README 入库；E-0004 于其后 25 秒（11:32:38 +0800）提交，故 ②/④ 作废，以本条为准；E-0004 其余各项有效。
  - 观测基准：\`observed_at=2026-11-06T03:34:08Z\`；\`observed_head=9ec61566abb65f088ccd48edddd6cf24feee446b\`；\`fact_commit=1895c4a\`；当时 \`git ls-files rules/archive\` = 6 个文件（README + policy 2 + redline 3）。
- 更正 E-0004 首行 ref：
  - E-0004「前版登记簿 sha（上一次 H3 回执 \`e1a728bd…\`）」无可解析编号——\`ref_source\` = H3「登记簿 E-0003 抽核回执」消息（跨席会话，编号不可解析），\`ref_resolvable: false\`；以 sha 绑定为准。
- 更正 policy 签认 note 笔误：
  - c_end 分区 note 写「签字 ref 以 A16 登记簿 E-0003 记录」，应为 **E-0004**（H3 原话：指针应为 E-0004；签名字节不改，以 E-0004/本条为准）。
- 观察项（供 H3 裁量；A16 只读记录，不改签名字节）：
  - internal 分区 owner note 仍保留「等待 owner 签 internal 分区」措辞，与 \`status=signed\` / ref \`m06899\` / signed_at \`2026-11-06T03:59:17Z\` 不符。
  - \`rules/archive/\` 当前跟踪文件数 = 9（含 1.1.2 policy 归档与 redline 两归档）；后续新版本仍须随 commit 入库、commit message 记归档 sha。
- 冻结 commit 测试复跑（r3 冻结判据）：\`observed_at=2026-11-06T04:02:52Z\`；\`observed_head=33a78b719afd7052ca66013b998e9ef77696012c\`（冻结 commit）；\`rules/\`、\`packages/ai-policy/\`、\`services/compliance/\` 三处 \`git status\` 干净；\`cd packages/ai-policy && npm test\` → 41/41 pass / fail 0；\`cd services/compliance && npm test\` → 4/4 pass / fail 0。
- 证据 gap 备注：\`1.1.1\` 已签字节不可复现（见 E-0003）；r2 作为当时记录保留、不可复现但仍有效。
- 登记人：A16 compliance-reviewer；登记时间：2026-11-06。
- 待抽核：本 append 由 H3 或 H5 抽核（重算 sha + 核对只追加 diff）；H3 回执本条生效 sha；生效后 r3 冻结 sha 以本条为准。
`;

appendFileSync(registerPath, entry, "utf8");
console.log(`E-0005 appended.`);
console.log(`  prior sha = ${priorSha}`);
console.log(`  new sha   = ${sha256(registerPath)}`);
console.log(`  r3 frozen = ${r3}`);
console.log(`  policy deployed = ${policySha}`);
console.log(`  fixtures=${fixtures}`);
console.log(`  runner=${runner}`);
console.log(`  determinism=${determinism}`);
