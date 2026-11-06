/**
 * /v1/ai/analyses 业务编排（ADR-007 D2/D3/D4、L126）。
 *
 * 形状真源：contracts/ai/openapi.yaml（AnalysisRequest/AnalysisResult/AiMeta）与
 * contracts/ai/internal-generation-context.schema.json（P8 审计上下文）。
 *
 * 流程：校验(400) → P1 证据探测（透传用户 Bearer）→ 全受限 403（调 LLM 前，D4.3）
 * → 模型生成（结构失败重试一次 → 降级确定性数据卡）→ P2–P8 postprocess（含审计）
 * → 装配契约响应（P6 后文本，不透传模型原始输出）。
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { AiDraft, Claim, EvidenceItem } from '@market-sense/ai-policy';
import { computeInputEvidenceHash } from '@market-sense/ai-policy';

import {
  AI_COPY,
  COPY_TEXT_HASH,
  COPY_VERSION,
  ERROR_TITLES,
  VALIDATION_FAILED_DETAIL,
} from '../../../api/src/copy.js';
import { HttpProblem } from '../../../api/src/errors.js';

import {
  hasRestrictedModule,
  moduleOfEvidenceId,
  okModules,
  type EvidenceModule,
  type EvidenceProbeResult,
  type EvidenceSource,
  type EvidenceSourceRef,
} from '../evidence.js';
import {
  buildAnalysisPrompt,
  dataCardDraft,
  DEFAULT_PROMPT_VERSION,
  parseModelDraft,
  sectionModules,
} from '../generation.js';
import type { AiProvider } from '../provider.js';
import type { AiGenerationAuditEvent } from '../postprocess/audit.js';
import {
  PostprocessBlockedError,
  PostprocessHostError,
  runPostprocessHost,
  type PolicyEvaluator,
  type PostprocessContext,
} from '../postprocess/host.js';

/** host 的 PolicyEvaluator + 策略版本（context.policyVersion 与文件版本必须一致，见 policy-evaluator.ts）。 */
export interface AnalysesPolicyEvaluator extends PolicyEvaluator {
  readonly policyVersion: string;
}

/** contracts/ai/openapi.yaml AnalysisKind 封闭枚举。 */
export const ANALYSIS_KINDS = [
  'stock_interpretation',
  'watchlist_review',
  'post_market_review',
  'lhb_review',
  'capital_features',
  'factor_screen',
  'research_brief',
  'anomaly_alert',
] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

const INSTRUMENT_ID_PATTERN = /^(SSE|SZSE|BSE):[0-9]{6}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

/** D4.4：部分受限/缺维度的 caveat 机器码（展示文案归 H3 copy 轴映射，服务端不拼中文）。 */
export const CAVEAT_EVIDENCE_DIMENSION_UNAVAILABLE = 'evidence_dimension_unavailable';

export interface AnalysisSubjectShape {
  readonly instrument_id?: string;
  readonly universe?: 'market' | 'watchlist';
  readonly as_of?: string;
}

export interface AnalysisRequestShape {
  readonly kind: AnalysisKind;
  readonly subject: AnalysisSubjectShape;
  readonly options?: { readonly lookback_days?: number; readonly include_evidence?: boolean };
  readonly idempotency_key?: string;
}

function badRequest(): HttpProblem {
  return new HttpProblem(400, 'VALIDATION_ERROR', ERROR_TITLES[400], VALIDATION_FAILED_DETAIL);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw badRequest();
    }
  }
}

