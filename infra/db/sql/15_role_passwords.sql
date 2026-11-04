-- infra/db/sql/15_role_passwords.sql
--
-- 给两个进程角色设置密码。仅当 bootstrap.sh 收到对应环境变量时才执行；
-- 密码经 psql 变量传入，不出现在命令行历史/仓库中（CI 永远不设密码）。
--
-- 用法（由 bootstrap.sh 调用）：
--   psql "$DSN" -v ON_ERROR_STOP=1 \
--     -v market_app_password="$APP_DB_MARKET_PASSWORD" \
--     -v warehouse_loader_password="$APP_DB_LOADER_PASSWORD" \
--     -f 15_role_passwords.sql

\if :{?market_app_password}
ALTER ROLE market_app PASSWORD :'market_app_password';
\echo 'market_app password updated'
\else
\echo 'skip: market_app_password 未提供（保留现有密码；生产由 secret manager 注入）'
\endif

\if :{?warehouse_loader_password}
ALTER ROLE warehouse_loader PASSWORD :'warehouse_loader_password';
\echo 'warehouse_loader password updated'
\else
\echo 'skip: warehouse_loader_password 未提供（保留现有密码；生产由 secret manager 注入）'
\endif
