/**
 * P1a 主题视图（M1a T1/T2/T3，A3 2026-11-18）。
 *
 * 与 warehouse/serving/c-end-metrics.sql（P0 五视图）分离：本文件只放 v_cend_theme_*
 * 系列视图（约束：不混入 c-end-metrics.sql）。
 *
 * 红线：
 *  ① 财报可见时点 = announced_at，禁按 report_end_date 做 as-of join（H4 防未来函数，
 *    warehouse/dwd/schema.sql 的 dwd_fina_indicator 表注释同口径）；
 *  ② 只读 DWD canonical 列，不暴露上游非 canonical 源字段（红线①守门见
 *    services/market/test/c-end-themes.test.ts 的静态 SQL 断言）；
 *  ③ 个股级不暴露涨跌停梯队明细表（dwd_stk_limit 不进主题视图；市场级家数由 T3 视图
 *    按 dwd_daily_basic.limit_status 聚合，底座 L202b/L203 口径）。
 * 幂等：CREATE SCHEMA IF NOT EXISTS serving + CREATE OR REPLACE VIEW。
 * 应用点：与 c-end-metrics.sql 相同（infra/ops/ecs-deploy-c-end.sh、
 * services/ingest/scripts/production-sync.sh —— 非 A3 owns 域，完工报告交 L0 补）。
 */

CREATE SCHEMA IF NOT EXISTS serving;

-- ============================================================
-- T1 fin-health：个股财务健康（近 8 季，季频）
-- 每行 = 一个已披露季度；窗口按 announced_at DESC 取最新 8 条（视图内 rn<=8 截断，
-- 消费方仍按 as_of DESC 读取）。
-- 数据源：dwd_fina_indicator（主）+ dwd_research_income（营收/利润/basic_eps，期对期
-- LEFT JOIN，带 H4 可见时点守卫：income 行只有不晚于本行可见时点披露才并入）。
-- ============================================================
CREATE OR REPLACE VIEW serving.v_cend_theme_fin_health AS
WITH fina AS (
    SELECT instrument_id,
           report_end_date,
           announced_at,
           roe,
           or_yoy_pct,
           debt_to_assets,
           netprofit_yoy_pct,
           grossprofit_margin,
           netprofit_margin,
           current_ratio,
           ROW_NUMBER() OVER (
               PARTITION BY instrument_id
               ORDER BY announced_at DESC NULLS LAST, report_end_date DESC
           ) AS rn
    FROM dwd_fina_indicator
),
income AS (
    SELECT instrument_id,
           report_end_date,
           announced_at AS income_announced_at,
           total_revenue,
           net_profit,
           net_profit_parent,
           basic_eps
    FROM dwd_research_income
)
SELECT f.instrument_id,
       -- 可见时点：财报公告日（date → +08:00 零点的 timestamptz）；as-of 判断只用 announced_at（H4）
       ((f.announced_at)::timestamp AT TIME ZONE 'Asia/Shanghai') AS as_of,
       f.report_end_date AS period,
       f.roe,
       f.or_yoy_pct,
       f.debt_to_assets,
       f.netprofit_yoy_pct,
       f.grossprofit_margin,
       f.netprofit_margin,
       f.current_ratio,
       i.total_revenue,
       i.net_profit,
       i.net_profit_parent,
       i.basic_eps,
       GREATEST(
           0,
           EXTRACT(EPOCH FROM (now() - ((f.announced_at)::timestamp AT TIME ZONE 'Asia/Shanghai'))) * 1000
       )::bigint AS staleness_ms
FROM fina f
LEFT JOIN income i
       ON i.instrument_id = f.instrument_id
      AND i.report_end_date = f.report_end_date
      -- H4 防未来函数：income 行晚于本行可见时点（fina.announced_at）披露的一律不并入 → NULL
      AND i.income_announced_at IS NOT NULL
      AND i.income_announced_at <= f.announced_at
WHERE f.rn <= 8;

COMMENT ON VIEW serving.v_cend_theme_fin_health IS
  'P1a T1 个股财务健康近 8 季（可见时点=announced_at，H4 禁 report_end_date as-of join；收入侧 income 并入带 announced_at <= fina.announced_at 守卫）';

