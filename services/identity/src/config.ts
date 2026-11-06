/**
 * identity 配置（env → 强类型），启动即校验（fail-closed）。
 *
 * 配置边界（ADR-008 D9）：
 *   - `internal_tier` 是**用户级数据**，不进 env（`services/market/src/config.ts:9-11` 的 DataTier
 *     保持不动）；本域唯一的档位默认值 `INTERNAL_TIER_DEFAULT` 是审批默认值，不是数据档配置。
 *   - `INTERNAL_AI_ADVICE_MODE` 归 A3/A13，本域不读（q3 不在范围）。
 *
 * 密钥/开关一旦缺失直接抛错，不允许「启动成功但默认放行」。
 */

import { assertJwtSecret, DEFAULT_JWT_AUDIENCE, type JwtConfig } from './auth/jwt.js';
import type { ApprovalEnv } from './domain/approval-ref.js';

/** 内部注册默认档位（ADR-008 D1：默认 internal_eval；research_only 需审批人显式选择+理由）。 */
export const INTERNAL_TIER_DEFAULT = 'internal_eval' as const;

export const DEFAULT_JWT_TTL_SECONDS = 8 * 60 * 60;
export const DEFAULT_PASSWORD_MIN_LENGTH = 12;

export interface InternalRegistrationConfig {
  /** 关则内部注册入口一律拒（默认关：P0 内部注册需 H5 明确开启）。 */
  readonly enabled: boolean;
  /** 邀请码的 sha256（只存哈希，不存明文码；见 README「邀请码运维」）。 */
  readonly inviteCodeSha256: ReadonlySet<string>;
  /** 企业邮箱白名单域（小写，不含 @）。与邀请码是「或」关系。 */
  readonly companyEmailDomains: readonly string[];
  /** 来源 IP 哈希盐（不落明文 IP，ADR-008 D2）。 */
  readonly sourceIpHashSalt: string;
}

export interface IdentityConfig {
  readonly jwt: JwtConfig;
  /**
   * S4 兼容开关：旧 C 端 token 无 `user_type` 时按 `c_end` 处理（ADR-008 D9 S4）。
   * 默认开；全量换发完成后由 A13 关闭，关闭后旧 token 一律 401。
   */
  readonly acceptLegacyTokensWithoutUserType: boolean;
  readonly passwordMinLength: number;
  readonly internalRegistration: InternalRegistrationConfig;
  /** 审批 id 的跨环境前缀（`prod:`/`staging:`）；未配置则不带前缀。 */
  readonly approvalEnv: ApprovalEnv | null;
}

export class IdentityConfigError extends Error {
  override readonly name = 'IdentityConfigError';
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === '1' || raw.toLowerCase() === 'true') {
    return true;
  }
  if (raw === '0' || raw.toLowerCase() === 'false') {
    return false;
  }
  throw new IdentityConfigError(`${key} 必须是 1/0/true/false，当前 ${raw}`);
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new IdentityConfigError(`${key} 必须是正整数，当前 ${raw}`);
  }
  return value;
}

function readCsv(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

const APPROVAL_ENVS = ['prod', 'staging'] as const;

function readApprovalEnv(env: NodeJS.ProcessEnv): ApprovalEnv | null {
  const raw = env['IDENTITY_APPROVAL_ENV'];
  if (raw === undefined || raw === '') {
    return null;
  }
  if (raw !== 'prod' && raw !== 'staging') {
    throw new IdentityConfigError(
      `IDENTITY_APPROVAL_ENV 只能是 ${APPROVAL_ENVS.join('/')}，当前 ${raw}`,
    );
  }
  return raw;
}

/**
 * 从 env 载入；构造身份插件时必须调用（缺 secret 直接失败，不带默认值）。
 *
 * 必需：`IDENTITY_JWT_SECRET`（≥32 字符）。
 * 可选：`IDENTITY_JWT_AUDIENCE`（默认 market-sense）、`IDENTITY_JWT_TTL_SECONDS`（默认 8h）、
 *      `IDENTITY_ACCEPT_LEGACY_TOKENS`（默认 1）、`IDENTITY_PASSWORD_MIN_LENGTH`（默认 12）、
 *      `IDENTITY_INTERNAL_REGISTRATION_ENABLED`、`IDENTITY_INTERNAL_INVITE_SHA256`（逗号分隔）、
 *      `IDENTITY_COMPANY_EMAIL_DOMAINS`（逗号分隔）、`IDENTITY_SOURCE_IP_HASH_SALT`、
 *      `IDENTITY_APPROVAL_ENV`。
 */
export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const secret = env['IDENTITY_JWT_SECRET'] ?? '';
  try {
    assertJwtSecret(secret);
  } catch (error) {
    throw new IdentityConfigError(error instanceof Error ? error.message : 'IDENTITY_JWT_SECRET 非法');
  }

  const enabled = readBoolean(env, 'IDENTITY_INTERNAL_REGISTRATION_ENABLED', false);
  const inviteCodeSha256 = new Set<string>();
  for (const item of readCsv(env, 'IDENTITY_INTERNAL_INVITE_SHA256')) {
    if (!/^[0-9a-f]{64}$/.test(item)) {
      throw new IdentityConfigError('IDENTITY_INTERNAL_INVITE_SHA256 必须是 64 位小写 hex');
    }
    inviteCodeSha256.add(item);
  }
  const companyEmailDomains = readCsv(env, 'IDENTITY_COMPANY_EMAIL_DOMAINS');
  for (const domain of companyEmailDomains) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      throw new IdentityConfigError(`企业邮箱域格式非法：${domain}`);
    }
  }
  const sourceIpHashSalt = env['IDENTITY_SOURCE_IP_HASH_SALT'] ?? '';
  if (enabled) {
    if (inviteCodeSha256.size === 0 && companyEmailDomains.length === 0) {
      throw new IdentityConfigError(
        '内部注册已开启，但既无 IDENTITY_INTERNAL_INVITE_SHA256 也无 IDENTITY_COMPANY_EMAIL_DOMAINS（否则任何人都能自助注册内部账号）',
      );
    }
    if (sourceIpHashSalt.length < 16) {
      throw new IdentityConfigError(
        '内部注册已开启时 IDENTITY_SOURCE_IP_HASH_SALT 必填且 ≥16 字符（避免明文 IP 落库）',
      );
    }
  }

  const jwt: JwtConfig = {
    secret,
    audience: env['IDENTITY_JWT_AUDIENCE'] ?? DEFAULT_JWT_AUDIENCE,
    ttlSeconds: readPositiveInt(env, 'IDENTITY_JWT_TTL_SECONDS', DEFAULT_JWT_TTL_SECONDS),
  };

  const passwordMinLength = readPositiveInt(
    env,
    'IDENTITY_PASSWORD_MIN_LENGTH',
    DEFAULT_PASSWORD_MIN_LENGTH,
  );
  if (passwordMinLength < 8) {
    throw new IdentityConfigError('IDENTITY_PASSWORD_MIN_LENGTH 不得小于 8');
  }

  return {
    jwt,
    acceptLegacyTokensWithoutUserType: readBoolean(env, 'IDENTITY_ACCEPT_LEGACY_TOKENS', true),
    passwordMinLength,
    internalRegistration: {
      enabled,
      inviteCodeSha256,
      companyEmailDomains,
      sourceIpHashSalt,
    },
    approvalEnv: readApprovalEnv(env),
  };
}
