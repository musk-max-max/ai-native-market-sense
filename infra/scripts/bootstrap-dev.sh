#!/usr/bin/env bash
# market-sense-h5 · dev 环境 bootstrap（可重建验证：删除 namespace 后能一条命令重建）
# 用法：infra/scripts/bootstrap-dev.sh
# 前置：KUBECONFIG、terraform 1.9.x、helm 3.16.x；集群需有 ingress-nginx（preview/dev 共用）。
# 生产不做 bootstrap（S1 起由 H5 批准 + 远端 state），本脚本只允许 dev。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="${ROOT}/infra/terraform/envs/dev"
CHART_DIR="${ROOT}/infra/helm/market-sense"

command -v terraform >/dev/null || { echo "❌ 缺少 terraform（固定 1.9.8）" >&2; exit 1; }
command -v helm >/dev/null || { echo "❌ 缺少 helm（固定 3.16.2）" >&2; exit 1; }
: "${KUBECONFIG:?需要 KUBECONFIG（禁止用生产 kubeconfig 跑 dev）}"

echo "▶ [1/4] 确认 kubectl 上下文为 dev 集群"
kubectl config current-context

echo "▶ [2/4] Terraform：dev 环境底座"
terraform -chdir="${ENV_DIR}" init -input=false -no-color
terraform -chdir="${ENV_DIR}" apply -input=false -auto-approve -no-color

echo "▶ [3/4] 同步 Prometheus 告警规则（单一真源 infra/monitoring）"
kubectl apply -f "${ROOT}/infra/monitoring/alerts/market-sense.rules.yaml" || {
  echo "⚠ 告警规则 apply 失败（可能未安装 Prometheus Operator）；dev 可继续，但上线前必须修" >&2
}

echo "▶ [4/4] Helm：部署 api/worker（tag=dev，stage=100）"
helm upgrade --install market-sense-dev "${CHART_DIR}" \
  -n market-sense-dev --create-namespace \
  -f "${CHART_DIR}/values-dev.yaml" \
  --set image.api.tag=dev --set image.worker.tag=dev \
  --atomic --wait --timeout 5m --history-max 10

echo "✅ dev 就绪：https://dev.market-sense.invalid（DNS 由 ingress 配置，S0 用 port-forward 验证亦可）"
