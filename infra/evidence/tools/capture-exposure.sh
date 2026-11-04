#!/bin/sh
# infra/evidence/tools/capture-exposure.sh —— H5 #7 ④ 暴露面外部/内部证据采集
#
# WHY：入口到位后必须一次跑出可复核证据，不能现写命令。证据要求（H5 m02701/m02740）：
#   * 集群外：https://<ingress-host>/healthz 与 /metrics 必须 404，且 body 不含 entitlement_degraded*/hold_reason；
#   * Pod 内：localhost:8080/healthz 必须 200 且字段完整；
#   * 记录命令原文 + 响应头 + 时间戳 + 执行人；YAML 本身不算证据。
#
# 用法：
#   EXPOSURE_HOST=docs.example.com POD=market-sense-dev-xxxxx NS=market-sense-dev \
#     EXECUTOR="A13 (a13-sre)" infra/evidence/tools/capture-exposure.sh
#   infra/evidence/tools/capture-exposure.sh --dry-run   # 只打印将执行的命令，不联网
#
# 退出码：0 全部断言通过 / 2 用法错误 / 3 外部断言失败 / 4 内部断言失败 / 5 证据文件写入失败
set -eu

MODE=run
if [ "${1:-}" = "--dry-run" ]; then MODE=dry-run; fi

HOST="${EXPOSURE_HOST:-}"
NS="${NS:-market-sense-dev}"
POD="${POD:-}"
EXECUTOR="${EXECUTOR:-A13 (a13-sre)}"
TIMEOUT="${TIMEOUT:-10}"
OUT_DIR="${OUT_DIR:-infra/evidence}"
TS=$(date -u +%Y%m%dT%H%MZ)
OUT="${OUT_DIR}/exposure-live-${TS}.txt"

if [ "$MODE" = "dry-run" ]; then
  cat <<EOF
# 将执行（入口到位后，去掉 --dry-run）：
curl -sS --max-time ${TIMEOUT} -D /tmp/h-healthz.hdr -o /tmp/h-healthz.body -w 'external /healthz http=%{http_code} t=%{time_total}\\n' https://<EXPOSURE_HOST>/healthz
curl -sS --max-time ${TIMEOUT} -D /tmp/h-metrics.hdr -o /tmp/h-metrics.body -w 'external /metrics http=%{http_code} t=%{time_total}\\n' https://<EXPOSURE_HOST>/metrics
kubectl -n ${NS} exec ${POD:-<pod>} -- curl -sS --max-time ${TIMEOUT} -o - -w '\\ninternal /healthz http=%{http_code}\\n' http://127.0.0.1:8080/healthz
# 断言：external /healthz、/metrics = 404 且 body 不含 entitlement_degraded|hold_reason；internal /healthz = 200 且含 data_ready/entitlement_degraded 字段
# 证据：${OUT}（path/bytes/sha256 入 infra/evidence/evidence-manifest.json，authority=authoritative phase=post-fix case_ids=H5-R10,H5-R19）
EOF
  exit 0
fi

