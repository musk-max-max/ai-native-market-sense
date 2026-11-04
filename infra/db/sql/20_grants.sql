-- infra/db/sql/20_grants.sql
--
-- 权限收口（两角色，按进程切；Lead 裁决 2026-11-04）：
--   market_app       => serving.* USAGE+SELECT；public.watchlist_items 仅 DML(S/I/U/D)；
--                       audit.entitlement_events 仅 INSERT；其余一律 REVOKE。
--   warehouse_loader => public.dwd_*/dim_* 仅 DML(S/I/U/D)；无 DDL/TRUNCATE；
--                       serving/watchlist/audit 零权限。
--
-- 三层防线：
--   1) 正向：按上表精确 GRANT；不 GRANT ALL。
--   2) 反向：REVOKE ALL 后再给最小集合；serving 不向 PUBLIC 开放；
--      两个角色都不能建表/不能 TRUNCATE/不能拿 REFERENCES/TRIGGER。
--   3) 运行时：90_verify_privileges.sql 断言「越权=0」与「该有的有」；
--      本文件在 migrations 之后由 db-migrate.sh 再跑一次（新表授权不靠人记）。
--
-- 幂等：全是 GRANT/REVOKE；watchlist_items / audit.entitlement_events 尚未迁移时
--       用 to_regclass 判断后跳过并 NOTICE（不因表不存在而让 bootstrap 失败）。
-- 视图以属主（迁移角色）权限执行，因此 market_app 无需底层 DWD 权限即可 SELECT serving view。

-- ---------------------------------------------------------------------------
-- 1) market_app：serving 只读
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA serving FROM PUBLIC;
GRANT USAGE ON SCHEMA serving TO market_app;
GRANT SELECT ON ALL TABLES IN SCHEMA serving TO market_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA serving GRANT SELECT ON TABLES TO market_app;
REVOKE CREATE ON SCHEMA serving FROM market_app;

-- ---------------------------------------------------------------------------
-- 2) market_app：public schema 只留 watchlist_items（+ audit 走第 3 步）
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM market_app;
GRANT USAGE ON SCHEMA public TO market_app;
REVOKE CREATE ON SCHEMA public FROM market_app;

-- 先全部收回，再把 watchlist_items 的最小集合给回去（现有表 + 未来的表都默认不给）
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM market_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM market_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM market_app;

DO $$
BEGIN
  IF to_regclass('public.watchlist_items') IS NULL THEN
    RAISE NOTICE 'skip: public.watchlist_items 尚未迁移；db-migrate.sh 会在迁移后重跑本文件';
  ELSE
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.watchlist_items TO market_app';
    EXECUTE 'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.watchlist_items FROM market_app';
    RAISE NOTICE 'granted market_app: SELECT/INSERT/UPDATE/DELETE on public.watchlist_items';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3) market_app：audit 事件列级 INSERT（排除 event_id/event_key/prev_hash/hash 自证列）
--    hold 只给只读视图（A5 canonical：audit.entitlement_hold_state），不给基表写权。
DO $$
DECLARE
  cols text;
BEGIN
  IF to_regclass('audit.entitlement_events') IS NULL THEN
    RAISE NOTICE 'skip: audit.entitlement_events 尚未迁移；db-migrate.sh 会在迁移后重跑本文件';
  ELSE
    EXECUTE 'REVOKE ALL ON SCHEMA audit FROM market_app';
    EXECUTE 'GRANT USAGE ON SCHEMA audit TO market_app';

    EXECUTE 'REVOKE ALL ON TABLE audit.entitlement_events FROM market_app';
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO cols
      FROM information_schema.columns
     WHERE table_schema = 'audit'
       AND table_name = 'entitlement_events'
       AND column_name NOT IN ('event_id', 'prev_hash', 'hash');
    EXECUTE format('GRANT INSERT (%s) ON TABLE audit.entitlement_events TO market_app', cols);
    RAISE NOTICE 'granted market_app: column-level INSERT on audit.entitlement_events (no hash columns)';

    IF to_regclass('audit.entitlement_hold_state') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL ON TABLE audit.entitlement_hold_state FROM market_app';
      EXECUTE 'GRANT SELECT ON TABLE audit.entitlement_hold_state TO market_app';
      RAISE NOTICE 'granted market_app: SELECT on audit.entitlement_hold_state (hold 读取)';
    END IF;
  END IF;
END
$$;

-- 3b) 四写角色 + 审计只读（H4/H5 职责分离）
DO $$
DECLARE
  cols text;
