/**
 * 分析生成：prompt 构造、模型 draft 解析（P2 入口）、确定性数据卡 fallback。
 *
 * 规则（ADR-007 D3）：
 *  - 功能点只提供 prompt、输出 JSON Schema、确定性 fallback，禁止各自实现过滤/文案；
 *  - P2 H3 m01470：模型 draft 不得携带 section.title（词表旁路），解析命中即整体作废重试；
 *  - 任何情况下不得把模型原始输出直接透传（后处理在 postprocess/host.ts）。
 */

import type { AiDraft, Claim, EvidenceItem, OutputClass } from '@market-sense/ai-policy';
import { OUTPUT_CLASSES } from '../../../packages/ai-policy/src/index.js';

import type { AiCompletionRequest } from './provider.js';
import type { AnalysisSubjectLike, EvidenceModule, EvidenceProbeResult } from './evidence.js';
import { okModules } from './evidence.js';

/** prompt 版本（写入 meta.ai.prompt_version / P8 审计）。 */
export const DEFAULT_PROMPT_VERSION = 'analyses-v1';

export interface BuildAnalysisPromptInput {
  readonly kind: string;
  readonly subject: AnalysisSubjectLike;
  readonly asOf: string;
  readonly evidence: readonly EvidenceItem[];
  readonly lookbackDays?: number;
}

const CLASSES_FOR_PROMPT = OUTPUT_CLASSES.filter((cls) => cls !== 'data_gaps').join('|');

export function buildAnalysisPrompt(input: BuildAnalysisPromptInput): AiCompletionRequest {
  const lines: string[] = [
    `kind=${input.kind}`,
    `as_of=${input.asOf}`,
    `lookback_days=${input.lookbackDays ?? 20}`,
    'evidence:',
    ...input.evidence.map((item) => `[${item.id}] ${item.text}`),
    `output_schema={"sections":[{"claims":[{"text":"<fact statement>","evidence_ids":["<ev id>"],"class":"<${CLASSES_FOR_PROMPT}>"}]}]}`,
    'requirements: strict JSON only; no section titles; every claim cites at least one evidence id;',
    'every number in a claim must appear in its cited evidence; factual statements only.',
  ];
  return {
    prompt: lines.join('\n'),
    system: 'market-sense analysis engine; strict JSON; no investment advice',
    maxOutputTokens: 2000,
  };
}

interface ModelDraftClaimShape {
  readonly text?: unknown;
  readonly evidence_ids?: unknown;
  readonly class?: unknown;
  readonly title?: unknown;
}

interface ModelDraftSectionShape {
  readonly title?: unknown;
  readonly claims?: unknown;
}

function isOutputClass(value: unknown): value is OutputClass {
  return typeof value === 'string' && (OUTPUT_CLASSES as readonly string[]).includes(value);
}

function parseClaim(raw: unknown): Claim | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const claim = raw as ModelDraftClaimShape;
  if (typeof claim.text !== 'string' || claim.text.trim() === '' || claim.text.length > 2000) {
    return null;
  }
  if (!Array.isArray(claim.evidence_ids) || claim.evidence_ids.length === 0) {
    return null;
  }
  if (!claim.evidence_ids.every((id) => typeof id === 'string' && id.trim() !== '')) {
    return null;
  }
  // H3 m01470：claim/section 携带 title 也是词表旁路，整体作废。
  if (claim.title !== undefined) {
    return null;
  }
  if (!isOutputClass(claim.class)) {
    return null;
  }
  return { text: claim.text, evidence_ids: [...claim.evidence_ids], class: claim.class };
}

/**
 * 解析模型输出为 AiDraft。只接受「sections 无 title + claims 带 class」形态；
 * 任何结构偏差返回 null（调用方重试一次后降级数据卡）。
 */
export function parseModelDraft(text: string): AiDraft | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    const captured = match[1];
    if (captured !== undefined) candidates.push(captured.trim());
  }
  candidates.push(text.trim());

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      continue;
    }
    const draft = asDraft(parsed);
    if (draft !== null) {
      return draft;
    }
  }
  return null;
}

function asDraft(parsed: unknown): AiDraft | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const shape = parsed as { sections?: unknown; claims?: unknown };
  const sections: { claims: Claim[] }[] = [];
  const flatClaims: Claim[] = [];

  if (shape.sections !== undefined) {
    if (!Array.isArray(shape.sections) || shape.sections.length === 0) {
      return null;
    }
    for (const raw of shape.sections as ModelDraftSectionShape[]) {
      // H3 m01470：模型不得生成 section.title。
      if (typeof raw?.title === 'string' && raw.title.trim() !== '') {
        return null;
      }
      if (!Array.isArray(raw?.claims) || raw.claims.length === 0) {
        return null;
      }
      const claims: Claim[] = [];
      for (const claimRaw of raw.claims) {
        const claim = parseClaim(claimRaw);
        if (claim === null) {
          return null;
        }
        claims.push(claim);
      }
      sections.push({ claims });
    }
    return { sections };
  }

  if (Array.isArray(shape.claims) && shape.claims.length > 0) {
    for (const claimRaw of shape.claims) {
      const claim = parseClaim(claimRaw);
      if (claim === null) {
        return null;
      }
      flatClaims.push(claim);
    }
    return { claims: flatClaims };
  }
  return null;
}

/**
 * 确定性数据卡 draft：只有表格/事实数字（claim.text=证据事实行原文），无 LLM 文案。
 * P2–P5 失败、模型不可解析时的统一降级；draft 不带 title（P2 规则）。
 */
export function dataCardDraft(probe: EvidenceProbeResult): AiDraft {
  const sections: { claims: Claim[] }[] = okModules(probe).map((module) => ({
    claims: module.evidence.map((item) => ({
      text: item.text,
      evidence_ids: [item.id],
      class: 'historical_facts' as const,
    })),
  }));
  return sections.length > 0 ? { sections } : { claims: [] };
}

/** 由输出 draft 的证据引用推导 section 的模块归属（装配 AnalysisSection.id/title 用）。 */
export function sectionModules(
  claims: readonly Claim[],
  modulesById: Map<string, EvidenceModule>,
): string[] {
  const modules: string[] = [];
  for (const claim of claims) {
    for (const id of claim.evidence_ids) {
      const module = modulesById.get(id);
      if (module !== undefined && !modules.includes(module.module)) {
        modules.push(module.module);
      }
    }
  }
  return modules;
}
