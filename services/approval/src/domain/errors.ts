/**
 * 域错误：status + 低基数 reason（reason 不出 wire，仅审计/日志）。
 * 409/412 的扩展字段（diff / approval_ref / current_status）随错误携带，由插件按
 * CONTRACT-REVIEW-2026-11-06-config-approval.md M1 矩阵直发契约问题体。
 */

export type ApprovalReason =
  | 'not_found'
  | 'validation_failed'
  | 'environment_mismatch'
  | 'invalid_system_field'
  | 'policy_version_mismatch'
  | 'idempotency_key_mismatch'
  | 'idempotency_key_required'
  | 'version_conflict'
  | 'precondition_failed'
  | 'approval_state_conflict'
  | 'approval_ref_unresolvable'
  | 'approval_ref_reuse'
  | 'approver_not_human'
  | 'self_approval'
  | 'already_decided'
  | 'config_not_draft'
  /** 账本 hash 链校验失败（断链）：停用该单 + 上报，fail-closed 出 500。 */
  | 'ledger_integrity_failure';

export interface ConflictExtras {
  /** 409 ConfigConflictProblem 的三点 diff（PUT If-Match 不符）。 */
  readonly diff?: unknown;
  readonly approvalRef?: string;
  /** 409 ApprovalConflictProblem 的当前状态。 */
  readonly currentStatus?: string;
}

export class DomainError extends Error {
  readonly status: number;
  readonly reason: ApprovalReason;
  readonly extras: ConflictExtras;
  /** 400 校验失败时的 errors[]（path/code），进 Problem.detail 供表单定位。 */
  readonly issues?: unknown;

  constructor(status: number, reason: ApprovalReason, extras: ConflictExtras = {}, issues?: unknown) {
    super(`${status} ${reason}`);
    this.name = 'DomainError';
    this.status = status;
    this.reason = reason;
    this.extras = extras;
    this.issues = issues;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
