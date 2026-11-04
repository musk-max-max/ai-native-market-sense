#!/bin/sh
# infra/db/bootstrap.sh —— 数据库底座 bootstrap（DWD → serving → 两角色/授权）
#
# WHY：A2 的 warehouse/dwd/schema.sql 与 warehouse/serving/schema.sql 是数据层 DDL 单一真源；
#      serving 的 view 依赖 dwd 表，顺序错了就建不出来。本脚本把顺序、幂等、权限收口固化，
#      不依赖任何人的「记得先跑哪个」。
#
# 容器兼容（Lead L77/ECS）：db-migrate 容器镜像是 postgres:16（Debian，/bin/sh=dash，无 bash/node），
#      因此本脚本必须保持 POSIX sh：不用 [[ ]] / 数组 / ${var,,} / 进程替换；
#      静态校验（node）只在有 node 时跑，容器内显式跳过并指向 CI 的 db-schema job。
#
# 边界（A13 硬规则）：
#   * 生产 schema 变更属于生产变更：必须经 IaC/流水线 + H5 人类确认，A13 只执行不自批。
#     本脚本在 production 下要求 APPROVAL_REF 且 ALLOW_PRODUCTION_BOOTSTRAP=1。
#   * dev / preview 环境可重复执行；全部 DDL 幂等（IF NOT EXISTS / CREATE OR REPLACE）。
#   * 不建业务表（watchlist_items 等由 services/*/migrations/ 管理，见 infra/scripts/db-migrate.sh）。
#
# 用法：
#   infra/db/bootstrap.sh --env dev [--dsn "$DATABASE_URL"] [--dry-run]
#   infra/db/bootstrap.sh --env preview --dsn ... --verify
#   APP_DB_MARKET_PASSWORD=... APP_DB_LOADER_PASSWORD=... infra/db/bootstrap.sh --env production --dsn ... \
#     ALLOW_PRODUCTION_BOOTSTRAP=1 APPROVAL_REF="<H5 批准链接>"
#
# 退出码：0 成功 / 2 用法或环境错误 / 3 生产未批准 / 4 前置检查失败 / 5 psql 执行失败
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
DB_DIR="${ROOT}/infra/db"
ENV_NAME=dev
DSN="${DATABASE_URL:-}"
DRY_RUN=0
VERIFY=0

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --dsn) DSN="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --verify) VERIFY=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1" >&2; usage ;;
  esac
done

case "$ENV_NAME" in
  dev|preview|production) ;;
  *) echo "ERROR: --env 必须是 dev|preview|production（收到：${ENV_NAME}）" >&2; exit 2 ;;
esac

log() { printf '\033[1;34m[db-bootstrap]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[db-bootstrap] ERROR:\033[0m %s\n' "$*" >&2; exit "${2:-4}"; }

# 临时文件（执行计划），退出时清理；POSIX 无数组，用换行分隔文件代替。
PLAN_FILE=$(mktemp)
cleanup() { rm -f "${PLAN_FILE:-}"; }
trap cleanup 0

# ---- 0. 静态自检（有 node 才跑；容器镜像无 node 时显式跳过，CI 独立跑） ------
log "静态校验 bootstrap 顺序 / 幂等 / 授权边界"
if command -v node >/dev/null 2>&1; then
  node "${ROOT}/infra/ci/check-db-bootstrap.mjs" || fail "静态校验失败（见上）" 4
else
  log "⏭ 容器内无 node：跳过静态校验（CI db-schema job 会独立运行 check-db-bootstrap.mjs；此处不伪装通过）"
fi

# ---- 1. 生产门禁 ------------------------------------------------------------
if [ "$ENV_NAME" = "production" ]; then
  [ "${ALLOW_PRODUCTION_BOOTSTRAP:-}" = "1" ] || fail "production bootstrap 未启用：需 ALLOW_PRODUCTION_BOOTSTRAP=1（生产变更须 IaC 流水线 + H5 批准）" 3
  [ -n "${APPROVAL_REF:-}" ] || fail "production bootstrap 缺少 APPROVAL_REF（H5 人类批准链接/工单号）" 3
  log "production 已批准：APPROVAL_REF=${APPROVAL_REF}"
fi

