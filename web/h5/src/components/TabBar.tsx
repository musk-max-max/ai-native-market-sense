/**
 * 底部 TabBar（5 项，固定；docs/design/c-end-h5-v2.md §1.1）。
 *
 * 为什么不用组件库：`web/h5` 依赖只有 react / react-dom / @market-sense/api-client，
 * 首屏 JS 有 200KB gzip 硬门禁（红线⑤）；5 个文本 Tab 用语义化 markup + CSS 即可，
 * 不为一处导航引入运行时依赖。
 *
 * 可访问性：`<nav>` + `<ul>`，当前项用 `aria-current="page"`（不是只靠颜色区分），
 * 固定定位的 CSS 见 styles/app.css 的 `.app-tabbar`（定位必须自补，见设计稿 §2.1 说明）。
 *
 * testid：刻意不加。新增 testid 要先在 tests/e2e/testids.json（A7 写域）注册，
 * 本组件的选择器用语义（role/nav + aria-current）就足够 E2E 稳定定位。
 */
import { copy } from '../lib/copy';
import { Link, useRoute } from '../lib/router';
import type { Route } from '../lib/router';

type TabKey = 'market' | 'watchlist' | 'portfolio' | 'ai' | 'me';

interface Tab {
  key: TabKey;
  href: string;
  label: string;
}

const TABS: ReadonlyArray<Tab> = [
  { key: 'market', href: '/', label: copy.app.tabMarket },
  { key: 'watchlist', href: '/watchlist', label: copy.app.tabWatchlist },
  { key: 'portfolio', href: '/review/portfolio', label: copy.app.tabPortfolio },
  { key: 'ai', href: '/ai', label: copy.app.tabAi },
  { key: 'me', href: '/me', label: copy.app.tabMe },
];

/** 路由 → 高亮 Tab。个股页与涨跌停梯队归属「行情」（v2 把梯队收进行情二级段控）。 */
export function tabKeyForRoute(route: Route): TabKey | null {
  switch (route.name) {
    case 'home':
    case 'stock':
    case 'limitLadder':
      return 'market';
    case 'watchlist':
      return 'watchlist';
    case 'portfolio':
      return 'portfolio';
    case 'ai':
      return 'ai';
    case 'me':
      return 'me';
    default:
      return null;
  }
}

export function TabBar() {
  const route = useRoute();
  const activeKey = tabKeyForRoute(route);

  return (
    <nav className="app-tabbar" aria-label={copy.app.navAriaLabel}>
      <ul className="app-tabbar__list">
        {TABS.map((tab) => (
          <li key={tab.key} className="app-tabbar__item">
            <Link
              href={tab.href}
              className="app-tabbar__link"
              aria-current={activeKey === tab.key ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
