#!/bin/sh
# infra/evidence/tools/capture-exposure.sh —— ④ 内网可达 / 公网不可达 取证（L91）
#
# WHY：Lead m03310 按用户 m05225/m05235 裁定「内网访问，不暴露公网」。④ 口径从
#   「公网 ingress 四件套」降级为：
#     A. 内网可达：平台在内网入口访问通（本机/内网段 curl web/api 返回 200/403 均算）；
#     B. 公网不可达：ECS 无 0.0.0.0 监听业务端口（只有 loopback）、ms-nginx 保持 stopped、
#        安全组 80 由用户在控制台处置（我们侧不可验，只验 ECS 侧）。
#   NetworkPolicy 真集群验证随「无公网入口」一并降级为历史项（L91 之前的要求），
#   静态守卫（check-network-policy.mjs）+ 本脚本的 ECS 侧证据构成发布依据。
#
# 用法（分两处跑，文件分开存，不要拼成一次 run）：
#   内网/ECS 侧：  ssh root@<ecs> 'sh -s' < infra/evidence/tools/capture-exposure.sh --mode internal
#   公网探测侧：   sh infra/evidence/tools/capture-exposure.sh --mode public
#   预演：         sh ... --mode internal --dry-run
#
# env：
#   INTERNAL_API_BASE 默认 http://127.0.0.1:8081    API 入口（loopback）
#   INTERNAL_WEB_BASE 默认 http://127.0.0.1:3000    H5 入口（loopback）
#   PUBLIC_HOST       默认 47.120.16.239            公网 IP（仅 public 模式）
#   PUBLIC_PORTS      默认 "80 8081 3000 18081"     公网应全部不可达（仅 public 模式）
#   EXECUTOR          执行人标识
#   COMMIT            commit sha（可选；在无 git 的 ECS 上传入）
#
# 退出码：0 全部断言通过 / 2 用法错误 / 3 公网暴露 / 4 内网不可达 / 5 断言失败（其他）
set -eu

MODE=internal
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE=${2:-}; shift 2 ;;
    --mode=*) MODE=${1#--mode=}; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "ERROR: 未知参数 $1" >&2; exit 2 ;;
  esac
done
case "$MODE" in internal|public) : ;; *) echo "ERROR: --mode 只能是 internal|public" >&2; exit 2 ;; esac

INTERNAL_API_BASE="${INTERNAL_API_BASE:-http://127.0.0.1:8081}"
INTERNAL_WEB_BASE="${INTERNAL_WEB_BASE:-http://127.0.0.1:3000}"
PUBLIC_HOST="${PUBLIC_HOST:-47.120.16.239}"
PUBLIC_PORTS="${PUBLIC_PORTS:-80 8081 3000 18081}"
EXECUTOR="${EXECUTOR:-A13 (a13-sre)}"
COMMIT="${COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
TIMEOUT="${TIMEOUT:-10}"

if [ "$DRY" = "1" ]; then
  if [ "$MODE" = "internal" ]; then
    cat <<EOF
# 内网/ECS 侧将执行（应无 FAIL）：
ss -ltnp | grep -E ':(80|8080|8081|3000|18080|18081|5432|6379)\b' || true
docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}' | grep -E 'ms-nginx|market-sense|e2e-ent' || true
docker inspect --format '{{.Name}} {{json .HostConfig.PortBindings}} {{json .RestartPolicy}}' \$(docker ps -q) || true
curl -sS --max-time ${TIMEOUT} -w '\nHTTP_CODE=%{http_code}\n' ${INTERNAL_API_BASE}/healthz
curl -sS --max-time ${TIMEOUT} -D - -o /dev/null -w 'HTTP_CODE=%{http_code}\n' '${INTERNAL_API_BASE}/v1/instruments/SSE:600519/quote'
curl -sS --max-time ${TIMEOUT} -w '\nHTTP_CODE=%{http_code}\n' ${INTERNAL_WEB_BASE}/ | head -20
# 断言：业务端口无 0.0.0.0/:: 监听；PortBindings 全 127.0.0.1；ms-nginx 非 running；api healthz=200 含字段；quote=403 no-store；web=200
EOF
  else
    cat <<EOF
# 公网侧将执行（应全部不可达）：
curl -sS --max-time ${TIMEOUT} -o /dev/null -w 'http://${PUBLIC_HOST}:<port>/ http=%{http_code} exit=%{exitcode}\n' http://${PUBLIC_HOST}:<port>/   # 对 80 8081 3000 18081 逐个
# 断言：connection refused / 无 HTTP 响应（curl exit 7/28/000），任何一个 200/403/401 都算公网暴露
EOF
  fi
  exit 0
