#!/usr/bin/env bash
# test-entitlement-gap.sh —— 002_audit_gap 正/负样本（H4 m01788：只看 migrate exit 0 不够）
#
# 口径（H4 m01852/m01990 + A11 m01917）：
#   - new_value.window_start / window_end（UTC ISO-8601 Z），lost_count>0（null 出口按最终 002：
#     仅 reason=process_restart 允许 null），reason∈{transient_write_failure,process_restart}，
#     owner、operator、deployment_uid 非空，顶层 reason 必须 NULL。
#   - 合法行必须插入成功；缺 window_start / 缺 window_end / 窗口反序 / lost_count=0 必须 23514。
#   - 负样本不仅看报错：被拒行的 trace_id 在库里行数必须 = 0（证明没插入）。
#   - 每条都取真实 psql exit code + SQLSTATE 原文，不靠 `| tail` 或输出文本猜。
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
  echo "⏭ dry-run：合法 gap 成功；transient+null 拒、process_restart+null 通过；缺 window_start/window_end、窗口反序、lost_count=0 均 23514 且行数=0"
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
count_trace() { psql_q -c "select count(*) from audit.entitlement_events where trace_id = '$1'"; }

deploy_uid="gap-test-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
window_start=$(psql_q -c "select to_char(now() - interval '90 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
window_end=$(psql_q -c "select to_char(now() - interval '30 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
failures=0

insert_ok() { # label trace sql -> asserts exit 0, exactly 1 row, returns output
  local label="$1" trace="$2" sql="$3" out rc=0
  set +e
  out=$(psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$DSN" -c "$sql" 2>&1)
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "❌ ${label}：期望成功，psql exit=${rc}；输出：$out"; failures=$((failures+1)); return 1
  fi
  local n; n=$(count_trace "$trace")
  if [[ "$n" == "1" ]]; then
    echo "✅ ${label}：插入成功（psql exit=0），库中恰好 1 行"
  else
    echo "❌ ${label}：插入报成功但库中 $n 行（期望 1）"; failures=$((failures+1)); return 1
  fi
  printf '%s\n' "$out"
}

insert_reject() { # label trace sql -> asserts non-zero, 23514 text, 0 rows
  local label="$1" trace="$2" sql="$3" out rc=0
  set +e
  out=$(psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$DSN" -c "$sql" 2>&1)
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    echo "❌ ${label}：psql exit=0，竟然插入成功"; failures=$((failures+1)); return 1
  fi
  local n; n=$(count_trace "$trace")
  if [[ "$n" != "0" ]]; then
    echo "❌ ${label}：虽报错但库里残留 $n 行（期望 0）"; failures=$((failures+1)); return 1
  fi
  if grep -q '23514' <<<"$out" && grep -q 'entitlement_events_audit_gap_chk' <<<"$out"; then
    echo "✅ ${label}：psql exit=${rc}、SQLSTATE 23514、entitlement_events_audit_gap_chk、库中 0 行"
  else
    echo "❌ ${label}：被拒但不是预期原因（期望 23514+audit_gap_chk）；输出：$out"; failures=$((failures+1)); return 1
  fi
}

trace_valid="seed:trace-gap-valid-$deploy_uid"
insert_ok "合法 audit_gap（transient_write_failure, lost_count=3）" "$trace_valid" \
"INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid', 'A13',
    jsonb_build_object('window_start','$window_start','window_end','$window_end',
                       'lost_count',3,'reason','transient_write_failure','owner','H4'),
    '$trace_valid')
  RETURNING event_key" >/tmp/gap-valid.out || true
grep -q '^gap|' /tmp/gap-valid.out && echo "   event_key=$(head -1 /tmp/gap-valid.out)"

insert_reject "缺 window_start" "seed:trace-gap-bad-start-$deploy_uid" \
"INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-no-start', 'A13',
    jsonb_build_object('window_end','$window_end','lost_count',1,
                       'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad-start-$deploy_uid')"

insert_reject "缺 window_end" "seed:trace-gap-bad-end-$deploy_uid" \
"INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-no-end', 'A13',
    jsonb_build_object('window_start','$window_start','lost_count',1,
                       'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad-end-$deploy_uid')"

insert_reject "window_end < window_start" "seed:trace-gap-bad-rev-$deploy_uid" \
"INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-rev', 'A13',
    jsonb_build_object('window_start','$window_end','window_end','$window_start',
                       'lost_count',1,'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad-rev-$deploy_uid')"

insert_reject "lost_count=0" "seed:trace-gap-bad-zero-$deploy_uid" \
"INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-zero', 'A13',
    jsonb_build_object('window_start','$window_start','window_end','$window_end',
                       'lost_count',0,'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad-zero-$deploy_uid')"

insert_reject "transient_write_failure + lost_count=null" "seed:trace-gap-bad-null-$deploy_uid" \
"INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-null-transient', 'A13',
    jsonb_build_object('window_start','$window_start','window_end','$window_end',
                       'lost_count',null,'reason','transient_write_failure','owner','H4'),
    'seed:trace-gap-bad-null-$deploy_uid')"

trace_restart="seed:trace-gap-restart-null-$deploy_uid"
insert_ok "process_restart + lost_count=null（重启后计数不可知，唯一可审计出口）" "$trace_restart" \
"INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-restart', 'A13',
    jsonb_build_object('window_start','$window_start','window_end','$window_end',
                       'lost_count',null,'reason','process_restart','owner','H4'),
    '$trace_restart')
  RETURNING event_key"

insert_reject "process_restart + lost_count=0" "seed:trace-gap-bad-restart-zero-$deploy_uid" \
"INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, operator, new_value, trace_id)
  VALUES ('audit_gap', now(), '$deploy_uid-restart-zero', 'A13',
    jsonb_build_object('window_start','$window_start','window_end','$window_end',
                       'lost_count',0,'reason','process_restart','owner','H4'),
    'seed:trace-gap-bad-restart-zero-$deploy_uid')"

problems=$(psql_q -c 'select count(*) from audit.verify_entitlement_chain()')
if [[ "$problems" == "0" ]]; then echo "✅ chain_problems=0"; else echo "❌ chain_problems=$problems"; failures=$((failures+1)); fi
[[ $failures -eq 0 ]] || { echo "gap 正/负样本失败：$failures 项"; exit 1; }
echo "✅ audit_gap 正/负样本全部符合预期（库=${DB_NAME}，deployment_uid=${deploy_uid}）"
