import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { loadAiConfig, type AiConfig } from './config.js';
import { createFakeProvider, type AiProvider } from './provider.js';
import { createToolRegistry, type ToolRegistry } from './tools.js';
import { POSTPROCESS_STAGES } from './postprocess/pipeline.js';

export interface BuildAiAppOptions {
  readonly config?: AiConfig;
  readonly logger?: FastifyServerOptions['logger'];
  readonly provider?: AiProvider;
  readonly tools?: ToolRegistry;
}

/**
 * AI 服务骨架（INF-02）：Fastify + health；不暴露业务路由。
 * 业务路由（/ai/analyses、/ai/chat）由后续批次接入；本服务始终保持内部服务定位。
 */
export function buildAiApp(options: BuildAiAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadAiConfig();
  const provider = options.provider ?? createFakeProvider();
  const tools = options.tools ?? createToolRegistry();

  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'market-sense-ai',
    version: config.serviceVersion,
    provider: provider.name,
    tools: tools.list().length,
    postprocess: { stages: POSTPROCESS_STAGES.length },
  }));

  return app;
}
