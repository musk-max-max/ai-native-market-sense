/**
 * 冷数据重试节流（M1a-F3，需求 §4.3）。
 *
 * - 30s 客户端节流：超时/5xx 场景的重试按钮在窗口内禁用，且网关层不自动重试
 *   （冷却期内只允许手动点击）；key 建议用主题数据 URL 或 themeKey。
 * - Retry-After 解析在 data/themeGateway.ts（HTTP 层职责）。
 */

/** 客户端重试冷却窗口（毫秒），需求 §4.3 场景 B/C 统一 30s。 */
export const THROTTLE_MS = 30_000;

const attempts = new Map<string, number>();

/** 距离下次可点击重试的剩余毫秒数（0=可重试）。 */
export function remainingMs(key: string, now: number = Date.now()): number {
  const last = attempts.get(key);
  if (last === undefined) return 0;
  return Math.max(0, last + THROTTLE_MS - now);
}

/** 剩余秒数（向上取整，供倒计时展示）。 */
export function remainingSec(key: string, now: number = Date.now()): number {
  return Math.ceil(remainingMs(key, now) / 1000);
}

/** 窗口内是否允许再次发起请求（冷却中=false）。 */
export function canAttempt(key: string, now: number = Date.now()): boolean {
  return remainingMs(key, now) === 0;
}

/** 记录一次请求尝试（点击重试时打点，起 30s 冷却）。 */
export function markAttempt(key: string, now: number = Date.now()): void {
  attempts.set(key, now);
}

/** 清除节流状态（key 省略时全清；测试隔离用）。 */
export function resetThrottle(key?: string): void {
  if (key === undefined) attempts.clear();
  else attempts.delete(key);
}
