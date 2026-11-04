#!/usr/bin/env bash
# market-sense-h5 · 起一个 PR 的 preview 环境（按 PR 起停）
#
# 用法：infra/scripts/preview-up.sh <pr_number> [image_tag]
# 前置：KUBECONFIG 可用、terraform/helm 已安装（CI 中固定版本）。
# preview 隔离：namespace=market-sense-preview-pr-<n>，release=market-sense-pr-<n>，state 按 PR 分开。
# 禁止：preview 连生产 tushare 凭据/生产数据库（只有 fixture/mock）。
set -euo pipefail

PR_NUMBER="${1:?用法：infra/scripts/preview-up.sh <pr_number> [image_tag]}"
IMAGE_TAG="${2:-pr-${PR_NUMBER}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="${ROOT}/infra/terraform/envs/preview"
CHART_DIR="${ROOT}/infra/helm/market-sense"
NAMESPACE="market-sense-preview-pr-${PR_NUMBER}"
RELEASE="market-sense-pr-${PR_NUMBER}"
STATE_DIR="${ROOT}/.preview-state"
STATE="${STATE_DIR}/pr-${PR_NUMBER}.tfstate"
mkdir -p "${STATE_DIR}"

echo "▶ [1/2] Terraform：namespace ${NAMESPACE}"
terraform -chdir="${ENV_DIR}" init -input=false -no-color >/dev/null
terraform -chdir="${ENV_DIR}" apply -input=false -auto-approve -no-color \
  -state="${STATE}" \
  -var "pr_number=${PR_NUMBER}"

# preview 的 deployment uid 由脚本生成（流水线产物），不手填；每次起环境唯一。
DEPLOYMENT_UID="${DEPLOYMENT_UID:-preview-pr-${PR_NUMBER}-$(date -u +%Y%m%d%H%M%S)}"

echo "▶ [2/2] Helm：release ${RELEASE}（deployment_uid=${DEPLOYMENT_UID}）"
helm upgrade --install "${RELEASE}" "${CHART_DIR}" \
  -n "${NAMESPACE}" -f "${CHART_DIR}/values-preview.yaml" \
  --set "image.api.tag=${IMAGE_TAG}" \
  --set "image.worker.tag=${IMAGE_TAG}" \
  --set "preview.prNumber=${PR_NUMBER}" \
  --set "config.DEPLOYMENT_UID=${DEPLOYMENT_UID}" \
  --atomic --wait --timeout 5m --history-max 5

echo "✅ preview 就绪：https://pr-${PR_NUMBER}.preview.market-sense.invalid"
echo "   关闭：infra/scripts/preview-down.sh ${PR_NUMBER}"
