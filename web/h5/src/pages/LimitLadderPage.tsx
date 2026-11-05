/**
 * B1-02 涨跌停市场级汇总页（C 端）。
 *
 * 形态裁定（H3 m02407 / lead m02415）：
 *  - C 端只允许「市场级汇总计数」：涨停家数 / 跌停家数 / 最高连板 / 连板分布；
 *  - 个股级名单（按连板/涨停时间排序、ST 排除后的编选）命中排序榜禁区，C 端不得出现；
 *    个股明细类型仍保留在 `LimitLadder.instrumentRows`，只供未来内部评测，页面不读取；
 *  - ST / *ST 排除必须显式标注，不静默过滤；
 *  - 口径为 provisional（临时近似规则），页面固定展示口径版本与范围说明；
 *  - 生产端点在授权落地前一律 unavailable（不展示数值，不用 mock 伪装面客）。
 */
import { useEffect, useState } from 'react';
import { DataGapCard } from '../components/DataGapCard';
import { ErrorBlock, LoadingBlock } from '../components/PageState';
import { reviewGateway } from '../data/ai';
import type { LimitLadder, LimitLadderResult } from '../data/ai/types';
import type { GatewayError } from '../data/gateway';
import { copy, errorCopy, MISSING, sourceLabel } from '../lib/copy';
import { TID } from '../lib/testids';

type PageState =
  | { status: 'loading' }
  | LimitLadderResult
  | { status: 'error'; error: GatewayError };

function asError(error: unknown): PageState {
  const gatewayError =
    typeof error === 'object' && error !== null && 'status' in error && 'network' in error
      ? (error as GatewayError)
      : { status: null, network: true };
  return { status: 'error', error: gatewayError };
}

function CountItem({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="ladder-count">
      <dt className="ladder-count__label">{label}</dt>
      <dd className="ladder-count__value" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function LadderBody({ ladder }: { ladder: LimitLadder }) {
  return (
    <>
      {ladder.demo ? (
        <p className="demo-banner" role="note">
          {copy.review.limits.demoNote}
        </p>
      ) : null}

      <p className="provisional-banner" data-testid={TID.limitProvisionalBanner} role="note">
        {copy.review.limits.provisional}
      </p>
      <p className="st-exclusion" data-testid={TID.limitStExclusion} role="note">
        {copy.review.limits.stExclusion}
        <span className="st-exclusion__count">
          {copy.review.limits.stExcludedLabel} {ladder.stExcludedCount} {copy.review.limits.countUnit}
        </span>
      </p>

      <section
        className="card ladder-card"
        data-testid={TID.limitLadderTable}
        data-mode="aggregate"
        aria-labelledby="ladder-overview-heading"
      >
        <h2 id="ladder-overview-heading" className="card__title">
          {copy.review.limits.overviewTitle}
        </h2>
        <dl className="ladder-counts">
          <CountItem
            label={copy.review.limits.counts.up}
            value={`${ladder.upCount} ${copy.review.limits.countUnit}`}
            testId={TID.limitUpCount}
          />
          <CountItem
            label={copy.review.limits.counts.down}
            value={`${ladder.downCount} ${copy.review.limits.countUnit}`}
            testId={TID.limitDownCount}
          />
          <CountItem
            label={copy.review.limits.counts.maxStreak}
            value={
              ladder.maxStreakDays === null
                ? MISSING
                : `${ladder.maxStreakDays} ${copy.review.limits.streakUnit}`
            }
            testId={TID.limitMaxStreak}
          />
        </dl>

        <h3 className="ladder-buckets__title">{copy.review.limits.counts.distribution}</h3>
        {ladder.streakBuckets.length === 0 ? (
          <p className="card__hint">{copy.review.limits.emptyList}</p>
        ) : (
          <ul
            className="ladder-buckets"
            data-testid={TID.limitStreakDistribution}
            aria-label={copy.review.limits.counts.distribution}
          >
            {ladder.streakBuckets.map((bucket) => (
              <li key={bucket.streakDays} className="ladder-bucket" data-streak-days={bucket.streakDays} data-count={bucket.count}>
                <span className="ladder-bucket__streak">
                  {bucket.streakDays} {copy.review.limits.streakUnit}
                </span>
                <span className="ladder-bucket__count">
                  {bucket.count} {copy.review.limits.countUnit}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="card__hint">{copy.review.limits.aggregateNote}</p>
      </section>

      <dl className="ladder-source">
        <div>
          <dt>{copy.review.limits.caliberVersionLabel}</dt>
          <dd>{ladder.caliberVersion}</dd>
        </div>
        <div>
          <dt>{copy.quote.asOfLabel}</dt>
          <dd>
            <time dateTime={ladder.source.asOf}>{ladder.source.asOf}</time>
          </dd>
        </div>
        <div>
          <dt>{copy.quote.sourceLabel}</dt>
          <dd>{sourceLabel(ladder.source.source)}</dd>
        </div>
      </dl>
    </>
  );
}

export function LimitLadderPage() {
  const [state, setState] = useState<PageState>({ status: 'loading' });

  const load = (): void => {
    setState({ status: 'loading' });
    reviewGateway.getLimitLadder().then(
      (result) => setState(result),
      (error: unknown) => setState(asError(error)),
    );
  };

  useEffect(() => {
    let alive = true;
    reviewGateway.getLimitLadder().then(
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
  }, []);

  return (
    <div className="page ladder-page" data-testid={TID.limitLadderPage}>
      <h1 className="page__title">{copy.review.limits.title}</h1>
      <p className="page__subtitle">{copy.review.limits.subtitle}</p>

      {state.status === 'loading' && (
        <LoadingBlock testId={TID.limitLadderLoading} text={copy.review.limits.loading} />
      )}

      {state.status === 'error' && (
        <ErrorBlock
          testId={TID.limitLadderError}
          text={errorCopy(state.error.status, state.error.network)}
          onRetry={load}
        />
      )}

      {state.status === 'empty' && (
        <div className="state state--empty" data-testid={TID.limitLadderEmpty}>
          <p className="state__title">{copy.review.limits.emptyList}</p>
        </div>
      )}

      {state.status === 'unavailable' && (
        <section className="unavailable-card" role="note">
          <p className="provisional-banner" data-testid={TID.limitProvisionalBanner} role="note">
            {copy.review.limits.provisional}
          </p>
          <p className="st-exclusion" data-testid={TID.limitStExclusion} role="note">
            {copy.review.limits.stExclusion}
          </p>
          <p>{copy.review.limits.unavailable}</p>
          <DataGapCard
            gapKey="limit-ladder"
            title={copy.review.limits.title}
            reason={state.reason}
          />
        </section>
      )}

      {state.status === 'ready' && <LadderBody ladder={state.ladder} />}
    </div>
  );
}
