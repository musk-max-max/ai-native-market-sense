import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiApp } from '../src/app.js';
import type { AiConfig } from '../src/config.js';
import { FakeProvider } from '../src/provider.js';
import { createToolRegistry } from '../src/tools.js';
import { runPostprocess } from '../src/postprocess/pipeline.js';
import {
  PostprocessBlockedError,
  PostprocessHostError,
  runPostprocessHost,
  type PostprocessContext,
} from '../src/postprocess/host.js';

const config: AiConfig = {
  host: '127.0.0.1',
  port: 8081,
  logLevel: 'silent',
  serviceVersion: '0.1.0-test',
};

test('healthz 返回骨架状态，不探测外部依赖', async () => {
  const app = buildAiApp({ config, logger: false });
  try {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      status: string;
      service: string;
      version: string;
      provider: string;
      tools: number;
    }>();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'market-sense-ai');
    assert.equal(body.version, '0.1.0-test');
    assert.equal(body.provider, 'fake');
    assert.equal(body.tools, 0);
  } finally {
    await app.close();
  }
});

test('FakeProvider complete 确定、无网络，modelFamily 可写入 ai.model_family', async () => {
  const provider = new FakeProvider();
  const first = await provider.complete({ prompt: '测试' });
  const second = await provider.complete({ prompt: '测试' });
  assert.deepEqual(first, second);
  assert.equal(first.modelFamily, 'fake-v1');
  assert.match(first.text, /\[fake\]/);
});

test('FakeProvider stream 分片以 done 结束', async () => {
  const provider = new FakeProvider();
  const chunks: string[] = [];
  for await (const chunk of provider.stream({ prompt: '分片' })) {
    if (chunk.delta.length > 0) {
      chunks.push(chunk.delta);
    }
    if (chunk.done === true) {
      assert.equal(chunk.delta, '');
    }
  }
  assert.equal(chunks.join(''), '[fake] 分片');
});

test('tool registry 支持注册/查询/重复拒绝，空骨架默认 0 个工具', () => {
  const registry = createToolRegistry();
  assert.equal(registry.list().length, 0);
  registry.register({
    name: 'market.quote',
    description: '只读行情；实际实现由 A3 后续接入',
    requiredTier: 'c_end_display',
    async execute() {
      return { ok: true };
    },
  });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('market.quote')?.name, 'market.quote');
  assert.throws(() =>
    registry.register({
      name: 'market.quote',
      description: 'dup',
      requiredTier: 'c_end_display',
      async execute() {
        return null;
      },
    }),
  );
});

test('postprocess 空管线原样返回且不阻断', async () => {
  const result = await runPostprocess(
    { sections: [] },
    { audience: 'c_end', policyVersion: 'p0-skeleton' },
  );
  assert.deepEqual(result, { output: { sections: [] }, blocked: false, reasonCodes: [] });
});


const preContext: PostprocessContext = {
  audience: 'c_end',
  policyVersion: 'p0-skeleton',
  entitlement: {
    audience: 'c_end',
    displayAllowed: true,
    internalAccessAllowed: false,
    blocked: false,
  },
};

test('postprocess host：授权阻断在策略/LLM 前短路', async () => {
  await assert.rejects(
    () =>
      runPostprocessHost(
        { sections: [] },
        {
          ...preContext,
          entitlement: { ...preContext.entitlement, blocked: true },
        },
        { policy: { evaluate: async () => ({ blocked: false, reasonCodes: [] }) } },
      ),
    (error: unknown) => error instanceof PostprocessBlockedError,
  );
});

test('postprocess host：未配置策略 fail-closed（500 路径），不静默透传', async () => {
  await assert.rejects(
    () => runPostprocessHost({ sections: [] }, preContext),
    (error: unknown) => error instanceof PostprocessHostError && error.stage === 'P2-P6',
  );
});

test('postprocess host：策略异常映射为 P2-P6 失败（不透传原始输出）', async () => {
  await assert.rejects(
    () =>
      runPostprocessHost(
        { sections: [] },
        preContext,
        {
          policy: {
            async evaluate() {
              throw new Error('policy boom');
            },
          },
        },
      ),
    (error: unknown) => error instanceof PostprocessHostError && error.stage === 'P2-P6',
  );
});

test('postprocess host：策略拒绝返回确定性降级卡并审计', async () => {
  const records: unknown[] = [];
  const result = await runPostprocessHost(
    { sections: [] },
    { ...preContext, analysisId: 'a1', traceId: 't1' },
    {
      policy: {
        async evaluate() {
          return { blocked: true, reasonCodes: ['DATA_NOT_READY'] };
        },
      },
      audit: (record) => {
        records.push(record);
      },
    },
  );
  assert.equal(result.blocked, true);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.reasonCodes, ['DATA_NOT_READY']);
  assert.deepEqual(result.output, { degraded: true, reasonCodes: ['DATA_NOT_READY'] });
  assert.equal(records.length, 1);
});

test('postprocess host：审计失败 fail-closed', async () => {
  await assert.rejects(
    () =>
      runPostprocessHost(
        { sections: [] },
        preContext,
        {
          policy: { evaluate: async () => ({ blocked: false, reasonCodes: [] }) },
          audit: () => {
            throw new Error('audit boom');
          },
        },
      ),
    (error: unknown) => error instanceof PostprocessHostError && error.stage === 'P8',
  );
});
