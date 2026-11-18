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

-- ============================================================
-- T2 valuation-price：个股估值行情（近 1 年 / 近 3 年，日频）
-- 行 = 一个交易日：close 以 dwd_stock_bar_daily 为价格真源，pe_ttm / pb /
-- turnover_rate_pct 来自 dwd_daily_basic（LEFT JOIN，缺估值行时留 NULL 不丢价格行）。
-- 窗口（1y=250、3y=750 交易日）与分位在消费方（services/market 仓储 SQL）按 range
-- 参数执行；视图只出该标的全序列（与其它 v_cend_* 视图一致，不做行数截断）。
-- ============================================================
CREATE OR REPLACE VIEW serving.v_cend_theme_valuation_price AS
SELECT bar.instrument_id,
       bar.trade_date,
       basic.pe_ttm,
       basic.pb,
       bar.close,
       basic.turnover_rate_pct
FROM dwd_stock_bar_daily bar
LEFT JOIN dwd_daily_basic basic
       ON basic.instrument_id = bar.instrument_id
      AND basic.trade_date = bar.trade_date;

COMMENT ON VIEW serving.v_cend_theme_valuation_price IS
  'P1a T2 个股估值行情日序列（价格真源 dwd_stock_bar_daily，估值/换手 dwd_daily_basic；窗口与分位按 range 在消费方 SQL 计算）';

-- ============================================================
-- T3 money-sentiment（市场级）：情绪四件套 + 资金面（日粒度，近 30 日窗口在消费方）
-- 每行 = 一个交易日；最终输出只按 trade_date 聚合、无个股行（H3 m02407 红线：
-- 市场级汇总计数，禁个股梯队明细）。
-- 四件套底座 = dwd_daily_basic.limit_status（L202b/L203 口径：1/5=涨停、2/6=跌停），
-- 最高连板数 = 窗口函数按交易日相邻算 streak：全局交易日历 day_idx 相邻（+1）且
-- limit-up 连续才延续 run，停牌/断档即新开 run（island 技法：SUM(new_run) 累积分组）。
-- 涨跌家数 = dwd_stock_bar_daily close vs prev_close（prev_close NULL 首日不计入）；
-- 资金面 = dwd_moneyflow 全市场净流入合计 + dwd_margin 两交易所融资余额合计（与
-- c-end-metrics.sql L203 同口径）。
-- ============================================================
CREATE OR REPLACE VIEW serving.v_cend_theme_sentiment_market AS
WITH calendar AS (
    SELECT trade_date,
           ROW_NUMBER() OVER (ORDER BY trade_date) AS day_idx
    FROM (SELECT DISTINCT trade_date FROM dwd_daily_basic) d
),
base AS (
    SELECT b.instrument_id,
           c.trade_date,
           c.day_idx,
           (b.limit_status::numeric IN (1, 5)) AS is_up,
           LAG(c.day_idx) OVER w AS prev_idx,
           LAG(b.limit_status::numeric IN (1, 5)) OVER w AS prev_up
    FROM dwd_daily_basic b
    JOIN calendar c ON c.trade_date = b.trade_date
    WINDOW w AS (PARTITION BY b.instrument_id ORDER BY c.day_idx)
),
runs AS (
    SELECT instrument_id,
           trade_date,
           is_up,
           SUM(CASE WHEN is_up AND prev_up AND day_idx = prev_idx + 1
                    THEN 0 ELSE 1 END)
               OVER (PARTITION BY instrument_id ORDER BY day_idx
                     ROWS UNBOUNDED PRECEDING) AS run_id
    FROM base
),
streaks AS (
    SELECT trade_date,
           MAX(run_len) AS max_limit_streak
    FROM (
        SELECT trade_date,
               is_up,
               COUNT(*) OVER (PARTITION BY instrument_id, run_id) AS run_len
        FROM runs
    ) s
    WHERE is_up
    GROUP BY trade_date
),
day_limits AS (
    SELECT trade_date,
           COUNT(*) FILTER (WHERE limit_status::numeric IN (1, 5)) AS limit_up_count,
           COUNT(*) FILTER (WHERE limit_status::numeric IN (2, 6)) AS limit_down_count
    FROM dwd_daily_basic
    GROUP BY trade_date
),
day_bars AS (
    SELECT trade_date,
           COUNT(*) FILTER (WHERE prev_close IS NOT NULL AND close > prev_close) AS advancers,
           COUNT(*) FILTER (WHERE prev_close IS NOT NULL AND close < prev_close) AS decliners
    FROM dwd_stock_bar_daily
    GROUP BY trade_date
),
day_flow AS (
    SELECT trade_date,
           SUM(net_inflow_amount) AS moneyflow_net_inflow_total
    FROM dwd_moneyflow
    GROUP BY trade_date
),
day_margin AS (
    SELECT trade_date,
           SUM(financing_balance) AS margin_financing_balance
    FROM dwd_margin
    GROUP BY trade_date
)
SELECT l.trade_date,
       l.limit_up_count,
       l.limit_down_count,
       b.advancers,
       b.decliners,
       CASE WHEN COALESCE(b.decliners, 0) = 0 THEN NULL
            ELSE ROUND(b.advancers::numeric / b.decliners, 4)
       END AS adv_dec_ratio,
       s.max_limit_streak,
       f.moneyflow_net_inflow_total,
       m.margin_financing_balance
