// A16 确定性复跑校验：连跑两次 run-samples.ts，断言两次输出 sha256 逐字节一致。
// 用法（仓库根）：node reviews/compliance/KD-AIPOLICY-OFFLINE/determinism-check.mjs [fixtures 相对路径] [证据文件名]
//   - 缺省 fixture = fixtures.json，证据 = determinism-evidence.json（1.1.1 轮次，勿覆盖）
//   - 1.1.2 轮次：node .../determinism-check.mjs reviews/compliance/KD-AIPOLICY-OFFLINE/fixtures-1.1.2.json determinism-evidence-1.1.2.json
// 证据内容本身确定性（无系统时钟），可重复生成。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const tsx = path.join(root, "packages/ai-policy/node_modules/.bin/tsx");
const runner = path.join(here, "run-samples.ts");

const fixtureArg = process.argv[2] ?? "fixtures.json";
const evidenceName = process.argv[3] ?? "determinism-evidence.json";
const fixturesPath = path.resolve(root, fixtureArg);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

const versionSlug = fixtures.policy_version_expected
  .replace(/^ai-content-policy\//, "")
  .replace(/[^0-9A-Za-z.-]/g, "-");
const reportDate = fixtures.report_date ?? "2026-11-06";
const mdPath = path.join(here, `report-samples-${versionSlug}-${reportDate}.md`);
const jsonPath = path.join(here, `report-samples-${versionSlug}-${reportDate}.json`);

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runOnce() {
  execFileSync(tsx, [runner, fixtureArg], { cwd: root, stdio: "pipe" });
  return { md: sha256(mdPath), json: sha256(jsonPath) };
}

const run1 = runOnce();
const run2 = runOnce();
const identical = run1.md === run2.md && run1.json === run2.json;
if (!identical) {
  console.error("determinism FAILED");
  console.error("run1", JSON.stringify(run1));
  console.error("run2", JSON.stringify(run2));
  process.exit(1);
}

const evidence = {
  fixture_set: fixtures.fixture_set,
  policy_version: fixtures.policy_version_expected,
  policy_file_sha256: sha256(path.join(root, "rules/ai-content-policy.json")),
  fixtures_sha256: sha256(fixturesPath),
  runner_sha256: sha256(runner),
  report_files: { md: `report-samples-${versionSlug}-${reportDate}.md`, json: `report-samples-${versionSlug}-${reportDate}.json` },
  runs: [run1, run2],
  identical: true,
  note:
    "时间戳固定取 fixtures.report_generated_at/report_date（不取系统时钟）、键顺序固定、固定换行；两次连续执行输出字节一致。",
};
writeFileSync(path.join(here, evidenceName), JSON.stringify(evidence, null, 2) + "\n");

console.log("determinism OK: 两次连跑输出一致");
console.log(`  md   = ${run1.md}`);
console.log(`  json = ${run1.json}`);
console.log(`  evidence -> ${evidenceName}`);
