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
  runAiPolicy,
  type AiContentPolicy,
  type AiDraft,
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

function toVerdict(result: PolicyResult, input: PostprocessDraftInput): PolicyVerdict {
  if (result.decision === 'blocked') {
    return { blocked: true, reasonCodes: result.reason_codes };
  }
  return {
    blocked: false,
    reasonCodes: result.reason_codes,
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
