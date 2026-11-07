-- =============================================================================
-- migration-004-smoke.sql —— 004 control 心跳 + observed 列 冒烟断言（A5）
--
-- 用法（仓库根目录，本地 PG@55432）：
--   createdb a5_m004_scratch
--   psql -d a5_m004_scratch -v ON_ERROR_STOP=1 \
--     -f services/compliance/migrations/001_audit_entitlement_events.sql \
--     -f services/compliance/migrations/002_audit_gap.sql \
--     -f services/compliance/migrations/003_ai_generation_events.sql \
--     -f services/compliance/test/migration-004-fixture.sql          # 阶段 1：历史夹具
--   psql -d a5_m004_scratch -v ON_ERROR_STOP=1 \
--     -f services/compliance/migrations/004_control_heartbeat_observed.sql
--   psql -d a5_m004_scratch -v ON_ERROR_STOP=1 \
--     -f services/compliance/migrations/004_control_heartbeat_observed.sql  # 幂等重跑
--   psql -d a5_m004_scratch -v ON_ERROR_STOP=1 \
--     -f services/compliance/test/migration-004-smoke.sql            # 阶段 2：断言
--
-- 期望末行 NOTICE: SMOKE PASS: 004 control 心跳 + observed 列 全部断言通过
-- 任一断言失败即 ERROR 抛出（ON_ERROR_STOP=1 退出码非 0）。
-- =============================================================================
DO $$
DECLARE
    v_count    bigint;
    v_seq      bigint;
    v_lws      bigint;
    v_prev_ts  timestamptz;
    v_prev_seq bigint;
    v_now      timestamptz;
    v_hb       timestamptz;
    v_cnt      bigint;
    v_src      text;
    v_by       text;
BEGIN
    -- ① 回填：历史 observed 行 chain_seq 1..N 连续、last_written_event_seq=前一环
    SELECT count(*) INTO v_count FROM audit.entitlement_events
     WHERE deployment_uid = 'smoke-hist' AND chain_seq IS NULL;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'SMOKE FAIL: 历史行 chain_seq 未回填 (%)', v_count;
    END IF;

    SELECT chain_seq, last_written_event_seq INTO v_seq, v_lws
      FROM audit.entitlement_events
     WHERE deployment_uid = 'smoke-hist' AND configured_tier = 'c_end_display';
    IF v_lws IS DISTINCT FROM v_seq - 1 THEN
        RAISE EXCEPTION 'SMOKE FAIL: 历史行 last_written_event_seq 期望 %，实得 %',
            v_seq - 1, v_lws;
    END IF;

    -- ② 新写 observed：触发器权威分配 chain_seq / last_written_event_seq
    --    （显式传入 999/888 会被覆盖，与 event_key 同口径）
    INSERT INTO audit.entitlement_events
        (event_type, boot_id, deployment_uid, configured_tier, effective_tier,
         expires_at, state_version, chain_seq, last_written_event_seq,
         old_value, new_value)
    VALUES ('tier_state_observed', gen_random_uuid(), 'smoke-live', 'internal_eval',
            'internal_eval', NULL, 1, 999, 888, '{}'::jsonb, '{}'::jsonb);

    SELECT chain_seq, last_written_event_seq INTO v_seq, v_lws
      FROM audit.entitlement_events WHERE deployment_uid = 'smoke-live';
    IF v_seq = 999 OR v_lws = 888 THEN
        RAISE EXCEPTION 'SMOKE FAIL: 应用传入的 chain_seq/last_written_event_seq 未被覆盖';
    END IF;
    -- 期望 = 本行落库前链上最后一笔的 chain_seq（L63 #1「最后一笔写进库的事」）
    SELECT max(chain_seq) INTO v_prev_seq FROM audit.entitlement_events
     WHERE deployment_uid <> 'smoke-live';
    IF v_lws IS DISTINCT FROM v_prev_seq THEN
        RAISE EXCEPTION 'SMOKE FAIL: 新 observed 的 last_written_event_seq 期望 %，实得 %',
            v_prev_seq, v_lws;
    END IF;

    -- ③ 非 observed 行 last_written_event_seq 强制 NULL
    INSERT INTO audit.entitlement_events
        (event_type, deployment_uid, approval_ref, executor, approver,
         last_written_event_seq, new_value)
    VALUES ('deploy', 'smoke-deploy', 'smoke-approval-1', 'smoke-exec', 'smoke-appr',
            888, '{"target_tier": "internal_eval"}'::jsonb);
    SELECT count(*) INTO v_count FROM audit.entitlement_events
     WHERE event_type = 'deploy' AND last_written_event_seq IS NOT NULL;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'SMOKE FAIL: deploy 行 last_written_event_seq 应为 NULL';
    END IF;

    -- ④ control 心跳：服务端时钟、来源留痕、单调不减、计数递增
    SELECT last_reconciled_at INTO v_prev_ts FROM audit.entitlement_hold WHERE id = 1;
    PERFORM audit.control_heartbeat('smoke-drill');
    SELECT last_reconciled_at, last_heartbeat_at, last_heartbeat_source,
           last_heartbeat_by, heartbeat_count
      INTO v_now, v_hb, v_src, v_by, v_cnt
      FROM audit.entitlement_hold WHERE id = 1;
    IF v_now IS NULL OR v_now < v_prev_ts OR v_hb IS NULL
       OR v_src <> 'smoke-drill' OR v_cnt < 1 THEN
        RAISE EXCEPTION 'SMOKE FAIL: control_heartbeat 留痕异常（at=% src=% by=% cnt=%）',
            v_hb, v_src, v_by, v_cnt;
    END IF;

    -- ⑤ fail-closed：p_source 必填
    BEGIN
        PERFORM audit.control_heartbeat(NULL);
        RAISE EXCEPTION 'SMOKE FAIL: control_heartbeat(NULL) 应拒绝';
    EXCEPTION
        WHEN raise_exception THEN
            IF SQLERRM LIKE 'SMOKE FAIL%' THEN RAISE; END IF;
    END;

    -- ⑥ append-only 仍然硬拦 UPDATE
    BEGIN
        UPDATE audit.entitlement_events SET reason = 'env_change'
         WHERE deployment_uid = 'smoke-live';
        RAISE EXCEPTION 'SMOKE FAIL: UPDATE 应被 append-only 触发器拒绝';
    EXCEPTION
        WHEN raise_exception THEN
            IF SQLERRM LIKE 'SMOKE FAIL%' THEN RAISE; END IF;
    END;

    -- ⑦ 哈希链完好（chain_seq 不进 hash，002 recorded_at 口径）
    SELECT count(*) INTO v_count FROM audit.verify_entitlement_chain() AS c
     WHERE c.problem IS NOT NULL;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'SMOKE FAIL: 链校验存在 % 处问题', v_count;
    END IF;

    -- ⑧ 视图暴露心跳列
    SELECT count(*) INTO v_count FROM information_schema.columns
     WHERE table_schema = 'audit' AND table_name = 'entitlement_hold_state'
       AND column_name IN ('last_heartbeat_at', 'last_heartbeat_by',
                           'last_heartbeat_source', 'heartbeat_count');
    IF v_count <> 4 THEN
        RAISE EXCEPTION 'SMOKE FAIL: entitlement_hold_state 视图缺心跳列 (%)', v_count;
    END IF;

    RAISE NOTICE 'SMOKE PASS: 004 control 心跳 + observed 列 全部断言通过';
END
$$;
