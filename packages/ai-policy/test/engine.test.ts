import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AiPolicyConfigError,
  canonicalJson,
  filterCompliance,
  hashCanonicalJson,
  parseAiContentPolicy,
  runAiPolicy,
  validateStructure,
  type AiContentPolicy,
  type Claim,
  type EvidenceItem,
} from "../src/index.js";

const policyPath = new URL("../../../rules/ai-content-policy.json", import.meta.url);
const policy = parseAiContentPolicy(JSON.parse(readFileSync(policyPath, "utf8")));

const evidence = (text: string, id = "e1", numbers?: number[]): EvidenceItem => ({
  id,
  text,
  ...(numbers === undefined ? {} : { numbers }),
});

const claim = (text: string, cls: Claim["class"] = "metrics", ids = ["e1"]): Claim => ({
  text,
  evidence_ids: ids,
  class: cls,
});

// 除专门的 F3 缺省 audience 用例外，测试统一显式传 c_end。
const run = (input: Parameters<typeof runAiPolicy>[0]) => runAiPolicy({ audience: "c_end", ...input });

test("策略文件：1.1.2 / 12 类 / 2 个允许前缀 / c_end 已签、internal 待 owner", () => {
  assert.equal(policy.policy_version, "ai-content-policy/1.1.2");
  assert.equal(policy.categories.length, 12);
  assert.deepEqual(policy.allowed_conclusion_prefixes, ["数据显示", "历史统计上"]);
  assert.equal(policy.authority.h3_policy_version_signature.status, "signed");
  assert.equal(policy.authority.h3_policy_version_signature.signed_by, "H3");
  assert.equal(policy.authority.h3_policy_version_signature.content_sha256_at_signoff, "aae8032a1423566d7d3f0355326a891ee88d8236959ebe5605557da57291a2bd");
  assert.ok(policy.authority.h3_policy_version_signature.sign_at);
  assert.equal(policy.authority.owner_policy_version_signature.status, "pending");
  assert.equal(policy.authority.owner_policy_version_signature.ref, "m06899");
  assert.equal(policy.basis_scope.applies_to, "c_end");
  assert.equal(policy.basis_scope.internal_basis, "owner decision 2026-11-06 (m06899)");
  assert.deepEqual(policy.scope.content_whitelist.audiences.internal, [
    "objective_fields",
    "metrics",
    "quantiles",
    "statistics",
    "historical_facts",
    "timestamps",
    "data_gaps",
  ]);
  assert.equal(policy.scope.content_whitelist.audiences.c_end.includes("data_gaps"), false);
  assert.deepEqual(policy.scope.rewrite_rules.skip_p6_classes, ["data_gaps"]);
});

test("parseAiContentPolicy fail-closed：结构/正则/枚举/白名单错误必须抛错", () => {
  const raw = JSON.parse(readFileSync(policyPath, "utf8"));
  const cases: Array<[string, (draft: any) => void]> = [
    ["schema_version", (draft) => { draft.schema_version = 2; }],
    ["categories 为空", (draft) => { draft.categories = []; }],
    ["category 重复", (draft) => { draft.categories = [draft.categories[0], draft.categories[0]]; }],
    ["非法正则", (draft) => { draft.categories[0].patterns = ["("]; }],
    ["非法 action", (draft) => { draft.categories[0].default_action = "warn"; }],
    ["非法 audience", (draft) => { draft.scope.audiences = ["public"]; }],
    ["非法 class", (draft) => {
      draft.scope.content_whitelist.audiences.c_end = ["objective_fields", "not_a_class"];
    }],
    ["白名单缺 audience", (draft) => { delete draft.scope.content_whitelist.audiences.c_end; }],
    ["前缀缺证据类型", (draft) => {
      draft.scope.rewrite_rules.prefix_evidence_match = { "数据显示": "numeric" };
    }],
    ["非法证据类型", (draft) => {
      draft.scope.rewrite_rules.prefix_evidence_match["数据显示"] = "vibes";
    }],
    ["非法 decision_mapping", (draft) => {
      draft.decision_mapping.redact = "maybe";
    }],
  ];
  for (const [name, mutate] of cases) {
    const draft = JSON.parse(JSON.stringify(raw));
    mutate(draft);
    assert.throws(
      () => parseAiContentPolicy(draft),
      (error: unknown) => error instanceof AiPolicyConfigError,
      name,
    );
  }
});

