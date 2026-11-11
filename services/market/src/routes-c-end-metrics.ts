/**
 * C 端展示指标路由（金融维度目录 v1.0）：
 *  - GET /c-end/overview            首页多维度聚合
 *  - GET /c-end/stocks/:instrument_id/metrics  个股全维度
 *  - GET /c-end/limits              涨跌停梯队
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
import { validationError } from './errors.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
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
  deps: { readonly metrics: CEndMetricsRepo },
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
}
