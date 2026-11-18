/**
 * C 端展示指标路由（金融维度目录 v1.0）：
 *  - GET /c-end/overview            首页多维度聚合
 *  - GET /c-end/stocks/:instrument_id/metrics  个股全维度
 *  - GET /c-end/limits              涨跌停梯队
 *  - GET /c-end/stocks/:instrument_id/themes/fin-health  个股财务健康近 8 季（M1a T1）
 *  - GET /c-end/stocks/:instrument_id/themes/valuation-price  个股估值行情窗口+分位（M1a T2）
 *  - GET /c-end/themes/money-sentiment  市场级资金与情绪（M1a T3，只市场级汇总）
 *  - GET /c-end/stocks/:instrument_id/themes/money-sentiment  个股资金与情绪（M1a T3）
 *
 * 边界：
 *  - 挂 /v1/c-end/**（C 端公开，但受 market plugin 的 EntitlementGate 保护）；
 *  - 不输出投资结论/评级/目标价/推荐（H3 红线）；
 *  - realtime_quote 相关字段不在此路由暴露（SEC-012 F1 residual）；
 *  - 数字以字符串透传（precision-safe），由前端 number() 转换；
 *  - 403 走 Problem + is_entitled=false，禁 200+is_entitled=false 替代（红线③）。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { CEndMetricsRepo } from './ports/c-end-metrics-repo.js';
import type { CEndThemeRepo } from './ports/c-end-theme-repo.js';
import { validationError } from './errors.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** M1a T2 分档：range=1y→250 交易日、3y→750 交易日（缺省 1y；非法值 400 VALIDATION_ERROR）。 */
const VALUATION_RANGE: Readonly<Record<string, number>> = { '1y': 250, '3y': 750 };

function parseRange(request: FastifyRequest): { readonly range: string; readonly windowRows: number } {
  const value = asRecord(request.query).range;
  const range = value === undefined ? '1y' : String(value);
  const windowRows = VALUATION_RANGE[range];
  if (windowRows === undefined) {
    throw validationError();
  }
  return { range, windowRows };
}

/** M1a T3 窗口：window=30d→30 个交易日（缺省 30d；非法值 400 VALIDATION_ERROR）。 */
const SENTIMENT_WINDOW: Readonly<Record<string, number>> = { '30d': 30 };

function parseWindow(request: FastifyRequest): { readonly window: string; readonly windowRows: number } {
  const value = asRecord(request.query).window;
  const windowName = value === undefined ? '30d' : String(value);
  const windowRows = SENTIMENT_WINDOW[windowName];
  if (windowRows === undefined) {
    throw validationError();
  }
  return { window: windowName, windowRows };
}

function parseInstrumentId(request: FastifyRequest): string {
  const value = asRecord(request.params).instrument_id;
  if (typeof value !== 'string' || !/^[A-Za-z]{2,6}:.+$/.test(value)) {
    throw validationError();
  }
  return value;
}

export function registerCEndMetricsRoutes(
  app: FastifyInstance,
  deps: { readonly metrics: CEndMetricsRepo; readonly themes: CEndThemeRepo },
): void {
  // GET /c-end/overview
  app.get('/c-end/overview', async () => {
    const metrics = await deps.metrics.getMarketOverview();
    return {
      metrics,
      as_of: new Date().toISOString(),
    };
  });

  // GET /c-end/stocks/:instrument_id/metrics
  app.get('/c-end/stocks/:instrument_id/metrics', async (request: FastifyRequest) => {
    const instrumentId = parseInstrumentId(request);
    const row = await deps.metrics.getStockMetrics(instrumentId);
    if (!row) {
      const { instrumentNotFound } = await import('./errors.js');
      throw instrumentNotFound(instrumentId);
    }
    return row;
  });

  // GET /c-end/limits
  app.get('/c-end/limits', async () => {
    const rows = await deps.metrics.getLimitLadder();
    return {
      rows,
      as_of: new Date().toISOString(),
    };
  });

  // GET /c-end/stocks/:instrument_id/themes/fin-health（M1a T1：近 8 季财务健康，季频）
  // 数据源 serving.v_cend_theme_fin_health；可见时点=announced_at（H4），行序 as_of DESC。
  app.get('/c-end/stocks/:instrument_id/themes/fin-health', async (request: FastifyRequest) => {
    const instrumentId = parseInstrumentId(request);
    const rows = await deps.themes.getFinHealth(instrumentId);
    return {
      instrument_id: instrumentId,
      // 空行（无已披露财报）→ 200 + as_of:null + rows:[]，与 /metrics 的 404（标的不存在）语义区分
      as_of: rows[0]?.as_of ?? null,
      rows,
    };
  });

  // GET /c-end/stocks/:instrument_id/themes/valuation-price?range=1y|3y（M1a T2：近 1 年/3 年日频+分位）
  // 数据源 serving.v_cend_theme_valuation_price（close 真源 dwd_stock_bar_daily，估值/换手 dwd_daily_basic）；
  // 窗口与分位在仓储 SQL 计算（1y=250、3y=750 交易日，分位 0-100 保留 1 位，样本 <2 → null）。
  app.get('/c-end/stocks/:instrument_id/themes/valuation-price', async (request: FastifyRequest) => {
    const instrumentId = parseInstrumentId(request);
    const { range, windowRows } = parseRange(request);
    const series = await deps.themes.getValuationPrice(instrumentId, windowRows);
    return {
      instrument_id: instrumentId,
      range,
      // 空序列（该标的无行情行）→ 200 + as_of:null + rows:[] + 分位全 null（非 404：非"标的不存在"语义）
      as_of: series.rows[0]?.trade_date ?? null,
      rows: series.rows,
      percentiles: series.percentiles,
    };
  });

  // GET /c-end/themes/money-sentiment?window=30d（M1a T3 市场级：情绪四件套+资金面，日粒度）
  // 数据源 serving.v_cend_theme_sentiment_market（只按 trade_date 聚合，H3 m02407 禁个股行）。
  app.get('/c-end/themes/money-sentiment', async (request: FastifyRequest) => {
    const { window: windowName, windowRows } = parseWindow(request);
    const rows = await deps.themes.getSentimentMarket(windowRows);
    return {
      window: windowName,
      // 空序列 → 200 + as_of:null + rows:[]（无数据 ≠ 出错，与 /metrics 404 语义区分）
      as_of: rows[0]?.trade_date ?? null,
      rows,
    };
  });

  // GET /c-end/stocks/:instrument_id/themes/money-sentiment?window=30d（M1a T3 个股级）
  // 数据源 serving.v_cend_theme_sentiment_stock（主力净流入+龙虎榜+机构净买+个股融资；
  // 无涨跌停列——H3 m02407）。summary = 近 30 日窗口汇总（空序列 → 全 null）。
  app.get('/c-end/stocks/:instrument_id/themes/money-sentiment', async (request: FastifyRequest) => {
    const instrumentId = parseInstrumentId(request);
    const { window: windowName, windowRows } = parseWindow(request);
    const series = await deps.themes.getSentimentStock(instrumentId, windowRows);
    return {
      instrument_id: instrumentId,
      window: windowName,
      as_of: series.rows[0]?.trade_date ?? null,
      rows: series.rows,
      summary: series.summary,
    };
  });
}
