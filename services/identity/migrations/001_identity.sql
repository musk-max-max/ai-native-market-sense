-- services/identity/migrations/001_identity.sql
--
-- identity 域初始 schema（A4）。依据：docs/adr/ADR-008-user-tiers-and-entitlement.md D1/D2/D9 S1。
--
-- 约定（infra/scripts/db-migrate.sh + infra/ci/check-db-bootstrap.mjs）：
--   * 单文件单事务，幂等（CREATE ... IF NOT EXISTS），禁止 DROP TABLE；
--   * 本文件是 identity schema 的唯一 DDL 真源；
--   * 应用层写入走 `identity.users / identity.internal_applications / identity.audit_events`。
--
-- 不在本迁移范围（边界）：
--   * gate / 服务级 tier / audience：A3（services/market）+ A0 契约；
--   * compliance 的 audit.entitlement_events：A5（新增 internal_approval 等事件类型需 A5 改 CHECK，
--     故本域 P0 使用独立的 identity.audit_events，避免越界改 compliance/）。

CREATE SCHEMA IF NOT EXISTS identity;

-- ---------------------------------------------------------------------------
-- 用户（身份 + 用户侧档位）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.users (
  user_id text PRIMARY KEY,
  -- 规范化（trim+lowercase）后的登录邮箱；应用层负责规范化，DB 侧唯一兜底并发注册。
  email text NOT NULL,
  -- scrypt$N$r$p$saltB64$hashB64；任何日志/审计/响应都不得出现该列。
  password_hash text NOT NULL,
  user_type text NOT NULL,
  -- 仅 internal_active 有效；c_end / internal_pending 为 NULL（ADR-008 D1「不允许绑 c_end_display」）。
  internal_tier text,
  -- 审批人只能是人类席位（agent 机器身份禁止进入审批链）。
  approved_by text,
  approved_at timestamptz,
  -- L51：apr_<uuidv7>，可带 prod:/staging: 前缀；形态由 CHECK 钉住（PG 的 uuid 类型不校验 version/variant）。
  approval_ref text,
  -- 审批 / 改档 / 停用递增；JWT 校验必须与当前值一致（旧 token 失效）。
  session_version integer NOT NULL DEFAULT 0,
  -- 停用：不改 user_type，只锁账号 + 递增 session_version。
  account_locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT ck_users_user_type CHECK (user_type IN ('c_end', 'internal_pending', 'internal_active')),
  CONSTRAINT ck_users_internal_tier CHECK (
    (user_type = 'internal_active' AND internal_tier IN ('internal_eval', 'research_only'))
    OR (user_type <> 'internal_active' AND internal_tier IS NULL)
  ),
  CONSTRAINT ck_users_approved_by CHECK (approved_by IS NULL OR approved_by IN ('H3', 'user')),
  CONSTRAINT ck_users_approval_consistency CHECK (
    (user_type = 'internal_active'
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_ref IS NOT NULL)
    OR (user_type <> 'internal_active'
      AND approved_by IS NULL AND approved_at IS NULL AND approval_ref IS NULL)
  ),
  CONSTRAINT ck_users_approval_ref CHECK (
    approval_ref IS NULL
    OR approval_ref ~ '^(?:(?:prod|staging):)?apr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT ck_users_session_version CHECK (session_version >= 0)
);

-- ---------------------------------------------------------------------------
-- 内部注册申请（审批对象；拒绝不删除，保留审计线索）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.internal_applications (
  application_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity.users (user_id),
  status text NOT NULL DEFAULT 'pending',
  company_email text NOT NULL,
  -- 只存邀请码哈希前缀（不存明文码）。
  invite_code_ref text,
  -- 来源 IP 的带盐 sha256（不落明文 IP）。
  source_ip_hash text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- 申请时拟绑的内部档；最终以 users.internal_tier 为准。
  proposed_internal_tier text,
  decided_at timestamptz,
  decided_by text,
  decision_ref text,
  decision_reason text,

  CONSTRAINT ck_internal_applications_status CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT ck_internal_applications_proposed_tier CHECK (
    proposed_internal_tier IS NULL
    OR proposed_internal_tier IN ('internal_eval', 'research_only')
  ),
  CONSTRAINT ck_internal_applications_decided_by CHECK (decided_by IS NULL OR decided_by IN ('H3', 'user')),
  CONSTRAINT ck_internal_applications_decision CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL AND decision_ref IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT ck_internal_applications_decision_ref CHECK (
    decision_ref IS NULL
    OR decision_ref ~ '^(?:(?:prod|staging):)?apr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

-- 同一用户最多一条 pending 申请（服务层也会查，DB 兜底并发）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_applications_pending
  ON identity.internal_applications (user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_internal_applications_status_requested
  ON identity.internal_applications (status, requested_at);

-- ---------------------------------------------------------------------------
-- 审计（append-only；A4 system_prompt 硬规则 3）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.audit_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  -- agent 必填（who 含模型版本）；human/system 可为空。
  actor_model_version text,
  subject_user_id text REFERENCES identity.users (user_id),
  subject_application_id text REFERENCES identity.internal_applications (application_id),
  before_state jsonb,
  after_state jsonb,
  reason text,
  approval_ref text,

  CONSTRAINT ck_audit_events_event_type CHECK (event_type IN (
    'identity_registration',
    'internal_registration',
    'identity_login',
    'identity_login_denied',
    'internal_approval',
    'internal_rejection',
    'internal_tier_change',
    'account_disabled',
    'approval_denied'
  )),
  CONSTRAINT ck_audit_events_actor_kind CHECK (actor_kind IN ('human', 'agent', 'system')),
  CONSTRAINT ck_audit_events_agent_model CHECK (
    actor_kind <> 'agent' OR (actor_model_version IS NOT NULL AND actor_model_version <> '')
  ),
  CONSTRAINT ck_audit_events_approval_ref CHECK (
    approval_ref IS NULL
    OR approval_ref ~ '^(?:(?:prod|staging):)?apr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

CREATE INDEX IF NOT EXISTS ix_audit_events_user_time
  ON identity.audit_events (subject_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_events_type_time
  ON identity.audit_events (event_type, occurred_at DESC);

COMMENT ON TABLE identity.audit_events IS
  'identity 审计（append-only）。写操作必须带 actor（agent 需 model_version）、before/after 快照、reason；不含 password_hash。';
COMMENT ON COLUMN identity.users.internal_tier IS
  '仅 internal_active：internal_eval（默认）/ research_only（审批显式选择+理由）；禁止 c_end_display。';
COMMENT ON COLUMN identity.users.approval_ref IS
  '审批回指 apr_<uuidv7>（L51：A4 审批 API 建单事务内生成，状态流转不换 id）。';
