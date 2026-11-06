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

export type SignedInUserType = 'c_end' | 'internal_active';
export type UserTier = 'c_end_display' | 'internal_eval' | 'research_only';

/** ADR-008 D1/D2：外壳注入的已认证主体；gate 只消费这四个字段，不解析 token。 */
export interface Principal {
  readonly userId: string;
  readonly userType: SignedInUserType;
  readonly tier: UserTier;
  readonly sessionVersion: number;
}

export type PrincipalParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'present'; readonly principal: Principal };

function isUserTier(value: unknown): value is UserTier {
  return value === 'c_end_display' || value === 'internal_eval' || value === 'research_only';
}

/**
 * claim 轴一致性（ADR-008 D3.2 / H2 L125）：
 *  - c_end ↔ c_end_display；
 *  - internal_active ↔ internal_eval | research_only；
 *  - 只有“完全没有 user_type”的旧 token 才按 c_end 兼容；有 user_type 但档位非法一律拒绝，
 *    不得降级成 c_end。返回 invalid 而不是回退，调用方必须 fail-closed。
 */
export function principalStateFromShell(request: FastifyRequest): PrincipalParse {
  const candidate = (request as unknown as { user?: unknown }).user;
  if (candidate === undefined) return { kind: 'absent' };
  if (typeof candidate !== 'object' || candidate === null) {
    return { kind: 'invalid', reason: 'principal_not_object' };
  }
  const record = candidate as Record<string, unknown>;
  const userId = record.userId ?? record.id;
  if (typeof userId !== 'string' || userId.length === 0) {
    return { kind: 'invalid', reason: 'principal_missing_user_id' };
  }
  const rawType = record.userType;
  const rawTier = record.tier;
  const rawSession = record.sessionVersion;
  if (rawSession !== undefined && (typeof rawSession !== 'number' || !Number.isInteger(rawSession) || rawSession < 0)) {
    return { kind: 'invalid', reason: 'invalid_session_version' };
  }
  const sessionVersion = rawSession === undefined ? 0 : rawSession;
  if (rawType === undefined) {
    // S4 兼容：旧 token 无 user_type → 按 c_end；但若同时带了非法 tier，不得猜成 c_end。
    if (rawTier !== undefined && rawTier !== 'c_end_display') {
      return { kind: 'invalid', reason: 'legacy_tier_axis_mismatch' };
    }
    return { kind: 'present', principal: { userId, userType: 'c_end', tier: 'c_end_display', sessionVersion } };
  }
  if (rawType !== 'c_end' && rawType !== 'internal_active') {
    return { kind: 'invalid', reason: 'unknown_user_type' };
  }
  if (!isUserTier(rawTier)) {
    return { kind: 'invalid', reason: 'invalid_tier' };
  }
  if (rawType === 'c_end' && rawTier !== 'c_end_display') {
    return { kind: 'invalid', reason: 'tier_axis_mismatch' };
  }
  if (rawType === 'internal_active' && (rawTier === 'internal_eval' || rawTier === 'research_only') === false) {
    return { kind: 'invalid', reason: 'tier_axis_mismatch' };
  }
  return { kind: 'present', principal: { userId, userType: rawType, tier: rawTier, sessionVersion } };
}

export type Authenticate = (request: FastifyRequest) => Promise<Principal | null> | Principal | null;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 兼容入口：absent/invalid 都返回 null（401）；需要区分时用 principalStateFromShell。 */
export function principalFromShell(request: FastifyRequest): Principal | null {
  const parsed = principalStateFromShell(request);
  return parsed.kind === 'present' ? parsed.principal : null;
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
    // 开发静态 token 固定按 C 端发布档位；生产无此后门。
    return { userId: config.devAuthUserId, userType: 'c_end', tier: 'c_end_display', sessionVersion: 0 };
  };
}
