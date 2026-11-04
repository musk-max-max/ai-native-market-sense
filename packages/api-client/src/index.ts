/**
 * @market-sense/api-client
 *
 * 唯一入口：类型与路径来自 `contracts/` 生成的 `src/generated/*.ts`（禁止手改）。
 * 本文件只做薄装配：合并域 paths 类型 + 用 openapi-fetch 创建类型化客户端；
 * 不定义任何 DTO、不手写字段类型。业务侧（A7/A8）只允许 import 本包。
 *
 * 依据：ADR-001 D7（openapi-typescript + openapi-fetch 选型）、决策 #1（契约单一真源）。
 */
import createClient from 'openapi-fetch';
import type { ClientOptions } from 'openapi-fetch';

import type { components as FundamentalComponents, paths as FundamentalPaths } from './generated/fundamental.js';
import type { components as MarketComponents, paths as MarketPaths } from './generated/market.js';
import type { components as SharedComponents } from './generated/shared.js';
import type { components as WatchlistComponents, paths as WatchlistPaths } from './generated/watchlist.js';

/** 平台来源词表闭集（来自 SourceRef.source 的 enum）。前端写 `Record<SourceValue, string>` 可让漏 key 在 tsc 阶段失败。 */
export type SourceValue = SharedComponents['schemas']['SourceRef']['source'];

export type { FundamentalComponents, MarketComponents, SharedComponents, WatchlistComponents };

export type { paths as FundamentalPaths } from './generated/fundamental.js';
export type { paths as MarketPaths } from './generated/market.js';
export type { paths as WatchlistPaths } from './generated/watchlist.js';

/** 全部 P0 域的路径合集（market / fundamental / watchlist）。 */
export type ApiPaths = MarketPaths & FundamentalPaths & WatchlistPaths;

/**
 * 创建类型化 API 客户端。
 *
 * @example
 * const api = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL });
 * const { data, error, response } = await api.GET('/v1/instruments/{instrument_id}/quote', {
 *   params: { path: { instrument_id: 'SSE:600519' } },
 * });
 */
export function createApiClient(options: ClientOptions = {}) {
  return createClient<ApiPaths>(options);
}

/** 客户端实例类型（A7 可在 props/依赖注入中使用，避免 any）。 */
export type ApiClient = ReturnType<typeof createApiClient>;
