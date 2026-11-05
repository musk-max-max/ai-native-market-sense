/**
 * B1 批次确定性功能路由（ADR-007 §D5 第 1 批）：
 *  - GET /v1/watchlist/review               自选组合绝对表现（B1-01）
 *  - GET /v1/market/limit-ladder            涨跌停梯队（B1-02，provisional 口径）
 *  - GET /v1/instruments/{id}/page-summary  个股页五段骨架 + 缺口（B1-03）
 *
 * 边界：
 *  - 不做任何 LLM 调用；不输出投资结论/评级/目标价/推荐（H3 红线）；
 *  - 缺口必须显式（固定 gap 码），不得用 0/"--"/空对象/骨架屏占位冒充数据；
 *  - 授权：受限/降级档（internal_eval）下 ladder/review 403；page-summary 返回 restricted 骨架
 *    （x 段不带数值），因为基础信息与页面骨架不因行情授权缺失整体 403；
 *  - 形状以 @market-sense/api-client 生成类型为准，不新增手写 DTO。
 */

import type { MarketComponents, WatchlistComponents } from '@market-sense/api-client';
import type { FastifyInstance } from 'fastify';

import {
  disclaimerMeta,
  entitlementForTier,
  sourceRef,
} from './domain/build.js';
import type { GateDecision } from './domain/entitlement-gate.js';
import { buildLimitLadder, type LadderInstrument } from './domain/limit-ladder.js';
import { buildPageSummary } from './domain/page-summary.js';
import { buildPortfolioReview } from './domain/portfolio-review.js';
import { stalenessMs, toCstIso } from './domain/time.js';
import { entitlementRestricted, instrumentNotFound, unauthenticated, validationError } from './errors.js';
import type { MarketRouteDeps } from './routes.js';
import { isCalendarDate, parseInstrumentId } from './routes.js';
import type { SourceInfo } from './ports/serving-repo.js';

