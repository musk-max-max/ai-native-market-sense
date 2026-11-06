/**
 * Fastify 实例工厂：外壳唯一入口。
 *
 * 职责（且仅这些）：
 *   1. 加载配置
 *   2. 创建 Fastify 实例（日志级别、trustProxy）
 *   3. 安装全局错误映射（Problem）
 *   4. 注册域插件（/v1 前缀）
 *   5. 注册 /healthz
 *
 * 不注册业务路由、不连数据库、不 import 任何域内部实现。
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { installAuth, type Authenticator } from './auth.js';
import { DEFAULT_RATE_LIMIT, loadConfig, type AppConfig } from './config.js';
import { installErrorHandling } from './errors.js';
import { registerDomainPlugins, type DomainPlugin } from './plugin.js';
import { installRateLimit } from './rate-limit.js';
import { registerHealthRoute } from './routes/health.js';

export interface BuildAppOptions {
  /** 注入配置（测试用）；缺省从环境变量加载 */
  readonly config?: AppConfig;
  /** 域插件；测试可注入 fake 插件验证注册/错误映射 */
  readonly domainPlugins?: readonly DomainPlugin[];
  /** Fastify logger 开关；测试传 false */
  readonly logger?: boolean;
  /** 认证器；缺省即默认拒绝（公开路径之外一律 401）。生产由 server 注入 identity authenticator。 */
  readonly authenticator?: Authenticator;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
  });

  installErrorHandling(app);
  installRateLimit(app, config.rateLimit ?? DEFAULT_RATE_LIMIT);
  installAuth(
    app,
    options.authenticator === undefined ? {} : { authenticator: options.authenticator },
  );

  // 行情响应带 as_of：缓存一次就是一次静默的陈旧。所有 /v1/* 无条件 no-store，
  // 不按响应内容判断（否则每新增一个接口都可能漏配）。
  // 同一出口统一剥掉诊断头：响应头与 body 同判客户端可达（ADR-006 D4），
  // 授权原因只进服务端事件/日志，不随 403 下发（H3 m01498）。
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/v1/')) {
      reply.header('cache-control', 'no-store');
      reply.removeHeader('x-entitlement-cause');
    }
    return payload;
  });

  const plugins = options.domainPlugins ?? [];
  const domains = registerDomainPlugins(app, plugins, { prefix: '/v1' });
  registerHealthRoute(app, {
    config,
    domains,
    contributors: plugins.flatMap((p) => (p.health ? [p.health] : [])),
  });

  return app;
}
