/**
 * AI 功能层数据装配（与行情 data/index.ts 同一套环境判定）。
 *
 * - 生产构建：unavailableGateway（显式缺口，不猜、不演示）；
 * - DEV + VITE_DATA_MODE=mock：mockReviewGateway（demo 标识）；
 * - DEV + 真实数据模式：同样 unavailable，直到 AI 汇总端点冻结接入。
 */
import type { ReviewGateway } from './types';
import { createMockReviewGateway } from './mockGateway';
import { createUnavailableReviewGateway } from './unavailableGateway';

const DATA_MODE = ((import.meta.env.VITE_DATA_MODE as string | undefined) ?? 'api').toLowerCase();
const useMock = import.meta.env.DEV && DATA_MODE === 'mock';

export const reviewGateway: ReviewGateway = useMock
  ? createMockReviewGateway()
  : createUnavailableReviewGateway();

export type { ReviewGateway } from './types';
