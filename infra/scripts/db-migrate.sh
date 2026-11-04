#!/bin/sh
# infra/scripts/db-migrate.sh —— 业务表迁移执行器（生产迁移唯一入口）
#
# WHY：A3 交付幂等 migration（services/*/migrations/*.sql）；执行动作归 A13 流水线。
#      本脚本用 ledger 记录「文件 + sha256 + 时间 + 执行人」，保证：
#        * 重复跑不重复执行（幂等）；
#        * 已执行文件被篡改会在下次部署直接失败（可审计）；
#        * 同一时刻只有一个迁移在跑（advisory lock）；
#        * 生产迁移前强制备份，且必须有 H5 批准的 APPROVAL_REF（A13 只执行不自批）。
#
# 容器兼容（Lead L77/ECS）：db-migrate 容器镜像是 postgres:16（Debian，/bin/sh=dash，无 bash/node），
#      本脚本保持 POSIX sh：不用数组 / [[ ]] / 进程替换 / $'\t' / declare；
#      需要 psql/pg_dump/sha256sum（postgres:16 镜像具备）。
#
# 边界：E2E_MODE 下 A3 的插件允许自动 CREATE TABLE（本地/CI 用），不经过本脚本；
#      生产/共享环境禁止自动建表，只走本脚本。
#
# 用法：
#   infra/scripts/db-migrate.sh --env dev [--dsn "$DATABASE_URL"] [--dry-run]
#   infra/scripts/db-migrate.sh --env production --dsn ... [--dry-run]
#       production 需要：APPROVAL_REF=<H5 批准链接>，以及 pg_dump（备份到 BACKUP_DIR，默认 ./backups）
#
# 退出码：0 成功 / 2 用法错误 / 3 生产未批准 / 4 前置检查失败 / 5 迁移失败
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_NAME=dev
DSN="${DATABASE_URL:-}"
DRY_RUN=0
BACKUP_DIR="${BACKUP_DIR:-${ROOT}/backups}"

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --dsn) DSN="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1" >&2; usage ;;
  esac
done

case "$ENV_NAME" in
  dev|preview|production) ;;
  *) echo "ERROR: --env 必须是 dev|preview|production" >&2; exit 2 ;;
esac

log()  { printf '\033[1;34m[db-migrate]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[db-migrate] ERROR:\033[0m %s\n' "$*" >&2; exit "${2:-4}"; }

# POSIX 无数组：文件清单、待执行清单、ledger 快照都用临时文件（换行分隔）。
FILES_FILE=$(mktemp)
PENDING_FILE=$(mktemp)
LEDGER_FILE=$(mktemp)
SQL_FILE=$(mktemp)
cleanup() { rm -f "${FILES_FILE:-}" "${PENDING_FILE:-}" "${LEDGER_FILE:-}" "${SQL_FILE:-}"; }
trap cleanup 0

# ---- 1. 发现迁移文件（services/<svc>/migrations/*.sql + infra/db/migrations/*.sql） --
# 跨域/基础设施表（如 audit.entitlement_events）放 infra/db/migrations/，由 A13 署名；
# 业务表仍放 services/<svc>/migrations/，由各域 owner 署名。统一进同一 ledger。
{
  find "${ROOT}/services" -path '*/migrations/*.sql' -type f 2>/dev/null || true
  find "${ROOT}/infra/db/migrations" -maxdepth 1 -name '*.sql' -type f 2>/dev/null || true
} | sort > "$FILES_FILE"
FILES_COUNT=$(wc -l < "$FILES_FILE" | tr -d ' ')
if [ "$FILES_COUNT" -eq 0 ]; then
  log "没有发现 services/*/migrations/*.sql 或 infra/db/migrations/*.sql，无需迁移"
  exit 0
fi

log "发现 ${FILES_COUNT} 个迁移（env=${ENV_NAME}）"
while IFS= read -r f; do printf '  - %s\n' "${f#"$ROOT"/}"; done < "$FILES_FILE"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else fail "需要 sha256sum 或 shasum 计算校验和" 4; fi
}

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run：不连接数据库；以下为文件与校验和"
  while IFS= read -r f; do
    printf '  %s  %s\n' "$(hash_file "$f")" "${f#"$ROOT"/}"
  done < "$FILES_FILE"
  log "dry-run 结束"
  exit 0
fi

# ---- 2. 前置检查 --------------------------------------------------------------
command -v psql >/dev/null 2>&1 || fail "psql 不存在（本机无 psql 时只能 --dry-run）" 4
[ -n "$DSN" ] || fail "缺少 --dsn 或 DATABASE_URL" 2

if [ "$ENV_NAME" = "production" ]; then
  [ -n "${APPROVAL_REF:-}" ] || fail "production 迁移缺少 APPROVAL_REF（H5 人类批准链接/工单号）" 3
  command -v pg_dump >/dev/null 2>&1 || fail "production 迁移前必须备份：pg_dump 不存在" 3
  log "production 已批准：APPROVAL_REF=${APPROVAL_REF}"
fi

# 单文件执行函数（POSIX 无数组；set -- 组装参数，密码不拼字符串）。
psql_file() {
  _file=$1
  set -- -X -q -v ON_ERROR_STOP=1
  if [ -n "${APP_DB_MARKET_PASSWORD:-}" ]; then set -- "$@" -v "market_app_password=${APP_DB_MARKET_PASSWORD}"; fi
  if [ -n "${APP_DB_LOADER_PASSWORD:-}" ]; then set -- "$@" -v "warehouse_loader_password=${APP_DB_LOADER_PASSWORD}"; fi
  psql "$DSN" "$@" --single-transaction -f "$_file"
}

