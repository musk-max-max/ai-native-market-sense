#!/usr/bin/env bash
# test-entitlement-gap.sh —— 002_audit_gap 正/负样本（H4 m01788：只看 migrate exit 0 不够）
#
# 冻结口径（H4 m01852 + A11 m01917）：new_value.window_start / window_end（UTC ISO-8601 Z），
# lost_count>0、reason∈{transient_write_failure,process_restart}、owner、operator/deployment_uid 非空，
# 顶层 reason 必须 NULL。合法行必须插入成功；缺 window_end / 窗口反序必须被 CHECK 拒。
#
# 只允许一次性验收库：append-only 表里的测试行无法删除，必须限定在随时可 drop 的库上。
# 用法：infra/db/test-entitlement-gap.sh --dsn postgresql://... [--dry-run]
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
if [[ $DRY_RUN -eq 1 ]]; then
  echo "⏭ dry-run：验证「合法 audit_gap 插入成功 / 缺 window_start、缺 window_end、窗口反序、lost_count=0 均被 CHECK 拒 / chain=0」"
  exit 0
fi
[[ -n "$DSN" ]] || { echo "✗ 需要 --dsn（一次性验收库，不要指向生产）" >&2; exit 2; }
command -v psql >/dev/null 2>&1 || { echo "✗ 需要 psql" >&2; exit 2; }

DB_NAME=$(psql -X -q -At "$DSN" -c 'select current_database()')
case "$DB_NAME" in
  a13_verify|a5_*_test|*_e2e|*_test) ;;
  *) echo "✗ 拒绝在非一次性库 $DB_NAME 写入测试 gap（append-only 不可删）" >&2; exit 4 ;;
esac

psql_q() { psql -X -q -At -v ON_ERROR_STOP=1 "$DSN" "$@"; }
deploy_uid="gap-test-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
window_start=$(psql_q -c "select to_char(now() - interval '90 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
window_end=$(psql_q -c "select to_char(now() - interval '30 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
failures=0

# 正样本
if out=$(psql_q -c "INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid', 'A13',
    jsonb_build_object('window_start','$window_start','window_end','$window_end',
                       'lost_count',3,'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-valid')
  RETURNING event_key"); then
  echo "✅ 合法 audit_gap 插入成功（event_key=${out}）"
else
  echo "❌ 合法 audit_gap 被拒（002 CHECK 过严）"; failures=$((failures+1))
fi

# 负样本 1：缺 window_end
if out=$(psql "$DSN" -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-missing', 'A13',
    jsonb_build_object('window_start','$window_start','lost_count',1,
                       'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad1')" 2>&1); then
  echo "❌ 缺 window_end 的 audit_gap 竟然插入成功"; failures=$((failures+1))
else
  if grep -q "entitlement_events_audit_gap_chk" <<<"$out"; then
    echo "✅ 缺 window_end 被 entitlement_events_audit_gap_chk 拒绝"
  else
    echo "❌ 缺 window_end 被拒但不是预期 CHECK：$out"; failures=$((failures+1))
  fi
fi

# 负样本 2：窗口反序
if out=$(psql "$DSN" -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-reversed', 'A13',
    jsonb_build_object('window_start','$window_end','window_end','$window_start',
                       'lost_count',1,'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad2')" 2>&1); then
  echo "❌ 窗口反序的 audit_gap 竟然插入成功"; failures=$((failures+1))
else
  if grep -q "entitlement_events_audit_gap_chk" <<<"$out"; then
    echo "✅ 窗口反序被 CHECK 拒绝"
  else
    echo "❌ 窗口反序被拒但不是预期 CHECK：$out"; failures=$((failures+1))
  fi
fi

# 负样本 3：缺 window_start
if out=$(psql "$DSN" -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-no-start', 'A13',
    jsonb_build_object('window_end','$window_end','lost_count',1,
                       'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad3')" 2>&1); then
  echo "❌ 缺 window_start 的 audit_gap 竟然插入成功"; failures=$((failures+1))
else
  if grep -q "entitlement_events_audit_gap_chk" <<<"$out"; then
    echo "✅ 缺 window_start 被 CHECK 拒绝"
  else
    echo "❌ 缺 window_start 被拒但不是预期 CHECK：$out"; failures=$((failures+1))
  fi
fi

# 负样本 4：lost_count=0（写「丢了 0 条」是自欺）
if out=$(psql "$DSN" -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-zero', 'A13',
    jsonb_build_object('window_start','$window_start','window_end','$window_end',
                       'lost_count',0,'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad4')" 2>&1); then
  echo "❌ lost_count=0 的 audit_gap 竟然插入成功"; failures=$((failures+1))
else
  if grep -q "entitlement_events_audit_gap_chk" <<<"$out"; then
    echo "✅ lost_count=0 被 CHECK 拒绝"
  else
    echo "❌ lost_count=0 被拒但不是预期 CHECK：$out"; failures=$((failures+1))
  fi
fi

problems=$(psql_q -c "select count(*) from audit.verify_entitlement_chain()")
if [[ "$problems" == "0" ]]; then echo "✅ 插入后 chain_problems=0"; else echo "❌ chain_problems=$problems"; failures=$((failures+1)); fi
[[ $failures -eq 0 ]] || { echo "gap 正/负样本失败：$failures 项"; exit 1; }
echo "✅ audit_gap 正/负样本全部符合预期（库=${DB_NAME}，deployment_uid=${deploy_uid}）"