# ---- 2. 执行计划（DWD → serving → 角色 → 授权） ----------------------------
printf '%s\n' \
  "${ROOT}/warehouse/dwd/schema.sql" \
  "${ROOT}/warehouse/serving/schema.sql" \
  "${DB_DIR}/sql/10_roles.sql" > "$PLAN_FILE"
if [ -n "${APP_DB_MARKET_PASSWORD:-}" ] || [ -n "${APP_DB_LOADER_PASSWORD:-}" ]; then
  printf '%s\n' "${DB_DIR}/sql/15_role_passwords.sql" >> "$PLAN_FILE"
else
  log "未设置 APP_DB_MARKET_PASSWORD / APP_DB_LOADER_PASSWORD：跳过密码设置（角色保留现有密码；生产由 secret manager 注入）"
fi
printf '%s\n' "${DB_DIR}/sql/20_grants.sql" >> "$PLAN_FILE"
if [ "$VERIFY" = "1" ]; then
  printf '%s\n' "${DB_DIR}/sql/90_verify_privileges.sql" >> "$PLAN_FILE"
fi

PLAN_COUNT=$(wc -l < "$PLAN_FILE" | tr -d ' ')
log "环境=${ENV_NAME} 顺序=${PLAN_COUNT} 个文件"
while IFS= read -r f; do
  [ -f "$f" ] || fail "缺少文件：${f}" 4
  printf '  - %s\n' "${f#"$ROOT"/}"
done < "$PLAN_FILE"

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run：不连接数据库，不执行任何 DDL"
  exit 0
fi

# ---- 3. 前置检查 ------------------------------------------------------------
command -v psql >/dev/null 2>&1 || fail "psql 不存在：bootstrap 需要 PostgreSQL 16 客户端（本机无 psql 时只能 --dry-run）" 4
[ -n "$DSN" ] || fail "缺少 --dsn 或 DATABASE_URL" 2
case "$DSN" in
  *"@"*) ;;
  *) log "WARN: DSN 看起来不含主机/用户，确认不是空串或占位符" ;;
esac

# 单文件执行函数：密码仅经 psql 变量注入（有才加），--single-transaction 保证整体回滚。
# POSIX 无数组：用 set -- 重新组装参数，避免把密码拼进字符串后被再次分词。
psql_file() {
  _file=$1
  set -- -X -q -v ON_ERROR_STOP=1
  if [ -n "${APP_DB_MARKET_PASSWORD:-}" ]; then set -- "$@" -v "market_app_password=${APP_DB_MARKET_PASSWORD}"; fi
  if [ -n "${APP_DB_LOADER_PASSWORD:-}" ]; then set -- "$@" -v "warehouse_loader_password=${APP_DB_LOADER_PASSWORD}"; fi
  psql "$DSN" "$@" --single-transaction -f "$_file"
}

# ---- 4. 执行（单事务：任一文件失败则整体回滚） ------------------------------
log "apply 开始（--single-transaction，失败即整体回滚）"
started=$(date +%s)
while IFS= read -r f; do
  log "apply ${f#"$ROOT"/}"
  psql_file "$f" || fail "执行失败：${f}" 5
done < "$PLAN_FILE"
elapsed=$(( $(date +%s) - started ))
log "apply 完成，耗时 ${elapsed}s"

# ---- 5. 失败即中断后的收尾提示 ---------------------------------------------
log "校验建议（人工/监控侧）："
cat <<'EOF'
  psql "$DSN" -f infra/db/sql/90_verify_privileges.sql                          # 越权=0（六角色边界）
  psql "$DSN" -c "SET ROLE market_app; SELECT count(*) FROM serving.serving_quote_latest"       # 可读
  psql "$DSN" -c "SET ROLE market_app; SELECT count(*) FROM dwd_stock_bar_daily"               # 必须 permission denied
  psql "$DSN" -c "SET ROLE market_app; SELECT hold FROM audit.entitlement_hold_state"         # hold 只读视图
  psql "$DSN" -c "SET ROLE warehouse_loader; SELECT count(*) FROM serving.serving_quote_latest" # 必须 permission denied
  psql "$DSN" -c "SET ROLE audit_reader; SELECT * FROM audit.verify_entitlement_chain()"        # 空=链完整
  node infra/ci/check-db-bootstrap.mjs
EOF
log "OK"
