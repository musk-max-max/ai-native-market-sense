import {
  OUTPUT_CLASSES,
  type AiDraft,
  type AiContentPolicy,
  type Audience,
  type Claim,
  type ClaimResult,
  type Decision,
  type EvidenceItem,
  type OutputClass,
  type PolicyResult,
  type PolicyViolation,
  type RunAiPolicyInput,
  type Section,
  AiPolicyConfigError,
} from "./types.js";
import {
  compileAiContentPolicy,
  type CompiledAiContentPolicy,
} from "./policy.js";

// 负号只在“不是数字/负号之后”时才算负号，避免把 ISO 日期 2026-11-05 拆成 -11/-05。
const NUMERIC_TOKEN = /(?<![\d-])-?\d[\d,]*(?:\.\d+)?%?/gu;

export function extractNumericTokens(text: string): string[] {
  const found = text.match(NUMERIC_TOKEN);
  return found ? Array.from(new Set(found)) : [];
}

function normalizeToken(token: string): string {
  return token.replace(/,/gu, "");
}

function tokenValue(token: string): number | null {
  const raw = normalizeToken(token).replace(/%$/u, "");
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function evidenceTextMatches(text: string, token: string): boolean {
  const normalizedText = text.replace(/,/gu, "");
  const pattern = new RegExp(`(?<![0-9.])${escapeRegExp(normalizeToken(token))}(?![0-9.])`, "u");
  return pattern.test(normalizedText);
}

function evidenceNumbersMatch(evidence: EvidenceItem, token: string): boolean {
  const value = tokenValue(token);
  if (value === null || !evidence.numbers) {
    return false;
  }
  return evidence.numbers.some((candidate) => candidate === value);
}

/** 展平 sections/claims（不做校验；结构问题由 validateStructure 报）。 */
export function collectClaims(draft: AiDraft): Claim[] {
  const claims: Claim[] = [];
  if (Array.isArray(draft.claims)) {
    claims.push(...draft.claims);
  }
  if (Array.isArray(draft.sections)) {
    for (const section of draft.sections) {
      if (section && Array.isArray(section.claims)) {
        claims.push(...section.claims);
      }
    }
  }
  return claims;
}

function isOutputClass(value: unknown): value is OutputClass {
  return typeof value === "string" && (OUTPUT_CLASSES as readonly string[]).includes(value);
}

/**
 * P2 结构校验：sections/claims 形态、claim.text 非空、evidence_ids 为数组、
 * claim.class 必填且属于该 audience 的 content_whitelist、证据 id/text 合法且 id 唯一。
 * 返回空数组=通过。
 *
 * 传入 policy+audience 时才执行 class 白名单校验（H3 S1 执行点）；
 * 单独做结构校验的调用方（如 A16 样本检查）可省略。
 */
export function validateStructure(
  draft: AiDraft,
  evidence: EvidenceItem[],
  policy?: AiContentPolicy,
  audience?: Audience,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const push = (code: string, claimIndex: number, matched: string): void => {
    violations.push({ stage: "P2", code, claim_index: claimIndex, action: "block", matched });
  };

  if (typeof draft !== "object" || draft === null) {
    push("structure_invalid", -1, "draft 不是对象");
    return violations;
  }
  if (draft.sections === undefined && draft.claims === undefined) {
    push("structure_invalid", -1, "draft 必须包含 sections 或 claims");
    return violations;
  }
  if (draft.sections !== undefined && !Array.isArray(draft.sections)) {
    push("structure_invalid", -1, "sections 必须是数组");
  }
  if (draft.claims !== undefined && !Array.isArray(draft.claims)) {
    push("structure_invalid", -1, "claims 必须是数组");
  }

  const sections = Array.isArray(draft.sections) ? draft.sections : [];
  sections.forEach((section, sectionIndex) => {
    if (typeof section !== "object" || section === null || !Array.isArray(section.claims)) {
      push("structure_invalid", -1, `sections[${sectionIndex}].claims 必须是数组`);
      return;
    }
    // H3 m01470：模型生成的 section.title 是词表旁路；标题由 copy.ts 常驻，schema 禁止模型生成。
    if (typeof section.title === "string" && section.title.trim() !== "") {
      push("model_generated_title_not_allowed", -1, section.title);
    }
  });

  const claims = collectClaims(draft);
  if (claims.length === 0) {
    push("structure_invalid", -1, "至少需要一条 claim");
  }
  const allowedClasses =
    policy !== undefined && audience !== undefined
      ? policy.scope.content_whitelist.audiences[audience]
      : undefined;
  claims.forEach((claim, claimIndex) => {
    const record = claim as Partial<Claim> | null;
    if (typeof record !== "object" || record === null) {
      push("structure_invalid", claimIndex, "claim 不是对象");
      return;
    }
    if (typeof record.text !== "string" || record.text.trim() === "") {
      push("structure_invalid", claimIndex, "claim.text 必须是非空字符串");
    }
    if (!Array.isArray(record.evidence_ids)) {
      push("structure_invalid", claimIndex, "claim.evidence_ids 必须是数组");
      return;
    }
    record.evidence_ids.forEach((id, idIndex) => {
      if (typeof id !== "string" || id.trim() === "") {
        push("structure_invalid", claimIndex, `claim.evidence_ids[${idIndex}] 必须是非空字符串`);
      }
    });
    if (allowedClasses !== undefined) {
      if (record.class === undefined) {
        push("class_missing", claimIndex, "claim.class 缺失（白名单必须可执行）");
      } else if (!isOutputClass(record.class)) {
        push("class_not_allowed", claimIndex, `未知 class：${String(record.class)}`);
      } else if (!allowedClasses.includes(record.class)) {
        push(
          "class_not_allowed",
          claimIndex,
          `audience ${audience ?? "?"} 不允许 class：${record.class}`,
        );
      }
    }
  });

  if (!Array.isArray(evidence)) {
    push("structure_invalid", -1, "evidence 必须是数组");
  } else {
    const seen = new Set<string>();
    evidence.forEach((item, evidenceIndex) => {
      if (typeof item !== "object" || item === null) {
        push("structure_invalid", -1, `evidence[${evidenceIndex}] 不是对象`);
        return;
      }
      if (typeof item.id !== "string" || item.id.trim() === "") {
        push("structure_invalid", -1, `evidence[${evidenceIndex}].id 必须是非空字符串`);
      } else if (seen.has(item.id)) {
        push("structure_invalid", -1, `evidence id 重复：${item.id}`);
      } else {
        seen.add(item.id);
      }
      if (typeof item.text !== "string") {
        push("structure_invalid", -1, `evidence[${evidenceIndex}].text 必须是字符串`);
      }
    });
  }

  return violations;
}

/** P3 证据绑定：claim 必须引用存在且非空的 evidence_ids（数字绑定见 P4）。 */
export function bindEvidence(claims: Claim[], evidence: EvidenceItem[]): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const known = new Set(evidence.map((item) => item.id));
  claims.forEach((claim, claimIndex) => {
    const ids = Array.isArray(claim.evidence_ids) ? claim.evidence_ids : [];
    if (ids.length === 0) {
      violations.push({
        stage: "P3",
        code: "evidence_binding_failed",
        claim_index: claimIndex,
        action: "block",
        matched: "claim 未引用任何 evidence_id",
      });
      return;
    }
    for (const id of ids) {
      if (!known.has(id)) {
        violations.push({
          stage: "P3",
          code: "evidence_binding_failed",
          claim_index: claimIndex,
          action: "block",
          matched: `未知 evidence_id：${id}`,
        });
      }
    }
  });
  return violations;
}

