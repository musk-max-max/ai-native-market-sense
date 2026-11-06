import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeBlockedDraftHash,
  computeInputEvidenceHash,
  computeOutputHash,
} from '@market-sense/ai-policy';
import { loadAiContentPolicy } from '@market-sense/compliance';

import {
  AI_GENERATION_INSERT_SQL,
  assertValidAiGenerationAuditEvent,
  createAiGenerationAuditWriter,
  postprocessActionsFromViolations,
  type AiGenerationAuditEvent,
} from '../src/postprocess/audit.js';
import { runPostprocessHost, type PostprocessContext } from '../src/postprocess/host.js';
import { createAiPolicyEvaluator } from '../src/postprocess/policy-evaluator.js';

const inputEvidenceHash = computeInputEvidenceHash({
  kind: 'stock_interpretation',
  audience: 'c_end',
  asOf: '2026-11-06T08:00:00.000Z',
  evidence: [{ id: 'e1', text: '区间收益 3%', numbers: [3] }],
});

function validEvent(): AiGenerationAuditEvent {
  return {
    requestId: 'req-1',
    analysisId: 'analysis-1',
    audience: 'c_end',
    userId: 'hmac-user-1',
    kind: 'stock_interpretation',
    modelFamily: 'fake-v1',
    promptVersion: 'prompt-1',
    policyVersion: 'ai-content-policy/1.1.1',
    contentVersion: 'copy-1',
    inputEvidenceHash,
    outputHash: computeOutputHash([
      { text: '数据显示，区间收益 3%', class: 'metrics', evidence_ids: ['e1'] },
    ]),
    postprocessActions: [],
    decision: 'passed',
    asOf: '2026-11-06T08:00:00.000Z',
  };
}

test('P8 writer：18 列 INSERT 与参数顺序，不写触发器计算列', async () => {
  const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
  const writer = createAiGenerationAuditWriter({
    async query(sql, values) {
      calls.push({ sql, values });
    },
  });
  const event = {
    ...validEvent(),
    postprocessActions: [
      {
        stage: 'P6' as const,
        action: 'redact' as const,
        matched: '该股上涨 3%',
        code: 'prefix_rewrite',
        original_text: '该股上涨 3%',
        rewritten_text: '数据显示，该股上涨 3%',
      },
    ],
  };
  await writer(event);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sql, AI_GENERATION_INSERT_SQL);
  assert.doesNotMatch(calls[0]?.sql ?? '', /event_key|prev_hash|occurred_at/u);
  const values = calls[0]?.values ?? [];
  assert.equal(values.length, 18);
  assert.equal(values[0], 'req-1');
  assert.equal(values[1], 'analysis-1');
  assert.equal(values[2], 'c_end');
  assert.equal(values[3], 'hmac-user-1');
  assert.equal(values[4], 'stock_interpretation');
  assert.equal(values[14], null);
  assert.equal(values[15], 'passed');
  assert.equal(values[17], '2026-11-06T08:00:00.000Z');
  assert.deepEqual(JSON.parse(String(values[13])), event.postprocessActions);
});

test('P8 writer：event_key 唯一冲突按已记录幂等成功，其他唯一冲突 fail-closed', async () => {
  const duplicate = new Error('duplicate') as Error & { code: string; constraint: string };
  duplicate.code = '23505';
  duplicate.constraint = 'ai_generation_events_event_key_uq';
  const idempotent = createAiGenerationAuditWriter({
    async query() {
      throw duplicate;
    },
  });
  await assert.doesNotReject(() => idempotent(validEvent()));

  const other = new Error('other duplicate') as Error & { code: string; constraint: string };
  other.code = '23505';
  other.constraint = 'some_other_uq';
  const failClosed = createAiGenerationAuditWriter({
    async query() {
      throw other;
    },
  });
  await assert.rejects(() => failClosed(validEvent()), /other duplicate/u);
});

test('P8 writer：应用侧按 DDL 契约 fail-closed（缺 content_version）', async () => {
  const writer = createAiGenerationAuditWriter({
    async query() {
      throw new Error('不应写库');
    },
  });
  const event = { ...validEvent(), contentVersion: undefined } as unknown as AiGenerationAuditEvent;
  await assert.rejects(() => writer(event), /content_version/u);
});

