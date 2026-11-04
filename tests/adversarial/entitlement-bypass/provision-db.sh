#!/usr/bin/env bash
# 重建 A19 隔离库 market_sense_a19：用当前 warehouse schema 建表 + 从本地合成数据源库复制 fixture。
# 只操作 127.0.0.1:55432 上名为 market_sense_a19 的独立库；不触碰源库/生产/真实用户数据。
#
# 用法（workspace 根目录）：
#   tests/adversarial/entitlement-bypass/provision-db.sh
# 可选环境变量：A19_SOURCE_DB_URL、A19_DB_NAME、A19_PG_HOST、A19_PG_PORT
set -euo pipefail

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PG_HOST="${A19_PG_HOST:-127.0.0.1}"
PG_PORT="${A19_PG_PORT:-55432}"
SRC_URL="${A19_SOURCE_DB_URL:-postgresql://ms@localhost:${PG_PORT}/market_sense}"
DST_NAME="${A19_DB_NAME:-market_sense_a19}"
DST_URL="postgresql://ms@${PG_HOST}:${PG_PORT}/${DST_NAME}"

TABLES=(dim_instrument dwd_stock_bar_daily dwd_suspended_daily dwd_adj_factor dwd_fundamental_report dwd_bar_revision)

echo "[a19] 重建隔离库 ${DST_NAME}（源：${SRC_URL}）"
psql "$SRC_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists ${DST_NAME} with (force)"
psql "$SRC_URL" -v ON_ERROR_STOP=1 -q -c "create database ${DST_NAME}"

echo "[a19] 应用当前 warehouse schema（dwd + serving）"
psql "$DST_URL" -v ON_ERROR_STOP=1 -q -f "${WS}/warehouse/dwd/schema.sql"
psql "$DST_URL" -v ON_ERROR_STOP=1 -q -f "${WS}/warehouse/serving/schema.sql"

echo "[a19] 从源库复制合成 fixture 数据"
DUMP_ARGS=(--data-only --no-owner --no-privileges)
for t in "${TABLES[@]}"; do
  DUMP_ARGS+=(-t "$t")
done
pg_dump "${DUMP_ARGS[@]}" "$SRC_URL" | psql "$DST_URL" -v ON_ERROR_STOP=1 -q

echo "[a19] 校验"
psql "$DST_URL" -v ON_ERROR_STOP=1 -tAc \
  "select 'instruments=' || count(*) || ' display_safe_null=' || count(*) filter (where display_safe is null) from dim_instrument"
psql "$DST_URL" -v ON_ERROR_STOP=1 -tAc "select 'serving_view_rows=' || count(*) from serving.serving_instrument"
echo "[a19] 完成：${DST_URL}"
