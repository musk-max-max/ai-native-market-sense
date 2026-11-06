import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpProblemError,
  requestJson,
  newIdempotencyKey,
  pointerSegments,
  getByPointer,
  setByPointer,
  flattenWriteBody,
  patchWriteBody,
  deepClone,
  toWriteBody,
  type HttpFetch,
} from '../src/adapters/http-common';
import { configIdForItemId, itemIdForConfigId } from '../src/adapters/config-ids';
import type { WireOpsConfigDocument, WireOpsConfigWrite } from '../src/adapters/contract-types';

/** 构造 HttpFetch（测试注入；按 method/status 返回预置响应）。 */
function fakeFetch(
  handler: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  },
): { fetch: HttpFetch; calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] } {
  const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    const out = handler(url, init);
    const headers = out.headers ?? {};
    return {
      status: out.status,
      ok: out.status >= 200 && out.status < 300,
      headers: { get: (n: string) => headers[n] ?? null },
      json: async () => out.body,
      text: async () => (out.body === null || out.body === undefined ? '' : JSON.stringify(out.body)),
    };
  };
  return { fetch: fetchImpl, calls };
}

const auth = () => ({ authorization: 'Bearer tok', 'x-actor-id': 'u1' });

test('requestJson：GET 200 返回 body + ETag', async () => {
  const { fetch, calls } = fakeFetch(() => ({
    status: 200,
    headers: { ETag: '"v3"' },
    body: { version: 3 },
  }));
  const out = await requestJson(fetch, '/v1/internal/configs/ops_home_feed', auth, { method: 'GET' });
  assert.equal(out.status, 200);
  assert.equal(out.etag, '"v3"');
  assert.deepEqual(out.body, { version: 3 });
  assert.equal(calls[0]!.url, '/v1/internal/configs/ops_home_feed');
  assert.equal(calls[0]!.init?.method, 'GET');
  // accept 头
  assert.equal(calls[0]!.init?.headers?.accept, 'application/json, application/problem+json');
  // auth 头透传
  assert.equal(calls[0]!.init?.headers?.authorization, 'Bearer tok');
});

test('requestJson：4xx problem+json 抛 HttpProblemError，保留 status/code/detail/errors', async () => {
  const { fetch } = fakeFetch(() => ({
    status: 409,
    body: {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'VERSION_CONFLICT',
      detail: 'expected_version 3 != server 4',
      trace_id: 'tr_1',
      errors: [{ path: '/expected_version', code: 'MISMATCH', message: 'stale' }],
    },
  }));
  await assert.rejects(
    requestJson(fetch, '/x', auth, { method: 'PUT', body: { version: 3 } }),
    (err: unknown) => {
      assert.ok(err instanceof HttpProblemError);
      assert.equal((err as HttpProblemError).status, 409);
      assert.equal((err as HttpProblemError).problem.code, 'VERSION_CONFLICT');
      assert.equal((err as HttpProblemError).problem.detail, 'expected_version 3 != server 4');
      assert.equal((err as HttpProblemError).problem.errors?.[0]?.path, '/expected_version');
      return true;
    },
  );
});

test('requestJson：problem 非 JSON → fallback to UNKNOWN/NON_JSON', async () => {
  const fetchImpl: HttpFetch = async () => ({
    status: 500,
    ok: false,
    headers: { get: () => null },
    json: async () => null,
    text: async () => 'gateway timeout',
  });
  await assert.rejects(
    requestJson(fetchImpl, '/x', auth, { method: 'GET' }),
    (err: unknown) => {
      const e = err as HttpProblemError;
      assert.ok(e instanceof HttpProblemError);
      assert.equal(e.status, 500);
      assert.equal(e.problem.code, 'NON_JSON');
      assert.match(e.problem.title ?? '', /gateway timeout/);
      return true;
    },
  );
});

test('newIdempotencyKey：8–128 字符、前缀 idem-console-、每次不同', () => {
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  assert.match(a, /^idem-console-/);
  assert.ok(a.length >= 8 && a.length <= 128, `len ${a.length}`);
  assert.notEqual(a, b);
});

