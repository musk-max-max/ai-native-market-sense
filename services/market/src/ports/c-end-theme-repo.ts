/**
 * P1a 主题端口（M1a，A3 2026-11-18）：
 *  - 只读 serving.v_cend_theme_* 视图；
 *  - 行类型全 string | null（数字字符串透传，precision-safe；timestamptz 运行时为
 *    Date，JSON 序列化为 ISO 字符串——与 CEndMetricsRow 同约定）；
 *  - 禁输出投资结论/评级/目标价（H3 红线），禁暴露上游非 canonical 源字段（红线①）。
 */

/** T1 财务健康行（v_cend_theme_fin_health，按 as_of DESC 取近 8 季）。 */
export interface ThemeFinHealthRow {
  readonly instrument_id: string;
  /** 可见时点 = 财报公告日 announced_at（H4 防未来函数）。 */
  readonly as_of: string | null;
  /** 报告期 = report_end_date（如 2026-09-30）。 */
  readonly period: string | null;
  readonly roe: string | null;
  readonly or_yoy_pct: string | null;
  readonly debt_to_assets: string | null;
  readonly netprofit_yoy_pct: string | null;
  readonly grossprofit_margin: string | null;
  readonly netprofit_margin: string | null;
  readonly current_ratio: string | null;
  readonly total_revenue: string | null;
  readonly net_profit: string | null;
  readonly net_profit_parent: string | null;
  readonly basic_eps: string | null;
  readonly staleness_ms: string | null;
}

/** T2 估值行情行（v_cend_theme_valuation_price，按 trade_date DESC）。 */
export interface ValuationPriceRow {
  readonly instrument_id: string;
  readonly trade_date: string;
  readonly pe_ttm: string | null;
  readonly pb: string | null;
  readonly close: string | null;
  readonly turnover_rate_pct: string | null;
}

/** T2 窗口分位（近 windowRows 交易日，0-100 保留 1 位；样本 <2 或最新值缺失 → null）。 */
export interface ValuationPercentiles {
  readonly pe_ttm: string | null;
  readonly pb: string | null;
  readonly close: string | null;
  readonly turnover_rate_pct: string | null;
}

export interface ValuationPriceSeries {
  readonly rows: readonly ValuationPriceRow[];
  readonly percentiles: ValuationPercentiles;
}

/** T3 市场情绪行（v_cend_theme_sentiment_market，按 trade_date DESC；只市场级无个股行）。 */
export interface SentimentMarketRow {
  readonly trade_date: string;
  readonly limit_up_count: string | null;
  readonly limit_down_count: string | null;
  readonly advancers: string | null;
  readonly decliners: string | null;
  readonly adv_dec_ratio: string | null;
  readonly max_limit_streak: string | null;
  readonly moneyflow_net_inflow_total: string | null;
  readonly margin_financing_balance: string | null;
}

/** T3 个股资金情绪行（v_cend_theme_sentiment_stock，按 trade_date DESC；无涨跌停列）。 */
export interface SentimentStockRow {
  readonly instrument_id: string;
  readonly trade_date: string;
  readonly net_inflow_amount: string | null;
  readonly lhb_net_amount: string | null;
  readonly inst_net_buy_amount: string | null;
  readonly financing_balance: string | null;
}

/**
 * T3 个股窗口汇总（近 windowRows 个交易日）。
 * 空序列 → 全 null（含 lhb_count）；有序列但 0 天上榜 → lhb_count='0'。
 */
export interface SentimentStockSummary {
  readonly net_inflow_sum: string | null;
  readonly net_inflow_latest: string | null;
  readonly lhb_count: string | null;
  readonly lhb_net_buy_sum: string | null;
  readonly inst_net_buy_sum: string | null;
  readonly financing_balance_latest: string | null;
  readonly financing_balance_change: string | null;
}

export interface SentimentStockSeries {
  readonly rows: readonly SentimentStockRow[];
  readonly summary: SentimentStockSummary;
}

export interface CEndThemeRepo {
  /**
   * T1：个股财务健康近 8 季（announced_at DESC，视图已 rn<=8 截断）。
   * 空数组 = 该标的无已披露财报 → 路由返回 200 空行（不 404：非"标的不存在"语义）。
   */
  getFinHealth(instrumentId: string): Promise<readonly ThemeFinHealthRow[]>;

  /**
   * T2：个股估值行情窗口（trade_date DESC 前 windowRows 个交易日）+ 同窗口分位。
   * windowRows 由路由按 range 解析（1y=250、3y=750）；空序列 → rows:[] + 分位全 null。
   */
  getValuationPrice(instrumentId: string, windowRows: number): Promise<ValuationPriceSeries>;

  /** T3：市场级情绪日序列（trade_date DESC 前 windowRows 个交易日）。 */
  getSentimentMarket(windowRows: number): Promise<readonly SentimentMarketRow[]>;

  /**
   * T3：个股资金情绪窗口（trade_date DESC 前 windowRows 个交易日）+ 窗口汇总。
   * windowRows 由路由按 window 解析（30d=30）；空序列 → rows:[] + summary 全 null。
   */
  getSentimentStock(instrumentId: string, windowRows: number): Promise<SentimentStockSeries>;
}
