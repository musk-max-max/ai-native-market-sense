-- =============================================================================
-- 002_audit_gap.sql
--
-- 归属：A5 backend-compliance（合规域）。schema/DDL 由 A5 署名与维护。
-- 执行：A13 SRE（infra/scripts/db-migrate.sh 单文件单事务执行并写入
--       meta.schema_migrations 台账）。**001 一个字不动**（Lead L62）：001 的 sha
--       c8116e4f… 已被 A11/A3/H4 的证据链引用，本迁移只做 additive 扩展。
--
-- 依据：
--   - Lead L62（新增 002、001 不改；断口可见，不做补记重放）；
--   - H4 m00540 / m00567（H5 第 2/4 条）：recorded_at、audit_gap 第 10 类、
--     schema_version 1/2 共存、锚定 deployment_uid 的 gap 幂等键；
--   - H5 要求：写审计失败恢复后必须留下「断口」事件，不能靠补记假装没断过。
--
-- 本迁移做什么（全部 additive）：
--   1. audit.entitlement_events 增加 recorded_at（DB 写入时间；触发器强制 now()，
--      调用方不可指定、不可 UPDATE，也不在列级 INSERT 授权里）；
--   2. event_type 增加第 10 类 audit_gap，并加其最小留痕完整性 CHECK；
--   3. schema_version CHECK 由 =1 放宽为 IN (1,2)：历史行保留 1，A3 新写事件
--      与 seed 均写 2（Lead L64：默认值应等于当前正确值）；
--   4. 触发器 event_key 增加 audit_gap 分支：gap|<deployment_uid>|<gap_from ISO>；
--   5. 检测侧 fail-open 的结构约束（H5-R14 / L67 / L68）：
--      - deploy 事件 new_value.target_tier 必填且限于 DataTier 枚举：reconciler 只在
--        target_tier != internal_eval 且缺 tier_switch 时才判 gap，缺它会把首次
--        internal_eval 部署误报成断口（H4 m00579）；
--      - tier_switch 必带 old_value.from / new_value.to（否则"该部署有没有
--        tier_switch"永远判不成立，hold 会误伤）；
--      - tier_state_observed 必填 deployment_uid + configured_tier；
--        configured_tier != internal_eval 时 expires_at 必填；
--   6. 给 entitlement_expired 的 expires_at 建部分索引（H5-R14 / L67：
--      "链上是否已存在绑定该 expires_at 的 expired" 必须可索引查询，不能藏 JSON）；
--   7. 链（prev_hash/hash）与 append-only 触发器天然覆盖 audit_gap，不需改动：
--      audit_gap 是正常链环，prev_hash 指向前一条；UPDATE/DELETE 照旧拒绝。
--
-- 刻意不做：
--   - 不改 001（含不改其 hash canonical 字段列表）：recorded_at 是 DB 侧元数据，
--     不参与 hash，旧行 hash 仍可验证；伪造 recorded_at 由「列级授权不给 +
--     append-only + 触发器强制 now()」三重约束挡住；
--   - 不加 write_cursor / event_seq 表（H4 m00567 第 5 条：写失败期间没有介质
--     能记录"尝试"）；reconciler 靠「链上缺 deployment_uid 的 observed」补 gap；
--   - 不做补记重放（Lead L62）：断口必须可见。
--
-- 幂等：ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD /
--       CREATE OR REPLACE / DROP TRIGGER IF EXISTS。
-- 授权：本文件只建对象与内部 REVOKE，不写角色 GRANT。A13 的
--       infra/db/sql/20_grants.sql 须在列级 INSERT 清单里**排除 recorded_at**
--       （与 prev_hash/hash 同等对待）；90_verify_privileges.sql 增加对应断言。
-- 禁止：不得在 infra/db/migrations/ 复制本文件；不得改写 001。
--
-- 兼容性：新 CHECK 是 validated 的。若某个旧库在 002 之前已存在缺 target_tier 的
-- deploy、缺 from/to 的 tier_switch、或缺 configured_tier 的 observed（append-only
-- 无法回填），002 会 fail-closed 失败。11-12 尚未上真栈，a13_verify 是 scratch：
-- 重建后由 seed 直接写入合规形态即可；不提供静默跳过/降级开关。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. recorded_at：DB 写入时间（业务时间仍是 occurred_at）
-- ---------------------------------------------------------------------------
ALTER TABLE audit.entitlement_events
    ADD COLUMN IF NOT EXISTS recorded_at timestamptz;

