#!/usr/bin/env bash
# market-sense-h5 · 发布（灰度档位部署；只允许 A13 通过流水线执行）
#
# 用法：infra/scripts/deploy.sh <env> <image_tag> [--stage 1|10|50|100] [--release name]
#   dev         → namespace market-sense-dev（可直接执行）
#   preview     → 用 preview-up.sh（按 PR 起停）
#   production  → 需 APPROVAL_REF（H5 批准）+ 冻结窗口检查（9:15–15:00 禁止非紧急发布）
#
# 灰度节奏（SLO）：1 → 10 → 50 → 100，每档 ≥30min；本脚本只部署单档，
# 推进下一档必须另一次 dispatch（时间间隔由发布流程/CI 强制记录）。
set -euo pipefail

ENV_NAME="${1:-}"
IMAGE_TAG="${2:-}"
shift $(( $# >= 2 ? 2 : $# )) || true
STAGE="1"
RELEASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) STAGE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -n "${ENV_NAME}" && -n "${IMAGE_TAG}" ]] || { echo "用法：infra/scripts/deploy.sh <env> <image_tag> [--stage N]" >&2; exit 2; }
case "${STAGE}" in 1|10|50|100) ;; *) echo "❌ stage 必须是 1|10|50|100（SLO 灰度档位）" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../helm/market-sense" && pwd)"

# ── HOST-EXPOSURE-01 部署钩子（H5 m03665 B=b）─────────────────────────────
# FAIL 或 UNVERIFIED 且本次发布改动了暴露面（端口绑定/ingress/SG）→ 阻塞并回滚；
# 纯代码发布只告警。break-glass 只能 H5 书面批，agent 不得自批。
EXPOSURE_AFFECTING="${EXPOSURE_AFFECTING:-0}"
HOST_AUDIT_SSH="${HOST_AUDIT_SSH:-}"
run_host_audit() { # $1=require_public_host(0|1)
  local req="$1" out rc
  [ -n "${HOST_AUDIT_SSH}" ] || return 99
  out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "${HOST_AUDIT_SSH}" \
    "HOST_EXPOSURE_AUTO_ISOLATE=1 HOST_EXPOSURE_REQUIRE_PUBLIC_HOST=${req} /usr/local/sbin/market-sense-host-baseline-audit.sh" 2>&1)
  rc=$?
  printf '%s\n' "${out}" | tail -25 >&2
  return "${rc}"
}
if [ "${EXPOSURE_AFFECTING}" = "1" ] && [ -z "${HOST_AUDIT_SSH}" ]; then
  echo "❌ HOST-EXPOSURE-01 UNVERIFIED：本次发布改动了暴露面，但未配置 HOST_AUDIT_SSH 主机巡检目标；按 B=b 阻塞（不自批 break-glass）。" >&2
  exit 8
fi
if [ "${EXPOSURE_AFFECTING}" = "1" ]; then
  echo "▶ HOST-EXPOSURE-01 部署前巡检（暴露面变更，require_public_host=1）"
  run_host_audit 1 || { echo "❌ HOST-EXPOSURE-01 部署前巡检失败/UNVERIFIED：阻止本次部署（B=b）" >&2; exit 9; }
fi
case "${ENV_NAME}" in
  dev)
    NAMESPACE="market-sense-dev"
    VALUES="${CHART_DIR}/values-dev.yaml"
    RELEASE="${RELEASE:-market-sense-dev}"
    ;;
  production)
    # S0 只做 dev+preview；生产 IaC 在 S1 由 A13 提案、H5 批准后加入（不提前写生产配置）
    echo "❌ S0 未启用生产发布：生产 IaC/发布流程在 S1 由 A13 提案、H5 批准后落地。" >&2
    exit 2
    ;;
  production-guard)
    NAMESPACE="${PROD_NAMESPACE:-market-sense}"
    VALUES="${CHART_DIR}/values-production.yaml"
    RELEASE="${RELEASE:-market-sense}"
    if [[ -z "${APPROVAL_REF:-}" ]]; then
      echo "❌ 生产发布被拒绝：缺少 APPROVAL_REF（H5 人类批准）。A13 不能自批。" >&2
      exit 3
    fi
    # 冻结窗口：交易日 9:15–15:00 禁止非紧急发布（EMERGENCY=1 + H5 批准才可）
    NOW_HM="$(TZ=Asia/Shanghai date +%H:%M)"
    DOW="$(TZ=Asia/Shanghai date +%u)"
    if [[ "${DOW}" -le 5 && "${NOW_HM}" > "09:15" && "${NOW_HM}" < "15:00" ]]; then
      if [[ "${EMERGENCY:-0}" != "1" ]]; then
        echo "❌ 当前 ${NOW_HM} 在交易日冻结窗口 9:15–15:00 内，禁止非紧急发布（需 H5 批准且 EMERGENCY=1）。" >&2
        exit 4
      fi
      echo "⚠ 紧急发布：冻结窗口内放行，H5 批准=${APPROVAL_REF}，原因=${EMERGENCY_REASON:-未填写}"
    fi
    ;;
  preview)
    echo "preview 环境请用 infra/scripts/preview-up.sh <pr_number>" >&2
    exit 2
    ;;
  *) echo "未知环境：${ENV_NAME}（dev|production）" >&2; exit 2 ;;
