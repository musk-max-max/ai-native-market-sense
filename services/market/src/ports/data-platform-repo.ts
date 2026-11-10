/**
 * 数据中台只读端口（hexagonal port，consumer-owned）。
 *
 * 归属：services/market。用途：Console「数据中台」页查询 tushare 已接入的
 * 12+ 研究数据集（daily_basic / top_list / top_inst / moneyflow / margin /
 * hk_hold / stk_limit / fina_indicator / index_daily / index_classify /
 * index_member_all）+ realtime_quote，仅内部使用（不接 C 端契约）。
 *
 * 边界（必须遵守）：
 *  - 只 SELECT `serving.serving_research_*` view，不直查 dwd_*（A13 只读角色只 GRANT serving schema）；
 *  - 数字以字符串出端口（precision-safe），由 HTTP 边界转 number；
 *  - 每行自带 source/as_of/staleness_ms（与 ServingRepo 同口径）。
 *
 * 归属：A3。
 */

import type { SourceInfo } from './serving-repo.js';

/** 数据集标识（与 warehouse serving view 一一对应）。 */
export type ResearchDataset =
  | 'daily_basic'
  | 'index_daily'
  | 'top_list'
  | 'top_inst'
  | 'moneyflow'
  | 'margin'
  | 'hk_hold'
  | 'stk_limit'
  | 'fina_indicator'
  | 'index_classify'
  | 'index_member_all'
  | 'realtime_quote'
  | 'dc_index'
  | 'dc_member';

/** 通用行：所有研究数据集共有字段。 */
export type ResearchRow = SourceInfo & Record<string, string | number | boolean | null>;

/** 查询参数（分页 + 时间窗 + 可选过滤）。 */
export interface ResearchQuery {
  /** 最多返回行数（硬上限 5000）。 */
  limit?: number;
  /** 偏移量（分页）。 */
  offset?: number;
  /** 起始 trade_date/snapshot_date/announced_at（ISO date 字符串，含）。 */
  from?: string;
  /** 截止日期（含）。 */
  to?: string;
  /** 标的过滤（instrument_id 精确匹配）。 */
  instrumentId?: string;
  /** 交易所过滤（margin 表专用）。 */
  exchange?: 'SSE' | 'SZSE' | 'BSE';
}

/** 查询结果：行 + 总数（用于分页）。 */
export interface ResearchPage {
  readonly rows: readonly ResearchRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** 数据集元数据（catalog 用）。 */
export interface DatasetMeta {
  readonly name: ResearchDataset;
  /** 业务域分类（前端一级 tab）。 */
  readonly domain: 'quote' | 'flow' | 'fundamental' | 'research' | 'sector';
  /** 中文显示名。 */
  readonly title: string;
  /** 一句话说明。 */
  readonly description: string;
  /** tushare points_min（仅研究表有；realtime_quote = null 表示 AKshare 源）。 */
  readonly pointsMin: number | null;
  /** tushare doc_id（仅研究表有）。 */
  readonly docId: number | null;
  /** 数据源标识（tushare / akshare_eastmoney / ...）。 */
  readonly source: string;
  /** 接入模式（daily / snapshot / per_instrument / realtime）。 */
  readonly mode: 'daily' | 'snapshot' | 'per_instrument' | 'realtime';
  /** serving view 名（查询时拼 serving.serving_research_<view_name>）。 */
  readonly viewName: string;
}

/** 数据集 + 行数统计（catalog 主视图用）。 */
export interface DatasetStats extends DatasetMeta {
  /** 总行数（近似，用于展示）。 */
  readonly rowCount: number;
  /** 最新一行 as_of（ISO 字符串）。 */
  readonly latestAsOf: string | null;
  /** 最新一行 trade_date/snapshot_date/report_end_date。 */
  readonly latestDate: string | null;
}

/** 数据中台只读端口。 */
export interface DataPlatformRepo {
  /** 列出全部数据集 + 行数统计。 */
  listDatasets(): Promise<readonly DatasetStats[]>;

  /** 查询单个数据集的行（分页 + 时间窗 + 过滤）。 */
  queryDataset(dataset: ResearchDataset, query: ResearchQuery): Promise<ResearchPage>;

