import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAiContentPolicy } from '@market-sense/compliance';

import {
  PostprocessHostError,
  runPostprocessHost,
  type PostprocessContext,
} from '../src/postprocess/host.js';
import { createAiPolicyEvaluator } from '../src/postprocess/policy-evaluator.js';

const policy = loadAiContentPolicy();
const evaluator = createAiPolicyEvaluator({ policy });

const context: PostprocessContext = {
  audience: 'c_end',
  policyVersion: policy.policy_version,
  entitlement: {
    audience: 'c_end',
    displayAllowed: true,
    internalAccessAllowed: false,
    blocked: false,
  },
  analysisId: 'analysis-test-1',
  traceId: 'trace-test-1',
};

test('ai-policy 装配：合规草稿通过并保留 draft/evidence 形态', async () => {
  const input = {
    draft: {
      sections: [
        {
          claims: [{ text: '数据显示，区间收益 3%', evidence_ids: ['e1'], class: 'metrics' }],
        },
      ],
    },
    evidence: [{ id: 'e1', text: '区间收益 3%', numbers: [3] }],
  };
  const result = await runPostprocessHost(input, context, { policy: evaluator });
  assert.equal(result.blocked, false);
  const output = result.output as typeof input & { violations: unknown[]; caveats: string[] };
  assert.equal(output.draft.sections[0]?.claims[0]?.text, '数据显示，区间收益 3%');
  assert.equal(output.evidence[0]?.id, 'e1');
  assert.deepEqual(output.violations, []);
});

test('ai-policy 装配：P5 投资建议命中 → host 返回确定性降级卡，不返回原文', async () => {
  const input = {
    draft: { claims: [{ text: '建议买入该股', evidence_ids: ['e1'], class: 'objective_fields' }] },
    evidence: [{ id: 'e1', text: '收盘价 10.00 元', numbers: [10] }],
  };
  const result = await runPostprocessHost(input, context, { policy: evaluator });
  assert.equal(result.blocked, true);
  assert.equal(result.degraded, true);
  assert.ok(result.reasonCodes.includes('investment_advice'));
  assert.deepEqual(result.output, { degraded: true, reasonCodes: result.reasonCodes });
  assert.doesNotMatch(JSON.stringify(result.output), /建议买入/);
});

test('ai-policy 装配：C 端 claim 缺省/不允许 class → P2 blocked', async () => {
  const missingClass = await runPostprocessHost(
    {
      draft: { claims: [{ text: '数据显示，区间收益 3%', evidence_ids: ['e1'] }] },
      evidence: [{ id: 'e1', text: '区间收益 3%', numbers: [3] }],
    },
    context,
    { policy: evaluator },
  );
  assert.equal(missingClass.blocked, true);
  assert.ok(missingClass.reasonCodes.includes('class_missing'));

  const dataGapsOnCend = await runPostprocessHost(
    {
      draft: { claims: [{ text: '数据显示，区间收益 3%', evidence_ids: ['e1'], class: 'data_gaps' }] },
      evidence: [{ id: 'e1', text: '区间收益 3%', numbers: [3] }],
    },
    context,
    { policy: evaluator },
  );
  assert.equal(dataGapsOnCend.blocked, true);
  assert.ok(
    dataGapsOnCend.reasonCodes.includes('class_not_allowed') ||
      dataGapsOnCend.reasonCodes.includes('data_gaps_not_allowed'),
  );
});

test('ai-policy 装配：P6 非白名单前缀改写为「数据显示，…」', async () => {
  const input = {
    draft: { claims: [{ text: '该股上涨 3%', evidence_ids: ['e1'], class: 'metrics' }] },
    evidence: [{ id: 'e1', text: '收盘涨幅 3%', numbers: [3] }],
  };
  const result = await runPostprocessHost(input, context, { policy: evaluator });
  assert.equal(result.blocked, false);
  const output = result.output as typeof input;
  assert.equal(output.draft.claims[0]?.text, '数据显示，该股上涨 3%');
  // P8 output_hash 的输入：P6 改写后的最终 claim（class/evidence_ids 保留，顺序不变）。
  const verdict = await evaluator.evaluate(input, context);
  assert.deepEqual(verdict.outputClaims, [
    { text: '数据显示，该股上涨 3%', class: 'metrics', evidence_ids: ['e1'] },
  ]);
});

test('ai-policy 装配：P4 模型自算数字无证据 → blocked', async () => {
  const input = {
    draft: { claims: [{ text: '数据显示，目标涨幅 8%', evidence_ids: ['e1'], class: 'metrics' }] },
    evidence: [{ id: 'e1', text: '收盘涨幅 3%', numbers: [3] }],
  };
  const result = await runPostprocessHost(input, context, { policy: evaluator });
  assert.equal(result.blocked, true);
  assert.ok(result.reasonCodes.includes('numeric_mismatch'));
});

test('ai-policy 装配：策略版本不一致 fail-closed（P2-P6 500）', async () => {
  await assert.rejects(
    () =>
      runPostprocessHost(
        { draft: { claims: [] }, evidence: [] },
        { ...context, policyVersion: 'ai-content-policy/0.0.0' },
        { policy: evaluator },
      ),
    (error: unknown) => error instanceof PostprocessHostError && error.stage === 'P2-P6',
  );
});

test('ai-policy 装配：输入形态不合法 fail-closed（P2-P6 500）', async () => {
  await assert.rejects(
    () => runPostprocessHost({ draft: null }, context, { policy: evaluator }),
    (error: unknown) => error instanceof PostprocessHostError && error.stage === 'P2-P6',
  );
});
