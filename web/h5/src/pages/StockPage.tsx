/**
 * 个股页（P0 竖切片）。
 *
 * 页面契约（A12 tests/e2e/specs/p0-stock-page.spec.js）：
 *  - /stocks/:instrument_id 主路由，/stock/:instrument_id 别名；
 *  - data-testid 全部来自 testids.json；首屏 6 元素（名称/最新价/涨跌幅/as_of/来源/免责）无需滚动；
 *  - 行情缺失/受限/出错时不渲染任何可判读价格；
 *  - 免责与数据口径披露不因加载失败、延时或受限而降级。
 *
 * 合规（H3/H4）：
 *  - 数值展示唯一条件是服务端 entitlement.is_entitled === true（在 data 适配层判断）；
 *  - 受限/403 只渲染中性文案区，不渲染 0/--/骨架/空数字 span；
 *  - 文案全部来自 lib/copy.ts，错误按 HTTP status 映射，不按内部错误码/接口 detail 渲染。
 */
import { useEffect, useState } from 'react';
import { DisclaimerNotice, DisclaimerUnavailable } from '../components/DisclaimerNotice';
import { EntitlementNotice } from '../components/EntitlementNotice';
import { FundamentalSummary } from '../components/FundamentalSummary';
import { QuoteBlock } from '../components/QuoteBlock';
import { ErrorState, LoadingState } from '../components/States';
import { WatchlistToggle } from '../components/WatchlistToggle';
import { gateway } from '../data';
import type { StockPageResult } from '../data/gateway';
import type { StockPageData } from '../data/model';
import { track } from '../lib/analytics';
import { errorCopy, copy, MISSING } from '../lib/copy';
import { Link } from '../lib/router';
import { TID } from '../lib/testids';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: StockPageData }
  | { status: 'error'; error: Extract<StockPageResult, { kind: 'error' }> };

function useStockPage(instrumentId: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void gateway.getStockPage(instrumentId).then((result) => {
      if (!alive) return;
      if (result.kind === 'ready') setState({ status: 'ready', data: result.data });
      else setState({ status: 'error', error: result });
    });
    return () => {
      alive = false;
    };
  }, [instrumentId]);

  return state;
}

export function StockPage({ instrumentId }: { instrumentId: string }) {
  const load = useStockPage(instrumentId);

  useEffect(() => {
    if (load.status === 'ready') {
      track('stock_page_view', {
        instrumentId,
        uiState: load.data.access === 'restricted' ? 'restricted' : 'ready',
      });
    } else if (load.status === 'error') {
      track('ui_state', { uiState: 'error' });
    }
  }, [load, instrumentId]);

  if (load.status === 'loading') {
    return (
      <div className="page stock-page" data-testid={TID.stockPage}>
        <nav className="breadcrumb" aria-label={copy.stock.breadcrumbAria}>
          <Link href="/">{copy.stock.breadcrumbHome}</Link>
        </nav>
        <LoadingState />
      </div>
    );
  }

  if (load.status === 'error') {
    const text = errorCopy(load.error.status, load.error.network);
    return (
      <div className="page stock-page" data-testid={TID.stockPage}>
        <nav className="breadcrumb" aria-label={copy.stock.breadcrumbAria}>
          <Link href="/">{copy.stock.breadcrumbHome}</Link>
        </nav>
        <ErrorState text={text} onRetry={() => window.location.reload()} />
        <p className="page__footnote">
          {copy.stock.instrumentPrefix}
          <span className="mono">{load.error.instrumentId}</span>
        </p>
      </div>
    );
  }

  const { data } = load;
  const displayName = data.name ?? data.instrumentId;
  const exchangeLabel = data.exchange ? (copy.stock.exchange[data.exchange] ?? data.exchange) : null;
  const granted = data.access === 'granted';
  const quoteReady = granted && data.quote !== null && data.source !== null;
  const compliant = !granted || (quoteReady && data.disclaimer !== null);

  return (
    <div className="page stock-page" data-testid={TID.stockPage}>
      <nav className="breadcrumb" aria-label={copy.stock.breadcrumbAria}>
        <Link href="/">{copy.stock.breadcrumbHome}</Link>
        <span aria-hidden="true">{copy.stock.breadcrumbSeparator}</span>
        <span className="breadcrumb__current" aria-current="page">
          {displayName}
        </span>
      </nav>

      <header className="stock-header" data-testid={TID.stockHeader}>
        <h1 className="stock-header__name" data-testid={TID.stockName}>
          {displayName}
        </h1>
        <p className="stock-header__meta">
          <span className="mono" data-testid={TID.instrumentId}>
            {data.instrumentId}
          </span>
          <span className="stock-header__exchange" data-testid={TID.stockExchange}>
            {exchangeLabel ?? data.exchange ?? MISSING}
          </span>
          <span className="tag" data-testid={TID.stockBoard}>
            {data.board ? (copy.stock.board[data.board] ?? data.board) : MISSING}
          </span>
          <span className="tag" data-testid={TID.stockSecurityType}>
            {data.securityType
              ? (copy.stock.securityType[data.securityType] ?? data.securityType)
              : MISSING}
          </span>
          <span className="tag tag--warning" data-testid={TID.stockListStatus}>
            {data.listStatus ? (copy.stock.listStatus[data.listStatus] ?? data.listStatus) : MISSING}
          </span>
          <span className="stock-header__listed">
            <span className="stock-header__label">{copy.stock.listDateLabel}</span>
            <span data-testid={TID.stockListDate}>{data.listedAt ?? MISSING}</span>
          </span>
        </p>
      </header>

      {compliant && granted && data.quote && data.source ? (
        <QuoteBlock quote={data.quote} source={data.source} />
      ) : compliant ? (
        <EntitlementNotice problem={data.restrictedProblem} />
      ) : (
        <ErrorState
          text={{
            ...errorCopy(null, false),
            title: copy.stock.incompleteTitle,
            message: copy.stock.incompleteMessage,
          }}
          onRetry={() => window.location.reload()}
        />
      )}

      <WatchlistToggle instrumentId={data.instrumentId} />

      {data.disclaimer ? (
        <DisclaimerNotice disclaimer={data.disclaimer} />
      ) : (
        <DisclaimerUnavailable />
      )}

      <FundamentalSummary fundamental={data.fundamental} state={data.fundamentalState} />

      <p className="page__footnote">{copy.stock.footnote}</p>
    </div>
  );
}
