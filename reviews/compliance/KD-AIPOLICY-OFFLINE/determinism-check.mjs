// A16 确定性复跑校验：连跑两次 run-samples.ts，断言两次输出 sha256 逐字节一致。
// 用法（仓库根）：node reviews/compliance/KD-AIPOLICY-OFFLINE/determinism-check.mjs
// 证据写入同目录 determinism-evidence.json（内容本身也是确定性的：无时间戳）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const tsx = path.join(root, "packages/ai-policy/node_modules/.bin/tsx");
const runner = path.join(here, "run-samples.ts");
const mdPath = path.join(here, "report-samples-1.1.1-2026-11-06.md");
const jsonPath = path.join(here, "report-samples-1.1.1-2026-11-06.json");

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runOnce() {
  execFileSync(tsx, [runner], { cwd: root, stdio: "pipe" });
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
  runner_sha256: sha256(runner),
  fixtures_sha256: sha256(path.join(here, "fixtures.json")),
  policy_file_sha256: sha256(path.join(root, "rules/ai-content-policy.json")),
  runs: [run1, run2],
  identical: true,
  note:
    "时间戳固定取 fixtures.report_generated_at/report_date（不取系统时钟）、键顺序固定、固定换行；两次连续执行输出字节一致。",
};
writeFileSync(
  path.join(here, "determinism-evidence.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);

console.log("determinism OK: 两次连跑输出一致");
console.log(`  md   = ${run1.md}`);
console.log(`  json = ${run1.json}`);
console.log(`  evidence -> determinism-evidence.json`);
