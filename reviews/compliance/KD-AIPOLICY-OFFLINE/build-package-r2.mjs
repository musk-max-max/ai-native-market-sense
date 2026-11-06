// A16 生成 review-package-H3-1.1.1-r2.md：基于 r1（不改 r1），用脚本重算 sha 表并自检。
// 用法（仓库根）：node reviews/compliance/KD-AIPOLICY-OFFLINE/build-package-r2.mjs
// 约束：所有 sha 由本脚本计算，禁止手抄；生成后自检表内 sha == 磁盘 sha。
// H3 m00533 后：evidence-register.md 登记 r2 冻结 sha 即进入 check-only（拒绝写入）；
// 以后新 rN 的签署栏必须是空模板，不得预填 H3 结论或签字。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (p) => {
  if (!existsSync(p)) throw new Error(`missing file: ${p}`);
  return createHash("sha256").update(readFileSync(p)).digest("hex");
};
const digest = (name) => sha256(path.join(here, name));

const files = {
  md: "report-samples-1.1.1-2026-11-06.md",
  json: "report-samples-1.1.1-2026-11-06.json",
  fixtures: "fixtures.json",
  runner: "run-samples.ts",
  mapping: "mapping-draft-R1-R19.md",
  determinism: "determinism-evidence.json",
};
const sha = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, digest(f)]));

