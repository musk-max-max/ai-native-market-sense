/**
 * A5 策略包（@market-sense/ai-policy）的在线装配层（A3 写域，L126）。
 *
 * 本文件只做 I/O 装配与输入/输出映射：
 *  - 策略文本由 `@market-sense/compliance` 的唯一只读 loader 加载（单一真源
 *    `rules/ai-content-policy.json`），P2–P6 判定全部调用 A5 的 `runAiPolicy`；
 *  - 不复制任何过滤规则、正则、数值复算或结论改写逻辑（L45：两份真源会互相打红）；
 *  - 策略加载失败/策略版本不符/输入形态不符一律抛错，由 host 映射为 500（fail-closed），
 *    不允许回退到“不过滤直接透传”。
 */

import { loadAiContentPolicy } from '@market-sense/compliance';
import {
  collectClaims,
  runAiPolicy,
  type AiContentPolicy,
  type AiDraft,
  type AuditOutputClaim,
  type Claim,
  type EvidenceItem,
  type PolicyResult,
  type Section,
} from '@market-sense/ai-policy';

import type {
  PolicyEvaluator,
  PolicyVerdict,
  PostprocessContext,
} from './host.js';
import { postprocessActionsFromViolations } from './audit.js';

/** 在线后处理的输入形态：模型草稿 + tool 层取到的、已按 allowlist 裁剪的证据。 */
export interface PostprocessDraftInput {
  readonly draft: AiDraft;
  readonly evidence: readonly EvidenceItem[];
}

export interface AiPolicyEvaluatorOptions {
  /** 已解析策略（测试/离线复用）；缺省从 compliance loader 读取。 */
  readonly policy?: AiContentPolicy;
  /** 仅供离线/测试指定策略文件；生产应使用仓库内唯一真源。 */
  readonly policyPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asDraftInput(input: unknown): PostprocessDraftInput {
  if (!isRecord(input) || !isRecord(input['draft']) || !Array.isArray(input['evidence'])) {
    throw new Error('postprocess 输入必须是 { draft, evidence[] }（A5 runAiPolicy 形态）');
  }
  return {
    draft: input['draft'] as unknown as AiDraft,
    evidence: input['evidence'] as unknown as EvidenceItem[],
  };
}

/** 按 collectClaims 的顺序把 P6 改写后的 text 写回原草稿，保留 sections 结构。 */
export function rewriteDraft(draft: AiDraft, claims: readonly { text: string }[]): AiDraft {
  let index = 0;
  const nextClaim = (claim: Claim): Claim => {
    const rewritten = claims[index++];
    return rewritten === undefined ? claim : { ...claim, text: rewritten.text };
  };

  const flatClaims = Array.isArray(draft.claims) ? draft.claims.map(nextClaim) : undefined;
  const sections: Section[] | undefined = Array.isArray(draft.sections)
    ? draft.sections.map((section) => ({
        ...section,
        claims: Array.isArray(section.claims) ? section.claims.map(nextClaim) : section.claims,
      }))
    : undefined;

  return {
    ...(flatClaims !== undefined ? { claims: flatClaims } : {}),
    ...(sections !== undefined ? { sections } : {}),
  };
}

/**
 * P2–P6 后的最终 claim（P6 改写后的 text，保留 class/evidence_ids 与输出顺序）。
 * 只用于 A5 `computeOutputHash`，不参与用户可见文案拼接。
 */
function outputClaimsFromResult(result: PolicyResult, draft: AiDraft): AuditOutputClaim[] {
  const sourceClaims = collectClaims(draft);
  const toAuditClaim = (index: number, text: string): AuditOutputClaim => {
    const source = sourceClaims[index];
    if (source === undefined) {
      throw new Error(`runAiPolicy 返回未知 claim_index=${index}，拒绝生成审计 hash`);
    }
    // P2 class_missing 时原 claim 没有 class：审计如实记 null（A5 P8 契约起
    // AuditOutputClaim.class 允许 null），不得用任何真实白名单类占位。
    return {
      text,
      class: source.class ?? null,
      evidence_ids: [...source.evidence_ids],
    };
  };

  if (result.claims.length > 0) {
    return result.claims.map((claim) => toAuditClaim(claim.index, claim.text));
  }

  // P2 class_missing 会在 claim 结果生成前 short-circuit（result.claims=[]），
  // 但被阻断的候选 claim 仍须进入 output_hash；按 violation 的 claim_index 回填原文。
  const blockedClaimIndices = [
    ...new Set(
      result.violations
        .filter((violation) => violation.action === 'block' && violation.claim_index >= 0)
        .map((violation) => violation.claim_index),
    ),
  ].sort((left, right) => left - right);
  return blockedClaimIndices.map((index) => {
    const source = sourceClaims[index];
    if (source === undefined) {
      throw new Error(`runAiPolicy violation 指向未知 claim_index=${index}，拒绝生成审计 hash`);
    }
    return toAuditClaim(index, source.text);
  });
}

function toVerdict(result: PolicyResult, input: PostprocessDraftInput): PolicyVerdict {
  const actions = postprocessActionsFromViolations(result.violations);
  if (result.decision === 'blocked') {
    // P8 blocked_draft：完整原模型 draft（P6 改写前的输入），不是命中片段。
    // blocked 的 output_hash 由 host 用 computeBlockedDraftHash(blockedDraft) 计算，
    // 因此这里不生成 outputClaims：P2 structure_invalid 时原 draft 本身无法 collectClaims，
    // 强行回填会抛错并把“应留痕的阻断”变成 500。
    return {
      blocked: true,
      reasonCodes: result.reason_codes,
      actions,
      blockedDraft: input.draft,
    };
  }
  const outputClaims = outputClaimsFromResult(result, input.draft);
  return {
    blocked: false,
    reasonCodes: result.reason_codes,
    actions,
    outputClaims,
    output: {
      ...input,
      draft: rewriteDraft(input.draft, result.claims),
      // 仅供调用方组装 P8 审计的 postprocess_actions；不含用户可见文案。
      violations: result.violations,
      caveats: result.caveats,
    },
  };
}

/**
 * 构造 host 可注入的 `PolicyEvaluator`。
 *
 * 注意：工厂在构造期加载策略（fail-fast）；文件不可读/JSON/结构非法直接抛
 * `AiPolicyConfigError`，调用方不得 catch 后继续启动请求路径。
 */
export function createAiPolicyEvaluator(options: AiPolicyEvaluatorOptions = {}): PolicyEvaluator {
  const policy = options.policy ?? loadAiContentPolicy(options.policyPath);
  return {
    async evaluate(input: unknown, context: PostprocessContext): Promise<PolicyVerdict> {
      if (context.policyVersion !== policy.policy_version) {
        throw new Error(
          `postprocess policyVersion=${context.policyVersion} 与策略文件 ${policy.policy_version} 不一致`,
        );
      }
      const parsed = asDraftInput(input);
      const result = runAiPolicy({
        policy,
        draft: parsed.draft,
        evidence: [...parsed.evidence],
        audience: context.audience,
      });
      return toVerdict(result, parsed);
    },
  };
}
