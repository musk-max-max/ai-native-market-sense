/**
 * 极小 History 路由（无第三方 router，保持首屏预算）。
 *
 * 路由：
 *  - /                         首页
 *  - /stocks/:instrument_id    P0 个股页（A12 E2E 主路径，instrument_id 形如 SSE:600519）
 *  - /stock/:instrument_id     别名（docs/p0-acceptance.md 早期写法），渲染同一页面
 *  - /watchlist                自选页
 *  - /review/portfolio         B1-01 自选组合复盘（固定模板）
 *  - /review/limits            B1-02 涨跌停梯队
 *  - /ai                       「AI」Tab：AI 解读聚合入口（docs/design/c-end-h5-v2.md §1.1）
 *  - /me                       「我的」Tab：账户 / 权限 / 退订（置顶）/ 免责全文
 *
 * 5 个底部 Tab 的路由映射见 components/TabBar.tsx（/review/limits 与个股页归「行情」）。
 *
 * 服务端（server.mjs）对所有非静态 GET 做 SPA fallback，因此直接刷新深链可用。
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { MouseEvent, ReactNode } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'watchlist' }
  | { name: 'portfolio' }
  | { name: 'limitLadder' }
  | { name: 'ai' }
  | { name: 'me' }
  | { name: 'stock'; instrumentId: string }
  | { name: 'notFound'; path: string };

const NAVIGATE_EVENT = 'app:navigate';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 非法百分号编码不应让整页崩溃：原样返回，交给 API 返回 404/VALIDATION_ERROR。
    return value;
  }
}

export function normalizeInstrumentId(raw: string): string {
  const decoded = safeDecode(raw).trim();
  // 契约 InstrumentId 为 交易所:代码。仅做大小写/空白归一，不猜测交易所、不补全代码。
  const match = /^([A-Za-z]{2,6}):(.+)$/.exec(decoded);
  if (!match || !match[1] || !match[2]) return decoded;
  return `${match[1].toUpperCase()}:${match[2]}`;
}

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' };
  if (pathname === '/watchlist' || pathname === '/watchlist/') return { name: 'watchlist' };
  if (pathname === '/review/portfolio' || pathname === '/review/portfolio/')
    return { name: 'portfolio' };
  if (pathname === '/review/limits' || pathname === '/review/limits/')
    return { name: 'limitLadder' };
  if (pathname === '/ai' || pathname === '/ai/') return { name: 'ai' };
  if (pathname === '/me' || pathname === '/me/') return { name: 'me' };

  const stockMatch = /^\/(?:stocks|stock)\/([^/]+)\/?$/.exec(pathname);
  if (stockMatch && stockMatch[1]) {
    return { name: 'stock', instrumentId: normalizeInstrumentId(stockMatch[1]) };
  }

  return { name: 'notFound', path: pathname };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

function getSnapshot(): string {
  return window.location.pathname;
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const current = `${window.location.pathname}${window.location.search}`;
  if (to === current) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getSnapshot, () => '/');
  return useMemo(() => parseRoute(pathname), [pathname]);
}

interface LinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  'aria-current'?: 'page' | undefined;
  'aria-label'?: string;
}

/** 站内链接：保留浏览器原生可访问性语义，仅拦截同标签页左键点击。 */
export function Link({ href, children, className, ...rest }: LinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
