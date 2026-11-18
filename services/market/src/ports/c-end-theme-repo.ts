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

export interface CEndThemeRepo {
  /**
   * T1：个股财务健康近 8 季（announced_at DESC，视图已 rn<=8 截断）。
   * 空数组 = 该标的无已披露财报 → 路由返回 200 空行（不 404：非"标的不存在"语义）。
   */
  getFinHealth(instrumentId: string): Promise<readonly ThemeFinHealthRow[]>;
}