-- 既有行没有真实写入时间可考（001 没有 created_at，Lead L62 提到的旧列不存在）：
-- 回填为 occurred_at，仅作最佳近似，并在列注释里写明；不得据此推断"写入延迟"。
-- append-only 触发器禁止 UPDATE，回填必须在迁移事务内临时停用它（迁移结束后恢复）。
ALTER TABLE audit.entitlement_events
    DISABLE TRIGGER entitlement_events_no_update_bu;
UPDATE audit.entitlement_events
   SET recorded_at = occurred_at
 WHERE recorded_at IS NULL;
ALTER TABLE audit.entitlement_events
    ENABLE TRIGGER entitlement_events_no_update_bu;

ALTER TABLE audit.entitlement_events
    ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE audit.entitlement_events
    ALTER COLUMN recorded_at SET NOT NULL;

-- 触发器强制 recorded_at = now()：即使调用方（迁移/seed/运维角色）显式传值也会被覆盖。
-- 应用角色本来也没有该列的 INSERT 权限（A13 列级授权排除），这是第二道防线。
CREATE OR REPLACE FUNCTION audit.entitlement_events_set_recorded_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    NEW.recorded_at := now();
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS entitlement_events_recorded_at_bi ON audit.entitlement_events;
CREATE TRIGGER entitlement_events_recorded_at_bi
    BEFORE INSERT ON audit.entitlement_events
    FOR EACH ROW EXECUTE FUNCTION audit.entitlement_events_set_recorded_at();

-- ---------------------------------------------------------------------------
-- 2. event_type 第 10 类：audit_gap（写审计失败恢复后的断口）
-- ---------------------------------------------------------------------------
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_event_type_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_event_type_chk
    CHECK (event_type IN ('entitlement_expired', 'entitlement_flip',
                          'tier_state_observed', 'unauthorized_config',
                          'deploy', 'tier_switch', 'hold_set', 'hold_clear',
                          'clause_review', 'audit_gap'));