test('P8 动作：block/redact 必须带原文标识，redact 必须带改写文本', () => {
  assert.throws(
    () =>
      assertValidAiGenerationAuditEvent({
        ...validEvent(),
        postprocessActions: [{ stage: 'P5', action: 'block', matched: '建议买入' }],
      }),
    /original_text/u,
  );
  assert.throws(
    () =>
      assertValidAiGenerationAuditEvent({
        ...validEvent(),
        postprocessActions: [
          { stage: 'P6', action: 'redact', matched: '该股上涨', original_text: '该股上涨' },
        ],
      }),
    /rewritten_text/u,
  );
});

test('P8 动作：非法 stage/action 在应用侧拒绝', () => {
  assert.throws(
    () =>
      assertValidAiGenerationAuditEvent({
        ...validEvent(),
        postprocessActions: [
          { stage: 'P9' as never, action: 'block', matched: 'x', original_text: 'x' },
        ],
      }),
    /stage 非法/u,
  );
});

test('P8 动作：从 A5 violations 补齐 matched/original/rewritten，不复制判定', () => {
  const actions = postprocessActionsFromViolations([
    {
      stage: 'P5',
      code: 'investment_advice',
      category: 'advice',
      claim_index: 0,
      action: 'block',
      matched: '建议买入',
    },
    {
      stage: 'P6',
      code: 'prefix_rewrite',
      claim_index: 1,
      action: 'redact',
      matched: '该股上涨 3%',
      rewritten_text: '数据显示，该股上涨 3%',
    },
    {
      stage: 'P2',
      code: 'class_not_allowed',
      claim_index: 2,
      action: 'block',
      matched: '目标价 20 元',
    },
  ]);
  assert.equal(actions.length, 3);
  assert.deepEqual(actions[0], {
    stage: 'P5',
    action: 'block',
    matched: '建议买入',
    code: 'investment_advice',
    category: 'advice',
    claim_index: 0,
    original_text: '建议买入',
  });
  assert.equal(actions[1]?.rewritten_text, '数据显示，该股上涨 3%');
  assert.equal(actions[1]?.original_text, '该股上涨 3%');
  // 纯 allow 动作不强制原文/改写字段；这里验证不会误加。
  assert.equal('rewritten_text' in (actions[2] ?? {}), false);
});

test('P8 集成：host 把策略 actions 写进审计事件（经 writer 落库）', async () => {
  const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
  const writer = createAiGenerationAuditWriter({
    async query(sql, values) {
      calls.push({ sql, values });
    },
  });
  const context: PostprocessContext = {
    audience: 'c_end',
    policyVersion: 'ai-content-policy/1.1.1',
    entitlement: {
      audience: 'c_end',
      displayAllowed: true,
      internalAccessAllowed: false,
      blocked: false,
    },
    requestId: 'req-p8-host',
    userId: 'hmac-user-1',
    kind: 'stock_interpretation',
    modelFamily: 'fake-v1',
    promptVersion: 'prompt-1',
    contentVersion: 'copy-1',
    asOf: '2026-11-06T08:00:00.000Z',
    inputEvidenceHash,
  };
  const blockedDraft = {
    claims: [{ text: '建议买入', class: 'objective_fields', evidence_ids: ['e1'] }],
  };
  const result = await runPostprocessHost(
    { draft: { claims: [] }, evidence: [] },
    context,
    {
      policy: {
        async evaluate() {
          return {
            blocked: true,
            blockedDraft,
            reasonCodes: ['investment_advice'],
            outputClaims: [
              { text: '建议买入', class: 'objective_fields', evidence_ids: ['e1'] },
            ],
            actions: [
              {
                stage: 'P5',
                action: 'block',
                matched: '建议买入',
                code: 'investment_advice',
                original_text: '建议买入',
              },
            ],
          };
        },
      },
      audit: writer,
    },
  );
  assert.equal(result.blocked, true);
  assert.equal(calls.length, 1);
  const values = calls[0]?.values ?? [];
  assert.equal(values[0], 'req-p8-host');
  assert.equal(values[15], 'blocked');
  assert.equal(values[12], computeBlockedDraftHash(blockedDraft));
  assert.deepEqual(JSON.parse(String(values[14])), blockedDraft);
  assert.deepEqual(JSON.parse(String(values[13])), [
    {
      stage: 'P5',
      action: 'block',
      matched: '建议买入',
      code: 'investment_advice',
      original_text: '建议买入',
    },
  ]);
});


