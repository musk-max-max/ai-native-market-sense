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

  // AI 解读（A12 KD-COPY-REG-01 / ADR-007 B2-07：估值/成长/盈利质量/资金/风险五段）
  aiInterpretation: 'ai-interpretation',
  aiGeneratedBadge: 'ai-generated-badge',
  aiDisclaimer: 'ai-disclaimer',
  aiSegmentValuation: 'ai-segment-valuation',
  aiSegmentGrowth: 'ai-segment-growth',
  aiSegmentEarningsQuality: 'ai-segment-earnings-quality',
  aiSegmentCapitalFlow: 'ai-segment-capital-flow',
  aiSegmentRisk: 'ai-segment-risk',

  dataGapCard: 'data-gap-card',
  dataGapReason: 'data-gap-reason',

  portfolioReviewPage: 'portfolio-review-page',
  portfolioMetrics: 'portfolio-metrics',
  portfolioMetric: 'portfolio-metric',
  portfolioMetricValue: 'portfolio-metric-value',
  portfolioScopeNote: 'portfolio-scope-note',
  portfolioReviewLoading: 'portfolio-review-loading',
  portfolioReviewError: 'portfolio-review-error',
  portfolioReviewEmpty: 'portfolio-review-empty',

  limitLadderPage: 'limit-ladder-page',
  limitLadderTable: 'limit-ladder-table',
  limitProvisionalBanner: 'limit-provisional-banner',
  limitStExclusion: 'limit-st-exclusion',
  // B1-02 市场级汇总计数（C 端唯一允许形态，H3 m02407 / lead m02459）。请求 A12 登记。
  limitUpCount: 'limit-up-count',
  limitDownCount: 'limit-down-count',
  limitMaxStreak: 'limit-max-streak',
  limitStreakDistribution: 'limit-streak-distribution',
  limitLadderLoading: 'limit-ladder-loading',
  limitLadderError: 'limit-ladder-error',
  limitLadderEmpty: 'limit-ladder-empty',

  errorBanner: 'error-banner',
  stockPageError: 'stock-page-error',
  stockPageEmpty: 'stock-page-empty',
  loading: 'stock-page-loading',
} as const;

export type TestId = (typeof TID)[keyof typeof TID];
