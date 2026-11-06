/**
 * Postprocess 空管线（INF-02）。
 *
 * ADR-007 D3 定义 P0–P8；本骨架只留阶段名和空实现，禁止在 P0 骨架里写合规判断。
 * INF-04 再实现授权解析/证据绑定/数值复算/合规过滤/定性/文案注入/审计。
 */

export type Audience = 'c_end' | 'internal';

export interface PostprocessContext {
  readonly audience: Audience;
  readonly policyVersion: string;
}

export interface PostprocessResult<T> {
  readonly output: T;
  readonly blocked: boolean;
  readonly reasonCodes: readonly string[];
}

export const POSTPROCESS_STAGES = [
  'P0-entitlement',
  'P1-tool-fetch',
  'P2-schema',
  'P3-evidence-binding',
  'P4-numeric-recalc',
  'P5-compliance-filter',
  'P6-qualitative',
  'P7-copy-injection',
  'P8-audit',
] as const;

/** 空管线：原样返回，不阻断；仅用于 INF-02 骨架与测试。 */
export async function runPostprocess<T>(
  input: T,
  context: PostprocessContext,
): Promise<PostprocessResult<T>> {
  void context;
  return { output: input, blocked: false, reasonCodes: [] };
}