FROM day_limits l
LEFT JOIN day_bars b USING (trade_date)
LEFT JOIN streaks s USING (trade_date)
LEFT JOIN day_flow f USING (trade_date)
LEFT JOIN day_margin m USING (trade_date);

COMMENT ON VIEW serving.v_cend_theme_sentiment_market IS
  'P1a T3 市场级资金与情绪日序列（涨停/跌停家数+涨跌家数比+最高连板数[limit_status streak 按交易日相邻]+全市场净流入+两融融资余额；只市场级汇总，H3 m02407）';

-- ============================================================
-- T3 money-sentiment（个股级，近 30 日窗口在消费方）
-- 每行 = 该股一个有数据的交易日（moneyflow / top_list / top_inst / 个股融资 任一）。
-- H3 m02407 红线：本视图不含任何涨跌停/梯队列（limit_status、dwd_stk_limit 禁入，
-- 静态守门见 services/market/test/c-end-themes.test.ts）。
-- 数据源：dwd_moneyflow 主力净流入（可负，NULL 不补 0）+ dwd_top_list 上榜净额
-- （同股同日多 reason 重复行，MAX 去重）+ dwd_top_inst 机构席位净买入合计 + 
-- dwd_research_margin_detail 个股融资余额（dwd_margin 是交易所级 PK(exchange,trade_date)，
-- 个股级不可用——口径更正见 A3 完工报告）。
-- ============================================================
CREATE OR REPLACE VIEW serving.v_cend_theme_sentiment_stock AS
WITH days AS (
    SELECT instrument_id, trade_date FROM dwd_moneyflow
    UNION
    SELECT instrument_id, trade_date FROM dwd_top_list
    UNION
    SELECT instrument_id, trade_date FROM dwd_top_inst
    UNION
    SELECT instrument_id, trade_date FROM dwd_research_margin_detail
),
lhb AS (
    SELECT instrument_id, trade_date, MAX(lhb_net_amount) AS lhb_net_amount
    FROM dwd_top_list
    GROUP BY instrument_id, trade_date
),
inst AS (
    SELECT instrument_id, trade_date, SUM(net_buy_amount) AS inst_net_buy_amount
    FROM dwd_top_inst
    GROUP BY instrument_id, trade_date
)
SELECT d.instrument_id,
       d.trade_date,
       mf.net_inflow_amount,
       lhb.lhb_net_amount,
       inst.inst_net_buy_amount,
       md.financing_balance
FROM days d
LEFT JOIN dwd_moneyflow mf
       ON mf.instrument_id = d.instrument_id AND mf.trade_date = d.trade_date
LEFT JOIN lhb
       ON lhb.instrument_id = d.instrument_id AND lhb.trade_date = d.trade_date
LEFT JOIN inst
       ON inst.instrument_id = d.instrument_id AND inst.trade_date = d.trade_date
LEFT JOIN dwd_research_margin_detail md
       ON md.instrument_id = d.instrument_id AND md.trade_date = d.trade_date;

COMMENT ON VIEW serving.v_cend_theme_sentiment_stock IS
  'P1a T3 个股资金与情绪日序列（主力净流入+龙虎榜净额+机构席位净买+个股融资余额；无涨跌停列，H3 m02407；窗口与汇总在消费方 SQL）';