// 0) check-only 闸门（H3 m00533）：evidence-register.md 登记 r2 冻结 sha 后，本脚本禁止写入，
//    只校验 r2 文件 sha 与表内各行 sha；已签证据不得被生成器重写。
const registerPath = path.join(here, "evidence-register.md");
const r2Path = path.join(here, "review-package-H3-1.1.1-r2.md");
if (existsSync(registerPath)) {
  const reg = readFileSync(registerPath, "utf8");
  const frozenMatch = reg.match(/r2 冻结 sha[^`\n]*`([0-9a-f]{64})`/);
  if (frozenMatch) {
    const frozen = frozenMatch[1];
    if (!existsSync(r2Path)) {
      console.error("check-only：r2 冻结于 register，但文件缺失");
      process.exit(1);
    }
    const problems = [];
    const actual = sha256(r2Path);
    if (actual !== frozen) problems.push(`r2 磁盘 sha ${actual} != 冻结 sha ${frozen}`);
    const written = readFileSync(r2Path, "utf8");
    const rows = [...written.matchAll(/\| \d+ \| `([^`]+)` \| (?:`([0-9a-f]{64})`|（本文件）) \|/g)];
    for (const [, name, listed] of rows) {
      if (!listed) continue;
      const disk = digest(name);
      if (disk !== listed) problems.push(`${name}: 表内 ${listed} != 磁盘 ${disk}`);
    }
    console.log(`check-only 模式：r2 已冻结（${frozen.slice(0, 16)}…），拒绝写入，仅校验`);
    if (problems.length) {
      console.error("校验失败：\n" + problems.join("\n"));
      process.exit(1);
    }
    console.log(`OK：r2 文件 sha == 冻结 sha；§1 表 ${rows.filter((r) => r[2]).length} 行 sha == 磁盘`);
    process.exit(0);
  }
}
const evidence = JSON.parse(readFileSync(path.join(here, files.determinism), "utf8"));
if (evidence.identical !== true || evidence.runs.length !== 2) {
  throw new Error("determinism-evidence.json 未显示两次连跑一致，拒绝生成 r2");
}
const r1 = readFileSync(path.join(here, "review-package-H3-1.1.1.md"), "utf8");

// 1) 表内 sha 行替换（行 15–19），并追加 determinism 行
let out = r1
  .replace(
    "| 1 | `review-package-H3-1.1.1.md` | （本文件）",
    "| 1 | `review-package-H3-1.1.1-r2.md` | （本文件）",
  )
  .replace(/(\| 2 \| `report-samples-1\.1\.1-2026-11-06\.md` \| )`[0-9a-f]{64}`/, `$1\`${sha.md}\``)
  .replace(/(\| 3 \| `report-samples-1\.1\.1-2026-11-06\.json` \| )`[0-9a-f]{64}`/, `$1\`${sha.json}\``)
  .replace(/(\| 4 \| `fixtures.json` \| )`[0-9a-f]{64}`/, `$1\`${sha.fixtures}\``)
  .replace(/(\| 5 \| `run-samples.ts` \| )`[0-9a-f]{64}`/, `$1\`${sha.runner}\``)
  .replace(/(\| 6 \| `mapping-draft-R1-R19\.md` \| )`[0-9a-f]{64}`/, `$1\`${sha.mapping}\``);

if (!out.includes(`| 7 | \`determinism-evidence.json\``)) {
  out = out.replace(
    /(\| 6 \| `mapping-draft-R1-R19\.md` \|[^\n]*\n)/,
    `$1| 7 | \`determinism-evidence.json\` | \`${sha.determinism}\` | 两次连跑一致证据（md/json 逐字节相同） |\n`,
  );
}

// 2) 标题后加 r1→r2 取代说明
out = out.replace(
  "# A16 复核包 — `ai-content-policy/1.1.1`（H3 直接签署）\n",
  "# A16 复核包 — `ai-content-policy/1.1.1`（H3 直接签署）\n\n> **r1 由 r2 取代（r1 保留作留痕，不删）。** r2 修正 §1 sha 表（改为脚本计算，覆盖 H3 m00481 指出的过期表），并新增 §1.1「确定性复跑」证据；正文其余内容与 r1 相同。\n",
);

// 3) 插入确定性复跑证据（放在 §1 与 §2 之间，编号 1.1 避免正文重编号）
const detSection = `## 1.1 确定性复跑证据（H3 m00481 返工项）

- 运行 \`node reviews/compliance/KD-AIPOLICY-OFFLINE/determinism-check.mjs\`（内部连跑两次 \`run-samples.ts\`），两次输出 sha256 **逐字节一致**：
  - run #1：md \`${evidence.runs[0].md}\`；json \`${evidence.runs[0].json}\`
  - run #2：md \`${evidence.runs[1].md}\`；json \`${evidence.runs[1].json}\`
- 确定性来源：报告时间戳固定取 \`fixtures.json\` 的 \`report_generated_at=2026-11-06T00:00:00Z\` / \`report_date=2026-11-06\`（不取系统时钟）、键顺序固定、固定换行；证据落 \`determinism-evidence.json\`（sha 见 §1 表第 7 行）。
- 结论：H3 复跑不会改变报告字节，§1 表内报告 sha 可作冻结绑定；本文件后续任何字节变更须重跑并出新 rN。

`;
out = out.replace("\n## 2. 签署绑定信息\n", `\n${detSection}## 2. 签署绑定信息\n`);

const target = path.join(here, "review-package-H3-1.1.1-r2.md");
writeFileSync(target, out);

// 4) 自检：重读 r2，校验表内每个 sha 与磁盘一致
const written = readFileSync(target, "utf8");
const rows = [...written.matchAll(/\| \d+ \| `([^`]+)` \| (?:`([0-9a-f]{64})`|（本文件）) \|/g)];
const problems = [];
for (const [, name, listed] of rows) {
  if (!listed) continue;
  const actual = digest(name);
  if (actual !== listed) problems.push(`${name}: table=${listed} disk=${actual}`);
}
if (problems.length) {
  console.error("r2 自检失败：\n" + problems.join("\n"));
  process.exit(1);
}
console.log("r2 生成并自检通过（表内 sha == 磁盘 sha）");
console.log(`  review-package-H3-1.1.1-r2.md sha256 = ${sha256(target)}`);
console.log(`  md=${sha.md}\n  json=${sha.json}\n  evidence=${sha.determinism}`);
