-- infra/db/sql/10_roles.sql
--
-- 进程角色（Lead 两角色裁决 + H4/H5 四写角色卡点，2026-11-04）：
--   * warehouse_loader —— 只有 `warehouse.load` 数据装载进程使用。
--       权限：public 下 dwd_*/dim_* 表的 DML（SELECT/INSERT/UPDATE/DELETE）；
--       不给 DDL、不给 TRUNCATE、不给 serving/watchlist/audit 任何权限。
--   * market_app —— services/api 进程使用。
--       权限：serving.* 的 USAGE + SELECT；public.watchlist_items 的 DML；
--       audit.entitlement_events 仅列级 INSERT；audit.entitlement_hold 仅 SELECT（hold 读取）。
--   * ci_deploy_writer —— 发布流水线使用（不可变产物写 deploy/tier_switch 事件）。
--       权限：audit.entitlement_events 仅列级 INSERT；其余零权限。禁止交互式手写 deploy 记录。
--   * reconciler —— 授权对账 CronJob 使用。
--       权限：仅 EXECUTE audit.raise_hold / audit.mark_reconciled；无表级权限、无 clear_hold。
--   * human_hold_clear —— 人工清 hold 的专用角色（NOLOGIN；人走 T2 工单 + H5 签字，
--       由 A13 执行时 SET ROLE）。权限：仅 EXECUTE audit.clear_hold。
--   * audit_reader —— 审计只读角色（NOLOGIN；H3/A16/A14 经 SET ROLE 使用）。
--       权限：仅 SELECT audit.entitlement_events / entitlement_hold(_state)，无函数 EXECUTE。
--
-- WHY 按进程切而不是按服务切：API 同时要「读行情」和「写自选」，这是两种风险。
--      合成一个「读写都行」的角色，一次注入就能改 DWD —— 而 DWD 是所有展示口径之源。
--
-- 幂等：DO 块按 pg_roles 判断；已存在时只校正属性（不覆盖密码）。
-- 密码：由 bootstrap.sh 通过 psql 变量注入（15_role_passwords.sql）；
--      生产密码来自 secret manager，绝不入库/入仓。

DO $$
DECLARE
  login_roles text[] := ARRAY['warehouse_loader', 'market_app', 'ci_deploy_writer', 'reconciler'];
  role_name   text;
BEGIN
  FOREACH role_name IN ARRAY login_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
        role_name
      );
      RAISE NOTICE 'created role %', role_name;
    ELSE
      EXECUTE format(
        'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
        role_name
      );
      RAISE NOTICE 'role % already exists, attributes normalised', role_name;
    END IF;
  END LOOP;

  -- 非登录功能角色：human_hold_clear（人工清 hold，走 T2 工单 + H5 签字）
  -- 与 audit_reader（H3/A16/A14 审计只读）；均只能被显式 SET ROLE。
  FOREACH role_name IN ARRAY ARRAY['human_hold_clear', 'audit_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
        role_name
      );
      RAISE NOTICE 'created role % (NOLOGIN)', role_name;
    ELSE
      EXECUTE format(
        'ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
        role_name
      );
      RAISE NOTICE 'role % already exists, attributes normalised', role_name;
    END IF;
  END LOOP;
END
$$;

-- 六个角色互不继承：任何一个被误 GRANT 给另一个，下一次 bootstrap 会再次收回。
DO $$
DECLARE
  all_roles text[] := ARRAY[
    'warehouse_loader', 'market_app', 'ci_deploy_writer', 'reconciler',
    'human_hold_clear', 'audit_reader'
  ];
  member_role text;
  granted_role text;
BEGIN
  FOREACH member_role IN ARRAY all_roles LOOP
    FOREACH granted_role IN ARRAY all_roles LOOP
      IF member_role <> granted_role THEN
        EXECUTE format('REVOKE %I FROM %I', granted_role, member_role);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
