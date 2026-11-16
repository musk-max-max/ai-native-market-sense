/**
 * C 端涨跌停市场级汇总聚合器（H3 m02407 唯一允许形态）。
 *
 * 后端 /v1/c-end/limits 返回 per-instrument 行（serving.v_cend_limit_ladder），
 * 前端只把行聚合成市场级计数（up/down），不把任何个股名称/代码/排序送进渲染路径。
 *
 * 口径边界（provisional）：
 *  - up/down 按 limit_status ('U'/'D') 计数；
 *  - Z（触及未封住）不计入任一侧（H3 未裁定，provisional）；
 *  - ST 排除需要 name LIKE '%ST%'，本聚合器在视图未提供 ST 标记前不做（provisional=0）；
 *  - streakDays 需要跨日连板 join，本聚合器不支持（maxStreakDays=null, streakBuckets=[]）。
 */
import type { LimitLadder } from './ai/types';
import type { LimitLadderRow } from './cEndMetricsGateway';

/** 当前聚合器口径版本（provisional）；调整口径必须 bump。 */
export const LIMIT_LADDER_CALIBER_VERSION = 'c-end-limits-v1.provisional';

function countByStatus(rows: readonly LimitLadderRow[], status: 'U' | 'D'): number {
  let count = 0;
  for (const row of rows) {
    if (row.limit_status === status) count += 1;
  }
  return count;
}

function latestAsOf(rows: readonly LimitLadderRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    const asOf = row.as_of;
    if (typeof asOf === 'string' && (latest === null || asOf > latest)) latest = asOf;
  }
  return latest;
}

export function aggregateLimitLadder(rows: readonly LimitLadderRow[]): LimitLadder | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const asOf = latestAsOf(rows);
  // 无任何 as_of → 数据时点不明，H3 禁渲染（页面会转 unavailable）。
  if (asOf === null) return null;
  return {
    upCount: countByStatus(rows, 'U'),
    downCount: countByStatus(rows, 'D'),
    maxStreakDays: null,
    streakBuckets: [],
    stExcludedCount: 0,
    caliberVersion: LIMIT_LADDER_CALIBER_VERSION,
    provisional: true,
    source: {
      source: 'platform_eod',
      asOf,
      stalenessMs: 0,
    },
    demo: false,
  };
}