[ -n "$HOST" ] || { echo "ERROR: 需要 EXPOSURE_HOST=<真实 ingress host>" >&2; exit 2; }
[ -n "$POD" ] || { echo "ERROR: 需要 POD=<运行中的 api pod>" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl 不存在" >&2; exit 2; }
command -v kubectl >/dev/null 2>&1 || { echo "ERROR: kubectl 不存在" >&2; exit 2; }

FAIL=0
mkdir -p "$OUT_DIR"

{
  echo "# H5 #7 ④ 暴露面实测证据"
  echo "# authority: authoritative  phase: post-fix  case_ids: H5-R10,H5-R19"
  echo "# command: EXPOSURE_HOST=${HOST} NS=${NS} POD=${POD} EXECUTOR=\"${EXECUTOR}\" infra/evidence/tools/capture-exposure.sh"
  echo "# commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "# timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# executor: ${EXECUTOR}"
  echo "# runtime: $(uname -srm)"
  echo
  echo "## 1) 集群外 GET https://${HOST}/healthz（期望 404，body 无 entitlement_degraded*/hold_reason）"
  code=$(curl -sS --max-time "$TIMEOUT" -D /tmp/a13-h-healthz.hdr -o /tmp/a13-h-healthz.body -w '%{http_code}' "https://${HOST}/healthz") || code=000
  echo "response_headers:"; sed 's/^/  /' /tmp/a13-h-healthz.hdr || true
  echo "status=${code}"
  echo "body:"; sed 's/^/  /' /tmp/a13-h-healthz.body || true
  if [ "$code" != "404" ]; then echo "ASSERT_FAIL external /healthz status=$code != 404"; FAIL=3; else echo "ASSERT_PASS external /healthz=404"; fi
  if grep -Eqi 'entitlement_degraded|hold_reason|data_ready_reason' /tmp/a13-h-healthz.body; then echo "ASSERT_FAIL external /healthz body 泄露内部状态"; FAIL=3; else echo "ASSERT_PASS external /healthz body 无内部状态字段"; fi
  echo
  echo "## 2) 集群外 GET https://${HOST}/metrics（期望 404 或 401，不得 200 泄露指标）"
  code=$(curl -sS --max-time "$TIMEOUT" -D /tmp/a13-h-metrics.hdr -o /tmp/a13-h-metrics.body -w '%{http_code}' "https://${HOST}/metrics") || code=000
  echo "status=${code}"
  echo "body(前 20 行):"; head -20 /tmp/a13-h-metrics.body 2>/dev/null | sed 's/^/  /' || true
  if [ "$code" = "200" ]; then echo "ASSERT_FAIL external /metrics=200（泄露）"; FAIL=3; else echo "ASSERT_PASS external /metrics=${code}（非 200）"; fi
  echo
  echo "## 3) Pod 内 GET http://127.0.0.1:8080/healthz（期望 200 且字段完整）"
  kubectl -n "$NS" exec "$POD" -- curl -sS --max-time "$TIMEOUT" -w '\nHTTP_CODE=%{http_code}\n' http://127.0.0.1:8080/healthz > /tmp/a13-i-healthz.raw 2>&1 || true
  icode=$(sed -n 's/.*HTTP_CODE=//p' /tmp/a13-i-healthz.raw | tail -1)
  [ -n "$icode" ] || icode=000
  echo "status=${icode}"
  echo "body:"; sed 's/^/  /' /tmp/a13-i-healthz.raw | grep -v '^  HTTP_CODE=' | head -40 || true
  if [ "$icode" != "200" ]; then echo "ASSERT_FAIL internal /healthz status=$icode != 200"; FAIL=4; else echo "ASSERT_PASS internal /healthz=200"; fi
  if grep -q 'data_ready' /tmp/a13-i-healthz.raw && grep -q 'entitlement_degraded' /tmp/a13-i-healthz.raw; then echo "ASSERT_PASS internal /healthz 字段完整"; else echo "ASSERT_FAIL internal /healthz 字段缺失"; FAIL=4; fi
  echo
  echo "## 4) Pod 内 GET /metrics（当前未实现；记录响应，不计 PASS/FAIL）"
  kubectl -n "$NS" exec "$POD" -- curl -sS --max-time "$TIMEOUT" -w '\nHTTP_CODE=%{http_code}\n' http://127.0.0.1:8080/metrics > /tmp/a13-i-metrics.raw 2>&1 || true
  mcode=$(sed -n 's/.*HTTP_CODE=//p' /tmp/a13-i-metrics.raw | tail -1)
  [ -n "$mcode" ] || mcode=000
  echo "status=${mcode}"
  echo
  echo "## 结论"
  if [ "$FAIL" = "0" ]; then echo "PASS: 外部 /healthz、/metrics 均未暴露内部状态；Pod 内 /healthz 200 字段完整。"; else echo "FAIL: 见上方 ASSERT_FAIL（exit ${FAIL}）"; fi
} > "$OUT" 2>&1 || { echo "ERROR: 证据写入失败" >&2; exit 5; }

echo "证据文件：${OUT}"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$OUT"; else shasum -a 256 "$OUT"; fi
wc -c < "$OUT" | awk '{print "bytes="$1}'
exit "$FAIL"
