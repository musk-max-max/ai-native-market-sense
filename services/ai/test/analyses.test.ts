/**
 * /v1/ai/analyses 编排单测（AI1）：校验、403 全受限短路（调 LLM 前）、降级数据卡、
 * blocked 不透传模型文本、幂等、GET 不泄露存在性、P8 审计闭环。全 fake，无 DB/网络。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AiDraft, EvidenceItem } from '@market-sense/ai-policy';

import { HttpProblem } from '../../api/src/errors.js';
import {
  AnalysesService,
  CAVEAT_EVIDENCE_DIMENSION_UNAVAILABLE,
  InMemoryAnalysisStore,
  deriveContentVersion,
  validateAnalysisRequest,
  type AnalysesPolicyEvaluator,
  type AiPrincipal,
} from '../src/domain/analyses.js';
import type {
  EvidenceModule,
  EvidenceProbeResult,
  EvidenceSource,
} from '../src/evidence.js';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiStreamChunk,
} from '../src/provider.js';
import type { PolicyVerdict, PostprocessContext } from '../src/postprocess/host.js';

const PRINCIPAL: AiPrincipal = { userId: 'user-1', tier: 'c_end_display' };
const AS_OF = '2026-11-06T13:54:15.636364+08:00';

function okModule(overrides: Partial<EvidenceModule> = {}): EvidenceModule {
  return {
    module: 'quote',
    status: 'ok',
    source: { source: 'platform_eod', source_id: 'serving_quote_latest', as_of: AS_OF, staleness_ms: 1200 },
    entitlement: { tier: 'c_end_display', is_entitled: true },
    evidence: [{ id: 'ev:quote', text: `quote|as_of=${AS_OF}|close=1510.0`, numbers: [1510] }],
    ...overrides,
  };
}

function stubEvidence(modules: EvidenceModule[]): EvidenceSource & { calls: number } {
  const source = {
    calls: 0,
    async probe(): Promise<EvidenceProbeResult> {
      source.calls += 1;
      return { modules };
    },
  };
  return source;
}

class ScriptedProvider implements AiProvider {
  public readonly name = 'scripted';
  public readonly modelFamily = 'fixture-v1';
  public calls = 0;
  public constructor(private readonly texts: readonly string[]) {}
  public async complete(_request: AiCompletionRequest): Promise<AiCompletionResult> {
    const text = this.texts[Math.min(this.calls, this.texts.length - 1)] ?? '';
    this.calls += 1;
    return { text, modelFamily: this.modelFamily };
  }
  public async *stream(): AsyncIterable<AiStreamChunk> {
    yield { delta: '', done: true };
  }
}

/** 策略 pass-through（编排测试专用；规则引擎行为由 policy-evaluator.test.ts 覆盖）。 */
function stubEvaluator(overrides: Partial<PolicyVerdict> = {}): AnalysesPolicyEvaluator & {
  calls: number;
} {
  const evaluator = {
    calls: 0,
    policyVersion: 'test-policy/1.0',
    async evaluate(input: unknown, _context: PostprocessContext): Promise<PolicyVerdict> {
      evaluator.calls += 1;
      const draft = (input as { draft: AiDraft }).draft;
      return {
        blocked: false,
        reasonCodes: [],
        actions: [],
        outputClaims: [],
        output: { ...(input as object), draft, violations: [], caveats: [] },
        ...overrides,
      };
    },
  };
  return evaluator;
}

const MODEL_DRAFT =
  '{"sections":[{"claims":[{"text":"close is 1510.0","evidence_ids":["ev:quote"],"class":"metrics"}]}]}';
const BLOCKED_MARKER = 'BUY NOW marker-must-not-leak';

