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
import { HttpThemeGateway, type ThemeGateway } from './themeGateway';
import { authFetch, handleUnauthorized } from '../lib/auth';

const DATA_MODE = ((import.meta.env.VITE_DATA_MODE as string | undefined) ?? 'api').toLowerCase();

/** 唯一放行条件：开发模式 + 显式 mock；生产构建中 DEV 为 false，mock 分支被摇树删除。 */
const useMock = import.meta.env.DEV && DATA_MODE === 'mock';

export const gateway: MarketGateway = useMock ? createMockGateway() : createApiGateway();

/**
 * 主题数据网关（M1a-F，T1/T2/T3 主题端点）：始终走真实 HTTP，
 * 不提供 mock 分支（无前端 flag 放行演示数值；dev/E2E 需要假数据时走网络层拦截）。
 * Bearer 注入与 401 收口在装配点传入（网关本体保持零相对依赖，node 测试可直接导入）。
 */
export const themeGateway: ThemeGateway = new HttpThemeGateway('', {
  fetchImpl: authFetch,
  onUnauthorized: handleUnauthorized,
});

export type { MarketGateway } from './gateway';
export type { ThemeGateway, ThemeResult, ColdError } from './themeGateway';