fi

command -v curl >/dev/null 2>&1 || { echo "ERROR: curl 不存在" >&2; exit 2; }
FAIL=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT 0 2 15

emit() { echo "$@"; }
hdr() {
  emit "# ④ 内网可达 / 公网不可达 实测证据（L91，内网访问、不暴露公网）"
  emit "# mode: ${MODE}  authority: authoritative  phase: post-fix  case_ids: H5-R10,H5-R19"
  emit "# timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)  executor: ${EXECUTOR}"
  emit "# commit: ${COMMIT}  runtime: $(uname -srm)"
  emit "# code_ref: agents/decisions.md L91（内网访问，不暴露公网）"
  emit
}

if [ "$MODE" = "internal" ]; then
  hdr
  emit "## A1) 宿主监听：业务端口不得 0.0.0.0/::"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | sed 's/^/  /' > "$TMP/ss.txt" || true
  else
    netstat -ltnp 2>/dev/null | sed 's/^/  /' > "$TMP/ss.txt" || true
  fi
  sed -n '1,80p' "$TMP/ss.txt"; emit
  PUBLIC_LISTEN=$(grep -E '^(LISTEN|[^ ]+)' "$TMP/ss.txt" 2>/dev/null | grep -E '0\.0\.0\.0:|\*:|\[::\]:' | grep -vE ':(22)\b' || true)
  if [ -n "$PUBLIC_LISTEN" ]; then
    emit "ASSERT_FAIL 存在非 sshd 的 0.0.0.0/:: 监听："
    emit "$PUBLIC_LISTEN" | sed 's/^/  /'
    FAIL=5
  else
    emit "ASSERT_PASS 业务端口仅 loopback（唯一通配监听为 sshd:22，允许）"
  fi
  emit

  emit "## A2) 容器端口绑定：全部 127.0.0.1（Docker inspect PortBindings）"
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Names}}' 2>/dev/null | while IFS= read -r c; do
      bindings=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$c" 2>/dev/null || echo '{}')
      emit "  ${c}: ${bindings}"
      echo "$bindings" | grep -q '"0.0.0.0"' && emit "  ASSERT_FAIL ${c}: 存在 0.0.0.0 绑定" && exit 9 || true
    done > "$TMP/bindings.txt" 2>&1 || true
    # 子 shell 里 exit 9 不能直接改 FAIL，重新判一次
    cat "$TMP/bindings.txt"
    if grep -q 'ASSERT_FAIL' "$TMP/bindings.txt" 2>/dev/null; then FAIL=5; else emit "ASSERT_PASS 所有运行容器 PortBindings 无 0.0.0.0"; fi
    emit "  -- 静态留档（按名称）--"
    docker ps --format '{{.Names}}' 2>/dev/null | while IFS= read -r c; do
      rp=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null || echo '?')
      emit "  ${c} restart=${rp}"
    done || true
  else
    emit "SKIP docker 不可用（不在 ECS 上？）；本次未验证 PortBindings"
    FAIL=5
  fi
  emit

  emit "## A3) 临时层 ms-nginx 必须保持 stopped，且不得自启（restart=no）"
  if command -v docker >/dev/null 2>&1; then
    state=$(docker inspect --format '{{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}}' ms-nginx 2>/dev/null || echo 'not-found')
    emit "  ms-nginx: ${state}"
    case "$state" in
      running*|restarting*|paused*) emit "ASSERT_FAIL ms-nginx 仍处于运行态"; FAIL=5 ;;
      *restart=always*|*restart=unless-stopped*) emit "ASSERT_FAIL ms-nginx restart 策略可能自启"; FAIL=5 ;;
      *) emit "ASSERT_PASS ms-nginx 非 running（L91：永久不恢复）" ;;
    esac
  else
    emit "SKIP docker 不可用"
    FAIL=5
  fi
  emit

  emit "## A4) 内网可达：API /healthz 200 且字段完整"
  code=$(curl -sS --max-time "$TIMEOUT" -D "$TMP/api-h.hdr" -o "$TMP/api-h.body" -w '%{http_code}' "${INTERNAL_API_BASE}/healthz" || echo 000)
  emit "  GET ${INTERNAL_API_BASE}/healthz -> status=${code}"
  sed 's/^/  /' "$TMP/api-h.body" 2>/dev/null | head -5 || true
  if [ "$code" = "200" ] && grep -q 'data_ready' "$TMP/api-h.body" 2>/dev/null && grep -q 'entitlement_degraded' "$TMP/api-h.body" 2>/dev/null; then
    emit "ASSERT_PASS 内网 API /healthz=200，含 data_ready/entitlement_degraded"
  else
    emit "ASSERT_FAIL 内网 API /healthz=${code} 或字段缺失"; FAIL=4
  fi
  emit

  emit "## A5) 内网可达：业务 API 返回 200/403（本例 quote 在 internal_eval 下应 403 或 200，均算可达）"
  qcode=$(curl -sS --max-time "$TIMEOUT" -D "$TMP/quote.hdr" -o "$TMP/quote.body" -w '%{http_code}' "${INTERNAL_API_BASE}/v1/instruments/SSE:600519/quote" || echo 000)
  emit "  GET ${INTERNAL_API_BASE}/v1/instruments/SSE:600519/quote -> status=${qcode}"
  grep -iE '^(cache-control|http/)' "$TMP/quote.hdr" 2>/dev/null | sed 's/^/  /' || true
  case "$qcode" in 200|403) emit "ASSERT_PASS 内网业务 API 可达（${qcode}）" ;; *) emit "ASSERT_FAIL 内网业务 API status=${qcode}"; FAIL=4 ;; esac
  emit

  emit "## A6) 内网可达：H5 入口 web 返回 200"
  wcode=$(curl -sS --max-time "$TIMEOUT" -o "$TMP/web.body" -w '%{http_code}' "${INTERNAL_WEB_BASE}/" || echo 000)
  emit "  GET ${INTERNAL_WEB_BASE}/ -> status=${wcode}"
  if [ "$wcode" = "200" ]; then emit "ASSERT_PASS 内网 web=200"; else emit "ASSERT_FAIL 内网 web=${wcode}"; FAIL=4; fi
  emit

  emit "## 结论"
  if [ "$FAIL" = "0" ]; then
    emit "PASS: 内网可达（api 200 / quote 200|403 / web 200）+ ECS 业务端口仅 loopback + ms-nginx stopped；公网侧见 public 模式证据。"
  else
    emit "FAIL: 见 ASSERT_FAIL（exit ${FAIL}）"
  fi
  exit "$FAIL"
