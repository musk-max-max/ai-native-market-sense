-- =============================================================================
-- migration-004-fixture.sql —— 004 迁移前历史夹具（A5 冒烟阶段 1）
--
-- 在应用 001-003 之后、004 之前执行：插入 2 行「004 之前写入」的 observed 事件
-- （无 chain_seq / last_written_event_seq），用于验证 004 的历史回填。
-- 整体用法见 services/compliance/test/migration-004-smoke.sql 头注。
-- =============================================================================

INSERT INTO audit.entitlement_events
    (event_type, boot_id, deployment_uid, configured_tier, effective_tier,
     expires_at, state_version, old_value, new_value)
SELECT 'tier_state_observed', gen_random_uuid(), 'smoke-hist', 'internal_eval',
       'internal_eval', NULL, 1, '{}'::jsonb, '{}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM audit.entitlement_events
                    WHERE deployment_uid = 'smoke-hist');

INSERT INTO audit.entitlement_events
    (event_type, boot_id, deployment_uid, configured_tier, effective_tier,
     expires_at, state_version, old_value, new_value)
SELECT 'tier_state_observed', gen_random_uuid(), 'smoke-hist', 'c_end_display',
       'c_end_display', '2030-12-31 08:00:00+08', 1, '{}'::jsonb, '{}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM audit.entitlement_events
                    WHERE deployment_uid = 'smoke-hist' AND configured_tier = 'c_end_display');
