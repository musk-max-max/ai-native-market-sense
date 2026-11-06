import { buildAiApp } from './app.js';
import { loadAiConfig, type AiConfig } from './config.js';

function loadConfigOrExit(): AiConfig {
  try {
    return loadAiConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai-config] 拒绝启动：${message}`);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const app = buildAiApp({ config });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error, 'shutdown failed');
    process.exit(1);
  }
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, 'listen failed');
  process.exit(1);
}