fi

# ---------- public 模式：公网应全部不可达（在能访问公网 IP 的机器上跑） ----------
hdr
emit "## B1) 公网不可达：${PUBLIC_HOST} 上业务端口应全部 connection refused（或超时/无 HTTP 响应）"
emit "  说明：安全组由用户在云控制台处置，本脚本只能验 ECS/网络侧；若端口被安全组放行但 ECS 未监听，仍表现为 refused/timeout。"
for port in $PUBLIC_PORTS; do
  out=$(curl -sS --max-time "$TIMEOUT" -o "$TMP/pub-${port}.body" -w 'http=%{http_code} exit=%{exitcode} time=%{time_total}' "http://${PUBLIC_HOST}:${port}/" 2>"$TMP/pub-${port}.err" || true)
  code=$(echo "$out" | sed -n 's/.*http=\([0-9]*\).*/\1/p')
  err=$(head -1 "$TMP/pub-${port}.err" 2>/dev/null || true)
  emit "  http://${PUBLIC_HOST}:${port}/ -> ${out}"
  [ -n "$err" ] && emit "    curl_stderr: ${err}"
  case "$port:$code" in
    *:200|*:201|*:204|*:301|*:302|*:307|*:308|*:401|*:403|*:404|*:405|*:500|*:502|*:503)
      emit "  ASSERT_FAIL 端口 ${port} 返回可观测 HTTP ${code}（公网可达/暴露面）"; FAIL=3 ;;
    *) emit "  ASSERT_PASS 端口 ${port} 无 HTTP 响应（不可达）" ;;
  esac
done
emit
emit "## B2) 公网 healthz/metrics 直探（即使 80 不通也记录原始输出，作为不可达证据）"
for p in /healthz /metrics; do
  out=$(curl -sS --max-time "$TIMEOUT" -o "$TMP/pub-$(echo "$p" | tr '/' '_').body" -w 'http=%{http_code} exit=%{exitcode}' "http://${PUBLIC_HOST}${p}" 2>&1 || true)
  emit "  http://${PUBLIC_HOST}${p} -> ${out}"
done
emit
emit "## 结论"
if [ "$FAIL" = "0" ]; then
  emit "PASS: 公网 ${PUBLIC_HOST} 的业务端口均无可观测 HTTP 响应（不可达）；ms-nginx stopped、ECS 侧仅 loopback 的结论见 internal 模式证据。"
else
  emit "FAIL: 公网暴露（见 ASSERT_FAIL，exit ${FAIL}）"
fi
exit "$FAIL"
