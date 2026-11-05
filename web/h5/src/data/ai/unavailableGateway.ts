/**
 * 生产骨架：真实端点未接入时的诚实实现。
 *
 * ADR-007 D5 第 1 批只验收「确定性结果 + 骨架 + 缺口显式」。在 `contracts/ai/openapi.yaml`
 * 冻结、A3 汇总 API 可用之前，生产构建必须走这里返回 unavailable，由页面渲染缺口卡；
 * **不得用 mock 数值伪装面客结果**（H4 / ADR-007 D4）。
 */
import type { ReviewGateway } from './types';

export function createUnavailableReviewGateway(): ReviewGateway {
  return {
    async getPortfolioReview() {
      return { status: 'unavailable', reason: 'not_integrated' } as const;
    },
    async getLimitLadder() {
      return { status: 'unavailable', reason: 'not_integrated' } as const;
    },
  };
}