test('P8 writer：blocked 必须带完整 draft，passed 必须不带', () => {
  const blocked = {
    ...validEvent(),
    decision: 'blocked' as const,
    blockedDraft: { claims: [{ text: '建议买入', evidence_ids: ['e1'] }] },
  };
  assert.doesNotThrow(() => assertValidAiGenerationAuditEvent(blocked));
  assert.throws(
    () => assertValidAiGenerationAuditEvent({ ...blocked, blockedDraft: undefined }),
    /blocked_draft/u,
  );
  assert.throws(
    () => assertValidAiGenerationAuditEvent({ ...blocked, decision: 'passed' }),
    /passed/u,
  );
});

test('P8 host：blocked 的 output_hash 用完整 draft，passed 用 claims', async () => {
  const records: AiGenerationAuditEvent[] = [];
  const draft = { claims: [{ text: '建议买入', class: 'objective_fields', evidence_ids: ['e1'] }] };
  const context: PostprocessContext = {
    audience: 'c_end',
    policyVersion: 'ai-content-policy/1.1.1',
    entitlement: {
      audience: 'c_end',
      displayAllowed: true,
      internalAccessAllowed: false,
      blocked: false,
    },
    requestId: 'req-hash-blocked',
    userId: 'hmac-user-1',
    kind: 'stock_interpretation',
    modelFamily: 'fake-v1',
    promptVersion: 'prompt-1',
    contentVersion: 'copy-1',
    asOf: '2026-11-06T08:00:00.000Z',
    inputEvidenceHash,
  };
  await runPostprocessHost(
    { draft, evidence: [] },
    context,
    {
      policy: {
        async evaluate() {
          return {
            blocked: true,
            blockedDraft: draft,
            reasonCodes: ['investment_advice'],
            outputClaims: [
              { text: '建议买入', class: 'objective_fields', evidence_ids: ['e1'] },
            ],
          };
        },
      },
      audit: (record) => {
        records.push(record);
      },
    },
  );
  assert.equal(records[0]?.blockedDraft !== undefined, true);
  assert.deepEqual(records[0]?.blockedDraft, draft);
  assert.equal(records[0]?.outputHash, computeBlockedDraftHash(draft));

  records.length = 0;
  await runPostprocessHost(
    { draft, evidence: [] },
    { ...context, requestId: 'req-hash-passed' },
    {
      policy: {
        async evaluate() {
          return {
            blocked: false,
            reasonCodes: [],
            outputClaims: [{ text: '数据显示，区间收益 3%', class: 'metrics', evidence_ids: ['e1'] }],
          };
        },
      },
      audit: (record) => {
        records.push(record);
      },
    },
  );
  assert.equal(records[0]?.blockedDraft, undefined);
  assert.equal(records[0]?.outputHash, computeOutputHash([
    { text: '数据显示，区间收益 3%', class: 'metrics', evidence_ids: ['e1'] },
  ]));
});


test('P8 blocked_draft：P2 structure_invalid 也写原始完整 draft', async () => {
  const calls: { values: readonly unknown[] | undefined }[] = [];
  const writer = createAiGenerationAuditWriter({
    async query(_sql, values) {
      calls.push({ values });
    },
  });
  const draft = { claims: 'not-an-array' };
  const context: PostprocessContext = {
    audience: 'c_end',
    policyVersion: loadAiContentPolicy().policy_version,
    entitlement: {
      audience: 'c_end',
      displayAllowed: true,
      internalAccessAllowed: false,
      blocked: false,
    },
    requestId: 'req-p2-structure',
    userId: 'hmac-user-1',
    kind: 'stock_interpretation',
    modelFamily: 'fake-v1',
    promptVersion: 'prompt-1',
    contentVersion: 'copy-1',
    asOf: '2026-11-06T08:00:00.000Z',
    inputEvidenceHash,
  };
  const result = await runPostprocessHost(
    { draft, evidence: [] },
    context,
    { policy: createAiPolicyEvaluator(), audit: writer },
  );
  assert.equal(result.blocked, true);
  const values = calls[0]?.values ?? [];
  assert.equal(values.length, 18);
  assert.equal(values[15], 'blocked');
  assert.deepEqual(JSON.parse(String(values[14])), draft);
  assert.equal(values[12], computeBlockedDraftHash(draft));
});
