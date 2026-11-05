/**
 * 只读 serving 数据端口（hexagonal port，consumer-owned；对端契约见 warehouse/serving/ports.yaml）。
 *
 * 归属：A3（services/market）。实现见 `adapters/pg-serving-repo.ts`：只 SELECT `serving.*` view，
 * **不直接读写 warehouse 的 dwd_ 与 dim_ 前缀表**，也**不在 TS 里算 qfq/hfq**（serving 已按 adj_type 固化三口径）。
 *
 * 精度约定（ports.yaml）：价格/金额/比率以十进制字符串出端口，避免 JS float 丢精度；
 * 由 `domain/build.ts` 在 HTTP 边界转 number。volume 为整数。
 *
 * 时效约定：每行自带 source/as_of/staleness_ms，serving SQL 计算且钳制 ≥0；A3 原样放进 meta.source。
 */

export type AdjType = 'none' | 'qfq' | 'hfq';
export type Exchange = 'SSE' | 'SZSE' | 'BSE';
export type Board = 'main' | 'gem' | 'star' | 'bse';
export type SecurityType = 'stock' | 'etf' | 'index';
export type ListStatus = 'listed' | 'delisted' | 'pre_listed';
export type LimitStatus = 'none' | 'limit_up' | 'limit_down';

/** serving 行级来源与时点（契约 SourceRef 的原始素材，A3 不自拼 as_of/staleness）。 */
export interface SourceInfo {
  readonly source: string;
  /** +08:00 ISO8601，来自 serving view 的 as_of */
  readonly asOf: string;
  /** now() - as_of 毫秒，serving SQL 已钳制 ≥0 */
  readonly stalenessMs: number;
}

export interface InstrumentRow extends SourceInfo {
  readonly instrument_id: string;
  readonly exchange: Exchange;
  readonly code: string;
  readonly name: string;
  readonly board: Board;
  readonly security_type: SecurityType;
  readonly list_status: ListStatus;
  readonly lot_size: number;
  readonly listed_at: string | null;
  /** 是否允许进入 C 端结果集（A2 m00854：C 端判定 = entitlement_ok AND display_safe）。 */
  readonly display_safe: boolean;
}

/**
 * 调用方受众（Lead m00895）：过滤放在 repo 层，domain 不再兜第二层。
 * c_end：不返回 display_safe=false 的标的；internal：内部评测态可读取。
 */
export type Audience = 'c_end' | 'internal';

/**
 * 最新行情快照。三态（ports.yaml）：
 *  - suspended=false：有最新行情；
 *  - suspended=true：停牌，价格/涨跌幅为 null（volume/amount 也为 null，A3 按「当日无成交」映射为 0）；
 *  - repo 返回 null：无 bar 且无停牌证据 → 数据未就绪（A3 返 404 NOT_FOUND，不推断为停牌）。
 */
export interface QuoteRow extends SourceInfo {
  readonly instrument_id: string;
  readonly trade_date: string | null;
  readonly open: string | null;
  readonly high: string | null;
  readonly low: string | null;
  readonly close: string | null;
  readonly prev_close: string | null;
  readonly change: string | null;
  readonly change_pct: string | null;
  readonly volume: number | null;
  readonly amount: string | null;
  readonly suspended: boolean;
  readonly limit_status: LimitStatus;
}

export interface BarRow extends SourceInfo {
  readonly instrument_id: string;
  readonly trade_date: string;
  readonly adj_type: AdjType;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: number;
  readonly amount: string;
  readonly factor: string | null;
}

export interface FactorRow extends SourceInfo {
  readonly instrument_id: string;
  readonly trade_date: string;
  readonly factor: string;
}

export interface FundamentalSummaryRow extends SourceInfo {
  readonly instrument_id: string;
  readonly report_period: string;
  readonly report_end_date: string;
  readonly announced_at: string;
  readonly statement_basis: 'reported' | 'restated';
  readonly currency: 'CNY';
  readonly revenue: string;
  readonly net_profit: string;
  readonly revenue_yoy_pct: string | null;
  readonly net_profit_yoy_pct: string | null;
  readonly eps: string | null;
  readonly roe_pct: string | null;
  readonly gross_margin_pct: string | null;
}

export interface BarsQuery {
  readonly instrumentId: string;
  readonly adjType: AdjType;
  /** 闭区间 [from, to]；日期 YYYY-MM-DD */
  readonly from?: string;
  readonly to?: string;
  /** 1..500，默认由 HTTP 层补 120 */
  readonly limit: number;
}

export interface BarsPage {
  /** 按 trade_date 升序 */
  readonly rows: BarRow[];
  readonly hasMore: boolean;
  /** 必须等于入参 adjType（契约：meta.adjustment == data.adjustment） */
  readonly adjustment: AdjType;
}

/** market-wide 日线行（B1-02 涨跌停梯队用；带 instrument 维度冗余，避免 N+1 查询）。 */
export interface MarketBarRow extends BarRow {
  readonly name: string;
  readonly board: Board;
  readonly security_type: SecurityType;
  readonly list_status: ListStatus;
  readonly display_safe: boolean;
}

export interface MarketBarsQuery {
  readonly adjType: AdjType;
  /** 闭区间日期列表（YYYY-MM-DD），由调用方从 listTradeDates 取窗口 */
  readonly dates: readonly string[];
  readonly audience?: Audience;
}

export interface ServingRepo {
  getInstrument(instrumentId: string, audience?: Audience): Promise<InstrumentRow | null>;
  getQuote(instrumentId: string): Promise<QuoteRow | null>;
  getBars(query: BarsQuery): Promise<BarsPage>;
  getLatestFactor(instrumentId: string): Promise<FactorRow | null>;
  getFundamentalSummary(instrumentId: string): Promise<FundamentalSummaryRow | null>;
  /** 不晚于 to（可选）的最近 N 个交易日（升序）。用于 B1-01 缺省区间与 B1-02 连板窗口。 */
  listTradeDates(limit: number, to?: string): Promise<string[]>;
  /** market-wide 日线窗口（B1-02），一次查询后按 instrument 分组计算。 */
  getMarketBars(query: MarketBarsQuery): Promise<MarketBarRow[]>;
  /** market-wide 标的清单（B1-02 板块/ST 判定；B1-03 已接入标的集合）。 */
  listInstruments(audience?: Audience): Promise<InstrumentRow[]>;
}
