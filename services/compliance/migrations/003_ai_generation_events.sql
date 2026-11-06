-- ============================================================================
-- 003_ai_generation_events.sql
-- Owner: A5 backend-compliance（合规域）
-- 执行点: A13 迁移 runner（services/compliance/migrations/ 下的文件，按文件名排序执行）
-- 依赖: 001_audit_entitlement_events.sql（复用 audit.iso_utc / audit.canonical_json
--       与 advisory-lock 链实现口径；003 必须在 001 之后执行）
-- ============================================================================
-- 依据: ADR-007 D3 P8 / L126（H2 会签 ADR-007 第 0 批）：
--   - AI 审计独立于 audit.entitlement_events（001 已签封版被证据引用；量级不同；
--     读主体不同：A16/H3 vs H4/H5）；
--   - append-only + 独立哈希链 + 硬拦 DELETE + 保留 ≥3 年（H3 定留痕期）；
--   - 字段至少：analysis_id / audience / user_id / kind / model_family /
--     prompt_version / policy_version / input_evidence_hash / output_hash /
--     postprocess_actions / blocked_draft / decision / trace_id / occurred_at / prev_hash / hash /
--     schema_version；
--   - A0 复核追加：chat 无 analysis_id，故必填 request_id 作为链/幂等身份；
--     analysis_id 改为仅 analyses 任务可选；user_id 必填（系统触达写 'system'）；
--     content_version 必填（P7 文案版本，由 API 注入方传入；缺失则 P8 失败，
--     fail-closed）；label_version / model_id 可选（model_id 不得含供应商名）。
--   - 新增角色 ai_app 只对本表列级 INSERT，无 UPDATE/DELETE、无业务表权限。
-- ============================================================================
-- 本文件只建 DDL / 触发器 / 校验函数，**不写任何 GRANT/REVOKE 到角色**
-- （grants 归 A13 的 infra/db/sql/20_grants.sql；90_verify_privileges.sql 加断言）。
-- 应用写入列（A13 的 20_grants.sql 已按 L126 落地）：ai_app 对本表**列级 INSERT**
-- （按 information_schema.columns 动态授全列；无表级权限、无 SELECT/UPDATE/DELETE）。
-- event_key/prev_hash/hash 由 BEFORE INSERT 触发器权威计算并**覆盖**应用传入值；
-- event_id 有 uuid 默认值。应用不得依赖自写 hash/prev_hash（触发器会重算）。
-- 校验读（A16/H3）走 audit_reader 或 verify 函数，ai_app 不读审计。
-- ============================================================================
-- 幂等：CREATE TABLE / INDEX 均 IF NOT EXISTS；函数 CREATE OR REPLACE；
-- 触发器先 DROP IF EXISTS 再建。本文件不 DROP TABLE、不改写 001/002。
-- ============================================================================

