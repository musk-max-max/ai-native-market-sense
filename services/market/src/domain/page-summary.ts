/**
 * B1-03 个股页五段骨架 + 数据缺口（后端汇总，确定性、无 LLM）。
 *
 * 五段顺序固定：行情概览 / 财务摘要 / 估值 / 资金 / 风险。
 * 第 1 批只有行情与财务摘要有真实数据；估值/资金/风险按 pending 输出固定 gap，
 * 缺口必须显式，不得用 0、"--"、空对象或骨架屏占位冒充数据。
 *
 * 授权边界：受限档（entitlement blocked）下 quote/fundamental 标 restricted，
 * 不带任何数值/data_refs；调用方（路由层）在此之前已按 gate 决定 403/200。
 */

export type PageSectionId = 'quote' | 'fundamental' | 'valuation' | 'capital' | 'risk';
export type PageSectionAvailability = 'available' | 'gap' | 'pending' | 'restricted';

export interface PageSectionRef {
  readonly module: string;
  /** 数据市场时点，+08:00 */
  readonly as_of: string;
  /** 可选报告期/交易日等定位信息 */
  readonly period?: string;
}

export interface PageSummarySection {
  readonly id: PageSectionId;
  readonly availability: PageSectionAvailability;
  readonly reason?: string;
  readonly data_refs: PageSectionRef[];
}

export interface PageSummaryGap {
  readonly code: string;
  readonly message: string;
}

export interface PageSummaryData {
  readonly instrument_id: string;
  readonly sections: PageSummarySection[];
  readonly gaps: PageSummaryGap[];
}

export interface PageSummaryInput {
  readonly instrumentId: string;
  readonly restricted: boolean;
  readonly quote: { readonly asOf: string; readonly tradeDate: string } | null;
  readonly fundamental: { readonly asOf: string; readonly reportPeriod: string } | null;
}

const RESTRICTED_REASON = '当前版本不提供该段数据';

export function buildPageSummary(input: PageSummaryInput): PageSummaryData {
  const gaps: PageSummaryGap[] = [];

  const quote: PageSummarySection = input.restricted
    ? {
        id: 'quote',
        availability: 'restricted',
        reason: RESTRICTED_REASON,
        data_refs: [],
      }
    : input.quote !== null
      ? {
          id: 'quote',
          availability: 'available',
          data_refs: [{ module: 'market.quote', as_of: input.quote.asOf, period: input.quote.tradeDate }],
        }
      : (() => {
          gaps.push({ code: 'DATA_NOT_READY', message: '暂无可展示的最新行情快照。' });
          return {
            id: 'quote',
            availability: 'gap' as const,
            reason: '暂无可展示的最新行情快照',
            data_refs: [],
          };
        })();

  const fundamental: PageSummarySection = input.restricted
    ? {
        id: 'fundamental',
        availability: 'restricted',
        reason: RESTRICTED_REASON,
        data_refs: [],
      }
    : input.fundamental !== null
      ? {
          id: 'fundamental',
          availability: 'available',
          data_refs: [
            { module: 'market.fundamental-summary', as_of: input.fundamental.asOf, period: input.fundamental.reportPeriod },
          ],
        }
      : (() => {
          gaps.push({ code: 'FUNDAMENTAL_NOT_READY', message: '暂无已披露财务摘要。' });
          return {
            id: 'fundamental',
            availability: 'gap' as const,
            reason: '暂无已披露财务摘要',
            data_refs: [],
          };
        })();

  const valuation: PageSummarySection = {
    id: 'valuation',
    availability: 'pending',
    reason: '待研究数据批次接入（daily_basic）',
    data_refs: [],
  };
  gaps.push({ code: 'DAILY_BASIC_MISSING', message: '估值数据待第 2 批接入（daily_basic 未接入）。' });

  const capital: PageSummarySection = {
    id: 'capital',
    availability: 'pending',
    reason: '待研究数据批次接入（moneyflow）',
    data_refs: [],
  };
  gaps.push({ code: 'MONEYFLOW_MISSING', message: '资金数据待第 2 批接入（moneyflow 未接入）。' });

  const risk: PageSummarySection = {
    id: 'risk',
    availability: 'pending',
    reason: '待研究数据批次接入（质押/解禁/股东户数）',
    data_refs: [],
  };
  gaps.push({ code: 'RISK_DATASETS_MISSING', message: '风险数据待第 2 批接入（质押/解禁/股东户数未接入）。' });

  return {
    instrument_id: input.instrumentId,
    sections: [quote, fundamental, valuation, capital, risk],
    gaps,
  };
}
