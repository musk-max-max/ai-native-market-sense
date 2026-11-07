/**
 * 进程入口：加载配置 → 构造 identity authenticator → buildApp → listen；
 * SIGINT/SIGTERM 优雅关闭。
 * 只做进程生命周期管理，不含业务逻辑。
 */

// L156：identity 同 approval 用相对路径导入（同根因——pnpm deploy 后的包是 .ts 源码，Node 拒绝 node_modules type stripping）。
import {
  createIdentityAuthenticator,
  createIdentityService,
  loadIdentityConfig,
  PgIdentityStore,
} from '../../identity/src/index.js';

import { buildApp } from './app.js';
import type { Authenticator } from './auth.js';
import { loadConfig, type AppConfig } from './config.js';
import { domainPlugins } from './domains.js';

/**
 * 配置必须在创建 Fastify / listen 之前完成校验并快速失败：
 * 非法 TRUST_PROXY 等配置不允许进入 buildApp（A19 R4 验收：退出 + 日志点名 + 从未监听）。
 */
function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[config] 拒绝启动：${message}`);
    process.exit(1);
  }
}

interface IdentityBootstrap {
  readonly authenticator: Authenticator;
  readonly close: () => Promise<void>;
}

/** identity 认证器：缺凭据/配置非法时拒绝启动，绝不降级为匿名放行。 */
function bootstrapIdentityOrExit(): IdentityBootstrap {
  try {
    const identityConfig = loadIdentityConfig(process.env);
    const store = new PgIdentityStore({ connectionString: process.env.DATABASE_URL });
    const service = createIdentityService({ store, config: identityConfig });
    return {
      authenticator: createIdentityAuthenticator(service),
      close: async () => {
        await store.close();
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[identity] 拒绝启动：${message}`);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const identity = bootstrapIdentityOrExit();
const app = buildApp({ config, domainPlugins, authenticator: identity.authenticator });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => identity.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