type Market = MarketComponents['schemas'];
type Watchlist = WatchlistComponents['schemas'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LOOKBACK = 10;
const MAX_LOOKBACK = 10;
const MAX_REVIEW_TRADING_DAYS = 250;
const MAX_REVIEW_BARS = 500;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function optionalDate(query: Record<string, unknown>, field: string): string | undefined {
  const value = query[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    throw validationError();
  }
  return value;
}

function parseLookback(query: Record<string, unknown>): number {
  const value = query.lookback;
  if (value === undefined) return DEFAULT_LOOKBACK;
  if (typeof value !== 'string' && typeof value !== 'number') throw validationError();
  const text = String(value);
  if (!/^\d+$/.test(text)) throw validationError();
  const parsed = Number(text);
  if (parsed < 1 || parsed > MAX_LOOKBACK) throw validationError();
  return parsed;
}

function parseReviewAdjustment(query: Record<string, unknown>): 'none' | 'qfq' {
  const value = query.adjustment;
  if (value === undefined) return 'qfq';
  if (value !== 'none' && value !== 'qfq') throw validationError();
  return value;
}

function fallbackSource(tradeDate: string, now: Date): SourceInfo {
  const asOf = `${tradeDate}T15:00:00+08:00`;
  return { source: 'platform_eod', asOf, stalenessMs: stalenessMs(asOf, now) };
}

function latestSource(rows: ReadonlyArray<SourceInfo>, now: Date, tradeDate: string): SourceInfo {
  let best: SourceInfo | null = null;
  for (const row of rows) {
    if (best === null || row.asOf > best.asOf) best = row;
  }
  return best ?? fallbackSource(tradeDate, now);
}

export function registerB1Routes(app: FastifyInstance, deps: MarketRouteDeps): void {
  const clock = (): Date => (deps.config.now ?? (() => new Date()))();
  const audience = 'c_end' as const;
  const evaluate = (): Promise<GateDecision> => deps.entitlement.evaluate();
  const checkEntitled = (decision: GateDecision): void => {
    if (decision.resolution.blocked) throw entitlementRestricted();
  };

  // GET /v1/market/limit-ladder —— 静态路径优先于参数路由（A0 m02975）。
  app.get('/market/limit-ladder', async (request) => {
    const query = asRecord(request.query);
    const requestedDate = optionalDate(query, 'trade_date');
    const lookback = parseLookback(query);

    const decision = await evaluate();
    checkEntitled(decision);
    const now = clock();
    const dates = await deps.serving.listTradeDates(Math.max(lookback, 2), requestedDate);
    const tradeDate = requestedDate ?? dates[dates.length - 1] ?? toCstIso(now).slice(0, 10);
    const window = dates.filter((date) => date <= tradeDate).slice(-lookback);

    if (window.length < 2) {
      const empty = buildLimitLadder({ tradeDate, instruments: [], bars: [] });
      return {
        data: {
          ...empty,
          excluded_st: empty.excluded_st.map((entry) => ({ instrument_id: entry.instrument_id, name: entry.name })),
        },
        meta: ladderMeta(fallbackSource(tradeDate, now), decision, deps),
      } satisfies Market['LimitLadderResponse'];
    }

    const [instrumentRows, barRows] = await Promise.all([
      deps.serving.listInstruments(audience),
      deps.serving.getMarketBars({ adjType: 'none', dates: window, audience }),
    ]);
    const instruments: LadderInstrument[] = instrumentRows.map((row) => ({
      instrumentId: row.instrument_id,
      name: row.name,
      board: row.board,
      securityType: row.security_type,
      listStatus: row.list_status,
    }));
    const ladder = buildLimitLadder({
      tradeDate,
      instruments,
      bars: barRows.map((row) => ({
        instrumentId: row.instrument_id,
        tradeDate: row.trade_date,
        close: row.close,
      })),
    });
    const todayRows = barRows
      .filter((row) => row.trade_date === tradeDate)
      .map((row) => ({ source: row.source, asOf: row.asOf, stalenessMs: row.stalenessMs }));
    return {
      data: {
        ...ladder,
        excluded_st: ladder.excluded_st.map((entry) => ({ instrument_id: entry.instrument_id, name: entry.name })),
      },
      meta: ladderMeta(latestSource(todayRows, now, tradeDate), decision, deps),
    } satisfies Market['LimitLadderResponse'];
  });

  // GET /v1/instruments/{instrument_id}/page-summary
  app.get('/instruments/:instrument_id/page-summary', async (request) => {
    const instrumentId = parseInstrumentId(request);
    const decision = await evaluate();
    const now = clock();

    // 存在性先判（契约：instrument 不存在才 404），再决定骨架的受限形态。
    const instrument = await deps.serving.getInstrument(instrumentId, audience);
    if (instrument === null) throw instrumentNotFound(instrumentId);
    if (decision.resolution.blocked) {
      // 受限/降级档：只回页面骨架与显式缺口，不读行情/财务、不暴露是否存在数据。
      const data = buildPageSummary({ instrumentId, restricted: true, quote: null, fundamental: null });
      return {
        data,
        meta: pageMeta(fallbackSource(toCstIso(now).slice(0, 10), now), decision, deps),
      } satisfies Market['InstrumentPageSummaryResponse'];
    }
    const [quote, fundamental] = await Promise.all([
      deps.serving.getQuote(instrumentId),
      deps.serving.getFundamentalSummary(instrumentId),
    ]);
    const data = buildPageSummary({
      instrumentId,
      restricted: false,
      quote: quote !== null && quote.trade_date !== null ? { asOf: quote.asOf, tradeDate: quote.trade_date } : null,
      fundamental:
        fundamental !== null ? { asOf: fundamental.asOf, reportPeriod: fundamental.report_period } : null,
    });
    const source: SourceInfo =
      quote !== null && quote.trade_date !== null
        ? { source: quote.source, asOf: quote.asOf, stalenessMs: quote.stalenessMs }
        : fundamental !== null
          ? { source: fundamental.source, asOf: fundamental.asOf, stalenessMs: fundamental.stalenessMs }
          : fallbackSource(toCstIso(now).slice(0, 10), now);
    return {
      data,
      meta: pageMeta(source, decision, deps),
    } satisfies Market['InstrumentPageSummaryResponse'];
  });

  // GET /v1/watchlist/review —— 自选组合绝对表现（bearerAuth，私有数据）。
  app.get('/watchlist/review', async (request) => {
    const query = asRecord(request.query);
    const requestedFrom = optionalDate(query, 'from');
    const requestedTo = optionalDate(query, 'to');
    if (requestedFrom !== undefined && requestedTo !== undefined && requestedFrom > requestedTo) {
      throw validationError();
    }
    const adjustment = parseReviewAdjustment(query);

    const principal = await deps.authenticate(request);
    if (principal === null) throw unauthenticated();
    const decision = await evaluate();
    checkEntitled(decision);
    const now = clock();

    // 契约：from/to 返回「实际生效的交易日」。缺省回溯 250 个交易日；显式 from 最多扫 1000 天，
    // 以便对 >250 交易日跨度给 400，而不是把窗口截断后静默算。
    const scanLimit = requestedFrom !== undefined ? 1000 : MAX_REVIEW_TRADING_DAYS + 1;
    const allDates = await deps.serving.listTradeDates(scanLimit, requestedTo);
    const dateWindow = allDates;
    const effectiveTo = requestedTo !== undefined ? dateWindow[dateWindow.length - 1] : dateWindow[dateWindow.length - 1];
    if (effectiveTo === undefined) {
      const emptyDate = requestedFrom ?? toCstIso(now).slice(0, 10);
      const review = buildPortfolioReview({ from: emptyDate, to: emptyDate, adjustment, items: [] });
      return {
        data: review,
        meta: reviewMeta(fallbackSource(emptyDate, now), decision, deps, adjustment),
      } satisfies Watchlist['WatchlistReviewResponse'];
    }

    const effectiveFrom = requestedFrom !== undefined
      ? dateWindow.find((date) => date >= requestedFrom)
      : dateWindow[0];
    if (effectiveFrom === undefined || effectiveFrom > effectiveTo) throw validationError();
    const inRange = dateWindow.filter((date) => date >= effectiveFrom && date <= effectiveTo);
    if (inRange.length > MAX_REVIEW_TRADING_DAYS) throw validationError();

    const watchlistItems = await deps.watchlist.list(principal.userId);
    const partialIds: string[] = [];
    const inputs: Array<{ instrumentId: string; name: string; bars: Array<{ tradeDate: string; close: string }> }> = [];
    const sources: SourceInfo[] = [];
    for (const item of watchlistItems) {
      const instrument = await deps.serving.getInstrument(item.instrument_id, audience);
      if (instrument === null) {
        partialIds.push(item.instrument_id);
        continue;
      }
      const page = await deps.serving.getBars({
        instrumentId: item.instrument_id,
        adjType: adjustment,
        from: effectiveFrom,
        to: effectiveTo,
        limit: MAX_REVIEW_BARS,
      });
      if (page.adjustment !== adjustment) {
        throw new Error(`serving bars 口径与请求不一致: ${page.adjustment} != ${adjustment}`);
      }
      sources.push(...page.rows.map((row) => ({ source: row.source, asOf: row.asOf, stalenessMs: row.stalenessMs })));
      inputs.push({
        instrumentId: item.instrument_id,
        name: instrument.name,
        bars: page.rows.map((row) => ({ tradeDate: row.trade_date, close: row.close })),
      });
    }

    const review = buildPortfolioReview({ from: effectiveFrom, to: effectiveTo, adjustment, items: inputs });
    if (partialIds.length > 0) {
      review.gaps.unshift({
        code: 'PARTIAL_HISTORY',
        message: `部分自选标的不在 C 端可见范围或不存在，未参与统计：${partialIds.join('、')}`,
      });
    }
    return {
      data: review,
      meta: reviewMeta(latestSource(sources, now, effectiveTo), decision, deps, adjustment),
    } satisfies Watchlist['WatchlistReviewResponse'];
  });
}

function ladderMeta(
  source: SourceInfo,
  decision: GateDecision,
  deps: MarketRouteDeps,
): Market['LimitLadderResponse']['meta'] {
  return {
    source: sourceRef(source, 'eod'),
    adjustment: 'none',
    entitlement: entitlementForTier(decision.resolution.effectiveTier, decision.resolution.expired),
    disclaimer: disclaimerMeta(deps.config.disclaimer),
  };
}

function pageMeta(
  source: SourceInfo,
  decision: GateDecision,
  deps: MarketRouteDeps,
): Market['InstrumentPageSummaryResponse']['meta'] {
  return {
    source: sourceRef(source, 'eod'),
    entitlement: entitlementForTier(decision.resolution.effectiveTier, decision.resolution.expired),
    disclaimer: disclaimerMeta(deps.config.disclaimer),
  };
}

function reviewMeta(
  source: SourceInfo,
  decision: GateDecision,
  deps: MarketRouteDeps,
  adjustment: 'none' | 'qfq',
): Watchlist['WatchlistReviewResponse']['meta'] {
  return {
    source: sourceRef(source, 'eod'),
    adjustment,
    entitlement: entitlementForTier(decision.resolution.effectiveTier, decision.resolution.expired),
    disclaimer: disclaimerMeta(deps.config.disclaimer),
  };
}
