/**
 * T3 资金与情绪主题：市场级（涨停/跌停/涨跌比/最高连板）+ 个股级（主力净流入/龙虎榜/机构/融资）。
 * 市场级数据近 30 日窗口 → 热标记；个股级汇总为实时查询 → 冷标记（copy.dataBadge）。
 * 无个股级汇总（summary 全 null）时个股卡显示 MISSING 占位，不伪造。
 */
import { useState } from 'react';
import type { SentimentData } from '../../data/themeGateway';
import { copy, interpolate } from '../../lib/copy';
import { DatasetLine } from './DatasetLine';
import { MetricCard } from './MetricCard';
import { count, money, plain } from './format';

interface MoneySentimentThemeProps {
  data: SentimentData;
}

export function MoneySentimentTheme({ data }: MoneySentimentThemeProps) {
  const [showTrend, setShowTrend] = useState(false);
  const market = data.market.slice().sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));
  const latest = market[0] ?? null;
  const summary = data.stockSummary;

  if (market.length === 0 && data.stockRows.length === 0) {
    return (
      <div className="theme-empty" data-testid="theme-empty">
        {copy.theme.empty}
      </div>
    );
  }

  return (
    <div className="theme-panel" data-testid="theme-panel-money-sentiment">
      <section className="theme-primary" data-testid="theme-primary">
        <h2 className="theme-primary__title">{copy.theme.primaryTitle}</h2>
        <p className="theme-primary__line" data-testid="theme-primary-1">
          {interpolate(copy.theme.p3Market, {
            up: count(latest ? latest.limitUpCount : null),
            down: count(latest ? latest.limitDownCount : null),
            ratio: plain(latest ? latest.advDecRatio : null),
            streak: count(latest ? latest.maxLimitStreak : null),
          })}
        </p>
        <p className="theme-primary__line" data-testid="theme-primary-2">
          {interpolate(copy.theme.p3Inflow, { value: money(summary ? summary.netInflowSum : null) })}
        </p>
        <p className="theme-primary__line" data-testid="theme-primary-3">
          {interpolate(copy.theme.p3Margin, {
            value: money(summary ? summary.financingBalanceLatest : null),
          })}
        </p>
      </section>

      <section className="theme-secondary" data-testid="theme-secondary">
        <h2 className="theme-secondary__title">{copy.theme.secondaryTitle}</h2>
        <div className="theme-secondary__grid">
          <MetricCard
            testid="theme-card-limit-up"
            label={copy.review.limits.counts.up}
            value={count(latest ? latest.limitUpCount : null)}
          />
          <MetricCard
            testid="theme-card-limit-down"
            label={copy.review.limits.counts.down}
            value={count(latest ? latest.limitDownCount : null)}
          />
          <MetricCard
            testid="theme-card-adv-dec-ratio"
            label={copy.theme.rowAdvDecRatio}
            value={plain(latest ? latest.advDecRatio : null)}
          />
          <MetricCard
            testid="theme-card-max-streak"
            label={copy.review.limits.counts.maxStreak}
            value={count(latest ? latest.maxLimitStreak : null)}
          />
          <MetricCard
            testid="theme-card-net-inflow"
            label={copy.metrics.rowNetInflow}
            value={money(summary ? summary.netInflowLatest : null)}
          />
          <MetricCard
            testid="theme-card-lhb"
            label={copy.metrics.rowLhbNet}
            value={money(summary ? summary.lhbNetBuySum : null)}
          />
          <MetricCard
            testid="theme-card-inst-net-buy"
            label={copy.theme.rowInstNetBuy}
            value={money(summary ? summary.instNetBuySum : null)}
          />
          <MetricCard
            testid="theme-card-financing"
            label={copy.theme.rowFinancingBalance}
            value={money(summary ? summary.financingBalanceLatest : null)}
          />
        </div>
      </section>

      <div className="theme-trend" data-testid="theme-trend">
        <button
          type="button"
          className="theme-trend__toggle"
          data-testid="theme-trend-toggle"
          aria-expanded={showTrend}
          onClick={() => setShowTrend((v) => !v)}
        >
          {copy.theme.trendToggle}
        </button>
        {showTrend ? (
          <div className="theme-trend__body" data-testid="theme-trend-body">
            <h3 className="theme-trend__title">{copy.theme.trendTitle}</h3>
            {market.length === 0 ? (
              <p data-testid="theme-trend-empty">{copy.theme.empty}</p>
            ) : (
              <ul className="theme-trend__list">
                {market.slice(0, 30).map((r) => (
                  <li key={r.tradeDate} className="theme-trend__row" data-testid="theme-trend-row">
                    <span className="theme-trend__cell">{r.tradeDate}</span>
                    <span className="theme-trend__cell">
                      {copy.review.limits.counts.up} {count(r.limitUpCount)}
                    </span>
                    <span className="theme-trend__cell">
                      {copy.review.limits.counts.down} {count(r.limitDownCount)}
                    </span>
                    <span className="theme-trend__cell">
                      {copy.review.limits.counts.maxStreak} {count(r.maxLimitStreak)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      <DatasetLine dataset={copy.theme.dataset.sentimentMarket} asOf={data.asOf} badge="hot" />
      <DatasetLine dataset={copy.theme.dataset.sentimentStock} asOf={data.asOf} badge="cold" />
    </div>
  );
}
