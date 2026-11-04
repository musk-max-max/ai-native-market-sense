/**
 * 外壳自测：只验证壳体行为（健康检查、插件注册、Problem 错误映射），不测试任何业务域。
 * 用 app.inject()，不监听端口、不连数据库、不依赖网络。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { HttpProblem } from '../src/errors.js';
import type { DomainPlugin } from '../src/plugin.js';

const config: AppConfig = {
  serviceName: 'market-sense-api',
  serviceVersion: '0.1.0',
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
};

function fakePlugin(domain: string, register: (app: Parameters<DomainPlugin>[0]) => void): DomainPlugin {
  return Object.assign(
    async (app) => {
      register(app);
    },
    { domain, contractVersion: '0.0.1' },
  );
}

test('/healthz 返回 200、服务名与已注册域列表', async () => {
  const app = buildApp({ config, logger: false });
  try {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { status: string; service: string; domains: string[] };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'market-sense-api');
    assert.deepEqual(body.domains, []);
  } finally {
    await app.close();
  }
});

test('域插件按 /v1 前缀注册，healthz 暴露域列表', async () => {
  const plugin = fakePlugin('market', (app) => {
    app.get('/ping', async () => ({ pong: true }));
  });
  const app = buildApp({ config, domainPlugins: [plugin], logger: false });
  try {
    const res = await app.inject({ method: 'GET', url: '/v1/ping' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { pong: true });

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.deepEqual((health.json() as { domains: string[] }).domains, ['market']);
  } finally {
    await app.close();
  }
});

test('HttpProblem 原样映射为 problem+json（含 trace_id）', async () => {
  const restrictedPlugin = fakePlugin('market', (app) => {
    app.get('/restricted', async () => {
      throw new HttpProblem(403, 'ENTITLEMENT_RESTRICTED', '无权展示', '未授权该行情等级');
    });
  });
  const app = buildApp({ config, domainPlugins: [restrictedPlugin], logger: false });
  try {
    const res = await app.inject({ method: 'GET', url: '/v1/restricted' });
    assert.equal(res.statusCode, 403);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    const body = res.json() as {
      status: number;
      code: string;
      title: string;
      trace_id: string;
    };
    assert.equal(body.status, 403);
    assert.equal(body.code, 'ENTITLEMENT_RESTRICTED');
    assert.equal(body.title, '无权展示');
    assert.equal(typeof body.trace_id, 'string');
    assert.ok(body.trace_id.length > 0);
  } finally {
    await app.close();
  }
});

test('403 响应头不得携带授权原因（X-Entitlement-Cause 及 expired/hold/stale/unauthorized）', async () => {
  // 域插件可能为排障加诊断头；外壳必须统一剥掉，响应头与 body 同判客户端可达（H3 m01498）。
  const plugin = fakePlugin('market', (app) => {
    app.get('/restricted-with-cause', async (_request, reply) => {
      reply.header('X-Entitlement-Cause', 'expired');
      throw new HttpProblem(403, 'ENTITLEMENT_RESTRICTED', '无权展示');
    });
  });
  const app = buildApp({ config, domainPlugins: [plugin], logger: false });
  try {
    const res = await app.inject({ method: 'GET', url: '/v1/restricted-with-cause' });
    assert.equal(res.statusCode, 403);
    const headerNames = Object.keys(res.headers).map((name) => name.toLowerCase());
    assert.ok(!headerNames.includes('x-entitlement-cause'));
    const headerValues = Object.values(res.headers)
      .map((value) => (Array.isArray(value) ? value.join(' ') : String(value ?? '')))
      .join(' ');
    assert.doesNotMatch(headerValues, /\b(expired|hold|stale|unauthorized)\b/i);
  } finally {
    await app.close();
  }
});

test('schema 校验失败 → 400 VALIDATION_ERROR；未知路由 → 404 NOT_FOUND；未捕获异常 → 500 INTERNAL_ERROR', async () => {
  const plugin = fakePlugin('market', (app) => {
    app.get(
      '/needs-id',
      {
        schema: {
          querystring: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    app.get('/boom', async () => {
      throw new Error('unexpected');
    });
  });
  const app = buildApp({ config, domainPlugins: [plugin], logger: false });
  try {
    const invalid = await app.inject({ method: 'GET', url: '/v1/needs-id' });
    assert.equal(invalid.statusCode, 400);
    assert.equal((invalid.json() as { code: string }).code, 'VALIDATION_ERROR');

    const missing = await app.inject({ method: 'GET', url: '/v1/nope' });
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json() as { code: string }).code, 'NOT_FOUND');
    assert.match(String(missing.headers['content-type']), /^application\/problem\+json/);

    const boom = await app.inject({ method: 'GET', url: '/v1/boom' });
    assert.equal(boom.statusCode, 500);
    const body = boom.json() as { code: string; detail?: string };
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.detail, undefined);
  } finally {
    await app.close();
  }
});

test('重复 domain 注册在启动期快速失败', () => {
  const one = fakePlugin('market', () => undefined);
  const two = fakePlugin('market', () => undefined);
  assert.throws(
    () => buildApp({ config, domainPlugins: [one, two], logger: false }),
    /重复注册 domain: market/,
  );
});

test('/healthz 合并域插件 health 贡献字段，单个贡献者失败不影响整体', async () => {
  const okPlugin: DomainPlugin = Object.assign(async () => undefined, {
    domain: 'market',
    health: async () => ({ data_ready: true, data_quality: 'ok' }),
  });
  const badPlugin: DomainPlugin = Object.assign(async () => undefined, {
    domain: 'content',
    health: async () => {
      throw new Error('report missing');
    },
  });
  const app = buildApp({ config, domainPlugins: [okPlugin, badPlugin], logger: false });
  try {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { status: string; data_ready: boolean; data_quality: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.data_ready, true);
    assert.equal(body.data_quality, 'ok');
  } finally {
    await app.close();
  }
});

test('客户端可达出口不含内部标识/英文原文（H3 文案门禁）', async () => {
  const plugin = fakePlugin('market', (app) => {
    app.get(
      '/needs-id',
      {
        schema: {
          querystring: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    app.get('/boom', async () => {
      throw new Error('unexpected internal failure');
    });
  });
  const app = buildApp({ config, domainPlugins: [plugin], logger: false });
  try {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/needs-id' }),
      app.inject({ method: 'GET', url: '/v1/nope' }),
      app.inject({ method: 'GET', url: '/v1/boom' }),
    ]);
    const forbidden = [
      /F1/,
      /tushare/i,
      /internal_eval/,
      /c_end_display/,
      /source_id/,
      /ENTITLEMENT_RESTRICTED/,
      /channel=/,
      /Required property|must be string|unexpected internal failure/i,
    ];
    for (const res of responses) {
      const body = res.body;
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(body), `响应泄漏 ${String(pattern)}: ${body}`);
      }
    }
    // title 必须来自 copy.ts 的兜底表，而不是 Fastify/Node 的英文 message。
    const missing = responses[1]!.json() as { title: string };
    assert.equal(missing.title, '资源不存在');
  } finally {
    await app.close();
  }
});

test('/v1/* 响应无条件 Cache-Control: no-store（/healthz 不加）', async () => {
  const plugin = fakePlugin('market', (app) => {
    app.get('/ping', async () => ({ pong: true }));
  });
  const app = buildApp({ config, domainPlugins: [plugin], logger: false });
  try {
    const v1 = await app.inject({ method: 'GET', url: '/v1/ping' });
    assert.equal(v1.statusCode, 200);
    assert.equal(v1.headers['cache-control'], 'no-store');
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.headers['cache-control'], undefined);
  } finally {
    await app.close();
  }
});

test('分页硬上限：limit>50 → 400（不 clamp）；offset 超窗 → 400；bars 按契约 500', async () => {
  const plugin = fakePlugin('market', (app) => {
    app.get('/items', async () => ({ items: [] }));
    app.get('/instruments/:id/bars', async () => ({ bars: [] }));
  });
  const app = buildApp({ config, domainPlugins: [plugin], logger: false });
  try {
    const tooBig = await app.inject({ method: 'GET', url: '/v1/items?limit=51' });
    assert.equal(tooBig.statusCode, 400);
    assert.equal((tooBig.json() as { code: string }).code, 'VALIDATION_ERROR');

    const ok = await app.inject({ method: 'GET', url: '/v1/items?limit=50&offset=1000' });
    assert.equal(ok.statusCode, 200);

    const offsetTooBig = await app.inject({ method: 'GET', url: '/v1/items?offset=1001' });
    assert.equal(offsetTooBig.statusCode, 400);

    const bars = await app.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/bars?limit=500' });
    assert.notEqual(bars.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('单 IP 令牌桶：超限 429 + Retry-After 整数 ≥1s + problem+json RATE_LIMITED，文案不露内部码', async () => {
  const plugin = fakePlugin('market', (app) => {
    app.get('/token', async () => ({ ok: true }));
  });
  const app = buildApp({ config, domainPlugins: [plugin], logger: false });
  try {
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 20; i += 1) {
      last = await app.inject({ method: 'GET', url: '/v1/token' });
      if (last.statusCode === 429) break;
    }
    assert.equal(last?.statusCode, 429);
    const retryAfter = String(last?.headers['retry-after'] ?? '');
    assert.match(retryAfter, /^\d+$/);
    assert.ok(Number(retryAfter) >= 1);
    assert.match(String(last?.headers['content-type']), /^application\/problem\+json/);
    const body = last?.json() as { code: string; title: string; detail?: string };
    assert.equal(body.code, 'RATE_LIMITED');
    assert.doesNotMatch(`${body.title} ${body.detail ?? ''}`, /RATE_LIMITED|limit=|bucket|window=|rate_limit_key/i);
  } finally {
    await app.close();
  }
});