BEGIN
  IF to_regclass('audit.entitlement_events') IS NULL THEN
    RAISE NOTICE 'skip: audit 尚未迁移，跳过 ci/reconciler/human/audit_reader 授权';
    RETURN;
  END IF;

  -- ci_deploy_writer：只能从不可变产物写事件；hold 无任何权限。
  EXECUTE 'REVOKE ALL ON SCHEMA audit FROM ci_deploy_writer';
  EXECUTE 'GRANT USAGE ON SCHEMA audit TO ci_deploy_writer';
  EXECUTE 'REVOKE ALL ON TABLE audit.entitlement_events FROM ci_deploy_writer';
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'audit'
     AND table_name = 'entitlement_events'
     AND column_name NOT IN ('event_id', 'prev_hash', 'hash');
  EXECUTE format('GRANT INSERT (%s) ON TABLE audit.entitlement_events TO ci_deploy_writer', cols);
  EXECUTE 'REVOKE ALL ON audit.entitlement_hold FROM ci_deploy_writer';
  EXECUTE 'REVOKE ALL ON audit.entitlement_hold_state FROM ci_deploy_writer';

  -- reconciler：无表级权限；只 EXECUTE raise_hold / mark_reconciled + 读 hold 视图。
  EXECUTE 'REVOKE ALL ON SCHEMA audit FROM reconciler';
  EXECUTE 'GRANT USAGE ON SCHEMA audit TO reconciler';
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM reconciler';
  EXECUTE 'GRANT SELECT ON TABLE audit.entitlement_hold_state TO reconciler';
  EXECUTE 'GRANT EXECUTE ON FUNCTION audit.raise_hold(text, text) TO reconciler';
  EXECUTE 'GRANT EXECUTE ON FUNCTION audit.mark_reconciled(timestamptz) TO reconciler';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION audit.clear_hold(text, text, text) FROM reconciler';

  -- human_hold_clear：只可 EXECUTE clear_hold（NOLOGIN，人经 T2 工单 + H5 签字后 SET ROLE）。
  EXECUTE 'REVOKE ALL ON SCHEMA audit FROM human_hold_clear';
  EXECUTE 'GRANT USAGE ON SCHEMA audit TO human_hold_clear';
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM human_hold_clear';
  EXECUTE 'GRANT EXECUTE ON FUNCTION audit.clear_hold(text, text, text) TO human_hold_clear';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION audit.raise_hold(text, text) FROM human_hold_clear';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION audit.mark_reconciled(timestamptz) FROM human_hold_clear';

  -- audit_reader：只 SELECT 事件表与 hold（审计/合规只读），无任何函数 EXECUTE。
  EXECUTE 'REVOKE ALL ON SCHEMA audit FROM audit_reader';
  EXECUTE 'GRANT USAGE ON SCHEMA audit TO audit_reader';
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM audit_reader';
  EXECUTE 'GRANT SELECT ON TABLE audit.entitlement_events TO audit_reader';
  EXECUTE 'GRANT SELECT ON TABLE audit.entitlement_hold TO audit_reader';
  IF to_regclass('audit.entitlement_hold_state') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE audit.entitlement_hold_state TO audit_reader';
  END IF;
  EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA audit FROM audit_reader';
  -- 只读链校验是审计角色的职责（A11 抽样也要用）；空结果 = 链完整。
  IF to_regprocedure('audit.verify_entitlement_chain()') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION audit.verify_entitlement_chain() TO audit_reader';
  END IF;

  RAISE NOTICE 'granted: ci_deploy_writer(event INSERT), reconciler(raise_hold/mark_reconciled+hold view), human_hold_clear(clear_hold only), audit_reader(SELECT only)';
END
$$;

-- ---------------------------------------------------------------------------
-- 4) warehouse_loader：public 下 dwd_*/dim_* 仅 DML；其余零权限
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA serving FROM warehouse_loader;
REVOKE ALL ON ALL TABLES IN SCHEMA serving FROM warehouse_loader;

REVOKE ALL ON SCHEMA public FROM warehouse_loader;
GRANT USAGE ON SCHEMA public TO warehouse_loader;
REVOKE CREATE ON SCHEMA public FROM warehouse_loader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM warehouse_loader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM warehouse_loader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM warehouse_loader;

DO $$
DECLARE
  rel record;
  granted integer := 0;
BEGIN
  FOR rel IN
    SELECT c.relname
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p') -- 表/分区表；视图/外部表不给 DML
      AND (c.relname LIKE 'dwd\_%' OR c.relname LIKE 'dim\_%')
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO warehouse_loader',
      rel.relname
    );
    EXECUTE format(
      'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM warehouse_loader',
      rel.relname
    );
    granted := granted + 1;
  END LOOP;
  RAISE NOTICE 'granted warehouse_loader: DML on % dwd_/dim_ relations (no DDL, no TRUNCATE)', granted;
END
$$;

DO $$
BEGIN
  IF to_regclass('audit.entitlement_events') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE audit.entitlement_events FROM warehouse_loader';
  END IF;
  IF to_regclass('public.watchlist_items') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.watchlist_items FROM warehouse_loader';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 其余进程角色：public/serving 默认零权限（audit 的精确授权见上方 3/3b；
-- 此处禁止再对 audit 表做 ALL TABLES REVOKE，否则会把上面刚授的列级权限整体抹掉）。
-- 原则：新角色无权访问 public/serving，必须显式授权；避免「新增角色默认继承 PUBLIC」。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['ci_deploy_writer', 'reconciler', 'human_hold_clear', 'audit_reader'] LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', role_name);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'serving') THEN
      EXECUTE format('REVOKE ALL ON SCHEMA serving FROM %I', role_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'audit') THEN
      EXECUTE format('GRANT USAGE ON SCHEMA audit TO %I', role_name);
    END IF;
  END LOOP;
END
$$;

\echo 'grants applied: market_app => serving SELECT + watchlist DML + audit column INSERT + hold view; warehouse_loader => DWD/DIM DML only; ci/reconciler/human/audit_reader => explicit minimal grants (A5 canonical audit DDL)'

