-- services/approval/migrations/001_approval.sql
-- 本文件是 approval schema 的唯一 DDL 真源（对齐 services/identity/migrations/001_identity.sql 先例）。
-- 约定（infra/scripts/db-migrate.sh）：单文件单事务；幂等（CREATE ... IF NOT EXISTS / ON CONFLICT DO NOTHING）；
-- 禁止 DROP TABLE；已执行的迁移文件永不修改（篡改即部署失败），只新增。
-- A4 = 审批账本（/v1/internal/approvals）+ 运营配置（/v1/internal/configs|releases）。
-- 审计独立表 approval.audit_events（复用 identity.audit_events 的 AuditActor 语义，不动其 9 类 CHECK）。

BEGIN;

CREATE SCHEMA IF NOT EXISTS approval;

-- ---------------------------------------------------------------------------
-- 审批单（账本折叠投影：current status = 事件 fold 的投影，不是权威真源）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval.applications (
    approval_ref       text PRIMARY KEY,
    application_id     text NOT NULL UNIQUE,
    flow               text NOT NULL,
    status             text NOT NULL,
    applicant          jsonb NOT NULL,
    beneficiary        jsonb,
    executor           jsonb,
    subject            jsonb NOT NULL,
    change             jsonb NOT NULL,
    evidence           jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_applications_approval_ref CHECK (
        approval_ref ~ '^apr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT ck_applications_flow CHECK (flow IN ('t1','t2','t3','t4','t5','t6','t7')),
    CONSTRAINT ck_applications_status CHECK (
        status IN ('submitted','evaluated','routed','auto_passed','approved','rejected','expired')
    ),
    CONSTRAINT ck_applications_applicant_kind CHECK (
        applicant ->> 'kind' IN ('human','agent')
    ),
    CONSTRAINT ck_applications_applicant_model CHECK (
        applicant ->> 'kind' <> 'agent' OR length(applicant ->> 'model_version') > 0
    )
);

CREATE INDEX IF NOT EXISTS ix_applications_created ON approval.applications (created_at DESC, approval_ref DESC);
CREATE INDEX IF NOT EXISTS ix_applications_status_created ON approval.applications (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 审批账本（append-only + hash 链；UPDATE/DELETE 由触发器拒绝）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval.events (
    event_id        text PRIMARY KEY,
    approval_ref    text NOT NULL REFERENCES approval.applications (approval_ref),
    seq             integer NOT NULL,
    type            text NOT NULL,
    at              timestamptz NOT NULL,
    actor           jsonb,
    evaluation      jsonb,
    decision        jsonb,
    note            text,
    prev_event_hash text NOT NULL,
    event_hash      text NOT NULL,
    CONSTRAINT uq_events_ref_seq UNIQUE (approval_ref, seq),
    CONSTRAINT ck_events_type CHECK (
        type IN ('created','evaluated','routed','auto_passed','approved','rejected','expired')
    ),
    CONSTRAINT ck_events_seq CHECK (seq >= 1),
    CONSTRAINT ck_events_actor_model CHECK (
        actor IS NULL OR actor ->> 'kind' <> 'agent' OR length(actor ->> 'model_version') > 0
    )
);

CREATE INDEX IF NOT EXISTS ix_events_ref_seq ON approval.events (approval_ref, seq);

CREATE OR REPLACE FUNCTION approval.forbid_event_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'approval.events is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_append_only ON approval.events;
CREATE TRIGGER trg_events_append_only
    BEFORE UPDATE OR DELETE ON approval.events
    FOR EACH ROW EXECUTE FUNCTION approval.forbid_event_mutation();

-- ---------------------------------------------------------------------------
-- Idempotency-Key（createApproval / decideApproval）：同 key 同请求重放同一响应，不重复建单
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval.idempotency (
    scope           text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash    text NOT NULL,
    approval_ref    text,
    response        jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- 运营配置（当前文档 + 版本快照）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval.ops_configs (
    config_id      text NOT NULL,
    environment    text NOT NULL,
    version        integer NOT NULL,
    status         text NOT NULL,
    schema_version text NOT NULL,
    change_reason  text NOT NULL,
    impact_scope   jsonb NOT NULL,
    spec           jsonb NOT NULL,
    created_by     jsonb,
    updated_by     jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (config_id, environment),
    CONSTRAINT ck_ops_configs_config_id CHECK (config_id ~ '^ops_[a-z0-9_]{3,48}$'),
    CONSTRAINT ck_ops_configs_environment CHECK (environment IN ('dev','staging','prod')),
    CONSTRAINT ck_ops_configs_status CHECK (status IN ('draft','published')),
    CONSTRAINT ck_ops_configs_version CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS approval.ops_config_versions (
    config_id     text NOT NULL,
    environment   text NOT NULL,
    version       integer NOT NULL,
    spec          jsonb NOT NULL,
    change_reason text NOT NULL,
    impact_scope  jsonb NOT NULL,
    saved_at      timestamptz NOT NULL DEFAULT now(),
    saved_by      jsonb,
    PRIMARY KEY (config_id, environment, version)
);

-- ---------------------------------------------------------------------------
-- 发布（不可变；is_current 为当前 release 指针，回滚只切指针不改历史）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval.ops_releases (
    release_id          text PRIMARY KEY,
    config_id           text NOT NULL,
    environment         text NOT NULL,
    version             integer NOT NULL,
    schema_version      text NOT NULL,
    policy_version      text NOT NULL,
    content_hash        text NOT NULL,
    published_at        timestamptz NOT NULL DEFAULT now(),
    approval_ref        text NOT NULL,
    canary_percent      integer NOT NULL,
    release_notes       text,
    previous_release_id text,
    is_current          boolean NOT NULL DEFAULT false,
    CONSTRAINT ck_ops_releases_release_id CHECK (release_id ~ '^rel_[0-9a-z-]{8,40}$'),
    CONSTRAINT ck_ops_releases_canary CHECK (canary_percent BETWEEN 1 AND 10),
    CONSTRAINT ck_ops_releases_env CHECK (environment IN ('dev','staging','prod'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_releases_current
    ON approval.ops_releases (config_id, environment) WHERE is_current;
CREATE INDEX IF NOT EXISTS ix_ops_releases_published
    ON approval.ops_releases (environment, published_at DESC, release_id DESC);

-- 发布/回滚绑定：一个 approval_ref 恰好消费一次（防复用；rollback 不得复用发布 ref）
CREATE TABLE IF NOT EXISTS approval.release_bindings (
    approval_ref   text PRIMARY KEY,
    purpose        text NOT NULL,
    config_id      text NOT NULL,
    environment    text NOT NULL,
    version        integer,
    policy_version text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    consumed_at    timestamptz,
    CONSTRAINT ck_release_bindings_purpose CHECK (purpose IN ('config_publish','config_rollback'))
);

-- ---------------------------------------------------------------------------
-- 域内审计（who 人或 agent id+模型版本 / what / before→after / why；append-only）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval.audit_events (
    event_id             text PRIMARY KEY,
    event_type           text NOT NULL,
    occurred_at          timestamptz NOT NULL,
    actor_kind           text NOT NULL,
    actor_id             text NOT NULL,
    actor_model_version  text,
    subject_kind         text,
    subject_id           text,
    before_state         jsonb,
    after_state          jsonb,
    reason               text,
    approval_ref         text,
    CONSTRAINT ck_audit_events_event_type CHECK (
        event_type IN ('approval_created','approval_evaluated','approval_decided',
                       'config_drafted','config_submitted','config_published','config_rolled_back')
    ),
    CONSTRAINT ck_audit_events_actor_kind CHECK (actor_kind IN ('human','agent','system')),
    CONSTRAINT ck_audit_events_agent_model CHECK (
        actor_kind <> 'agent' OR length(actor_model_version) > 0
    ),
    CONSTRAINT ck_audit_events_approval_ref CHECK (
        approval_ref IS NULL OR approval_ref ~ '^apr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
);

CREATE INDEX IF NOT EXISTS ix_audit_events_type_time ON approval.audit_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_events_subject ON approval.audit_events (subject_kind, subject_id, occurred_at DESC);

-- A14 registry seed：ops-config 契约主键的 canonical config_id（A4 服务端真源）。
-- 仅预置空 spec 草稿；后续变更走 API（saveDraft→validate→submit→publish），此处不再追加业务数据。
INSERT INTO approval.ops_configs
    (config_id, environment, version, status, schema_version, change_reason, impact_scope, spec, created_by, updated_by)
VALUES
    ('ops_home_feed', 'dev', 1, 'draft', '0.1', 'initial registry seed', '["column_layout"]'::jsonb,
     '{"columns":[],"content_items":[],"strategies":[]}'::jsonb,
     '{"kind":"system","id":"registry-seed"}'::jsonb, '{"kind":"system","id":"registry-seed"}'::jsonb),
    ('ops_home_banner', 'dev', 1, 'draft', '0.1', 'initial registry seed', '["content_placement"]'::jsonb,
     '{"columns":[],"content_items":[],"strategies":[]}'::jsonb,
     '{"kind":"system","id":"registry-seed"}'::jsonb, '{"kind":"system","id":"registry-seed"}'::jsonb)
ON CONFLICT (config_id, environment) DO NOTHING;

INSERT INTO approval.ops_config_versions
    (config_id, environment, version, spec, change_reason, impact_scope, saved_by)
VALUES
    ('ops_home_feed', 'dev', 1, '{"columns":[],"content_items":[],"strategies":[]}'::jsonb,
     'initial registry seed', '["column_layout"]'::jsonb, '{"kind":"system","id":"registry-seed"}'::jsonb),
    ('ops_home_banner', 'dev', 1, '{"columns":[],"content_items":[],"strategies":[]}'::jsonb,
     'initial registry seed', '["content_placement"]'::jsonb, '{"kind":"system","id":"registry-seed"}'::jsonb)
ON CONFLICT (config_id, environment, version) DO NOTHING;

COMMIT;