test('JSON Pointer：pointerSegments/getByPointer/setByPointer 往返', () => {
  const root = { spec: { columns: [{ id: 'c1' }, { id: 'c2' }] } };
  assert.equal(getByPointer(root, '/spec/columns/1/id'), 'c2');
  assert.deepEqual(pointerSegments('/spec/columns/0/id'), ['spec', 'columns', '0', 'id']);
  // ~1 → /，~0 → ~
  const doc = { 'a/b': { 'c~d': 1 } };
  assert.equal(getByPointer(doc, '/a~1b/c~0d'), 1);
  // setByPointer 写入嵌套
  setByPointer(root, '/spec/columns/0/visible', false);
  assert.equal(getByPointer(root, '/spec/columns/0/visible'), false);
});

test('flattenWriteBody：三根字段 + spec 深层树扁平化为 JSON Pointer', () => {
  const body: WireOpsConfigWrite = {
    schema_version: '0.1',
    config_id: 'ops_home_feed',
    environment: 'prod',
    change_reason: 'test',
    impact_scope: ['ranking'],
    spec: {
      columns: [{ id: 'c1', title: '推荐', order: 1 }],
      content_items: [],
      strategies: [{ type: 'rotation', id: 'r1', max_items: 8, interval_seconds: 300, enabled: true }],
    },
  };
  const values = flattenWriteBody(body);
  assert.equal(values['/change_reason'], 'test');
  assert.deepEqual(values['/impact_scope'], ['ranking']);
  assert.equal(values['/spec/columns/0/id'], 'c1');
  assert.equal(values['/spec/strategies/0/max_items'], 8);
});

test('patchWriteBody：扁平 values 写回完整文档，深拷贝不改入参', () => {
  const body: WireOpsConfigWrite = {
    schema_version: '0.1',
    config_id: 'ops_home_feed',
    environment: 'prod',
    change_reason: 'orig',
    impact_scope: ['ranking'],
    spec: {
      columns: [{ id: 'c1', title: '推荐', order: 1 }],
      content_items: [],
      strategies: [],
    },
  };
  const patched = patchWriteBody(body, {
    '/change_reason': 'updated',
    '/spec/columns/0/title': '改后',
  });
  assert.equal(patched.change_reason, 'updated');
  assert.equal(patched.spec.columns[0]!.title, '改后');
  assert.equal(patched.spec.columns[0]!.id, 'c1');
  // 入参未改
  assert.equal(body.change_reason, 'orig');
  assert.equal(body.spec.columns[0]!.title, '推荐');
});

test('toWriteBody：剥掉服务端维护的 version/status/meta', () => {
  const doc: WireOpsConfigDocument = {
    schema_version: '0.1',
    config_id: 'ops_home_feed',
    environment: 'prod',
    version: 4,
    status: 'published',
    change_reason: 'test',
    impact_scope: ['ranking'],
    spec: { columns: [], content_items: [], strategies: [] },
    meta: { created_at: '2026-01-01T00:00:00Z' },
  };
  const write = toWriteBody(doc);
  assert.equal(write.schema_version, '0.1');
  assert.equal(write.config_id, 'ops_home_feed');
  assert.equal(write.change_reason, 'test');
  // 契约硬要求：version/status/meta 携带即 400，故 write 体里必须没有
  assert.ok(!('version' in write));
  assert.ok(!('status' in write));
  assert.ok(!('meta' in write));
});

test('deepClone：JSON 兼容值往返', () => {
  const orig = { a: 1, b: { c: [1, 2, 3] } };
  const copy = deepClone(orig);
  assert.deepEqual(copy, orig);
  assert.notEqual(copy, orig);
  assert.notEqual((copy as { b: { c: number[] } }).b.c, orig.b.c);
});

test('config_id 映射：seed 双向、未知 config_id 原样通过、非法 itemId 抛 NOT_FOUND', () => {
  assert.equal(configIdForItemId('ops.home-feed'), 'ops_home_feed');
  assert.equal(configIdForItemId('ops.home-banner'), 'ops_home_banner');
  // 未知但形如合法 config_id → 原样通过
  assert.equal(configIdForItemId('ops_new_feature'), 'ops_new_feature');
  // 非法 itemId → NOT_FOUND
  assert.throws(() => configIdForItemId('ops.Home-Feed'), /NOT_FOUND/);
  // 反向
  assert.equal(itemIdForConfigId('ops_home_feed'), 'ops.home-feed');
  assert.equal(itemIdForConfigId('ops_new_feature'), 'ops_new_feature');
});