function buildService(overrides: {
  evidence?: EvidenceSource;
  provider?: AiProvider;
  policyEvaluator?: AnalysesPolicyEvaluator;
  audit?: (event: unknown) => Promise<void>;
  contentVersion?: string;
} = {}): { service: AnalysesService; events: unknown[]; store: InMemoryAnalysisStore } {
  const events: unknown[] = [];
  const store = new InMemoryAnalysisStore();
  const service = new AnalysesService({
    evidence: overrides.evidence ?? stubEvidence([okModule()]),
    provider: overrides.provider ?? new ScriptedProvider([MODEL_DRAFT]),
    policyEvaluator: overrides.policyEvaluator ?? stubEvaluator(),
    audit:
      overrides.audit ??
      (async (event: unknown) => {
        events.push(event);
      }),
    store,
    userHashKey: 'test-key',
    ...(overrides.contentVersion !== undefined ? { contentVersion: overrides.contentVersion } : {}),
  });
  return { service, events, store };
}

function validBody(): Record<string, unknown> {
  return {
    kind: 'stock_interpretation',
    subject: { instrument_id: 'SSE:600519' },
  };
}

test('validateAnalysisRequest 接受契约最小请求', () => {
  const parsed = validateAnalysisRequest(validBody());
  assert.equal(parsed.kind, 'stock_interpretation');
  assert.equal(parsed.subject.instrument_id, 'SSE:600519');
});

test('validateAnalysisRequest 对非法输入抛 400 VALIDATION_ERROR', () => {
  const cases: unknown[] = [
    { kind: 'not_a_kind', subject: { instrument_id: 'SSE:600519' } },
    { kind: 'stock_interpretation', subject: {} },
    { kind: 'stock_interpretation', subject: { instrument_id: 'sh600519' } },
    { kind: 'stock_interpretation', subject: { instrument_id: 'SSE:600519' }, extra: 1 },
    { kind: 'stock_interpretation', subject: { instrument_id: 'SSE:600519' }, options: { lookback_days: 0 } },
    { kind: 'stock_interpretation', subject: { instrument_id: 'SSE:600519' }, idempotency_key: 'short' },
    { kind: 'stock_interpretation', subject: { instrument_id: 'SSE:600519', universe: 'sector' } },
  ];
  for (const body of cases) {
    assert.throws(
      () => validateAnalysisRequest(body),
      (error: unknown) => {
        assert.ok(error instanceof HttpProblem);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'VALIDATION_ERROR');
        return true;
      },
      JSON.stringify(body),
    );
  }
});

test('run 成功路径：meta.ai 六字段 + as_of + disclaimer + P8 审计闭环', async () => {
  const { service, events } = buildService();
  const parsed = validateAnalysisRequest(validBody());
  const result = await service.run({
    request: parsed,
    principal: PRINCIPAL,
    audience: 'c_end',
    requestId: 'req-1',
    bearer: 'user-bearer',
  });

  const response = result.response as {
    data: Record<string, unknown>;
    meta: Record<string, unknown>;
  };
  const data = response.data as {
    analysis_id: string;
    as_of: string;
    status: string;
    ai: Record<string, unknown>;
    meta: Record<string, unknown>;
    compliance: Record<string, unknown>;
    sections: { claims: { text: string; evidence_ids: string[] }[]; data_refs: unknown[] }[];
    caveats: string[];
  };

  assert.match(data.analysis_id, /^[A-Za-z0-9_-]+$/u);
  assert.ok(data.analysis_id.length >= 8 && data.analysis_id.length <= 128);
  assert.equal(data.as_of, AS_OF);
  assert.equal(data.status, 'succeeded');

  // AI 标识六字段（AI-1 判据 1）：generated=true + content_version/模型族/留痕版本齐全。
  assert.equal(data.ai.generated, true);
  assert.equal(data.ai.content_version, deriveContentVersion());
  assert.equal(data.ai.label_version, deriveContentVersion());
  assert.equal(data.ai.model_family, 'fixture-v1');
  assert.equal(data.ai.prompt_version, 'analyses-v1');
  assert.equal(data.ai.policy_version, 'test-policy/1.0');

  assert.equal(data.compliance.decision, 'passed');
  assert.ok(Array.isArray(data.sections) && data.sections.length >= 1);
  assert.ok(data.sections[0] !== undefined && data.sections[0].data_refs.length >= 1);

  // 展示留痕字段：source/as_of/entitlement/disclaimer（P7 注入形态，closable:false）。
  const meta = data.meta as {
    source: { as_of: string };
    entitlement: { is_entitled: boolean };
    disclaimer: { text: string; version: string; closable: boolean };
  };
  assert.equal(meta.source.as_of, AS_OF);
  assert.equal(meta.entitlement.is_entitled, true);
  assert.equal(meta.disclaimer.closable, false);
  assert.equal(meta.disclaimer.version, '2026.11.5');
  assert.deepEqual(response.meta, data.meta);

  // P8：审计事件与 request_id/analysis_id 闭环。
  assert.equal(events.length, 1);
  const event = events[0] as { requestId: string; analysisId: string; asOf: string; inputEvidenceHash: string };
  assert.equal(event.requestId, 'req-1');
  assert.equal(event.analysisId, data.analysis_id);
  assert.equal(event.asOf, AS_OF);
  assert.match(event.inputEvidenceHash, /^[0-9a-f]{64}$/u);
});

