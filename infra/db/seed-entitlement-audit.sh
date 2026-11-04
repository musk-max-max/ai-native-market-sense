#!/usr/bin/env bash
# seed-entitlement-audit.sh —— release 验收栈的审计/控制表 seed（A11 需要可抽样数据）
#
# 约束（A5/H4/H5）：
#   - 事件表 audit.entitlement_events、控制表 audit.entitlement_hold（A5 canonical DDL；固定单行 PK=1；
#     不再使用 entitlement_control 这个旧名）。
#   - 只做 INSERT（事件表）与固定 control 行 upsert；不建表、不改 schema。
#   - 应用角色 market_app 仍只有 INSERT；本脚本使用迁移高权限 DSN（A11_AUDIT_DSN）。
#   - 迁移/DDL 未落地时明确退出 3，而不是静默跳过（A11：缺配置/缺表按失败，不 skip）。
#
# 用法：A11_AUDIT_DSN=postgresql://... infra/db/seed-entitlement-audit.sh [--dry-run]

set -euo pipefail

DSN="${A11_AUDIT_DSN:-}"
SEED_ENVIRONMENT="${SEED_ENVIRONMENT:-dev}"
DRY_RUN=0
RESTORE_FRESH=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  --restore-fresh) RESTORE_FRESH=1 ;;
esac

if [[ -z "$DSN" ]]; then
  echo "✗ 缺少 A11_AUDIT_DSN（迁移高权限 DSN；不能用应用角色，应用无 SELECT）" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "⏭ dry-run：本机无 psql，仅打印将执行的 seed（不验证表存在）"
    cat <<'SQL'
-- 期望 schema（A5 DDL 到达后生效）：
-- control 行：last_reconciled_at = now()-16min（只触发 #4 的 stale 断言；其余事件另算时间）
-- events：hold_set / hold_clear / deploy(deployment_uid=...)，各 1 条可抽样记录
SQL
    exit 0
  fi
  echo "✗ 需要 psql 连接 release 验收栈（本机无 psql 时只能 --dry-run）" >&2
  exit 2
fi

psql_q() { psql -X -q -v ON_ERROR_STOP=1 "$DSN" "$@"; }

HAS_EVENTS=$(psql -X -q -t -A "$DSN" -c "SELECT to_regclass('audit.entitlement_events') IS NOT NULL")
HAS_CONTROL=$(psql -X -q -t -A "$DSN" -c "SELECT to_regclass('audit.entitlement_hold') IS NOT NULL")

if [[ "$HAS_EVENTS" != "t" || "$HAS_CONTROL" != "t" ]]; then
  echo "✗ 审计/控制表未落地（events=$HAS_EVENTS control=$HAS_CONTROL）。" >&2
  echo "  需要 A13 迁移 A5 canonical migrations/001_audit_entitlement_events.sql（bootstrap 先建角色）；按失败处理，不 skip。" >&2
  exit 3
fi

if [[ $RESTORE_FRESH -eq 1 ]]; then
  # H4 m01399：stale 时间戳只服务 #4 的用例；用例跑完必须恢复 fresh，
  # 否则默认栈每次启动都是 fail-closed，A11 会把「环境坏了」误判成「判定对了」。
  SQL="UPDATE audit.entitlement_hold SET last_reconciled_at = now() WHERE id = 1;"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "⏭ dry-run：将把 last_reconciled_at 恢复为 now()：$SQL"
    exit 0
  fi
  echo "$SQL" | psql_q
  echo "✓ last_reconciled_at 已恢复 fresh（seed 的 stale 只用于 #4 用例）"
  exit 0
fi

SQL=$(cat <<'SQL'
BEGIN;
-- control 行：固定单行；last_reconciled_at 置 16 分钟前，供 A11 的 stale 断言抽样。
INSERT INTO audit.entitlement_hold
  (id, hold, hold_id, hold_reason, set_by, set_at, last_reconciled_at)
VALUES (1, false, NULL, NULL, 'seed:release-gate', now(), now() - interval '16 minutes')
ON CONFLICT (id) DO UPDATE
  SET last_reconciled_at = now() - interval '16 minutes'
  WHERE audit.entitlement_hold.hold = false;  -- 不覆盖运行时 hold；只更新对账时间

-- 每次运行使用随机 deployment_uid / hold_id，避免 event_key 唯一冲突。
SELECT gen_random_uuid() AS hold_id,
       'seed-deploy-' || substr(md5(random()::text), 1, 12) AS deploy_uid
\gset

-- 事件时间从「链头 + 1s」与 now()-5min 里取较晚者：seed 可重复执行且不触发时钟倒退。
SELECT GREATEST(
         now() - interval '5 minutes',
         COALESCE((SELECT max(occurred_at) FROM audit.entitlement_events), now() - interval '5 minutes')
           + interval '1 second'
       ) AS base_ts
\gset

-- 事件按时间顺序逐条 INSERT（触发器要求 occurred_at 不早于链头超过 1s；
-- 三个数据修改 CTE 的执行顺序未定义，不能用单语句插多条）。
INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, release_id, manifest_hash,
   executor, approver, approval_ref, approval_read_at, approval_read_by,
   config_fingerprint, trace_id)
