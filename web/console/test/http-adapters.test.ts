/**
 * HTTP adapter 桩测：注入 fetchImpl，验证每方法 URL/method/headers/请求体/响应映射/错误抛出。
 * 覆盖：list/get/saveDraft 成功+409+locked、validate、submit、publish、rollback、listPending、approve/reject 成功+agent 拒绝、Problem 错误。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpConsoleServices } from '../src/adapters';
import { HttpConfigService } from '../src/adapters/http-config-service';
import { HttpApprovalService } from '../src/adapters/http-approval-service';
import type { HttpFetch } from '../src/adapters/http-common';

// ---------------------------------------------------------------------------
// fake fetch（记录调用并返回预置响应）
// ---------------------------------------------------------------------------

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function fakeFetch(
  handler: (url: string, init?: Call['init']) => { status: number; headers?: Record<string, string>; body: unknown },
): { fetch: HttpFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    const out = handler(url, init);
    const headers = out.headers ?? {};
    return {
      status: out.status,
      ok: out.status >= 200 && out.status < 300,
      headers: { get: (n: string) => headers[n] ?? null },
      json: async () => out.body,
      text: async () => JSON.stringify(out.body),
    };
  };
  return { fetch: fetchImpl, calls };
}

const auth = () => ({ authorization: 'Bearer tok', 'x-actor-id': 'u1' });
const humanActor = { kind: 'human' as const, id: 'H2' };
const agentActor = { kind: 'agent' as const, id: 'A15', modelVersion: 'v1', runId: 'r1' };

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const OPS_DOC = {
  schema_version: '0.1',
  config_id: 'ops_home_feed',
  environment: 'dev',
  version: 7,
  status: 'published',
  change_reason: '首页改版',
  impact_scope: ['ranking', 'visibility'],
  spec: {
    columns: [{ id: 'hero', title: '首页焦点', order: 1, visible: true, max_items: 3 }],
    content_items: [],
    strategies: [],
  },
  meta: { created_at: '2026-11-01T10:00:00+08:00', updated_at: '2026-11-06T09:30:00+08:00' },
};

const OPS_LIST_BODY = { items: [OPS_DOC], next_cursor: null };

const SUBMIT_BODY = {
  approval_ref: 'apr_12345678-1234-7abc-8def-123456789abc',
  application_id: 'app-001',
  flow: 't1',
  status: 'submitted',
  submitted_at: '2026-11-06T09:30:00+08:00',
};

const PUBLISH_BODY = {
  release_id: 'rel_20261103abc',
  config_id: 'ops_home_feed',
  environment: 'dev',
  version: 7,
  schema_version: '0.1',
  policy_version: 'ai-content-policy/1.2.0',
  content_hash: 'sha256:aaa',
  approval_ref: 'apr_12345678-1234-7abc-8def-123456789abc',
  published_at: '2026-11-06T09:30:00+08:00',
  canary_percent: 5,
  release_notes: '首页改版灰度',
};

const ROLLBACK_BODY = {
  config_id: 'ops_home_feed',
  environment: 'dev',
  release_id: 'rel_20261103def',
  previous_release_id: 'rel_20261103abc',
  approval_ref: 'apr_12345678-1234-7abc-8def-123456789abc',
  rolled_back_at: '2026-11-06T09:30:00+08:00',
};

const CONFLICT_BODY = {
  type: 'https://errors.market-sense.invalid/conflict',
  title: '错误',
  status: 409,
  code: 'CONFLICT',
  detail: '版本冲突',
  diff: {
    config_id: 'ops_home_feed',
    environment: 'dev',
    base_version: 6,
    current_version: 7,
    submitted_version: 8,
    changes: [{ path: 'spec.columns[0].visible', kind: 'modified', base: true, current: true, submitted: false }],
    conflicts: [],
  },
};

const APPROVAL_LIST_BODY = {
  items: [
    {
      approval_ref: 'apr_12345678-1234-7abc-8def-123456789abc',
      application_id: 'app-001',
      flow: 't1',
      status: 'submitted',
      applicant: { kind: 'human', id: 'u-1001' },
      subject: { environment: 'dev', domain: 'ops_config', object_id: 'ops_home_feed', path: 'spec.strategies' },
      change: { keys: ['spec.strategies'], diff_hash: 'sha256:aaa' },
      created_at: '2026-11-06T09:30:00+08:00',
    },
  ],
  next_cursor: null,
};

const DECISION_BODY = {
  approval_ref: 'apr_12345678-1234-7abc-8def-123456789abc',
  decision: 'approved',
  decided_by: { kind: 'human', id: 'u-2001' },
  decided_at: '2026-11-06T09:30:00+08:00',
  reason: '风险可控，同意发布',
};

const RELEASE_LIST_BODY = { items: [PUBLISH_BODY], next_cursor: null };

// ---------------------------------------------------------------------------
// HttpConfigService
// ---------------------------------------------------------------------------

test('list: GET /v1/internal/configs 带环境+limit，返回 ConfigItemSummary[]', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: OPS_LIST_BODY }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const list = await svc.list();
  assert.equal(calls[0]!.url, 'http://api/v1/internal/configs?environment=dev&limit=20');
  assert.equal(calls[0]!.init?.method, 'GET');
  assert.equal(calls[0]!.init?.headers?.authorization, 'Bearer tok');
  // ops_home_feed → ops.home-feed
  assert.equal(list.length, 1);
  assert.equal(list[0]!.item.id, 'ops.home-feed');
  assert.equal(list[0]!.publishedVersion, 7);
});

test('list: 过滤掉未在 registry 的 config_id', async () => {
  const extra = { ...OPS_DOC, config_id: 'ops_unknown_item' };
  const { fetch } = fakeFetch(() => ({ status: 200, body: { items: [OPS_DOC, extra], next_cursor: null } }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const list = await svc.list();
  assert.equal(list.length, 1);
});

test('get: GET /v1/internal/configs/{config_id} → ConfigItemDetail（含 published+releases）', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes('/releases')) return { status: 200, body: RELEASE_LIST_BODY };
    return { status: 200, headers: { ETag: '"v7"' }, body: OPS_DOC };
  });
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const detail = await svc.get('ops.home-feed');
  assert.equal(detail.item.id, 'ops.home-feed');
  assert.equal(detail.published.version, 7);
  assert.equal(detail.releases.length, 1);
  assert.equal(detail.releases[0]!.releaseId, 'rel_20261103abc');
  // 两次请求：GET config + GET releases
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/v1\/internal\/configs\/ops_home_feed\?environment=dev$/);
});

test('get: 未知 itemId 抛 ConfigGateError(NOT_FOUND)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: OPS_DOC }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.get('nonexistent.item'),
    (error: Error & { code?: string }) => error.name === 'ConfigGateError' && error.code === 'NOT_FOUND',
  );
});

test('saveDraft: PUT 带 If-Match "v<n>" → ok:true 返回 DraftConfig', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: OPS_DOC }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const outcome = await svc.saveDraft({
    itemId: 'ops.home-feed',
    expectedVersion: 6,
    values: { '/change_reason': '改版', '/impact_scope': ['ranking'] },
    actor: humanActor,
    changeReason: '改版',
    impactScope: ['ranking'],
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.draft.baseVersion, 6);
    assert.equal(outcome.draft.state, 'draft');
  }
  assert.equal(calls[0]!.init?.method, 'PUT');
  assert.equal(calls[0]!.init?.headers?.['if-match'], '"v6"');
  const body = JSON.parse(calls[0]!.init?.body ?? '{}');
  assert.equal(body.change_reason, '改版');
  assert.deepEqual(body.impact_scope, ['ranking']);
  // 不含 version/status/meta（服务端维护）
  assert.equal('version' in body, false);
  assert.equal('status' in body, false);
  assert.equal('meta' in body, false);
});

test('saveDraft: 409 → ok:false kind:conflict，冲突字段映射正确', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 409, body: CONFLICT_BODY }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const outcome = await svc.saveDraft({
    itemId: 'ops.home-feed',
    expectedVersion: 7,
    values: {},
    actor: humanActor,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok && outcome.kind === 'conflict') {
    assert.equal(outcome.conflict.currentVersion, 7);
    assert.match(outcome.conflict.message, /409 冲突/);
  } else {
    assert.fail('expected conflict');
  }
  assert.equal(calls[0]!.init?.headers?.['if-match'], '"v7"');
});

test('saveDraft: 锁定项返回 locked，不发 HTTP 请求', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 500, body: {} }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const outcome = await svc.saveDraft({
    itemId: 'compliance.disclaimer',
    expectedVersion: 1,
    values: {},
    actor: humanActor,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.kind, 'locked');
  assert.equal(calls.length, 0);
});

test('validate: POST .../validate → ValidationOutcome', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes('/validate')) {
      return { status: 200, body: { valid: true, structural_errors: [], semantic_errors: [], normalized_hash: 'sha256:aaa' } };
    }
    return { status: 200, body: OPS_DOC };
  });
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const outcome = await svc.validate('ops.home-feed', humanActor);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.state, 'validated');
  assert.equal(outcome.issues.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.init?.method, 'POST');
  assert.match(calls[1]!.url, /\/validate\?environment=dev$/);
});

test('validate: 服务端报错 → ok:false issues 映射', async () => {
  const { fetch } = fakeFetch((url) => {
    if (url.includes('/validate')) {
      return {
        status: 200,
        body: {
          valid: false,
          structural_errors: [{ path: '/spec/columns/0/order', code: 'REQUIRED', message: '必填' }],
          semantic_errors: [{ path: '/spec/strategies/0/limit', code: 'RANGE', message: '范围错误' }],
        },
      };
    }
    return { status: 200, body: OPS_DOC };
  });
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const outcome = await svc.validate('ops.home-feed', humanActor);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.issues.length, 2);
  assert.equal(outcome.issues[0]!.field, '/spec/columns/0/order');
  assert.equal(outcome.issues[1]!.field, '/spec/strategies/0/limit');
});

test('submitForApproval: POST .../submit → ChangeRequest，approval_ref 暂存', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes('/submit')) return { status: 200, body: SUBMIT_BODY };
    return { status: 200, body: OPS_DOC };
  });
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const cr = await svc.submitForApproval({ itemId: 'ops.home-feed', actor: humanActor, diffAcknowledged: true });
  assert.equal(cr.state, 'pending_approval');
  assert.equal(cr.itemId, 'ops.home-feed');
  assert.match(calls[1]!.url, /\/submit\?environment=dev$/);
  const body = JSON.parse(calls[1]!.init?.body ?? '{}');
  assert.equal(body.expected_version, 7);
  // approval_ref 已暂存
  const publishFetch = fakeFetch((url) => {
    if (url.includes('/publish')) return { status: 200, body: PUBLISH_BODY };
    if (url.includes('/submit')) return { status: 200, body: SUBMIT_BODY };
    return { status: 200, body: OPS_DOC };
  });
  const svc2 = new HttpConfigService({ fetchImpl: publishFetch.fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await svc2.submitForApproval({ itemId: 'ops.home-feed', actor: humanActor, diffAcknowledged: true });
  const release = await svc2.publish({ itemId: 'ops.home-feed', changeRequestId: cr.id, actor: humanActor, diffAcknowledged: true, canaryPercent: 5 });
  assert.equal(release.releaseId, 'rel_20261103abc');
});

test('publish: POST .../publish approval_ref+expected_version+canary_percent', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes('/publish')) return { status: 200, body: PUBLISH_BODY };
    if (url.includes('/submit')) return { status: 200, body: SUBMIT_BODY };
    return { status: 200, body: OPS_DOC };
  });
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await svc.submitForApproval({ itemId: 'ops.home-feed', actor: humanActor, diffAcknowledged: true });
  const release = await svc.publish({ itemId: 'ops.home-feed', changeRequestId: 'apr_x', actor: humanActor, diffAcknowledged: true, canaryPercent: 5 });
  assert.equal(release.releaseId, 'rel_20261103abc');
  assert.equal(release.version, 7);
  assert.equal(release.authorization.kind, 'human_approval');
  const pubCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/publish'));
  assert.ok(pubCall);
  const body = JSON.parse(pubCall!.init?.body ?? '{}');
  assert.equal(body.approval_ref, 'apr_12345678-1234-7abc-8def-123456789abc');
  assert.equal(body.expected_version, 7);
  assert.equal(body.canary_percent, 5);
});

test('publish: canary_percent 越界（0 或 11）抛 ConfigGateError(INVALID)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: OPS_DOC }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.publish({ itemId: 'ops.home-feed', changeRequestId: 'x', actor: humanActor, diffAcknowledged: true, canaryPercent: 0 }),
    (error: Error & { code?: string }) => error.name === 'ConfigGateError' && error.code === 'INVALID',
  );
  await assert.rejects(
    () => svc.publish({ itemId: 'ops.home-feed', changeRequestId: 'x', actor: humanActor, diffAcknowledged: true, canaryPercent: 11 }),
    (error: Error & { code?: string }) => error.name === 'ConfigGateError' && error.code === 'INVALID',
  );
});

test('publish: 无 submit 前置抛 ConfigGateError(NO_APPROVAL)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: OPS_DOC }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.publish({ itemId: 'ops.home-feed', changeRequestId: 'x', actor: humanActor, diffAcknowledged: true }),
    (error: Error & { code?: string }) => error.name === 'ConfigGateError' && error.code === 'NO_APPROVAL',
  );
});

test('rollback: POST .../rollback target_release_id+approval_ref 必填', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes('/rollback')) return { status: 200, body: ROLLBACK_BODY };
    if (url.includes('/releases')) return { status: 200, body: RELEASE_LIST_BODY };
    return { status: 200, body: OPS_DOC };
  });
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const release = await svc.rollback({
    itemId: 'ops.home-feed',
    targetVersion: 7,
    actor: humanActor,
    diffAcknowledged: true,
    reason: '回滚至上一版本',
    approvalRef: 'apr_12345678-1234-7abc-8def-123456789abc',
  });
  assert.equal(release.rolledBackFrom, 'rel_20261103abc');
  const rbCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/rollback'));
  assert.ok(rbCall);
  const body = JSON.parse(rbCall!.init?.body ?? '{}');
  assert.equal(body.target_release_id, 'rel_20261103abc');
  assert.equal(body.approval_ref, 'apr_12345678-1234-7abc-8def-123456789abc');
  assert.equal(body.reason, '回滚至上一版本');
});

test('rollback: agent 抛 ConfigGateError(STATE)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: ROLLBACK_BODY }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.rollback({ itemId: 'ops.home-feed', targetVersion: 7, actor: agentActor, diffAcknowledged: true, reason: 'x', approvalRef: 'apr' }),
    (error: Error & { code?: string }) => error.name === 'ConfigGateError' && error.code === 'STATE',
  );
});

test('rollback: 缺 approvalRef 抛 ConfigGateError(NO_APPROVAL)', async () => {
  const { fetch } = fakeFetch((url) => {
    if (url.includes('/releases')) return { status: 200, body: RELEASE_LIST_BODY };
    return { status: 200, body: {} };
  });
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.rollback({ itemId: 'ops.home-feed', targetVersion: 7, actor: humanActor, diffAcknowledged: true, reason: 'reason' }),
    (error: Error & { code?: string }) => error.name === 'ConfigGateError' && error.code === 'NO_APPROVAL',
  );
});

test('listReleases: GET /v1/internal/releases?config_id → Release[]', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: RELEASE_LIST_BODY }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const releases = await svc.listReleases('ops.home-feed');
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.releaseId, 'rel_20261103abc');
  assert.match(calls[0]!.url, /\/v1\/internal\/releases\?config_id=ops_home_feed&environment=dev&limit=20$/);
});

test('Problem 错误：400/401/403/404 透传 HttpProblemError', async () => {
  const { fetch } = fakeFetch(() => ({
    status: 403,
    body: { type: 'about:blank', title: '错误', status: 403, code: 'FORBIDDEN', detail: '越权' },
  }));
  const svc = new HttpConfigService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.list(),
    (error: Error & { status?: number }) => error.name === 'HttpProblemError' && error.status === 403,
  );
});

// ---------------------------------------------------------------------------
// HttpApprovalService
// ---------------------------------------------------------------------------

test('listPending: GET /v1/internal/approvals → 只暴露 ops_config 域 pending 状态', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: APPROVAL_LIST_BODY }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const pending = await svc.listPending();
  assert.equal(calls[0]!.url, 'http://api/v1/internal/approvals?environment=dev&limit=20');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.changeRequest.id, 'apr_12345678-1234-7abc-8def-123456789abc');
  assert.equal(pending[0]!.changeRequest.itemId, 'ops.home-feed');
  assert.equal(pending[0]!.changeRequest.state, 'pending_approval');
});

test('listPending: 过滤掉非 ops_config 域和非 pending 状态', async () => {
  const mixed = {
    items: [
      { ...APPROVAL_LIST_BODY.items[0], approval_ref: 'apr_pending', status: 'submitted', subject: { ...APPROVAL_LIST_BODY.items[0].subject, domain: 'ops_config' } },
      { ...APPROVAL_LIST_BODY.items[0], approval_ref: 'apr_rbac', status: 'submitted', subject: { ...APPROVAL_LIST_BODY.items[0].subject, domain: 'rbac' } },
      { ...APPROVAL_LIST_BODY.items[0], approval_ref: 'apr_done', status: 'approved', subject: { ...APPROVAL_LIST_BODY.items[0].subject, domain: 'ops_config' } },
    ],
    next_cursor: null,
  };
  const { fetch } = fakeFetch(() => ({ status: 200, body: mixed }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const pending = await svc.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.changeRequest.id, 'apr_pending');
});

test('approve: POST .../decision approved，Idempotency-Key 头存在', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: DECISION_BODY }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const cr = await svc.approve({
    changeRequestId: 'apr_12345678-1234-7abc-8def-123456789abc',
    actor: humanActor,
    approvalRef: 'apr_12345678-1234-7abc-8def-123456789abc',
    diffAcknowledged: true,
    note: '同意发布，风险可控',
  });
  assert.equal(cr.state, 'approved');
  assert.equal(cr.authorization?.kind, 'human_approval');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.match(calls[0]!.url, /\/decision$/);
  assert.ok(calls[0]!.init?.headers?.['idempotency-key']);
  const body = JSON.parse(calls[0]!.init?.body ?? '{}');
  assert.equal(body.decision, 'approved');
  assert.ok(body.reason.length >= 8);
});

test('approve: agent 抛 ApprovalAuthorityError(AGENT_CANNOT_FINAL_APPROVE)', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: DECISION_BODY }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.approve({ changeRequestId: 'apr_x', actor: agentActor, approvalRef: 'apr_x', diffAcknowledged: true }),
    (error: Error & { code?: string }) => error.name === 'ApprovalAuthorityError' && error.code === 'AGENT_CANNOT_FINAL_APPROVE',
  );
  assert.equal(calls.length, 0);
});

test('approve: reason <8 字抛 ApprovalAuthorityError(STATE)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: DECISION_BODY }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.approve({ changeRequestId: 'apr_x', actor: humanActor, approvalRef: 'apr_x', diffAcknowledged: true, note: '同意' }),
    (error: Error & { code?: string }) => error.name === 'ApprovalAuthorityError' && error.code === 'STATE',
  );
});

test('approve: 缺 approvalRef 抛 ApprovalAuthorityError(APPROVAL_REF_REQUIRED)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: DECISION_BODY }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.approve({ changeRequestId: 'x', actor: humanActor, approvalRef: '', diffAcknowledged: true }),
    (error: Error & { code?: string }) => error.name === 'ApprovalAuthorityError' && error.code === 'APPROVAL_REF_REQUIRED',
  );
});

test('reject: POST .../decision rejected，reason 必填', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ...DECISION_BODY, decision: 'rejected' } }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  const cr = await svc.reject({
    changeRequestId: 'apr_12345678-1234-7abc-8def-123456789abc',
    actor: humanActor,
    reason: '风险过高，驳回本次发布',
  });
  assert.equal(cr.state, 'rejected');
  const body = JSON.parse(calls[0]!.init?.body ?? '{}');
  assert.equal(body.decision, 'rejected');
  assert.ok(body.reason.length >= 8);
});

test('reject: agent 抛 ApprovalAuthorityError(HUMAN_ONLY)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: DECISION_BODY }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.reject({ changeRequestId: 'apr_x', actor: agentActor, reason: '驳回原因足够长' }),
    (error: Error & { code?: string }) => error.name === 'ApprovalAuthorityError' && error.code === 'HUMAN_ONLY',
  );
});

test('reject: reason 为空抛 ApprovalAuthorityError(STATE)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: DECISION_BODY }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.reject({ changeRequestId: 'apr_x', actor: humanActor, reason: '' }),
    (error: Error & { code?: string }) => error.name === 'ApprovalAuthorityError' && error.code === 'STATE',
  );
});

test('Problem 错误：403 decision 透传 HttpProblemError', async () => {
  const { fetch } = fakeFetch(() => ({
    status: 403,
    body: { type: 'about:blank', title: '错误', status: 403, code: 'FORBIDDEN', detail: '越权' },
  }));
  const svc = new HttpApprovalService({ fetchImpl: fetch, baseUrl: 'http://api', environment: 'dev', authHeaders: auth });
  await assert.rejects(
    () => svc.approve({ changeRequestId: 'apr_x', actor: humanActor, approvalRef: 'apr_x', diffAcknowledged: true, note: '同意发布，理由充分' }),
    (error: Error & { status?: number }) => error.name === 'HttpProblemError' && error.status === 403,
  );
});

// ---------------------------------------------------------------------------
// createHttpConsoleServices factory
// ---------------------------------------------------------------------------

test('createHttpConsoleServices: 返回三端口实例', () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: {} }));
  const services = createHttpConsoleServices({ baseUrl: 'http://api', environment: 'dev', authHeaders: auth, fetchImpl: fetch });
  assert.ok(services.config instanceof HttpConfigService);
  assert.ok(services.approval instanceof HttpApprovalService);
  assert.ok(services.audit);
});

test('createHttpConsoleServices: audit.listAudit 返回空数组（契约未开放）', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: {} }));
  const services = createHttpConsoleServices({ baseUrl: 'http://api', environment: 'dev', authHeaders: auth, fetchImpl: fetch });
  const events = await services.audit.listAudit();
  assert.deepEqual(events, []);
});
