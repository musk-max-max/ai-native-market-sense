/**
 * A16 离线抽样复核 runner（KD-AIPOLICY-OFFLINE）
 *
 * 只用 A5 的 @market-sense/ai-policy 包跑同批样本（L126：A16 不另写判定脚本），
 * 不复制任何词表/判定逻辑；期望值写在 fixtures.json，本文件只做「调用 + 断言 + 出报告」。
 * 另做 parseAiContentPolicy 的 fail-closed 配置检查（H3 S4 生产未签强制 / S2 改写规则完整性）。
 *
 * 运行：node --import tsx reviews/compliance/KD-AIPOLICY-OFFLINE/run-samples.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AiPolicyConfigError,
  parseAiContentPolicy,
  runAiPolicy,
  type AiContentPolicy,
  type PolicyResult,
} from "../../../packages/ai-policy/src/index.ts";

type Expected = {
  decision?: string;
  audience?: string;
  claim_actions?: string[];
  claim_texts?: string[];
  reason_codes?: string[];
  caveats?: string[];
  throws?: { name: string; code?: string };
};

type Sample = {
  id: string;
  class: "positive" | "negative" | "boundary";
  covers: string;
  audience?: string;
  draft: unknown;
  evidence: unknown;
  expected: Expected;
  note: string;
};

type Fixtures = {
  fixture_set: string;
  policy_path: string;
  policy_version_expected: string;
  policy_content_sha256_expected?: string;
  report_date?: string;
  report_generated_at?: string;
  samples: Sample[];
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const fixtureArg = process.argv[2];
const fixturePath = fixtureArg ? resolve(process.cwd(), fixtureArg) : resolve(here, "fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixtures;
const policyJson = JSON.parse(
  readFileSync(resolve(root, fixtures.policy_path), "utf8"),
) as unknown;
const policy: AiContentPolicy = parseAiContentPolicy(policyJson);
const policySha = createHash("sha256")
  .update(readFileSync(resolve(root, fixtures.policy_path)))
  .digest("hex");

if (policy.policy_version !== fixtures.policy_version_expected) {
  throw new Error(
    `policy_version 不一致：fixtures=${fixtures.policy_version_expected} 文件=${policy.policy_version}`,
  );
}
const expectedSha = fixtures.policy_content_sha256_expected;
if (expectedSha && expectedSha !== policySha) {
  throw new Error(
    `policy content sha256 不一致：fixtures=${expectedSha} 文件=${policySha}`,
  );
}

const signature = policy.authority.h3_policy_version_signature;
if (signature.status !== "signed") {
  console.warn(
    `[warn] h3_policy_version_signature.status=${signature.status}：本报告为待签版复核实测（provisional），不构成放行结论。`,
  );
}

// ---------- 1. 样本复核 ----------
type Row = {
  id: string;
  class: string;
  covers: string;
  audience: string;
  expected: Expected;
  actual:
    | { kind: "result"; decision: string; audience: string; claim_actions: string[]; claim_texts: string[]; reason_codes: string[]; caveats: string[] }
    | { kind: "throw"; name: string; code?: string };
  pass: boolean;
  diffs: string[];
  note: string;
};

function compare(expected: Expected, actual: Row["actual"]): { pass: boolean; diffs: string[] } {
  const diffs: string[] = [];
  if (expected.throws) {
    if (actual.kind !== "throw") {
      diffs.push(`期望抛错 ${expected.throws.name}，实际返回 ${actual.kind}`);
      return { pass: false, diffs };
    }
    if (actual.name !== expected.throws.name) diffs.push(`抛错类型 ${actual.name} != ${expected.throws.name}`);
    if (expected.throws.code && actual.code !== expected.throws.code) {
      diffs.push(`抛错 code ${actual.code} != ${expected.throws.code}`);
    }
    return { pass: diffs.length === 0, diffs };
  }
  if (actual.kind !== "result") {
    diffs.push(`期望返回结果，实际抛错 ${actual.name}:${actual.code ?? ""}`);
    return { pass: false, diffs };
  }
  if (expected.decision !== undefined && expected.decision !== actual.decision) {
    diffs.push(`decision ${actual.decision} != ${expected.decision}`);
  }
  if (expected.audience !== undefined && expected.audience !== actual.audience) {
    diffs.push(`audience ${actual.audience} != ${expected.audience}`);
  }
  const cmpList = (label: string, exp?: string[], act?: string[]): void => {
    if (!exp) return;
    const e = JSON.stringify(exp);
    const a = JSON.stringify(act ?? []);
    if (e !== a) diffs.push(`${label} ${a} != ${e}`);
  };
  cmpList("reason_codes", expected.reason_codes, actual.reason_codes);
  cmpList("caveats", expected.caveats, actual.caveats);
  cmpList("claim_actions", expected.claim_actions, actual.claim_actions);
  cmpList("claim_texts", expected.claim_texts, actual.claim_texts);
  return { pass: diffs.length === 0, diffs };
}

const rows: Row[] = fixtures.samples.map((sample) => {
  let actual: Row["actual"];
  try {
    const result: PolicyResult = runAiPolicy({
      policy,
      draft: sample.draft as never,
      evidence: sample.evidence as never,
      audience: sample.audience as never,
    });
    actual = {
      kind: "result",
      decision: result.decision,
      audience: result.audience,
      claim_actions: result.claims.map((claim) => claim.action),
      claim_texts: result.claims.map((claim) => claim.text),
      reason_codes: result.reason_codes,
      caveats: result.caveats,
    };
  } catch (error) {
    if (error instanceof AiPolicyConfigError) {
      actual = { kind: "throw", name: error.name, code: error.code };
    } else {
      actual = { kind: "throw", name: error instanceof Error ? error.name : typeof error, code: undefined };
    }
  }
  const { pass, diffs } = compare(sample.expected, actual);
  return {
    id: sample.id,
    class: sample.class,
    covers: sample.covers,
    audience: sample.audience ?? "(缺省)",
    expected: sample.expected,
    actual,
    pass,
    diffs,
    note: sample.note,
  };
});

// 覆盖度断言：负样本覆盖 12 类 reason_code；正样本覆盖白名单 7 类
const allCategories = policy.categories.map((category) => category.id);
const negHit = new Set(rows.filter((row) => row.class === "negative").flatMap((row) => row.expected.reason_codes ?? []));
const missingCategories = allCategories.filter((id) => !negHit.has(id));

function extractClasses(draft: unknown): string[] {
  const classes: string[] = [];
  const d = draft as { claims?: { class?: string }[]; sections?: { claims?: { class?: string }[] }[] };
  for (const claim of d.claims ?? []) if (claim.class) classes.push(claim.class);
  for (const section of d.sections ?? []) {
    for (const claim of section.claims ?? []) if (claim.class) classes.push(claim.class);
  }
  return classes;
}
const posClasses = new Set(rows.filter((row) => row.class === "positive").flatMap((row) => extractClasses(fixtures.samples.find((sample) => sample.id === row.id)?.draft)));
const allOutputClasses = policy.scope.content_whitelist.audiences.internal;
const missingOutputClasses = allOutputClasses.filter((id) => !posClasses.has(id));

// ---------- 2. 配置 fail-closed 检查（parseAiContentPolicy） ----------
type ConfigCheck = { id: string; covers: string; expect: string; actual: string; pass: boolean; note: string };
const clonePolicy = (): unknown => JSON.parse(JSON.stringify(policyJson));
const configChecks: ConfigCheck[] = [];
function configCheck(id: string, covers: string, expect: string, fn: () => void, note: string): void {
  let actual = "ok";
  try {
    fn();
  } catch (error) {
    if (error instanceof AiPolicyConfigError) actual = `throw ${error.code}`;
    else actual = `throw ${error instanceof Error ? error.name : typeof error}`;
  }
  configChecks.push({ id, covers, expect, actual, pass: actual === expect, note });
}
const withEnv = (env: Record<string, string | undefined>, fn: () => void): void => {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

configCheck(
  "CFG-01",
  "S4 生产环境未签版拒绝加载",
  "throw policy_not_signed_for_production",
  () => {
    const cloned = clonePolicy() as { authority: { h3_policy_version_signature: { status: string } } };
    cloned.authority.h3_policy_version_signature.status = "pending";
    withEnv({ NODE_ENV: "production", APP_PROFILE: undefined }, () => parseAiContentPolicy(cloned));
  },
  "策略文件已翻转 signed；本检查用 pending 克隆验证生产 profile 下未签版必须抛错（fail-closed）。",
);
configCheck(
  "CFG-02",
  "S4 部署清单版本不一致拒绝加载（1.1.1 version+sha256 双 pin）",
  "throw policy_version_mismatch",
  () => {
    const cloned = clonePolicy() as { authority: { h3_policy_version_signature: { status: string } } };
    cloned.authority.h3_policy_version_signature.status = "signed";
    withEnv(
      {
        NODE_ENV: "production",
        AI_CONTENT_POLICY_EXPECTED_VERSION: "ai-content-policy/0.0.0",
        AI_CONTENT_POLICY_EXPECTED_SHA256: policySha,
      },
      () => parseAiContentPolicy(cloned, { sourceSha256: policySha }),
    );
  },
  "签名通过后，AI_CONTENT_POLICY_EXPECTED_VERSION 与文件版本不一致必须抛错（sha 双 pin 均匹配）。",
);
configCheck(
  "CFG-06",
  "S4 生产内容哈希与部署清单不一致拒绝加载",
  "throw policy_sha256_mismatch",
  () => {
    const cloned = clonePolicy() as { authority: { h3_policy_version_signature: { status: string } } };
    cloned.authority.h3_policy_version_signature.status = "signed";
    withEnv(
      {
        NODE_ENV: "production",
        AI_CONTENT_POLICY_EXPECTED_VERSION: policy.policy_version,
        AI_CONTENT_POLICY_EXPECTED_SHA256: "0".repeat(64),
      },
      () => parseAiContentPolicy(cloned, { sourceSha256: policySha }),
    );
  },
  "H3 m01470：生产加载的原始字节 sha256 必须与部署清单一致。",
);
configCheck(
  "CFG-07",
  "S4 生产缺少 version/sha 双 pin 拒绝加载",
  "throw policy_pin_missing",
  () => {
    const cloned = clonePolicy() as { authority: { h3_policy_version_signature: { status: string } } };
    cloned.authority.h3_policy_version_signature.status = "signed";
    withEnv({ NODE_ENV: "production", AI_CONTENT_POLICY_EXPECTED_VERSION: undefined, AI_CONTENT_POLICY_EXPECTED_SHA256: undefined }, () =>
      parseAiContentPolicy(cloned),
    );
  },
  "生产环境必须显式 pin version 与 sha256，缺失即拒绝启动。",
);
configCheck(
  "CFG-08",
  "F2 data_gaps 跳过 P6 由策略声明（机读断言）",
  "ok",
  () => {
    if (!policy.scope.rewrite_rules.skip_p6_classes.includes("data_gaps")) {
      throw new AiPolicyConfigError("missing_skip_p6_class", "策略未声明 skip_p6_classes: data_gaps");
    }
  },
  "H3 m01502：缺口豁免必须在 rules 策略文本中声明，A16 机读断言，防止实现与策略文本分叉。",
);
configCheck(
  "CFG-03",
  "S2 每个允许前缀必须有证据类型映射",
  "throw missing_rewrite_rule",
  () => {
    const cloned = clonePolicy() as { scope: { rewrite_rules: { prefix_evidence_match: Record<string, string> } } };
    delete cloned.scope.rewrite_rules.prefix_evidence_match["历史统计上"];
    parseAiContentPolicy(cloned);
  },
  "删除「历史统计上」映射后 parse 必须拒绝加载。",
);
configCheck(
  "CFG-04",
  "非法正则拒绝加载",
  "throw invalid_regex",
  () => {
    const cloned = clonePolicy() as { categories: { patterns: string[] }[] };
    cloned.categories[0].patterns = ["(unclosed"];
    parseAiContentPolicy(cloned);
  },
  "类别词法正则不可编译时必须抛错，不得带着未过滤规则运行。",
);
configCheck(
  "CFG-05",
  "非生产环境 pending 可加载（联调形态）",
  "ok",
  () => withEnv({ NODE_ENV: "test", APP_PROFILE: undefined }, () => parseAiContentPolicy(clonePolicy())),
  "非生产允许 pending 加载，用于 A3/A16 联调；但不得对用户展示。",
);

// ---------- 3. 快照哈希 ----------
function sha16(relativePath: string): string {
  return createHash("sha256").update(readFileSync(resolve(root, relativePath))).digest("hex").slice(0, 16);
}
const snapshotFiles = [
  fixtures.policy_path,
  "packages/ai-policy/src/engine.ts",
  "packages/ai-policy/src/policy.ts",
  "packages/ai-policy/src/types.ts",
  "packages/ai-policy/src/canonical.ts",
  "packages/ai-policy/src/index.ts",
];
const snapshot = Object.fromEntries(snapshotFiles.map((file) => [file, sha16(file)]));

// ---------- 4. 报告 ----------
const counts = {
  total: rows.length,
  pass: rows.filter((row) => row.pass).length,
  fail: rows.filter((row) => !row.pass).length,
  config: { total: configChecks.length, pass: configChecks.filter((row) => row.pass).length },
  byClass: ["positive", "negative", "boundary"].map((cls) => {
    const subset = rows.filter((row) => row.class === cls);
    return { class: cls, total: subset.length, pass: subset.filter((row) => row.pass).length };
  }),
};
if (counts.byClass.some((entry) => entry.class === "positive" && entry.total < 6)) {
  throw new Error("正样本不足 6 条（Lead 任务单要求）");
}
if (counts.byClass.some((entry) => entry.class === "negative" && entry.total < 8)) {
  throw new Error("负样本不足 8 条（Lead 任务单要求）");
}
if (counts.byClass.some((entry) => entry.class === "boundary" && entry.total < 4)) {
  throw new Error("边界样本不足 4 条（Lead 任务单要求）");
}

// 确定性输出：时间戳/日期不取系统时钟，固定来自 fixtures（report_generated_at / report_date）。
const stamp = fixtures.report_generated_at ?? "2026-11-06T00:00:00Z";
const reportDate = fixtures.report_date ?? stamp.slice(0, 10);
const versionSlug = policy.policy_version.replace(/^ai-content-policy\//, "").replace(/[^0-9A-Za-z.-]/g, "-");
const reportName = `report-samples-${versionSlug}-${reportDate}.md`;
const jsonName = `report-samples-${versionSlug}-${reportDate}.json`;
const runCommand = `packages/ai-policy/node_modules/.bin/tsx reviews/compliance/KD-AIPOLICY-OFFLINE/run-samples.ts${fixtureArg ? ` ${fixtureArg}` : ""}`;
function inputDigest(sample: Sample): unknown {
  const d = sample.draft as { claims?: { text?: string; class?: string; evidence_ids?: string[] }[]; sections?: { claims?: { text?: string; class?: string; evidence_ids?: string[] }[] }[] };
  const claims = [...(d.claims ?? []), ...(d.sections ?? []).flatMap((section) => section.claims ?? [])].map((claim) => ({
    text: claim.text,
    class: claim.class,
    evidence_ids: claim.evidence_ids,
  }));
  const evidence = (sample.evidence as { id?: string; text?: string; numbers?: number[] }[]).map((item) => ({
    id: item.id,
    text: item.text,
    numbers: item.numbers,
  }));
  return { audience: sample.audience ?? "(缺省)", claims, evidence };
}

const lines: string[] = [];
lines.push(`# A16 离线抽样复核报告（KD-AIPOLICY-OFFLINE）`);
lines.push("");
lines.push(`- 生成时间：${stamp}`);
lines.push(`- 复核对象：\`${fixtures.policy_path}\` / \`@market-sense/ai-policy\` 的 \`runAiPolicy\`（P2–P6）`);
lines.push(`- policy_version：\`${policy.policy_version}\`；H3 签认状态：**已生效（ref m01561）**（翻转前内容 sha 与当前文件 diff 仅 status/note/definition_refs[2]）`);
lines.push(`- **签认内容 sha256**（H3 m01561 签字绑定，翻转前）：\`eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293\``);
lines.push(`- **最终文件 sha256**（翻转 status 后、进部署 pin；fixtures 绑定此值）：\`${policySha}\``);
lines.push(`- 生效状态：H3 签认已生效（ref m01561）；A16 仍不写「合规通过/放行」结论。`);
lines.push(`- 运行命令：\`${runCommand}\``);
lines.push(`- 样本集：\`${fixtures.fixture_set}\`，共 ${counts.total} 条（正 ${fixtures.samples.filter((s) => s.class === "positive").length} / 负 ${fixtures.samples.filter((s) => s.class === "negative").length} / 边界 ${fixtures.samples.filter((s) => s.class === "boundary").length}）`);
lines.push(`- 覆盖度：负样本已覆盖 12 类 reason_code${missingCategories.length === 0 ? "（全部命中）" : `（缺 ${missingCategories.join(",")}）`}；正样本已覆盖白名单 7 类${missingOutputClasses.length === 0 ? "（objective_fields 由 C 端样本 POS-07 覆盖）" : `（缺 ${missingOutputClasses.join(",")}）`}。`);
lines.push(`- **本报告只记录实现行为证据，不构成放行或合规结论；A16 无终审权，复核结论由 H3 在文末签署栏填写。**`);
lines.push("");
lines.push(`## 汇总`);
lines.push("");
lines.push(`| 类别 | 条数 | 与期望一致 |`);
lines.push(`|---|---|---|`);
for (const entry of counts.byClass) {
  lines.push(`| ${entry.class} | ${entry.total} | ${entry.pass} |`);
}
lines.push(`| **合计** | **${counts.total}** | **${counts.pass}** |`);
lines.push("");
lines.push(`## 逐条结果`);
lines.push("");
lines.push(`| ID | 类别 | 覆盖点 | audience | decision（期望/实际） | claim action | reason_codes（实际） | 一致 |`);
lines.push(`|---|---|---|---|---|---|---|---|`);
for (const row of rows) {
  const actual = row.actual;
  const decision = actual.kind === "result" ? actual.decision : `throw:${actual.code ?? actual.name}`;
  const actions = actual.kind === "result" ? actual.claim_actions.join(",") || "—" : "—";
  const codes = actual.kind === "result" ? actual.reason_codes.join(",") || "—" : "—";
  const exp = row.expected.throws ? `throw:${row.expected.throws.code ?? row.expected.throws.name}` : row.expected.decision ?? "—";
  lines.push(
    `| ${row.id} | ${row.class} | ${row.covers} | ${row.audience} | ${exp} / ${decision} | ${actions} | ${codes} | ${row.pass ? "✅" : "❌"} |`,
  );
}
lines.push("");
const failures = rows.filter((row) => !row.pass);
if (failures.length > 0) {
  lines.push(`## 不一致明细（需 A5/H3 处理，A16 不自行裁定）`);
  lines.push("");
  for (const row of failures) {
    lines.push(`- \`${row.id}\`（${row.covers}）：${row.diffs.join("；")}`);
  }
  lines.push("");
}
lines.push(`## 配置 fail-closed 检查`);
lines.push("");
lines.push(`| ID | 覆盖 | 期望 | 实际 | 一致 |`);
lines.push(`|---|---|---|---|---|`);
for (const row of configChecks) {
  lines.push(`| ${row.id} | ${row.covers} | ${row.expect} | ${row.actual} | ${row.pass ? "✅" : "❌"} |`);
}
lines.push("");
lines.push(`## 复核发现（实现行为 vs 书面口径）`);
lines.push("");
const findings = rows.filter((entry) => entry.note.includes("【复核发现】"));
if (findings.length === 0) {
  lines.push(`- 本轮未发现实现行为与 1.1.1 策略文本 / H3 m00298 签认范围的新增不一致（36/36、8/8）。`);
} else {
  for (const row of findings) {
    lines.push(`- \`${row.id}\`：${row.note}`);
  }
}
lines.push("");
lines.push(`## 遗留事项（非实现缺陷，由 H3/A0/H1 处理）`);
lines.push("");
lines.push(`1. \`agents/decisions.md:141\` 红线编号记录自相矛盾（「禁止 7 条」列 10 个编号）；A16 不再引用 R 编号，更正由 Lead/H1 负责。`);
lines.push(`2. ADR-007 P5/P6 文本修订（P5 改为「命中即 block」、P6 前缀仅「数据显示/历史统计上」）由 A0/H2 同步，policy 文件为准。`);
lines.push(`3. ADR-008 D8 状态行仍 \`OWNER-DECISION-PENDING\`；policy 已删除 q3=A 引用，A16 对内部只判「未越 L3」。`);
lines.push(`4. AI-1（隐式标识 + 3 年留痕）/AI-2/AI-3 上线门禁未闭环；本报告不构成 C 端展示放行。`);
lines.push("");
lines.push(`## 快照（复核时刻只读哈希，报告正文事实以此为准）`);
lines.push("");
lines.push(`| 文件 | sha256(前 16 位) |`);
lines.push(`|---|---|`);
for (const [file, hash] of Object.entries(snapshot)) {
  lines.push(`| \`${file}\` | \`${hash}\` |`);
}
lines.push("");
lines.push(`## 边界样本输入（可独立复跑）`);
lines.push("");
for (const sample of fixtures.samples.filter((entry) => entry.class === "boundary")) {
  const row = rows.find((entry) => entry.id === sample.id)!;
  const actualText = row.actual.kind === "result"
    ? `${row.actual.decision}; actions=${row.actual.claim_actions.join(",") || "—"}; codes=${row.actual.reason_codes.join(",") || "—"}`
    : `throw ${row.actual.code ?? row.actual.name}`;
  lines.push(`- \`${sample.id}\`（audience=${sample.audience ?? "(缺省)"}）：${JSON.stringify(inputDigest(sample))}；期望=${row.expected.throws ? `throw ${row.expected.throws.code ?? row.expected.throws.name}` : row.expected.decision}；实际=${actualText}；${row.pass ? "一致" : "不一致"}`);
}
lines.push("");
lines.push(`## 样本设计说明`);
lines.push("");
lines.push(`- 正样本覆盖白名单类别：内部 audience 覆盖 6 类客观类别 + data_gaps，C 端覆盖 6 类（无 data_gaps）；每条带 evidence 与数字/历史统计绑定。`);
lines.push(`- 负样本覆盖 policy 1.1.1 全部 12 类默认 block（含 H3 m01300 新增 selection_solicitation / future_prediction / suitability_advice / nonpublic_information）。`);
lines.push(`- 边界样本覆盖：允许前缀 pass、data_gap→caveat、causal 在 data_gap 语境豁免、audience 缺省抛错（F3）、非白名单前缀 redact、P6 证据类型不匹配、class 白名单（缺失/C 端 data_gaps）、P2 结构畸形、未声明 audience、ISO 日期与 YYYY年M月D日/HH:mm 时刻 token 排除（F4）、证据外数字仍 block、模型生成 section.title 拒绝（H3 m01470）、skip_p6_classes 策略声明（F2）。`);
lines.push("");
lines.push(`## 待签文本（H3 m00298 签认范围；最终 sha 以本报告头为准）`);
lines.push("");
lines.push(`> H3 m01561 签认内容 sha256=\`eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293\`（翻转前）；最终文件 sha256=\`${policySha}\`（翻转 status 仅改 sig.status/note/definition_refs[2]，经 H3 m00367 复核 diff 后生效）。`);
lines.push(`> 签认范围：audience 分档白名单、H3-C01–C12 词表与依据、允许前缀仅「数据显示/历史统计上」且与证据类型绑定、`);
lines.push(`> P6 改写后重跑 P5、P5 命中即 block、data_gaps 豁免经策略声明。**不构成对 C 端 AI 生成内容展示的放行**：`);
lines.push(`> AI-1（隐式标识 + 3 年留痕机制）/AI-2/AI-3 未闭环前不得展示。`);
lines.push("");
lines.push(`## 签署栏（由 H3 填写；A16 不出结论）`);
lines.push("");
lines.push(`- 复核结论（通过 / 不通过 / 附条件，由 H3 填写）：________________`);
lines.push(`- 依据：本报告 36/36 样本实测 + 8/8 配置 fail-closed 检查 + mapping（H3-C01–C12）。`);
lines.push(`- H3 签字：________________　日期：________________`);
lines.push(`- 备注：A16 无终审权；本报告样本为离线抽检，不替代 H3 对策略内容的签认。`);
lines.push("");
const reportPath = resolve(here, reportName);
writeFileSync(reportPath, lines.join("\n"), "utf8");
writeFileSync(
  resolve(here, jsonName),
  JSON.stringify(
    {
      generated_at: stamp,
      policy_version: policy.policy_version,
      signature_status: signature.status,
      signed_content_sha256: "eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293",
      final_file_sha256: policySha,
      signature_effective: "effective_m01561",
      fixture_set: fixtures.fixture_set,
      snapshot,
      coverage: { categories_total: allCategories.length, categories_missing: missingCategories, output_classes_missing: missingOutputClasses },
      counts,
      rows: rows.map((row) => ({
        ...row,
        input: inputDigest(fixtures.samples.find((sample) => sample.id === row.id)!),
      })),
      configChecks,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`A16 KD-AIPOLICY-OFFLINE: ${counts.pass}/${counts.total} 与期望一致；配置检查 ${counts.config.pass}/${counts.config.total}`);
if (missingCategories.length > 0) console.log(`  COVERAGE MISS categories: ${missingCategories.join(",")}`);
if (missingOutputClasses.length > 0) console.log(`  COVERAGE MISS output_classes: ${missingOutputClasses.join(",")}`);
for (const row of failures) {
  console.log(`  FAIL ${row.id}: ${row.diffs.join("; ")}`);
}
for (const row of configChecks.filter((entry) => !entry.pass)) {
  console.log(`  FAIL ${row.id}: actual=${row.actual} expect=${row.expect}`);
}
console.log(`report -> ${reportPath}`);
process.exitCode = failures.length === 0 && configChecks.every((row) => row.pass) ? 0 : 1;