/** 契约校验（additionalProperties:false 语义）；违反即 400 VALIDATION_ERROR。 */
export function validateAnalysisRequest(body: unknown): AnalysisRequestShape {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest();
  }
  const record = body as Record<string, unknown>;
  rejectUnknownKeys(record, ['kind', 'subject', 'options', 'idempotency_key']);

  const kind = record.kind;
  if (typeof kind !== 'string' || !(ANALYSIS_KINDS as readonly string[]).includes(kind)) {
    throw badRequest();
  }

  const subjectRaw = record.subject;
  if (typeof subjectRaw !== 'object' || subjectRaw === null || Array.isArray(subjectRaw)) {
    throw badRequest();
  }
  const subjectRecord = subjectRaw as Record<string, unknown>;
  rejectUnknownKeys(subjectRecord, ['instrument_id', 'universe', 'as_of']);
  const { instrument_id: instrumentId, universe, as_of: asOf } = subjectRecord;
  if (instrumentId !== undefined && (typeof instrumentId !== 'string' || !INSTRUMENT_ID_PATTERN.test(instrumentId))) {
    throw badRequest();
  }
  if (universe !== undefined && universe !== 'market' && universe !== 'watchlist') {
    throw badRequest();
  }
  if (asOf !== undefined && (typeof asOf !== 'string' || asOf.trim() === '')) {
    throw badRequest();
  }
  if (instrumentId === undefined && universe === undefined) {
    throw badRequest();
  }
  const subject: AnalysisSubjectShape = {
    ...(typeof instrumentId === 'string' ? { instrument_id: instrumentId } : {}),
    ...(universe === 'market' || universe === 'watchlist' ? { universe } : {}),
    ...(typeof asOf === 'string' ? { as_of: asOf } : {}),
  };

  let options: { lookback_days?: number; include_evidence?: boolean } | undefined;
  const optionsRaw = record.options;
  if (optionsRaw !== undefined) {
    if (typeof optionsRaw !== 'object' || optionsRaw === null || Array.isArray(optionsRaw)) {
      throw badRequest();
    }
    const optionsRecord = optionsRaw as Record<string, unknown>;
    rejectUnknownKeys(optionsRecord, ['lookback_days', 'include_evidence']);
    const lookback = optionsRecord.lookback_days;
    if (lookback !== undefined && (!Number.isInteger(lookback) || (lookback as number) < 1 || (lookback as number) > 250)) {
      throw badRequest();
    }
    const includeEvidence = optionsRecord.include_evidence;
    if (includeEvidence !== undefined && typeof includeEvidence !== 'boolean') {
      throw badRequest();
    }
    options = {
      ...(typeof lookback === 'number' ? { lookback_days: lookback } : {}),
      ...(typeof includeEvidence === 'boolean' ? { include_evidence: includeEvidence } : {}),
    };
  }

  const idempotencyKey = record.idempotency_key;
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128 ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
  ) {
    throw badRequest();
  }

  return {
    kind: kind as AnalysisKind,
    subject,
    ...(options !== undefined ? { options } : {}),
    ...(typeof idempotencyKey === 'string' ? { idempotency_key: idempotencyKey } : {}),
  };
}

export function validateAnalysisId(analysisId: string): void {
  if (analysisId.length < 8 || analysisId.length > 128 || !ANALYSIS_ID_PATTERN.test(analysisId)) {
    throw badRequest();
  }
}

/** 外壳/认证器解析出的主体（services/identity Principal 的消费子集）。 */
export interface AiPrincipal {
  readonly userId: string;
  readonly tier: string;
}

export interface StoredAnalysis {
  readonly userId: string;
  readonly response: unknown;
}

export interface AnalysisStore {
  save(analysisId: string, userId: string, response: unknown): void;
  get(analysisId: string): StoredAnalysis | undefined;
  findByKey(userId: string, idempotencyKey: string): string | undefined;
  saveKey(userId: string, idempotencyKey: string, analysisId: string): void;
}

export class InMemoryAnalysisStore implements AnalysisStore {
  private readonly byId = new Map<string, StoredAnalysis>();
  private readonly byKey = new Map<string, string>();

  public save(analysisId: string, userId: string, response: unknown): void {
    this.byId.set(analysisId, { userId, response });
  }

  public get(analysisId: string): StoredAnalysis | undefined {
    return this.byId.get(analysisId);
  }

  public findByKey(userId: string, idempotencyKey: string): string | undefined {
    return this.byKey.get(`${userId}|${idempotencyKey}`);
  }

  public saveKey(userId: string, idempotencyKey: string, analysisId: string): void {
    this.byKey.set(`${userId}|${idempotencyKey}`, analysisId);
  }
}

