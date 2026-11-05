/**
 * DEV 预览用 mock 适配器（仅 `import.meta.env.DEV && VITE_DATA_MODE=mock` 可达）。
 *
 * 目的：让新页面/状态机/testid 在真实端点冻结前可被本地与 headless 验证。
 * 约束：
 *  - 返回值一律带 `demo: true`，页面必须显示「本地演示数据」标识；
 *  - 不编造真实证券名称/行情，梯队 mock 行用演示代码（DEMO:xxxx）且 name=null；
 *  - 生产构建中本文件被摇树删除（见 data/ai/index.ts）。
 *
 * 演示开关（URL `?mock=...`，与行情 mock 保持一致）：
 *  - guest           复盘页返回 anonymous；
 *  - review-empty    自选为空；
 *  - review-unavailable 汇总端点未接入（渲染缺口卡）；
 *  - limits-empty    梯队为空。
 */
import type { GapReason } from '../../lib/copy';
import type {
  LimitLadder,
  LimitLadderResult,
  LimitRow,
  PortfolioMetrics,
  PortfolioReviewResult,
  ReviewPeriod,
  ReviewGateway,
} from './types';

const MOCK_WATCHLIST_KEY = 'h5.mock.watchlist';
const MOCK_DELAY_MS = 150;
const AS_OF = '2026-11-03T15:00:00+08:00';

/** 固定演示指标（按区间确定，不随时间抖动），页面必须显示 demo 标识。 */
const DEMO_METRICS: Readonly<Record<ReviewPeriod, PortfolioMetrics>> = {
  '1m': { instrumentCount: 0, periodReturnPct: 2.14, annualizedVolPct: 16.8, maxDrawdownPct: -3.42, equalWeightReturnPct: 2.14 },
  '3m': { instrumentCount: 0, periodReturnPct: 5.63, annualizedVolPct: 18.4, maxDrawdownPct: -7.65, equalWeightReturnPct: 5.63 },
  '6m': { instrumentCount: 0, periodReturnPct: 8.92, annualizedVolPct: 19.7, maxDrawdownPct: -9.31, equalWeightReturnPct: 8.92 },
  '1y': { instrumentCount: 0, periodReturnPct: 12.47, annualizedVolPct: 21.2, maxDrawdownPct: -14.08, equalWeightReturnPct: 12.47 },
};

function readMockWatchlist(): string[] {
  try {
    const raw = window.localStorage.getItem(MOCK_WATCHLIST_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mockParam(): string | null {
  return new URLSearchParams(window.location.search).get('mock');
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), MOCK_DELAY_MS);
  });
}

function demoRow(
  instrumentId: string,
  board: string,
  changePct: number,
  streakDays: number | null,
): LimitRow {
  return { instrumentId, name: null, board, changePct, streakDays };
}

function demoLadder(): LimitLadder {
  return {
    upCount: 12,
    downCount: 3,
    maxStreakDays: 5,
    streakBuckets: [
      { streakDays: 2, count: 4 },
      { streakDays: 3, count: 3 },
      { streakDays: 4, count: 2 },
      { streakDays: 5, count: 1 },
    ],
    stExcludedCount: 2,
    caliberVersion: 'provisional-1',
    provisional: true,
    source: { source: 'platform_snapshot', asOf: AS_OF, stalenessMs: 3_600_000 },
    demo: true,
    // 内部评测明细：C 端页面不得渲染（H3 排序榜禁区），这里保留是为了后续内部后台。
    instrumentRows: {
      up: [
        demoRow('DEMO:0001', 'main', 10, null),
        demoRow('DEMO:0002', 'gem', 20, 2),
      ],
      down: [demoRow('DEMO:0003', 'main', -10, null)],
      streak: [
        demoRow('DEMO:0002', 'gem', 20, 2),
        demoRow('DEMO:0004', 'main', 10, 3),
      ],
    },
  };
}

export function createMockReviewGateway(): ReviewGateway {
  return {
    async getPortfolioReview(period: ReviewPeriod): Promise<PortfolioReviewResult> {
      const mode = mockParam();
      if (mode === 'review-unavailable') {
        return delay({ status: 'unavailable', reason: 'not_integrated' as GapReason });
      }
      if (mode === 'guest') return delay({ status: 'anonymous' });

      const watchlist = readMockWatchlist();
      if (watchlist.length === 0) return delay({ status: 'empty' });

      const metrics = DEMO_METRICS[period];
      return delay({
        status: 'ready',
        metrics: { ...metrics, instrumentCount: watchlist.length },
        source: { source: 'platform_snapshot', asOf: AS_OF, stalenessMs: 3_600_000 },
        demo: true,
      });
    },

    async getLimitLadder(): Promise<LimitLadderResult> {
      if (mockParam() === 'limits-empty') return delay({ status: 'empty' });
      if (mockParam() === 'review-unavailable') {
        return delay({ status: 'unavailable', reason: 'not_integrated' as GapReason });
      }
      return delay({ status: 'ready', ladder: demoLadder() });
    },
  };
}
