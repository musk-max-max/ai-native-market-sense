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
  | 'dc_member'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'new_share'
  | 'income'
  | 'balancesheet'
  | 'cashflow'
  | 'forecast'
  | 'express'
  | 'dividend'
  | 'pledge_detail'
  | 'pledge_stat'
  | 'margin_detail'
  | 'repurchase'
  | 'share_float'
  | 'block_trade'
  | 'stk_holdernumber'
  | 'stk_holdertrade'
  | 'index_basic'
  | 'index_weekly'
  | 'index_monthly'
  | 'fund_basic'
  | 'fund_company'
  | 'fund_nav'
  | 'fund_daily'
  | 'fund_div'
  | 'fut_basic'
  | 'trade_cal'
  | 'fut_daily'
  | 'fut_holding'
  | 'fut_wsr'
  | 'fut_settle'
  | 'opt_basic'
  | 'opt_daily'
  | 'cb_basic'
  | 'cb_issue'
  | 'cb_daily'
  | 'fx_obasic'
  | 'fx_daily';

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
  readonly domain: 'quote' | 'flow' | 'fundamental' | 'research' | 'sector' | 'shareholder' | 'index' | 'fund' | 'futures' | 'options' | 'bond' | 'fx';
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
  // ---- L172 第一批（15000 档全量接入，20 数据集）----
  { name: 'daily', domain: 'quote', title: '日线行情', description: '全部历史日线 OHLCV（交易日 15-17 点更新）', pointsMin: 120, docId: 27, source: 'tushare', mode: 'daily', viewName: 'serving_research_daily' },
  { name: 'weekly', domain: 'quote', title: '周线行情', description: '全部历史周线 OHLCV（每周五盘后更新）', pointsMin: 2000, docId: 28, source: 'tushare', mode: 'daily', viewName: 'serving_research_weekly' },
  { name: 'monthly', domain: 'quote', title: '月线行情', description: '全部历史月线 OHLCV（每月盘后更新）', pointsMin: 2000, docId: 29, source: 'tushare', mode: 'daily', viewName: 'serving_research_monthly' },
  { name: 'new_share', domain: 'quote', title: 'IPO 新股', description: '新股列表含申购/上市/中签日期与募资额（每日 19 点更新）', pointsMin: 120, docId: 18, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_new_share' },
  { name: 'income', domain: 'fundamental', title: '利润表', description: '营收/营业利润/净利润/归母净利/EPS（全部历史，实时更新）', pointsMin: 2000, docId: 33, source: 'tushare', mode: 'per_instrument', viewName: 'serving_research_income' },
  { name: 'balancesheet', domain: 'fundamental', title: '资产负债表', description: '总资产/总负债/股东权益/流动与非流动项/应收/存货/商誉（实时更新）', pointsMin: 2000, docId: 34, source: 'tushare', mode: 'per_instrument', viewName: 'serving_research_balancesheet' },
  { name: 'cashflow', domain: 'fundamental', title: '现金流量表', description: '经营/投资/筹资活动现金流净额与资本开支（实时更新）', pointsMin: 2000, docId: 35, source: 'tushare', mode: 'per_instrument', viewName: 'serving_research_cashflow' },
  { name: 'forecast', domain: 'fundamental', title: '业绩预告', description: '预告类型/净利润区间/同比变动/预告原因（实时更新）', pointsMin: 2000, docId: 36, source: 'tushare', mode: 'per_instrument', viewName: 'serving_research_forecast' },
  { name: 'express', domain: 'fundamental', title: '业绩快报', description: '营收/净利润/同比与环比增速（实时更新）', pointsMin: 2000, docId: 37, source: 'tushare', mode: 'per_instrument', viewName: 'serving_research_express' },
  { name: 'dividend', domain: 'fundamental', title: '分红送股', description: '每股派息/送股比例/股权登记日/除权日/派息日（实时更新）', pointsMin: 2000, docId: 38, source: 'tushare', mode: 'per_instrument', viewName: 'serving_research_dividend' },
  { name: 'pledge_detail', domain: 'shareholder', title: '股权质押明细', description: '质押次数/质押比例/质押股份/质押市值（2004 起，每日更新）', pointsMin: 2000, docId: 55, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_pledge_detail' },
  { name: 'pledge_stat', domain: 'shareholder', title: '股权质押统计', description: '质押/解押次数/质押比例/总质押比例（2014 起，每日更新）', pointsMin: 2000, docId: 56, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_pledge_stat' },
  { name: 'margin_detail', domain: 'flow', title: '融资融券明细', description: '个股两融余额/融资买入额/融券余量（2010 起，每日 9 点更新）', pointsMin: 2000, docId: 57, source: 'tushare', mode: 'daily', viewName: 'serving_research_margin_detail' },
  { name: 'repurchase', domain: 'shareholder', title: '股票回购', description: '回购数量/金额/价格区间（2011 起，每日更新）', pointsMin: 2000, docId: 43, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_repurchase' },
  { name: 'share_float', domain: 'shareholder', title: '限售股解禁', description: '解禁日期/解禁数量/解禁比例/股东名称（3000 分，定期更新）', pointsMin: 3000, docId: 44, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_share_float' },
  { name: 'block_trade', domain: 'flow', title: '大宗交易', description: '成交价/成交量/成交金额/买卖营业部（每日晚 9 点更新）', pointsMin: 2000, docId: 45, source: 'tushare', mode: 'daily', viewName: 'serving_research_block_trade' },
  { name: 'stk_holdernumber', domain: 'shareholder', title: '股东人数', description: '股东户数/变动/户均市值/户均持股（不定期更新）', pointsMin: 2000, docId: 46, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_stk_holdernumber' },
  { name: 'stk_holdertrade', domain: 'shareholder', title: '股东增减持', description: '股东名称/变动数量/变动比例/均价/增减持方向（交易日 19 点更新）', pointsMin: 2000, docId: 47, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_stk_holdertrade' },
  // ---- L172 第二批（指数/基金/期货/期权/债券/外汇，21 数据集）----
  { name: 'index_basic', domain: 'index', title: '指数基本信息', description: '指数代码/名称/发布商/基日/基点（每日更新）', pointsMin: 2000, docId: 93, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_index_basic' },
  { name: 'index_weekly', domain: 'index', title: '指数周线', description: '指数周线 OHLCV（每周盘后更新）', pointsMin: 2000, docId: 96, source: 'tushare', mode: 'daily', viewName: 'serving_research_index_weekly' },
  { name: 'index_monthly', domain: 'index', title: '指数月线', description: '指数月线 OHLCV（每月盘后更新）', pointsMin: 2000, docId: 97, source: 'tushare', mode: 'daily', viewName: 'serving_research_index_monthly' },
  { name: 'fund_basic', domain: 'fund', title: '公募基金列表', description: '基金代码/名称/管理人/托管行/基金类型/成立日（定时更新）', pointsMin: 2000, docId: 25, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_fund_basic' },
  { name: 'fund_company', domain: 'fund', title: '基金公司', description: '公司代码/名称/注册资本/城市（定时更新）', pointsMin: 2000, docId: 26, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_fund_company' },
  { name: 'fund_nav', domain: 'fund', title: '基金净值', description: '单位净值/累计净值/日收益率（每日定期更新）', pointsMin: 2000, docId: 24, source: 'tushare', mode: 'daily', viewName: 'serving_research_fund_nav' },
  { name: 'fund_daily', domain: 'fund', title: '场内基金日线', description: 'ETF/LOF 日线 OHLCV（每日盘后更新）', pointsMin: 2000, docId: 30, source: 'tushare', mode: 'daily', viewName: 'serving_research_fund_daily' },
  { name: 'fund_div', domain: 'fund', title: '基金分红', description: '每单位派息/除息日/派息日（定期更新）', pointsMin: 2000, docId: 31, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_fund_div' },
  { name: 'fut_basic', domain: 'futures', title: '期货合约', description: '合约代码/名称/交易所/合约单位/上市与退市日（全部历史）', pointsMin: 2000, docId: 111, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_fut_basic' },
  { name: 'trade_cal', domain: 'futures', title: '交易日历', description: '交易所交易日历含开市标识（1996 起，定期更新）', pointsMin: 2000, docId: 109, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_trade_cal' },
  { name: 'fut_daily', domain: 'futures', title: '期货日线', description: '期货 OHLCV + 结算价 + 持仓量（1996 起，每日盘后更新）', pointsMin: 2000, docId: 112, source: 'tushare', mode: 'daily', viewName: 'serving_research_fut_daily' },
  { name: 'fut_holding', domain: 'futures', title: '成交持仓排名', description: '期货公司多/空持仓量与变化（2002 起，每日盘后更新）', pointsMin: 2000, docId: 113, source: 'tushare', mode: 'daily', viewName: 'serving_research_fut_holding' },
  { name: 'fut_wsr', domain: 'futures', title: '仓单日报', description: '注册仓单量与变化（2006 起，每日盘后更新）', pointsMin: 2000, docId: 114, source: 'tushare', mode: 'daily', viewName: 'serving_research_fut_wsr' },
  { name: 'fut_settle', domain: 'futures', title: '结算参数', description: '结算价/保证金率/手续费/交割价（2012 起，每日盘后更新）', pointsMin: 2000, docId: 115, source: 'tushare', mode: 'daily', viewName: 'serving_research_fut_settle' },
  { name: 'opt_basic', domain: 'options', title: '期权合约', description: '期权代码/标的/类型/行权价/到期日（每日晚 8 点更新）', pointsMin: 2000, docId: 119, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_opt_basic' },
  { name: 'opt_daily', domain: 'options', title: '期权日线', description: '期权 OHLCV + 结算价 + 持仓量（5000 分，每日 17 点更新）', pointsMin: 5000, docId: 120, source: 'tushare', mode: 'daily', viewName: 'serving_research_opt_daily' },
  { name: 'cb_basic', domain: 'bond', title: '可转债基础', description: '转债代码/名称/正股/发行价/上市日/到期日（每日更新）', pointsMin: 2000, docId: 121, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_cb_basic' },
  { name: 'cb_issue', domain: 'bond', title: '可转债发行', description: '发行公告日/上市日/发行价/票面利率/期限（每日更新）', pointsMin: 2000, docId: 122, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_cb_issue' },
  { name: 'cb_daily', domain: 'bond', title: '可转债日线', description: '转债 OHLCV（每日 17 点更新）', pointsMin: 2000, docId: 123, source: 'tushare', mode: 'daily', viewName: 'serving_research_cb_daily' },
  { name: 'fx_obasic', domain: 'fx', title: '外汇基础', description: '外汇代码/名称/基准货币/报价货币（海外，每日更新）', pointsMin: 2000, docId: 134, source: 'tushare', mode: 'snapshot', viewName: 'serving_research_fx_obasic' },
  { name: 'fx_daily', domain: 'fx', title: '外汇日线', description: '外汇 OHLCV（每日更新）', pointsMin: 2000, docId: 135, source: 'tushare', mode: 'daily', viewName: 'serving_research_fx_daily' },
];
