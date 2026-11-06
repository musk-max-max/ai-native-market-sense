/**
 * 个股页「AI 解读」五段骨架（B1-03 / ADR-007 B2-07）。
 *
 * 五段固定：估值 / 成长 / 盈利质量 / 资金 / 风险（A12 已登记 testid）。
 * 第 1 批数据边界：
 *  - 成长、盈利质量：展示已接入的确定性财报字段（revenue_yoy / net_profit_yoy /
 *    gross_margin / roe / eps），并标注来自财报、与行情时点不同；
 *  - 估值、资金、风险：无数据来源，**用缺口卡显式占位**，不编造、不放假 AI 文案；
 *  - 五段的 AI 文本位一律走 AiTextSlot，本批传 null → 仅展示「待接入」；
 *    因此页面不会出现「像 AI 的话」。
 *
 * 合规：
 *  - 只有 granted 且合规的个股页才渲染本节（受限页零数值，调用方负责门禁）；
 *  - 所有数字均为契约字段的确定性格式化，不含模型生成内容；
 *  - 缺口原因只来自受控枚举。
 */
import type { ReactNode } from 'react';
import type {
  FundamentalInfo,
  FundamentalState,
  QuoteInfo,
  SourceInfo,
} from '../data/model';
import { copy, MISSING, sourceLabel } from '../lib/copy';
import {
  formatChangePct,
  formatPrice,
  formatRatioPct,
} from '../lib/format';
import { TID } from '../lib/testids';
import { AiTextSlot } from './AiTextSlot';
import { DataGapCard } from './DataGapCard';

export interface AiInterpretationProps {
  quote: QuoteInfo | null;
  source: SourceInfo | null;
  fundamental: FundamentalInfo | null;
  fundamentalState: FundamentalState;
}

type SegmentStatus = 'filled' | 'gap';

function Segment({
  testId,
  title,
  status,
  children,
}: {
  testId: string;
  title: string;
  status: SegmentStatus;
  children: ReactNode;
}) {
  const headingId = `${testId}-heading`;
  return (
    <section
      className="ai-segment"
      data-testid={testId}
      data-segment-status={status}
      aria-labelledby={headingId}
    >
      <div className="ai-segment__head">
        <h3 id={headingId} className="ai-segment__title">
          {title}
        </h3>
        <span className="ai-segment__status" aria-hidden="true">
          {status === 'filled' ? copy.ai.deterministicNote : copy.gap.title}
        </span>
      </div>
      {children}
      <AiTextSlot content={null} />
    </section>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="ai-metric">
      <dt className="ai-metric__label">{label}</dt>
      <dd className="ai-metric__value">{value}</dd>
    </div>
  );
}

export function AiInterpretation({
  quote,
  source,
  fundamental,
  fundamentalState,
}: AiInterpretationProps) {
  const hasFundamental = fundamental !== null;
  const fundamentalGapReason = fundamentalState === 'error' ? 'upstream_missing' : 'no_coverage';
  const epsText =
    fundamental && fundamental.eps !== null
      ? `${fundamental.eps.toFixed(2)} ${copy.units.yuanPerShare}`
      : MISSING;

  return (
    <section className="card ai-section" data-testid={TID.aiInterpretation} aria-labelledby="ai-heading">
      <h2 id="ai-heading" className="card__title">
        {copy.ai.sectionTitle}
      </h2>
      <p className="ai-section__note">{copy.ai.sectionNote}</p>

      {quote && source ? (
        <div className="ai-context">
          <h3 className="ai-context__title">{copy.ai.quoteContext}</h3>
          <dl className="ai-context__list">
            <div className="ai-context__item">
              <dt>{copy.quote.caption}</dt>
              <dd>{formatPrice(quote.lastPrice)}</dd>
            </div>
            <div className="ai-context__item">
              <dt>{copy.quote.changeLabel}</dt>
              <dd>{formatChangePct(quote.changePct)}</dd>
            </div>
            <div className="ai-context__item">
              <dt>{copy.quote.asOfLabel}</dt>
              <dd>
                {/* ai-as-of：值原样等于 source.asOf（含 +08:00），不换算不格式化（规格 §3）。 */}
                <time dateTime={source.asOf} data-testid={TID.aiAsOf}>
                  {source.asOf}
                </time>
              </dd>
            </div>
            <div className="ai-context__item">
              <dt>{copy.quote.sourceLabel}</dt>
              <dd>{sourceLabel(source.source)}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="ai-segments" aria-label={copy.ai.segmentsAria}>
        <Segment testId={TID.aiSegmentValuation} title={copy.ai.segments.valuation} status="gap">
          <DataGapCard
            gapKey="valuation"
            title={copy.ai.segments.valuation}
            reason="pending_batch"
          />
        </Segment>

        <Segment testId={TID.aiSegmentGrowth} title={copy.ai.segments.growth} status={hasFundamental ? 'filled' : 'gap'}>
          {fundamental ? (
            <dl className="ai-metrics">
              <Metric label={copy.fundamental.metrics.revenueYoy} value={formatChangePct(fundamental.revenueYoyPct)} />
              <Metric label={copy.fundamental.metrics.netProfitYoy} value={formatChangePct(fundamental.netProfitYoyPct)} />
            </dl>
          ) : (
            <DataGapCard gapKey="growth" title={copy.ai.segments.growth} reason={fundamentalGapReason} />
          )}
        </Segment>

        <Segment
          testId={TID.aiSegmentEarningsQuality}
          title={copy.ai.segments.earningsQuality}
          status={hasFundamental ? 'filled' : 'gap'}
        >
          {fundamental ? (
            <dl className="ai-metrics">
              <Metric label={copy.fundamental.metrics.grossMargin} value={formatRatioPct(fundamental.grossMarginPct)} />
              <Metric label={copy.fundamental.metrics.roe} value={formatRatioPct(fundamental.roePct)} />
              <Metric label={copy.fundamental.metrics.eps} value={epsText} />
            </dl>
          ) : (
            <DataGapCard
              gapKey="earnings-quality"
              title={copy.ai.segments.earningsQuality}
              reason={fundamentalGapReason}
            />
          )}
        </Segment>

        <Segment testId={TID.aiSegmentCapitalFlow} title={copy.ai.segments.capitalFlow} status="gap">
          <DataGapCard gapKey="capital-flow" title={copy.ai.segments.capitalFlow} reason="pending_batch" />
        </Segment>

        <Segment testId={TID.aiSegmentRisk} title={copy.ai.segments.risk} status="gap">
          <DataGapCard gapKey="risk" title={copy.ai.segments.risk} reason="pending_batch" />
        </Segment>
      </div>

      <p className="ai-section__footnote">{copy.gap.footnote}</p>
      <p className="ai-section__meta">{copy.ai.notGeneratedNote}</p>
    </section>
  );
}
