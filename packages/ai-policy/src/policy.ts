import {
  OUTPUT_CLASSES,
  type Action,
  type AiContentPolicy,
  type Audience,
  type EvidenceKind,
  type OutputClass,
  type PolicyCaveatRule,
  type PolicyCategory,
  type PolicyRewriteRules,
  AiPolicyConfigError,
} from "./types.js";

interface CompiledCategory {
  category: PolicyCategory;
  regexes: RegExp[];
}

interface CompiledCaveat {
  rule: PolicyCaveatRule;
  regex: RegExp;
}

export interface CompiledAiContentPolicy {
  policy: AiContentPolicy;
  categories: CompiledCategory[];
  caveats: CompiledCaveat[];
}

const ACTIONS: readonly Action[] = ["allow", "block", "redact", "caveat"];
const AUDIENCES: readonly Audience[] = ["c_end", "internal"];
const EVIDENCE_KINDS: readonly EvidenceKind[] = ["numeric", "historical_statistical"];

const compiledCache = new WeakMap<AiContentPolicy, CompiledAiContentPolicy>();

function fail(code: string, message: string): never {
  throw new AiPolicyConfigError(code, `ai-content-policy 校验失败：${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid_type", `${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("invalid_type", `${path} 必须是非空字符串或 null`);
  }
  return value;
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_type", `${path} 必须是非空字符串`);
  }
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("invalid_type", `${path} 必须是非空字符串数组`);
  }
  return value.map((item, index) => asNonEmptyString(item, `${path}[${index}]`));
}

function asAction(value: unknown, path: string): Action {
  if (typeof value !== "string" || !ACTIONS.includes(value as Action)) {
    fail("invalid_action", `${path} 必须是 ${ACTIONS.join("|")}`);
  }
  return value as Action;
}

function asOutputClass(value: unknown, path: string): OutputClass {
  if (typeof value !== "string" || !(OUTPUT_CLASSES as readonly string[]).includes(value)) {
    fail("invalid_output_class", `${path} 必须是 ${OUTPUT_CLASSES.join("|")}`);
  }
  return value as OutputClass;
}

function compileRegex(pattern: string, path: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("invalid_regex", `${path} 不是合法正则：${detail}`);
  }
}

function parseCategory(value: unknown, index: number): PolicyCategory {
  const path = `categories[${index}]`;
  const raw = asRecord(value, path);
  return {
    id: asNonEmptyString(raw["id"], `${path}.id`),
    reason_code: asNonEmptyString(raw["reason_code"], `${path}.reason_code`),
    default_action: asAction(raw["default_action"], `${path}.default_action`),
    basis: asNonEmptyString(raw["basis"], `${path}.basis`),
    patterns: asStringArray(raw["patterns"], `${path}.patterns`),
  };
}

function parseCaveatRule(value: unknown, index: number): PolicyCaveatRule {
  const path = `caveat_rules[${index}]`;
  const raw = asRecord(value, path);
  return {
    id: asNonEmptyString(raw["id"], `${path}.id`),
    caveat_code: asNonEmptyString(raw["caveat_code"], `${path}.caveat_code`),
    trigger: asNonEmptyString(raw["trigger"], `${path}.trigger`),
    basis: asNonEmptyString(raw["basis"], `${path}.basis`),
  };
}

