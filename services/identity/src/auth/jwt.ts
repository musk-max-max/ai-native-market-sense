/**
 * JWT 签发/校验（HS256，node:crypto 内置）。
 *
 * 依据 ADR-008 D2「JWT claims（最小集）」：
 *   { sub, aud: "market-sense", user_type: "c_end | internal_active",
 *     tier: "c_end_display | internal_eval | research_only", session_version, iat, exp }
 *
 * 校验优先级（fail-closed）：
 *   算法固定 HS256（拒绝 `none`/其它 alg，防算法混淆）→ 签名 → 结构 → aud → 时间窗
 *   → **claim 判别式自洽性**。
 * 错误口径（H2 会签 ADR-008 L125 的 gate 契约）：
 *   - token 形态/签名/过期/aud 错 → `UNAUTHENTICATED`（401），不暴露内部原因；
 *   - 带 claim 但轴不一致/未知值 → `FORBIDDEN claim_inconsistent`（403），**不得降级成 c_end**；
 *   - 无 `user_type` 的旧 token 不在此处判定，由 service 的 S4 兼容逻辑决定是否按 `c_end`。
 * 判别式联合语义：c_end → tier 只能是 `c_end_display`；internal_active → tier ∈
 * {internal_eval, research_only} 且必须带 `session_version`（ADR-008 D2 / L125）。
 *
 * WHY 不用 jose/jsonwebtoken：工作区当前无该依赖，P0 最小集签名逻辑 50 行可测；
 * 引入第三方库需改 pnpm-lock（A13 维护）且增加供应链面。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { IdentityError } from '../domain/errors.js';
import type { Principal } from '../domain/principal.js';
import { USER_TIERS, type SignedInUserType, type UserTier } from '../domain/types.js';

export const DEFAULT_JWT_AUDIENCE = 'market-sense';
export const MIN_JWT_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 8192;
const CLOCK_SKEW_SECONDS = 60;

export interface JwtConfig {
  readonly secret: string;
  readonly audience: string;
  readonly ttlSeconds: number;
}

/** 已验签的 claims；字段按 token 里实际存在与否可选（兼容旧 token）。 */
export interface JwtClaims {
  readonly sub: string;
  readonly aud: string;
  readonly user_type?: SignedInUserType;
  readonly tier?: UserTier;
  readonly session_version?: number;
  readonly iat: number;
  readonly exp: number;
}

export interface IssuedToken {
  readonly token: string;
  /** ISO8601（UTC）。 */
  readonly expiresAt: string;
}

export function assertJwtSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `identity JWT secret 至少 ${MIN_JWT_SECRET_LENGTH} 字符（当前 ${String(secret?.length ?? 0)}）`,
    );
  }
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data, 'utf8').digest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSignedInUserType(value: unknown): value is SignedInUserType {
  return value === 'c_end' || value === 'internal_active';
}

function isUserTier(value: unknown): value is UserTier {
  return typeof value === 'string' && (USER_TIERS as readonly string[]).includes(value);
}

/** 签发：claims 只从 principal 推导，调用方无法注入角色字段。 */
export function signToken(
  principal: Principal,
  config: JwtConfig,
  nowMs: number = Date.now(),
): IssuedToken {
  assertJwtSecret(config.secret);
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + config.ttlSeconds;
  const claims: Record<string, unknown> = {
    sub: principal.userId,
    aud: config.audience,
    user_type: principal.userType,
    tier: principal.tier,
    session_version: principal.sessionVersion,
    iat,
    exp,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = base64UrlEncode(hmac(config.secret, signingInput));
  return {
    token: `${signingInput}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * 验签 + 结构校验。抛 `IdentityError('UNAUTHENTICATED', ...)`，`reason` 只进审计日志。
 */
export function verifyToken(
  token: string,
  config: JwtConfig,
  nowMs: number = Date.now(),
): JwtClaims {
  assertJwtSecret(config.secret);
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }

  // 1) 算法固定：只接受 HS256。禁止按 header.alg 动态选择（算法混淆攻击）。
  let header: unknown;
  try {
    header = base64UrlDecodeJson(headerPart);
  } catch {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }
  if (!isRecord(header) || header['alg'] !== 'HS256' || header['typ'] !== 'JWT') {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }

  // 2) 签名（常量时间比较）
  const expected = hmac(config.secret, `${headerPart}.${payloadPart}`);
  let actual: Buffer;
  try {
    actual = Buffer.from(signaturePart, 'base64url');
  } catch {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }

  // 3) 结构
  let payload: unknown;
  try {
    payload = base64UrlDecodeJson(payloadPart);
  } catch {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }
  if (!isRecord(payload)) {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }
  const sub = payload['sub'];
  const aud = payload['aud'];
  const iat = payload['iat'];
  const exp = payload['exp'];
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }
  if (typeof aud !== 'string') {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }

  // 4) aud 只做 token 来源校验，不用于选择路由 audience（ADR-008 D2）。
  if (aud !== config.audience) {
    throw new IdentityError('UNAUTHENTICATED', 'token_audience_mismatch');
  }

  // 5) 时间窗
  const nowSeconds = Math.floor(nowMs / 1000);
  if ((exp as number) <= nowSeconds) {
    throw new IdentityError('UNAUTHENTICATED', 'token_expired');
  }
  if ((iat as number) > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new IdentityError('UNAUTHENTICATED', 'token_invalid');
  }

  // 6) claim 判别式（(user_type, tier) 轴一致性）——H2 L125：不匹配或未知值一律 403，不得降级。
  const userType = payload['user_type'];
  const tier = payload['tier'];
  const sessionVersion = payload['session_version'];
  if (userType !== undefined) {
    if (!isSignedInUserType(userType)) {
      throw new IdentityError('FORBIDDEN', 'claim_inconsistent');
    }
    if (tier === undefined || !isUserTier(tier)) {
      throw new IdentityError('FORBIDDEN', 'claim_inconsistent');
    }
    if (
      sessionVersion !== undefined &&
      (!Number.isInteger(sessionVersion) || (sessionVersion as number) < 0)
    ) {
      throw new IdentityError('FORBIDDEN', 'claim_inconsistent');
    }
    if (userType === 'c_end') {
      // C 端 token 只能带 c_end_display；internal_* 档出现在 C 端 token 即轴错。
      if (tier !== 'c_end_display') {
        throw new IdentityError('FORBIDDEN', 'claim_inconsistent');
      }
    } else {
      // internal_active：档位必须落在内部两档，且必须带 session_version（失效控制）。
      if (tier === 'c_end_display' || sessionVersion === undefined) {
        throw new IdentityError('FORBIDDEN', 'claim_inconsistent');
      }
    }
  } else if (tier !== undefined) {
    // 无 user_type 却带 tier：旧 token 不应有档位字段，视为伪造/损坏。
    throw new IdentityError('FORBIDDEN', 'claim_inconsistent');
  }

  const claims: JwtClaims = {
    sub,
    aud,
    iat: iat as number,
    exp: exp as number,
  };
  return {
    ...claims,
    ...(userType === undefined ? {} : { user_type: userType }),
    ...(tier === undefined ? {} : { tier }),
    ...(sessionVersion === undefined ? {} : { session_version: sessionVersion as number }),
  };
}
