/**
 * AI 功能层（ADR-007 第 1 批）的页面端口。
 *
 * 第 1 批的可验收产物是「确定性结果 + 契约/页面骨架 + 缺口显式」：
 *  - B1-01 自选组合复盘：区间涨跌 / 年化波动 / 最大回撤 / 等权组合表现，固定模板；
 *  - B1-02 涨跌停梯队：涨停 / 跌停 / 连板，涨跌停口径暂为 provisional；
 *  - B1-03 个股 AI 解读：五段骨架，只有行情/财务两段有确定性数据，其余走缺口卡。
 *
 * 本文件只定义「页面要什么」，不是 API DTO。真实实现等 `contracts/ai/openapi.yaml`
 * 冻结后由 api 适配层用生成的客户端映射；当前生产构建走 unavailableGateway
 * （显式缺口），DEV 预览走 mockGateway（明确标注 demo）。
 *
 * 合规边界（ADR-007 D3/D4）：
 *  - AI 生成文本只能来自服务端 P7 注入标识的响应，前端不生成、不拼接"像 AI 的话"；
 *  - 受限（entitlement 未授权）时不得渲染任何行情数值，也不得用 mock 数据伪装面客；
 *  - 缺口只按受控原因枚举显示（GapReason），不允许调用方传任意说明文本。
 */
import type { GapReason } from '../../lib/copy';
import type { GatewayError } from '../gateway';

export type { GapReason };

/** 复盘统计区间（固定枚举，避免前端自造区间口径）。 */
export type ReviewPeriod = '1m' | '3m' | '6m' | '1y';

/** 组合指标的数据来源与时效；与行情同一套 SourceRef 口径。 */
export interface ReviewSource {
  /** canonical 数据源标识（platform_* 枚举），展示时走 copy.sourceLabel。 */
  source: string;
  /** 原样展示 ISO8601 +08:00，不做前端时区换算。 */
  asOf: string;
  stalenessMs: number;
}

/** 组合表现指标；null 表示该指标暂无可计算数据（不用 0 冒充）。 */
export interface PortfolioMetrics {
  instrumentCount: number;
  periodReturnPct: number | null;
  annualizedVolPct: number | null;
  maxDrawdownPct: number | null;
  equalWeightReturnPct: number | null;
}

export type PortfolioReviewResult =
  | {
      status: 'ready';
      metrics: PortfolioMetrics;
      source: ReviewSource;
      /** true = DEV mock 演示数据；生产构建必须为 false。 */
      demo: boolean;
    }
  | { status: 'empty' }
  | { status: 'anonymous' }
  | { status: 'unavailable'; reason: GapReason }
  | { status: 'error'; error: GatewayError };

/**
 * 梯队中的一行（涨跌停/连板通用）。
 *
 * **仅内部评测使用**：H3 的 P0 排序榜/编选禁区不允许 C 端出现个股级名单
 * （含按连板/涨停时间排序、排除 ST 后的名单）。C 端页面只渲染市场级汇总计数。
 */
export interface LimitRow {
  instrumentId: string;
  /** 证券简称；上游未提供时为 null，页面显示代码，不编造名称。 */
  name: string | null;
  /** 板块（main/gem/star/bse），展示时走受控映射。 */
  board: string | null;
  /** 涨跌幅（百分数数值，-10.02 表示 -10.02%）。 */
  changePct: number | null;
  /** 连板数；非连板梯队为 null。 */
  streakDays: number | null;
}

/** 连板分布中的一档（纯计数，不含个股）。 */
export interface LimitStreakBucket {
  readonly streakDays: number;
  readonly count: number;
}

/**
 * 涨跌停市场级汇总（C 端唯一允许的形态，H3 m02407 裁定 (a)）。
 *
 * 只允许计数与口径信息；任何个股名称/代码/排序都不得进入 C 端渲染路径。
 */
export interface LimitLadder {
  /** 涨停家数。 */
  upCount: number;
  /** 跌停家数。 */
  downCount: number;
  /** 最高连板数；无连板标的是 null，不用 0 冒充。 */
  maxStreakDays: number | null;
  /** 连板分布（按板数计家数）；空数组表示无连板标的。 */
  streakBuckets: readonly LimitStreakBucket[];
  /** 被排除的 ST / *ST 标的数量（显式披露，不静默过滤）。 */
  stExcludedCount: number;
  /** 当前涨跌停口径版本标识（provisional 阶段可能变化）。 */
  caliberVersion: string;
  /** true = 口径仍为临时近似规则，页面必须显示 provisional 提示。 */
  provisional: boolean;
  source: ReviewSource;
  /** true = DEV mock 演示数据；生产构建必须为 false。 */
  demo: boolean;
  /**
   * 内部评测用个股明细（ADR-007 D5 / H3 (b)）。
   * C 端页面禁止读取；等授权落地后再决定内部后台形态。
   */
  readonly instrumentRows?: {
    readonly up: readonly LimitRow[];
    readonly down: readonly LimitRow[];
    readonly streak: readonly LimitRow[];
  };
}

export type LimitLadderResult =
  | { status: 'ready'; ladder: LimitLadder }
  | { status: 'empty' }
  | { status: 'unavailable'; reason: GapReason }
  | { status: 'error'; error: GatewayError };

/**
 * AI 功能页的数据端口。
 *
 * 页面只依赖此接口；真实端点未冻结前由 mock/unavailable 实现装配，
 * 冻结后新增 apiReviewGateway 并保持页面不改（端口是稳定边界）。
 */
export interface ReviewGateway {
  getPortfolioReview(period: ReviewPeriod): Promise<PortfolioReviewResult>;
  getLimitLadder(): Promise<LimitLadderResult>;
}
