-- =============================================================================
-- 001_audit_entitlement_events.sql
--
-- 归属：A5 backend-compliance（合规域）。schema/DLL 由 A5 署名与维护。
-- 执行：A13 SRE（infra/scripts/db-migrate.sh 自动发现 services/*/migrations/*.sql，
--       单文件单事务执行并写入 meta.schema_migrations 台账）。
-- 依据：H4 2026-11-04 m00076 / m00083 / m00085 / m00087 / m00245 列清单与实现约束；
--        Lead L20（未留痕的 tier 变更按未授权处理，fail-closed）、L24；
--        Lead L49（reason 单列 6 值终局；L38/L47/L48 关于本字段作废）；
--        Lead L53（audit.entitlement_hold.reason -> hold_reason，不留兼容别名；视图同步）；
--        H3 m00064/m00078（条款复核结论落同一 append-only 事件流）；
--        H3 §2.3 留痕保存 ≥3 年、hold_clear 需「工单号 + 签字人 + 依据文件哈希」。
-- 幂等：CREATE ... IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS。
-- 授权：本文件只建对象与内部 REVOKE，不写角色 GRANT（角色由 A13 的
--       infra/db/sql/20_grants.sql 幂等授权、90_verify_privileges.sql 断言）。
-- 禁止：不得在 infra/db/migrations/ 复制本文件——两份文件会被 db-migrate.sh
--       各执行一次，导致触发器重复、哈希链断裂。本文件是唯一真源。
-- PII：不建 subject_ref 等 PII 列（H3 六条件未过，禁止加）。
-- 保留：不分区（P0 事件量低）；occurred_at + authorization_valid_until 快照
--       支撑 ≥3 年保留期审计。清理（≥3 年后）需另行签批的迁移，本版硬拦 DELETE。
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------------------
-- 1. 事件表（append-only；应用角色只有列级 INSERT，无 SELECT/UPDATE/DELETE）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.entitlement_events (
    event_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key                text NOT NULL,
    schema_version           smallint NOT NULL DEFAULT 1,
    event_type               text NOT NULL,
    occurred_at              timestamptz NOT NULL DEFAULT now(),
    boot_id                  uuid,
    deployment_uid           text,
    state_version            integer,
    old_value                jsonb,
    new_value                jsonb,
    reason                   text,
    effective_tier           text,
    configured_tier          text,
    expires_at               timestamptz,
    config_fingerprint       char(64),
    authorization_doc_id     text,
    authorization_doc_sha256 char(64),
    clause_locator           text,
    authorization_valid_until timestamptz,
    approval_ref             text,
    approval_read_at         timestamptz,
    approval_read_by         text,
    executor                 text,
    approver                 text,
    operator                 text,
    trace_id                 text,
    rule_version             text,
    release_id               text,
    manifest_hash            char(64),
    hold_id                  uuid,
    hold_ticket              text,
    hold_signer              text,
    prev_hash                char(64),
    hash                     char(64),

    CONSTRAINT entitlement_events_schema_version_chk
        CHECK (schema_version = 1),
    CONSTRAINT entitlement_events_event_type_chk
        CHECK (event_type IN ('entitlement_expired', 'entitlement_flip',
                              'tier_state_observed', 'unauthorized_config',
                              'deploy', 'tier_switch', 'hold_set', 'hold_clear',
                              'clause_review')),
    -- reason 单列 6 值（Lead L49 终局；L38/L47/L48 关于本字段全部作废）：
    --   env_change / expires_at_passed / expected_fingerprint_mismatch /
    --   manual_signoff / hold_active / clause_change
    -- runtime 403 原因（hold_stale 等）不进审计表，只进日志/指标；未知值 fail-closed 拒绝。
    CONSTRAINT entitlement_events_reason_chk
        CHECK (reason IS NULL OR reason IN ('env_change', 'expires_at_passed',
                                            'expected_fingerprint_mismatch',
                                            'manual_signoff', 'hold_active',
                                            'clause_change')),
    CONSTRAINT entitlement_events_state_version_chk
        CHECK (state_version IS NULL OR state_version >= 0),
    -- approval_ref 不是自由字符串：须可解析到 A15 不可变审批记录。
    CONSTRAINT entitlement_events_approval_ref_shape_chk
        CHECK (approval_ref IS NULL OR approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$'),
    CONSTRAINT entitlement_events_config_fingerprint_chk
        CHECK (config_fingerprint IS NULL OR btrim(config_fingerprint) ~ '^[0-9a-f]{64}$'),
    CONSTRAINT entitlement_events_authorization_doc_sha256_chk
        CHECK (authorization_doc_sha256 IS NULL OR btrim(authorization_doc_sha256) ~ '^[0-9a-f]{64}$'),
    CONSTRAINT entitlement_events_manifest_hash_chk
        CHECK (manifest_hash IS NULL OR btrim(manifest_hash) ~ '^[0-9a-f]{64}$'),
    CONSTRAINT entitlement_events_prev_hash_chk
        CHECK (prev_hash IS NULL OR btrim(prev_hash) ~ '^[0-9a-f]{64}$'),
    CONSTRAINT entitlement_events_hash_chk
        CHECK (hash IS NULL OR btrim(hash) ~ '^[0-9a-f]{64}$'),
    CONSTRAINT entitlement_events_effective_tier_chk
        CHECK (effective_tier IS NULL OR effective_tier ~ '^[a-z][a-z0-9_]{1,31}$'),
    CONSTRAINT entitlement_events_configured_tier_chk
        CHECK (configured_tier IS NULL OR configured_tier ~ '^[a-z][a-z0-9_]{1,31}$'),

    -- 各事件类型的最小留痕完整性（缺字段 = 无法审计 = fail-closed 拒绝）
    CONSTRAINT entitlement_events_require_deploy_chk
        CHECK (event_type <> 'deploy' OR
               (deployment_uid IS NOT NULL AND approval_ref IS NOT NULL
                AND executor IS NOT NULL AND approver IS NOT NULL)),
    CONSTRAINT entitlement_events_require_tier_switch_chk
        CHECK (event_type <> 'tier_switch' OR
               (deployment_uid IS NOT NULL AND approval_ref IS NOT NULL)),
    CONSTRAINT entitlement_events_require_observed_chk
        CHECK (event_type <> 'tier_state_observed' OR
               (boot_id IS NOT NULL AND state_version IS NOT NULL
                AND effective_tier IS NOT NULL)),
    CONSTRAINT entitlement_events_require_flip_chk
        CHECK (event_type <> 'entitlement_flip' OR
               (boot_id IS NOT NULL AND state_version IS NOT NULL)),
    CONSTRAINT entitlement_events_require_unauthorized_chk
        CHECK (event_type <> 'unauthorized_config' OR
               (config_fingerprint IS NOT NULL AND boot_id IS NOT NULL)),
    CONSTRAINT entitlement_events_require_expired_chk
        CHECK (event_type <> 'entitlement_expired' OR
               ((configured_tier IS NOT NULL OR effective_tier IS NOT NULL)
                AND expires_at IS NOT NULL AND reason IS NOT NULL)),
    CONSTRAINT entitlement_events_require_hold_set_chk
        CHECK (event_type <> 'hold_set' OR hold_id IS NOT NULL),
    -- hold_clear 三要素（H3/H4 m00096）：工单号 + 签字人 + 依据文件哈希，缺一不可
    CONSTRAINT entitlement_events_require_hold_clear_chk
        CHECK (event_type <> 'hold_clear' OR
               (hold_id IS NOT NULL AND hold_ticket IS NOT NULL
                AND btrim(hold_ticket) <> ''
                AND hold_signer IS NOT NULL AND btrim(hold_signer) <> ''
                AND authorization_doc_sha256 IS NOT NULL
                AND btrim(authorization_doc_sha256) <> '')),
    -- clause_review（H3 m00064/m00078 + H4 m00245 + Lead L49）：条款复核结论可举证。
    -- reason 仅 clause_change / manual_signoff；必须带 doc sha、条款定位、operator、
    -- new_value={"verdict":"allow|deny|pending",...}、authorization_valid_until（复核认定到期日）。
    CONSTRAINT entitlement_events_clause_review_reason_chk
        CHECK (event_type <> 'clause_review'
               OR reason IN ('clause_change', 'manual_signoff')),
    CONSTRAINT entitlement_events_require_clause_review_chk
        CHECK (event_type <> 'clause_review' OR
               (authorization_doc_sha256 IS NOT NULL
                AND btrim(authorization_doc_sha256) <> ''
                AND clause_locator IS NOT NULL AND btrim(clause_locator) <> ''
                AND operator IS NOT NULL AND btrim(operator) <> ''
                AND authorization_valid_until IS NOT NULL
                AND new_value IS NOT NULL
                AND jsonb_typeof(new_value) = 'object'
                AND new_value ? 'verdict'
                AND new_value ->> 'verdict' IN ('allow', 'deny', 'pending')))
);

-- 升级块（幂等；仅用于已在旧版 001 上建过表的 S0 库重放）：
-- CREATE TABLE IF NOT EXISTS 不会改动既有约束，这里显式按 L49 口径重建。
-- 若旧库中已有 reason 取值不在 6 值内，ADD CONSTRAINT 会失败（fail-closed）——
-- 这是有意的：S0 库请直接重建，生产首次应用即为最终版，后续变更必须新增 002。
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_event_type_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_event_type_chk
    CHECK (event_type IN ('entitlement_expired', 'entitlement_flip',
                          'tier_state_observed', 'unauthorized_config',
                          'deploy', 'tier_switch', 'hold_set', 'hold_clear',
                          'clause_review'));
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_reason_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_reason_chk
    CHECK (reason IS NULL OR reason IN ('env_change', 'expires_at_passed',
                                        'expected_fingerprint_mismatch',
                                        'manual_signoff', 'hold_active',
                                        'clause_change'));
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_clause_review_reason_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_clause_review_reason_chk
    CHECK (event_type <> 'clause_review'
           OR reason IN ('clause_change', 'manual_signoff'));
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_require_clause_review_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_require_clause_review_chk
    CHECK (event_type <> 'clause_review' OR
           (authorization_doc_sha256 IS NOT NULL
            AND btrim(authorization_doc_sha256) <> ''
            AND clause_locator IS NOT NULL AND btrim(clause_locator) <> ''
            AND operator IS NOT NULL AND btrim(operator) <> ''
            AND authorization_valid_until IS NOT NULL
            AND new_value IS NOT NULL
            AND jsonb_typeof(new_value) = 'object'
            AND new_value ? 'verdict'
            AND new_value ->> 'verdict' IN ('allow', 'deny', 'pending')));

-- event_key 幂等键（H4 m00076；禁止用 content hash）：
--   obs|<boot_id> / flip|<boot_id>|<state_version>
--   unauth|<config_fingerprint>|<boot_id>
--   exp|<configured_tier 优先，否则 effective_tier>|<expires_at UTC ISO-8601 毫秒>|<reason>
--   deploy|<deployment_uid> / switch|<deployment_uid>
--   hold|<hold_id>|set / hold|<hold_id>|clear
--   clause|<authorization_doc_sha256>|<clause_locator>|<occurred_at UTC 日期 YYYY-MM-DD>
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_events_event_key_uq
    ON audit.entitlement_events (event_key);

-- 同一审批不得复用/跨环境复用（H3）：全局（不按 env 分组）部分唯一。
-- 前提：approval_ref 指向 A15 全局唯一记录；若 A15 记录 id 按 env 分段，
-- 需 A15 保证 ref 全局唯一，否则本约束无法识别跨环境复用（见交付说明）。
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_events_tier_switch_approval_ref_uq
    ON audit.entitlement_events (approval_ref)
    WHERE event_type = 'tier_switch';

-- 链头读取 / 全链校验 / 保留期审计的主排序
CREATE INDEX IF NOT EXISTS entitlement_events_chain_idx
    ON audit.entitlement_events (occurred_at, event_id);
CREATE INDEX IF NOT EXISTS entitlement_events_type_occurred_idx
    ON audit.entitlement_events (event_type, occurred_at);

-- ---------------------------------------------------------------------------
-- 2. 单行 control 表（H4 m00085：就一张，PK 固定 = 1）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.entitlement_hold (
    id                  smallint PRIMARY KEY DEFAULT 1,
    hold                boolean NOT NULL DEFAULT false,
    hold_id             uuid,
    -- L53：自由文本原因列改名 hold_reason，避免与 events.reason（6 值闭集）混读。
    hold_reason         text,
    set_by              text,
    set_at              timestamptz,
    last_reconciled_at  timestamptz,
    CONSTRAINT entitlement_hold_singleton_chk CHECK (id = 1),
    CONSTRAINT entitlement_hold_active_chk
        CHECK (hold = false OR
               (hold_id IS NOT NULL AND hold_reason IS NOT NULL
                AND set_by IS NOT NULL AND set_at IS NOT NULL))
);

-- seed：hold=false + last_reconciled_at=now()，避免 fail-closed 机制在首次部署
-- 启动时因「超过 15 分钟无对账」立即降级（服务读 last_reconciled_at 判陈旧）。
INSERT INTO audit.entitlement_hold (id, hold, last_reconciled_at)
VALUES (1, false, now())
ON CONFLICT (id) DO NOTHING;

-- 升级块（幂等）：L53 把旧库的 reason 列改名为 hold_reason；不留兼容别名。
-- 先删视图（旧视图依赖 reason 列，否则 RENAME 会报依赖错误），随后重建视图。
DROP VIEW IF EXISTS audit.entitlement_hold_state;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'audit' AND table_name = 'entitlement_hold'
                  AND column_name = 'reason') THEN
        ALTER TABLE audit.entitlement_hold RENAME COLUMN reason TO hold_reason;
    END IF;
END
$$;

-- reconciler / market_app 用只读视图（H4 m00083：reconciler 只授 SELECT 视图）
CREATE OR REPLACE VIEW audit.entitlement_hold_state AS
SELECT id, hold, hold_id, hold_reason, set_by, set_at, last_reconciled_at
  FROM audit.entitlement_hold;

-- ---------------------------------------------------------------------------
-- 3. 规范化 JSON / 时间戳 / event_key / hash（哈希链的唯一定义，外部校验复用）
-- ---------------------------------------------------------------------------
-- 时间戳统一：UTC ISO-8601，固定 6 位微秒 + Z（如 2026-11-04T00:00:00.123456Z）
CREATE OR REPLACE FUNCTION audit.iso_utc(p_ts timestamptz)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE WHEN p_ts IS NULL THEN NULL
                ELSE to_char(p_ts AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           END
$$;

-- canonical JSON：对象键按 Unicode 码点升序（COLLATE "C"）、无空白、UTF-8 原样，
-- 与 A2/JSONL 口径一致（但本表 hash 覆盖的是本表整行，见下方 row 函数）。
CREATE OR REPLACE FUNCTION audit.canonical_json(p_value jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE jsonb_typeof(p_value)
        WHEN 'null'    THEN 'null'
        WHEN 'boolean' THEN p_value::text
        WHEN 'number'  THEN p_value::text
        WHEN 'string'  THEN p_value::text
        WHEN 'array'   THEN '[' || coalesce((
                    SELECT string_agg(audit.canonical_json(e.value), ','
                                      ORDER BY e.ordinality)
                      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, ordinality)
                ), '') || ']'
        WHEN 'object'  THEN '{' || coalesce((
                    SELECT string_agg(to_json(e.key)::text || ':' ||
                                      audit.canonical_json(e.value), ','
                                      ORDER BY e.key COLLATE "C")
                      FROM jsonb_each(p_value) AS e(key, value)
                ), '') || '}'
    END
$$;

-- event_key 由触发器权威计算（应用给的值会被覆盖）：事件类型 → 幂等键
CREATE OR REPLACE FUNCTION audit.entitlement_event_key(e audit.entitlement_events)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    CASE e.event_type
        WHEN 'tier_state_observed' THEN
            IF e.boot_id IS NULL THEN
                RAISE EXCEPTION 'event_key(tier_state_observed) 需要 boot_id';
            END IF;
            RETURN 'obs|' || e.boot_id::text;
        WHEN 'entitlement_flip' THEN
            IF e.boot_id IS NULL OR e.state_version IS NULL THEN
                RAISE EXCEPTION 'event_key(entitlement_flip) 需要 boot_id/state_version';
            END IF;
            RETURN 'flip|' || e.boot_id::text || '|' || e.state_version::text;
        WHEN 'unauthorized_config' THEN
            IF e.config_fingerprint IS NULL OR e.boot_id IS NULL THEN
                RAISE EXCEPTION 'event_key(unauthorized_config) 需要 config_fingerprint/boot_id';
            END IF;
            RETURN 'unauth|' || btrim(e.config_fingerprint) || '|' || e.boot_id::text;
        WHEN 'entitlement_expired' THEN
            IF coalesce(e.configured_tier, e.effective_tier) IS NULL
               OR e.expires_at IS NULL OR e.reason IS NULL THEN
                RAISE EXCEPTION 'event_key(entitlement_expired) 需要 configured_tier/effective_tier、expires_at、reason';
            END IF;
            -- 与 A3 expiredEventKey() 的 JS 口径逐字一致：tier 取 configured_tier 优先，
            -- 时间戳固定毫秒 UTC（JS Date.toISOString()）；避免应用与 DB 派生不同键。
            RETURN 'exp|' || coalesce(e.configured_tier, e.effective_tier) || '|'
                   || to_char(e.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                   || '|' || e.reason;
        WHEN 'deploy' THEN
            IF e.deployment_uid IS NULL THEN
                RAISE EXCEPTION 'event_key(deploy) 需要 deployment_uid';
            END IF;
            RETURN 'deploy|' || e.deployment_uid;
        WHEN 'tier_switch' THEN
            IF e.deployment_uid IS NULL THEN
                RAISE EXCEPTION 'event_key(tier_switch) 需要 deployment_uid';
            END IF;
            RETURN 'switch|' || e.deployment_uid;
        WHEN 'hold_set' THEN
            IF e.hold_id IS NULL THEN
                RAISE EXCEPTION 'event_key(hold_set) 需要 hold_id';
            END IF;
            RETURN 'hold|' || e.hold_id::text || '|set';
        WHEN 'hold_clear' THEN
            IF e.hold_id IS NULL THEN
                RAISE EXCEPTION 'event_key(hold_clear) 需要 hold_id';
            END IF;
            RETURN 'hold|' || e.hold_id::text || '|clear';
        WHEN 'clause_review' THEN
            IF e.authorization_doc_sha256 IS NULL
               OR btrim(e.authorization_doc_sha256) = ''
               OR e.clause_locator IS NULL OR btrim(e.clause_locator) = ''
               OR e.occurred_at IS NULL THEN
                RAISE EXCEPTION 'event_key(clause_review) 需要 authorization_doc_sha256/clause_locator/occurred_at';
            END IF;
            -- 同文档 + 同条款 + 同日重复复核 → 唯一键冲突；写入方 ON CONFLICT DO NOTHING
            RETURN 'clause|' || btrim(e.authorization_doc_sha256) || '|'
                   || e.clause_locator || '|'
                   || to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD');
        ELSE
            RAISE EXCEPTION '未知 event_type：%', e.event_type;
    END CASE;
END
$$;

-- 整行 canonical 文本（hash 覆盖范围 = 除 hash 外的全部列，含 prev_hash）
CREATE OR REPLACE FUNCTION audit.entitlement_event_canonical(e audit.entitlement_events)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT audit.canonical_json(jsonb_build_object(
        'schema_version',            e.schema_version,
        'event_id',                  e.event_id::text,
        'event_key',                 e.event_key,
        'event_type',                e.event_type,
        'occurred_at',               audit.iso_utc(e.occurred_at),
        'boot_id',                   e.boot_id::text,
        'deployment_uid',            e.deployment_uid,
        'state_version',             e.state_version,
        'old_value',                 e.old_value,
        'new_value',                 e.new_value,
        'reason',                    e.reason,
        'effective_tier',            e.effective_tier,
        'configured_tier',           e.configured_tier,
        'expires_at',                audit.iso_utc(e.expires_at),
        'config_fingerprint',        nullif(btrim(e.config_fingerprint), ''),
        'authorization_doc_id',      e.authorization_doc_id,
        'authorization_doc_sha256',  nullif(btrim(e.authorization_doc_sha256), ''),
        'clause_locator',            e.clause_locator,
        'authorization_valid_until', audit.iso_utc(e.authorization_valid_until),
        'approval_ref',              e.approval_ref,
        'approval_read_at',          audit.iso_utc(e.approval_read_at),
        'approval_read_by',          e.approval_read_by,
        'executor',                  e.executor,
        'approver',                  e.approver,
        'operator',                  e.operator,
        'trace_id',                  e.trace_id,
        'rule_version',              e.rule_version,
        'release_id',                e.release_id,
        'manifest_hash',             nullif(btrim(e.manifest_hash), ''),
        'hold_id',                   e.hold_id::text,
        'hold_ticket',               e.hold_ticket,
        'hold_signer',               e.hold_signer,
        'prev_hash',                 nullif(btrim(e.prev_hash), '')
    ))
$$;

-- hash = sha256(UTF-8(canonical 行文本))，64 位小写 hex
CREATE OR REPLACE FUNCTION audit.entitlement_event_hash(e audit.entitlement_events)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT encode(sha256(convert_to(audit.entitlement_event_canonical(e), 'UTF8')), 'hex')
$$;

-- ---------------------------------------------------------------------------
-- 4. 哈希链 BEFORE INSERT 触发器（SECURITY DEFINER + advisory 锁串行化链头）
--    并发写入若不串行化会分叉出两条链（H4 m00083 与 A13 对齐要求）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.entitlement_events_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_prev_hash      text;
    v_last_occurred  timestamptz;
BEGIN
    -- 三个写入者（ci_deploy_writer / market_app / hold 函数）共用同一把事务级锁；
    -- 锁在事务提交时释放，链头读取在锁内完成，保证链不分叉。
    PERFORM pg_advisory_xact_lock(hashtextextended('audit.entitlement_events.chain', 0));

    SELECT btrim(e.hash), e.occurred_at
      INTO v_prev_hash, v_last_occurred
      FROM audit.entitlement_events e
     ORDER BY e.occurred_at DESC, e.event_id DESC
     LIMIT 1;

    IF v_last_occurred IS NOT NULL THEN
        IF v_last_occurred - NEW.occurred_at > interval '1 second' THEN
            RAISE EXCEPTION
                'audit.entitlement_events 拒绝时钟倒退写入：occurred_at % 比链头 % 早超过 1 秒',
                NEW.occurred_at, v_last_occurred;
        END IF;
        -- 同一事务内多次写入共用 now()（事务时间）；为保持链的严格全序，微调
        -- 到「链头 + 1µs」（仅毫秒级以下，不改变业务含义）。回填历史事件必须
        -- 按时间顺序分事务写入。
        IF NEW.occurred_at <= v_last_occurred THEN
            NEW.occurred_at := v_last_occurred + interval '1 microsecond';
        END IF;
    END IF;

    NEW.prev_hash := coalesce(v_prev_hash, repeat('0', 64));
    -- event_key 由触发器权威计算，覆盖应用传入值（同 hash，应用不得自证）
    NEW.event_key := audit.entitlement_event_key(NEW);
    NEW.hash := audit.entitlement_event_hash(NEW);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS entitlement_events_chain_bi ON audit.entitlement_events;
CREATE TRIGGER entitlement_events_chain_bi
    BEFORE INSERT ON audit.entitlement_events
    FOR EACH ROW EXECUTE FUNCTION audit.entitlement_events_before_insert();

-- ---------------------------------------------------------------------------
-- 5. append-only 硬保证：拒绝 UPDATE / DELETE（A11；篡改由 hash 链发现）
--    ≥3 年后的保留期清理需另签批迁移（届时需同时给出链重锚方案）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.entitlement_events_no_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'append-only：audit.entitlement_events 禁止 UPDATE（留痕不可篡改）';
END
$$;

CREATE OR REPLACE FUNCTION audit.entitlement_events_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'append-only：audit.entitlement_events 禁止 DELETE（保留期清理需签批迁移）';
END
$$;

DROP TRIGGER IF EXISTS entitlement_events_no_update_bu ON audit.entitlement_events;
CREATE TRIGGER entitlement_events_no_update_bu
    BEFORE UPDATE ON audit.entitlement_events
    FOR EACH ROW EXECUTE FUNCTION audit.entitlement_events_no_update();

DROP TRIGGER IF EXISTS entitlement_events_no_delete_bd ON audit.entitlement_events;
CREATE TRIGGER entitlement_events_no_delete_bd
    BEFORE DELETE ON audit.entitlement_events
    FOR EACH ROW EXECUTE FUNCTION audit.entitlement_events_no_delete();

-- ---------------------------------------------------------------------------
-- 6. 全链校验（A11 抽样/验收用；空结果 = 链完整）
--    返回每行的问题说明；调用者只需 `SELECT ... FROM audit.verify_entitlement_chain()`。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.verify_entitlement_chain()
RETURNS TABLE (event_id uuid, occurred_at timestamptz, problem text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    WITH ordered AS (
        SELECT e AS row_ref,
               btrim(e.hash) AS hash_hex,
               btrim(e.prev_hash) AS prev_hex,
               lag(btrim(e.hash)) OVER (ORDER BY e.occurred_at, e.event_id) AS expected_prev
          FROM audit.entitlement_events e
    )
    SELECT (o.row_ref).event_id,
           (o.row_ref).occurred_at,
           concat_ws('; ',
               CASE WHEN o.prev_hex IS DISTINCT FROM coalesce(o.expected_prev, repeat('0', 64))
                    THEN format('prev_hash 断链：记录 %s，期望 %s',
                                o.prev_hex,
                                coalesce(o.expected_prev, repeat('0', 64)))
               END,
               CASE WHEN o.hash_hex IS DISTINCT FROM btrim(audit.entitlement_event_hash(o.row_ref))
                    THEN format('hash 不匹配：记录 %s，重算 %s',
                                o.hash_hex,
                                btrim(audit.entitlement_event_hash(o.row_ref)))
               END) AS problem
      FROM ordered o
     WHERE o.prev_hex IS DISTINCT FROM coalesce(o.expected_prev, repeat('0', 64))
        OR o.hash_hex IS DISTINCT FROM btrim(audit.entitlement_event_hash(o.row_ref))
$$;

-- ---------------------------------------------------------------------------
-- 7. hold 控制函数（H4 m00085：reconciler 只读却要置 hold → SECURITY DEFINER）
--    - raise_hold / mark_reconciled：授 reconciler EXECUTE（无表级写权）
--    - clear_hold：只授人工 hold_clear 角色（非 LOGIN；T2 工单 + H5 签字，
--      由 A13 SET ROLE 执行）
--    set_by / executor 记录 session_user（真实登录账号），不记录函数 owner。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.raise_hold(p_reason text, p_hold_ticket text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_hold_id uuid;
    v_row     audit.entitlement_hold;
BEGIN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'raise_hold 拒绝：reason 必填（留痕完整性 fail-closed）';
    END IF;

    SELECT * INTO v_row FROM audit.entitlement_hold WHERE id = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'raise_hold 拒绝：audit.entitlement_hold 单行缺失（迁移未 seed）';
    END IF;
    IF v_row.hold THEN
        -- H4 P0 #2 / m00813：reconciler 每 2min 重跑，已生效时必须 no-op：
        -- 不新增事件（否则 event_key hold|<id>|set 冲突/审计噪声）、不报错刷屏。
        -- 首次 hold 的 reason 保持不变（重复 raise 不覆盖，避免无事件的静默改因）。
        IF v_row.hold_id IS NULL THEN
            RAISE EXCEPTION 'raise_hold 拒绝：control 行 hold=true 但 hold_id 为空（状态损坏，fail-closed）';
        END IF;
        RETURN v_row.hold_id;
    END IF;

    v_hold_id := gen_random_uuid();

    UPDATE audit.entitlement_hold
       SET hold = true,
           hold_id = v_hold_id,
           hold_reason = p_reason,
           set_by = session_user,
           set_at = now()
     WHERE id = 1;

    -- 事件 reason 固定枚举 hold_active；自由文本原因存 control.hold_reason 与 new_value
    INSERT INTO audit.entitlement_events
        (event_type, old_value, new_value, reason, hold_id, hold_ticket,
         executor, occurred_at)
    VALUES
        ('hold_set',
         '{"hold": false}'::jsonb,
         jsonb_build_object('hold', true, 'hold_id', v_hold_id::text, 'reason', p_reason),
         'hold_active', v_hold_id, p_hold_ticket, session_user, now());

    RETURN v_hold_id;
END
$$;

CREATE OR REPLACE FUNCTION audit.clear_hold(p_ticket text, p_signer text, p_doc_sha text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_row audit.entitlement_hold;
BEGIN
    -- H4 m00096：三要素任一为空即拒绝（带空签字不得清 hold）
    IF p_ticket IS NULL OR btrim(p_ticket) = '' THEN
        RAISE EXCEPTION 'clear_hold 拒绝：ticket（H5 工单号）必填';
    END IF;
    IF p_signer IS NULL OR btrim(p_signer) = '' THEN
        RAISE EXCEPTION 'clear_hold 拒绝：signer（H5 签字人）必填';
    END IF;
    IF p_doc_sha IS NULL OR btrim(p_doc_sha) !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'clear_hold 拒绝：doc_sha 必须是 64 位小写 hex（依据文件 sha256）';
    END IF;

    SELECT * INTO v_row FROM audit.entitlement_hold WHERE id = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'clear_hold 拒绝：audit.entitlement_hold 单行缺失（迁移未 seed）';
    END IF;
    IF NOT v_row.hold THEN
        -- H4：无 hold 时 no-op（不写事件、不报错）；三要素仍先校验，空签字永远拒绝。
        RETURN;
    END IF;

    UPDATE audit.entitlement_hold
       SET hold = false,
           set_by = session_user,
           set_at = now()
     WHERE id = 1;

    INSERT INTO audit.entitlement_events
        (event_type, old_value, new_value, reason, hold_id, hold_ticket, hold_signer,
         authorization_doc_sha256, executor, approver, occurred_at)
    VALUES
        ('hold_clear',
         '{"hold": true}'::jsonb,
         '{"hold": false}'::jsonb,
         'manual_signoff',
         v_row.hold_id, btrim(p_ticket), btrim(p_signer),
         p_doc_sha, session_user, btrim(p_signer), now());
END
$$;

CREATE OR REPLACE FUNCTION audit.mark_reconciled(p_at timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_result timestamptz;
BEGIN
    IF p_at IS NULL THEN
        RAISE EXCEPTION 'mark_reconciled 拒绝：时间戳必填';
    END IF;

    UPDATE audit.entitlement_hold
       SET last_reconciled_at = greatest(coalesce(last_reconciled_at, p_at), p_at)
     WHERE id = 1
    RETURNING last_reconciled_at INTO v_result;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'mark_reconciled 拒绝：audit.entitlement_hold 单行缺失（迁移未 seed）';
    END IF;
    RETURN v_result;
END
$$;

-- ---------------------------------------------------------------------------
-- 8. 权限收口：函数默认对 PUBLIC 可执行，这里全部收回；具体角色由 A13 GRANT。
--    列级 INSERT 授权（排除 prev_hash/hash）也在 20_grants.sql，不在本文件。
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
REVOKE ALL ON audit.entitlement_events FROM PUBLIC;
REVOKE ALL ON audit.entitlement_hold FROM PUBLIC;
REVOKE ALL ON audit.entitlement_hold_state FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.iso_utc(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.canonical_json(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.entitlement_event_key(audit.entitlement_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.entitlement_event_canonical(audit.entitlement_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.entitlement_event_hash(audit.entitlement_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.entitlement_events_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.entitlement_events_no_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.entitlement_events_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.verify_entitlement_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.raise_hold(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.clear_hold(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.mark_reconciled(timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 9. 数据字典（迁移/审计/校验口径的说明落库，供 A11/A13 对照）
-- ---------------------------------------------------------------------------
COMMENT ON TABLE audit.entitlement_events IS
    '合规留痕事件（append-only，唯一真源；应用角色仅列级 INSERT，无 SELECT/UPDATE/DELETE）。保留 ≥3 年。';
COMMENT ON COLUMN audit.entitlement_events.event_key IS
    '幂等键，触发器权威计算并覆盖应用值：obs|<boot_id>、flip|<boot_id>|<state_version>、unauth|<fp>|<boot_id>、exp|<tier>|<expires_at UTC 毫秒>|<reason>、deploy|<deployment_uid>、switch|<deployment_uid>、hold|<hold_id>|set|clear、clause|<authorization_doc_sha256>|<clause_locator>|<occurred_at UTC 日期 YYYY-MM-DD>。写入方幂等：捕获 entitlement_events_event_key_uq 的 unique_violation（其他唯一冲突必须失败）；因应用仅列级 INSERT，带目标列的 ON CONFLICT (event_key) 会报 permission denied，可用裸 ON CONFLICT DO NOTHING（仅 A3 四类事件适用）。';
COMMENT ON COLUMN audit.entitlement_events.hash IS
    'sha256(UTF-8(audit.entitlement_event_canonical(整行去 hash)))；canonical = 键按 Unicode 码点升序、无空白；timestamptz 统一 UTC ISO-8601 6 位微秒 + Z；char(64) 去尾随空格；uuid 小写。触发器计算，应用无权写。';
COMMENT ON COLUMN audit.entitlement_events.prev_hash IS
    '前一事件（按 occurred_at,event_id 排序）的 hash；首条为 64 个 0。触发器计算，应用无权写。';
COMMENT ON COLUMN audit.entitlement_events.approval_ref IS
    '提权依据审批引用（deploy/tier_switch 必填）。格式 <env>:<A15 不可变记录 id>，须全局唯一以挡住跨环境复用；A15 记录 id 若按 env 分段需 A15 保证全局唯一。';
COMMENT ON COLUMN audit.entitlement_events.reason IS
    '原因枚举（Lead L49 终局，单列 6 值，未知值 fail-closed 拒绝）：env_change/expires_at_passed/expected_fingerprint_mismatch/manual_signoff/hold_active/clause_change。runtime 403 原因（hold_stale 等）不进本表，只进日志/指标。hold_set 固定 hold_active、hold_clear 固定 manual_signoff（自由文本 hold 原因在 audit.entitlement_hold.hold_reason 与事件 new_value）；clause_review 仅 clause_change/manual_signoff。';
COMMENT ON COLUMN audit.entitlement_events.event_type IS
    '事件类型：entitlement_expired / entitlement_flip / tier_state_observed / unauthorized_config / deploy / tier_switch / hold_set / hold_clear / clause_review。clause_review 由 A13 运维按工单用迁移角色 psql 插入（11-12 不建函数）。';
COMMENT ON FUNCTION audit.verify_entitlement_chain() IS
    '全链校验：返回断链/哈希不匹配的行；空结果 = 链完整。A11 验收调用 SELECT * FROM audit.verify_entitlement_chain()。';
COMMENT ON TABLE audit.entitlement_hold IS
    '单行 hold 控制（id=1）。服务读 last_reconciled_at，超过 15 分钟无对账即 fail-closed。写入只经 SECURITY DEFINER 函数，应用无表级写权。';
COMMENT ON COLUMN audit.entitlement_hold.hold_reason IS
    'hold 的自由文本原因（L53 由 reason 改名；不是事件枚举，勿与 audit.entitlement_events.reason 混读）。置 hold 时由 raise_hold 写入；hold_set 事件里固定记 hold_active。';
COMMENT ON FUNCTION audit.raise_hold(text, text) IS
    '置 hold 并写 hold_set 事件（executor=session_user）；已生效时 no-op 返回现有 hold_id、不写事件、不报错（reconciler 幂等）。授 reconciler EXECUTE。';
COMMENT ON FUNCTION audit.clear_hold(text, text, text) IS
    '清 hold 并写 hold_clear 事件；ticket/signer/doc_sha 三要素非空且 doc_sha 为 64 位小写 hex；当前无 hold 时 no-op（不写事件）。只授人工 hold_clear 角色（非 LOGIN）。';
COMMENT ON FUNCTION audit.mark_reconciled(timestamptz) IS
    '只更新 last_reconciled_at（单调不减），不写事件。授 reconciler EXECUTE。';

