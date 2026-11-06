/**
 * `@market-sense/identity` 公共出口（A4）。
 *
 * 使用方：
 *   - 外壳 A0：`import { identityPlugin } from '@market-sense/identity/plugin'` 挂载到 /v1；
 *   - 外壳 A0：`createIdentityAuthenticator(service)` 把 Bearer 换成 principal 注入 request；
 *   - A3（market gate）：只消费 `Principal` 形状（`userId/userType/tier/sessionVersion`），不依赖本包运行时代码。
 *
 * 不导出：PG 适配器细节（`./adapters/*` 由插件内部使用）、密码/JWT 内部实现（避免被绕过服务层直接使用）。
 */

export { identityPlugin, createIdentityPlugin } from './plugin.js';
export {
  createIdentityAuthenticator,
  bearerToken,
  type Authenticate,
  type RequestLike,
} from './auth/authenticator.js';
export {
  createIdentityService,
  IdentityService,
  type ApprovalResult,
  type ApproveInput,
  type InternalRegistrationResult,
  type LoginResult,
  type RegistrationResult,
  type RejectInput,
} from './service/identity-service.js';
export {
  loadIdentityConfig,
  IdentityConfigError,
  INTERNAL_TIER_DEFAULT,
  type IdentityConfig,
  type InternalRegistrationConfig,
} from './config.js';
export {
  principalFromUser,
  tierForUser,
  isInternalPrincipal,
  type Principal,
} from './domain/principal.js';
export {
  IdentityError,
  isIdentityError,
  IDENTITY_ERROR_STATUS,
  type IdentityErrorCode,
  type IdentityReason,
} from './domain/errors.js';
export {
  USER_TYPES,
  INTERNAL_TIERS,
  USER_TIERS,
  HUMAN_APPROVERS,
  ACCOUNT_ADMINISTRATORS,
  APPLICATION_STATUSES,
  isApproverId,
  type UserType,
  type InternalTier,
  type UserTier,
  type UserRecord,
  type InternalApplication,
  type ApplicationStatus,
} from './domain/types.js';
export {
  APPROVAL_REF_PATTERN,
  isApprovalRef,
  generateApprovalRef,
  uuidv7,
  type ApprovalEnv,
} from './domain/approval-ref.js';
export {
  IDENTITY_AUDIT_EVENT_TYPES,
  type AuditActor,
  type AuditSink,
  type IdentityAuditEvent,
  type IdentityAuditEventType,
} from './ports/audit-sink.js';
export type {
  ApplicationRepository,
  IdentityRepositories,
  IdentityStore,
  UserRepository,
} from './ports/store.js';
export { MemoryIdentityStore, MemoryAuditSink } from './adapters/memory-store.js';
export { PgIdentityStore, type PgIdentityStoreOptions } from './adapters/pg-store.js';
export {
  signToken,
  verifyToken,
  assertJwtSecret,
  DEFAULT_JWT_AUDIENCE,
  MIN_JWT_SECRET_LENGTH,
  type JwtClaims,
  type JwtConfig,
} from './auth/jwt.js';
export { hashPassword, verifyPassword } from './auth/password.js';
