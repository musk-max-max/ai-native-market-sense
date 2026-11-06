/**
 * H3 红线依据（rules/redline-basis.json）的纯校验（A5 实现，H3 定义）。
 *
 * 该文件把 policy 的 12 个 P5 category 映射到 H3-C01..H3-C12 与三档依据；
 * 本包只做结构与一致性校验，不生成/改写依据文本。生产加载时必须同时校验
 * policy 的双 sha（签字内容 sha / 部署文件 sha），任一漂移即拒绝启动。
 */

import type { AiContentPolicy } from "./types.js";

export const BASIS_TIERS = {
  CSRC_40_DEF: "40号文定义（分析/预测/建议）",
  L3_FIVE_NO: "L3 五不",
  ADR007_P5_P6: "ADR-007 P5/P6",
  PENDING_LEGAL: "待外部律师意见，禁止引用条号",
} as const;

export type BasisTier = keyof typeof BASIS_TIERS;

export const REDLINE_BASIS_EXPECTED_VERSION = "1.0.1";

export const REDLINE_RULE_IDS = [
  "H3-C01",
  "H3-C02",
  "H3-C03",
  "H3-C04",
  "H3-C05",
  "H3-C06",
  "H3-C07",
  "H3-C08",
  "H3-C09",
  "H3-C10",
  "H3-C11",
  "H3-C12",
] as const;

export type RedlineRuleId = (typeof REDLINE_RULE_IDS)[number];

export interface RedlineBasisRule {
  rule_id: RedlineRuleId;
  theme: string;
  category: string;
  basis: BasisTier[];
}

export interface RedlineBasis {
  schema_version: number;
  version: string;
  doc_type: string;
  owner: string;
  implemented_by: string;
  signed: boolean;
  signed_by: string;
  /** 待签时为 null；翻转 signed=true 时必须为非空 UTC 时间。 */
  signed_at: string | null;
  /** H3 签认的 pending 内容 sha256；待签时为 null，翻转时填入。 */
  content_sha256_at_signoff: string | null;
  /** 翻转签认的实际 UTC 时间；待签时为 null。 */
  sign_at: string | null;
  policy_version: string;
  policy_signed_content_sha256: string;
  policy_deployed_file_sha256: string;
  basis_tiers: Record<BasisTier, string>;
  rules: RedlineBasisRule[];
}

export type RedlineBasisErrorCode =
  | "invalid_structure"
  | "invalid_basis_tier"
  | "invalid_rule_sequence"
  | "invalid_category_set"
  | "invalid_basis_ref"
  | "policy_category_not_block"
  | "reason_code_mismatch"
  | "policy_version_mismatch"
  | "policy_sha_mismatch"
  | "not_signed"
  | "signature_incomplete"
  | "version_mismatch";

export class RedlineBasisError extends Error {
  readonly code: RedlineBasisErrorCode;

  constructor(code: RedlineBasisErrorCode, message: string) {
    super(message);
    this.name = "RedlineBasisError";
    this.code = code;
  }
}

export interface ParseRedlineBasisOptions {
  policy: AiContentPolicy;
  expectedVersion?: string;
  expectedPolicySignedContentSha256?: string;
  expectedPolicyDeployedFileSha256?: string;
  /** 生产入口必须传 true：signed 必须为 true。 */
  requireSigned?: boolean;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const RULE_ID_SET = new Set<string>(REDLINE_RULE_IDS);
const BASIS_TIER_KEYS = Object.keys(BASIS_TIERS) as BasisTier[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function fail(code: RedlineBasisErrorCode, message: string): never {
  throw new RedlineBasisError(code, message);
}

function assertString(value: unknown, field: string, code: RedlineBasisErrorCode): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(code, `字段 ${field} 必须为非空字符串`);
  }
  return value;
}

function assertNullableString(
  value: unknown,
  field: string,
  code: RedlineBasisErrorCode,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(code, `字段 ${field} 必须为非空字符串或 null`);
  }
  return value;
}

/**
 * 校验红线依据文件，并做三层一致性：
 * 1) 文件自身结构/签名/版本；
 * 2) 12 条 C01..C12 与 policy 的 12 个 category 双向集合相等；
 * 3) policy 版本与双 sha 必须匹配（防 policy 改版后红线依据未跟）。
 */
