/**
 * 域插件入口：导出 shell 可挂载的 Fastify plugin（A0 负责 app 实例/注册/全局错误映射/入口）。
 *
 * 接线约定（A0 2026-11-04）：
 *  - `marketPlugin` 由 domains.ts `import { marketPlugin } from '../../market/src/plugin.js'` 挂载到 /v1；
 *  - 依赖由插件从 env 自建（外壳不注入 DB）；
 *  - 自建连接池时注册 `onClose` hook 结束 pool（优雅关闭不泄漏连接）；
 *  - 错误一律 throw HttpProblem，trace_id 由外壳 request.id 注入。
 *
 * 授权（H4/H5/Lead）：
 *  - 每请求闸门 EntitlementGate：本地时间盒 → control 行（hold/新鲜度）→ env tier；
 *  - 启动探测：control 表不存在/无权限等确定性错误 → crashloop（L27）；瞬态故障 → degraded_unauthorized；
 *  - 审计事件（audit.entitlement_events）仅在 A5 DDL + A13 GRANT 落地后通过 env 打开；
 *  - 所有响应（含 getInstrument 200）一律 `Cache-Control: no-store`（H4 m00840/L36）。
 *
 * 测试可用 `createMarketPlugin({ config, servingRepo, watchlistRepo, authenticate, controlRepo, eventRepo })` 注入假实现。
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';

import type { DomainPlugin, DomainPluginOptions } from '../../api/src/plugin.js';
import { PgEntitlementControlRepo } from './adapters/pg-entitlement-control-repo.js';
import { PgEntitlementEventRepo } from './adapters/pg-entitlement-event-repo.js';
import { PgDataPlatformRepo } from './adapters/pg-data-platform-repo.js';
import { PgServingRepo } from './adapters/pg-serving-repo.js';
import { PgWatchlistRepo } from './adapters/pg-watchlist-repo.js';
import { createAuthenticator, type Authenticate } from './auth.js';
import { SnapshotCache } from './cache.js';
import {
  assertEntitlementTimebox,
  isProductionProfile,
  loadMarketConfig,
  MarketConfigError,
  type MarketConfig,
} from './config.js';
import { configFingerprint, resolveEntitlement, type EntitlementResolution } from './domain/entitlement.js';
import {
  EntitlementEventWriter,
  expiredEventKey,
  observedEventKey,
  unauthorizedEventKey,
} from './domain/entitlement-events.js';
import { EntitlementGate } from './domain/entitlement-gate.js';
import {
  type EventPayloadContract,
  loadEventPayloadContract,
} from './domain/event-payload-contract.js';
import { createMarketHealthContribution, type HealthContribution } from './health.js';
import {
  classifyWriteError,
  type EntitlementControlRepo,
  type EntitlementEventRepo,
} from './ports/entitlement.js';
import type { ServingRepo } from './ports/serving-repo.js';
import type { DataPlatformRepo } from './ports/data-platform-repo.js';
import type { WatchlistRepo } from './ports/watchlist-repo.js';
import { registerMarketRoutes } from './routes.js';
import { registerB1Routes } from './routes-b1.js';
import { registerDataPlatformRoutes } from './routes-data-platform.js';

export interface MarketPluginOptions {
  /** 显式配置（测试）；缺省从 env 读取 */
  readonly config?: MarketConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly servingRepo?: ServingRepo;
  readonly watchlistRepo?: WatchlistRepo;
  readonly dataPlatformRepo?: DataPlatformRepo;
  readonly authenticate?: Authenticate;
  /** 复用外壳/测试的 pool；不传则按 DATABASE_URL 自建并负责关闭 */
  readonly pool?: Pool;
  readonly cache?: SnapshotCache;
  /** 测试注入：control 行读取 / 审计事件写入（缺省按 env 决定是否创建 PG 适配器）。 */
  readonly controlRepo?: EntitlementControlRepo;
  readonly eventRepo?: EntitlementEventRepo;
  readonly bootId?: string;
  /** 流水线注入的部署标识（audit_gap 去重键，H4 m01784）；缺省读 DEPLOYMENT_UID。 */
  readonly deploymentUid?: string;
}

function entitlementPayload(resolution: EntitlementResolution): Record<string, unknown> {
  return {
    effective_tier: resolution.effectiveTier,
    configured_tier: resolution.configuredTier,
    expires_at: resolution.expiresAt ?? null,
  };
}