test("H3 S4 / m01502 F5：生产环境未签字、pin 缺失、sha/版本不一致均拒绝加载", () => {
  const rawBytes = readFileSync(policyPath, "utf8");
  const raw = JSON.parse(rawBytes);
  const sourceSha256 = createHash("sha256").update(rawBytes, "utf8").digest("hex");
  const previousNodeEnv = process.env["NODE_ENV"];
  const previousProfile = process.env["APP_PROFILE"];
  const previousVersion = process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"];
  const previousSha = process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"];
  const restore = (): void => {
    if (previousNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = previousNodeEnv;
    if (previousProfile === undefined) delete process.env["APP_PROFILE"];
    else process.env["APP_PROFILE"] = previousProfile;
    if (previousVersion === undefined) delete process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"];
    else process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"] = previousVersion;
    if (previousSha === undefined) delete process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"];
    else process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"] = previousSha;
  };
  try {
    process.env["NODE_ENV"] = "production";
    delete process.env["APP_PROFILE"];
    delete process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"];
    delete process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"];
    // 未签字副本：即使 pin 全给也拒绝。
    const unsigned = JSON.parse(JSON.stringify(raw));
    unsigned.authority.h3_policy_version_signature.status = "pending";
    assert.throws(
      () => parseAiContentPolicy(unsigned, { sourceSha256 }),
      (error: unknown) =>
        error instanceof AiPolicyConfigError && error.code === "policy_not_signed_for_production",
    );

    const signed = JSON.parse(JSON.stringify(raw));
    signed.authority.h3_policy_version_signature.status = "signed";
    signed.authority.h3_policy_version_signature.content_sha256_at_signoff = "f".repeat(64);
    signed.authority.h3_policy_version_signature.sign_at = "2026-11-06T00:00:00Z";
    signed.authority.owner_policy_version_signature.status = "signed";
    signed.authority.owner_policy_version_signature.signed_at = "2026-11-06T00:00:00Z";
    process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"] = "ai-content-policy/1.1.2";
    process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"] = sourceSha256;
    assert.equal(
      parseAiContentPolicy(signed, { sourceSha256 }).policy_version,
      "ai-content-policy/1.1.2",
    );

    // 分区签发：H3 已签但 owner 未签 internal → 生产拒绝。
    const ownerPending = JSON.parse(JSON.stringify(signed));
    ownerPending.authority.owner_policy_version_signature.status = "pending";
    assert.throws(
      () => parseAiContentPolicy(ownerPending, { sourceSha256 }),
      (error: unknown) =>
        error instanceof AiPolicyConfigError && error.code === "policy_not_signed_for_production",
    );
    // 缺 owner 分区 → fail-closed。
    const noOwner = JSON.parse(JSON.stringify(signed));
    delete noOwner.authority.owner_policy_version_signature;
    assert.throws(
      () => parseAiContentPolicy(noOwner, { sourceSha256 }),
      (error: unknown) => error instanceof AiPolicyConfigError,
    );

    // 只翻 status 不填绑定字段 → signature_incomplete。
    const noSha = JSON.parse(JSON.stringify(signed));
    noSha.authority.h3_policy_version_signature.content_sha256_at_signoff = null;
    assert.throws(
      () => parseAiContentPolicy(noSha, { sourceSha256 }),
      (error: unknown) => error instanceof AiPolicyConfigError && error.code === "signature_incomplete",
    );
    const noSignAt = JSON.parse(JSON.stringify(signed));
    noSignAt.authority.h3_policy_version_signature.sign_at = null;
    assert.throws(
      () => parseAiContentPolicy(noSignAt, { sourceSha256 }),
      (error: unknown) => error instanceof AiPolicyConfigError && error.code === "signature_incomplete",
    );
    const wrongSigner = JSON.parse(JSON.stringify(signed));
    wrongSigner.authority.h3_policy_version_signature.signed_by = "owner";
    assert.throws(
      () => parseAiContentPolicy(wrongSigner, { sourceSha256 }),
      (error: unknown) => error instanceof AiPolicyConfigError && error.code === "signature_incomplete",
    );
    const ownerNoSignAt = JSON.parse(JSON.stringify(signed));
    ownerNoSignAt.authority.owner_policy_version_signature.signed_at = null;
    assert.throws(
      () => parseAiContentPolicy(ownerNoSignAt, { sourceSha256 }),
      (error: unknown) => error instanceof AiPolicyConfigError && error.code === "signature_incomplete",
    );

    // 缺任一 pin：拒绝。
    delete process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"];
    assert.throws(
      () => parseAiContentPolicy(signed, { sourceSha256 }),
      (error: unknown) => error instanceof AiPolicyConfigError && error.code === "policy_pin_missing",
    );
    process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"] = sourceSha256;
    delete process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"];
    assert.throws(
      () => parseAiContentPolicy(signed, { sourceSha256 }),
      (error: unknown) => error instanceof AiPolicyConfigError && error.code === "policy_pin_missing",
    );

    // sha 不一致：拒绝。
    process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"] = "ai-content-policy/1.1.2";
    process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"] = "0".repeat(64);
    assert.throws(
      () => parseAiContentPolicy(signed, { sourceSha256 }),
      (error: unknown) =>
        error instanceof AiPolicyConfigError && error.code === "policy_sha256_mismatch",
    );

    // 版本不一致：拒绝。
    process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"] = sourceSha256;
    process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"] = "ai-content-policy/1.0.0";
    assert.throws(
      () => parseAiContentPolicy(signed, { sourceSha256 }),
      (error: unknown) =>
        error instanceof AiPolicyConfigError && error.code === "policy_version_mismatch",
    );
  } finally {
    restore();
  }
});

test("P5 表驱动：12 类禁用表达全部 blocked 且 reason_code 命中", () => {
  const cases: Array<[string, string, string, string]> = [
    ["investment_advice", "建议买入贵州茅台", "贵州茅台 2025 年营收 1700 亿元", "investment_advice"],
    ["directional_conclusion", "后市将上涨", "指数当前 3200 点", "directional_conclusion"],
    ["rating", "维持买入评级", "评级历史待核", "rating"],
    ["target_price", "目标价 2000 元", "现价 1800 元", "target_price"],
    ["market_timing", "现在买入", "指数 3200 点", "market_timing"],
    ["position_advice", "建议仓位五成", "账户净资产 100 万元", "position_advice"],
    ["selection_solicitation", "重点关注贵州茅台", "贵州茅台 2025 年营收 1700 亿元", "selection_solicitation"],
    ["future_prediction", "预计明年上涨", "指数当前 3200 点", "future_prediction"],
    ["suitability_advice", "适合稳健型投资者", "产品风险等级 R2", "suitability_advice"],
    ["nonpublic_information", "内部消息称将重组", "公司公告待核", "nonpublic_information"],
    ["causal_attribution", "资金流入导致股价上涨", "主力净流入 3 亿元", "causal_attribution"],
    ["guarantee", "保证收益 20%", "历史年化 20%", "guarantee"],
  ];
  for (const [name, text, evidenceText, reasonCode] of cases) {
    const result = run({
      policy,
      draft: { claims: [claim(text)] },
      evidence: [evidence(evidenceText)],
    });
    assert.equal(result.decision, "blocked", `${name} 应 blocked`);
    assert.ok(result.reason_codes.includes(reasonCode), `${name} 应含 ${reasonCode}`);
    assert.equal(result.claims[0]?.action, "block", `${name} claim action 应为 block`);
  }
});

test("P5 新增词表：定投/低吸/追涨/分批/网格 也命中", () => {
  const texts = ["建议定投", "低吸机会", "可以追涨", "分批建仓", "网格交易策略"];
  for (const text of texts) {
    const result = run({
      policy,
      draft: { claims: [claim(text)] },
      evidence: [evidence(text)],
    });
    assert.equal(result.decision, "blocked", `${text} 应 blocked`);
  }
});

test("S1：Claim.class 必填且按 audience 白名单校验；C 端 data_gaps 被拒", () => {
  const missingClass = run({
    policy,
    draft: { claims: [{ text: "营收 10 亿元", evidence_ids: ["e1"] } as never] },
    evidence: [evidence("营收 10 亿元")],
  });
  assert.equal(missingClass.decision, "blocked");
  assert.ok(missingClass.reason_codes.includes("class_missing"));

  const unknownClass = run({
    policy,
    draft: { claims: [claim("营收 10 亿元", "not_a_class" as never)] },
    evidence: [evidence("营收 10 亿元")],
  });
  assert.equal(unknownClass.decision, "blocked");
  assert.ok(unknownClass.reason_codes.includes("class_not_allowed"));

  const cEndGap = run({
    policy,
    draft: { claims: [claim("北向资金数据缺失", "data_gaps")] },
    evidence: [evidence("北向资金数据缺失")],
    audience: "c_end",
  });
  assert.equal(cEndGap.decision, "blocked");
  assert.ok(cEndGap.reason_codes.includes("class_not_allowed"));

  const internalGap = run({
    policy,
    draft: { claims: [claim("北向资金数据缺失", "data_gaps")] },
    evidence: [evidence("北向资金数据缺失")],
    audience: "internal",
  });
  assert.equal(internalGap.decision, "passed");
  assert.equal(internalGap.claims[0]?.action, "caveat");
});

test("P6 改写：数字证据补「数据显示，」；历史统计证据补「历史统计上，」", () => {
  const numericEvidence = run({
    policy,
    draft: { claims: [claim("2025 年营收 12.3%")] },
    evidence: [evidence("2025 年营收 12.3%")],
  });
  assert.equal(numericEvidence.decision, "passed");
  assert.equal(numericEvidence.claims[0]?.action, "redact");
  assert.ok(numericEvidence.claims[0]?.text.startsWith("数据显示，"));

  const historical = run({
    policy,
    draft: { claims: [claim("近五年营收均值持续抬升")] },
    evidence: [evidence("近五年营收均值：历史统计口径")],
  });
  assert.equal(historical.decision, "passed");
  assert.equal(historical.claims[0]?.action, "redact");
  assert.ok(historical.claims[0]?.text.startsWith("历史统计上，"));

  const prefixed = run({
    policy,
    draft: { claims: [claim("数据显示，2025 年营收 12.3%")] },
    evidence: [evidence("2025 年营收 12.3%")],
  });
  assert.equal(prefixed.decision, "passed");
  assert.equal(prefixed.claims[0]?.action, "allow");
});

test("S2：无证据或证据类型不匹配时禁止补出处，直接 block", () => {
  const noEvidence = run({
    policy,
    draft: { claims: [claim("经营质量优秀")] },
    evidence: [evidence("公司公告")],
  });
  assert.equal(noEvidence.decision, "blocked");
  assert.ok(noEvidence.reason_codes.includes("conclusion_unqualified"));

  // 证据既无数字也无历史统计口径：不能贴「数据显示」或「历史统计上」。
  const unmatched = run({
    policy,
    draft: { claims: [claim("公司经营稳健")] },
    evidence: [evidence("公司公告")],
  });
  assert.equal(unmatched.decision, "blocked");
  assert.ok(unmatched.reason_codes.includes("conclusion_unqualified"));
});

test("S3：decision_mapping 被实际消费；未知 action 无法映射则抛错", () => {
  const blocked = run({
    policy,
    draft: { claims: [claim("目标价 30 元")] },
    evidence: [evidence("目标价 30 元")],
  });
  assert.equal(blocked.decision, "blocked");

  // 映射被真正消费：block→passed 时决策随映射变为 passed。
  const remapped: AiContentPolicy = {
    ...policy,
    decision_mapping: { ...policy.decision_mapping, block: "passed" },
  };
  const remappedResult = run({
    policy: remapped,
    draft: { claims: [claim("目标价 30 元")] },
    evidence: [evidence("目标价 30 元")],
  });
  assert.equal(remappedResult.decision, "passed");

  // 缺失 action 映射 → 运行时抛错（fail-closed，不允许默认放行）。
  const missing: AiContentPolicy = {
    ...policy,
    decision_mapping: { ...policy.decision_mapping },
  };
  delete (missing.decision_mapping as Partial<Record<string, string>>)["block"];
  assert.throws(
    () => run({ policy: missing, draft: { claims: [claim("目标价 30 元")] }, evidence: [evidence("目标价 30 元")] }),
    (error: unknown) => error instanceof AiPolicyConfigError,
  );
});

test("P2 结构：畸形输入 blocked，不进入部分判定", () => {
  const result = run({
    policy,
    draft: { claims: [] },
    evidence: [],
  });
  assert.equal(result.decision, "blocked");
  assert.ok(result.reason_codes.includes("structure_invalid"));
  assert.equal(result.claims.length, 0);

  const violations = validateStructure(
    { claims: [{ text: "", evidence_ids: [] } as never] },
    [],
  );
  assert.ok(violations.some((violation) => violation.code === "structure_invalid"));
});

test("P3 证据绑定：未知 evidence_id blocked", () => {
  const result = run({
    policy,
    draft: {
      claims: [{ text: "数据显示，营收 10 亿元", evidence_ids: ["missing"], class: "metrics" }],
    },
    evidence: [evidence("营收 10 亿元")],
  });
  assert.equal(result.decision, "blocked");
  assert.ok(result.reason_codes.includes("evidence_binding_failed"));
});

test("P4 数值一致：证据里没有的数字 blocked", () => {
  const result = run({
    policy,
    draft: { claims: [claim("数据显示，营收 99 亿元")] },
    evidence: [evidence("营收 10 亿元")],
  });
  assert.equal(result.decision, "blocked");
  assert.ok(result.reason_codes.includes("numeric_mismatch"));
});

test("caveat：内部 data_gap 显式，不改变 passed", () => {
  const result = run({
    policy,
    draft: { claims: [claim("北向资金数据缺失", "data_gaps")] },
    evidence: [evidence("北向资金数据缺失")],
    audience: "internal",
  });
  assert.equal(result.decision, "passed");
  assert.equal(result.claims[0]?.action, "caveat");
  assert.deepEqual(result.caveats, ["data_gap"]);
});

test("H3 causal caveat-first：data_gap 语境下「由于」不判归因；无缺口仍 block", () => {
  const gapContext = run({
    policy,
    draft: { claims: [claim("由于停牌无成交，数据缺失", "data_gaps")] },
    evidence: [evidence("停牌期间无成交，数据缺失")],
    audience: "internal",
  });
  assert.equal(gapContext.decision, "passed");
  assert.equal(gapContext.claims[0]?.action, "caveat");

  const causal = run({
    policy,
    draft: { claims: [claim("资金流入导致股价上涨")] },
    evidence: [evidence("主力净流入 3 亿元")],
  });
  assert.equal(causal.decision, "blocked");
  assert.ok(causal.reason_codes.includes("causal_attribution"));
});

test("无假阳性：客观资金字段「买入额」不触发投资建议", () => {
  const result = run({
    policy,
    draft: { claims: [claim("2025 年北向资金买入额 300 亿元")] },
    evidence: [evidence("2025 年北向资金买入额 300 亿元")],
  });
  assert.equal(result.decision, "passed");
  assert.equal(result.claims[0]?.action, "redact");
});

test("filterCompliance 直接调用返回类别与依据", () => {
  const violations = filterCompliance("目标价 30 元", 0, policy);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.category, "target_price");
  assert.equal(violations[0]?.code, "target_price");
  assert.equal(violations[0]?.action, "block");
});

