#!/usr/bin/env bash
# market-sense-h5 · 发布后 smoke（回滚/部署脚本与 CI 共用）
# 用法：BASE_URL=https://dev.market-sense.invalid infra/scripts/smoke.sh [base_url]
# 判据：/healthz 必须 200；行情/自选股接口若已实现则校验契约字段，未实现时 WARN 不阻塞（S0）。
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-}}"
[[ -n "${BASE_URL}" ]] || { echo "用法：BASE_URL=... infra/scripts/smoke.sh" >&2; exit 2; }
BASE_URL="${BASE_URL%/}"

fail=0
check() {
  local path="$1" label="$2" required="${3:-true}"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE_URL}${path}" || true)"
  if [[ "${code}" == "200" ]]; then
    echo "✅ ${label} ${path} → 200"
  elif [[ "${required}" == "true" ]]; then
    echo "❌ ${label} ${path} → ${code}" >&2
    fail=1
  else
    echo "⚠ ${label} ${path} → ${code}（S0 未实现，记录不阻塞）"
  fi
}

check /healthz '健康检查'
check '/v1/quotes?symbols=600519.SH' '行情接口' false
check /v1/watchlist '自选股接口' false

if [[ "${fail}" -ne 0 ]]; then
  echo "❌ smoke 失败：不要继续放量，先查 docs/runbook/release-rollback.md" >&2
  exit 1
fi
echo "✅ smoke 通过"
