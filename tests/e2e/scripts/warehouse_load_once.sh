#!/bin/sh
# 契约 §1 第 2 步（load）：A2 `python -m warehouse.load` ODS → DWD/serving 幂等 upsert + 质量门禁。
# 在 A2 的 warehouse 镜像内执行（不塞进 ingest 镜像，Lead m01015 裁定）。
# 退出码 0/1（质量红黑拒绝写库）/2（env/DB/schema）/3（输入缺失）由 A2 定义；
# 本脚本只记录 step 结果，不改变语义。
set -u

ODS_ROOT="${ODS_ROOT:-/data/ods}"
AUDIT_ROOT="${AUDIT_ROOT:-/data/audit}"
QUALITY_PATH="${QUALITY_REPORT_PATH:-/state/quality.json}"
STEP_FILE="${STEP_LOAD_FILE:-/state/step-load.json}"
LOAD_CMD="${LOAD_INNER_CMD:-python -m warehouse.load --ods-root $ODS_ROOT --manifest-root $AUDIT_ROOT --dsn ${DATABASE_URL:-}}"
mkdir -p "$(dirname "$QUALITY_PATH")" "$(dirname "$STEP_FILE")" 2>/dev/null || true
export ODS_DIR="$ODS_ROOT" QUALITY_REPORT_PATH="$QUALITY_PATH"

echo "[load] ODS_DIR=$ODS_ROOT QUALITY_REPORT_PATH=$QUALITY_PATH"
rc=0
if ! python -c "import warehouse.load" >/dev/null 2>&1; then
  echo "[load] 镜像内没有 warehouse 模块（A2 Dockerfile 未就绪或入口不对）" >&2
  rc=2
else
  # shellcheck disable=SC2086
  $LOAD_CMD || rc=$?
fi

case "$rc" in
  0) detail="OK" ;;
  1) detail="QUALITY_RED" ;;
  2) detail="ENV" ;;
  3) detail="INPUT_MISSING" ;;
  *) detail="UNKNOWN" ;;
esac
tmp="${STEP_FILE}.tmp"
printf '{"exit_code": %s, "detail": "%s"}\n' "$rc" "$detail" > "$tmp" && mv "$tmp" "$STEP_FILE"
echo "[load] rc=$rc detail=$detail step_file=$STEP_FILE"
exit "$rc"
