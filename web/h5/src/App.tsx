import { useEffect } from 'react';
import { track } from './lib/analytics';
import { copy } from './lib/copy';
import { HomePage } from './pages/HomePage';
import { LimitLadderPage } from './pages/LimitLadderPage';
import { PortfolioReviewPage } from './pages/PortfolioReviewPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { StockPage } from './pages/StockPage';
import { WatchlistPage } from './pages/WatchlistPage';
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
        <nav className="app-nav" aria-label={copy.app.navAriaLabel}>
          <Link
            href="/"
            className="app-nav__link"
            aria-current={route.name === 'home' ? 'page' : undefined}
          >
            {copy.app.navHome}
          </Link>
          <Link
            href="/watchlist"
            className="app-nav__link"
            aria-current={route.name === 'watchlist' ? 'page' : undefined}
          >
            {copy.app.navWatchlist}
          </Link>
          <Link
            href="/review/portfolio"
            className="app-nav__link"
            aria-current={route.name === 'portfolio' ? 'page' : undefined}
          >
            {copy.app.navReview}
          </Link>
        </nav>
      </header>

      <main id="main-content" className="app-main" tabIndex={-1}>
        {route.name === 'home' && <HomePage />}
        {route.name === 'watchlist' && <WatchlistPage />}
        {route.name === 'portfolio' && <PortfolioReviewPage />}
        {route.name === 'limitLadder' && <LimitLadderPage />}
        {route.name === 'stock' && <StockPage instrumentId={route.instrumentId} />}
        {route.name === 'notFound' && <NotFoundPage />}
      </main>

      <footer className="app-footer">
        <p>{copy.app.footerNote}</p>
        <p className="app-footer__meta">{copy.app.footerMeta}</p>
      </footer>
    </div>
  );
}