esac

command -v helm >/dev/null || { echo "❌ 缺少 helm" >&2; exit 1; }

# 灰度 SLO：1→10→50→100，每档 ≥30min。推进档位时检查上一档停留时长。
if [[ "${STAGE}" != "1" ]] && helm status "${RELEASE}" -n "${NAMESPACE}" >/dev/null 2>&1; then
  LAST_TS="$(helm history "${RELEASE}" -n "${NAMESPACE}" -o json | python3 -c '
import json, sys
history = json.load(sys.stdin)
deployed = [h for h in history if h.get("status") == "deployed"]
deployed.sort(key=lambda h: h["revision"])
print(deployed[-1]["updated"] if deployed else "")
')"
  if [[ -n "${LAST_TS}" ]]; then
    LAST_EPOCH="$(python3 -c "import datetime,sys; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')).timestamp()))" "${LAST_TS}")"
    DWELL=$(( $(date +%s) - LAST_EPOCH ))
    if (( DWELL < 1800 )) && [[ "${ALLOW_FAST_PROMOTE:-0}" != "1" ]]; then
      echo "❌ 灰度档位停留仅 ${DWELL}s（要求 ≥1800s/30min）——SLO：每档 ≥30min。本地演练可 ALLOW_FAST_PROMOTE=1。" >&2
      exit 5
    fi
    echo "✓ 上一档已停留 ${DWELL}s（≥1800s）"
  fi
fi

# H4 m01649：DEPLOYMENT_UID 必须由发布流水线注入（它是 deploy 事件/ gap 去重的锚点）。
# 本脚本不是流水线，缺了就拒绝，避免手填一个看起来像真的 uid。
if [[ -z "${DEPLOYMENT_UID:-}" ]]; then
  echo "✗ 缺少 DEPLOYMENT_UID：必须由发布流水线注入（例如 <env>-<commit>-<run_id>），不允许手填" >&2
  exit 6
fi

echo "▶ 部署 ${ENV_NAME}/${RELEASE}：image tag=${IMAGE_TAG}，灰度 stage=${STAGE}%，deployment_uid=${DEPLOYMENT_UID}"
helm upgrade --install "${RELEASE}" "${CHART_DIR}" \
  -n "${NAMESPACE}" --create-namespace \
  -f "${VALUES}" \
  --set "image.api.tag=${IMAGE_TAG}" \
  --set "image.worker.tag=${IMAGE_TAG}" \
  --set "config.RELEASE_GRAY_STAGE=${STAGE}" \
  --set "global.environment=${ENV_NAME}" \
  --set "config.DEPLOYMENT_UID=${DEPLOYMENT_UID}" \
  --atomic --wait --timeout 5m --history-max 10

# 部署后巡检：暴露面变更 → 失败即回滚（B=b）；纯代码发布 → 只告警。
if [ -n "${HOST_AUDIT_SSH}" ]; then
  if [ "${EXPOSURE_AFFECTING}" = "1" ]; then
    run_host_audit 1 || {
      echo "❌ HOST-EXPOSURE-01 部署后巡检失败：按 B=b 回滚 ${RELEASE}" >&2
      helm rollback "${RELEASE}" 0 -n "${NAMESPACE}" --wait --timeout 5m || true
      exit 7
    }
  else
    run_host_audit 0 || echo "::warning::HOST-EXPOSURE-01 巡检命中/UNVERIFIED（纯代码发布，按 B=b 只告警，不阻塞）" >&2
  fi
else
  echo "⏭ HOST-EXPOSURE-01 未配置 HOST_AUDIT_SSH：跳过主机巡检（暴露面变更会被上一步阻塞）"
fi

echo "✅ 部署完成：stage=${STAGE}%。下一档需间隔 ≥30min，且观察错误率/P95/AI 四项。"
echo "   如有异常：infra/scripts/rollback.sh ${ENV_NAME} ${RELEASE}"
