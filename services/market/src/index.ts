/**
 * @market-sense/market —— A3 域插件公共出口（只导出插件与端口/配置类型，不导出内部实现细节）。
 */

export {
  marketPlugin,
  createMarketPlugin,
  type MarketDomainPlugin,
  type MarketPluginOptions,
} from './plugin.js';
export {
  readDataReadiness,
  parseIngestReport,
  resolveIngestReportPath,
  createDataReadinessContribution,
  type DataReadiness,
  type HealthContribution,
  type IngestReport,
  type QualityLevel,
} from './health.js';
export { isEntitlementExpired } from './domain/entitlement.js';
export {
  INSTRUMENT_PUBLIC_FIELDS,
  assertInstrumentWhitelist,
} from './domain/build.js';
export { loadMarketConfig, MarketConfigError } from './config.js';
export type { DataTier, MarketConfig, DisclaimerConfig } from './config.js';
export type { Authenticate, Principal } from './auth.js';
export type {
  AdjType,
  BarRow,
  BarsPage,
  BarsQuery,
  Board,
  Exchange,
  FactorRow,
  FundamentalSummaryRow,
  InstrumentRow,
  LimitStatus,
  ListStatus,
  QuoteRow,
  SecurityType,
  ServingRepo,
  SourceInfo,
} from './ports/serving-repo.js';
export type {
  WatchlistAddResult,
  WatchlistItemRow,
  WatchlistRepo,
} from './ports/watchlist-repo.js';
export { WatchlistLimitExceededError } from './ports/watchlist-repo.js';
export { ServingDataError } from './errors.js';
