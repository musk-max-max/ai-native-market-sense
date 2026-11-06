/**
 * 外壳 × identity 接线自测：验证 A0 的默认拒绝 preHandler 与 A4 identity 插件
 * 在同一条请求链上工作（不连数据库、不监听端口）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createIdentityAuthenticator,
  createIdentityService,
  loadIdentityConfig,
  MemoryIdentityStore,
} from '@market-sense/identity';
import { createIdentityPlugin } from '@market-sense/identity/plugin';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { DomainPlugin } from '../src/plugin.js';

const config: AppConfig = {
  serviceName: 'market-sense-api',
  serviceVersion: '0.1.0',
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
};

const identityConfig = loadIdentityConfig({
  IDENTITY_JWT_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv);
const store = new MemoryIdentityStore();
const service = createIdentityService({ store, config: identityConfig });
const identity = createIdentityPlugin({ service });
const authenticator = createIdentityAuthenticator(service);

const whoami = Object.assign(
  async (app: Parameters<DomainPlugin>[0]) => {
    app.get('/whoami', async (request) => ({
      user_id: request.user?.userId ?? null,
      audience: request.audience,
    }));
  },
  { domain: 'smoke', contractVersion: '0.0.1' },
) satisfies DomainPlugin;

test('identity 公开路由经 preHandler 可达，默认拒绝与 Bearer 认证语义正确', async () => {
  const app = buildApp({
    authenticator,
    config,
    domainPlugins: [identity, whoami],
    logger: false,
  });
  try {
    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'smoke@example.com', password: 'correct horse battery' },
    });
    assert.equal(register.statusCode, 201, register.body);
    const userId = (register.json() as { user_id: string }).user_id;
    assert.ok(userId.length > 0);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'smoke@example.com', password: 'correct horse battery' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const token = (login.json() as { token: string }).token;
    assert.ok(token.length > 0);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.statusCode, 200, me.body);

    const denied = await app.inject({ method: 'GET', url: '/v1/whoami' });
    assert.equal(denied.statusCode, 401, denied.body);

    const allowed = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal((allowed.json() as { user_id: string }).user_id, userId);
    assert.equal((allowed.json() as { audience: string }).audience, 'c_end');

    const internal = await app.inject({
      method: 'POST',
      url: '/v1/internal/auth/register',
      payload: {
        email: 'internal@example.com',
        password: 'correct horse battery',
        company_email: 'internal@example.com',
      },
    });
    assert.notEqual(internal.statusCode, 404, internal.body);
    assert.notEqual(internal.statusCode, 401, internal.body);
  } finally {
    await app.close();
  }
});
