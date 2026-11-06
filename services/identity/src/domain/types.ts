/**
 * identity 域数据模型（A4）。
 *
 * 依据：`docs/adr/ADR-008-user-tiers-and-entitlement.md` D1（角色模型）/ D2（注册、登录、审批流）。
 * 边界：本域只管「用户是谁、能不能登录、能拿什么用户档位」；gate 判定在 A3（services/market）。
 * 注意：`user_type` 是终局三值，不再加第四种 `suspended`——停用由 `accountLocked` +
 * `sessionVersion` 表达（ADR-008 D1：「不改变 user_type，但登录拒绝且旧 token 失效」）。
 */

export const USER_TYPES = ['c_end', 'internal_pending', 'internal_active'] as const;
export type UserType = (typeof USER_TYPES)[number];

/** 内部数据档：只对 `internal_active` 有效；`c_end_display` 是 C 端发布授权，不允许绑到这里。 */
export const INTERNAL_TIERS = ['internal_eval', 'research_only'] as const;
export type InternalTier = (typeof INTERNAL_TIERS)[number];

/** JWT `tier` claim 的取值：C 端 → `c_end_display`；内部 → `internal_eval | research_only`。 */
export const USER_TIERS = ['c_end_display', 'internal_eval', 'research_only'] as const;
export type UserTier = (typeof USER_TIERS)[number];

/**
 * 审批人只允许人类席位（README「agent 不能批准 agent」；ADR-008 D2）。
 * `H3` = 合规负责人席位，`user` = 平台所有者。agent 的机器身份即使有权限也不能出现在这里。
 */
export const HUMAN_APPROVERS = ['H3', 'user'] as const;
export type ApproverId = (typeof HUMAN_APPROVERS)[number];

/**
 * 账号管理（停用/吊销）的人类席位：H3 合规、H5 安全运维、user 平台所有者。
 * ADR-008 D1 只规定了停用状态，未指定执行人；按 agents/README.md §3「权限授予/认证类需 H5」，
 * H5 必须在内。agent 一律不得停用账号（含机器身份自我停用）。
 */
export const ACCOUNT_ADMINISTRATORS = ['H3', 'H5', 'user'] as const;
export type AccountAdministratorId = (typeof ACCOUNT_ADMINISTRATORS)[number];

export function isApproverId(value: string): value is ApproverId {
  return (HUMAN_APPROVERS as readonly string[]).includes(value);
}

export function isAccountAdministratorId(value: string): value is AccountAdministratorId {
  return (ACCOUNT_ADMINISTRATORS as readonly string[]).includes(value);
}

export const APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** 允许签发 token 的 user_type（`internal_pending` 恒不签，ADR-008 D2「登录 2.」）。 */
export type SignedInUserType = Extract<UserType, 'c_end' | 'internal_active'>;

/** 用户表一行（身份 + 授权档位），不对应任何 C 端公开字段。 */
export interface UserRecord {
  readonly userId: string;
  /** 规范化（trim + 小写）后的登录邮箱；唯一。 */
  readonly email: string;
  /** `scrypt$N$r$p$saltB64$hashB64`；永不进日志/审计快照。 */
  readonly passwordHash: string;
  readonly userType: UserType;
  /** 仅 `internal_active` 有效；其余为 null。 */
  readonly internalTier: InternalTier | null;
  readonly approvedBy: ApproverId | null;
  /** ISO8601（UTC）。 */
  readonly approvedAt: string | null;
  /** 审批回指（L51：`apr_<uuidv7>`，可带 `prod:`/`staging:` 前缀）。 */
  readonly approvalRef: string | null;
  /** 审批 / 改档 / 停用时递增；JWT 校验必须与当前值一致（ADR-008 D1 硬规则 4）。 */
  readonly sessionVersion: number;
  /** 停用/吊销；不改 user_type。 */
  readonly accountLocked: boolean;
  /** ISO8601（UTC）。 */
  readonly createdAt: string;
  /** ISO8601（UTC）。 */
  readonly updatedAt: string;
}

/** 内部注册申请（审批对象）。拒绝不删除记录（ADR-008 D2「审批」）。 */
export interface InternalApplication {
  readonly applicationId: string;
  readonly userId: string;
  readonly status: ApplicationStatus;
  /** 申请时填写的企业邮箱（可能与登录邮箱不同域，审批 UI 依赖它）。 */
  readonly companyEmail: string;
  /** 命中的邀请码引用（不解密邀请码本身，只留引用/哈希前缀）。 */
  readonly inviteCodeRef: string | null;
  /** 来源 IP 的带盐哈希（ADR-008 D2 注册：不落明文 IP）。 */
  readonly sourceIpHash: string | null;
  readonly requestedAt: string;
  /** 申请时拟绑的内部档（审批人可改；最终以用户记录为准）。 */
  readonly proposedInternalTier: InternalTier | null;
  readonly decidedAt: string | null;
  readonly decidedBy: ApproverId | null;
  readonly decisionRef: string | null;
  readonly decisionReason: string | null;
}
