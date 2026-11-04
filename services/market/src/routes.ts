/**
 * 行情/内容域 HTTP 路由（market + fundamental + watchlist）。
 *
 * 只做四件事：参数校验、授权闸门、调用 ServingRepo/WatchlistRepo、把结果委托给 domain/build 映射。
 * 错误一律 throw HttpProblem（外壳统一 RFC 9457 映射）；不在此处写任何投资判断性文案（H3 红线）。
 *
 * 降级规则（system_prompt 硬规则 #2）：行情读失败时返回最近一次成功快照，meta.source.source=platform_snapshot/
 * platform_degraded、保留原始 as_of、按当前时刻重算 staleness_ms；命不中快照才把原始错误抛给外壳（5xx Problem）。
 * 判定顺序（Lead m00443）：先确认标的存在性（404 INSTRUMENT_NOT_FOUND）→ 再判 entitlement（403）→ 再取数
 * （存在但无数据→404 NOT_FOUND）。403 语义=知道存在但无权看内容；不先于存在性（否则未导入标的被误报无权）。
 * C 端受众（L30）：display_safe=false 的标的不进 C 端结果集（由 repo 层按 audience 过滤）。
 */

import type { MarketComponents } from '@market-sense/api-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { HttpProblem } from '../../api/src/errors.js';
import type { Authenticate } from './auth.js';
import { SnapshotCache, degradePayload, platformSource } from './cache.js';
import type { MarketConfig } from './config.js';
import {
  buildBarsResponse,
  buildFundamentalResponse,
  buildInstrumentResponse,
  buildQuoteResponse,
  buildWatchlistItemResponse,
  buildWatchlistResponse,
  entitlementForTier,
  platformEntitlement,
} from './domain/build.js';
import { type EntitlementGate, type GateDecision } from './domain/entitlement-gate.js';
import {
  dataNotFound,
  entitlementRestricted,
  instrumentNotFound,
  unauthenticated,
  validationError,
} from './errors.js';
import type { AdjType, ServingRepo, SourceInfo } from './ports/serving-repo.js';
import type { WatchlistRepo } from './ports/watchlist-repo.js';
import { WatchlistLimitExceededError } from './ports/watchlist-repo.js';

const INSTRUMENT_ID_PATTERN = /^(SSE|SZSE|BSE):[0-9]{6}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ADJUSTMENTS = ['none', 'qfq', 'hfq'] as const;
const DEFAULT_BARS_LIMIT = 120;
const MAX_BARS_LIMIT = 500;

export interface MarketRouteDeps {
  readonly config: MarketConfig;
  readonly serving: ServingRepo;
  readonly watchlist: WatchlistRepo;
  readonly authenticate: Authenticate;
  readonly cache: SnapshotCache;
  readonly entitlement: EntitlementGate;
}

interface MetaWithSource {
  source: MarketComponents['schemas']['SourceRef'];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function parseInstrumentId(request: FastifyRequest): string {
  const value = asRecord(request.params).instrument_id;
  if (typeof value !== 'string' || !INSTRUMENT_ID_PATTERN.test(value)) {
    throw validationError();
  }
  return value;
}

function isCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  );
}

function optionalDate(query: Record<string, unknown>, field: 'from' | 'to'): string | undefined {
  const value = query[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    throw validationError();
  }
  return value;
}

function parseAdjustment(query: Record<string, unknown>): AdjType {
  const value = query.adjustment;
  if (value === undefined) return 'none';
  if (typeof value !== 'string' || !(ADJUSTMENTS as readonly string[]).includes(value)) {
    throw validationError();
  }
  return value as AdjType;
}

function parseLimit(query: Record<string, unknown>): number {
  const value = query.limit;
  if (value === undefined) return DEFAULT_BARS_LIMIT;
  if (typeof value !== 'string' && typeof value !== 'number') throw validationError();
  const text = String(value);
  if (!/^\d+$/.test(text)) throw validationError();
  const parsed = Number(text);
  if (parsed < 1 || parsed > MAX_BARS_LIMIT) throw validationError();
  return parsed;
}

