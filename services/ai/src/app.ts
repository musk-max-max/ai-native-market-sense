import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { installErrorHandling } from '../../api/src/errors.js';
import { loadAiConfig, type AiConfig } from './config.js';
import { createAiPlugin, type AiPluginOptions } from './plugin.js';
import { createFakeProvider, type AiProvider } from './provider.js';
import { createToolRegistry, type ToolRegistry } from './tools.js';
import { POSTPROCESS_STAGES } from './postprocess/pipeline.js';

export interface BuildAiAppOptions {
  readonly config?: AiConfig;
  readonly logger?: FastifyServerOptions['logger'];
  readonly provider?: AiProvider;
  readonly tools?: ToolRegistry;
  /**
   * 业务路由（POST /v1/ai/analyses、GET /v1/ai/analyses/{analysis_id}）装配参数。
   * 传入即挂载（或 env 存在 AI_DATABASE_URL 时以默认参数挂载）；否则仅 /healthz（INF-02 骨架形态）。
   */
  readonly ai?: AiPluginOptions;
}

/**
 * AI 服务（INF-02 + AI1）：Fastify + health + /v1/ai/analyses 业务路由。
 * 本服务保持内部服务定位（不直面客）；经外壳 domain 插件挂载时鉴权/no-store/限流由外壳统一负责。
 */
export function buildAiApp(options: BuildAiAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadAiConfig();
  const provider = options.provider ?? createFakeProvider();
  const tools = options.tools ?? createToolRegistry();

  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
  });

  // 与外壳同构：HttpProblem → Problem；未捕获异常 → 500（standalone 也需要统一错误出口）。
  installErrorHandling(app);

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'market-sense-ai',
    version: config.serviceVersion,
    provider: provider.name,
    tools: tools.list().length,
    postprocess: { stages: POSTPROCESS_STAGES.length },
  }));

  const aiOptions = options.ai ?? (process.env.AI_DATABASE_URL !== undefined ? {} : undefined);
  if (aiOptions !== undefined) {
    app.register(createAiPlugin({ ...aiOptions, provider }), { prefix: '/v1' });
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'no-store');
      return payload;
    });
  }

  return app;
}
