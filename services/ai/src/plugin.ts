/**
 * AI 域插件入口：导出外壳（services/api/src/domains.ts）可挂载的 Fastify plugin。
 *
 * 接线约定（A0/ADR-007 D1 回退方案）：
 *  - `aiPlugin` 由 domains.ts 挂载到 /v1（待 H2 复核）；
 *  - 依赖从 env 自建（AI_DATABASE_URL 自建 pg pool，onClose 关闭）；
 *  - 错误一律 throw HttpProblem；/v1/* no-store 由外壳统一兜底；
 *  - P8 审计为 fail-closed 硬依赖：未注入 audit 且缺 AI_DATABASE_URL → 启动失败（L27 确定性配置错误）。
 *
 * 测试可用 createAiPlugin({ provider, evidence, policyEvaluator, audit, authenticate, store }) 注入假实现。
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';

import type { DomainPlugin, DomainPluginOptions } from '../../api/src/plugin.js';
import {
  AnalysesService,
  InMemoryAnalysisStore,
  type AiPrincipal,
  type AnalysesPolicyEvaluator,
  type AnalysisStore,
} from './domain/analyses.js';
import { httpEvidenceSource, type EvidenceSource } from './evidence.js';
import { deriveContentVersion } from './domain/analyses.js';
import { createAiGenerationAuditWriter, type AiGenerationAuditEvent } from './postprocess/audit.js';
import { createAiPolicyEvaluator } from './postprocess/policy-evaluator.js';
import { createFakeProvider, type AiProvider } from './provider.js';
import { registerAnalysesRoutes, type AiAuthenticate } from './routes/analyses.js';

export interface AiPluginOptions {
  /** 显式环境（测试）；缺省 process.env。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly provider?: AiProvider;
  readonly evidence?: EvidenceSource;
  readonly policyEvaluator?: AnalysesPolicyEvaluator;
  /** P8 审计写入；缺省用 AI_DATABASE_URL 自建 pool + A5 createAiGenerationAuditWriter。 */
  readonly audit?: (event: AiGenerationAuditEvent) => void | Promise<void>;
  readonly pool?: Pool;
  readonly authenticate?: AiAuthenticate;
  /** 幂等/检索用存储；P0 为内存 store（持久化留 P1，DDL 归 A5/A13）。 */
  readonly store?: AnalysisStore;
  /** HMAC(user) 键；缺省退化 sha256('ai|'+userId)（仍不可逆，不落明文）。 */
  readonly userHashKey?: string;
  readonly promptVersion?: string;
  /** P7 文案版本；缺省 COPY_VERSION+'.'+COPY_TEXT_HASH[:12]。 */
  readonly contentVersion?: string;
}

function buildAuditFromPool(pool: Pool): (event: AiGenerationAuditEvent) => Promise<void> {
  return createAiGenerationAuditWriter({
    query: (sql: string, values?: unknown[]) => pool.query(sql, values as unknown[]),
  });
}

async function installAiPlugin(app: FastifyInstance, options: AiPluginOptions): Promise<void> {
  const env = options.env ?? process.env;

  const needsPool = options.audit === undefined;
  const pool =
    options.pool ??
    (needsPool
      ? env.AI_DATABASE_URL !== undefined && env.AI_DATABASE_URL.trim() !== ''
        ? new Pool({
            connectionString: env.AI_DATABASE_URL,
            connectionTimeoutMillis: 1000,
            query_timeout: 1000,
            statement_timeout: 1000,
          })
        : null
      : null);
  if (options.audit === undefined && pool === null) {
    // P8 fail-closed：没有审计后端就不生成（不产生半条审计，ADR-007 D2）。
    throw new Error(
      'services/ai 启动失败：缺少 AI_DATABASE_URL（或通过 AiPluginOptions.audit 注入审计写入）',
    );
  }
  const audit = options.audit ?? buildAuditFromPool(pool as Pool);

  const provider = options.provider ?? createFakeProvider();
  const evidence =
    options.evidence ??
    httpEvidenceSource({
      ...(env.MARKET_API_URL !== undefined && env.MARKET_API_URL.trim() !== ''
        ? { baseUrl: env.MARKET_API_URL.trim() }
        : {}),
    });
  const policyEvaluator = options.policyEvaluator ?? createAiPolicyEvaluator();
  const store = options.store ?? new InMemoryAnalysisStore();

  const service = new AnalysesService({
    evidence,
    provider,
    policyEvaluator,
    audit,
    store,
    ...(env.AI_PROMPT_VERSION !== undefined && env.AI_PROMPT_VERSION.trim() !== ''
      ? { promptVersion: env.AI_PROMPT_VERSION.trim() }
      : {}),
    ...(env.AI_USER_HASH_KEY !== undefined && env.AI_USER_HASH_KEY.trim() !== ''
      ? { userHashKey: env.AI_USER_HASH_KEY.trim() }
      : options.userHashKey !== undefined
        ? { userHashKey: options.userHashKey }
        : {}),
    contentVersion: options.contentVersion ?? deriveContentVersion(),
  });

  registerAnalysesRoutes(app, {
    service,
    ...(options.authenticate !== undefined ? { authenticate: options.authenticate } : {}),
  });

  if (options.pool === undefined && pool !== null) {
    const ownedPool = pool;
    app.addHook('onClose', async () => {
      await ownedPool.end();
    });
  }
}

export interface AiDomainPlugin extends DomainPlugin {
  readonly health: () => Promise<Record<string, unknown>>;
}

function buildPlugin(options: AiPluginOptions, providerName: () => string): AiDomainPlugin {
  return Object.assign(
    (async (app: FastifyInstance, _options: DomainPluginOptions) => {
      await installAiPlugin(app, options);
    }) as FastifyPluginAsync<DomainPluginOptions>,
    {
      domain: 'ai',
      contractVersion: '0.1.0',
      health: async () => ({
        ai: { service: 'market-sense-ai', provider: providerName(), policy: 'ai-content-policy/1.1.2' },
      }),
    } as const,
  );
}

/** 无参版本（外壳挂载用）：配置从 process.env 读取（AI_DATABASE_URL/AI_USER_HASH_KEY/MARKET_API_URL）。 */
export const aiPlugin: AiDomainPlugin = buildPlugin({ env: process.env }, () =>
  process.env.AI_PROVIDER_NAME ?? 'fake',
);

/** 单测/证据脚本工厂：显式注入 provider/证据源/策略/审计/认证，避免起 PG。 */
export function createAiPlugin(options: AiPluginOptions = {}): AiDomainPlugin {
  return buildPlugin(options, () => options.provider?.name ?? 'fake');
}

export type { AiPrincipal };