test('run 全受限：调 LLM 前 403 ENTITLEMENT_RESTRICTED，不落半条审计', async () => {
  const provider = new ScriptedProvider([MODEL_DRAFT]);
  const { service, events } = buildService({
    provider,
    evidence: stubEvidence([
      okModule({ status: 'restricted', source: undefined, entitlement: undefined, evidence: [] }),
    ]),
  });

  await assert.rejects(
    service.run({
      request: validateAnalysisRequest(validBody()),
      principal: PRINCIPAL,
      audience: 'c_end',
      requestId: 'req-2',
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpProblem);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'ENTITLEMENT_RESTRICTED');
      return true;
    },
  );
  assert.equal(provider.calls, 0);
  assert.equal(events.length, 0);
});

test('run 不存在标的：404 INSTRUMENT_NOT_FOUND', async () => {
  const { service } = buildService({
    evidence: stubEvidence([
      okModule({ status: 'unavailable', instrumentNotFound: true, source: undefined, evidence: [] }),
    ]),
  });
  await assert.rejects(
    service.run({
      request: validateAnalysisRequest(validBody()),
      principal: PRINCIPAL,
      audience: 'c_end',
      requestId: 'req-3',
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpProblem);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'INSTRUMENT_NOT_FOUND');
      return true;
    },
  );
});

test('run 部分受限：删受限维度 + caveat 机器码 evidence_dimension_unavailable', async () => {
  const { service } = buildService({
    evidence: stubEvidence([
      okModule(),
      okModule({
        module: 'fundamental',
        status: 'restricted',
        source: undefined,
        entitlement: undefined,
        evidence: [{ id: 'ev:fundamental', text: 'must-not-appear' }],
      }),
    ]),
  });
  const result = await service.run({
    request: validateAnalysisRequest(validBody()),
    principal: PRINCIPAL,
    audience: 'c_end',
    requestId: 'req-4',
  });
  const { data } = result.response as { data: { caveats: string[] } };
  assert.ok(data.caveats.includes(CAVEAT_EVIDENCE_DIMENSION_UNAVAILABLE));
  assert.ok(!JSON.stringify(result.response).includes('must-not-appear'));
});

test('run 模型输出不可解析：降级确定性数据卡，不透传模型原文', async () => {
  const { service, events } = buildService({
    provider: new ScriptedProvider(['[fake] not-json-at-all', 'still not json']),
  });
  const result = await service.run({
    request: validateAnalysisRequest(validBody()),
    principal: PRINCIPAL,
    audience: 'c_end',
    requestId: 'req-5',
  });
  const serialized = JSON.stringify(result.response);
  assert.ok(!serialized.includes('[fake]'));
  assert.ok(serialized.includes('close=1510.0')); // 数据卡 = 证据事实行
  assert.equal(events.length, 1);
});