-- audit_gap 最小留痕完整性（缺字段 = 无法审计 = fail-closed 拒绝）：
--   - deployment_uid、operator 必填；reason 必须 NULL（结构性断口不占 6 值业务枚举）；
--   - new_value 对象必须含 gap_from / gap_to / lost_count / reason / owner；
--     gap_from 的语义 = 链上最后一条成功事件的 occurred_at（由写入方计算；DDL 只校验
--     非空与 gap_to >= gap_from，不替写入方猜窗口）；
--   - gap_from/gap_to 必须是 UTC ISO-8601（Z 或 +00:00）；gap_to >= gap_from；
--   - lost_count：null（恢复时无法确知）或正整数；**0 拒绝**（写"丢了 0 条"是自欺）；
--   - reason 仅 transient_write_failure / process_restart；owner 非空。
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_audit_gap_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_audit_gap_chk
    CHECK (event_type <> 'audit_gap' OR (
        deployment_uid IS NOT NULL AND btrim(deployment_uid) <> ''
        AND operator IS NOT NULL AND btrim(operator) <> ''
        AND reason IS NULL
        AND new_value IS NOT NULL AND jsonb_typeof(new_value) = 'object'
        AND new_value ? 'gap_from' AND new_value ? 'gap_to'
        AND new_value ? 'lost_count' AND new_value ? 'reason' AND new_value ? 'owner'
        AND coalesce(new_value->>'gap_from', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$'
        AND coalesce(new_value->>'gap_to', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$'
        AND (new_value->>'gap_to')::timestamptz >= (new_value->>'gap_from')::timestamptz
        AND (jsonb_typeof(new_value->'lost_count') = 'null'
             OR (jsonb_typeof(new_value->'lost_count') = 'number'
                 AND (new_value->>'lost_count') ~ '^[0-9]+$'
                 AND (new_value->>'lost_count')::numeric > 0))
        AND (new_value->>'reason') IN ('transient_write_failure', 'process_restart')
        AND btrim(coalesce(new_value->>'owner', '')) <> ''
    ));

-- ---------------------------------------------------------------------------
-- 3. schema_version：1/2 共存；新写事件默认 2（A3 无需改 INSERT 列清单）
-- ---------------------------------------------------------------------------
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_schema_version_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_schema_version_chk
    CHECK (schema_version IN (1, 2));
ALTER TABLE audit.entitlement_events
    ALTER COLUMN schema_version SET DEFAULT 2;

-- 说明：既有行保持 1；A3 runtime 不写该列即得 2；A13 的 seed 在 002 之后也写 2
-- （Lead L64：「默认值应当等于当前正确值」，只有历史行留 1）；clause_review /
-- audit_gap 由运维或 reconciler 写入时也按 2（新事件）。002 生效后新 insert
-- 若不显式指定 schema_version，默认 2。

-- ---------------------------------------------------------------------------
-- 3b. deploy 事件必须自带 new_value.target_tier（H5-R14 / L67 + H4 m00579）
--     取值 = 服务端 DataTier 枚举：internal_eval / c_end_display / research_only /
--     platform_user_data（services/market/src/config.ts:9）。H4 m00579 原话「三档」
--     但同一段又用 internal_eval 做比较，故按代码的 4 值闭集落；若产品口径只允许
--     三档（排除 internal_eval），那是新规则，需 H5 另发改动，不由 A5 放宽。
--     reconciler 只在 target_tier != internal_eval 且缺对应 tier_switch 时才判 gap，
--     所以本字段用来避免把首次 internal_eval 部署误报成断口；缺 = fail-closed。
--     注意：本 CHECK 是 validated 的。若某个已存在的库在 002 之前已有缺 target_tier
--     的 deploy 事件（append-only 无法回填），本迁移会失败——11-12 尚未跑真栈，
--     a13_verify 是 scratch，A13 重建后 seed 直接带 target_tier 即可。
-- ---------------------------------------------------------------------------
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_require_deploy_tier_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_require_deploy_tier_chk
    CHECK (event_type <> 'deploy' OR (
        new_value IS NOT NULL AND jsonb_typeof(new_value) = 'object'
        AND coalesce(jsonb_typeof(new_value->'target_tier'), '') = 'string'
        AND (new_value->>'target_tier') IN
            ('internal_eval', 'c_end_display', 'research_only', 'platform_user_data')
    ));

-- ---------------------------------------------------------------------------
-- 3d. tier_switch 必须带 from/to（H4 m00599 + Lead L68）
--     旧版只看 deployment_uid/approval_ref，漏字段时 reconciler 的"是否有对应
--     tier_switch"规则会静默失效；这里把语义写进 DB。
-- ---------------------------------------------------------------------------
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_tier_switch_from_to_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_tier_switch_from_to_chk
    CHECK (event_type <> 'tier_switch' OR (
        old_value IS NOT NULL AND jsonb_typeof(old_value) = 'object'
        AND coalesce(jsonb_typeof(old_value->'from'), '') = 'string'
        AND btrim(old_value->>'from') <> ''
        AND new_value IS NOT NULL AND jsonb_typeof(new_value) = 'object'
        AND coalesce(jsonb_typeof(new_value->'to'), '') = 'string'
        AND btrim(new_value->>'to') <> ''
    ));

-- ---------------------------------------------------------------------------
-- 3e. tier_state_observed 必填集（H4 m00599 + Lead L68）
--     deployment_uid、configured_tier 恒必填；configured_tier != internal_eval 时
--     expires_at 必填（internal_eval 恒 403，可无时间盒）。001 只强制了
--     boot_id/state_version/effective_tier；缺这三项会让 reconciler 无法把
--     "observed" 与部署对上，进而漏判断口——检测侧 fail-open。
-- ---------------------------------------------------------------------------
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_observed_required_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_observed_required_chk
    CHECK (event_type <> 'tier_state_observed' OR (
        deployment_uid IS NOT NULL AND btrim(deployment_uid) <> ''
        AND configured_tier IS NOT NULL AND btrim(configured_tier) <> ''
        AND (configured_tier = 'internal_eval' OR expires_at IS NOT NULL)
    ));

-- ---------------------------------------------------------------------------
-- 3c. expired 事件按 expires_at 可索引（H5-R14 / L67）
--     判定「链上是否已存在绑定该 expires_at 的 expired」= 查
--     event_type='entitlement_expired' AND expires_at=<值>；expires_at 是真实列，
--     不藏在 JSON 里，这里补部分索引避免全表扫。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS entitlement_events_expired_expires_at_idx
    ON audit.entitlement_events (expires_at)
    WHERE event_type = 'entitlement_expired';

-- ---------------------------------------------------------------------------
-- 4. event_key：新增 audit_gap 分支
--    权威公式：gap|<deployment_uid>|<gap_from UTC 毫秒 ISO>
--    用 deployment_uid（不用 boot_id）：service 与 reconciler 都能算出同一个键
--    （H4 m00567 第 2 条）。
--    其余 9 类分支与 001 逐字一致；本文件替换函数是因为 001 不允许改，
--    后续新增类型应继续用 003+ 迁移替换，不要回改 001。
-- ---------------------------------------------------------------------------
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
            RETURN 'clause|' || btrim(e.authorization_doc_sha256) || '|'
                   || e.clause_locator || '|'
                   || to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD');
        WHEN 'audit_gap' THEN
            IF e.deployment_uid IS NULL OR btrim(e.deployment_uid) = '' THEN
                RAISE EXCEPTION 'event_key(audit_gap) 需要 deployment_uid';
            END IF;
            IF e.new_value IS NULL OR jsonb_typeof(e.new_value) <> 'object'
               OR (e.new_value->>'gap_from') IS NULL
               OR btrim(e.new_value->>'gap_from') = '' THEN
                RAISE EXCEPTION 'event_key(audit_gap) 需要 new_value.gap_from';
            END IF;
            -- 与 A3 的 JS Date.toISOString() 口径一致：UTC 毫秒 + Z。
            RETURN 'gap|' || btrim(e.deployment_uid) || '|'
                   || to_char((e.new_value->>'gap_from')::timestamptz AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
        ELSE
            RAISE EXCEPTION '未知 event_type：%', e.event_type;
    END CASE;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. 权限收口（新增函数默认对 PUBLIC 可执行；具体角色仍由 A13 GRANT）
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION audit.entitlement_events_set_recorded_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.entitlement_event_key(audit.entitlement_events) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 6. 数据字典更新（001 的 COMMENT 不删除，这里覆盖有变化的列/说明）
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN audit.entitlement_events.recorded_at IS
    'DB 写入时间（触发器强制 now()，调用方不可指定；列级 INSERT 不授权；append-only 禁 UPDATE）。occurred_at 仍是服务侧事件发生时间。001 既有行回填为 occurred_at（真实写入时间不可考，仅最佳近似）。不参与 hash canonical，因此旧行 hash 仍可验证。';
COMMENT ON COLUMN audit.entitlement_events.event_type IS
    '事件类型（10 类）：entitlement_expired / entitlement_flip / tier_state_observed / unauthorized_config / deploy / tier_switch / hold_set / hold_clear / clause_review / audit_gap。audit_gap 记录写审计失败恢复后的断口（reason 必须 NULL；new_value 含 gap_from/gap_to/lost_count/reason/owner；event_key=gap|<deployment_uid>|<gap_from UTC 毫秒>）。clause_review 由 A13 运维按工单用迁移角色 psql 插入。';
COMMENT ON COLUMN audit.entitlement_events.event_key IS
    '幂等键，触发器权威计算并覆盖应用值：obs|<boot_id>、flip|<boot_id>|<state_version>、unauth|<fp>|<boot_id>、exp|<tier>|<expires_at UTC 毫秒>|<reason>、deploy|<deployment_uid>、switch|<deployment_uid>、hold|<hold_id>|set|clear、clause|<authorization_doc_sha256>|<clause_locator>|<occurred_at UTC 日期 YYYY-MM-DD>、gap|<deployment_uid>|<gap_from UTC 毫秒 ISO>。写入方幂等：捕获 entitlement_events_event_key_uq 的 unique_violation（其他唯一冲突必须失败）；因应用仅列级 INSERT，带目标列的 ON CONFLICT (event_key) 会报 permission denied，可用裸 ON CONFLICT DO NOTHING。';
COMMENT ON COLUMN audit.entitlement_events.schema_version IS
    '事件 schema 版本（1/2 共存）：1 = 001 历史行与 A13 seed；2 = 002 之后 A3 runtime 新写事件（默认值 2）。历史行不升级。';
