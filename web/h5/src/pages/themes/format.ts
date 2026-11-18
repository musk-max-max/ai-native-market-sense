/**
 * 主题页数值格式化（M1a-F3）。
 * 单位一律取 copy.units（compliance 单一来源门禁）；null/非有限数 → MISSING 占位，不猜不造。
 */
import { copy, MISSING } from '../../lib/copy';

export function pct(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return value.toFixed(digits) + ' ' + copy.units.percent;
}

export function plain(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}

export function price(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return value.toFixed(2) + ' ' + copy.units.yuanPerShare;
}

export function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return Math.round(value).toString() + ' ' + copy.units.yuan;
}

export function count(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return String(Math.round(value));
}

export function percentile(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return value.toFixed(1) + '%';
}

export function median(values: readonly (number | null)[]): number | null {
  const sorted = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}