export function parseRedlineBasis(
  raw: unknown,
  options: ParseRedlineBasisOptions,
): RedlineBasis {
  if (!isPlainObject(raw)) fail("invalid_structure", "redline-basis 必须是 JSON 对象");

  if (raw.schema_version !== 1) {
    fail("invalid_structure", `redline-basis.schema_version 必须为 1，实际 ${String(raw.schema_version)}`);
  }
  if (raw.doc_type !== "h3-redline-basis") {
    fail("invalid_structure", "redline-basis.doc_type 必须为 h3-redline-basis");
  }
  if (raw.owner !== "H3" || raw.implemented_by !== "A5" || raw.signed_by !== "H3") {
    fail("invalid_structure", "redline-basis 的 owner/implemented_by/signed_by 不匹配（H3 定义、A5 实现）");
  }
  if (options.requireSigned === true && raw.signed !== true) {
    fail("not_signed", "生产环境要求 redline-basis.signed=true");
  }

  const version = assertString(raw.version, "version", "invalid_structure");
  if (options.expectedVersion !== undefined && version !== options.expectedVersion) {
    fail(
      "version_mismatch",
      `redline-basis.version=${version}，期望 ${options.expectedVersion}（改版须升版并找 H3 重签）`,
    );
  }
  const signedAt = assertNullableString(raw.signed_at, "signed_at", "invalid_structure");
  const contentShaAtSignoff = assertNullableString(
    raw.content_sha256_at_signoff,
    "content_sha256_at_signoff",
    "invalid_structure",
  );
  const signAt = assertNullableString(raw.sign_at, "sign_at", "invalid_structure");
  if (typeof raw.signed !== "boolean") {
    fail("invalid_structure", "redline-basis.signed 必须为布尔值");
  }
  if (raw.signed) {
    if (!signedAt) fail("signature_incomplete", "signed=true 但 signed_at 为空");
    if (!contentShaAtSignoff || !SHA256_RE.test(contentShaAtSignoff)) {
      fail("signature_incomplete", "signed=true 但 content_sha256_at_signoff 不是 64 位小写 hex");
    }
    if (!signAt) fail("signature_incomplete", "signed=true 但 sign_at 为空");
  }
  const policyVersion = assertString(raw.policy_version, "policy_version", "invalid_structure");

  const signedSha = assertString(
    raw.policy_signed_content_sha256,
    "policy_signed_content_sha256",
    "invalid_structure",
  );
  const deployedSha = assertString(
    raw.policy_deployed_file_sha256,
    "policy_deployed_file_sha256",
    "invalid_structure",
  );
  if (!SHA256_RE.test(signedSha) || !SHA256_RE.test(deployedSha)) {
    fail("invalid_structure", "redline-basis 的 policy 两个 sha 必须是 64 位小写 hex");
  }

  if (!isPlainObject(raw.basis_tiers)) {
    fail("invalid_basis_tier", "redline-basis.basis_tiers 必须为对象");
  }
  const tierKeys = Object.keys(raw.basis_tiers);
  if (tierKeys.length !== BASIS_TIER_KEYS.length) {
    fail("invalid_basis_tier", "redline-basis.basis_tiers 必须恰有 4 档");
  }
  for (const tier of BASIS_TIER_KEYS) {
    if (raw.basis_tiers[tier] !== BASIS_TIERS[tier]) {
      fail("invalid_basis_tier", `redline-basis.basis_tiers.${tier} 文本不得改写`);
    }
  }

  if (!Array.isArray(raw.rules)) {
    fail("invalid_rule_sequence", "redline-basis.rules 必须为数组");
  }
  if (raw.rules.length !== REDLINE_RULE_IDS.length) {
    fail(
      "invalid_rule_sequence",
      `redline-basis.rules 必须恰为 12 条（C01..C12），实际 ${raw.rules.length} 条`,
    );
  }

  const seenIds = new Set<string>();
  const seenCategories = new Set<string>();
  const rules: RedlineBasisRule[] = [];
  for (const rawRule of raw.rules) {
    if (!isPlainObject(rawRule)) {
      fail("invalid_rule_sequence", "redline-basis.rules 每项必须为对象");
    }
    const ruleId = rawRule.rule_id;
    if (typeof ruleId !== "string" || !RULE_ID_SET.has(ruleId)) {
      fail("invalid_rule_sequence", `未知或缺失 rule_id：${String(ruleId)}（只允许 H3-C01..H3-C12）`);
    }
    if (seenIds.has(ruleId)) {
      fail("invalid_rule_sequence", `rule_id 重复：${ruleId}`);
    }
    seenIds.add(ruleId);

    const theme = assertString(rawRule.theme, `${ruleId}.theme`, "invalid_structure");
    const category = assertString(rawRule.category, `${ruleId}.category`, "invalid_category_set");
    if (seenCategories.has(category)) {
      fail("invalid_category_set", `category 重复：${category}`);
    }
    seenCategories.add(category);

    if (!Array.isArray(rawRule.basis) || rawRule.basis.length === 0) {
      fail("invalid_basis_tier", `${ruleId}.basis 必须为非空数组`);
    }
    const seenBasis = new Set<string>();
    const basis: BasisTier[] = [];
    for (const rawTier of rawRule.basis) {
      if (typeof rawTier !== "string" || !(BASIS_TIER_KEYS as string[]).includes(rawTier)) {
        fail("invalid_basis_tier", `${ruleId}.basis 含未知档位：${String(rawTier)}`);
      }
      if (seenBasis.has(rawTier)) {
        fail("invalid_basis_tier", `${ruleId}.basis 档位重复：${rawTier}`);
      }
      seenBasis.add(rawTier);
      basis.push(rawTier as BasisTier);
    }
    if (ruleId !== "H3-C12" && basis.includes("PENDING_LEGAL")) {
      fail("invalid_basis_tier", `${ruleId} 不允许使用 PENDING_LEGAL（仅 C12）`);
    }
    if (ruleId === "H3-C12" && (basis.length !== 1 || basis[0] !== "PENDING_LEGAL")) {
      fail("invalid_basis_tier", "H3-C12 必须且只能标 PENDING_LEGAL");
    }

    rules.push({ rule_id: ruleId as RedlineRuleId, theme, category, basis });
  }

  // 12 个 rule_id 集合必须完整（不校验数组顺序）
  if (seenIds.size !== REDLINE_RULE_IDS.length) {
    fail("invalid_rule_sequence", "redline-basis.rules 缺少 H3-C01..H3-C12 中的条目");
  }

  const policyCategories = options.policy.categories;
  const policyById = new Map(policyCategories.map((c) => [c.id, c]));
  if (policyById.size !== policyCategories.length) {
    fail("invalid_category_set", "policy.categories 存在重复 id，无法与红线依据对齐");
  }
  if (seenCategories.size !== policyById.size) {
    fail(
      "invalid_category_set",
      `红线依据 category 数=${seenCategories.size} 与 policy category 数=${policyById.size} 不一致`,
    );
  }
  for (const category of seenCategories) {
    if (!policyById.has(category)) {
      fail("invalid_category_set", `红线依据 category 不在 policy 中：${category}`);
    }
  }
  for (const policyCategory of policyCategories) {
    if (!seenCategories.has(policyCategory.id)) {
      fail("invalid_category_set", `policy category 没有 H3-C 依据：${policyCategory.id}`);
    }
  }

  // 反向校验（H3 1.1.2）：policy 的 category.basis 必须是指向本文件同一 category 的
  // `见 rules/redline-basis.json#H3-Cxx` 引用，防止 policy 里再抄一份依据文本造成漂移。
  const BASIS_REF_RE = /^见 rules\/redline-basis\.json#(H3-C[0-9]{2})$/;
  const ruleIdByCategory = new Map(rules.map((rule) => [rule.category, rule.rule_id]));
  for (const [category, expectedRuleId] of ruleIdByCategory) {
    const policyCategory = policyById.get(category);
    if (policyCategory === undefined) {
      fail("invalid_basis_ref", `policy 缺少 category ${category}，无法校验 basis 引用`);
    }
    const match = BASIS_REF_RE.exec(policyCategory.basis);
    if (match === null || match[1] !== expectedRuleId) {
      fail(
        "invalid_basis_ref",
        `policy category ${category}.basis 必须为 "见 rules/redline-basis.json#${expectedRuleId}"，实际 ${JSON.stringify(policyCategory.basis)}`,
      );
    }
  }

  for (const policyCategory of policyCategories) {
    if (policyCategory.default_action !== "block") {
      fail(
        "policy_category_not_block",
        `policy category ${policyCategory.id} 的 default_action 必须为 block（P5 命中即 block）`,
      );
    }
    if (policyCategory.reason_code !== policyCategory.id) {
      fail(
        "reason_code_mismatch",
        `policy category ${policyCategory.id} 的 reason_code=${policyCategory.reason_code}，必须等于 category id`,
      );
    }
  }

  if (policyVersion !== options.policy.policy_version) {
    fail(
      "policy_version_mismatch",
      `redline-basis.policy_version=${policyVersion}，policy.policy_version=${options.policy.policy_version}`,
    );
  }
  if (
    options.expectedPolicySignedContentSha256 !== undefined &&
    signedSha !== options.expectedPolicySignedContentSha256
  ) {
    fail("policy_sha_mismatch", "redline-basis.policy_signed_content_sha256 与期望不一致");
  }
  if (
    options.expectedPolicyDeployedFileSha256 !== undefined &&
    deployedSha !== options.expectedPolicyDeployedFileSha256
  ) {
    fail("policy_sha_mismatch", "redline-basis.policy_deployed_file_sha256 与期望不一致");
  }

  return {
    schema_version: 1,
    version,
    doc_type: "h3-redline-basis",
    owner: "H3",
    implemented_by: "A5",
    signed: raw.signed as boolean,
    signed_by: "H3",
    signed_at: signedAt,
    content_sha256_at_signoff: contentShaAtSignoff,
    sign_at: signAt,
    policy_version: policyVersion,
    policy_signed_content_sha256: signedSha,
    policy_deployed_file_sha256: deployedSha,
    basis_tiers: { ...BASIS_TIERS },
    rules,
  };
}
