/**
 * E2E testid 映射（唯一真源：tests/e2e/testids.json，owner: A12）。
 *
 * 约束：
 *  - 任何 testid 的新增/改名都必须先在 testids.json 注册，本文件只做映射，不自创 id；
 *  - `disclaimerClose` 故意不在此处：免责声明不可关闭，DOM 中不得渲染任何关闭控件（AC-4）；
 *  - loading / error 态使用独立、常驻的节点 id，便于 E2E 稳定等待。
 */
export const TID = {
  stockPage: 'stock-page',
  stockHeader: 'stock-header',
  instrumentId: 'stock-instrument-id',
  stockName: 'stock-name',
  stockExchange: 'stock-exchange',
  stockBoard: 'stock-board',
  stockSecurityType: 'stock-security-type',
  stockListStatus: 'stock-list-status',
  stockListDate: 'stock-list-date',

  quoteBlock: 'quote-block',
  quotePrice: 'quote-price',
  quoteChange: 'quote-change',
  quoteAsOf: 'quote-as-of',
  quoteStaleBadge: 'quote-stale-badge',
  quoteAdjustment: 'quote-adjustment',
  quoteSource: 'quote-source',

  entitlementNotice: 'entitlement-notice',

  disclaimer: 'disclaimer',
  disclaimerText: 'disclaimer-text',
  disclaimerVersion: 'disclaimer-version',

  fundamentalSummary: 'fundamental-summary',
  fundamentalReportPeriod: 'fundamental-report-period',
  fundamentalStatementBasis: 'fundamental-statement-basis',

  watchlistToggle: 'watchlist-toggle',
  watchlistState: 'watchlist-state',

  errorBanner: 'error-banner',
  stockPageError: 'stock-page-error',
  stockPageEmpty: 'stock-page-empty',
  loading: 'stock-page-loading',
} as const;

export type TestId = (typeof TID)[keyof typeof TID];
