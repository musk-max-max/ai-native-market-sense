#!/bin/sh
# 契约 §1 第 1 步（ingress）：A1 adapter 录播回放 → ODS display/internal + audit manifest。
# 由 compose `ingress` 服务执行（A1 镜像，入口 python -m market_ingest）。
# 退出码：0 成功；21 配额/限流；22 网络/上游 5xx；其他非 0 未分类。
# 结果写 /state/step-ingest.json，供 ingest-report（第 4 步）聚合；本脚本不写 ingest-report。
set -u

MARKET_NOW="${MARKET_NOW:-2026-11-04T15:00:00+08:00}"
ODS_ROOT="${ODS_ROOT:-/data/ods}"
INGEST_DB="${INGEST_DB:-/data/ingest.db}"
AUDIT_ROOT="${AUDIT_ROOT:-/data/audit}"
STEP_FILE="${STEP_INGEST_FILE:-/state/step-ingest.json}"
CSV_FILE="${INGEST_CSV_FILE:-/app/data/instruments/base_info.csv}"
TERMS_FILE="${INGEST_TERMS_FILE:-/app/services/ingest/config/terms-synthetic.txt}"
BARS_START="${INGEST_BARS_START:-2026-10-28}"
BARS_END="${INGEST_BARS_END:-2026-11-03}"
export MARKET_NOW
mkdir -p "$ODS_ROOT" "$AUDIT_ROOT" "$(dirname "$STEP_FILE")" 2>/dev/null || true

echo "[ingress] MARKET_NOW=$MARKET_NOW"
rc_instruments=0
python -m market_ingest sync-instruments --source csv \
  --csv-file "$CSV_FILE" --channel manual_import \
  --operator e2e-seed \
  --source-url "https://example.invalid/e2e/base_info.csv" \
  --terms-version synthetic-terms-v1 --terms-file "$TERMS_FILE" \
  --credential-ref "sha256:$(sha256sum "$CSV_FILE" | cut -d' ' -f1)" \
  --manifest-root "$AUDIT_ROOT" --ods-root "$ODS_ROOT" --db "$INGEST_DB" || rc_instruments=$?

rc_bars=0
if [ "$rc_instruments" -eq 0 ]; then
  python -m market_ingest sync-bars --start "$BARS_START" --end "$BARS_END" \
    --ods-root "$ODS_ROOT" --db "$INGEST_DB" --budget-calls 100 || rc_bars=$?
else
  echo "[ingress] skip sync-bars: sync-instruments rc=${rc_instruments}"
fi
rc=0
[ "$rc_instruments" -ne 0 ] && rc="$rc_instruments"
[ "$rc" -eq 0 ] && [ "$rc_bars" -ne 0 ] && rc="$rc_bars"

case "$rc" in
  0) detail="OK" ;;
  21) detail="QUOTA" ;;
  22) detail="UPSTREAM" ;;
  *) detail="UNKNOWN" ;;
esac
tmp="${STEP_FILE}.tmp"
printf '{"exit_code": %s, "detail": "%s"}\n' "$rc" "$detail" > "$tmp" && mv "$tmp" "$STEP_FILE"
echo "[ingress] rc=$rc detail=$detail step_file=$STEP_FILE"
exit "$rc"
