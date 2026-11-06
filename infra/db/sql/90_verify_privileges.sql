-- infra/db/sql/90_verify_privileges.sql
--
-- 权限断言（bootstrap.sh --verify 末尾、db-migrate.sh 迁移+授权之后执行）。
-- 失败即 RAISE EXCEPTION（psql ON_ERROR_STOP=1 → 退出非 0，部署中断）。
--
-- 断言「没有 XX 权限」与断言「有 YY 权限」同等重要：越权是静默的，少授是显式的。
-- 覆盖：
--   * 角色存在与属性（无 SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS）、互相不继承
--   * market_app：dwd_*/dim_* 零权限；serving 只有 SELECT；watchlist_items 恰有 DML；
--                 audit.entitlement_events 恰有 INSERT（表存在时）；不能建表
--   * warehouse_loader：dwd_*/dim_* 有 DML、无 DDL/TRUNCATE；serving/watchlist/audit 零权限
--   * 两个角色都不拥有任何关系/序列/schema
--
-- 表尚未迁移时（bootstrap 阶段先于 migrations）对应断言跳过并 NOTICE；
-- db-migrate.sh 会在迁移后重跑 20_grants.sql + 本文件，届时表存在即强断言。

DO $$
DECLARE
  n integer;
  rel record;
  role_attr record;
  p text;
  dml text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  no_ddl text[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'];
  has_watchlist boolean := to_regclass('public.watchlist_items') IS NOT NULL;
  has_audit boolean := to_regclass('audit.entitlement_events') IS NOT NULL;
BEGIN
  -- ---------- 0. 角色存在与属性 ----------
  SELECT count(*) INTO n
  FROM pg_roles WHERE rolname IN ('market_app', 'warehouse_loader');
  IF n <> 2 THEN
    RAISE EXCEPTION '角色缺失：market_app / warehouse_loader 必须都存在（当前 % 个）', n;
  END IF;

  FOR role_attr IN
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit
    FROM pg_roles WHERE rolname IN ('market_app', 'warehouse_loader')
  LOOP
    IF role_attr.rolsuper OR role_attr.rolcreatedb OR role_attr.rolcreaterole
       OR role_attr.rolbypassrls THEN
      RAISE EXCEPTION '角色 % 属性越权：%', role_attr.rolname, role_attr;
    END IF;
    IF NOT role_attr.rolinherit THEN
      RAISE EXCEPTION '角色 % 应 INHERIT（但不得继承任何组角色）', role_attr.rolname;
    END IF;
  END LOOP;

  -- 两个角色之间、以及它们作为成员，都不允许有角色继承关系
  SELECT count(*) INTO n
  FROM pg_auth_members m
  JOIN pg_roles granted_role ON granted_role.oid = m.roleid
  JOIN pg_roles member_role ON member_role.oid = m.member
  WHERE granted_role.rolname IN ('market_app', 'warehouse_loader')
     OR member_role.rolname IN ('market_app', 'warehouse_loader');
  IF n > 0 THEN
    RAISE EXCEPTION '角色继承关系越权：market_app/warehouse_loader 不得参与任何 GRANT role（% 条）', n;
  END IF;

  -- ---------- 1. market_app：dwd_*/dim_* 零权限 ----------
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE grantee = 'market_app'
    AND table_schema = 'public'
    AND (table_name LIKE 'dwd\_%' OR table_name LIKE 'dim\_%');
  IF n > 0 THEN
    RAISE EXCEPTION 'market_app 在 DWD/DIM 上仍有 % 条授权（必须为 0）', n;
  END IF;

  FOR rel IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND (c.relname LIKE 'dwd\_%' OR c.relname LIKE 'dim\_%')
  LOOP
    IF has_table_privilege('market_app', format('public.%I', rel.relname), 'SELECT')
       OR has_table_privilege('market_app', format('public.%I', rel.relname), 'INSERT')
       OR has_table_privilege('market_app', format('public.%I', rel.relname), 'UPDATE')
       OR has_table_privilege('market_app', format('public.%I', rel.relname), 'DELETE')
       OR has_table_privilege('market_app', format('public.%I', rel.relname), 'TRUNCATE') THEN
      RAISE EXCEPTION 'market_app 对 DWD/DIM 表 % 存在实际权限（含 PUBLIC 继承），必须为零', rel.relname;
    END IF;
  END LOOP;

  -- ---------- 2. market_app：serving 只有 SELECT ----------
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE grantee = 'market_app' AND table_schema = 'serving' AND privilege_type <> 'SELECT';
  IF n > 0 THEN
    RAISE EXCEPTION 'market_app 在 serving 上有 % 条非 SELECT 授权', n;
  END IF;

  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE grantee = 'market_app' AND table_schema = 'serving' AND privilege_type = 'SELECT';
  IF n = 0 THEN
    RAISE EXCEPTION 'market_app 在 serving 上没有 SELECT 授权（API 读不到行情）';
  END IF;

  IF has_schema_privilege('market_app', 'serving', 'CREATE') THEN
    RAISE EXCEPTION 'market_app 不允许在 serving 上 CREATE';
  END IF;
  IF has_schema_privilege('market_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'market_app 不允许在 public 上 CREATE';
  END IF;

  -- ---------- 3. market_app：watchlist_items 恰有 DML ----------
  IF has_watchlist THEN
    FOREACH p IN ARRAY dml LOOP
      IF NOT has_table_privilege('market_app', 'public.watchlist_items', p) THEN
        RAISE EXCEPTION 'market_app 缺 watchlist_items 的 % 权限（自选增删改查需要）', p;
      END IF;
    END LOOP;
    FOREACH p IN ARRAY no_ddl LOOP
      IF has_table_privilege('market_app', 'public.watchlist_items', p) THEN
        RAISE EXCEPTION 'market_app 对 watchlist_items 不应有 % 权限', p;
      END IF;
    END LOOP;

    SELECT count(*) INTO n
    FROM information_schema.role_table_grants
    WHERE grantee = 'market_app' AND table_schema = 'public'
      AND table_name <> 'watchlist_items';
    IF n > 0 THEN
      RAISE EXCEPTION 'market_app 在 public（非 watchlist_items）上仍有 % 条授权', n;
    END IF;
  ELSE
    RAISE NOTICE 'watchlist_items 尚未迁移：跳过其 DML 断言（db-migrate 后复验）';
  END IF;

  -- ---------- 4. market_app：audit 列级 INSERT（排除自证列）+ hold 只读视图 ----------
  IF has_audit THEN
    IF has_table_privilege('market_app', 'audit.entitlement_events', 'INSERT') THEN
      RAISE EXCEPTION 'market_app 持有事件表级 INSERT（应为列级，排除 event_key/prev_hash/hash）';
    END IF;
    IF has_column_privilege('market_app', 'audit.entitlement_events', 'prev_hash', 'INSERT')
     OR has_column_privilege('market_app', 'audit.entitlement_events', 'hash', 'INSERT')
     OR has_column_privilege('market_app', 'audit.entitlement_events', 'recorded_at', 'INSERT') THEN
    RAISE EXCEPTION 'market_app 可写 prev_hash/hash（可伪造哈希链）';
  END IF;
  IF NOT has_column_privilege('market_app', 'audit.entitlement_events', 'event_type', 'INSERT')
     OR NOT has_column_privilege('market_app', 'audit.entitlement_events', 'event_key', 'INSERT') THEN
      RAISE EXCEPTION 'market_app 缺 audit.entitlement_events 业务列 INSERT（留痕写不进去）';
    END IF;
    FOREACH p IN ARRAY ARRAY['SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('market_app', 'audit.entitlement_events', p) THEN
        RAISE EXCEPTION 'market_app 对 audit.entitlement_events 不应有 % 权限（只写不读）', p;
      END IF;
    END LOOP;
    IF NOT has_schema_privilege('market_app', 'audit', 'USAGE') THEN
      RAISE EXCEPTION 'market_app 缺 audit schema 的 USAGE（无法写事件表）';
    END IF;
  ELSE
    RAISE NOTICE 'audit.entitlement_events 尚未迁移：跳过审计授权断言（db-migrate 后复验）';
  END IF;

  -- ---------- 5. warehouse_loader：DWD/DIM DML，且无 DDL/TRUNCATE ----------
  FOR rel IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND (c.relname LIKE 'dwd\_%' OR c.relname LIKE 'dim\_%')
  LOOP
    FOREACH p IN ARRAY dml LOOP
      IF NOT has_table_privilege('warehouse_loader', format('public.%I', rel.relname), p) THEN
        RAISE EXCEPTION 'warehouse_loader 缺 DWD/DIM 表 % 的 % 权限', rel.relname, p;
      END IF;
    END LOOP;
    FOREACH p IN ARRAY no_ddl LOOP
      IF has_table_privilege('warehouse_loader', format('public.%I', rel.relname), p) THEN
        RAISE EXCEPTION 'warehouse_loader 对 DWD/DIM 表 % 不应有 % 权限', rel.relname, p;
      END IF;
    END LOOP;
  END LOOP;

  -- ---------- 6. warehouse_loader：serving / watchlist / audit 零权限 ----------
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE grantee = 'warehouse_loader' AND table_schema = 'serving';
  IF n > 0 THEN
    RAISE EXCEPTION 'warehouse_loader 在 serving 上有 % 条授权（必须为 0）', n;
  END IF;
  IF has_schema_privilege('warehouse_loader', 'serving', 'USAGE') THEN
    RAISE EXCEPTION 'warehouse_loader 不应有 serving schema 的 USAGE';
  END IF;

  IF has_watchlist THEN
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege('warehouse_loader', 'public.watchlist_items', p) THEN
        RAISE EXCEPTION 'warehouse_loader 对 watchlist_items 不应有 % 权限', p;
      END IF;
    END LOOP;
  END IF;

  IF has_audit THEN
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege('warehouse_loader', 'audit.entitlement_events', p) THEN
        RAISE EXCEPTION 'warehouse_loader 对 audit.entitlement_events 不应有 % 权限', p;
      END IF;
    END LOOP;
  END IF;

  -- ---------- 7. 两个角色都不拥有关系/schema ----------
  SELECT count(*) INTO n
  FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
  WHERE r.rolname IN ('market_app', 'warehouse_loader');
  IF n > 0 THEN
    RAISE EXCEPTION '进程角色不得拥有关系（当前 % 个对象）', n;
  END IF;

  SELECT count(*) INTO n
  FROM pg_namespace ns JOIN pg_roles r ON r.oid = ns.nspowner
  WHERE r.rolname IN ('market_app', 'warehouse_loader');
  IF n > 0 THEN
    RAISE EXCEPTION '进程角色不得拥有 schema（当前 % 个）', n;
  END IF;

  RAISE NOTICE 'verify ok: market_app(serving SELECT + watchlist DML + audit INSERT), warehouse_loader(DWD/DIM DML), 越权=0';
END
$$;

-- 运营核对（只读）：两个角色的授权面
SELECT grantee, table_schema, privilege_type, count(*) AS grants
FROM information_schema.role_table_grants
WHERE grantee IN ('market_app', 'warehouse_loader')
GROUP BY grantee, table_schema, privilege_type
ORDER BY grantee, table_schema, privilege_type;

-- ---------------------------------------------------------------------------
-- 授权生命周期（H4/H5 卡点）：hold 只自动置、只有人能清；reconciler 无表级权限。
-- 表/函数可能尚未迁移：用 to_regclass / to_regprocedure 判断后跳过（migrate 后会强制重跑本文件）。
-- 说明：hold 的只读入口是 A5 canonical 视图 audit.entitlement_hold_state；
--       market_app / reconciler 不直读基表，避免拿到 set_by 之外的写入语义。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  violations text[] := ARRAY[]::text[];
  has_events boolean := to_regclass('audit.entitlement_events') IS NOT NULL;
  has_hold   boolean := to_regclass('audit.entitlement_hold') IS NOT NULL;
  has_state  boolean := to_regclass('audit.entitlement_hold_state') IS NOT NULL;
  has_raise  boolean := to_regprocedure('audit.raise_hold(text,text)') IS NOT NULL;
  has_clear  boolean := to_regprocedure('audit.clear_hold(text,text,text)') IS NOT NULL;
  has_marks  boolean := to_regprocedure('audit.mark_reconciled(timestamptz)') IS NOT NULL;
  has_ai_table  boolean := to_regclass('audit.ai_generation_events') IS NOT NULL;
  has_ai_verify boolean := to_regprocedure('audit.verify_ai_generation_chain()') IS NOT NULL;
  col        record;
  c          record;
BEGIN
  IF NOT has_events OR NOT has_hold THEN
    RAISE NOTICE 'audit 表尚未迁移，跳过 hold/事件授权断言（db-migrate 完成后会强制重跑）';
    RETURN;
  END IF;

  -- 002 新增约束必须已验证（convalidated=true）。NOT VALID 的 CHECK 对旧行不生效，
  -- 等于「规则写了但不拦历史」，越权/断口会被静默放过（A5 m01799）。
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'audit.entitlement_events'::regclass
      AND conname IN ('entitlement_events_audit_gap_chk',
                      'entitlement_events_tier_switch_from_to_chk',
                      'entitlement_events_schema_version_chk')
      AND convalidated IS NOT TRUE
  LOOP
    violations := array_append(violations, '002 约束未验证（NOT VALID）：' || c.conname);
  END LOOP;

  -- market_app：hold 通过只读视图；基表无任何权限。
  IF has_state THEN
    IF has_table_privilege('market_app', 'audit.entitlement_hold_state', 'SELECT') IS NOT TRUE THEN
      violations := array_append(violations, 'market_app 缺少 audit.entitlement_hold_state SELECT（hold 无法生效）');
    END IF;
  END IF;
  IF has_table_privilege('market_app', 'audit.entitlement_hold', 'SELECT')
     OR has_table_privilege('market_app', 'audit.entitlement_hold', 'INSERT')
     OR has_table_privilege('market_app', 'audit.entitlement_hold', 'UPDATE')
     OR has_table_privilege('market_app', 'audit.entitlement_hold', 'DELETE') THEN
    violations := array_append(violations, 'market_app 不应有 audit.entitlement_hold 基表权限（只走只读视图）');
  END IF;

  -- market_app 事件表：表级 INSERT 必须为 false，hash 列不可写，不可读。
  IF has_table_privilege('market_app', 'audit.entitlement_events', 'INSERT') THEN
    violations := array_append(violations, 'market_app 对事件表持有表级 INSERT（应为列级，排除 hash 列）');
  END IF;
  IF has_column_privilege('market_app', 'audit.entitlement_events', 'prev_hash', 'INSERT')
     OR has_column_privilege('market_app', 'audit.entitlement_events', 'hash', 'INSERT') THEN
    violations := array_append(violations, 'market_app 可写 prev_hash/hash（可伪造哈希链）');
  END IF;
  IF has_table_privilege('market_app', 'audit.entitlement_events', 'SELECT') THEN
    violations := array_append(violations, 'market_app 可读审计事件（应用无审计读权限）');
  END IF;

  -- ci_deploy_writer：事件列级 INSERT；无读/改/删；无 hold 任何权限。
  IF NOT has_column_privilege('ci_deploy_writer', 'audit.entitlement_events', 'event_type', 'INSERT') THEN
    violations := array_append(violations, 'ci_deploy_writer 缺事件列级 INSERT（发布留痕写不进去）');
  END IF;
  IF has_column_privilege('ci_deploy_writer', 'audit.entitlement_events', 'prev_hash', 'INSERT')
     OR has_column_privilege('ci_deploy_writer', 'audit.entitlement_events', 'hash', 'INSERT')
     OR has_column_privilege('ci_deploy_writer', 'audit.entitlement_events', 'recorded_at', 'INSERT') THEN
    violations := array_append(violations, 'ci_deploy_writer 不应能写 prev_hash/hash/recorded_at（自证列）');
  END IF;
  IF has_table_privilege('ci_deploy_writer', 'audit.entitlement_events', 'INSERT')
     OR has_table_privilege('ci_deploy_writer', 'audit.entitlement_events', 'SELECT')
     OR has_table_privilege('ci_deploy_writer', 'audit.entitlement_events', 'UPDATE')
     OR has_table_privilege('ci_deploy_writer', 'audit.entitlement_events', 'DELETE') THEN
    violations := array_append(violations, 'ci_deploy_writer 不应有事件表级权限（只应列级 INSERT）');
  END IF;
  IF has_table_privilege('ci_deploy_writer', 'audit.entitlement_hold', 'SELECT')
     OR has_table_privilege('ci_deploy_writer', 'audit.entitlement_hold', 'INSERT')
     OR has_table_privilege('ci_deploy_writer', 'audit.entitlement_hold', 'UPDATE')
     OR has_table_privilege('ci_deploy_writer', 'audit.entitlement_hold', 'DELETE') THEN
    violations := array_append(violations, 'ci_deploy_writer 不应有 hold 表权限');
  END IF;

  -- reconciler：无表级写权；只读 hold 视图；只 EXECUTE raise_hold / mark_reconciled。
  IF has_table_privilege('reconciler', 'audit.entitlement_events', 'SELECT')
     OR has_table_privilege('reconciler', 'audit.entitlement_events', 'INSERT')
     OR has_table_privilege('reconciler', 'audit.entitlement_events', 'UPDATE')
     OR has_table_privilege('reconciler', 'audit.entitlement_events', 'DELETE') THEN
    violations := array_append(violations, 'reconciler 不应有事件表权限（只应 EXECUTE 函数）');
  END IF;
  IF has_table_privilege('reconciler', 'audit.entitlement_hold', 'INSERT')
     OR has_table_privilege('reconciler', 'audit.entitlement_hold', 'UPDATE')
     OR has_table_privilege('reconciler', 'audit.entitlement_hold', 'DELETE') THEN
    violations := array_append(violations, 'reconciler 不应有 hold 写权限（只应 EXECUTE 函数）');
  END IF;
  IF has_raise AND NOT has_function_privilege('reconciler', 'audit.raise_hold(text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'reconciler 缺少 raise_hold EXECUTE');
  END IF;
  IF has_marks AND NOT has_function_privilege('reconciler', 'audit.mark_reconciled(timestamptz)', 'EXECUTE') THEN
    violations := array_append(violations, 'reconciler 缺少 mark_reconciled EXECUTE');
  END IF;
  IF has_clear AND has_function_privilege('reconciler', 'audit.clear_hold(text,text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'reconciler 不应能 clear_hold（清 hold 只能人工）');
  END IF;

  -- human_hold_clear：仅 clear_hold；必须 NOLOGIN。
  IF has_clear AND NOT has_function_privilege('human_hold_clear', 'audit.clear_hold(text,text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'human_hold_clear 缺少 clear_hold EXECUTE');
  END IF;
  IF has_raise AND has_function_privilege('human_hold_clear', 'audit.raise_hold(text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'human_hold_clear 不应能 raise_hold');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'human_hold_clear' AND rolcanlogin) THEN
    violations := array_append(violations, 'human_hold_clear 必须 NOLOGIN（人工角色只能 SET ROLE）');
  END IF;

  -- audit_reader：只 SELECT 审计对象 + 只 EXECUTE 只读链校验函数；NOLOGIN。
  IF has_table_privilege('audit_reader', 'audit.entitlement_events', 'SELECT') IS NOT TRUE THEN
    violations := array_append(violations, 'audit_reader 缺少 events SELECT');
  END IF;
  IF has_table_privilege('audit_reader', 'audit.entitlement_hold', 'SELECT') IS NOT TRUE THEN
    violations := array_append(violations, 'audit_reader 缺少 hold SELECT');
  END IF;
  IF has_raise AND has_function_privilege('audit_reader', 'audit.raise_hold(text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'audit_reader 不应能 EXECUTE 写函数');
  END IF;
  IF to_regprocedure('audit.verify_entitlement_chain()') IS NOT NULL
     AND NOT has_function_privilege('audit_reader', 'audit.verify_entitlement_chain()', 'EXECUTE') THEN
    violations := array_append(violations, 'audit_reader 缺少 verify_entitlement_chain EXECUTE');
  END IF;
  -- raise_hold 幂等：A5 canonical 已改为 no-op（不再 RAISE）；用函数体断言，避免在验证里真的置 hold。
  IF has_raise THEN
    IF position('RETURN v_row.hold_id' IN pg_get_functiondef(to_regprocedure('audit.raise_hold(text,text)'))) = 0
       AND position('RETURN v_row.hold_id;' IN pg_get_functiondef(to_regprocedure('audit.raise_hold(text,text)'))) = 0 THEN
      violations := array_append(violations, 'raise_hold 缺少幂等 no-op（reconciler 每 2min 会刷假事件）');
    END IF;
  END IF;
  IF has_clear AND has_function_privilege('audit_reader', 'audit.clear_hold(text,text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'audit_reader 不应能 EXECUTE 任何函数');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader' AND rolcanlogin) THEN
    violations := array_append(violations, 'audit_reader 必须 NOLOGIN（审计只读经 SET ROLE）');
  END IF;
  IF has_table_privilege('audit_reader', 'audit.entitlement_events', 'INSERT')
     OR has_table_privilege('audit_reader', 'audit.entitlement_events', 'UPDATE')
     OR has_table_privilege('audit_reader', 'audit.entitlement_events', 'DELETE') THEN
    violations := array_append(violations, 'audit_reader 对事件表有写权限（必须只读）');
  END IF;

  -- AI 审计只读（A16/H3）：audit_reader 可 SELECT ai_generation_events、只 EXECUTE 全链校验；
  -- 无 INSERT/UPDATE/DELETE/TRUNCATE，也不能 EXECUTE 触发器/哈希内部函数。ai_app 的断言在其独立 DO 块。
  IF has_ai_table THEN
    IF NOT has_table_privilege('audit_reader', 'audit.ai_generation_events', 'SELECT') THEN
      violations := array_append(violations, 'audit_reader 缺少 ai_generation_events SELECT');
    END IF;
    IF has_table_privilege('audit_reader', 'audit.ai_generation_events', 'INSERT')
       OR has_table_privilege('audit_reader', 'audit.ai_generation_events', 'UPDATE')
       OR has_table_privilege('audit_reader', 'audit.ai_generation_events', 'DELETE')
       OR has_table_privilege('audit_reader', 'audit.ai_generation_events', 'TRUNCATE') THEN
      violations := array_append(violations, 'audit_reader 对 ai_generation_events 有写权限（必须只读）');
    END IF;
  END IF;
  IF has_ai_verify AND NOT has_function_privilege('audit_reader', 'audit.verify_ai_generation_chain()', 'EXECUTE') THEN
    violations := array_append(violations, 'audit_reader 缺少 verify_ai_generation_chain EXECUTE');
  END IF;
  IF has_ai_verify AND has_function_privilege('audit_reader', 'audit.ai_generation_event_hash(audit.ai_generation_events)', 'EXECUTE') THEN
    violations := array_append(violations, 'audit_reader 不应能 EXECUTE ai_generation_event_hash（只读链校验函数足够）');
  END IF;

  -- H3/H4：清 hold 只能人工。market_app/warehouse_loader 不能执行任何 hold 写函数；
  -- 这三条防的是「DROP FUNCTION + CREATE 后 ACL 重置回 PUBLIC」及未来迁移漏收口。
  IF has_clear AND has_function_privilege('market_app', 'audit.clear_hold(text,text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'market_app 不应能 EXECUTE clear_hold（清 hold 只能人工）');
  END IF;
  IF has_raise AND has_function_privilege('market_app', 'audit.raise_hold(text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'market_app 不应能 EXECUTE raise_hold（hold 只能 reconciler 置）');
  END IF;
  IF has_marks AND has_function_privilege('market_app', 'audit.mark_reconciled(timestamptz)', 'EXECUTE') THEN
    violations := array_append(violations, 'market_app 不应能 EXECUTE mark_reconciled');
  END IF;
  IF has_clear AND has_function_privilege('warehouse_loader', 'audit.clear_hold(text,text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'warehouse_loader 不应能 EXECUTE clear_hold');
  END IF;
  IF has_raise AND has_function_privilege('warehouse_loader', 'audit.raise_hold(text,text)', 'EXECUTE') THEN
    violations := array_append(violations, 'warehouse_loader 不应能 EXECUTE raise_hold');
  END IF;
  IF has_marks AND has_function_privilege('warehouse_loader', 'audit.mark_reconciled(timestamptz)', 'EXECUTE') THEN
    violations := array_append(violations, 'warehouse_loader 不应能 EXECUTE mark_reconciled');
  END IF;
  -- PUBLIC（grantee=0）不得持有写函数 EXECUTE：proacl IS NULL 即默认 PUBLIC EXECUTE，也算越权。
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'audit'
      AND p.proname IN ('raise_hold', 'clear_hold', 'mark_reconciled')
      AND (
        p.proacl IS NULL
        OR EXISTS (
          SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        )
      )
  ) THEN
    violations := array_append(violations, 'PUBLIC 持有 audit hold 写函数 EXECUTE（ACL 重置/迁移漏收口）');
  END IF;

  -- 列级授权必须排除 hash 列（防未来 GRANT 表级回退）。
  FOR col IN
    SELECT grantee, privilege_type
    FROM information_schema.column_privileges
    WHERE table_schema = 'audit'
      AND table_name = 'entitlement_events'
      AND column_name IN ('prev_hash', 'hash')
      AND privilege_type = 'INSERT'
      AND grantee IN ('market_app', 'ci_deploy_writer')
  LOOP
    violations := array_append(violations, format('%s 可写 hash 列（可伪造哈希链）', col.grantee));
  END LOOP;

  -- H4 P0：display_safe 默认必须 fail-closed（false）；旧库补列后也一样。
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dim_instrument' AND column_name = 'display_safe'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dim_instrument'
        AND column_name = 'display_safe' AND column_default IS DISTINCT FROM 'false'
    ) THEN
      violations := array_append(violations, 'dim_instrument.display_safe 默认值不是 false（fail-open）');
    END IF;
  END IF;

  IF array_length(violations, 1) > 0 THEN
    RAISE EXCEPTION 'entitlement 授权边界越权：%', array_to_string(violations, '；');
  END IF;
  RAISE NOTICE 'entitlement 授权断言通过：hold 只读/人工清；reconciler 仅函数；audit_reader 只读；hash 列不可写';
END
$$;

-- ---------------------------------------------------------------------------
-- ai_app（L126 H2）：AI 生成审计独立写角色。
-- 口径：只允许 audit.ai_generation_events 的列级 INSERT；表级任何权限、UPDATE/DELETE、
--       SELECT（「检查在读」——不是只靠 REVOKE）、业务表/identity/audit 其它对象一律不许。
-- 表尚未迁移时跳过表级断言并 NOTICE；db-migrate 迁移+授权后会重跑本文件强断言。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
  col record;
  seq record;
  p text;
  has_ai_table boolean := to_regclass('audit.ai_generation_events') IS NOT NULL;
  has_audit_schema boolean := EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'audit');
  expected_cols integer := 0;
BEGIN
  -- 1. 角色存在、属性、可登录、互不继承。
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_app') THEN
    RAISE EXCEPTION '角色缺失：ai_app（AI 生成审计写进程）必须存在';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'ai_app'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'ai_app 角色属性越权（不得 SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_app' AND rolcanlogin) THEN
    RAISE EXCEPTION 'ai_app 必须 LOGIN（服务进程直接写入）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_app' AND rolinherit) THEN
    RAISE EXCEPTION 'ai_app 应 INHERIT（但不得继承任何组角色）';
  END IF;
  SELECT count(*) INTO n
  FROM pg_auth_members m
  JOIN pg_roles granted_role ON granted_role.oid = m.roleid
  JOIN pg_roles member_role ON member_role.oid = m.member
  WHERE granted_role.rolname = 'ai_app' OR member_role.rolname = 'ai_app';
  IF n > 0 THEN
    RAISE EXCEPTION 'ai_app 不得参与任何角色继承关系（当前 % 条）', n;
  END IF;

  -- 2. 不得拥有任何关系/序列/schema（owner 可绕过 ACL）。
  SELECT count(*) INTO n
  FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
  WHERE r.rolname = 'ai_app';
  IF n > 0 THEN RAISE EXCEPTION 'ai_app 拥有 % 个关系/序列（必须零所有权）', n; END IF;
  SELECT count(*) INTO n
  FROM pg_namespace ns JOIN pg_roles r ON r.oid = ns.nspowner
  WHERE r.rolname = 'ai_app';
  IF n > 0 THEN RAISE EXCEPTION 'ai_app 拥有 % 个 schema（必须零所有权）', n; END IF;

  -- 3. 任何表级授权都不允许（目标表也只能列级）。
  -- 注意：information_schema.role_table_grants / table_privileges 只覆盖「当前启用角色」，
  -- 对 ai_app 这类非当前角色永远返回 0，会静默假绿。这里直接查 pg_class.relacl / pg_proc.proacl。
  SELECT count(*) INTO n
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE r.rolname = 'ai_app';
  IF n > 0 THEN
    RAISE EXCEPTION 'ai_app 有 % 条表/序列 ACL 授权（目标表只允许列级 INSERT，其他对象一律零权限）', n;
  END IF;
  SELECT count(*) INTO n
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE r.rolname = 'ai_app';
  IF n > 0 THEN RAISE EXCEPTION 'ai_app 有 % 条函数 EXECUTE 授权（应为零）', n; END IF;

  -- 4. schema 权限：public（默认连接 schema）必有 USAGE；audit 迁移后必须有 USAGE；
  --    其余 schema 不得有 USAGE；任何 schema 不得有 CREATE。
  IF NOT has_schema_privilege('ai_app', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'ai_app 缺 public schema USAGE（连不上默认 schema）';
  END IF;
  IF has_audit_schema AND NOT has_schema_privilege('ai_app', 'audit', 'USAGE') THEN
    RAISE EXCEPTION 'ai_app 缺 audit schema USAGE（无法写 ai_generation_events）';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_namespace ns
    WHERE ns.nspname NOT IN ('public', 'audit')
      AND ns.nspname NOT LIKE 'pg\_%'
      AND ns.nspname <> 'information_schema'
      AND has_schema_privilege('ai_app', ns.nspname, 'USAGE')
  ) THEN
    RAISE EXCEPTION 'ai_app 对 public/audit 之外的 schema 有 USAGE（越权）';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_namespace ns WHERE has_schema_privilege('ai_app', ns.nspname, 'CREATE')
  ) THEN
    RAISE EXCEPTION 'ai_app 不应有任何 schema CREATE 权限';
  END IF;
  -- 显式 USAGE 授权也只允许 public/audit（防未来新增 schema 时被 GRANT）。
  SELECT count(*) INTO n
  FROM pg_namespace ns
  CROSS JOIN LATERAL aclexplode(COALESCE(ns.nspacl, acldefault('n', ns.nspowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE r.rolname = 'ai_app'
    AND a.privilege_type = 'USAGE'
    AND ns.nspname NOT IN ('public', 'audit')
    AND ns.nspname NOT LIKE 'pg\_%'
    AND ns.nspname <> 'information_schema';
  IF n > 0 THEN
    RAISE EXCEPTION 'ai_app 对 public/audit 之外的 schema 有显式 USAGE 授权（% 条）', n;
  END IF;

  -- 5. 序列零权限（序列权限不在 role_table_grants 里，逐条断言）。
  FOR seq IN
    SELECT c.oid::regclass AS qualified
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE c.relkind = 'S' AND ns.nspname IN ('public', 'serving', 'audit', 'identity')
  LOOP
    IF has_sequence_privilege('ai_app', seq.qualified, 'USAGE')
       OR has_sequence_privilege('ai_app', seq.qualified, 'SELECT')
       OR has_sequence_privilege('ai_app', seq.qualified, 'UPDATE') THEN
      RAISE EXCEPTION 'ai_app 对序列 % 有权限（应为零）', seq.qualified;
    END IF;
  END LOOP;

  IF NOT has_ai_table THEN
    RAISE NOTICE 'audit.ai_generation_events 尚未迁移：跳过 ai_app 列级断言（db-migrate 后复验）';
    RETURN;
  END IF;

  -- 6. 表级七种权限必须全无（只允许列级 INSERT）。
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('ai_app', 'audit.ai_generation_events', p) THEN
      RAISE EXCEPTION 'ai_app 对 audit.ai_generation_events 有表级 % 权限（只允许列级 INSERT）', p;
    END IF;
  END LOOP;

  -- 7. 目标表每一列：INSERT 有、SELECT/UPDATE/REFERENCES 无；覆盖数必须等于列数。
  SELECT count(*) INTO expected_cols
  FROM information_schema.columns
  WHERE table_schema = 'audit' AND table_name = 'ai_generation_events';
  IF expected_cols = 0 THEN
    RAISE EXCEPTION 'audit.ai_generation_events 没有列（DDL 不完整）';
  END IF;

  FOR col IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'audit' AND table_name = 'ai_generation_events'
  LOOP
    IF NOT has_column_privilege('ai_app', 'audit.ai_generation_events', col.column_name, 'INSERT') THEN
      RAISE EXCEPTION 'ai_app 缺列级 INSERT：ai_generation_events.%（写入会失败）', col.column_name;
    END IF;
    IF has_column_privilege('ai_app', 'audit.ai_generation_events', col.column_name, 'SELECT') THEN
      RAISE EXCEPTION 'ai_app 可读列 ai_generation_events.%（AI 进程不应读审计）', col.column_name;
    END IF;
    IF has_column_privilege('ai_app', 'audit.ai_generation_events', col.column_name, 'UPDATE')
       OR has_column_privilege('ai_app', 'audit.ai_generation_events', col.column_name, 'REFERENCES') THEN
      RAISE EXCEPTION 'ai_app 对列 ai_generation_events.% 有 UPDATE/REFERENCES（只应 INSERT）', col.column_name;
    END IF;
  END LOOP;

  -- 8. 目标表之外不得有任何列级授权（未来新增表/列也不会自动获得权限）。
  --    information_schema.column_privileges 同样只覆盖当前启用角色，改用 pg_attribute.attacl。
  SELECT count(*) INTO n
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE r.rolname = 'ai_app'
    AND att.attnum > 0
    AND NOT (
      ns.nspname = 'audit'
      AND c.relname = 'ai_generation_events'
      AND a.privilege_type = 'INSERT'
    );
  IF n > 0 THEN
    RAISE EXCEPTION 'ai_app 在目标表之外有 % 条列级授权（越权）', n;
  END IF;

  RAISE NOTICE 'ai_app 授权断言通过：仅 audit.ai_generation_events 列级 INSERT（% 列），无读/改/删/表级权限', expected_cols;
END
$$;