test("audience 透传；未声明 audience fail-closed", () => {
  const internal = run({
    policy,
    draft: { claims: [claim("数据显示，营收 10 亿元")] },
    evidence: [evidence("营收 10 亿元")],
    audience: "internal",
  });
  assert.equal(internal.audience, "internal");

  assert.throws(
    () => run({
      policy,
      draft: { claims: [claim("数据显示，营收 10 亿元")] },
      evidence: [evidence("营收 10 亿元")],
      audience: "public" as never,
    }),
    (error: unknown) => error instanceof AiPolicyConfigError,
  );
});

test("H3 m01502 F5：模型生成 section.title 被 P2 拒绝（标题由 copy.ts 常驻）", () => {
  const result = run({
    policy,
    draft: { sections: [{ title: "投资建议", claims: [claim("数据显示，营收 10 亿元")] }] },
    evidence: [evidence("营收 10 亿元")],
    audience: "c_end",
  });
  assert.equal(result.decision, "blocked");
  assert.ok(result.reason_codes.includes("model_generated_title_not_allowed"));
});

test("H3 m01502 F3：audience 缺省必须抛错，不得静默默认 c_end", () => {
  assert.throws(
    () => runAiPolicy({
      policy,
      draft: { claims: [claim("数据显示，营收 10 亿元")] },
      evidence: [evidence("营收 10 亿元")],
    }),
    (error: unknown) => error instanceof AiPolicyConfigError && error.code === "audience_required",
  );
});