  /** 单个数据集的元数据（catalog 详情用）。 */
  getDatasetMeta(dataset: ResearchDataset): DatasetMeta;
}

/** 全部数据集元数据（编译期常量，运行时按 view 实际行数补 rowCount/latestAsOf）。 */
export const DATASETS: readonly DatasetMeta[] = [
  {
    name: 'daily_basic',
    domain: 'fundamental',
    title: '每日指标',
    description: 'PE/PB/PS/换手率/市值/涨跌停状态（全市场日频）',
    pointsMin: 2000,
    docId: 32,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_daily_basic',
  },
  {
    name: 'index_daily',
    domain: 'quote',
    title: '指数日线',
    description: '基准指数 OHLCV（上证/深证/创业板/科创/北证）',
    pointsMin: 2000,
    docId: 95,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_index_daily',
  },
  {
    name: 'top_list',
    domain: 'flow',
    title: '龙虎榜',
    description: '龙虎榜每日明细（上榜原因原文保留）',
    pointsMin: 2000,
    docId: 106,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_top_list',
  },
  {
    name: 'top_inst',
    domain: 'flow',
    title: '龙虎榜席位',
    description: '机构/营业部席位买卖明细（5000 分档特色数据）',
    pointsMin: 5000,
    docId: 107,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_top_inst',
  },
  {
    name: 'moneyflow',
    domain: 'flow',
    title: '资金流向',
    description: '个股资金流向五档（小/中/大/特大单 + 净流入）',
    pointsMin: 2000,
    docId: 170,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_moneyflow',
  },
  {
    name: 'margin',
    domain: 'flow',
    title: '融资融券',
    description: '两融交易汇总（交易所维度 SSE/SZSE/BSE）',
    pointsMin: 2000,
    docId: 58,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_margin',
  },
  {
    name: 'hk_hold',
    domain: 'flow',
    title: '北向持股',
    description: '沪深股通持股明细（港交所源）',
    pointsMin: 2000,
    docId: 188,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_hk_hold',
  },
  {
    name: 'stk_limit',
    domain: 'quote',
    title: '涨跌停价',
    description: '每日涨跌停价（2007 起全市场，原样透传）',
    pointsMin: 2000,
    docId: 183,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_stk_limit',
  },
  {
    name: 'fina_indicator',
    domain: 'fundamental',
    title: '财务指标',
    description: '财报宽表（EPS/ROE/毛利率/负债率 40+ 指标，按报告期）',
    pointsMin: 2000,
    docId: 79,
    source: 'tushare',
    mode: 'per_instrument',
    viewName: 'serving_research_fina_indicator',
  },
  {
    name: 'index_classify',
    domain: 'sector',
    title: '申万行业分类',
    description: '申万 2021 版 L1/L2/L3 行业树快照',
    pointsMin: 2000,
    docId: 181,
    source: 'tushare',
    mode: 'snapshot',
    viewName: 'serving_research_index_classify',
  },
  {
    name: 'index_member_all',
    domain: 'sector',
    title: '申万成分股',
    description: '申万三级成分时点快照（含历史进出，防幸存者偏差）',
    pointsMin: 2000,
    docId: 335,
    source: 'tushare',
    mode: 'snapshot',
    viewName: 'serving_research_index_member_all',
  },
  {
    name: 'realtime_quote',
    domain: 'quote',
    title: '实时行情',
    description: 'AKshare 东方财富源快照（F1 residual，仅内部展示，SEC-012 未放行 C 端）',
    pointsMin: null,
    docId: null,
    source: 'akshare_eastmoney',
    mode: 'realtime',
    viewName: 'serving_quote_realtime',
  },
  {
    name: 'dc_index',
    domain: 'sector',
    title: '东财板块行情',
    description: '东方财富概念/行业/地域板块日行情（1058 板块，6000 分档）',
    pointsMin: 6000,
    docId: 362,
    source: 'tushare',
    mode: 'daily',
    viewName: 'serving_research_dc_index',
  },
  {
    name: 'dc_member',
    domain: 'sector',
    title: '东财板块成分股',
    description: '东方财富概念板块成分股快照（append-only 多日共存，6000 分档）',
    pointsMin: 6000,
    docId: 363,
    source: 'tushare',
    mode: 'snapshot',
    viewName: 'serving_research_dc_member',
  },
];