export interface AnalysesServiceOptions {
  readonly evidence: EvidenceSource;
  readonly provider: AiProvider;
  readonly policyEvaluator: AnalysesPolicyEvaluator;
  readonly audit: (event: AiGenerationAuditEvent) => void | Promise<void>;
  readonly store: AnalysisStore;
  readonly promptVersion?: string;
  readonly userHashKey?: string;
  /** P7 文案版本派生：缺省 COPY_VERSION.COPY_TEXT_HASH[:12]（与 H3 凭证一致）。 */
  readonly contentVersion?: string;
}

export interface RunAnalysisInput {
  readonly request: AnalysisRequestShape;
  readonly principal: AiPrincipal;
  readonly audience: 'c_end' | 'internal';
  readonly requestId: string;
  /** 用户 Bearer（短 TTL）随内部调用透传 market（L126）。 */
  readonly bearer?: string;
}

export interface RunAnalysisResult {
  readonly analysisId: string;
  readonly requestId: string;
  readonly response: unknown;
  readonly decision: 'passed' | 'blocked';
}

/** content_version = COPY_VERSION + '.' + COPY_TEXT_HASH[:12]（H3 凭证 2026.11.5.ac875c9d9237）。 */
export function deriveContentVersion(): string {
  return `${COPY_VERSION}.${COPY_TEXT_HASH.slice(0, 12)}`;
}

function hashUserId(userId: string, key: string | undefined): string {
  if (key !== undefined && key !== '') {
    return createHmac('sha256', key).update(userId, 'utf8').digest('hex');
  }
  return createHash('sha256').update(`ai|${userId}`, 'utf8').digest('hex');
}

function primarySource(probe: EvidenceProbeResult): EvidenceSourceRef {
  for (const module of okModules(probe)) {
    if (module.source !== undefined) {
      return module.source;
    }
  }
  throw new HttpProblem(500, 'INTERNAL_ERROR', ERROR_TITLES.default);
}

interface PostprocessOutput {
  readonly draft: AiDraft;
  readonly caveats?: readonly string[];
}

interface AssembleInput {
  readonly analysisId: string;
  readonly request: AnalysisRequestShape;
  readonly probe: EvidenceProbeResult;
  readonly asOf: string;
  readonly source: EvidenceSourceRef;
  readonly entitlement: { tier: string; is_entitled: boolean };
  readonly aiMeta: Record<string, unknown>;
  readonly decision: 'passed' | 'blocked';
  readonly reasonCodes: readonly string[];
  readonly policyCaveats: readonly string[];
  readonly draft: AiDraft;
  readonly principal: AiPrincipal;
}

function buildMeta(input: {
  source: EvidenceSourceRef;
  entitlement: { tier: string; is_entitled: boolean };
}): Record<string, unknown> {
  return {
    source: input.source,
    entitlement: input.entitlement,
    disclaimer: { text: AI_COPY.disclaimer, version: COPY_VERSION, closable: false },
  };
}

/** 装配契约 AnalysisSection：id/title=模块机器码（H3 m01470：draft 禁 title，copy 标题表落地后换映射）。 */
function buildSections(
  draft: AiDraft,
  modulesById: Map<string, EvidenceModule>,
  moduleSource: Map<string, EvidenceSourceRef>,
): Record<string, unknown>[] {
  const groups: { claims: Claim[] }[] = [];
  if (Array.isArray(draft.sections)) {
    groups.push(...(draft.sections as { claims: Claim[] }[]));
  }
  if (Array.isArray(draft.claims)) {
    groups.push({ claims: draft.claims as Claim[] });
  }
  return groups.map((group, index) => {
    const modules = sectionModules(group.claims, modulesById);
    const id = modules[0] ?? `sec-${index}`;
    return {
      id,
      title: id,
      claims: group.claims.map((claim) => ({
        text: claim.text,
        evidence_ids: [...claim.evidence_ids],
      })),
      data_refs: modules.map((module) => {
        const source = moduleSource.get(module);
        return {
          module,
          ...(source !== undefined ? { as_of: source.as_of } : {}),
        };
      }),
    };
  });
}

