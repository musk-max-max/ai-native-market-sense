/**
 * 数据层装配。
 *
 * 默认走真实契约客户端（@market-sense/api-client，A0 生成）。
 * mock 适配器**只在开发模式**可用：生产构建即使误传 VITE_DATA_MODE=mock 也会走真实客户端，
 * 避免「前端 flag 自行放行演示数值」这类合规风险（H4）。
 *
 * 页面只 import gateway，不知道底层是 API 还是 mock，也不写裸 fetch。
 */
import type { MarketGateway } from './gateway';
import { createApiGateway } from './apiGateway';
import { createMockGateway } from './mockGateway';

const DATA_MODE = ((import.meta.env.VITE_DATA_MODE as string | undefined) ?? 'api').toLowerCase();

/** 唯一放行条件：开发模式 + 显式 mock；生产构建中 DEV 为 false，mock 分支被摇树删除。 */
const useMock = import.meta.env.DEV && DATA_MODE === 'mock';

export const gateway: MarketGateway = useMock ? createMockGateway() : createApiGateway();

export type { MarketGateway } from './gateway';