test("H3 m01502 F4：ISO 日期不被 P4 拆成负数 token；证据外数字仍 block", () => {
  const timestampPass = run({
    policy,
    draft: { claims: [claim("数据显示，数据截至 2026-11-05。", "timestamps")] },
    evidence: [evidence("数据截至 2026-11-05")],
    audience: "c_end",
  });
  assert.equal(timestampPass.decision, "passed");

  const numberBlocked = run({
    policy,
    draft: { claims: [claim("数据显示，营收 999 亿元")] },
    evidence: [evidence("营收 10 亿元")],
    audience: "c_end",
  });
  assert.equal(numberBlocked.decision, "blocked");
  assert.ok(numberBlocked.reason_codes.includes("numeric_mismatch"));
});

test("sections 形态与扁平 claims 等价；重复 evidence id 结构违规", () => {
  const sections = run({
    policy,
    draft: {
      sections: [{ claims: [claim("数据显示，营收 10 亿元")] }],
    },
    evidence: [evidence("营收 10 亿元")],
  });
  assert.equal(sections.decision, "passed");

  const duplicateEvidence = run({
    policy,
    draft: { claims: [claim("数据显示，营收 10 亿元")] },
    evidence: [evidence("营收 10 亿元"), evidence("营收 10 亿元")],
  });
  assert.equal(duplicateEvidence.decision, "blocked");
  assert.ok(duplicateEvidence.reason_codes.includes("structure_invalid"));
});

