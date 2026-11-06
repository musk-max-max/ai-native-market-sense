/**
 * 单测共用夹具（不是测试文件：`test/*.test.ts` 才会被 node --test 执行）。
 *
 * 原则：测试不碰网络/PG；用 `MemoryIdentityStore` + 固定/可推进时钟，保证断言确定性。
 */

import { createHash, createHmac } from 'node:crypto';

import { MemoryAuditSink, MemoryIdentityStore } from '../src/adapters/memory-store.js';
import { DEFAULT_JWT_AUDIENCE, type JwtConfig } from '../src/auth/jwt.js';
import type { IdentityConfig } from '../src/config.js';
import type { AuditActor } from '../src/ports/audit-sink.js';
import type { Clock } from '../src/ports/clock.js';
import { createIdentityService, type IdentityService } from '../src/service/identity-service.js';

export const TEST_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
export const TEST_AUDIENCE = DEFAULT_JWT_AUDIENCE;
export const INVITE_CODE = 'INVITE-2026';
export const INTERNAL_EMAIL = 'alice@example.com';

/** 12 位以上，满足默认密码策略。 */
export const VALID_PASSWORD = 'correct horse battery staple';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function testConfig(overrides: { legacy?: boolean; internalRegistration?: boolean } = {}): IdentityConfig {
  return {
    jwt: { secret: TEST_SECRET, audience: TEST_AUDIENCE, ttlSeconds: 3600 },
    acceptLegacyTokensWithoutUserType: overrides.legacy ?? true,
    passwordMinLength: 12,
    internalRegistration: {
      enabled: overrides.internalRegistration ?? true,
      inviteCodeSha256: new Set([sha256Hex(INVITE_CODE)]),
      companyEmailDomains: ['example.com'],
      sourceIpHashSalt: 'test-source-ip-salt-0123',
    },
    approvalEnv: null,
  };
}

/** 可推进时钟：token 过期/时间窗测试用。 */
export class MutableClock implements Clock {
  private millis: number;

  constructor(iso: string = '2026-11-06T00:00:00.000Z') {
    this.millis = Date.parse(iso);
  }

  now(): Date {
    return new Date(this.millis);
  }

  advanceSeconds(seconds: number): void {
    this.millis += seconds * 1000;
  }

  advanceMillis(millis: number): void {
    this.millis += millis;
  }
}

export interface TestContext {
  readonly service: IdentityService;
  readonly store: MemoryIdentityStore;
  readonly audit: MemoryAuditSink;
  readonly clock: MutableClock;
  readonly config: IdentityConfig;
}

export function makeContext(options: { legacy?: boolean; internalRegistration?: boolean } = {}): TestContext {
  const audit = new MemoryAuditSink();
  const store = new MemoryIdentityStore(audit);
  const clock = new MutableClock();
  const config = testConfig(options);
  const service = createIdentityService({ store, config, clock });
  return { service, store, audit, clock, config };
}

export const HUMAN_APPROVER: AuditActor = { kind: 'human', id: 'H3' };
export const ACCOUNT_ADMIN: AuditActor = { kind: 'human', id: 'H5' };
export const AGENT_ACTOR: AuditActor = {
  kind: 'agent',
  id: 'A4',
  modelVersion: 'deepseek-flash',
};

/** 手写任意 claims 的合法签名 token（测试伪造/旧 token 场景；生产只能走 signToken）。 */
export function signRawClaims(
  claims: Record<string, unknown>,
  config: JwtConfig = { secret: TEST_SECRET, audience: TEST_AUDIENCE, ttlSeconds: 3600 },
  nowMs: number = Date.parse('2026-11-06T00:00:00.000Z'),
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(
    JSON.stringify({ aud: config.audience, iat, exp: iat + config.ttlSeconds, ...claims }),
  ).toString('base64url');
  const signature = createHmac('sha256', config.secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
