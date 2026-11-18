/**
 * 单股主题页（M1a-F3，需求 §3.3 模板 / §3.4 热冷并存）。
 *
 * - 热字段：股票头（GET /v1/c-end/stocks/:id/metrics）独立请求独立失败，不进冷降级容器。
 * - 冷字段：主题端点（themeGateway）经 ColdDataWrapper 四态降级（429/超时/5xx/stale）。
 * - 登录守卫：未登录 replace 跳 /login?next=（Q5 Phase 2 handleUnauthorized 的入口侧补充）。
 * - 文案全部来自 copy.*（compliance 单一来源门禁），只描述历史/当期数据（HARD-002）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  cEndMetricsGateway,
  type StockMetricsResult,
} from '../data/cEndMetricsGateway';
import { themeGateway } from '../data/index';
import {
  type FinHealthData,
  type SentimentData,
  type ThemeResult,
  type ValuationData,
} from '../data/themeGateway';
import { ColdDataWrapper } from '../components/cold/ColdDataWrapper';
import { ThemeTabStrip } from '../components/ThemeTabStrip';
import { hasAuthToken } from '../lib/auth';
import { copy, MISSING } from '../lib/copy';
import { navigate, type ThemeKey } from '../lib/router';
import { pct, price } from './themes/format';
import { FinHealthTheme } from './themes/FinHealthTheme';
import { MoneySentimentTheme } from './themes/MoneySentimentTheme';
import { ValuationPriceTheme } from './themes/ValuationPriceTheme';

type ColdState =
  | { key: 'fin-health'; result: ThemeResult<FinHealthData> }
  | { key: 'valuation-price'; result: ThemeResult<ValuationData> }
  | { key: 'money-sentiment'; result: ThemeResult<SentimentData> }
  | null;

interface ThemePageProps {
  instrumentId: string;
  initialTheme: ThemeKey;
}

function toNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function ThemePage({ instrumentId, initialTheme }: ThemePageProps) {
  const [hot, setHot] = useState<StockMetricsResult | null>(null);
  const [cold, setCold] = useState<ColdState>(null);
  const [reload, setReload] = useState(0);

  // 登录守卫（需求 §5.1：主题页仅登录用户可访问）。
  useEffect(() => {
    if (hasAuthToken()) return;
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    navigate('/login?next=' + next, { replace: true });
  }, []);

  // 热字段：股票头指标（失败只影响头部区，不进冷降级容器，§3.4 不拖垮）。
  useEffect(() => {
    let alive = true;
    setHot(null);
    void cEndMetricsGateway.getStockMetrics(instrumentId).then((r) => {
      if (alive) setHot(r);
    });
    return () => {
      alive = false;
    };
  }, [instrumentId, reload]);

  // 冷字段：当前主题端点；切主题先置 loading（旧面板撤下），热字段不受影响。
  useEffect(() => {
    let alive = true;
    setCold(null);
    const load = async (): Promise<void> => {
      if (initialTheme === 'fin-health') {
        const r = await themeGateway.getFinHealth(instrumentId);
        if (alive) setCold({ key: 'fin-health', result: r });
      } else if (initialTheme === 'valuation-price') {
        const r = await themeGateway.getValuationPrice(instrumentId);
        if (alive) setCold({ key: 'valuation-price', result: r });
      } else {
        const r = await themeGateway.getSentiment(instrumentId);
        if (alive) setCold({ key: 'money-sentiment', result: r });
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [instrumentId, initialTheme, reload]);

  const retry = useCallback(() => setReload((n) => n + 1), []);

  // 判别联合收窄：先 key 后 kind（TS 关联类型），只有当前主题的数据才进面板。
  const loaded = cold !== null && cold.key === initialTheme ? cold : null;
  const loading = loaded === null;
  const error =
    loaded !== null && loaded.result.kind !== 'ready'
      ? loaded.result.kind === 'stale'
        ? loaded.result.error
        : loaded.result.error
      : null;
  const cachedAt = loaded !== null && loaded.result.kind === 'stale' ? loaded.result.cachedAt : null;

  let panel = null;
  if (loaded !== null) {
    if (loaded.key === 'fin-health' && loaded.result.kind !== 'error') {
      panel = <FinHealthTheme data={loaded.result.data} />;
    } else if (loaded.key === 'valuation-price' && loaded.result.kind !== 'error') {
      panel = <ValuationPriceTheme data={loaded.result.data} />;
    } else if (loaded.key === 'money-sentiment' && loaded.result.kind !== 'error') {
      panel = <MoneySentimentTheme data={loaded.result.data} />;
    }
  }

  return (
    <section className="theme-page" data-testid="theme-page">
      <ThemeTabStrip instrumentId={instrumentId} active={initialTheme} />

      {hot === null ? (
        <div className="theme-head theme-head--loading" data-testid="theme-head-loading" aria-busy="true">
          {copy.states.loadingTitle}
        </div>
      ) : hot.kind === 'error' ? (
        <div className="theme-head theme-head--error" data-testid="theme-head-error" role="alert">
          <p className="theme-head__error-title">{copy.metrics.errorTitle}</p>
          <p className="theme-head__error-body">
            {hot.network ? copy.metrics.errorNetwork : copy.metrics.errorTitle}
          </p>
          <button type="button" className="theme-head__retry" data-testid="theme-head-retry" onClick={retry}>
            {copy.states.retry}
          </button>
        </div>
      ) : (
        <header className="theme-head" data-testid="theme-head">
          <p className="theme-head__name">{hot.data.instrument_name ?? hot.data.instrument_id}</p>
          <p className="theme-head__code">{hot.data.instrument_id}</p>
          <p className="theme-head__price">
            <span className="theme-head__last" data-testid="theme-head-close">
              {price(toNumber(hot.data.close))}
            </span>
            <span className="theme-head__pct" data-testid="theme-head-pct">
              {pct(toNumber(hot.data.pct_change_pct))}
            </span>
          </p>
          <p className="theme-head__asof" data-testid="theme-head-asof">
            {copy.theme.asOfLabel}: {hot.data.as_of ?? MISSING}
          </p>
        </header>
      )}

      <ColdDataWrapper
        loading={loading}
        error={error}
        cachedAt={cachedAt}
        throttleKey={'theme:' + instrumentId + ':' + initialTheme}
        onRetry={retry}
      >
        {panel}
      </ColdDataWrapper>

      <footer className="theme-footer" data-testid="theme-footer">
        {copy.theme.footerNote}
      </footer>
    </section>
  );
}
