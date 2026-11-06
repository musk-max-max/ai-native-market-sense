/**
 * 审计端口 —— A4 system_prompt 硬规则 3：每个写操作必须落审计
 * （who 含 agent 模型版本 / what / before-after diff / why）。
 *
 * `before` / `after` 是脱敏快照（`userSnapshot`），不得含 `passwordHash`；
 * `reason` 是低基数 reason 码，不写用户原文（ADR-008 D2：pending 不暴露原因，原因只进日志）。
 *
 * 实现选择：P0 先落 `identity.audit_events`（本域迁移，见 migrations/001_identity.sql），
 * 因为 `audit.entitlement_events.event_type` 是 A5 的固定 CHECK 集合，新增
 * `internal_approval` 等事件需 A5 改 DDL（服务端硬边界，A4 不越界改 compliance/）。
 */

export const IDENTITY_AUDIT_EVENT_TYPES = [
  'identity_registration',
  'internal_registration',
  'identity_login',
  'identity_login_denied',
  'internal_approval',
  'internal_rejection',
  'internal_tier_change',
  'account_disabled',
  'approval_denied',
] as const;

export type IdentityAuditEventType = (typeof IDENTITY_AUDIT_EVENT_TYPES)[number];

/**
 * 操作者身份。人类与 agent 是同类 principal，但 agent 必须带独立模型版本：
 * `agent` + 缺 `modelVersion` 的审计记录被视为不合规（服务层入口会拒绝）。
 */
export interface AuditActor {
  readonly kind: 'human' | 'agent' | 'system';
  readonly id: string;
  /** agent 必填：`deepseek-v3.2` 这类模型标识 + 版本。 */
  readonly modelVersion?: string;
}

export interface IdentityAuditEvent {
  readonly eventType: IdentityAuditEventType;
  /** ISO8601（UTC）。 */
  readonly occurredAt: string;
  readonly actor: AuditActor;
  readonly subjectUserId: string | null;
  readonly subjectApplicationId: string | null;
  /** 脱敏前值（jsonb）；注册为 null。 */
  readonly before: unknown;
  readonly after: unknown;
  /** 低基数 reason 码（见 domain/errors.ts 的 IdentityReason）。 */
  readonly reason: string | null;
  readonly approvalRef: string | null;
}

export interface AuditSink {
  record(event: IdentityAuditEvent): Promise<void>;
}