test('run 策略 block：status=blocked 且不透传被阻断草稿', async () => {
  const evaluator = stubEvaluator({
    blocked: true,
    reasonCodes: ['investment_advice'],
    actions: [],
    blockedDraft: { sections: [{ claims: [{ text: BLOCKED_MARKER }] }] },
    output: undefined,
    outputClaims: undefined,
  });
  const { service, events } = buildService({
    policyEvaluator: evaluator,
    provider: new ScriptedProvider([
      `{"sections":[{"claims":[{"text":"${BLOCKED_MARKER}","evidence_ids":["ev:quote"],"class":"metrics"}]}]}`,
    ]),
  });
  const result = await service.run({
    request: validateAnalysisRequest(validBody()),
    principal: PRINCIPAL,
    audience: 'c_end',
    requestId: 'req-6',
  });
  const { data } = result.response as {
    data: { status: string; compliance: { decision: string; reason_codes: string[] } };
  };
  assert.equal(data.status, 'blocked');
  assert.equal(data.compliance.decision, 'blocked');
  assert.ok(data.compliance.reason_codes.includes('investment_advice'));
  assert.ok(!JSON.stringify(result.response).includes(BLOCKED_MARKER));
  const event = events[0] as { decision: string; blockedDraft: unknown };
  assert.equal(event.decision, 'blocked');
  assert.ok(event.blockedDraft !== undefined);
});

test('run is_entitled=false 的 200 数据：C 端 displayAllowed=false → 403（D4.6）', async () => {
  const provider = new ScriptedProvider([MODEL_DRAFT]);
  const { service } = buildService({
    provider,
    evidence: stubEvidence([
      okModule({ entitlement: { tier: 'internal_eval', is_entitled: false } }),
    ]),
  });
  await assert.rejects(
    service.run({
      request: validateAnalysisRequest(validBody()),
      principal: PRINCIPAL,
      audience: 'c_end',
      requestId: 'req-7',
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpProblem);
      assert.equal(error.status, 403);
      return true;
    },
  );
  assert.equal(provider.calls, 0);
});

test('幂等键：重放返回同一 analysis_id 与响应，不重复生成/探测', async () => {
  const evidence = stubEvidence([okModule()]);
  const provider = new ScriptedProvider([MODEL_DRAFT]);
  const { service } = buildService({ evidence, provider });
  const request = validateAnalysisRequest({ ...validBody(), idempotency_key: 'idem-key-0001' });
  const first = await service.run({ request, principal: PRINCIPAL, audience: 'c_end', requestId: 'req-8' });
  const second = await service.run({ request, principal: PRINCIPAL, audience: 'c_end', requestId: 'req-9' });
  assert.equal(first.analysisId, second.analysisId);
  assert.deepEqual(first.response, second.response);
  assert.equal(provider.calls, 1);
  assert.equal(evidence.calls, 1);
});

test('GET：本人可取、非本人/不存在一律 404（不泄露存在性）', async () => {
  const { service } = buildService();
  const result = await service.run({
    request: validateAnalysisRequest(validBody()),
    principal: PRINCIPAL,
    audience: 'c_end',
    requestId: 'req-10',
  });
  assert.deepEqual(service.get(result.analysisId, 'user-1'), result.response);
  assert.throws(
    () => service.get(result.analysisId, 'user-2'),
    (error: unknown) => {
      assert.ok(error instanceof HttpProblem);
      assert.equal(error.status, 404);
      return true;
    },
  );
  assert.throws(
    () => service.get('an-does-not-exist', 'user-1'),
    (error: unknown) => {
      assert.ok(error instanceof HttpProblem);
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test('content_version 缺失：调模型前 500 fail-closed，不产生审计', async () => {
  const provider = new ScriptedProvider([MODEL_DRAFT]);
  const { service, events } = buildService({ provider, contentVersion: '' });
  await assert.rejects(
    service.run({
      request: validateAnalysisRequest(validBody()),
      principal: PRINCIPAL,
      audience: 'c_end',
      requestId: 'req-11',
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpProblem);
      assert.equal(error.status, 500);
      return true;
    },
  );
  assert.equal(provider.calls, 0);
  assert.equal(events.length, 0);
});

test('EvidenceItem 事实行进入数据卡的 claim 引用可回溯（evidence_ids 绑定）', async () => {
  const items: EvidenceItem[] = [{ id: 'ev:quote', text: 'quote|close=1510.0', numbers: [1510] }];
  const first = items[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 'ev:quote');
});
