/**
 * B1-01 自选组合复盘页（固定模板）。
 *
 * 口径（lead 明令）：
 *  - 一律称「自选组合」，不得写「我的持仓 / 真实持仓」；
 *  - 指标只做确定性统计：区间涨跌、年化波动、最大回撤、等权组合表现；
 *  - 相对基准 / 板块对比属第 2 批数据，固定用缺口卡显式占位；
 *  - 生产构建在汇总 API 冻结前走 unavailable（不伪造数值），DEV mock 必须显示 demo 标识。
 *
 * 数据来源：`data/ai` 的 ReviewGateway（端口稳定；真实端点冻结后只换适配器）。
 */
import { useEffect, useState } from 'react';
import { ErrorBlock, EmptyBlock, LoadingBlock } from '../components/PageState';
import { DataGapCard } from '../components/DataGapCard';
import { reviewGateway } from '../data/ai';
import type {
  PortfolioReviewResult,
  ReviewPeriod,
} from '../data/ai/types';
import type { GatewayError } from '../data/gateway';
import { copy, errorCopy, sourceLabel } from '../lib/copy';
import { formatChangePct, formatRatioPct } from '../lib/format';
import { Link } from '../lib/router';
import { TID } from '../lib/testids';

const PERIODS: readonly ReviewPeriod[] = ['1m', '3m', '6m', '1y'];

type PageState =
  | { status: 'loading' }
  | PortfolioReviewResult
  | { status: 'error'; error: GatewayError };

function asError(error: unknown): PageState {
  const gatewayError =
    typeof error === 'object' && error !== null && 'status' in error && 'network' in error
      ? (error as GatewayError)
      : { status: null, network: true };
  return { status: 'error', error: gatewayError };
}

function MetricRow({
  metricKey,
  label,
  value,
}: {
  metricKey: string;
  label: string;
  value: string;
}) {
  return (
    <div className="portfolio-metric" data-testid={TID.portfolioMetric} data-metric-key={metricKey}>
      <dt className="portfolio-metric__label">{label}</dt>
      <dd
        className="portfolio-metric__value"
        data-testid={TID.portfolioMetricValue}
        data-metric-key={metricKey}
      >
        {value}
      </dd>
    </div>
  );
}

export function PortfolioReviewPage() {
  const [period, setPeriod] = useState<ReviewPeriod>('3m');
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    reviewGateway.getPortfolioReview(period).then(
      (result) => {
        if (alive) setState(result);
      },
      (error: unknown) => {
        if (alive) setState(asError(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [period]);

  const reload = (): void => {
    setState({ status: 'loading' });
    reviewGateway.getPortfolioReview(period).then(
      (result) => setState(result),
      (error: unknown) => setState(asError(error)),
    );
  };

  return (
    <div className="page review-page" data-testid={TID.portfolioReviewPage}>
      <h1 className="page__title">{copy.review.portfolio.title}</h1>
      <p className="page__subtitle">{copy.review.portfolio.subtitle}</p>
      <p className="review-scope-note" data-testid={TID.portfolioScopeNote}>
        {copy.review.portfolio.scopeNote}
      </p>

      <div className="period-tabs" role="group" aria-label={copy.review.portfolio.periodLabel}>
        {PERIODS.map((item) => (
          <button
            key={item}
            type="button"
            className="period-tabs__tab"
            aria-pressed={item === period}
            onClick={() => setPeriod(item)}
          >
            {copy.review.portfolio.periods[item]}
          </button>
        ))}
      </div>

      {state.status === 'loading' && (
        <LoadingBlock testId={TID.portfolioReviewLoading} text={copy.review.portfolio.loading} />
      )}

      {state.status === 'error' && (
        <ErrorBlock
          testId={TID.portfolioReviewError}
          text={errorCopy(state.error.status, state.error.network)}
          onRetry={reload}
        />
      )}

      {state.status === 'empty' && (
        <EmptyBlock
          testId={TID.portfolioReviewEmpty}
          title={copy.review.portfolio.empty}
          action={
            <Link className="home__link" href="/watchlist">
              {copy.review.portfolio.emptyLink}
            </Link>
          }
        />
      )}

      {state.status === 'anonymous' && (
        <section className="notice-card" role="note">
          <p>{copy.review.portfolio.loginRequired}</p>
          <Link className="home__link" href="/watchlist">
            {copy.review.portfolio.emptyLink}
          </Link>
        </section>
      )}

      {state.status === 'unavailable' && (
        <section className="unavailable-card" role="note">
          <p>{copy.review.portfolio.unavailable}</p>
          <DataGapCard
            gapKey="portfolio-summary"
            title={copy.review.portfolio.metricsTitle}
            reason={state.reason}
          />
        </section>
      )}

      {state.status === 'ready' && (
        <>
          {state.demo ? (
            <p className="demo-banner" role="note">
              {copy.review.portfolio.demoNote}
            </p>
          ) : null}

          <section className="card portfolio-card" aria-labelledby="portfolio-metrics-heading">
            <h2 id="portfolio-metrics-heading" className="card__title">
              {copy.review.portfolio.metricsTitle}
            </h2>
            <dl className="portfolio-metrics" data-testid={TID.portfolioMetrics}>
              <MetricRow
                metricKey="interval-return"
                label={copy.review.portfolio.metrics.periodReturn}
                value={formatChangePct(state.metrics.periodReturnPct)}
              />
              <MetricRow
                metricKey="volatility"
                label={copy.review.portfolio.metrics.volatility}
                value={formatRatioPct(state.metrics.annualizedVolPct)}
              />
              <MetricRow
                metricKey="max-drawdown"
                label={copy.review.portfolio.metrics.maxDrawdown}
                value={formatChangePct(state.metrics.maxDrawdownPct)}
              />
              <MetricRow
                metricKey="equal-weight-benchmark"
                label={copy.review.portfolio.metrics.equalWeight}
                value={formatChangePct(state.metrics.equalWeightReturnPct)}
              />
              <MetricRow
                metricKey="instrument-count"
                label={copy.review.portfolio.metrics.instrumentCount}
                value={String(state.metrics.instrumentCount)}
              />
            </dl>
            <dl className="portfolio-source">
              <div>
                <dt>{copy.review.portfolio.asOfLabel}</dt>
                <dd>
                  <time dateTime={state.source.asOf}>{state.source.asOf}</time>
                </dd>
              </div>
              <div>
                <dt>{copy.review.portfolio.sourceLabel}</dt>
                <dd>{sourceLabel(state.source.source)}</dd>
              </div>
            </dl>
            <p className="card__hint">{copy.review.portfolio.templateNote}</p>
          </section>

          <section className="card portfolio-gaps" aria-labelledby="portfolio-gaps-heading">
            <h2 id="portfolio-gaps-heading" className="card__title">
              {copy.review.portfolio.gapsTitle}
            </h2>
            <DataGapCard
              gapKey="benchmark"
              title={copy.review.portfolio.gaps.benchmark}
              reason="pending_batch"
            />
            <DataGapCard
              gapKey="sector"
              title={copy.review.portfolio.gaps.sector}
              reason="pending_batch"
            />
            <p className="card__hint">{copy.review.portfolio.gapFootnote}</p>
          </section>
        </>
      )}
    </div>
  );
}