function parseRewriteRules(value: unknown, prefixes: string[]): PolicyRewriteRules {
  const raw = asRecord(value, "scope.rewrite_rules");
  if (typeof raw["require_evidence"] !== "boolean") {
    fail("invalid_type", "scope.rewrite_rules.require_evidence 必须是布尔");
  }
  const mapRaw = asRecord(
    raw["prefix_evidence_match"],
    "scope.rewrite_rules.prefix_evidence_match",
  );
  const mapEntries = Object.entries(mapRaw);
  if (mapEntries.length === 0) {
    fail("invalid_type", "scope.rewrite_rules.prefix_evidence_match 不能为空");
  }
  const prefixEvidenceMatch: Record<string, EvidenceKind> = {};
  for (const [prefix, kind] of mapEntries) {
    if (!prefixes.includes(prefix)) {
      fail(
        "invalid_rewrite_prefix",
        `rewrite_rules.prefix_evidence_match 的 ${prefix} 不在 allowed_conclusion_prefixes`,
      );
    }
    if (typeof kind !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      fail(
        "invalid_evidence_kind",
        `rewrite_rules.prefix_evidence_match.${prefix} 必须是 ${EVIDENCE_KINDS.join("|")}`,
      );
    }
    prefixEvidenceMatch[prefix] = kind as EvidenceKind;
  }
  // 每个允许前缀都必须有证据类型约束，防止新增前缀绕过 S2。
  for (const prefix of prefixes) {
    if (prefixEvidenceMatch[prefix] === undefined) {
      fail(
        "missing_rewrite_rule",
        `allowed_conclusion_prefixes 的 ${prefix} 缺 prefix_evidence_match`,
      );
    }
  }
  const skipP6Raw = raw["skip_p6_classes"];
  if (!Array.isArray(skipP6Raw)) {
    fail("invalid_type", "scope.rewrite_rules.skip_p6_classes 必须是数组");
  }
  const skipP6Classes = skipP6Raw.map((value, index) => {
    if (typeof value !== "string" || !(OUTPUT_CLASSES as readonly string[]).includes(value)) {
      fail(
        "invalid_skip_p6_class",
        `scope.rewrite_rules.skip_p6_classes[${index}] 必须是 OutputClass`,
      );
    }
    return value as OutputClass;
  });
  if (new Set(skipP6Classes).size !== skipP6Classes.length) {
    fail("invalid_skip_p6_class", "scope.rewrite_rules.skip_p6_classes 不得重复");
  }
  const historical_pattern = asNonEmptyString(
    raw["historical_statistical_pattern"],
    "scope.rewrite_rules.historical_statistical_pattern",
  );
  compileRegex(historical_pattern, "scope.rewrite_rules.historical_statistical_pattern");
  return {
    require_evidence: raw["require_evidence"],
    prefix_evidence_match: prefixEvidenceMatch,
    skip_p6_classes: skipP6Classes,
    historical_statistical_pattern: historical_pattern,
  };
}

function isProductionEnvironment(): boolean {
  return (
    process.env["NODE_ENV"] === "production" || process.env["APP_PROFILE"] === "prod"
  );
}

/**
 * 校验并规范化策略 JSON（不访问文件/网络）。任何结构/正则错误都抛
 * AiPolicyConfigError —— 调用方必须 fail-closed 阻断，不得回退“无过滤”。
 *
 * 生产强制（H3 S4）：生产环境下未签字的策略拒绝加载；如果设置了
 * `AI_CONTENT_POLICY_EXPECTED_VERSION`，policy_version 必须与部署清单一致。
 */
export interface ParseAiContentPolicyOptions {
  /**
   * 策略文件原始字节的 sha256（由 loader 计算）。生产环境必须与
   * AI_CONTENT_POLICY_EXPECTED_SHA256 一致；H3 m01470 签字绑定内容哈希。
   */
  sourceSha256?: string;
}

