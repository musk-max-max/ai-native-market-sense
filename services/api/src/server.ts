/**
 * 进程入口：加载配置 → buildApp → listen；SIGINT/SIGTERM 优雅关闭。
 * 只做进程生命周期管理，不含业务逻辑。
 */

import { buildApp } from './app.js';
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

const config = loadConfigOrExit();
const app = buildApp({ config, domainPlugins });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
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
