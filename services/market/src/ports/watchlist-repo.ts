/**
 * 自选存储端口（hexagonal port，consumer-owned）。
 *
 * 自选是平台自有数据（platform_user_data），不来自 tushare/serving view，A3 自己落 PG：
 * `watchlist_items(user_id, instrument_id, added_at)`，迁移见 `services/market/migrations/`。
 *
 * 幂等语义（契约）：POST 重复添加返回 200 且 added_at 保持首次值；DELETE 不存在同样 204。
 */

export interface WatchlistItemRow {
  readonly instrument_id: string;
  readonly added_at: Date;
}

export interface WatchlistAddResult {
  readonly item: WatchlistItemRow;
  /** false = 已存在（幂等命中），true = 本次新增 */
  readonly created: boolean;
}

/** 超过运营配置的自选上限（契约：400 VALIDATION_ERROR，数值不在契约里写死）。 */
export class WatchlistLimitExceededError extends Error {
  override readonly name = 'WatchlistLimitExceededError';
  constructor(readonly limit: number) {
    super(`自选数量超过上限 ${limit}`);
  }
}

export interface WatchlistRepo {
  list(userId: string): Promise<WatchlistItemRow[]>;
  add(userId: string, instrumentId: string, limit: number): Promise<WatchlistAddResult>;
  remove(userId: string, instrumentId: string): Promise<void>;
  /** 建表（IF NOT EXISTS）。生产由迁移执行；E2E/本地可用 WATCHLIST_AUTO_MIGRATE=1 兜底。 */
  ensureSchema(): Promise<void>;
}
