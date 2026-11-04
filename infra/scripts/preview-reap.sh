#!/usr/bin/env bash
# infra/scripts/preview-reap.sh —— 回收超龄 PR 预览环境（成本兜底，A13）
#
# WHY：每个 preview = 一个 namespace + 一套 Helm release + 本地 state；磁盘/配额有限，
#      不能只依赖「PR 关闭」事件（人可能直接删分支、事件可能丢）。本脚本是兜底回收器：
#        * 依据：.preview-state/pr-<n>.tfstate 的 mtime（最近一次 apply 时间）；
#        * 兜底：即使 state 丢了，也用 helm list 找 market-sense-pr-<n> release，按 updated 时间判断；
#        * 默认 TTL 24h（PREVIEW_TTL_HOURS 可覆盖，上限由 Terraform 变量同样约束为 72h）。
#
# 用法：
#   PREVIEW_TTL_HOURS=24 bash infra/scripts/preview-reap.sh            # 真回收
#   PREVIEW_TTL_HOURS=24 bash infra/scripts/preview-reap.sh --dry-run  # 只列出将被回收的 PR
#
# 依赖：helm（集群访问）；terraform 仅在 state 存在时需要。无 KUBECONFIG 时脚本明确报错退出 2。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TTL_HOURS="${PREVIEW_TTL_HOURS:-24}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

case "$TTL_HOURS" in
  ''|*[!0-9]*) echo "ERROR: PREVIEW_TTL_HOURS 必须是正整数（收到：${TTL_HOURS}）" >&2; exit 2 ;;
esac
if [[ "$TTL_HOURS" -lt 1 || "$TTL_HOURS" -gt 72 ]]; then
  echo "ERROR: PREVIEW_TTL_HOURS 必须在 1..72（成本约束，默认 24）" >&2; exit 2
fi

log() { printf '[preview-reap] %s\n' "$*"; }
warn() { printf '[preview-reap] WARN: %s\n' "$*" >&2; }

command -v helm >/dev/null 2>&1 || { echo "ERROR: 需要 helm（无 KUBECONFIG 或未装 helm 时不能回收）" >&2; exit 2; }
if [[ -z "${KUBECONFIG:-}" && ! -d "${HOME}/.kube" ]]; then
  echo "ERROR: 没有 KUBECONFIG 且 ~/.kube 不存在：无法访问集群，拒绝假装回收成功" >&2
  exit 2
fi

now="$(date +%s)"
reaped=0
seen=""

# 1) 以 state 文件为准（最近一次 apply 的 mtime）
for state in "${ROOT}"/.preview-state/pr-*.tfstate; do
  [[ -e "$state" ]] || continue
  pr="$(basename "$state" | sed -E 's/^pr-([0-9]+)\.tfstate$/\1/')"
  [[ "$pr" =~ ^[0-9]+$ ]] || continue
  mtime="$(stat -f %m "$state" 2>/dev/null || stat -c %Y "$state")"
  age_h=$(( (now - mtime) / 3600 ))
  if (( age_h >= TTL_HOURS )); then
    log "PR #${pr} 的 state 已 ${age_h}h 未更新（TTL=${TTL_HOURS}h）"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "dry-run：将执行 preview-down.sh ${pr}"
    else
      bash "${ROOT}/infra/scripts/preview-down.sh" "$pr" || warn "PR #${pr} 回收失败（继续处理其余，CI 会报警）"
      reaped=$((reaped + 1))
    fi
    seen="${seen} ${pr}"
  fi
done

# 2) 兜底：state 丢失但 release 还在的（按 helm release updated 时间）
if command -v python3 >/dev/null 2>&1; then
  releases_json="$(helm list -A -o json 2>/dev/null || echo '[]')"
  while IFS=$'\t' read -r pr age_h; do
    [[ -n "$pr" ]] || continue
    case " ${seen} " in *" ${pr} "*) continue ;; esac
    log "release market-sense-pr-${pr} 无本地 state，已存在 ${age_h}h"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "dry-run：将执行 preview-down.sh ${pr}"
    else
      bash "${ROOT}/infra/scripts/preview-down.sh" "$pr" || warn "PR #${pr} 回收失败（可能缺 terraform state，需人工确认 namespace）"
      reaped=$((reaped + 1))
    fi
  done < <(printf '%s' "$releases_json" | python3 -c '
import json, re, sys, datetime
now = datetime.datetime.now(datetime.timezone.utc)
for r in json.load(sys.stdin):
    name = r.get("name", "")
    ns = r.get("namespace", "")
    m = re.match(r"^market-sense-pr-(\d+)$", name)
    if not m:
        continue
    if ns != f"market-sense-preview-pr-{m.group(1)}":
        continue
    try:
        updated = datetime.datetime.fromisoformat(r["updated"].replace("Z", "+00:00"))
    except Exception:
        continue
    hours = int((now - updated).total_seconds() // 3600)
    print(f"{m.group(1)}\t{hours}")
')
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run 完成（TTL=${TTL_HOURS}h）；未回收任何资源"
else
  log "完成：回收 ${reaped} 个 preview（TTL=${TTL_HOURS}h）"
fi
