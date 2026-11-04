#!/usr/bin/env bash
# market-sense-h5 · 回收一个 PR 的 preview 环境（PR closed 时由 CI 触发）
# 语义：先 uninstall release，再 destroy namespace；残留 state 一并清理。
# 失败不阻塞 PR 关闭（孤儿资源由定时清理 job 兜底），但必须打印告警。
set -euo pipefail

PR_NUMBER="${1:?用法：infra/scripts/preview-down.sh <pr_number>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="${ROOT}/infra/terraform/envs/preview"
NAMESPACE="market-sense-preview-pr-${PR_NUMBER}"
RELEASE="market-sense-pr-${PR_NUMBER}"
STATE_DIR="${ROOT}/.preview-state"
STATE="${STATE_DIR}/pr-${PR_NUMBER}.tfstate"

echo "▶ 回收 preview：${RELEASE} / ${NAMESPACE}"
if helm status "${RELEASE}" -n "${NAMESPACE}" >/dev/null 2>&1; then
  helm uninstall "${RELEASE}" -n "${NAMESPACE}" --wait --timeout 2m
else
  echo "ℹ release ${RELEASE} 不存在或已回收"
fi

if [[ -f "${STATE}" ]]; then
  terraform -chdir="${ENV_DIR}" init -input=false -no-color >/dev/null
  terraform -chdir="${ENV_DIR}" destroy -input=false -auto-approve -no-color \
    -state="${STATE}" -var "pr_number=${PR_NUMBER}" || true
  rm -f "${STATE}" "${STATE}.backup" "${STATE}.lock.info"
else
  echo "ℹ 无 preview state，跳过 terraform destroy（若 namespace 残留需人工确认）"
fi

echo "✅ preview 回收完成（PR #${PR_NUMBER}）"
