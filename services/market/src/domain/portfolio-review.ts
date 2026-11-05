/**
 * B1-01 自选组合绝对表现（确定性计算，固定模板，无 LLM）。
 *
 * 口径（ADR-007 §D5 第 1 批）：
 *  - 输入是自选（watchlist）+ bars，输出是「自选组合」复盘；**不称真实持仓**（P0 无持仓账本）；
 *  - 绝对表现：区间收益、年化波动率、最大回撤、等权组合；
 *  - 相对基准/板块对比第 2 批（index_daily 未接），本轮以固定 gap 显式标注；
 *  - 历史不足（少于 2 个日收益点）的标的不出现在 items 中，只计入 gaps，不补数、不插值。
 *
 * 计算约定（契约 watchlist 0.3.0，写进 README 后不得静默改）：
 *  - 区间收益：`(endClose / startClose - 1) * 100`；
 *  - 波动率：日收益样本标准差 × sqrt(252) × 100；
 *  - 最大回撤：收盘价序列 peak-to-trough 最大跌幅（≤0，如 -12.34 表示 -12.34%）；
 *  - 等权组合：每个交易日对当日有收益的标等权平均，链式累乘；再按同公式算收益/波动/回撤。
 */

export type ReviewAdjustment = 'none' | 'qfq';

export interface ReviewBar {
  /** YYYY-MM-DD */
  readonly tradeDate: string;
  /** 十进制字符串（serving 端口精度约定） */
  readonly close: string;
}

export interface ReviewItemInput {
  readonly instrumentId: string;
  readonly name: string;
  readonly bars: readonly ReviewBar[];
}

export interface ReviewGap {
  readonly code: string;
  readonly message: string;
}

export interface ReviewItem {
  readonly instrument_id: string;
  readonly name: string;
  readonly start_close: number;
  readonly end_close: number;
  readonly range_return_pct: number;
  readonly volatility_pct: number;
  readonly max_drawdown_pct: number;
  readonly data_points: number;
}

export interface ReviewPortfolio {
  readonly equal_weight_return_pct: number;
  readonly volatility_pct: number;
  readonly max_drawdown_pct: number;
  readonly start_date: string;
  readonly end_date: string;
  readonly data_points: number;
}

export interface PortfolioReviewData {
  readonly from: string;
  readonly to: string;
  readonly adjustment: ReviewAdjustment;
  readonly items: ReviewItem[];
  readonly portfolio: ReviewPortfolio | null;
  readonly universe: {
    readonly count: number;
    /** 实际进入 items 的标的数 */
    readonly indicators_available: number;
  };
  readonly gaps: ReviewGap[];
}

const TRADING_DAYS_PER_YEAR = 252;

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function within(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

interface SeriesMetrics {
  readonly startClose: number;
  readonly endClose: number;
  readonly rangeReturnPct: number;
  readonly volatilityPct: number;
  readonly maxDrawdownPct: number;
  readonly dataPoints: number;
  readonly dailyReturns: ReadonlyArray<{ date: string; ret: number }>;
}

function metricsOfSeries(points: ReadonlyArray<{ date: string; close: number }>): SeriesMetrics | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  if (start === undefined || end === undefined || start.close <= 0) return null;

  const dailyReturns: Array<{ date: string; ret: number }> = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    if (prev === undefined || next === undefined || prev.close <= 0) continue;
    dailyReturns.push({ date: next.date, ret: next.close / prev.close - 1 });
  }
  // 契约：不足 2 个收益点不进入 items（波动率没有统计意义）。
  if (dailyReturns.length < 2) return null;

  const mean = dailyReturns.reduce((sum, item) => sum + item.ret, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((sum, item) => sum + (item.ret - mean) ** 2, 0) / (dailyReturns.length - 1);
  const volatilityPct = round4(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100);

  let peak = start.close;
  let maxDrawdown = 0;
  for (const point of points) {
    if (point.close > peak) peak = point.close;
    if (peak > 0) {
      const drawdown = point.close / peak - 1;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }
  }

  return {
    startClose: start.close,
    endClose: end.close,
    rangeReturnPct: round4((end.close / start.close - 1) * 100),
    volatilityPct,
    maxDrawdownPct: round4(maxDrawdown * 100),
    dataPoints: points.length,
    dailyReturns,
  };
}

