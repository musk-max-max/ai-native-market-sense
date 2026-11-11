/**
 * C 端展示指标 Repo 端口（金融维度目录 v1.0，docs/design/c-end-metrics-catalog-2026-11-11.md）
 *
 * 边界：
 *  - 仅数据展示 + 派生计算口径；不输出投资建议/评级/目标价（HANDOFF §1 硬约束 2）；
 *  - 数字以字符串透传（precision-safe），由前端 number() 转换；
 *  - realtime_quote 标 source_internal_only（SEC-012 F1 residual）。
 */

export interface StockMetricsRow {
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
  free_float_turnover_rate_pct: string | null;
  volume_ratio: string | null;
  pe: string | null;
  pe_ttm: string | null;
  pb: string | null;
  ps_ttm: string | null;
  dividend_yield_ttm_pct: string | null;
  total_market_value: string | null;
  circulating_market_value: string | null;
  limit_status: string | null;
  close_5d_pct: string | null;
  close_20d_pct: string | null;
  close_60d_pct: string | null;
  ma20: string | null;
  amount_5d_avg: string | null;
  grossprofit_margin: string | null;
  netprofit_margin: string | null;
  roe: string | null;
  roa: string | null;
  roic: string | null;
  profit_dedt: string | null;
  or_yoy_pct: string | null;
  netprofit_yoy_pct: string | null;
  assets_yoy_pct: string | null;
  eqt_yoy_pct: string | null;
  debt_to_assets: string | null;
  current_ratio: string | null;
  quick_ratio: string | null;
  q_sales_qoq_pct: string | null;
  fina_report_end_date: string | null;
  net_inflow_amount: string | null;
  xl_net: string | null;
  l_net: string | null;
  m_net: string | null;
  s_net: string | null;
  lhb_net_amount: string | null;
  holding_ratio_pct: string | null;
  holder_number: string | null;
  avg_market_value: string | null;
  pledged_shares: string | null;
  as_of: string | null;
  staleness_ms: string | null;
}

export interface MarketOverviewRow {
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
  up_limit: string | null;
  down_limit: string | null;
  limit_pct: string | null;
  exchange: string | null;
  close: string | null;
  turnover_rate_pct: string | null;
  pe_ttm: string | null;
  total_market_value: string | null;
  limit_status: string | null;
  seal_ratio_pct_hint: string | null;
  net_inflow_amount: string | null;
  l1_name: string | null;
  l2_name: string | null;
  as_of: string | null;
  staleness_ms: string | null;
}

export interface CEndMetricsRepo {
  /** 个股全维度（估值/盈利/成长/杠杆/流动性/股东/资金/技术面）。 */
  getStockMetrics(instrumentId: string): Promise<StockMetricsRow | null>;
  /** 首页多维度聚合（quote/flow/fundamental/sector/index/research）。 */
  getMarketOverview(): Promise<readonly MarketOverviewRow[]>;
  /** 涨跌停梯队。 */
  getLimitLadder(): Promise<readonly LimitLadderRow[]>;
}
