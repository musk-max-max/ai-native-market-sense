/**
 * AI 内容策略类型（A5）。
 *
 * 策略文本单一真源：rules/ai-content-policy.json（H3 定义、签字；A5 只实现）。
 * 本包无 I/O：调用方（A3 在线 / A16 离线）负责加载 JSON，再用 parseAiContentPolicy 校验。
 */

export type Audience = "c_end" | "internal";

/** 单条 claim 的处置。 */
export type Action = "allow" | "block" | "redact" | "caveat";

/** 整份结果的对外决策（映射到 contracts/ai 结果 schema 的 compliance.decision）。 */
export type Decision = "passed" | "blocked";

export type Stage = "P2" | "P3" | "P4" | "P5" | "P6";

/**
 * 输出类别白名单（H3 q3=A）。claim 必须声明 class，P2 按 audience 校验；
 * 缺省/未知 → blocked。C 端不含 data_gaps（缺口文案由 API copy 常驻）。
 */
export const OUTPUT_CLASSES = [
  "objective_fields",
  "metrics",
  "quantiles",
  "statistics",
  "historical_facts",
  "timestamps",
  "data_gaps",
] as const;

export type OutputClass = (typeof OUTPUT_CLASSES)[number];

/** ADR-007 结果 schema 的 claim 输入形态。class 必填（H3 S1）。 */
export interface Claim {
  text: string;
  evidence_ids: string[];
  class: OutputClass;
}

export interface Section {
  title?: string;
  claims: Claim[];
}

/** 允许两种输入：sections[]（ADR-007 契约形态）或扁平 claims[]（内部/离线样本）。 */
export interface AiDraft {
  sections?: Section[];
  claims?: Claim[];
}

/** 证据项（由 tool 层按 allowlist 取到；本包只看内容，不访问网络）。 */
export interface EvidenceItem {
  id: string;
  text: string;
  numbers?: number[];
}

export interface PolicyCategory {
  id: string;
  reason_code: string;
  default_action: Action;
  basis: string;
  patterns: string[];
}

export interface PolicyCaveatRule {
  id: string;
  caveat_code: string;
  trigger: string;
  basis: string;
}

/** P6 改写的前缀—证据类型匹配（H3 S2：没有证据类型匹配不许 redact）。 */
export type EvidenceKind = "numeric" | "historical_statistical";

export interface PolicyRewriteRules {
  require_evidence: boolean;
  prefix_evidence_match: Record<string, EvidenceKind>;
  /** H3 m01502：这些 class 不适用 P6（缺口声明不是结论，不补出处）。 */
  skip_p6_classes: OutputClass[];
  historical_statistical_pattern: string;
}

export interface PolicyScope {
  audiences: Audience[];
  applies_to_stages: string[];
  content_whitelist: {
    audiences: Record<Audience, OutputClass[]>;
    statement: string;
  };
  rewrite_rules: PolicyRewriteRules;
}

export interface AiContentPolicy {
  schema_version: number;
  canonical_source_of_truth: string;
  policy_version: string;
  updated: string;
  authored_by: string;
  authority: {
    defined_by: string;
    definition_refs: string[];
    a5_change_policy: string;
    h3_policy_version_signature: {
      required: boolean;
      status: string;
      signed_by: string;
      content_sha256_at_signoff: string | null;
      sign_at: string | null;
      note: string;
    };
    owner_policy_version_signature: {
      required: boolean;
      status: string;
      ref: string;
      signed_at: string | null;
      note: string;
    };
  };
  /** 依据分区：H3-Cxx 只约束 c_end；internal 依据由 owner decision 承载。 */
  basis_scope: {
    applies_to: string;
    internal_basis: string;
  };
  scope: PolicyScope;
  categories: PolicyCategory[];
  allowed_conclusion_prefixes: string[];
  caveat_rules: PolicyCaveatRule[];
  decision_mapping: Record<Action, Decision>;
  consumers: Record<string, string>;
}

/** 单条命中/违规。 */
export interface PolicyViolation {
  stage: Stage;
  code: string;
  /** P5 命中类别时填 category.id。 */
  category?: string;
  claim_index: number;
  action: Action;
  /** P5/P6 命中的原文片段，便于审计。 */
  matched?: string;
  /** P6 等需要改写时的目标文本。 */
  rewritten_text?: string;
  basis?: string;
}

export interface ClaimResult {
  index: number;
  text: string;
  action: Action;
  violations: PolicyViolation[];
}

export interface PolicyResult {
  policy_version: string;
  audience: Audience;
  decision: Decision;
  claims: ClaimResult[];
  caveats: string[];
  reason_codes: string[];
  violations: PolicyViolation[];
}

export interface RunAiPolicyInput {
  policy: AiContentPolicy;
  draft: AiDraft;
  evidence: EvidenceItem[];
  /** 缺省 c_end：fail-closed 取更严口径。 */
  audience?: Audience;
}

/** 策略文件加载/校验失败（fail-closed：调用方应阻断请求，不得回退无过滤）。 */
export class AiPolicyConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AiPolicyConfigError";
    this.code = code;
  }
}