/**
 * P4 数值一致性：claim 中出现的数字必须能在其引用的证据里找到（文本或 numbers）。
 * 模型自算、证据里不存在的新数字 → 违规（fail-closed；由调用方降级为确定性数据卡）。
 */
export function checkNumericConsistency(
  claims: Claim[],
  evidence: EvidenceItem[],
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const byId = new Map(evidence.map((item) => [item.id, item]));
  claims.forEach((claim, claimIndex) => {
    const cited = (Array.isArray(claim.evidence_ids) ? claim.evidence_ids : [])
      .map((id) => byId.get(id))
      .filter((item): item is EvidenceItem => item !== undefined);
    for (const token of extractNumericTokens(claim.text)) {
      const bound = cited.some(
        (item) => evidenceTextMatches(item.text, token) || evidenceNumbersMatch(item, token),
      );
      if (!bound) {
        violations.push({
          stage: "P4",
          code: "numeric_mismatch",
          claim_index: claimIndex,
          action: "block",
          matched: token,
        });
      }
    }
  });
  return violations;
}

export interface ComplianceFilterOptions {
  /**
   * 已由 caveat 口径豁免的类别。H3 m01300：causal_attribution 先判 data_gap
   * 语境，命中缺口语境的「因为/由于」不构成归因违规。
   */
  exemptCategories?: string[];
}