export function parseAiContentPolicy(
  raw: unknown,
  options: ParseAiContentPolicyOptions = {},
): AiContentPolicy {
  const root = asRecord(raw, "root");
  if (root["schema_version"] !== 1) {
    fail("unsupported_schema_version", "schema_version 必须为 1");
  }
  const basisScope = asRecord(root["basis_scope"], "basis_scope");
  const basisScopeAppliesTo = asNonEmptyString(basisScope["applies_to"], "basis_scope.applies_to");
  const basisScopeInternal = asNonEmptyString(basisScope["internal_basis"], "basis_scope.internal_basis");

  const policyVersion = asNonEmptyString(root["policy_version"], "policy_version");
  const updated = asNonEmptyString(root["updated"], "updated");
  const canonical = asNonEmptyString(
    root["canonical_source_of_truth"],
    "canonical_source_of_truth",
  );
  const authoredBy = asNonEmptyString(root["authored_by"], "authored_by");

  const authority = asRecord(root["authority"], "authority");
  const signature = asRecord(
    authority["h3_policy_version_signature"],
    "authority.h3_policy_version_signature",
  );
  if (typeof signature["required"] !== "boolean") {
    fail("invalid_type", "authority.h3_policy_version_signature.required 必须是布尔");
  }
  const signatureStatus = asNonEmptyString(
    signature["status"],
    "authority.h3_policy_version_signature.status",
  );
  const signatureSignedBy = asNonEmptyString(
    signature["signed_by"],
    "authority.h3_policy_version_signature.signed_by",
  );
  const signatureContentSha = asNullableString(
    signature["content_sha256_at_signoff"],
    "authority.h3_policy_version_signature.content_sha256_at_signoff",
  );
  const signatureSignAt = asNullableString(
    signature["sign_at"],
    "authority.h3_policy_version_signature.sign_at",
  );
  const ownerSignature = asRecord(
    authority["owner_policy_version_signature"],
    "authority.owner_policy_version_signature",
  );
  if (typeof ownerSignature["required"] !== "boolean") {
    fail("invalid_type", "authority.owner_policy_version_signature.required 必须是布尔");
  }
  const ownerSignatureStatus = asNonEmptyString(
    ownerSignature["status"],
    "authority.owner_policy_version_signature.status",
  );
  const ownerSignatureRef = asNonEmptyString(
    ownerSignature["ref"],
    "authority.owner_policy_version_signature.ref",
  );
  const ownerSignatureAt = asNullableString(
    ownerSignature["signed_at"],
    "authority.owner_policy_version_signature.signed_at",
  );

  // 分区签名完整性：只翻 status、不填绑定字段一律 fail-closed（Lead L130 硬化）。
  if (signatureStatus === "signed") {
    if (signatureSignedBy !== "H3") {
      fail("signature_incomplete", `c_end 分区 signed_by 必须为 H3，实际 ${signatureSignedBy}`);
    }
    if (signatureContentSha === null) {
      fail("signature_incomplete", "c_end 分区 status=signed 但 content_sha256_at_signoff 为空");
    }
    if (signatureSignAt === null) {
      fail("signature_incomplete", "c_end 分区 status=signed 但 sign_at 为空");
    }
  }
  if (ownerSignatureStatus === "signed" && ownerSignatureAt === null) {
    fail("signature_incomplete", "internal 分区 status=signed 但 signed_at 为空");
  }

  const scopeRaw = asRecord(root["scope"], "scope");
  const audiences = scopeRaw["audiences"];
  if (!Array.isArray(audiences) || audiences.length === 0) {
    fail("invalid_type", "scope.audiences 必须是非空数组");
  }
  const parsedAudiences = audiences.map((item, index) => {
    const audience = asNonEmptyString(item, `scope.audiences[${index}]`);
    if (!AUDIENCES.includes(audience as Audience)) {
      fail("invalid_audience", `scope.audiences[${index}] 未知 audience：${audience}`);
    }
    return audience as Audience;
  });

  const whitelist = asRecord(scopeRaw["content_whitelist"], "scope.content_whitelist");
  const whitelistAudiencesRaw = asRecord(
    whitelist["audiences"],
    "scope.content_whitelist.audiences",
  );
  const whitelistAudiences = {} as Record<Audience, OutputClass[]>;
  for (const audience of AUDIENCES) {
    const classes = asStringArray(
      whitelistAudiencesRaw[audience],
      `scope.content_whitelist.audiences.${audience}`,
    ).map((value, index) =>
      asOutputClass(value, `scope.content_whitelist.audiences.${audience}[${index}]`),
    );
    whitelistAudiences[audience] = classes;
  }

  const categoriesRaw = root["categories"];
  if (!Array.isArray(categoriesRaw) || categoriesRaw.length === 0) {
    fail("invalid_type", "categories 必须是非空数组");
  }
  const categories = categoriesRaw.map(parseCategory);
  const ids = new Set<string>();
  for (const category of categories) {
    if (ids.has(category.id)) {
      fail("duplicate_category", `category 重复：${category.id}`);
    }
    ids.add(category.id);
  }

  const prefixes = asStringArray(
    root["allowed_conclusion_prefixes"],
    "allowed_conclusion_prefixes",
  );
  const rewriteRules = parseRewriteRules(scopeRaw["rewrite_rules"], prefixes);

  const caveatsRaw = root["caveat_rules"];
  if (!Array.isArray(caveatsRaw)) {
    fail("invalid_type", "caveat_rules 必须是数组");
  }
  const caveatRules = caveatsRaw.map(parseCaveatRule);

  const mappingRaw = asRecord(root["decision_mapping"], "decision_mapping");
  const decisionMapping = {} as Record<Action, "passed" | "blocked">;
  for (const action of ACTIONS) {
    const mapped = mappingRaw[action];
    if (mapped !== "passed" && mapped !== "blocked") {
      fail("invalid_decision_mapping", `decision_mapping.${action} 必须是 passed|blocked`);
    }
    decisionMapping[action] = mapped;
  }

  // 正则在这里编译，非法正则在加载期就 fail-closed。
  for (const [index, category] of categories.entries()) {
    category.patterns.forEach((pattern, patternIndex) =>
      compileRegex(pattern, `categories[${index}].patterns[${patternIndex}]`),
    );
  }
  caveatRules.forEach((rule, index) => compileRegex(rule.trigger, `caveat_rules[${index}].trigger`));

  // H3 S4 + L130：分区签发（c_end=H3 / internal=owner）必须在生产环境同时成立。
  if (isProductionEnvironment()) {
    if (signatureStatus !== "signed") {
      fail(
        "policy_not_signed_for_production",
        `生产环境拒绝加载未签字策略（c_end 分区）：status=${signatureStatus}`,
      );
    }
    if (parsedAudiences.includes("internal") && ownerSignatureStatus !== "signed") {
      fail(
        "policy_not_signed_for_production",
        `生产环境拒绝加载未签字策略（internal 分区）：status=${ownerSignatureStatus}`,
      );
    }
    const expectedVersion = process.env["AI_CONTENT_POLICY_EXPECTED_VERSION"]?.trim();
    const expectedSha256 = process.env["AI_CONTENT_POLICY_EXPECTED_SHA256"]?.trim();
    if (!expectedVersion || !expectedSha256) {
      fail(
        "policy_pin_missing",
        "生产环境必须同时设置 AI_CONTENT_POLICY_EXPECTED_VERSION 与 AI_CONTENT_POLICY_EXPECTED_SHA256",
      );
    }
    if (!options.sourceSha256) {
      fail(
        "policy_pin_missing",
        "生产环境加载策略必须提供原始文件 sha256（loader 未传入 sourceSha256）",
      );
    }
    if (options.sourceSha256 !== expectedSha256) {
      fail(
        "policy_sha256_mismatch",
        `策略文件内容哈希与部署清单不一致：expected=${expectedSha256} actual=${options.sourceSha256}`,
      );
    }
    if (expectedVersion !== policyVersion) {
      fail(
        "policy_version_mismatch",
        `策略版本与部署清单不一致：expected=${expectedVersion} actual=${policyVersion}`,
      );
    }
  }

  return {
    schema_version: 1,
    canonical_source_of_truth: canonical,
    policy_version: policyVersion,
    updated,
    authored_by: authoredBy,
    authority: {
      defined_by: asNonEmptyString(authority["defined_by"], "authority.defined_by"),
      definition_refs: asStringArray(authority["definition_refs"], "authority.definition_refs"),
      a5_change_policy: asNonEmptyString(authority["a5_change_policy"], "authority.a5_change_policy"),
      h3_policy_version_signature: {
        required: signature["required"],
        status: signatureStatus,
        signed_by: signatureSignedBy,
        content_sha256_at_signoff: signatureContentSha,
        sign_at: signatureSignAt,
        note: asNonEmptyString(signature["note"], "authority.h3_policy_version_signature.note"),
      },
      owner_policy_version_signature: {
        required: ownerSignature["required"],
        status: ownerSignatureStatus,
        ref: ownerSignatureRef,
        signed_at: ownerSignatureAt,
        note: asNonEmptyString(ownerSignature["note"], "authority.owner_policy_version_signature.note"),
      },
    },
    basis_scope: {
      applies_to: basisScopeAppliesTo,
      internal_basis: basisScopeInternal,
    },
    scope: {
      audiences: parsedAudiences,
      applies_to_stages: asStringArray(scopeRaw["applies_to_stages"], "scope.applies_to_stages"),
      content_whitelist: {
        audiences: whitelistAudiences,
        statement: asNonEmptyString(
          whitelist["statement"],
          "scope.content_whitelist.statement",
        ),
      },
      rewrite_rules: rewriteRules,
    },
    categories,
    allowed_conclusion_prefixes: prefixes,
    caveat_rules: caveatRules,
    decision_mapping: decisionMapping,
    consumers: {},
  };
}

/** 编译（带缓存，不改变输入对象；纯内存操作）。 */
export function compileAiContentPolicy(policy: AiContentPolicy): CompiledAiContentPolicy {
  const cached = compiledCache.get(policy);
  if (cached) {
    return cached;
  }
  const compiled: CompiledAiContentPolicy = {
    policy,
    categories: policy.categories.map((category) => ({
      category,
      regexes: category.patterns.map((pattern) => compileRegex(pattern, `category:${category.id}`)),
    })),
    caveats: policy.caveat_rules.map((rule) => ({
      rule,
      regex: compileRegex(rule.trigger, `caveat:${rule.id}`),
    })),
  };
  compiledCache.set(policy, compiled);
  return compiled;
}
