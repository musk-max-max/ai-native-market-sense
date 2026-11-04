/**
 * 展示格式化。
 *
 * 原则：
 *  - 价格严格保留后端精度（两位小数），不加千分位，避免 E2E / 用户复制解析时产生歧义；
 *  - 涨跌幅带符号与 %，满足 AC-8：^[+-]\d+(\.\d+)?%$；
 *  - 缺失值一律显式展示「—」，绝不用 0 冒充（契约明确禁止）；
 *  - as_of 原样展示 API 返回的 ISO8601 字符串（+08:00），不做前端时区换算（AC-2 严格相等）；
 *  - 本文件不写用户可见文案，单位与占位符来自 lib/copy.ts（H3 单一来源）。
 */

import { copy, MISSING } from './copy';

/** 延时时长阈值：> 15 分钟视为非实时快照（与 contracts/shared SourceRef 口径一致）。 */
export const STALE_THRESHOLD_MS = 900_000;

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING;
  return `${value.toFixed(2)} ${copy.units.yuan}`;
}

export function formatChangePct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING;
  const sign = value < 0 ? '-' : '+';
  return `${sign}${Math.abs(value).toFixed(2)}${copy.units.percent}`;
}

export function formatSignedAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING;
  const sign = value < 0 ? '-' : '+';
  return `${sign}${Math.abs(value).toFixed(2)}`;
}

/** 整数展示（财报金额等），保留千分位便于阅读；不等于行情价格的展示口径。 */
export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

export function formatRatioPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING;
  return `${value.toFixed(2)}${copy.units.percent}`;
}

export function formatStaleness(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return copy.units.zeroMinutes;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}${copy.units.minutes}`;
  return `${(ms / 3_600_000).toFixed(1)}${copy.units.hours}`;
}

export function isStale(stalenessMs: number): boolean {
  return Number.isFinite(stalenessMs) && stalenessMs > STALE_THRESHOLD_MS;
}

export function adjustmentLabel(value: string | undefined): string {
  if (!value) return MISSING;
  return copy.labels.adjustment[value] ?? value;
}

export function statementBasisLabel(value: string): string {
  return copy.labels.statementBasis[value] ?? value;
}

/** 「涨」「跌」「平」配色语义（A 股：红涨绿跌），仅用于视觉，不替代文字信息。 */
export function priceTone(value: number | null | undefined): 'up' | 'down' | 'flat' {
  if (value === null || value === undefined || Number.isNaN(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}