/** P5 合规过滤：按策略类别逐词法匹配；命中即 block（H3 未给可改写的中性映射）。 */
export function filterCompliance(
  text: string,
  claimIndex: number,
  policy: AiContentPolicy,
  options: ComplianceFilterOptions = {},
): PolicyViolation[] {
  const compiled = compileAiContentPolicy(policy);
  const exempt = new Set(options.exemptCategories ?? []);
  const violations: PolicyViolation[] = [];
  for (const { category, regexes } of compiled.categories) {
    if (exempt.has(category.id)) {
      continue;
    }
    let hit: RegExpExecArray | null = null;
    for (const regex of regexes) {
      hit = regex.exec(text);
      if (hit) {
        break;
      }
    }
    if (hit) {
      violations.push({
        stage: "P5",
        code: category.reason_code,
        category: category.id,
        claim_index: claimIndex,
        action: category.default_action,
        matched: hit[0],
        basis: category.basis,
      });
    }
  }
  return violations;
}

function evidenceHasNumeric(items: EvidenceItem[]): boolean {
  return items.some(
    (item) => extractNumericTokens(item.text).length > 0 || (item.numbers?.length ?? 0) > 0,
  );
}

function evidenceHasHistorical(items: EvidenceItem[], policy: AiContentPolicy): boolean {
  const pattern = new RegExp(policy.scope.rewrite_rules.historical_statistical_pattern, "u");
  return items.some((item) => pattern.test(item.text));
}

function evidenceMatchesPrefix(
  prefix: string,
  items: EvidenceItem[],
  policy: AiContentPolicy,
): boolean {
  const kind = policy.scope.rewrite_rules.prefix_evidence_match[prefix];
  if (kind === "numeric") {
    return evidenceHasNumeric(items);
  }
  if (kind === "historical_statistical") {
    return evidenceHasHistorical(items, policy);
  }
  return false;
}

/**
 * P6 结论定性（H3 S2 收紧）：只有 claim.class 在白名单（P2 已校验）、
 * evidence_ids 非空、且**前缀与证据类型匹配**时才允许改写；
 * 否则 block，绝不为无证据断言补一个虚假出处。
 */
export function qualifyConclusion(
  text: string,
  claimIndex: number,
  policy: AiContentPolicy,
  citedEvidence: EvidenceItem[],
): { violations: PolicyViolation[]; rewrittenText?: string } {
  const trimmed = text.trim();
  const prefixed = policy.allowed_conclusion_prefixes.some((prefix) => trimmed.startsWith(prefix));
  if (prefixed) {
    return { violations: [] };
  }

  if (policy.scope.rewrite_rules.require_evidence && citedEvidence.length === 0) {
    return {
      violations: [
        {
          stage: "P6",
          code: "conclusion_unqualified",
          claim_index: claimIndex,
          action: "block",
          matched: trimmed,
          basis: "无证据不允许改写出处（H3 S2）",
        },
      ],
    };
  }

  for (const prefix of policy.allowed_conclusion_prefixes) {
    if (!evidenceMatchesPrefix(prefix, citedEvidence, policy)) {
      continue;
    }
    const rewrittenText = `${prefix}，${trimmed}`;
    return {
      violations: [
        {
          stage: "P6",
          code: "conclusion_unqualified",
          claim_index: claimIndex,
          action: "redact",
          matched: trimmed,
          rewritten_text: rewrittenText,
        },
      ],
      rewrittenText,
    };
  }

  return {
    violations: [
      {
        stage: "P6",
        code: "conclusion_unqualified",
        claim_index: claimIndex,
        action: "block",
        matched: trimmed,
        basis: "证据类型与允许前缀不匹配，禁止补出处（H3 S2）",
      },
    ],
  };
}

function scanCaveats(
  text: string,
  claimIndex: number,
  policy: AiContentPolicy,
): PolicyViolation[] {
  const compiled = compileAiContentPolicy(policy);
  const violations: PolicyViolation[] = [];
  for (const { rule, regex } of compiled.caveats) {
    const match = regex.exec(text);
    if (match) {
      violations.push({
        stage: "P5",
        code: rule.caveat_code,
        claim_index: claimIndex,
        action: "caveat",
        matched: match[0],
        basis: rule.basis,
      });
    }
  }
  return violations;
}

function mapDecision(policy: AiContentPolicy, action: ClaimResult["action"]): Decision {
  const decision = policy.decision_mapping[action];
  if (decision === undefined) {
    throw new AiPolicyConfigError(
      "invalid_decision_mapping",
      `decision_mapping 缺 action：${action}`,
    );
  }
  return decision;
}

function claimAction(violations: PolicyViolation[]): ClaimResult["action"] {
  return violations.some((violation) => violation.action === "block")
    ? "block"
    : violations.some((violation) => violation.action === "caveat")
      ? "caveat"
      : violations.some((violation) => violation.action === "redact")
        ? "redact"
        : "allow";
}

