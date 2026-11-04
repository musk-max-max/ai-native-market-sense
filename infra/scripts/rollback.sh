#!/usr/bin/env bash
# market-sense-h5 · 一键回滚（SLO：≤5min；生产必须 H5 批准，A13 执行，不能自批）
#
# 用法：
#   infra/scripts/rollback.sh <env> <release> [--to <revision>]
#   env: dev | preview | production
#   preview 需 PR_NUMBER 环境变量；production 需 APPROVAL_REF（H5 审批单号/链接）
#
# 示例：
#   infra/scripts/rollback.sh dev market-sense-dev
#   APPROVAL_REF=gh-issue-123 infra/scripts/rollback.sh production market-sense
#
# 禁止：手工 kubectl 改镜像、跳过 Helm 直接 apply manifest。回滚本身也必须可审计。
set -euo pipefail

ENV_NAME="${1:-}"
RELEASE="${2:-}"
shift $(( $# >= 2 ? 2 : $# )) || true
TARGET_REVISION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) TARGET_REVISION="${2:-}"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ -z "${ENV_NAME}" || -z "${RELEASE}" ]]; then
  echo "用法：infra/scripts/rollback.sh <env:dev|preview|production> <release> [--to revision]" >&2
  exit 2
fi

case "${ENV_NAME}" in
  dev)        NAMESPACE="${DEV_NAMESPACE:-market-sense-dev}" ;;
  preview)    NAMESPACE="market-sense-preview-pr-${PR_NUMBER:?preview 回滚必须设置 PR_NUMBER}" ;;
  production) NAMESPACE="${PROD_NAMESPACE:-market-sense}" ;;
  *) echo "未知环境：${ENV_NAME}（必须是 dev|preview|production）" >&2; exit 2 ;;
esac

# 生产回滚：A13 不能自批，必须有 H5 审批引用
if [[ "${ENV_NAME}" == "production" ]]; then
  if [[ -z "${APPROVAL_REF:-}" ]]; then
    echo "❌ 生产回滚被拒绝：缺少 APPROVAL_REF（H5 人类审批单号/链接）。" >&2
    echo "   A13 只执行、不批准；未经 H5 确认的回滚同样不允许。" >&2
    exit 3
  fi
  echo "生产回滚，H5 审批引用：${APPROVAL_REF}"
fi

command -v helm >/dev/null || { echo "❌ 缺少 helm" >&2; exit 1; }

echo "▶ 回滚 ${ENV_NAME}/${RELEASE}（namespace=${NAMESPACE}）"
helm history "${RELEASE}" -n "${NAMESPACE}" --max 10

if [[ -z "${TARGET_REVISION}" ]]; then
  TARGET_REVISION="$(helm history "${RELEASE}" -n "${NAMESPACE}" -o json | python3 -c '
import json, sys
history = json.load(sys.stdin)
deployed = [h for h in history if h.get("status") == "deployed"]
deployed.sort(key=lambda h: h["revision"])
# 最新 deployed 是当前版本；回滚目标是它之前最后一个 deployed
if len(deployed) < 2:
    print("")
else:
    print(deployed[-2]["revision"])
')"
fi

if [[ -z "${TARGET_REVISION}" ]]; then
  echo "❌ 找不到可回滚的上一 healthy revision（history 中 less than 2 个 deployed）。" >&2
  echo "   止血替代：切只读降级（READ_ONLY_MODE=1）并升级 H5/lead。" >&2
  exit 4
fi

START_EPOCH="$(date +%s)"
echo "▶ helm rollback ${RELEASE} → revision ${TARGET_REVISION}（--wait --timeout 5m --atomic）"
if ! helm rollback "${RELEASE}" "${TARGET_REVISION}" -n "${NAMESPACE}" --wait --timeout 5m --atomic; then
  echo "❌ 回滚失败或超时（>5min）→ 停止盲目重试，升级 H5 + lead，切只读降级。" >&2
  exit 5
fi
END_EPOCH="$(date +%s)"
DURATION=$(( END_EPOCH - START_EPOCH ))
echo "✅ 回滚完成：revision=${TARGET_REVISION}，耗时 ${DURATION}s（SLO ≤300s）"
if (( DURATION > 300 )); then
  echo "⚠ 回滚耗时超过 5 分钟 SLO，必须记录并按 docs/runbook/release-rollback.md 复盘。" >&2
fi

# 回滚后最低验证（不通过即升级）
if command -v kubectl >/dev/null; then
  kubectl -n "${NAMESPACE}" rollout status "deployment/${RELEASE}-api" --timeout=120s || {
    echo "⚠ rollout status 未通过，人工确认 Pod 状态；必要时升级。" >&2
    exit 6
  }
fi
echo "✅ 回滚流程结束。请在发布工单标注：rolled back to r${TARGET_REVISION} at $(date -Iseconds), ${DURATION}s"
