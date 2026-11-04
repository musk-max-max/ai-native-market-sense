/**
 * 基本面摘要。
 *
 * 口径约束：
 *  - 报告期 / 报表口径（reported|restated）原样来自 API，并在页面上显式标注；
 *  - 财报时点与行情 as_of 分开展示，不混用（契约要求）；
 *  - 缺失字段显示「—」并说明未用 0 代替；无财报数据时说明「未披露/未收录」，不渲染假数值；
 *  - 文案与标签来自 lib/copy.ts，来源标识经受控映射，data-source 保留原始枚举值。
 */
import type { FundamentalInfo, FundamentalState } from '../data/model';
import { copy, MISSING, sourceLabel } from '../lib/copy';
import { formatInteger, formatRatioPct, statementBasisLabel } from '../lib/format';
import { TID } from '../lib/testids';

interface FundamentalSummaryProps {
  fundamental: FundamentalInfo | null;
  state: FundamentalState;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function money(value: number | null | undefined): string {
  return `${formatInteger(value)} ${copy.units.yuan}`;
}

export function FundamentalSummary({ fundamental, state }: FundamentalSummaryProps) {
  return (
    <section
      className="card fundamental"
      data-testid={TID.fundamentalSummary}
      aria-labelledby="fundamental-heading"
    >
      <header className="card__header">
        <h2 id="fundamental-heading" className="card__title">
          {copy.fundamental.title}
        </h2>
        <p className="card__note">{copy.fundamental.note}</p>
      </header>

      {fundamental ? (
        <>
          <p className="fundamental__period">
            <span className="fundamental__period-label">{copy.fundamental.periodLabel}</span>
            <span className="fundamental__period-value" data-testid={TID.fundamentalReportPeriod}>
              {fundamental.reportPeriod}
            </span>
            <span className="fundamental__basis">
              {copy.fundamental.basisLabel}
              <span data-testid={TID.fundamentalStatementBasis}>
                {statementBasisLabel(fundamental.statementBasis)}
              </span>
            </span>
          </p>

          <dl className="metrics">
            <Metric label={copy.fundamental.metrics.revenue} value={money(fundamental.revenue)} />
            <Metric label={copy.fundamental.metrics.netProfit} value={money(fundamental.netProfit)} />
            <Metric
              label={copy.fundamental.metrics.revenueYoy}
              value={formatRatioPct(fundamental.revenueYoyPct)}
            />
            <Metric
              label={copy.fundamental.metrics.netProfitYoy}
              value={formatRatioPct(fundamental.netProfitYoyPct)}
            />
            <Metric
              label={copy.fundamental.metrics.eps}
              value={
                fundamental.eps === null
                  ? MISSING
                  : `${fundamental.eps.toFixed(2)} ${copy.units.yuanPerShare}`
              }
            />
            <Metric
              label={copy.fundamental.metrics.roe}
              value={formatRatioPct(fundamental.roePct)}
            />
            <Metric
              label={copy.fundamental.metrics.grossMargin}
              value={formatRatioPct(fundamental.grossMarginPct)}
            />
            <Metric
              label={copy.fundamental.metrics.totalAssets}
              value={money(fundamental.totalAssets)}
            />
          </dl>

          <p className="fundamental__meta">
            {copy.fundamental.meta.reportEnd} {fundamental.reportEndDate}
            <span aria-hidden="true">{copy.units.separator}</span>
            {copy.fundamental.meta.asOf}{' '}
            <time dateTime={fundamental.source.asOf}>{fundamental.source.asOf}</time>
            <span aria-hidden="true">{copy.units.separator}</span>
            {copy.fundamental.meta.source}{' '}
            <span data-source={fundamental.source.source}>
              {sourceLabel(fundamental.source.source)}
            </span>
            <span aria-hidden="true">{copy.units.separator}</span>
            {copy.fundamental.meta.announced} {fundamental.announcedAt}
          </p>
          <p className="fundamental__footnote">{copy.fundamental.footnote}</p>
        </>
      ) : (
        <p className="fundamental__empty">
          {state === 'error' ? copy.fundamental.unavailable : copy.fundamental.missing}
        </p>
      )}
    </section>
  );
}