function assembleResponse(input: AssembleInput): Record<string, unknown> {
  const modulesById = new Map<string, EvidenceModule>();
  const moduleSource = new Map<string, EvidenceSourceRef>();
  for (const module of input.probe.modules) {
    moduleSource.set(module.module, module.source ?? { source: 'platform_eod', as_of: input.asOf, staleness_ms: 0 });
    for (const item of module.evidence) {
      modulesById.set(item.id, module);
    }
  }

  const dimensionMissing = input.probe.modules.length > okModules(input.probe).length;
  const caveats = [
    ...new Set([...input.policyCaveats, ...(dimensionMissing ? [CAVEAT_EVIDENCE_DIMENSION_UNAVAILABLE] : [])]),
  ].slice(0, 20);

  const meta = buildMeta({ source: input.source, entitlement: input.entitlement });
  const result: Record<string, unknown> = {
    analysis_id: input.analysisId,
    kind: input.request.kind,
    subject: input.request.subject,
    status: input.decision === 'blocked' ? 'blocked' : 'succeeded',
    as_of: input.asOf,
    sections: buildSections(input.draft, modulesById, moduleSource),
    caveats,
    compliance: {
      policy_version: input.aiMeta.policy_version,
      decision: input.decision,
      reason_codes: [...input.reasonCodes].slice(0, 50),
    },
    ai: input.aiMeta,
    meta,
  };
  return { data: result, meta };
}

export class AnalysesService {
  private readonly options: AnalysesServiceOptions;

  public constructor(options: AnalysesServiceOptions) {
    this.options = options;
  }

