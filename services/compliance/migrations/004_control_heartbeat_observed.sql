-- =============================================================================
-- 004_control_heartbeat_observed.sql
--
-- 归属：A5 backend-compliance（合规域）。schema/DDL 由 A5 署名与维护。
-- 执行：A13 SRE（infra/scripts/db-migrate.sh 自动发现 services/*/migrations/*.sql，
--       单文件单事务执行并写入 meta.schema_migrations 台账）。
-- 依据：Lead L63（H5-R12）三条裁定：
--        ① "audit.tier_state_observed 增 boot_id + last_written_event_seq；
--           reconciler 发现 seq 不连续即补写 audit_gap。窗口的事实来源是
--           「最后一笔写进库的事」和「库恢复时间」，两者都在库里"——boot_id 已由
--           001 落地，本文件补最后一列 last_written_event_seq，并引入全链写序
--           chain_seq 作为它的取值来源；
--        ② window_start=失败前最后一条成功事件 occurred_at（002 已落地）；
--        ③ recorded_at 永不接受客户端传入（002 已落地；本文件心跳沿用同一原则
--           ——时间戳只由服务端时钟产生）。
--       Lead L23/L24（role 分工：CI 写 deploy / pod 写 observed / reconciler 写
--       hold；reconciler 2min 间隔、last_reconciled_at 陈旧阈值 15min，两个数字
--       分开定，本文件不改阈值）。
--       task-13（P2-11）："control 心跳 / observed 列两个基础设施缺口
--       （本机栈实跑暴露）"（docs/HANDOFF-team-rebuild-2026-11-06.md:118/161、
--       docs/requirements/go-live-blockers.md:64）。
--       002 先例：DB 侧元数据（触发器权威计算）不进 hash canonical，旧行 hash
--       仍可验证（002_audit_gap.sql:39-40 recorded_at 口径）。
--
-- 本文件交付 decision→control→policy 落库链路的两块基础设施（对照 001-003）：
--   A. observed 列（decision 落库侧）：
--      - audit.entitlement_events 增 chain_seq（全链写序环号，触发器权威分配，
--        用 SEQUENCE 计数；应用给的值会被覆盖，与 event_key 同口径）；
--      - tier_state_observed 增 last_written_event_seq（L63 #1）：本行落库前
--        链上最后一笔写进库的事 = 前一环的 chain_seq，触发器权威计算。至此
--        L63 要求的窗口事实「最后一笔写进库的事」（last_written_event_seq）与
--        「库恢复时间」（recorded_at，002）都落在库里，不在服务内存里。
--   B. control 心跳（control 落库侧）：
--      - audit.entitlement_hold 增心跳留痕列 last_heartbeat_at / last_heartbeat_by
--        / last_heartbeat_source / heartbeat_count；
--      - 新增 audit.control_heartbeat(p_source)：只用服务端时钟（不接受调用方
--        时间戳——可伪造的保活时间等于没有保活），单调不减刷新 last_reconciled_at
--        （gate 的新鲜度信号：services/market/src/adapters/pg-entitlement-control-
--        repo.ts:25 只读此列，15min 阈值 H5 不变）；session_user 与来源标签落列，
--        谁在保活一查便知。心跳 = control 行保活；对账（reconciler 核对链与
--        control 一致）落地上线后仍走 audit.mark_reconciled（001 不动），心跳与
--        对账的区分看 last_heartbeat_source / heartbeat_count。
--      - 【L0 追认 L135.5（Lead 2026-11-06）】D1 语义照准，权威口径句（H4 安全
--        半口径引用锚点，与 docs/reference/event-payloads.json 同文）：
--        「gate 语义 = 存活心跳门禁，对账完整性看 mark_reconciled / last_heartbeat_source」
--        即：心跳刷新 last_reconciled_at（gate 15min 阈值只读此列，存活 = 有人在
--        保活）；对账完整性结论只出自 audit.mark_reconciled（reconciler 核对链后
--        落地）；一次刷新是心跳还是对账，看 last_heartbeat_source / heartbeat_count。
--
-- 兼容性：历史行（004 之前写入）的 chain_seq / last_written_event_seq 按链序
--        回填（occurred_at, event_id 与 001 链头判定同一全序；DISABLE TRIGGER
--        回填模式照抄 002 recorded_at 先例）。回填是链序近似：004 之前真实写序
--        的空洞（回滚/幂等去重）不可考，**不得据此推断断口或写入延迟**；断口
--        判定只对 004 之后的行成立（且按 Lead L66 两条确定性条件收口，seq 空洞
--        只是线索不是结论——幂等去重 ON CONFLICT DO NOTHING 也会留空洞）。
--        心跳列全部可空/带默认，旧 hold 行不受影响。
-- 幂等：CREATE SEQUENCE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--       DROP CONSTRAINT IF EXISTS + ADD / DROP TRIGGER IF EXISTS /
--       CREATE OR REPLACE / 回填 WHERE 列 IS NULL。
-- 授权：本文件只建对象与内部 REVOKE，不写角色 GRANT。A13 的
--       infra/db/sql/20_grants.sql 须：
--        ① 列级 INSERT 排除清单增 chain_seq / last_written_event_seq
--          （与 prev_hash/hash/recorded_at 同等对待：触发器权威计算，应用不得
--          自证）；
--        ② audit.control_heartbeat(text) 只授 reconciler（心跳=control 行写入，
--          归「reconciler 写 hold」角色分工，Lead L23）；market_app 不得持有
--          （market_app 对 hold 写函数 has_function_privilege 必须 false）；
--       90_verify_privileges.sql 增加对应断言。
-- 刻意不做：① 不做 write_cursor / event_seq **表**（H4 m00567 第 5 条维持：写
--        失败期间没有介质能记录「尝试」；chain_seq 是行内列 + SEQUENCE 对象，
--        不是表）② 心跳不写事件链（2 分钟一条链事件是噪音；留痕在 hold 行四列）
--        ③ 不改 001（含 hash canonical 字段列表）：chain_seq / last_written_
--        event_seq 与 recorded_at 同口径不进 hash，旧行 hash 仍可验证 ④ 不改
--        002/003 ⑤ 不改 15min 阈值与 reason 词表（执行者不改规则）⑥ 不做
--        reconciler 的 gap 判定逻辑（A13 P1）。
-- PII：不新增任何 PII 列（H3 六条件未过，禁止加）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A. observed 列：chain_seq（全链写序）+ last_written_event_seq（L63 #1）
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS audit.entitlement_events_write_seq;

ALTER TABLE audit.entitlement_events
    ADD COLUMN IF NOT EXISTS chain_seq bigint;
ALTER TABLE audit.entitlement_events
    ADD COLUMN IF NOT EXISTS last_written_event_seq bigint;

COMMENT ON COLUMN audit.entitlement_events.chain_seq IS
    '全链写序环号（L63 #1 的 seq 取值来源）。触发器用 audit.entitlement_events_write_seq 权威分配，应用给的值会被覆盖（与 event_key 同口径）；不进 hash（002 recorded_at 口径：DB 侧元数据），列级 INSERT 授权须排除本列。SEQUENCE 空洞 = 有尝试但未落库（回滚）的线索；幂等去重（ON CONFLICT DO NOTHING）同样留空洞，断口判定按 L66 两条确定性条件收口。004 之前的历史行按链序回填 1..N（近似，不得据此推断断口/写入延迟）。';
COMMENT ON COLUMN audit.entitlement_events.last_written_event_seq IS
    'L63 #1：tier_state_observed 专有列——本行落库前「最后一笔写进库的事」= 前一环 chain_seq，触发器权威计算（链空前为 0）。窗口事实「最后一笔写进库的事」自此在库里；「库恢复时间」看 recorded_at（002）。非 observed 行为 NULL（触发器强制覆盖）。004 之前的历史行按链序回填（近似）。';

-- 回填：chain_seq = 链序环号（occurred_at, event_id 与 001 链头判定同一全序），
-- last_written_event_seq = 链上前一环（仅 observed 行）。
-- append-only 触发器禁止 UPDATE，回填必须在迁移事务内临时停用它（002 先例）。
ALTER TABLE audit.entitlement_events
    DISABLE TRIGGER entitlement_events_no_update_bu;

WITH ordered AS (
    SELECT event_id,
           row_number() OVER (ORDER BY occurred_at, event_id) AS rn
      FROM audit.entitlement_events
)
UPDATE audit.entitlement_events e
   SET chain_seq = o.rn
  FROM ordered o
 WHERE e.event_id = o.event_id
   AND e.chain_seq IS NULL;

WITH ordered AS (
    SELECT event_id,
           lag(chain_seq) OVER (ORDER BY chain_seq) AS prev_seq
      FROM audit.entitlement_events
)
UPDATE audit.entitlement_events e
   SET last_written_event_seq = coalesce(o.prev_seq, 0)
  FROM ordered o
 WHERE e.event_id = o.event_id
   AND e.event_type = 'tier_state_observed'
   AND e.last_written_event_seq IS NULL;

ALTER TABLE audit.entitlement_events
    ENABLE TRIGGER entitlement_events_no_update_bu;

-- 序列推进到已回填的最大环号（并发/幂等保护：只前进不回退）。
DO $$
DECLARE
    v_max bigint;
BEGIN
    SELECT coalesce(max(chain_seq), 0) INTO v_max FROM audit.entitlement_events;
    IF v_max > 0 THEN
        PERFORM setval('audit.entitlement_events_write_seq',
                       GREATEST(v_max,
                                coalesce(pg_sequence_last_value(
                                    'audit.entitlement_events_write_seq'::regclass), 0)),
                       true);
    END IF;
END
$$;

-- 触发器权威分配写序（与 002 recorded_at 触发器同规格）：
--   chain_seq := nextval(...)（覆盖应用传入值）；
--   tier_state_observed → last_written_event_seq := 本行落库前 max(chain_seq)。
-- 事务级 advisory 锁与链触发器同一把（001）：max() 读取与链头读取同一串行域，
-- 与触发器名字母序无关（同事务重复加锁可重入）。
CREATE OR REPLACE FUNCTION audit.entitlement_events_set_write_seq()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_last bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('audit.entitlement_events.chain', 0));

    SELECT max(e.chain_seq) INTO v_last FROM audit.entitlement_events e;

    NEW.chain_seq := nextval('audit.entitlement_events_write_seq');
    IF NEW.event_type = 'tier_state_observed' THEN
        -- 「最后一笔写进库的事」（L63 #1 窗口事实来源）：链空前为 0。
        NEW.last_written_event_seq := coalesce(v_last, 0);
    ELSE
        NEW.last_written_event_seq := NULL;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS entitlement_events_write_seq_bi ON audit.entitlement_events;
CREATE TRIGGER entitlement_events_write_seq_bi
    BEFORE INSERT ON audit.entitlement_events
    FOR EACH ROW EXECUTE FUNCTION audit.entitlement_events_set_write_seq();

-- 完整性：observed 行两列必填（触发器权威保证，CHECK 是第二道防线；回填后
-- 历史行已非空，CHECK 为 validated）。
ALTER TABLE audit.entitlement_events
    DROP CONSTRAINT IF EXISTS entitlement_events_observed_seq_chk;
ALTER TABLE audit.entitlement_events
    ADD CONSTRAINT entitlement_events_observed_seq_chk
        CHECK (event_type <> 'tier_state_observed' OR
               (chain_seq IS NOT NULL AND last_written_event_seq IS NOT NULL
                AND last_written_event_seq >= 0));

-- ---------------------------------------------------------------------------
-- B. control 心跳：hold 行心跳留痕 + audit.control_heartbeat
-- ---------------------------------------------------------------------------
ALTER TABLE audit.entitlement_hold
    ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
ALTER TABLE audit.entitlement_hold
    ADD COLUMN IF NOT EXISTS last_heartbeat_by text;
ALTER TABLE audit.entitlement_hold
    ADD COLUMN IF NOT EXISTS last_heartbeat_source text;
ALTER TABLE audit.entitlement_hold
    ADD COLUMN IF NOT EXISTS heartbeat_count bigint NOT NULL DEFAULT 0;

ALTER TABLE audit.entitlement_hold
    DROP CONSTRAINT IF EXISTS entitlement_hold_heartbeat_count_chk;
ALTER TABLE audit.entitlement_hold
    ADD CONSTRAINT entitlement_hold_heartbeat_count_chk
        CHECK (heartbeat_count >= 0);

COMMENT ON COLUMN audit.entitlement_hold.last_heartbeat_at IS
    '最近一次心跳（control 行保活）的服务端时间；只由 audit.control_heartbeat 写入，单调不减。';
COMMENT ON COLUMN audit.entitlement_hold.last_heartbeat_by IS
    '最近一次心跳的 session_user（真实登录账号，不记函数 owner；与 raise_hold/clear_hold 的 set_by 同口径）。';
COMMENT ON COLUMN audit.entitlement_hold.last_heartbeat_source IS
    '心跳来源标签（p_source，如 reconciler / runbook / manual-drill）：心跳 ≠ 对账结论，区分「谁在保活」。';
COMMENT ON COLUMN audit.entitlement_hold.heartbeat_count IS
    '心跳累计次数（单调递增）：配合告警（心跳静默）与演练核查。';

-- control 心跳（task-13）：本机栈实跑暴露「没有保活 → last_reconciled_at 15 分钟
-- 后全站 control_stale 降档」。心跳只用服务端时钟（L63 #3 原则：可伪造的时间
-- 等于没有时间——001 的 mark_reconciled(p_at) 接受调用方时间戳，故不能直接当
-- 心跳用，001 不动、本文件新增）；对 last_reconciled_at 与 mark_reconciled 同
-- 口径单调不减刷新（gate 15min 新鲜度信号，阈值不变）。
CREATE OR REPLACE FUNCTION audit.control_heartbeat(p_source text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_now    timestamptz := now();
    v_result timestamptz;
BEGIN
    IF p_source IS NULL OR btrim(p_source) = '' THEN
        RAISE EXCEPTION 'control_heartbeat 拒绝：p_source 必填（心跳留痕：谁在保活）';
    END IF;
    IF length(btrim(p_source)) > 128 THEN
        RAISE EXCEPTION 'control_heartbeat 拒绝：p_source 超长（≤128 字符）';
    END IF;

    UPDATE audit.entitlement_hold
       SET last_heartbeat_at      = greatest(coalesce(last_heartbeat_at, v_now), v_now),
           last_heartbeat_by      = session_user,
           last_heartbeat_source  = btrim(p_source),
           heartbeat_count        = heartbeat_count + 1,
           -- gate 的新鲜度信号是 last_reconciled_at（H5 15min 阈值不变）：
           -- 心跳 = control 行保活，与 mark_reconciled 同口径单调不减。
           last_reconciled_at     = greatest(coalesce(last_reconciled_at, v_now), v_now)
     WHERE id = 1
    RETURNING last_reconciled_at INTO v_result;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'control_heartbeat 拒绝：audit.entitlement_hold 单行缺失（迁移未 seed）';
    END IF;
    RETURN v_result;
END
$$;

-- 视图同步（001 的 L53 升级块先例）：A3 只读列保持原序，新列追加在尾部。
CREATE OR REPLACE VIEW audit.entitlement_hold_state AS
SELECT id, hold, hold_id, hold_reason, set_by, set_at, last_reconciled_at,
       last_heartbeat_at, last_heartbeat_by, last_heartbeat_source, heartbeat_count
  FROM audit.entitlement_hold;

-- ---------------------------------------------------------------------------
-- 权限收口（001 §8 同口径）：具体角色由 A13 的 20_grants.sql GRANT。
-- ---------------------------------------------------------------------------
REVOKE ALL ON SEQUENCE audit.entitlement_events_write_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.entitlement_events_set_write_seq() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.control_heartbeat(text) FROM PUBLIC;
