/**
 * 自选接口认证适配（P0 过渡实现）。
 *
 * 决策 #5：鉴权走统一判定点，服务端只信任 token 主体，**不接受请求体/查询参数里的 user_id**。
 * P0 的 identity 服务（A4）尚未落地，因此本文件只提供两个入口：
 *   1. 外壳已装饰 `request.user`（A0/A4 接入后）→ 直接用其 userId；
 *   2. E2E/本地显式开启的静态 token（E2E_MODE=1 且设置 E2E_AUTH_TOKEN）→ 映射到固定 userId。
 * 生产（未开 allowDevAuth）永远返回 null → 401，不接受任何"开发后门"。
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import type { MarketConfig } from './config.js';

export interface Principal {
  readonly userId: string;
}

export type Authenticate = (request: FastifyRequest) => Promise<Principal | null> | Principal | null;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function principalFromShell(request: FastifyRequest): Principal | null {
  const candidate = (request as unknown as { user?: unknown }).user;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  const userId = record.userId ?? record.id;
  return typeof userId === 'string' && userId.length > 0 ? { userId } : null;
}

export function createAuthenticator(config: MarketConfig): Authenticate {
  return (request) => {
    const fromShell = principalFromShell(request);
    if (fromShell !== null) return fromShell;

    const header = request.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match === null) return null;
    const token = match[1]?.trim() ?? '';
    if (token.length === 0) return null;

    if (!config.allowDevAuth || config.devAuthToken === undefined) return null;
    if (!safeEqual(token, config.devAuthToken)) return null;
    return { userId: config.devAuthUserId };
  };
}
