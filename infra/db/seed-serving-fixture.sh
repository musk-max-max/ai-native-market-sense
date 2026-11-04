#!/usr/bin/env bash
# seed-serving-fixture.sh —— 给 scratch/验收库补最小 serving 数据（A11 #4 需要 SSE:600519 存在）
#
# 用途：release / 真栈验收时，API 对未知标的先返回 404，到不了 entitlement 403；
#       #4 hold/stale 需要至少一个「存在且可报价」的标的。生产不用本脚本。
# 约束：只 INSERT fixture 行（idempotent upsert）；不建表、不改 schema、不碰真实数据。
# 用法：infra/db/seed-serving-fixture.sh --dsn postgresql://... [--dry-run]
set -euo pipefail

DSN=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsn) DSN="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
[[ -n "$DSN" ]] || { echo "✗ 需要 --dsn（本地/验收库，不要指向生产）" >&2; exit 2; }

SQL=$(cat <<'SQL'
BEGIN;
INSERT INTO dim_instrument
  (instrument_id, exchange, code, name, board, security_type, list_status, lot_size,
   listed_at, display_safe, source, as_of, fetched_at, ingested_at)
VALUES
  ('SSE:600519', 'SSE', '600519', '贵州茅台', 'main', 'stock', 'listed', 100,
   DATE '2001-08-27', true, 'fixture', now(), now(), now())
ON CONFLICT (instrument_id) DO UPDATE
  SET display_safe = true, source = 'fixture', as_of = now(), fetched_at = now(), ingested_at = now();

INSERT INTO dwd_stock_bar_daily
  (instrument_id, trade_date, open, high, low, close, volume, amount, prev_close,
   source, as_of, fetched_at, batch_id, revision, ingested_at)
VALUES
  ('SSE:600519', CURRENT_DATE - 1, 1500.00, 1520.00, 1490.00, 1510.00,
   1000000, 1510000000.00, 1495.00, 'fixture', now(), now(), 'fixture-batch', 0, now())
ON CONFLICT (instrument_id, trade_date) DO NOTHING;

INSERT INTO dwd_adj_factor
  (instrument_id, trade_date, factor, source, as_of, fetched_at, batch_id, revision, ingested_at)
VALUES
  ('SSE:600519', CURRENT_DATE - 1, 1.0, 'fixture', now(), now(), 'fixture-batch', 0, now())
ON CONFLICT (instrument_id, trade_date) DO NOTHING;
COMMIT;
SQL
)

if [[ $DRY_RUN -eq 1 ]]; then
  echo "⏭ dry-run：将 upsert fixture（SSE:600519 + 1 根日线 + 因子）"
  exit 0
fi
command -v psql >/dev/null 2>&1 || { echo "✗ 需要 psql" >&2; exit 2; }
echo "$SQL" | psql -X -q -v ON_ERROR_STOP=1 "$DSN"
echo "✓ serving fixture 已写入（SSE:600519，display_safe=true，source=fixture）"
