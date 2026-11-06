/**
 * 认证薄壳（ADR-008 D6.4 / services/identity/docs/integration.md §1）。
 *
 * 外壳只做「解析 Bearer → 注入受信 principal → 统一 401」，不做角色/授权判定：
 * - 公开路径白名单之外一律默认拒绝；
 * - audience 由路径决定（/v1/internal/* → internal，其他 → c_end），不读客户端 header；
 * - market gate 仍是数据授权的唯一判定点。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from '@market-sense/identity';

import { ERROR_TITLES } from './copy.js';
import { HttpProblem } from './errors.js';

export type Audience = 'c_end' | 'internal';

export type Authenticator = (request: FastifyRequest) => Promise<Principal | null>;

export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  '/healthz',
  '/v1/auth/register',
  '/v1/auth/login',
  '/v1/internal/auth/register',
]);

function pathname(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

export function isPublicRoute(url: string): boolean {
  return PUBLIC_ROUTES.has(pathname(url));
}

/** 受众只由服务端路径判定，忽略任何客户端 header/query。 */
export function audienceForPath(url: string): Audience {
  return pathname(url).startsWith('/v1/internal/') ? 'internal' : 'c_end';
}

declare module 'fastify' {
  interface FastifyRequest {
    user: Principal | null;
    audience: Audience;
  }
}

export interface InstallAuthOptions {
  /**
   * 由 server 注入的真实认证器（identity service + authenticator）。
   * 缺省为「一切非公开请求 401」的默认拒绝；不会降级为匿名放行。
   */
  readonly authenticator?: Authenticator;
}

export function installAuth(app: FastifyInstance, options: InstallAuthOptions = {}): void {
  const authenticate: Authenticator = options.authenticator ?? (async () => null);

  app.decorateRequest('user', null);
  app.decorateRequest('audience', 'c_end');

  app.addHook('preHandler', async (request) => {
    request.audience = audienceForPath(request.url);
    if (isPublicRoute(request.url)) {
      return;
    }
    const principal = await authenticate(request);
    if (principal === null) {
      throw new HttpProblem(401, 'UNAUTHENTICATED', ERROR_TITLES[401]);
    }
    request.user = principal;
  });
}
