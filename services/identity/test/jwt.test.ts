/**
 * JWT（HS256）签发/校验 + H2 会签的判别式 claim 契约（ADR-008 L125）：
 *   - c_end token：tier 只能是 c_end_display；
 *   - internal_active token：tier ∈ {internal_eval, research_only} 且必须带 session_version；
 *   - 轴不一致/未知值 → 403 claim_inconsistent，不得降级成 c_end；
 *   - 无 user_type 的旧 C 端 token 允许通过 verify（由 service 按 S4 兼容判定）。
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  assertJwtSecret,
  signToken,
  verifyToken,
  type JwtConfig,
} from '../src/auth/jwt.js';
import type { Principal } from '../src/domain/principal.js';
import { IdentityError } from '../src/domain/errors.js';
import { TEST_AUDIENCE, TEST_SECRET, signRawClaims } from './helpers.js';

const CONFIG: JwtConfig = { secret: TEST_SECRET, audience: TEST_AUDIENCE, ttlSeconds: 3600 };
const NOW = Date.parse('2026-11-06T00:00:00.000Z');

const C_END: Principal = {
  userId: 'usr_1',
  userType: 'c_end',
  tier: 'c_end_display',
  sessionVersion: 0,
};
const INTERNAL: Principal = {
  userId: 'usr_2',
  userType: 'internal_active',
  tier: 'research_only',
  sessionVersion: 3,
};

function expectIdentityError(fn: () => unknown, status: number, reason?: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof IdentityError, `期望 IdentityError，实际 ${String(error)}`);
    assert.equal(error.status, status);
    if (reason !== undefined) {
      assert.equal(error.reason, reason);
    }
    return;
  }
  assert.fail('期望抛错，但没有抛');
}

test('signToken/verifyToken：往返 claim 与 principal 一致', () => {
  const issued = signToken(C_END, CONFIG, NOW);
  const claims = verifyToken(issued.token, CONFIG, NOW);
  assert.equal(claims.sub, 'usr_1');
  assert.equal(claims.aud, TEST_AUDIENCE);
  assert.equal(claims.user_type, 'c_end');
  assert.equal(claims.tier, 'c_end_display');
  assert.equal(claims.session_version, 0);
  assert.equal(claims.iat, Math.floor(NOW / 1000));
  assert.equal(issued.expiresAt, new Date((Math.floor(NOW / 1000) + 3600) * 1000).toISOString());
});

test('verifyToken：internal_active 往返保留内部档与 session_version', () => {
  const claims = verifyToken(signToken(INTERNAL, CONFIG, NOW).token, CONFIG, NOW);
  assert.equal(claims.user_type, 'internal_active');
  assert.equal(claims.tier, 'research_only');
  assert.equal(claims.session_version, 3);
});

test('verifyToken：过期 token → 401 token_expired', () => {
  const token = signToken(C_END, CONFIG, NOW).token;
  expectIdentityError(() => verifyToken(token, CONFIG, NOW + 3600 * 1000), 401, 'token_expired');
});

test('verifyToken：aud 不匹配 → 401（aud 只做来源校验，不参与路由受众）', () => {
  const token = signToken(C_END, CONFIG, NOW).token;
  expectIdentityError(
    () => verifyToken(token, { ...CONFIG, audience: 'other-service' }, NOW),
    401,
    'token_audience_mismatch',
  );
});

test('verifyToken：签名错误/篡改 payload → 401 token_invalid', () => {
  const token = signToken(C_END, CONFIG, NOW).token;
  const [header, payload, signature] = token.split('.');
  assert.ok(header !== undefined && payload !== undefined && signature !== undefined);

  const tamperedPayload = Buffer.from(
    JSON.stringify({
      sub: 'usr_1',
      aud: TEST_AUDIENCE,
      user_type: 'internal_active',
      tier: 'research_only',
      session_version: 9,
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 3600,
    }),
  ).toString('base64url');
  expectIdentityError(
    () => verifyToken(`${header}.${tamperedPayload}.${signature}`, CONFIG, NOW),
    401,
    'token_invalid',
  );

  const badSignature = createHmac('sha256', 'another-secret').update(`${header}.${payload}`).digest('base64url');
  expectIdentityError(() => verifyToken(`${header}.${payload}.${badSignature}`, CONFIG, NOW), 401, 'token_invalid');
});

test('verifyToken：拒绝 alg=none（算法混淆）', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: 'usr_1', aud: TEST_AUDIENCE, iat: 0, exp: 9_999_999_999 }),
  ).toString('base64url');
  expectIdentityError(() => verifyToken(`${header}.${payload}.`, CONFIG, NOW), 401, 'token_invalid');
});

test('claim 轴：c_end + internal 档 → 403 claim_inconsistent（不得降级）', () => {
  const token = signRawClaims(
    { sub: 'usr_1', user_type: 'c_end', tier: 'research_only', session_version: 0 },
    CONFIG,
    NOW,
  );
  expectIdentityError(() => verifyToken(token, CONFIG, NOW), 403, 'claim_inconsistent');
});

test('claim 轴：internal_active + c_end_display → 403 claim_inconsistent', () => {
  const token = signRawClaims(
    { sub: 'usr_2', user_type: 'internal_active', tier: 'c_end_display', session_version: 1 },
    CONFIG,
    NOW,
  );
  expectIdentityError(() => verifyToken(token, CONFIG, NOW), 403, 'claim_inconsistent');
});

test('claim 轴：internal_active 缺 session_version / 未知 user_type / 未知 tier → 403', () => {
  const missingSession = signRawClaims(
    { sub: 'usr_2', user_type: 'internal_active', tier: 'internal_eval' },
    CONFIG,
    NOW,
  );
  expectIdentityError(() => verifyToken(missingSession, CONFIG, NOW), 403, 'claim_inconsistent');

  const unknownUserType = signRawClaims({ sub: 'usr_1', user_type: 'admin', tier: 'c_end_display' }, CONFIG, NOW);
  expectIdentityError(() => verifyToken(unknownUserType, CONFIG, NOW), 403, 'claim_inconsistent');

  const unknownTier = signRawClaims({ sub: 'usr_1', user_type: 'c_end', tier: 'admin' }, CONFIG, NOW);
  expectIdentityError(() => verifyToken(unknownTier, CONFIG, NOW), 403, 'claim_inconsistent');
});

test('旧 token（无 user_type）可通过 verify，但不允许夹带 tier', () => {
  const legacy = signRawClaims({ sub: 'usr_1' }, CONFIG, NOW);
  const claims = verifyToken(legacy, CONFIG, NOW);
  assert.equal(claims.user_type, undefined);
  assert.equal(claims.tier, undefined);

  const legacyWithTier = signRawClaims({ sub: 'usr_1', tier: 'internal_eval' }, CONFIG, NOW);
  expectIdentityError(() => verifyToken(legacyWithTier, CONFIG, NOW), 403, 'claim_inconsistent');
});

test('assertJwtSecret：短密钥启动失败（fail-closed）', () => {
  assert.throws(() => assertJwtSecret('short'));
  assert.doesNotThrow(() => assertJwtSecret(TEST_SECRET));
});
