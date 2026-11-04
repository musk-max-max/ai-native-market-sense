/**
 * 进程入口：加载配置 → buildApp → listen；SIGINT/SIGTERM 优雅关闭。
 * 只做进程生命周期管理，不含业务逻辑。
 */

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { domainPlugins } from './domains.js';

const config = loadConfig();
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
