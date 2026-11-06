/**
 * 已认证主体（principal）—— A4/A3 边界的共享类型。
 *
 * ADR-008 §附：「`services/market/src/auth.ts:16-18`：`Principal` 从仅 `userId` 扩展为
 * `{ userId, userType, tier, sessionVersion }`（A4/A3 边界）」。
 * 本文件是该形状的真源；A3 的 `services/market/src/auth.ts` 应 re-export/镜像这四个字段
 * （接线归 A3，A4 不写 market/，见 ownership.yaml）。
 *
 * 硬规则（ADR-008 D1/D2）：
 *   - `internal_pending` 没有登录态，永远不产出 principal；
 *   - 被停用（`accountLocked`）同样不产出 principal；
 *   - `internal_active` 没有 `approvalRef` 视为数据错误（fail-closed）；
 *   - `tier` 由服务端存储推导，客户端 header/body 一律不参与（决策 #5）。
 */

import { IdentityError } from './errors.js';
import type { SignedInUserType, UserRecord, UserTier } from './types.js';

export interface Principal {
  readonly userId: string;
  readonly userType: SignedInUserType;
  /** C 端恒为 `c_end_display`；内部为审批人绑定的 `internal_eval | research_only`。 */
  readonly tier: UserTier;
  /** 与 identity.users.session_version 一致；不一致即旧 token。 */
  readonly sessionVersion: number;
}

/** 用户记录 → 用户侧档位（ADR-008 D2：`c_end` → `c_end_display`；内部 → `internal_tier`）。 */
export function tierForUser(user: UserRecord): UserTier {
  if (user.userType === 'c_end') {
    return 'c_end_display';
  }
  if (user.userType === 'internal_active') {
    if (user.internalTier === null) {
      // 数据错误：internal_active 必须有审批人绑定的档位。fail-closed（ADR-008 D2 审批）。
      throw new IdentityError('FORBIDDEN', 'internal_active_without_approval');
    }
    return user.internalTier;
  }
  throw new IdentityError('FORBIDDEN', 'internal_pending');
}

/** 用户记录 → principal；不可登录态（pending / locked / 缺审批回指）一律抛错。 */
export function principalFromUser(user: UserRecord): Principal {
  if (user.accountLocked) {
    throw new IdentityError('FORBIDDEN', 'account_locked');
  }
  if (user.userType === 'internal_pending') {
    throw new IdentityError('FORBIDDEN', 'internal_pending');
  }
  if (user.userType === 'internal_active') {
    if (user.approvalRef === null || user.approvedBy === null || user.approvedAt === null) {
      throw new IdentityError('FORBIDDEN', 'internal_active_without_approval');
    }
  }
  return {
    userId: user.userId,
    userType: user.userType,
    tier: tierForUser(user),
    sessionVersion: user.sessionVersion,
  };
}

/** 内部身份判定（供 gate / 审计使用，不做授权决策）。 */
export function isInternalPrincipal(principal: Principal): boolean {
  return principal.userType === 'internal_active';
}