/**
 * P2–P6 统一入口（无 I/O 纯函数，仅读取 process.env 做生产未签策略拒绝）。
 *
 * 决策由 policy.decision_mapping 消费得出（H3 S3，禁止硬编码）。
 * redact → passed 前对改写文本重跑 P5；命中则升级为 block。
 */
export function runAiPolicy(input: RunAiPolicyInput): PolicyResult {
  const policy = input.policy;
  if (!policy || !Array.isArray(policy.categories)) {
    throw new AiPolicyConfigError("invalid_policy", "runAiPolicy 需要已解析的 AiContentPolicy");
  }
  compileAiContentPolicy(policy);
  if (input.audience === undefined) {
    throw new AiPolicyConfigError("audience_required", "runAiPolicy 必须显式传入 audience");
  }
  const audience: Audience = input.audience;
  if (!policy.scope.audiences.includes(audience)) {
    throw new AiPolicyConfigError("unsupported_audience", `策略未声明 audience：${audience}`);
  }
  const whitelist = policy.scope.content_whitelist.audiences[audience];
  if (!Array.isArray(whitelist) || whitelist.length === 0) {
    throw new AiPolicyConfigError(
      "unsupported_audience_whitelist",
      `策略未声明 audience ${audience} 的白名单`,
    );
  }

  const structure = validateStructure(input.draft, input.evidence, policy, audience);
  if (structure.length > 0) {
    return {
      policy_version: policy.policy_version,
      audience,
      decision: "blocked",
      claims: [],
      caveats: [],
      reason_codes: Array.from(new Set(structure.map((violation) => violation.code))),
      violations: structure,
    };
  }

  const claims = collectClaims(input.draft);
  const evidence = input.evidence;
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const violations: PolicyViolation[] = [];
  const claimResults: ClaimResult[] = [];
  const caveats: string[] = [];

  claims.forEach((claim, claimIndex) => {
    const cited = (Array.isArray(claim.evidence_ids) ? claim.evidence_ids : [])
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceItem => item !== undefined);
    const caveatViolations = scanCaveats(claim.text, claimIndex, policy);
    const caveatHit = caveatViolations.some((violation) => violation.code === "data_gap");
    const complianceViolations = filterCompliance(claim.text, claimIndex, policy, {
      exemptCategories: caveatHit ? ["causal_attribution"] : [],
    });

    const claimViolations: PolicyViolation[] = [
      ...bindEvidence([claim], evidence).map((violation) => ({
        ...violation,
        claim_index: claimIndex,
      })),
      ...checkNumericConsistency([claim], evidence).map((violation) => ({
        ...violation,
        claim_index: claimIndex,
      })),
      ...caveatViolations,
      ...complianceViolations,
    ];

    const hasBlockBeforeP6 = claimViolations.some((violation) => violation.action === "block");
    // 策略声明的 skip_p6_classes（H3 m01502）：缺口声明不是结论，不补出处。
    if (!hasBlockBeforeP6 && !policy.scope.rewrite_rules.skip_p6_classes.includes(claim.class)) {
      const conclusion = qualifyConclusion(claim.text, claimIndex, policy, cited);
      claimViolations.push(...conclusion.violations);
    }

    let action = claimAction(claimViolations);
    let resultText = claim.text;
    if (action === "redact") {
      const rewritten = claimViolations.find(
        (violation) => violation.stage === "P6" && violation.rewritten_text !== undefined,
      )?.rewritten_text;
      if (rewritten !== undefined) {
        // H3 S3：redact → passed 前必须对改写文本重跑 P5；命中则升级为 block。
        const recheck = filterCompliance(rewritten, claimIndex, policy);
        if (recheck.length > 0) {
          claimViolations.push(
            ...recheck.map((violation) => ({
              ...violation,
              basis: `${violation.basis ?? ""}（P6 改写后重跑 P5 命中）`,
            })),
          );
          action = "block";
        } else {
          resultText = rewritten;
        }
      }
    }

    for (const violation of claimViolations) {
      if (violation.action === "caveat") {
        caveats.push(violation.code);
      }
    }

    claimResults.push({
      index: claimIndex,
      text: action === "redact" ? resultText : claim.text,
      action,
      violations: claimViolations,
    });
    violations.push(...claimViolations);
  });

  const decision: Decision = claimResults
    .map((result) => mapDecision(policy, result.action))
    .includes("blocked")
    ? "blocked"
    : "passed";

  return {
    policy_version: policy.policy_version,
    audience,
    decision,
    claims: claimResults,
    caveats: Array.from(new Set(caveats)),
    reason_codes: Array.from(new Set(violations.map((violation) => violation.code))),
    violations,
  };
}