  public async run(input: RunAnalysisInput): Promise<RunAnalysisResult> {
    const { request, principal, requestId } = input;
    const contentVersion = this.options.contentVersion ?? deriveContentVersion();
    if (contentVersion.trim() === '') {
      // D2：content_version 缺失必须调模型前拒绝（fail-closed），不产生半条审计。
      throw new HttpProblem(500, 'INTERNAL_ERROR', ERROR_TITLES.default);
    }
    const promptVersion = this.options.promptVersion ?? DEFAULT_PROMPT_VERSION;

    if (request.idempotency_key !== undefined) {
      const existing = this.options.store.findByKey(principal.userId, request.idempotency_key);
      if (existing !== undefined) {
        const stored = this.options.store.get(existing);
        if (stored !== undefined) {
          return { analysisId: existing, requestId, response: stored.response, decision: 'passed' };
        }
      }
    }

    // P1：证据探测（透传 Bearer）；全受限在调 LLM 前 403（D4.3，不消耗 token）。
    const probe = await this.options.evidence.probe(request.subject, { bearer: input.bearer });
    const ok = okModules(probe);
    if (ok.length === 0) {
      if (hasRestrictedModule(probe)) {
        throw new HttpProblem(403, 'ENTITLEMENT_RESTRICTED', ERROR_TITLES[403]);
      }
      if (probe.modules.some((module) => module.instrumentNotFound)) {
        throw new HttpProblem(404, 'INSTRUMENT_NOT_FOUND', ERROR_TITLES[404]);
      }
      throw new HttpProblem(500, 'INTERNAL_ERROR', ERROR_TITLES.default);
    }

    // C 端可展示性：200+is_entitled=false 仅是降级预判（红线③）；AI 不得为不可展示档生成
    // 可见内容（D4.6），且必须在调 LLM 前短路（D4.3，不消耗 token）。
    const displayAllowed = ok.some((module) => module.entitlement === undefined || module.entitlement.is_entitled);
    if (!displayAllowed) {
      throw new HttpProblem(403, 'ENTITLEMENT_RESTRICTED', ERROR_TITLES[403]);
    }

    const source = primarySource(probe);
    const asOf = source.as_of;
    const evidence: EvidenceItem[] = ok.flatMap((module) => [...module.evidence]);

    const prompt = buildAnalysisPrompt({
      kind: request.kind,
      subject: request.subject,
      asOf,
      evidence,
      ...(request.options?.lookback_days !== undefined ? { lookbackDays: request.options.lookback_days } : {}),
    });

    // P2：模型输出结构校验失败重试一次，仍失败降级确定性数据卡（D3）。
    let draft: AiDraft | null = null;
    for (let attempt = 0; attempt < 2 && draft === null; attempt += 1) {
      const completion = await this.options.provider.complete(prompt);
      draft = parseModelDraft(completion.text);
    }
    const usedDataCard = draft === null;
    const effectiveDraft: AiDraft = draft ?? dataCardDraft(probe);

    const analysisId = `an-${randomUUID()}`;
    const context: PostprocessContext = {
      audience: input.audience,
      policyVersion: this.options.policyEvaluator.policyVersion,
      entitlement: {
        audience: input.audience,
        displayAllowed,
        internalAccessAllowed: true,
        blocked: false,
      },
      analysisId,
      traceId: requestId,
      requestId,
      userId: hashUserId(principal.userId, this.options.userHashKey),
      kind: request.kind,
      modelFamily: this.options.provider.modelFamily,
      promptVersion,
      contentVersion,
      labelVersion: contentVersion,
      asOf,
      inputEvidenceHash: computeInputEvidenceHash({
        kind: request.kind,
        audience: input.audience,
        asOf,
        evidence: evidence.map((item) => ({ ...item })),
      }),
    };

    let hostResult;
    try {
      hostResult = await runPostprocessHost(
        { draft: effectiveDraft, evidence: evidence.map((item) => ({ ...item })) },
        context,
        {
          policy: this.options.policyEvaluator,
          audit: this.options.audit,
          degradedCard: (reasonCodes) => ({ degraded: true as const, reasonCodes }),
        },
      );
    } catch (error) {
      if (error instanceof PostprocessBlockedError) {
        throw new HttpProblem(403, 'ENTITLEMENT_RESTRICTED', ERROR_TITLES[403]);
      }
      if (error instanceof PostprocessHostError) {
        throw new HttpProblem(500, 'INTERNAL_ERROR', ERROR_TITLES.default);
      }
      throw error;
    }

    const decision: 'passed' | 'blocked' = hostResult.blocked ? 'blocked' : 'passed';
    const output = hostResult.output as PostprocessOutput | { degraded: true };
    // D3：blocked 一律降级确定性数据卡（不得透传模型文本，含被阻断草稿）；passed 用 P6 改写后草稿。
    const finalDraft: AiDraft = hostResult.blocked
      ? dataCardDraft(probe)
      : 'draft' in output && output.draft !== undefined
        ? output.draft
        : effectiveDraft;
    const policyCaveats: readonly string[] =
      'caveats' in output && Array.isArray(output.caveats) ? output.caveats : [];

    const firstOkEntitlement = ok.find((module) => module.entitlement !== undefined)?.entitlement;
    const entitlement = firstOkEntitlement ?? { tier: principal.tier, is_entitled: displayAllowed };
    const aiMeta: Record<string, unknown> = {
      generated: true,
      label_version: contentVersion,
      content_version: contentVersion,
      model_family: this.options.provider.modelFamily,
      prompt_version: promptVersion,
      policy_version: this.options.policyEvaluator.policyVersion,
    };

    const response = assembleResponse({
      analysisId,
      request,
      probe,
      asOf,
      source,
      entitlement,
      aiMeta,
      decision,
      reasonCodes: hostResult.reasonCodes,
      policyCaveats,
      draft: finalDraft,
      principal,
    });

    this.options.store.save(analysisId, principal.userId, response);
    if (request.idempotency_key !== undefined) {
      this.options.store.saveKey(principal.userId, request.idempotency_key, analysisId);
    }
    void usedDataCard;
    return { analysisId, requestId, response, decision };
  }

  public get(analysisId: string, userId: string): unknown {
    validateAnalysisId(analysisId);
    const stored = this.options.store.get(analysisId);
    if (stored === undefined || stored.userId !== userId) {
      // 不泄露存在性：非本人与不存在同样 404。
      throw new HttpProblem(404, 'NOT_FOUND', ERROR_TITLES[404]);
    }
    return stored.response;
  }
}

export function moduleOfEvidence(item: { id: string }): string | undefined {
  return moduleOfEvidenceId(item.id);
}
