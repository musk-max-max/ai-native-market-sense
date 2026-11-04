/**
 * 页面展示模型（view model）。
 *
 * 注意：这里不是 API DTO。字段由 web/h5 依据「页面要展示什么」定义，
 * 由 data/ 适配层从 @market-sense/api-client 的契约类型映射而来；
 * 页面组件不直接依赖契约 JSON 结构，也不自行拼造后端字段。
 *
 * 合规约束：不保留权限分层取值等内部标识（H3：不得进入客户端可取得出口）。
 */

export type DataAccess = 'granted' | 'restricted';
export type FundamentalState = 'ready' | 'missing' | 'error';

/** 数据来源与时效（展示口径与 API meta.source 一一对应）。 */
export interface SourceInfo {
  /** canonical 数据源标识（契约枚举），经受控映射表转展示文案，不直接当文案用。 */
  source: string;
  /** API 返回的 as_of 原样展示（ISO8601 +08:00），不做前端时区换算（AC-2）。 */
  asOf: string;
  stalenessMs: number;
  /** 价格口径（不复权/前复权/后复权）；基础信息类响应无此字段。 */
  adjustment: string | null;
}

export interface DisclaimerInfo {
  /** 合规文案（A5 版本化发布），必须原样展示。 */
  text: string;
  /** 文案/规则版本号，用于留痕复核。 */
  version: string;
  /** 契约恒为 false；前端不渲染任何关闭/折叠入口。 */
  closable: boolean;
}

export interface QuoteInfo {
  tradeDate: string;
  lastPrice: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  suspended: boolean;
  limitStatus: string | null;
}

export interface FundamentalInfo {
  reportPeriod: string;
  reportEndDate: string;
  announcedAt: string;
  statementBasis: 'reported' | 'restated';
  revenue: number;
  netProfit: number;
  revenueYoyPct: number | null;
  netProfitYoyPct: number | null;
  eps: number | null;
  roePct: number | null;
  grossMarginPct: number | null;
  totalAssets: number | null;
  /** 财报自身的来源与时点，与行情 as_of 分开展示，不混用。 */
  source: SourceInfo;
}

export interface StockPageData {
  instrumentId: string;
  /** 证券简称；基础信息接口未收录时为 null。 */
  name: string | null;
  exchange: string | null;
  board: string | null;
  listStatus: string | null;
  securityType: string | null;
  listedAt: string | null;
  access: DataAccess;
  /** 无授权或数据不可用时为 null；为 null 时页面不得渲染任何价格数字。 */
  quote: QuoteInfo | null;
  /** 行情来源；受限场景改用仍可用的 meta 来源，完全不可用时为 null。 */
  source: SourceInfo | null;
  /** 免责文案；任何价格展示的前提是它存在（缺失则隐藏行情并报错）。 */
  disclaimer: DisclaimerInfo | null;
  fundamental: FundamentalInfo | null;
  fundamentalState: FundamentalState;
}
