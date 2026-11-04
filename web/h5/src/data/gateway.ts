/**
 * 数据访问端口（port）。
 *
 * 页面只依赖本接口；真实实现由 @market-sense/api-client 的类型化客户端提供，
 * mock 实现只用于本地 UI/状态开发（形状对齐契约，不伪造超出契约的字段）。
 *
 * 错误只携带 **HTTP 状态码** 与「是否网络层失败」，不携带内部错误码：
 * 用户文案由 lib/copy.ts 按状态码映射（H3：客户端可取得的内部码出口必须关闭）。
 */
import type { StockPageData } from './model';

/** 页面级错误：status 为 null 表示没拿到合法响应（网络失败或响应结构不合法）。 */
export interface GatewayError {
  /** HTTP 状态码；无响应时为 null。 */
  status: number | null;
  /** 是否网络层失败（fetch 抛错 / 浏览器离线）；与「有响应但结构异常」区分。 */
  network: boolean;
}

export type StockPageResult =
  | { kind: 'ready'; data: StockPageData }
  | ({ kind: 'error'; instrumentId: string } & GatewayError);

export type WatchlistResult =
  | { kind: 'ready'; instrumentIds: string[] }
  | { kind: 'anonymous' }
  | ({ kind: 'error' } & GatewayError);

export type WatchlistMutationResult =
  | { kind: 'ok' }
  | { kind: 'anonymous' }
  | ({ kind: 'error' } & GatewayError);

export interface MarketGateway {
  getStockPage(instrumentId: string): Promise<StockPageResult>; // eslint-disable-line no-unused-vars
  getWatchlist(): Promise<WatchlistResult>;
  addToWatchlist(instrumentId: string): Promise<WatchlistMutationResult>; // eslint-disable-line no-unused-vars
  removeFromWatchlist(instrumentId: string): Promise<WatchlistMutationResult>; // eslint-disable-line no-unused-vars
}
