-- infra/db/migrations/002_display_safe.sql
--
-- 背景（L30 + Lead 11-12 优先级 2）：
--   `dim_instrument.display_safe` 在 warehouse/dwd/schema.sql 的 CREATE TABLE 里已经存在，
--   但早于该列的旧库（bootstrap 跑过、表已建）不会因为 CREATE TABLE IF NOT EXISTS 获得新列。
--   没有这列，serving.serving_instrument 视图（A2）会直接创建失败，C 端展示安全开关失效。
--
-- 本迁移只做「补齐历史库列」，不修改 A2 的 canonical DDL：
--   1) 幂等补列，**DEFAULT false**（H4 m00993：缺 manifest 证据 = 不可展示，
--      fail-closed；历史行一次性置 false，manifest 回放成功后再翻 true）；
--   2) 视图重放由 db-migrate.sh 第 6.5 步执行 warehouse/serving/schema.sql 的
--      CREATE OR REPLACE VIEW 完成（单一真源在 A2，不在迁移里复制视图定义）。
--
-- 幂等：ADD COLUMN IF NOT EXISTS；重复执行只更新注释。
-- 前置：dim_instrument 必须已由 bootstrap.sh 的 DWD schema 创建（旧库天然满足）。

DO $$
BEGIN
  IF to_regclass('public.dim_instrument') IS NULL THEN
    RAISE EXCEPTION 'dim_instrument 不存在：请先执行 infra/db/bootstrap.sh（DWD schema）';
  END IF;
END
$$;

ALTER TABLE public.dim_instrument
  ADD COLUMN IF NOT EXISTS display_safe boolean NOT NULL DEFAULT false;

-- 旧库的列可能已由 canonical DDL 以 DEFAULT true 建出：ADD COLUMN IF NOT EXISTS 不会改默认值，
-- 必须显式 SET DEFAULT，否则新插入的行仍然是 fail-open。
ALTER TABLE public.dim_instrument
  ALTER COLUMN display_safe SET DEFAULT false;

-- 历史行：旧默认/缺列时一律先 fail-closed；只有 manifest 回放能把它翻成 true。
UPDATE public.dim_instrument
   SET display_safe = false
 WHERE display_safe IS DISTINCT FROM false;

COMMENT ON COLUMN public.dim_instrument.display_safe IS
  'L30：渠道是来源属性。false 不得进入 C 端结果集（保留内部评测态）；缺 manifest 证据默认 false（fail-closed）。';

DO $$
BEGIN
  RAISE NOTICE 'display_safe 列已就绪；serving 视图重放见 db-migrate.sh 第 6.5 步';
END
$$;
