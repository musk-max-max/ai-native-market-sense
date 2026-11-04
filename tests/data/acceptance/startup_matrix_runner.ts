/**
 * KD-ENT-01 启动矩阵 runner（A11，2026-11-04）。
 *
 * 黑盒驱动 A3 真实 `loadMarketConfig` + `createMarketPlugin`：
 *  - 应拒启的组合：配置解析抛错（消息分类 config_mismatch/unauthorized_config）；
 *  - 应放行的组合：用内存假仓储把插件真正挂到 fastify 并 listen 127.0.0.1:0，
 *    输出实际 listen 端口与生效的 hold/audit/sha 标志，供测试断言“默认值 fail-closed”。
 *
 * 用法：tsx tests/data/acceptance/startup_matrix_runner.ts --cases cases.json
 * 输出：一行 JSON 数组；每项 {id, started, refusal?: {category, message}, flags?, degraded?, port?}
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { loadMarketConfig } from '../../../services/market/src/config.ts';
import { createMarketPlugin } from '../../../services/market/src/plugin.ts';
import type {
  EntitlementControlRepo,
  EntitlementEventRecord,
  EntitlementEventRepo,
} from '../../../services/market/src/ports/entitlement.ts';
import type { ServingRepo } from '../../../services/market/src/ports/serving-repo.ts';
import type { WatchlistRepo } from '../../../services/market/src/ports/watchlist-repo.ts';
import type { MarketConfig } from '../../../services/market/src/config.ts';

const requireFromApi = createRequire(new URL('../../../services/api/package.json', import.meta.url));
const Fastify = requireFromApi('fastify') as typeof import('fastify').default;

interface Case {
  readonly id: string;
  readonly env: Record<string, string>;
}

function fakeServing(): ServingRepo {
  return {
    async getInstrument() { return null; },
    async getQuote() { return null; },
    async getBars() { return { rows: [], hasMore: false, adjustment: 'none' }; },
    async getLatestFactor() { return null; },
    async getFundamentalSummary() { return null; },
  } as unknown as ServingRepo;
}

function fakeWatchlist(): WatchlistRepo {
  return {
    async list() { return []; },
    async add() { return { item: { instrument_id: 'SSE:600519', added_at: new Date() }, created: true } as never; },
    async remove() { /* noop */ },
    async ensureSchema() { /* noop */ },
  };
}

/** control 行存在且新鲜：避免 allowed 组合被 “control_missing/stale” 误伤启动探测。 */
function fakeControl(): EntitlementControlRepo {
  return {
    async fetchControl() {
      return {
        hold: false,
        holdReason: null,
        lastReconciledAt: new Date(Date.now() - 60_000),
      } as never;
    },
  };
}

function fakeEvents(): EntitlementEventRepo & { records: EntitlementEventRecord[] } {
  const records: EntitlementEventRecord[] = [];
  return {
    records,
    async insert(record: EntitlementEventRecord) { records.push(record); },
  };
}

function classifyRefusal(message: string): string {
  if (/E2E 模式在生产不可用|E2E_MODE=1/.test(message)) return 'unauthorized_config';
  if (/ENTITLEMENT_CONFIG_EXPECTED_SHA256|ENTITLEMENT_EXPIRES_AT|DEPLOYMENT_UID|DISCLAIMER/.test(message)) {
    return 'config_mismatch';
  }
  if (/HOLD_CHECK|AUDIT/.test(message)) return 'config_mismatch';
  return 'config_mismatch';
}

async function runCase(c: Case): Promise<Record<string, unknown>> {
  const env = { NODE_ENV: 'test', LOG_LEVEL: 'silent', ...c.env } as NodeJS.ProcessEnv;
  let config: MarketConfig;
  try {
    config = loadMarketConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: c.id, started: false, refusal: { category: classifyRefusal(message), message } };
  }
  const app = Fastify({ logger: false });
  try {
    const plugin = createMarketPlugin({
      config,
      env,
      servingRepo: fakeServing(),
      watchlistRepo: fakeWatchlist(),
      controlRepo: fakeControl(),
      eventRepo: fakeEvents(),
    });
    await app.register(plugin);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const degraded = plugin.health ? await plugin.health() : {};
    const flags = {
      holdCheck: config.entitlementHoldCheck,
      auditEnabled: config.entitlementAuditEnabled,
      expectedSha256Present: config.entitlementExpectedSha256 !== undefined,
      tier: config.entitlementTier,
    };
    const port = Number(new URL(address).port);
    return { id: c.id, started: true, port, flags, degraded };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: c.id, started: false, refusal: { category: classifyRefusal(message), message } };
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argIndex = process.argv.indexOf('--cases');
  if (argIndex < 0) {
    console.error('usage: startup_matrix_runner.ts --cases cases.json');
    process.exit(2);
  }
  const cases = JSON.parse(readFileSync(process.argv[argIndex + 1], 'utf8')) as Case[];
  const results: Record<string, unknown>[] = [];
  for (const c of cases) results.push(await runCase(c));
  process.stdout.write(`${JSON.stringify(results)}\n`);
  void createHash;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
