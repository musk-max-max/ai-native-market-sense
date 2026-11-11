/**
 * C 端展示指标访问端口（金融维度目录 v1.0）。
 *
 * 页面只依赖本接口；真实实现走 /v1/c-end/*（services/market/src/routes-c-end-metrics.ts）。
 * 数字以字符串透传，由前端 number() 转换；不输出投资建议/评级/目标价（HANDOFF §1 硬约束 2）。
 */

export interface StockMetrics {
  instrument_id: string;
  instrument_name: string | null;
  exchange: string | null;
  quote_trade_date: string | null;
  close: string | null;
  volume: string | null;
  amount: string | null;
  prev_close: string | null;
  pct_change_pct: string | null;
  turnover_rate_pct: string | null;
  pe_ttm: string | null;
  pb: string | null;
  ps_ttm: string | null;
  dividend_yield_ttm_pct: string | null;
  total_market_value: string | null;
  limit_status: string | null;
  close_5d_pct: string | null;
  close_20d_pct: string | null;
  close_60d_pct: string | null;
  ma20: string | null;
  roe: string | null;
  roa: string | null;
  grossprofit_margin: string | null;
  netprofit_margin: string | null;
  or_yoy_pct: string | null;
  netprofit_yoy_pct: string | null;
  debt_to_assets: string | null;
  current_ratio: string | null;
  net_inflow_amount: string | null;
  lhb_net_amount: string | null;
  holding_ratio_pct: string | null;
  holder_number: string | null;
  as_of: string | null;
}

export interface MarketOverviewMetric {
  metric_key: string;
  value_text: string | null;
  unit: string | null;
  dataset: string | null;
  derivation: string | null;
}

export interface LimitLadderRow {
  instrument_id: string;
  instrument_name: string | null;
  trade_date: string | null;
  limit_pct: string | null;
  close: string | null;
  turnover_rate_pct: string | null;
  pe_ttm: string | null;
  total_market_value: string | null;
  limit_status: string | null;
  net_inflow_amount: string | null;
  l1_name: string | null;
  as_of: string | null;
}

export interface GatewayError {
  status: number | null;
  network: boolean;
}

export type OverviewResult =
  | { kind: 'ready'; metrics: readonly MarketOverviewMetric[] }
  | ({ kind: 'error' } & GatewayError);

export type StockMetricsResult =
  | { kind: 'ready'; data: StockMetrics }
  | ({ kind: 'error'; instrumentId: string } & GatewayError);

export type LimitLadderResult =
  | { kind: 'ready'; rows: readonly LimitLadderRow[] }
  | ({ kind: 'error' } & GatewayError);

export interface CEndMetricsGateway {
  getOverview(): Promise<OverviewResult>;
  getStockMetrics(instrumentId: string): Promise<StockMetricsResult>; // eslint-disable-line no-unused-vars
  getLimitLadder(): Promise<LimitLadderResult>;
}

/** 默认 fetch 实现：/v1/c-end/*  */
export class HttpCEndMetricsGateway implements CEndMetricsGateway {
  constructor(private readonly baseUrl = '') {}

  async getOverview(): Promise<OverviewResult> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/c-end/overview`);
      if (!res.ok) return { kind: 'error', status: res.status, network: false };
      const json = (await res.json()) as { metrics?: readonly MarketOverviewMetric[] };
      if (!Array.isArray(json.metrics)) return { kind: 'error', status: res.status, network: false };
      return { kind: 'ready', metrics: json.metrics };
    } catch {
      return { kind: 'error', status: null, network: true };
    }
  }

  async getStockMetrics(instrumentId: string): Promise<StockMetricsResult> {
    try {
      const encoded = encodeURIComponent(instrumentId);
      const res = await fetch(`${this.baseUrl}/v1/c-end/stocks/${encoded}/metrics`);
      if (!res.ok) return { kind: 'error', instrumentId, status: res.status, network: false };
      const json = (await res.json()) as StockMetrics;
      if (!json || typeof json.instrument_id !== 'string') {
        return { kind: 'error', instrumentId, status: res.status, network: false };
      }
      return { kind: 'ready', data: json };
    } catch {
      return { kind: 'error', instrumentId, status: null, network: true };
    }
  }

  async getLimitLadder(): Promise<LimitLadderResult> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/c-end/limits`);
      if (!res.ok) return { kind: 'error', status: res.status, network: false };
      const json = (await res.json()) as { rows?: readonly LimitLadderRow[] };
      if (!Array.isArray(json.rows)) return { kind: 'error', status: res.status, network: false };
      return { kind: 'ready', rows: json.rows };
    } catch {
      return { kind: 'error', status: null, network: true };
    }
  }
}

export const cEndMetricsGateway = new HttpCEndMetricsGateway();