async function installMarketPlugin(
  app: FastifyInstance,
  options: MarketPluginOptions,
  healthState: { gate?: EntitlementGate },
): Promise<void> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadMarketConfig(env);
  // 注入 config 的路径（测试/嵌入）也要过同一道 fail-closed 校验；绝不因绕过 loader 而放开时间盒。
  assertEntitlementTimebox(config);

  const needsDatabase = options.servingRepo === undefined || options.watchlistRepo === undefined;
  // L77：DB 故障的常态是"慢慢不回"，不是"快速报错"。没有超时的熔断是装饰：
  // 连接/查询/服务端语句都必须有硬超时，否则 probeStartup→evaluate 会在 TCP 黑洞下挂死。
  const pool =
    options.pool ??
    (config.databaseUrl !== undefined
      ? new Pool({
          connectionString: config.databaseUrl,
          connectionTimeoutMillis: 1000,
          query_timeout: 1000,
          statement_timeout: 1000,
          options: '-c statement_timeout=1000',
        })
      : null);
  if (pool === null && needsDatabase) {
    throw new Error(
      'services/market 启动失败：缺少 DATABASE_URL（或通过 MarketPluginOptions 注入 servingRepo/watchlistRepo）',
    );
  }

  const serving = options.servingRepo ?? new PgServingRepo(pool as Pool);
  const watchlist = options.watchlistRepo ?? new PgWatchlistRepo(pool as Pool, config.watchlistTable);
  const authenticate = options.authenticate ?? createAuthenticator(config);

  const clock = (): Date => (config.now ?? (() => new Date()))();

  // control 行读取：生产默认开启；E2E 默认关闭（A5 audit schema 未进真栈）。
  const controlRepo =
    options.controlRepo ??
    (pool !== null && (config.entitlementHoldCheck ?? true) ? new PgEntitlementControlRepo(pool) : null);
  // 审计事件：A3 只写 4 类；启动无条件写 tier_state_observed，写失败 → effective=internal_eval（H4）。
  const eventRepo =
    options.eventRepo ??
    (pool !== null && (config.entitlementAuditEnabled ?? true) ? new PgEntitlementEventRepo(pool) : null);
  const bootId = options.bootId ?? randomUUID();
  const deploymentUid =
    options.deploymentUid ?? config.deploymentUid ?? env.DEPLOYMENT_UID?.trim() ?? undefined;
  // L70：payload 键集唯一真源。prod 缺契约 → 拒启（fail-closed）；非 prod 告警后继续
  // （E2E/本地镜像可能未带 docs/reference，由 A0 后续补进 runtime 后自然生效）。
  let payloadContract: EventPayloadContract | undefined;
  try {
    payloadContract = loadEventPayloadContract();
  } catch (error) {
    if (isProductionProfile(env)) {
      throw new MarketConfigError(
        `事件 payload 契约不可用（L70 fail-closed）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.emitWarning(
      `[market] event-payloads 契约缺失，非生产环境跳过 payload 键校验：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const eventWriter =
    eventRepo !== null
      ? new EntitlementEventWriter(eventRepo, {
          ...(deploymentUid !== undefined ? { deploymentUid } : {}),
          operator: 'market-app',
          ...(payloadContract !== undefined ? { payloadContract } : {}),
        })
      : null;

  const gate = new EntitlementGate(config, controlRepo, clock, {
    ...(config.audienceGateMode !== undefined ? { audienceGateMode: config.audienceGateMode } : {}),
    // S3 起才交付审计；A5 的 internal_access 事件契约尚未落地前，先写结构化 stderr，
    // 由 A13 日志链路接（待 A5 加 event_type 后替换为 audit.entitlement_events 写入）。
    ...(config.audienceGateMode === 'enforce'
      ? {
          onInternalAccess: (record: unknown): void => {
            process.stderr.write(`${JSON.stringify({ event: 'internal_access', ...(record as object) })}\n`);
          },
        }
      : {}),
  });
  healthState.gate = gate;
  // 确定性配置错误（表不存在/无权限）→ 启动失败；瞬态故障只降级，不 crash（L27）。
  await gate.probeStartup();

  if (eventWriter !== null) {
    const writer = eventWriter;
    const resolution = resolveEntitlement(config, clock());
    const basePayload = {
      eventKey: observedEventKey(bootId),
      eventType: 'tier_state_observed' as const,
      occurredAt: clock(),
      bootId,
      stateVersion: 1,
      oldValue: entitlementPayload(resolution),
      newValue: entitlementPayload(resolution),
      ...(config.deploymentUid !== undefined ? { deploymentUid: config.deploymentUid } : {}),
      ...(config.releaseId !== undefined ? { releaseId: config.releaseId } : {}),
      ...(resolution.expiresAt !== undefined ? { expiresAt: resolution.expiresAt } : {}),
      configuredTier: resolution.configuredTier,
      effectiveTier: resolution.effectiveTier,
      configFingerprint: configFingerprint(config.entitlementTier, config.entitlementExpiresAt),
    };
    const observed = await writer.write(basePayload);
    if (!observed) {
      const kind = classifyWriteError(writer.lastFailure?.error);
      // H4 m01741：确定性写错误（权限/表/列/类型/schema）→ 阻断并寻呼；
      // 启动路径拒绝以 c_end_display 启动；瞬态 → 非阻断（只 degraded）。
      if (kind === 'deterministic') {
        if (config.entitlementTier !== 'internal_eval') {
          throw new Error(
            '审计事件写入确定性错误（权限/表/schema），拒绝以 c_end_display 启动；修复 GRANT/DDL 后重启',
          );
        }
        gate.markWriteBlocked('audit_write_misconfigured');
      } else {
        gate.markDegraded('audit_write_failed');
      }
    }
    if (resolution.configMismatch) {
      await writer.write({
        ...basePayload,
        eventKey: unauthorizedEventKey(basePayload.configFingerprint, bootId),
        eventType: 'unauthorized_config',
        // A5 DDL reason 枚举并集已放行 expected_fingerprint_mismatch（H4 m00813 口径）。
        reason: 'expected_fingerprint_mismatch',
        oldValue: entitlementPayload(resolution),
      });
    }
    // L20/L59：先降档 → 再写事件 → 才开始服务。到期降档必须留痕；写失败仍保持 internal_eval，
    // 不回滚（失败态即低权限态），仅在 gate/healthz 记 degraded。
    if (
      resolution.expired &&
      config.entitlementTier !== 'internal_eval' &&
      resolution.expiresAt !== undefined
    ) {
      // event_key 逐字使用 UTC 毫秒 ISO（A11/H4 对账口径），boot_id 不进 key → 重启幂等。
      const expiresAtUtc = new Date(resolution.expiresAt).toISOString();
      const written = await writer.write({
        ...basePayload,
        eventKey: expiredEventKey(resolution.configuredTier, expiresAtUtc, 'expires_at_passed'),
        eventType: 'entitlement_expired',
        reason: 'expires_at_passed',
        expiresAt: expiresAtUtc,
        oldValue: entitlementPayload(resolution),
      });
      if (!written) {
        const kind = classifyWriteError(writer.lastFailure?.error);
        if (kind === 'deterministic') gate.markWriteBlocked('audit_write_misconfigured');
        else gate.markDegraded('expired_event_write_failed');
      }
    }
  }

  if (config.autoMigrate) {
    // 仅 E2E/本地兜底建表；生产由 A13 发布流水线执行 migrations/。
    await watchlist.ensureSchema();
  }

  // 凡响应体含 meta.entitlement（含 getInstrument 200）与 403 一律 no-store（H4 m00840 / Lead L36）。
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  const routeDeps = {
    config,
    serving,
    watchlist,
    authenticate,
    cache: options.cache ?? new SnapshotCache(),
    entitlement: gate,
  } as const;
  registerMarketRoutes(app, routeDeps);
  registerB1Routes(app, routeDeps);
  const dataPlatform = options.dataPlatformRepo ?? new PgDataPlatformRepo(pool as Pool);
  registerDataPlatformRoutes(app, { dataPlatform });

  if (options.pool === undefined && pool !== null) {
    const ownedPool = pool;
    app.addHook('onClose', async () => {
      await ownedPool.end();
    });
  }
}

/**
 * 域插件对 /healthz 的贡献（A12 preflight 的 DATA_READY 检查依赖它）。
 * 外壳把每个插件的 health() 合并进 /healthz 200 响应体；本函数永不抛错。
 */
export interface MarketDomainPlugin extends DomainPlugin {
  readonly health: HealthContribution;
}

function buildPlugin(
  options: MarketPluginOptions,
  healthState: { gate?: EntitlementGate },
  env: NodeJS.ProcessEnv,
): MarketDomainPlugin {
  return Object.assign(
    (async (app: FastifyInstance, _options: DomainPluginOptions) => {
      await installMarketPlugin(app, options, healthState);
    }) as FastifyPluginAsync<DomainPluginOptions>,
    {
      domain: 'market',
      contractVersion: '0.4.0',
      health: createMarketHealthContribution(env, () => {
        const status = healthState.gate?.status();
        return status === undefined ? { degraded: false } : status;
      }),
    } as const,
  );
}

const moduleHealthState: { gate?: EntitlementGate } = {};

/** 无参版本（外壳挂载用）：配置与就绪报告路径均从 process.env 读取。 */
export const marketPlugin: MarketDomainPlugin = buildPlugin({ env: process.env }, moduleHealthState, process.env);

/** 单测工厂：显式注入 config/仓储/认证，避免起 PG。 */
export function createMarketPlugin(options: MarketPluginOptions = {}): MarketDomainPlugin {
  if (options.config !== undefined) {
    // 同步 fail-fast：注入配置在创建插件时就要过时间盒校验，不等 app.ready()。
    assertEntitlementTimebox(options.config);
  }
  return buildPlugin(options, {}, options.env ?? process.env);
}
