/**
 * T1 财务健康主题（需求 §3.3：P 一眼结论 / S 支撑卡 / T 历史趋势折叠）。
 * 数据=近 8 季财报指标（冷路径）；文案取 copy.theme + copy.metrics（HARD-002 只述历史/当期）。
 *
 * T 层展开仅渲染已随端点取回的 rows（单端点无二次请求，避免把冷路径再打一遍）。
 */
import { useState } from 'react';
import type { FinHealthData } from '../../data/themeGateway';
import { copy, interpolate } from '../../lib/copy';
import { DatasetLine } from './DatasetLine';
import { MetricCard } from './MetricCard';
import { median, pct, plain } from './format';

interface FinHealthThemeProps {
  data: FinHealthData;
}

export function FinHealthTheme({ data }: FinHealthThemeProps) {
  const [showTrend, setShowTrend] = useState(false);
  const rows = data.rows;
  const latest = rows[0] ?? null;

  if (rows.length === 0) {
    return (
      <div className="theme-empty" data-testid="theme-empty">
        {copy.theme.empty}
      </div>
    );
  }

  const roeMedian = median(rows.map((r) => r.roe));

  return (
    <div className="theme-panel" data-testid="theme-panel-fin-health">
      <section className="theme-primary" data-testid="theme-primary">
        <h2 className="theme-primary__title">{copy.theme.primaryTitle}</h2>
        <p className="theme-primary__line" data-testid="theme-primary-1">
          {interpolate(copy.theme.p1Roe, { value: pct(latest ? latest.roe : null), median: pct(roeMedian) })}
        </p>
        <p className="theme-primary__line" data-testid="theme-primary-2">
          {interpolate(copy.theme.p1Revenue, { value: pct(latest ? latest.orYoyPct : null) })}
        </p>
        <p className="theme-primary__line" data-testid="theme-primary-3">
          {interpolate(copy.theme.p1Debt, { value: pct(latest ? latest.debtToAssets : null) })}
        </p>
      </section>

      <section className="theme-secondary" data-testid="theme-secondary">
        <h2 className="theme-secondary__title">{copy.theme.secondaryTitle}</h2>
        <div className="theme-secondary__grid">
          <MetricCard testid="theme-card-roe" label="ROE" value={pct(latest ? latest.roe : null)} sub={latest ? latest.period : undefined} />
          <MetricCard
            testid="theme-card-or-yoy"
            label={copy.metrics.rowOrYoy}
            value={pct(latest ? latest.orYoyPct : null)}
          />
          <MetricCard
            testid="theme-card-np-yoy"
            label={copy.metrics.rowNetprofitYoy}
            value={pct(latest ? latest.netprofitYoyPct : null)}
          />
          <MetricCard
            testid="theme-card-debt"
            label={copy.metrics.rowDebtToAssets}
            value={pct(latest ? latest.debtToAssets : null)}
          />
          <MetricCard
            testid="theme-card-gross-margin"
            label={copy.metrics.rowGrossMargin}
            value={pct(latest ? latest.grossprofitMargin : null)}
          />
          <MetricCard
            testid="theme-card-net-margin"
            label={copy.metrics.rowNetMargin}
            value={pct(latest ? latest.netprofitMargin : null)}
          />
          <MetricCard
            testid="theme-card-current-ratio"
            label={copy.metrics.rowCurrentRatio}
            value={plain(latest ? latest.currentRatio : null)}
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
            <ul className="theme-trend__list">
              {rows.map((r) => (
                <li key={r.period} className="theme-trend__row" data-testid="theme-trend-row">
                  <span className="theme-trend__cell">{r.period}</span>
                  <span className="theme-trend__cell">ROE {pct(r.roe)}</span>
                  <span className="theme-trend__cell">
                    {copy.metrics.rowOrYoy} {pct(r.orYoyPct)}
                  </span>
                  <span className="theme-trend__cell">
                    {copy.metrics.rowDebtToAssets} {pct(r.debtToAssets)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <DatasetLine dataset={copy.theme.dataset.finHealth} asOf={data.asOf} badge="cold" />
    </div>
  );
}