function pointsOf(item: ReviewItemInput, from: string, to: string): Array<{ date: string; close: number }> {
  return item.bars
    .filter((bar) => within(bar.tradeDate, from, to))
    .map((bar) => ({ date: bar.tradeDate, close: parseNumber(bar.close) }))
    .filter((point): point is { date: string; close: number } => point.close !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 纯函数：不读库、不感知 HTTP/tier。调用方负责按 entitlement 决定是否调用
 * （受限档在路由层先 403，不进入本函数）。
 */
export function buildPortfolioReview(input: {
  readonly from: string;
  readonly to: string;
  readonly adjustment: ReviewAdjustment;
  readonly items: readonly ReviewItemInput[];
}): PortfolioReviewData {
  const included: Array<{ item: ReviewItemInput; metrics: SeriesMetrics }> = [];
  const partialHistoryNames: string[] = [];

  for (const item of input.items) {
    const metrics = metricsOfSeries(pointsOf(item, input.from, input.to));
    if (metrics === null) {
      partialHistoryNames.push(item.name);
      continue;
    }
    included.push({ item, metrics });
  }

  included.sort((a, b) => (a.item.instrumentId < b.item.instrumentId ? -1 : a.item.instrumentId > b.item.instrumentId ? 1 : 0));

  const items: ReviewItem[] = included.map(({ item, metrics }) => ({
    instrument_id: item.instrumentId,
    name: item.name,
    start_close: metrics.startClose,
    end_close: metrics.endClose,
    range_return_pct: metrics.rangeReturnPct,
    volatility_pct: metrics.volatilityPct,
    max_drawdown_pct: metrics.maxDrawdownPct,
    data_points: metrics.dataPoints,
  }));

  // 等权组合：按日期汇总入选标的日收益，当日可用标的等权平均；链式累乘成组合净值。
  const byDate = new Map<string, number[]>();
  for (const { metrics } of included) {
    for (const daily of metrics.dailyReturns) {
      const list = byDate.get(daily.date) ?? [];
      list.push(daily.ret);
      byDate.set(daily.date, list);
    }
  }
  const portfolioReturns = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, returns]) => ({
      date,
      ret: returns.reduce((sum, ret) => sum + ret, 0) / returns.length,
    }));

  let portfolio: ReviewPortfolio | null = null;
  if (included.length > 0 && portfolioReturns.length >= 2) {
    const firstDates = included
      .map(({ item }) => pointsOf(item, input.from, input.to)[0]?.date)
      .filter((date): date is string => date !== undefined)
      .sort();
    const startDate = firstDates[0] ?? portfolioReturns[0]?.date;
    const lastDate = portfolioReturns[portfolioReturns.length - 1]?.date;
    if (startDate !== undefined && lastDate !== undefined) {
      const points: Array<{ date: string; close: number }> = [{ date: startDate, close: 1 }];
      let index = 1;
      for (const daily of portfolioReturns) {
        index *= 1 + daily.ret;
        points.push({ date: daily.date, close: index });
      }
      const metrics = metricsOfSeries(points);
      if (metrics !== null) {
        portfolio = {
          equal_weight_return_pct: metrics.rangeReturnPct,
          volatility_pct: metrics.volatilityPct,
          max_drawdown_pct: metrics.maxDrawdownPct,
          start_date: startDate,
          end_date: lastDate,
          data_points: points.length,
        };
      }
    }
  }

  const gaps: ReviewGap[] = [];
  if (partialHistoryNames.length > 0) {
    gaps.push({
      code: 'PARTIAL_HISTORY',
      message: `部分标的历史数据不足（少于 2 个日收益点），未参与统计：${partialHistoryNames.join('、')}`,
    });
  }
  gaps.push({
    code: 'BENCHMARK_PENDING',
    message: '相对基准与板块对比待第 2 批接入（index_daily 未接入），本轮仅提供绝对表现。',
  });

  return {
    from: input.from,
    to: input.to,
    adjustment: input.adjustment,
    items,
    portfolio,
    universe: {
      count: input.items.length,
      indicators_available: included.length,
    },
    gaps,
  };
}