VALUES
  ('deploy', :'base_ts'::timestamptz + interval '0 seconds', :'deploy_uid', 'seed-release', repeat('a', 64),
   'A13', 'H5', 'seed-approval-ref-' || substr(md5(random()::text), 1, 8),
   now() - interval '21 minutes', 'ci:seed', repeat('b', 64), 'seed-trace-deploy');

INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, reason, hold_id, old_value, new_value, trace_id)
VALUES
  ('hold_set', :'base_ts'::timestamptz + interval '1 second', :'deploy_uid', 'hold_active', :'hold_id'::uuid,
   '{"hold": false}'::jsonb,
   jsonb_build_object('hold', true, 'hold_id', :'hold_id', 'reason', 'seed'),
   'seed-trace-hold-set');

INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, reason, hold_id, hold_ticket, hold_signer,
   authorization_doc_sha256, authorization_doc_id, clause_locator, authorization_valid_until,
   old_value, new_value, trace_id)
VALUES
  ('hold_clear', :'base_ts'::timestamptz + interval '2 seconds', :'deploy_uid', 'manual_signoff', :'hold_id'::uuid,
   'seed-ticket-001', 'H5', repeat('c', 64), 'seed-doc-id', 'L30.1',
   now() + interval '30 days',
   '{"hold": true}'::jsonb,
   jsonb_build_object('hold', false, 'hold_id', :'hold_id', 'reason', 'manual_signoff'),
   'seed-trace-hold-clear');

-- A11 #6 抽样覆盖：events 9 类里至少 7 类可抽样；以下补齐 expired/flip/tier_switch/clause_review。
-- 时间必须严格递增（触发器拒绝时钟倒退），随机量用于避开 event_key 唯一键（重跑不撞）。
INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, reason, configured_tier, effective_tier,
   expires_at, trace_id)
VALUES
  ('entitlement_expired', :'base_ts'::timestamptz + interval '3 seconds', :'deploy_uid', 'expires_at_passed',
   'c_end_display', 'internal_eval',
   now() - interval '2 days' - (floor(random() * 3600) || ' seconds')::interval,
   'seed-trace-expired');

INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, boot_id, state_version, reason,
   old_value, new_value, trace_id)
VALUES
  ('entitlement_flip', :'base_ts'::timestamptz + interval '4 seconds', :'deploy_uid', gen_random_uuid(), 2,
   'env_change',
   '{"effective_tier": "c_end_display"}'::jsonb,
   '{"effective_tier": "internal_eval"}'::jsonb,
   'seed-trace-flip');

INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, reason, approval_ref, executor, approver,
   old_value, new_value, trace_id)
VALUES
  ('tier_switch', :'base_ts'::timestamptz + interval '5 seconds',
   'seed-switch-' || substr(md5(random()::text), 1, 12), 'manual_signoff',
   'seed-approval-switch-' || substr(md5(random()::text), 1, 16),
   'A13', 'H5',
   '{"effective_tier": "internal_eval"}'::jsonb,
   '{"effective_tier": "c_end_display"}'::jsonb,
   'seed-trace-tier-switch');

INSERT INTO audit.entitlement_events
  (event_type, occurred_at, deployment_uid, reason, authorization_doc_sha256,
   authorization_doc_id, clause_locator, operator, authorization_valid_until,
   new_value, trace_id)
VALUES
  ('clause_review', :'base_ts'::timestamptz + interval '6 seconds', :'deploy_uid', 'clause_change',
   md5(random()::text) || md5(random()::text),
   'seed-doc-clause-' || substr(md5(random()::text), 1, 8),
   'L' || (1 + floor(random() * 30)::int) || '.' || (1 + floor(random() * 8)::int),
   'A16',
   now() + interval '90 days',
   '{"verdict": "allow", "seed": true}'::jsonb,
   'seed-trace-clause-review');
COMMIT;
SQL
)

if [[ $DRY_RUN -eq 1 ]]; then
  echo "⏭ dry-run：将执行 seed（rollback）："
  echo "$SQL"
  exit 0
fi

echo "$SQL" | psql_q
echo "✓ entitlement audit/control seed 完成（control.last_reconciled_at = now()-16min；events 7 类：deploy/hold_set/hold_clear/entitlement_expired/entitlement_flip/tier_switch/clause_review）"
