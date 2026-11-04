/**
 * 自选页（P0 最小集）：验证登录态读取与自选列表读写链路。
 * 列表项链接到个股页；行情数值不在此处展示。
 * 文案来自 lib/copy.ts；错误不暴露内部码。
 */
import { useWatchlistList } from '../components/WatchlistToggle';
import { copy } from '../lib/copy';
import { Link } from '../lib/router';
import { TID } from '../lib/testids';

export function WatchlistPage() {
  const state = useWatchlistList();

  return (
    <div className="page">
      <h1 className="page__title">{copy.watchlist.pageTitle}</h1>

      {state.status === 'loading' && (
        <p className="state__title" role="status">
          {copy.watchlist.loading}
        </p>
      )}

      {state.status === 'anonymous' && <p className="empty-note">{copy.watchlist.anonymous}</p>}

      {state.status === 'error' && (
        <p className="empty-note" role="alert">
          {copy.watchlist.error}
        </p>
      )}

      {state.status === 'ready' && state.ids.length === 0 && (
        <div className="empty-note" data-testid={TID.stockPageEmpty}>
          <p>{copy.watchlist.empty}</p>
          <Link href="/stocks/SSE%3A600519">{copy.watchlist.emptyLink}</Link>
        </div>
      )}

      {state.status === 'ready' && state.ids.length > 0 && (
        <ul className="watchlist-list">
          {state.ids.map((id) => (
            <li key={id} className="watchlist-list__item">
              <Link href={`/stocks/${encodeURIComponent(id)}`} className="watchlist-list__link">
                <span className="mono">{id}</span>
                <span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
