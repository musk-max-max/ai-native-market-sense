/**
 * identity 域错误：只表达「机器可读 code + 审计 reason」，不含任何用户可见文案。
 *
 * WHY 不含文案：agents/README.md 与 ADR-006/H3 的硬规则是「4xx 用户可见 title 一律来自
 * `services/api/src/copy.ts`」；域层拼中文会绕过 COPY_VERSION 快照校验。HTTP 适配层
 * （`src/plugin.ts`）负责把 code 映射成 `HttpProblem`，title 取现有 copy 表。
 *
 * `reason` 只进服务端审计日志（ADR-008 D2：pending 不暴露审核原因），不得回传客户端。
 */

export const IDENTITY_ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
} as const;

export type IdentityErrorCode = keyof typeof IDENTITY_ERROR_STATUS;

/** 审计 reason 白名单：低基数、ASCII，避免自由文本进事件流。 */
export type IdentityReason =
  | 'invalid_credentials'
  | 'duplicate_email'
  | 'email_invalid'
  | 'password_policy'
  | 'internal_registration_not_allowed'
  | 'internal_pending'
  | 'account_locked'
  | 'user_not_found'
  | 'token_invalid'
  | 'token_expired'
  | 'token_audience_mismatch'
  | 'legacy_token_rejected'
  | 'session_version_mismatch'
  | 'claim_inconsistent'
  | 'internal_active_without_approval'
  | 'approver_not_human'
  | 'approver_not_allowed'
  | 'application_not_found'
  | 'application_not_pending'
  | 'internal_tier_invalid'
  | 'research_only_requires_reason'
  | 'approval_ref_invalid'
  | 'tier_change_not_internal'
  | 'actor_model_version_required';

export class IdentityError extends Error {
  override readonly name = 'IdentityError';
  readonly code: IdentityErrorCode;
  readonly status: number;
  /** 只进审计/日志；不回传客户端。 */
  readonly reason: IdentityReason;

  constructor(code: IdentityErrorCode, reason: IdentityReason) {
    super(`${code}:${reason}`);
    this.code = code;
    this.status = IDENTITY_ERROR_STATUS[code];
    this.reason = reason;
  }
}

export function isIdentityError(value: unknown): value is IdentityError {
  return value instanceof IdentityError;
}