psql_stdin() {
  set -- -X -q -v ON_ERROR_STOP=1
  if [ -n "${APP_DB_MARKET_PASSWORD:-}" ]; then set -- "$@" -v "market_app_password=${APP_DB_MARKET_PASSWORD}"; fi
  if [ -n "${APP_DB_LOADER_PASSWORD:-}" ]; then set -- "$@" -v "warehouse_loader_password=${APP_DB_LOADER_PASSWORD}"; fi
  psql "$DSN" "$@"
}

# ---- 3. ledger（幂等 + 审计） -------------------------------------------------
psql_stdin <<'SQL'
CREATE SCHEMA IF NOT EXISTS meta;
CREATE TABLE IF NOT EXISTS meta.schema_migrations (
  filename    text        PRIMARY KEY,
  sha256      text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text        NOT NULL DEFAULT current_user
);
COMMENT ON TABLE meta.schema_migrations IS '业务表迁移 ledger：文件+sha256 只增不改；篡改即部署失败（A13 执行）';
SQL

TAB_SEP=$(printf '\t')
psql "$DSN" -X -q -v ON_ERROR_STOP=1 -At -F "$TAB_SEP" \
  -c 'SELECT filename, sha256 FROM meta.schema_migrations ORDER BY filename' > "$LEDGER_FILE"

# ---- 4. 计算待执行集合 --------------------------------------------------------
: > "$PENDING_FILE"
while IFS= read -r f; do
  rel="${f#"$ROOT"/}"
  checksum=$(hash_file "$f")
  applied_checksum=$(awk -F "$TAB_SEP" -v n="$rel" '$1 == n { print $2; exit }' "$LEDGER_FILE")
  if [ -n "$applied_checksum" ]; then
    if [ "$applied_checksum" != "$checksum" ]; then
      fail "迁移文件已被篡改：${rel}（ledger=${applied_checksum} current=${checksum}）——禁止改写已执行迁移，请新增迁移" 5
    fi
    continue
  fi
  printf '%s\n' "$f" >> "$PENDING_FILE"
done < "$FILES_FILE"

PENDING_COUNT=$(wc -l < "$PENDING_FILE" | tr -d ' ')
if [ "$PENDING_COUNT" -eq 0 ]; then
  log "所有迁移均已执行（${FILES_COUNT} 个），无需变更"
  exit 0
fi

log "待执行 ${PENDING_COUNT} 个："
while IFS= read -r f; do printf '  + %s\n' "${f#"$ROOT"/}"; done < "$PENDING_FILE"

# ---- 5. 生产备份（先备份后迁移） ----------------------------------------------
if [ "$ENV_NAME" = "production" ]; then
  mkdir -p "$BACKUP_DIR"
  backup="${BACKUP_DIR}/prod-$(date -u +%Y%m%dT%H%M%SZ).dump"
  log "production 备份 → ${backup}"
  pg_dump "$DSN" -Fc -f "$backup" || fail "pg_dump 备份失败：中止迁移（不允许无备份改生产）" 5
  [ -s "$backup" ] || fail "备份文件为空：中止迁移" 5
fi

# ---- 6. 逐个执行（单文件单事务；advisory lock 防并发） ------------------------
started=$(date +%s)
while IFS= read -r f; do
  rel="${f#"$ROOT"/}"
  checksum=$(hash_file "$f")
  log "apply ${rel}"
  {
    echo 'BEGIN;'
    echo "SET lock_timeout = '5s';"
    echo "SELECT pg_advisory_xact_lock(hashtext('market_sense_migrations'));"
    cat "$f"
    printf "INSERT INTO meta.schema_migrations (filename, sha256) VALUES ('%s', '%s');\n" "$rel" "$checksum"
    echo 'COMMIT;'
  } > "$SQL_FILE"
  if ! psql_file "$SQL_FILE"; then
    fail "迁移失败：${rel}（事务已回滚，ledger 未写入）" 5
  fi
done < "$PENDING_FILE"

elapsed=$(( $(date +%s) - started ))
log "迁移完成：${PENDING_COUNT} 个，耗时 ${elapsed}s"

# ---- 6.5 迁移后重放 serving 视图（列变更后必须重放；单一真源在 A2） ----------
# WHY：CREATE OR REPLACE VIEW 依赖列在创建时已存在。002_display_safe 给旧库补列后，
#      serving.serving_instrument 必须重新编译，否则旧定义（或无定义）继续引用缺列。
# 幂等：schema.sql 全部为 CREATE OR REPLACE / CREATE SCHEMA IF NOT EXISTS。
SERVING_SQL="${ROOT}/warehouse/serving/schema.sql"
if [ -f "$SERVING_SQL" ]; then
  log "重放 serving 视图（warehouse/serving/schema.sql，幂等）"
  psql_file "$SERVING_SQL" || fail "serving 视图重放失败：${SERVING_SQL}" 5
fi

# ---- 7. 迁移后重跑授权与断言（新表授权不靠人记；幂等） ----------------------
GRANTS_SQL="${ROOT}/infra/db/sql/20_grants.sql"
VERIFY_SQL="${ROOT}/infra/db/sql/90_verify_privileges.sql"
if [ -f "$GRANTS_SQL" ]; then
  log "重跑授权（迁移后新表：watchlist_items / audit.entitlement_events）"
  psql_file "$GRANTS_SQL" || fail "授权文件执行失败：${GRANTS_SQL}" 5
fi
if [ -f "$VERIFY_SQL" ]; then
  log "运行权限断言（越权=0 且应有权限齐备）"
  psql_file "$VERIFY_SQL" || fail "权限断言失败：见上（禁止带越权部署）" 5
fi

log "OK"