-- 001 的函数是本文件的前置依赖；缺失时明确 fail-closed，避免半套 schema。
DO $$
BEGIN
    IF to_regprocedure('audit.iso_utc(timestamptz)') IS NULL
       OR to_regprocedure('audit.canonical_json(jsonb)') IS NULL THEN
        RAISE EXCEPTION '003_ai_generation_events.sql 依赖 001 的 audit.iso_utc/audit.canonical_json，请先执行 001';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. AI 生成事件（append-only；每请求一条）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.ai_generation_events (
    event_id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key             text        NOT NULL,
    schema_version        smallint    NOT NULL DEFAULT 1,
    request_id            text        NOT NULL,
    analysis_id           text,
    audience              text        NOT NULL,
    user_id               text        NOT NULL,
    kind                  text        NOT NULL,
    model_family          text        NOT NULL,
    model_id              text,
    prompt_version        text        NOT NULL,
    policy_version        text        NOT NULL,
    content_version       text        NOT NULL,
    label_version         text,
    input_evidence_hash   text        NOT NULL,
    output_hash           text        NOT NULL,
    postprocess_actions   jsonb       NOT NULL,
    blocked_draft         jsonb,
    decision              text        NOT NULL,
    trace_id              text,
    as_of                 timestamptz NOT NULL,
    occurred_at           timestamptz NOT NULL DEFAULT now(),
    prev_hash             text        NOT NULL,
    hash                  text        NOT NULL,

    CONSTRAINT ai_generation_events_schema_version_chk
        CHECK (schema_version >= 1),
    CONSTRAINT ai_generation_events_request_id_chk
        CHECK (btrim(request_id) <> ''),
    CONSTRAINT ai_generation_events_analysis_id_chk
        CHECK (analysis_id IS NULL OR btrim(analysis_id) <> ''),
    CONSTRAINT ai_generation_events_audience_chk
        CHECK (audience IN ('c_end', 'internal')),
    CONSTRAINT ai_generation_events_user_id_chk
        CHECK (btrim(user_id) <> ''),
    CONSTRAINT ai_generation_events_kind_chk
        CHECK (kind IN (
            'stock_interpretation',
            'watchlist_review',
            'post_market_review',
            'lhb_review',
            'capital_features',
            'factor_screen',
            'research_brief',
            'anomaly_alert'
        )),
    CONSTRAINT ai_generation_events_model_family_chk
        CHECK (btrim(model_family) <> ''),
    CONSTRAINT ai_generation_events_model_id_chk
        CHECK (model_id IS NULL OR btrim(model_id) <> ''),
    CONSTRAINT ai_generation_events_prompt_version_chk
        CHECK (btrim(prompt_version) <> ''),
    CONSTRAINT ai_generation_events_policy_version_chk
        CHECK (btrim(policy_version) <> ''),
    CONSTRAINT ai_generation_events_content_version_chk
        CHECK (btrim(content_version) <> ''),
    CONSTRAINT ai_generation_events_label_version_chk
        CHECK (label_version IS NULL OR btrim(label_version) <> ''),
    CONSTRAINT ai_generation_events_input_evidence_hash_chk
        CHECK (input_evidence_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ai_generation_events_output_hash_chk
        CHECK (output_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ai_generation_events_postprocess_actions_chk
        CHECK (jsonb_typeof(postprocess_actions) = 'array'),
    CONSTRAINT ai_generation_events_decision_chk
        CHECK (decision IN ('passed', 'blocked')),
    CONSTRAINT ai_generation_events_trace_id_chk
        CHECK (trace_id IS NULL OR btrim(trace_id) <> ''),
    CONSTRAINT ai_generation_events_prev_hash_chk
        CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ai_generation_events_hash_chk
        CHECK (hash ~ '^[0-9a-f]{64}$')
);

-- 旧版 003 已建表的升级路径（幂等）：补 blocked_draft 列。
ALTER TABLE audit.ai_generation_events
    ADD COLUMN IF NOT EXISTS blocked_draft jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_events_event_key_uq
    ON audit.ai_generation_events (event_key);
CREATE INDEX IF NOT EXISTS ai_generation_events_chain_ord_idx
    ON audit.ai_generation_events (occurred_at, event_id);
CREATE INDEX IF NOT EXISTS ai_generation_events_analysis_id_idx
    ON audit.ai_generation_events (analysis_id)
    WHERE analysis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_generation_events_kind_occurred_idx
    ON audit.ai_generation_events (kind, occurred_at);

-- ---------------------------------------------------------------------------
-- 2. event_key 幂等键（由触发器权威计算；一个 request_id/一次生成只允许一条最终事件）
--    chat 与 analyses 统一用 request_id；analysis_id 仅 analyses 任务可填。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.ai_generation_event_key(e audit.ai_generation_events)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF e.request_id IS NULL OR btrim(e.request_id) = '' THEN
        RAISE EXCEPTION 'event_key(ai_generation) 需要 request_id';
    END IF;
    RETURN 'ai|generation|' || btrim(e.request_id);
END
$$;

-- 整行 canonical 文本（hash 覆盖范围 = 除 hash 外的全部列，含 prev_hash）。
-- 规则与 001 audit.entitlement_event_canonical 一致：JSON 键 COLLATE "C" 排序、
-- 无空白、UTF-8 原样；时间戳 UTC ISO-8601 固定 6 位微秒 + Z。
CREATE OR REPLACE FUNCTION audit.ai_generation_event_canonical(e audit.ai_generation_events)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT audit.canonical_json(jsonb_build_object(
        'schema_version',        e.schema_version,
        'event_id',              e.event_id::text,
        'event_key',             e.event_key,
        'request_id',            e.request_id,
        'analysis_id',           e.analysis_id,
        'audience',              e.audience,
        'user_id',               e.user_id,
        'kind',                  e.kind,
        'model_family',          e.model_family,
        'model_id',              e.model_id,
        'prompt_version',        e.prompt_version,
        'policy_version',        e.policy_version,
        'content_version',       e.content_version,
        'label_version',         e.label_version,
        'input_evidence_hash',   e.input_evidence_hash,
        'output_hash',           e.output_hash,
        'postprocess_actions',   e.postprocess_actions,
        'blocked_draft',         e.blocked_draft,
        'decision',              e.decision,
        'trace_id',              e.trace_id,
        'as_of',                 audit.iso_utc(e.as_of),
        'occurred_at',           audit.iso_utc(e.occurred_at),
        'prev_hash',             btrim(e.prev_hash)
    ))
$$;

CREATE OR REPLACE FUNCTION audit.ai_generation_event_hash(e audit.ai_generation_events)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT encode(sha256(convert_to(audit.ai_generation_event_canonical(e), 'UTF8')), 'hex')
$$;

-- ---------------------------------------------------------------------------
-- 3. 哈希链 BEFORE INSERT 触发器（SECURITY DEFINER + advisory 锁串行化链头）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.ai_generation_events_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_prev_hash     text;
    v_last_occurred timestamptz;
BEGIN
    -- 并发写入串行化：锁在事务提交时释放，链头读取在锁内完成，保证链不分叉。
    PERFORM pg_advisory_xact_lock(hashtextextended('audit.ai_generation_events.chain', 0));

    SELECT btrim(e.hash), e.occurred_at
      INTO v_prev_hash, v_last_occurred
      FROM audit.ai_generation_events e
     ORDER BY e.occurred_at DESC, e.event_id DESC
     LIMIT 1;

    IF v_last_occurred IS NOT NULL THEN
        IF v_last_occurred - NEW.occurred_at > interval '1 second' THEN
            RAISE EXCEPTION
                'audit.ai_generation_events 拒绝时钟倒退写入：occurred_at % 比链头 % 早超过 1 秒',
                NEW.occurred_at, v_last_occurred;
        END IF;
        -- 同一事务内多次写入共用 now()；微调为链头 + 1µs 保持严格全序（同 001）。
        IF NEW.occurred_at <= v_last_occurred THEN
            NEW.occurred_at := v_last_occurred + interval '1 microsecond';
        END IF;
    END IF;

    NEW.prev_hash := coalesce(v_prev_hash, repeat('0', 64));
    NEW.event_key := audit.ai_generation_event_key(NEW);
    NEW.hash := audit.ai_generation_event_hash(NEW);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ai_generation_events_chain_bi ON audit.ai_generation_events;
CREATE TRIGGER ai_generation_events_chain_bi
    BEFORE INSERT ON audit.ai_generation_events
    FOR EACH ROW EXECUTE FUNCTION audit.ai_generation_events_before_insert();

-- ---------------------------------------------------------------------------
-- 4. append-only 硬保证：拒绝 UPDATE / DELETE
--    保留期（≥3 年，H3）到期清理需另签批迁移并同时给出链重锚方案；
--    在此之前任何 DELETE 都是篡改（哈希链会报断链）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.ai_generation_events_no_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'append-only：audit.ai_generation_events 禁止 UPDATE（留痕不可篡改）';
END
$$;

CREATE OR REPLACE FUNCTION audit.ai_generation_events_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'append-only：audit.ai_generation_events 禁止 DELETE（保留期清理需签批迁移 + 链重锚）';
END
$$;

DROP TRIGGER IF EXISTS ai_generation_events_no_update_bu ON audit.ai_generation_events;
CREATE TRIGGER ai_generation_events_no_update_bu
    BEFORE UPDATE ON audit.ai_generation_events
    FOR EACH ROW EXECUTE FUNCTION audit.ai_generation_events_no_update();

DROP TRIGGER IF EXISTS ai_generation_events_no_delete_bd ON audit.ai_generation_events;
CREATE TRIGGER ai_generation_events_no_delete_bd
    BEFORE DELETE ON audit.ai_generation_events
    FOR EACH ROW EXECUTE FUNCTION audit.ai_generation_events_no_delete();

-- ---------------------------------------------------------------------------
-- 5. 全链校验（A16 离线复核 / 90_verify 用；空结果 = 链完整）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.verify_ai_generation_chain()
RETURNS TABLE (event_id uuid, occurred_at timestamptz, problem text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    WITH ordered AS (
        SELECT e AS row_ref,
               btrim(e.hash) AS hash_hex,
               btrim(e.prev_hash) AS prev_hex,
               lag(btrim(e.hash)) OVER (ORDER BY e.occurred_at, e.event_id) AS expected_prev
          FROM audit.ai_generation_events e
    )
    SELECT (o.row_ref).event_id,
           (o.row_ref).occurred_at,
           concat_ws('; ',
               CASE WHEN o.prev_hex IS DISTINCT FROM coalesce(o.expected_prev, repeat('0', 64))
                    THEN format('prev_hash 断链：记录 %s，期望 %s',
                                o.prev_hex,
                                coalesce(o.expected_prev, repeat('0', 64)))
               END,
               CASE WHEN o.hash_hex IS DISTINCT FROM btrim(audit.ai_generation_event_hash(o.row_ref))
                    THEN format('hash 不匹配：记录 %s，重算 %s',
                                o.hash_hex,
                                btrim(audit.ai_generation_event_hash(o.row_ref)))
               END) AS problem
      FROM ordered o
     WHERE o.prev_hex IS DISTINCT FROM coalesce(o.expected_prev, repeat('0', 64))
        OR o.hash_hex IS DISTINCT FROM btrim(audit.ai_generation_event_hash(o.row_ref))
$$;

-- ---------------------------------------------------------------------------
-- 6. postprocess_actions 结构校验（H3 m01300：A16 复核改写是否制造新表述）
--    每个 item 必须含 stage/action/matched；block/redact 必须带 original_text 或
--    original_hash；redact 还必须带 rewritten_text 或 rewritten_hash。
--    用 JSONPath 内联校验（无函数）：CHECK 里的函数需要调用方 EXECUTE，
--    而 ai_app 只被授予列级 INSERT（A13 verify 断言 ai_app 零函数 EXECUTE）。
-- ---------------------------------------------------------------------------
ALTER TABLE audit.ai_generation_events
    DROP CONSTRAINT IF EXISTS ai_generation_events_blocked_draft_chk;
ALTER TABLE audit.ai_generation_events
    ADD CONSTRAINT ai_generation_events_blocked_draft_chk
    CHECK (
        (decision = 'passed' AND blocked_draft IS NULL)
        OR (decision = 'blocked' AND blocked_draft IS NOT NULL)
    );

ALTER TABLE audit.ai_generation_events
    DROP CONSTRAINT IF EXISTS ai_generation_events_postprocess_actions_shape_chk;
ALTER TABLE audit.ai_generation_events
    ADD CONSTRAINT ai_generation_events_postprocess_actions_shape_chk
    CHECK (
        jsonb_typeof(postprocess_actions) = 'array'
        AND NOT jsonb_path_exists(
            postprocess_actions,
            '$[*] ? (@.type() != "object"
                || !(@.stage == "P2" || @.stage == "P3" || @.stage == "P4" || @.stage == "P5" || @.stage == "P6")
                || !(@.action == "allow" || @.action == "block" || @.action == "redact" || @.action == "caveat")
                || !(@.matched != null && @.matched != "")
                || ((@.action == "block" || @.action == "redact") && !(@.original_text != null || @.original_hash != null))
                || (@.action == "redact" && !(@.rewritten_text != null || @.rewritten_hash != null)))'::jsonpath
        )
    );

-- ---------------------------------------------------------------------------
-- 7. 默认权限收回（角色级 GRANT 归 A13；这里只清 PUBLIC）
-- ---------------------------------------------------------------------------
REVOKE ALL ON audit.ai_generation_events FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ai_generation_event_key(audit.ai_generation_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ai_generation_event_canonical(audit.ai_generation_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ai_generation_event_hash(audit.ai_generation_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ai_generation_events_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ai_generation_events_no_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ai_generation_events_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.verify_ai_generation_chain() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 8. 数据字典
-- ---------------------------------------------------------------------------
COMMENT ON TABLE audit.ai_generation_events IS
    'AI 生成审计事件（ADR-007 P8 / L126；A5 DDL，A13 grants）：每请求一条，append-only，独立哈希链，保留 ≥3 年。不复用 audit.entitlement_events（001 已签封版；读主体/量级不同）。';
COMMENT ON COLUMN audit.ai_generation_events.event_id IS '内部行 id（uuid；哈希链排序键之一）';
COMMENT ON COLUMN audit.ai_generation_events.event_key IS '幂等键 ai|generation|<request_id>，由 BEFORE INSERT 触发器权威计算';
COMMENT ON COLUMN audit.ai_generation_events.schema_version IS '本表 schema 版本，当前 1';
COMMENT ON COLUMN audit.ai_generation_events.analysis_id IS 'AI 分析任务 id（contracts/ai；可空；不承担幂等，幂等身份是 request_id）';
COMMENT ON COLUMN audit.ai_generation_events.audience IS 'c_end | internal（两 audience 均受 L3 硬禁止约束）';
COMMENT ON COLUMN audit.ai_generation_events.user_id IS 'HMAC(subject_ref) 受控标识（禁明文手机号/openid；系统触达记 system）';
COMMENT ON COLUMN audit.ai_generation_events.kind IS 'AI 能力类型（8 类封闭枚举，见 CHECK）';
COMMENT ON COLUMN audit.ai_generation_events.model_family IS '模型家族（只到家族，不出现供应商名；ADR-007 D2）';
COMMENT ON COLUMN audit.ai_generation_events.prompt_version IS 'prompt 版本（A3/A0 维护）';
COMMENT ON COLUMN audit.ai_generation_events.policy_version IS 'AI 内容策略版本（rules/ai-content-policy.json 的 policy_version，H3 签字）';
COMMENT ON COLUMN audit.ai_generation_events.input_evidence_hash IS '输入证据集合 sha256（64 位小写 hex）';
COMMENT ON COLUMN audit.ai_generation_events.output_hash IS '模型最终输出 sha256（原始模型输出不得透传，仅留 hash）';
COMMENT ON COLUMN audit.ai_generation_events.postprocess_actions IS 'P2–P6 过滤/改写动作列表（jsonb array，无默认值；item 必含 stage/action/matched，block/redact 带 original_text|original_hash，redact 另带 rewritten_text|rewritten_hash；供 A16 复核）';
COMMENT ON COLUMN audit.ai_generation_events.blocked_draft IS 'P5 阻断时的完整 draft（受限存储，按 analysis_id/request_id 关联；仅审计/复核角色可读，不得进 C 端/SSE/日志；≥3 年）。decision=blocked 必填，passed 必须为 NULL；A3 P8 写入，输出 hash 与 P5 原文 hash 必须指向同一份 draft。';
COMMENT ON COLUMN audit.ai_generation_events.decision IS 'passed | blocked（与 contracts/ai 结果 schema 的 compliance.decision 一致）';
COMMENT ON COLUMN audit.ai_generation_events.trace_id IS '端到端 trace id（与 API/网关日志关联）';
COMMENT ON COLUMN audit.ai_generation_events.as_of IS '本次生成所用数据的业务时点（数据 as-of；A16/AI-2 复核用）';
COMMENT ON COLUMN audit.ai_generation_events.occurred_at IS '事件发生时刻（UTC；链按 occurred_at,event_id 排序）';
COMMENT ON COLUMN audit.ai_generation_events.prev_hash IS '前一条事件 hash（首条 64 个 0），由触发器计算';
COMMENT ON COLUMN audit.ai_generation_events.hash IS 'sha256(整行 canonical 去 hash；含 prev_hash)，由触发器计算';
COMMENT ON FUNCTION audit.ai_generation_event_key(audit.ai_generation_events) IS
    'AI 事件幂等键：ai|generation|<request_id>（触发器权威覆盖应用传入值）';
COMMENT ON FUNCTION audit.verify_ai_generation_chain() IS
    '校验 AI 事件哈希链完整性；空结果=完整（A16 离线复核/90_verify 断言使用）';
