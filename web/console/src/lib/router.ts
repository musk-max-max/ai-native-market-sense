import { useSyncExternalStore } from 'react';

/**
 * 极简路由（参照 web/h5/src/lib/router.tsx 的自研思路：不引第三方 router）。
 * 中后台路由数量固定、需要与四中台导航绑定，不需要嵌套路由。
 */

export type ConsoleRoute = 'overview' | 'config' | 'approvals' | 'compliance' | 'crm';

export interface RouteDef {
  id: ConsoleRoute;
  path: string;
  label: string;
  /** 路由归属的中台域，用于侧边导航分组。 */
  group: 'ops' | 'admin' | 'compliance' | 'crm';
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'overview', path: '/overview', label: '配置看板', group: 'ops' },
  { id: 'config', path: '/config', label: '配置编辑器', group: 'ops' },
  { id: 'approvals', path: '/approvals', label: '审批队列', group: 'admin' },
  { id: 'compliance', path: '/compliance', label: '合规与审计', group: 'compliance' },
  { id: 'crm', path: '/crm', label: '客户跟进', group: 'crm' },
];

export const DEFAULT_ROUTE: ConsoleRoute = 'overview';

const NAVIGATE_EVENT = 'console:navigate';
const BASE_PREFIX = '/console';

function stripBase(pathname: string): string {
  if (pathname === BASE_PREFIX || pathname === `${BASE_PREFIX}/`) return '/';
  if (pathname.startsWith(`${BASE_PREFIX}/`)) return pathname.slice(BASE_PREFIX.length);
  return pathname;
}

export function parseRoute(pathname: string): ConsoleRoute {
  const path = stripBase(pathname);
  const match = ROUTES.find((route) => path === route.path || path.startsWith(`${route.path}/`));
  return match?.id ?? DEFAULT_ROUTE;
}

export function routePath(route: ConsoleRoute): string {
  return ROUTES.find((item) => item.id === route)?.path ?? '/overview';
}

export function navigate(route: ConsoleRoute, options: { replace?: boolean } = {}): void {
  const path = routePath(route);
  if (options.replace) {
    window.history.replaceState(null, '', path);
  } else {
    window.history.pushState(null, '', path);
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

export function useRoute(): ConsoleRoute {
  return useSyncExternalStore(
    subscribe,
    () => parseRoute(window.location.pathname),
    () => DEFAULT_ROUTE,
  );
}
