import type { ProblemNotice } from '../data/model';

/**
 * 403 Problem 的展示行（H4 #5）。
 *
 * 返回顺序固定为 title、detail（detail 缺失则只有 title）。
 * 不做换行拼接、不追加解释性 hint：页面把每一行原样放进独立节点，
 * 保证「去掉 API 两段文本后，notice 不剩任何文案」。
 */
export function problemNoticeLines(problem: ProblemNotice | null): string[] {
  if (!problem) return [];
  const lines = [problem.title.trim()];
  const detail = problem.detail?.trim() ?? '';
  if (detail) lines.push(detail);
  return lines.filter((line) => line.length > 0);
}
