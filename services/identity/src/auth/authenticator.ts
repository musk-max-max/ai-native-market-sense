/**
 * Bearer token 认证适配器 —— 供外壳（A0，`services/api`）把 principal 注入 request。
 *
 * 形状对齐现有 `services/market/src/auth.ts` 的 `Authenticate`（A4/A3 边界）：
 * 返回 `null` 表示「未认证/无凭据」，外壳据此回 401；不在这里做授权判定。
 *
 * 语义：
 *   - 无 Authorization / 非 Bearer → `null`（C 端匿名可访问的读接口由路由自行决定是否要求登录）；
 *   - token 无效/过期/aud 错/角色或 session_version 不一致 → `null`（都按未认证处理，不区分原因）；
 *   - 数据库等基础设施错误 → 原样抛出（不能把故障伪装成 401，否则排障困难）。
 */

import { isIdentityError } from '../domain/errors.js';
import type { Principal } from '../domain/principal.js';
import type { IdentityService } from '../service/identity-service.js';

export interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

export type Authenticate = (request: RequestLike) => Promise<Principal | null>;

export function bearerToken(request: RequestLike): string | null {
  const header = request.headers['authorization'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match?.[1] ?? null;
}

export function createIdentityAuthenticator(service: IdentityService): Authenticate {
  return async (request) => {
    const token = bearerToken(request);
    if (token === null) {
      return null;
    }
    try {
      return await service.authenticateToken(token);
    } catch (error) {
      if (isIdentityError(error)) {
        // 401/403 都按「未认证」交给外壳；403 的 account_locked 已由服务层审计。
        return null;
      }
      throw error;
    }
  };
}
