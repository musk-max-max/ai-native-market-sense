/**
 * 插件层（外壳接线行为）：路由 / 状态码 / Problem 映射 / no-store。
 *
 * 说明：P0 刻意不暴露审批 HTTP 入口（审批人人类身份依赖 A0/A8 管理后台认证，待 H5+A9 签发），
 * 因此这里只测认证相关路由；审批语义在 service 层已覆盖。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { installErrorHandling } from '../../api/src/errors.js';
import { createIdentityPlugin } from '../src/plugin.js';
import { INTERNAL_EMAIL, VALID_PASSWORD, makeContext } from './helpers.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  installErrorHandling(app);
  const ctx = makeContext();
  await app.register(createIdentityPlugin({ service: ctx.service }), { prefix: '/v1' });
  await app.ready();
  return app;
}

test('POST /v1/auth/register → 201 {user_id}；重复邮箱 → 400 VALIDATION_ERROR', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'plugin@example.net', password: VALID_PASSWORD },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json<{ user_id: string }>();
  assert.match(body.user_id, /^usr_/);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'plugin@example.net', password: VALID_PASSWORD },
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.json<{ code: string }>().code, 'VALIDATION_ERROR');
  assert.match(String(duplicate.headers['content-type']), /^application\/problem\+json/);
});

test('POST /v1/auth/login → 200 token/expires_at；GET /v1/auth/me 带 Bearer 返回三字段', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'me@example.net', password: VALID_PASSWORD },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'me@example.net', password: VALID_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const { token } = login.json<{ token: string; expires_at: string }>();
  assert.ok(token.length > 0);

  const me = await app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json<Record<string, string>>(), {
    user_id: me.json<{ user_id: string }>().user_id,
    user_type: 'c_end',
    tier: 'c_end_display',
  });
  // token/个人信息响应不得被缓存。
  assert.equal(me.headers['cache-control'], 'no-store');
});

test('GET /v1/auth/me 无 token → 401 通用 Problem（title 来自 copy.ts）', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/v1/auth/me' });
  assert.equal(response.statusCode, 401);
  const body = response.json<{ code: string; title: string }>();
  assert.equal(body.code, 'UNAUTHENTICATED');
  assert.equal(body.title, '未认证');
});

test('POST /v1/internal/auth/register → 202 pending；pending 登录 403 且响应无 token', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const registered = await app.inject({
    method: 'POST',
    url: '/v1/internal/auth/register',
    payload: {
      email: INTERNAL_EMAIL,
      password: VALID_PASSWORD,
      company_email: 'alice@example.com',
    },
  });
  assert.equal(registered.statusCode, 202);
  const registeredBody = registered.json<{ application_id: string; status: string }>();
  assert.match(registeredBody.application_id, /^app_/);
  assert.equal(registeredBody.status, 'pending');

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: INTERNAL_EMAIL, password: VALID_PASSWORD },
  });
  assert.equal(login.statusCode, 403);
  const body = login.json<Record<string, unknown>>();
  assert.equal(body['code'], 'FORBIDDEN');
  assert.equal(body['token'], undefined, 'pending 登录不得返回 token');
});

test('POST /v1/auth/register：非法 body → 400 VALIDATION_ERROR（schema 层拒绝）', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'not-an-email' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json<{ code: string }>().code, 'VALIDATION_ERROR');
});