test("策略对象不可变：filterCompliance 多次调用结果稳定", () => {
  const first = filterCompliance("建议买入", 0, policy);
  const second = filterCompliance("建议买入", 1, policy);
  assert.equal(first[0]?.category, second[0]?.category);
});

test("policy_version 透传到结果，供审计事件记录", () => {
  const result = run({
    policy,
    draft: { claims: [claim("数据显示，营收 10 亿元")] },
    evidence: [evidence("营收 10 亿元")],
  });
  assert.equal(result.policy_version, policy.policy_version);
});

test("canonicalJson：递归键序、数组保序、UTF-8 与 sha256 稳定", () => {
  const value = {
    b: [3, { z: "中", a: null }],
    a: { d: 1, c: true },
  };
  const text = canonicalJson(value);
  assert.equal(text, '{"a":{"c":true,"d":1},"b":[3,{"a":null,"z":"中"}]}');
  assert.notEqual(text, JSON.stringify(value)); // 原始对象键序不同，证明排序生效
  assert.equal(canonicalJson({ x: 1 }), '{"x":1}');
  const digest = createHash("sha256").update('{"x":1}', "utf8").digest("hex");
  assert.equal(hashCanonicalJson({ x: 1 }), digest);
});

test("审计 canonical hash helper：输入证据按 id 排序；输出 claims 保持顺序", async () => {
  const { computeInputEvidenceHash, computeOutputHash } = await import("../src/index.js");
  const h1 = computeInputEvidenceHash({
    kind: "stock_interpretation",
    audience: "c_end",
    asOf: "2026-11-06T00:00:00.000Z",
    evidence: [
      { id: "e2", text: "营收 10 亿元", numbers: [10] },
      { id: "e1", text: "净利 1 亿元" },
    ],
  });
  const h2 = computeInputEvidenceHash({
    kind: "stock_interpretation",
    audience: "c_end",
    asOf: "2026-11-06T00:00:00.000Z",
    evidence: [
      { id: "e1", text: "净利 1 亿元" },
      { id: "e2", text: "营收 10 亿元", numbers: [10] },
    ],
  });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  const h3 = computeInputEvidenceHash({
    kind: "stock_interpretation",
    audience: "c_end",
    asOf: "2026-11-06T00:00:00.000Z",
    evidence: [{ id: "e1", text: "净利 1 亿元" }],
  });
  assert.notEqual(h1, h3);

  const out = computeOutputHash([
    { text: "数据显示，营收 10 亿元", class: "metrics", evidence_ids: ["e1"] },
  ]);
  assert.match(out, /^[0-9a-f]{64}$/);
  // P2 class_missing：模型未给 class，如实用 null，而不是拿 data_gaps 占位。
  const outMissing = computeOutputHash([{ text: "营收 10 亿元", class: null, evidence_ids: [] }]);
  assert.match(outMissing, /^[0-9a-f]{64}$/);
  assert.notEqual(out, outMissing);
});
