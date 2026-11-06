/**
 * 状态迁移（纯函数）：只负责「改哪些字段」，不负责权限判定。
 *
 * 判定（谁能审批、tier 是否合法、ref 形态）在 `src/service/identity-service.ts`；
 * 这里是审计 before/after 的计算基础。所有迁移都递增 `sessionVersion`（ADR-008 D1 硬规则 4：
 * 审批、改档、停用都使旧 token 失效）。
 *
 * 停用/吊销**不改变** `userType`：ADR-008 D1 状态机明确 `account_locked=true` 时
 * `user_type` 保留，取消停用后可恢复原角色（P1 流程另定）。
 */

import type { ApproverId, InternalTier, UserRecord } from './types.js';

export interface ApprovalTransitionInput {
  readonly internalTier: InternalTier;
  readonly approvedBy: ApproverId;
  readonly approvalRef: string;
  /** ISO8601（UTC）。 */
  readonly at: string;
}

/** internal_pending → internal_active。 */
export function applyApproval(user: UserRecord, input: ApprovalTransitionInput): UserRecord {
  return {
    ...user,
    userType: 'internal_active',
    internalTier: input.internalTier,
    approvedBy: input.approvedBy,
    approvedAt: input.at,
    approvalRef: input.approvalRef,
    sessionVersion: user.sessionVersion + 1,
    updatedAt: input.at,
  };
}

/** 停用/吊销：保留 userType，锁账号 + 递增 sessionVersion。 */
export function applyDisable(user: UserRecord, at: string): UserRecord {
  return {
    ...user,
    accountLocked: true,
    sessionVersion: user.sessionVersion + 1,
    updatedAt: at,
  };
}

/** 改内部数据档：只对 internal_active；递增 sessionVersion 使旧 token 失效。 */
export function applyInternalTierChange(
  user: UserRecord,
  input: { readonly internalTier: InternalTier; readonly at: string },
): UserRecord {
  return {
    ...user,
    internalTier: input.internalTier,
    sessionVersion: user.sessionVersion + 1,
    updatedAt: input.at,
  };
}

/** 审计快照：剔除 `passwordHash`（审计日志不得含凭据材料）。 */
export type UserSnapshot = Omit<UserRecord, 'passwordHash'>;

export function userSnapshot(user: UserRecord): UserSnapshot {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}
