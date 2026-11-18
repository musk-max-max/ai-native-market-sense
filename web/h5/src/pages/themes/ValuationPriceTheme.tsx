/**
 * T2 估值与价格主题（近 1 年估值行情 + 分位）。行序本地按 trade_date 降序（服务端已 DESC，这里防御性重排）。
 */
import { useState } from 'react';
import type { ValuationData } from '../../data/themeGateway';
import { copy, interpolate } from '../../lib/copy';
import { DatasetLine } from './DatasetLine';
import { MetricCard } from './MetricCard';
import { pct, percentile, plain, price } from './format';

interface ValuationPriceThemeProps {
  data: ValuationData;
}

export function ValuationPriceTheme({ data }: ValuationPriceThemeProps) {
  const [showTrend, setShowTrend] = useState(false);
  const rows = data.rows.slice().sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));
  const latest = rows[0] ?? null;
  // 30 日涨跌基准：取最新前第 30 个交易日；不足则用最早一条。
  const base = rows[30] ?? rows[rows.length - 1] ?? null;
  const change =
    latest !== null &&
    base !== null &&
    latest.close !== null &&
    base.close !== null &&
    base.close !== 0
      ? (latest.close / base.close - 1) * 100
      : null;

  if (rows.length === 0) {
    return (
      <div className="theme-empty" data-testid="theme-empty">
        {copy.theme.empty}
      </div>
    );
  }

  return (
    <div className="theme-panel" data-testid="theme-panel-valuation-price">
      <section className="theme-primary" data-testid="theme-primary">
        <h2 className="theme-primary__title">{copy.theme.primaryTitle}</h2>
        <p className="theme-primary__line" data-testid="theme-primary-1">
          {interpolate(copy.theme.p2Pe, {
            value: plain(latest ? latest.peTtm : null),
            percentile: percentile(data.percentiles.peTtm),
          })}
        </p>
        <p className="theme-primary__line" data-testid="theme-primary-2">
          {interpolate(copy.theme.p2Close, {
            value: price(latest ? latest.close : null),
            change: pct(change),
          })}
        </p>
        <p className="theme-primary__line" data-testid="theme-primary-3">
          {interpolate(copy.theme.p2Pb, {
            value: plain(latest ? latest.pb : null),
            percentile: percentile(data.percentiles.pb),
          })}
        </p>
      </section>

      <section className="theme-secondary" data-testid="theme-secondary">
        <h2 className="theme-secondary__title">{copy.theme.secondaryTitle}</h2>
        <div className="theme-secondary__grid">
          <MetricCard testid="theme-card-pe" label="PE-TTM" value={plain(latest ? latest.peTtm : null)} />
          <MetricCard testid="theme-card-pb" label="PB" value={plain(latest ? latest.pb : null)} />
          <MetricCard
            testid="theme-card-close"
            label={copy.theme.closeLabel}
            value={price(latest ? latest.close : null)}
          />
          <MetricCard
            testid="theme-card-turnover"
            label={copy.metrics.rowTurnoverRate}
            value={pct(latest ? latest.turnoverRatePct : null)}
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
              {rows.slice(0, 30).map((r) => (
                <li key={r.tradeDate} className="theme-trend__row" data-testid="theme-trend-row">
                  <span className="theme-trend__cell">{r.tradeDate}</span>
                  <span className="theme-trend__cell">{price(r.close)}</span>
                  <span className="theme-trend__cell">PE-TTM {plain(r.peTtm)}</span>
                  <span className="theme-trend__cell">PB {plain(r.pb)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <DatasetLine dataset={copy.theme.dataset.valuationPrice} asOf={data.asOf} badge="cold" />
    </div>
  );
}
