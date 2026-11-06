import { useEffect } from 'react';
import { track } from './lib/analytics';
import { copy } from './lib/copy';
import { HomePage } from './pages/HomePage';
import { LimitLadderPage } from './pages/LimitLadderPage';
import { PortfolioReviewPage } from './pages/PortfolioReviewPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { StockPage } from './pages/StockPage';
import { WatchlistPage } from './pages/WatchlistPage';
import { AiHomePage } from './pages/AiHomePage';
import { MePage } from './pages/MePage';
import { TabBar } from './components/TabBar';
import { Link, useRoute } from './lib/router';

export function App() {
  const route = useRoute();

  useEffect(() => {
    if (route.name !== 'stock' && route.name !== 'notFound') {
      track('page_view', { route: route.name });
    }
  }, [route]);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        {copy.app.skipToMain}
      </a>

      {/* v2：顶部只留品牌标识，导航下沉为底部 5 项 TabBar（docs/design/c-end-h5-v2.md §1.1/§2.1）。 */}
      <header className="app-bar">
        <Link href="/" className="brand" aria-label={copy.app.brandAriaLabel}>
          <span className="brand__mark" aria-hidden="true">
            MS
          </span>
          <span className="brand__name">
            {copy.app.brandName}
            <span className="brand__tag">{copy.app.brandTag}</span>
          </span>
        </Link>
      </header>

      <main id="main-content" className="app-main" tabIndex={-1}>
        {route.name === 'home' && <HomePage />}
        {route.name === 'watchlist' && <WatchlistPage />}
        {route.name === 'portfolio' && <PortfolioReviewPage />}
        {route.name === 'limitLadder' && <LimitLadderPage />}
        {route.name === 'ai' && <AiHomePage />}
        {route.name === 'me' && <MePage />}
        {route.name === 'stock' && <StockPage instrumentId={route.instrumentId} />}
        {route.name === 'notFound' && <NotFoundPage />}
      </main>

      {/* 免责摘要全站常驻、不可折叠；退订入口同时常驻此处（红线④ / 硬约束 1）。 */}
      <footer className="app-footer">
        <p className="app-footer__title">{copy.app.footerDisclaimerTitle}</p>
        <p>{copy.app.footerNote}</p>
        <p className="app-footer__meta">{copy.app.footerMeta}</p>
        <p className="app-footer__links">
          <Link href="/me" className="app-footer__link">
            {copy.app.footerUnsubscribe}
          </Link>
        </p>
      </footer>

      <TabBar />
    </div>
  );
}