function cacheSource(payload: { meta: MetaWithSource }): SourceInfo {
  return {
    source: payload.meta.source.source,
    asOf: payload.meta.source.as_of,
    stalenessMs: payload.meta.source.staleness_ms,
  };
}

/**
 * 执行一次读并写快照缓存；基础设施/未知错误时回退到最近成功快照（degraded）。
 * HttpProblem（403/404/400 等业务错误）原样抛出——不把 404 伪装成旧快照。
 */
async function withDegradation<T extends { meta: MetaWithSource }>(
  deps: MarketRouteDeps,
  key: string,
  now: Date,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const payload = await load();
    deps.cache.set(key, payload, cacheSource(payload));
    return payload;
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    const hit = deps.cache.get(key);
    if (hit === undefined) throw error;
    return degradePayload(hit.payload as T, now);
  }
}

export function registerMarketRoutes(app: FastifyInstance, deps: MarketRouteDeps): void {
  const clock = (): Date => (deps.config.now ?? (() => new Date()))();
  // Lead 定（L27）：先确认存在性（404）→ 授权（403）→ 取数（404）。
  // A13 #3/L77 修正：gate 已 blocked 时把授权判定前置到 serving 读之前——否则熔断后每条请求
  // 仍付 1s query_timeout，熔断器保护的调用点不在关键路径上。blocked 时直接 403，不碰 serving。
  // display_safe=false 由 repo 层（audience='c_end'）过滤掉 → 对外表现为不存在（L30）。
  const audience = 'c_end' as const;

  const evaluate = (): Promise<GateDecision> => deps.entitlement.evaluate();

  /**
   * 存在性确认 + fail-closed：gate 已判 blocked 时若 serving 读失败（例如 PG 不可达），
   * 返回 403 而不是 500——授权判不了时拒绝回答行情，符合 H4/H5「读失败→internal_eval」。
   * DB 正常时仍保持 Lead m00443 顺序：存在性 404 → 授权 403。
   */
  const loadInstrument = async (
    instrumentId: string,
  ): Promise<Awaited<ReturnType<ServingRepo['getInstrument']>>> => {
    // blocked 已在上游 403 返回；这里读失败按真实故障交给外壳（不再用 authority 掩盖）。
    return deps.serving.getInstrument(instrumentId, audience);
  };

  const requireEntitled = (decision: GateDecision, _reply: FastifyReply): void => {
    // H3 fail-closed：本地时间盒/control hold/指纹不一致都在 gate 内归一为 blocked；403 不暴露原因给 C 端文案。
    if (!decision.resolution.blocked) return;
    throw entitlementRestricted();
  };

  // GET /v1/instruments/{instrument_id} —— 基础信息；不整体 403（A0：200+is_entitled=false 仅预判/降级）。
  app.get('/instruments/:instrument_id', async (request) => {
    const instrumentId = parseInstrumentId(request);
    return withDegradation(deps, `instrument:${instrumentId}`, clock(), async () => {
      const decision = await evaluate();
      let row;
      try {
        row = await deps.serving.getInstrument(instrumentId, audience);
      } catch (error) {
        // 基础信息不整体 403；DB 读失败时交给外壳 500 / 降级快照，不在这里改写。
        throw error;
      }
      if (row === null) throw instrumentNotFound(instrumentId);
      return buildInstrumentResponse(row, decision.resolution.effectiveTier, decision.resolution.expired);
    });
  });

  // GET /v1/instruments/{instrument_id}/quote —— 最近成功快照（停牌可 null 价格，禁止 0 冒充）。
  app.get('/instruments/:instrument_id/quote', async (request, reply) => {
    const instrumentId = parseInstrumentId(request);
    return withDegradation(deps, `quote:${instrumentId}`, clock(), async () => {
      const decision = await evaluate();
      // L77/A13 #3：gate blocked → 先 403，不付 serving 读的 1s 超时代价。
      requireEntitled(decision, reply);
      const instrument = await loadInstrument(instrumentId);
      if (instrument === null) throw instrumentNotFound(instrumentId);
      const row = await deps.serving.getQuote(instrumentId);
      if (row === null || row.trade_date === null) {
        throw dataNotFound();
      }
      return buildQuoteResponse(
        row,
        decision.resolution.effectiveTier,
        deps.config.disclaimer,
        decision.resolution.expired,
      );
    });
  });

  // GET /v1/instruments/{instrument_id}/bars —— 复权口径由 serving 固化（none/hfq/qfq），本层不计算。
  app.get('/instruments/:instrument_id/bars', async (request, reply) => {
    const instrumentId = parseInstrumentId(request);
    const query = asRecord(request.query);
    const adjustment = parseAdjustment(query);
    const from = optionalDate(query, 'from');
    const to = optionalDate(query, 'to');
    if (from !== undefined && to !== undefined && from > to) throw validationError();
    const limit = parseLimit(query);
    const key = `bars:${instrumentId}:${adjustment}:${from ?? ''}:${to ?? ''}:${limit}`;

    return withDegradation(deps, key, clock(), async () => {
      const decision = await evaluate();
      requireEntitled(decision, reply);
      const instrument = await loadInstrument(instrumentId);
      if (instrument === null) throw instrumentNotFound(instrumentId);
      const page = await deps.serving.getBars({
        instrumentId,
        adjType: adjustment,
        limit,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      });
      if (page.adjustment !== adjustment) {
        throw new Error(`serving bars 口径与请求不一致: ${page.adjustment} != ${adjustment}`);
      }
      return buildBarsResponse(
        page.rows,
        page.hasMore,
        adjustment,
        { source: instrument, instrumentId },
        decision.resolution.effectiveTier,
        deps.config.disclaimer,
        decision.resolution.expired,
      );
    });
  });

  // GET /v1/instruments/{instrument_id}/fundamental-summary —— 最新一期；P0 无数据时 404 NOT_FOUND。
  app.get('/instruments/:instrument_id/fundamental-summary', async (request, reply) => {
    const instrumentId = parseInstrumentId(request);
    return withDegradation(deps, `fundamental:${instrumentId}`, clock(), async () => {
      const decision = await evaluate();
      requireEntitled(decision, reply);
      const instrument = await loadInstrument(instrumentId);
      if (instrument === null) throw instrumentNotFound(instrumentId);
      const row = await deps.serving.getFundamentalSummary(instrumentId);
      if (row === null) throw dataNotFound();
      return buildFundamentalResponse(
        row,
        decision.resolution.effectiveTier,
        deps.config.disclaimer,
        decision.resolution.expired,
      );
    });
  });

  // ---------------- watchlist（平台自有数据，恒 200 + platform_user_data/true） ----------------

  const requirePrincipal = async (request: FastifyRequest) => {
    const principal = await deps.authenticate(request);
    if (principal === null) throw unauthenticated();
    return principal;
  };

  const watchlistMeta = () => ({
    source: platformSource(clock()),
    entitlement: platformEntitlement(),
  });

  app.get('/watchlist', async (request) => {
    const principal = await requirePrincipal(request);
    const items = await deps.watchlist.list(principal.userId);
    return buildWatchlistResponse(items, watchlistMeta());
  });

  app.post('/watchlist', async (request) => {
    const principal = await requirePrincipal(request);
    const body = asRecord(request.body);
    const instrumentId = body.instrument_id;
    if (typeof instrumentId !== 'string' || !INSTRUMENT_ID_PATTERN.test(instrumentId)) {
      throw validationError();
    }
    try {
      const result = await deps.watchlist.add(principal.userId, instrumentId, deps.config.watchlistLimit);
      return buildWatchlistItemResponse(result.item, watchlistMeta());
    } catch (error) {
      if (error instanceof WatchlistLimitExceededError) {
        throw validationError();
      }
      throw error;
    }
  });

  app.delete('/watchlist/:instrument_id', async (request, reply) => {
    const principal = await requirePrincipal(request);
    const instrumentId = parseInstrumentId(request);
    await deps.watchlist.remove(principal.userId, instrumentId);
    return reply.status(204).send();
  });
}
