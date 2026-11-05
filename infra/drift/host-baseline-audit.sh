#!/bin/sh
# 主机基线漂移审计（只读）。
# 背景：A19 L91 复核（commit 370c6bb）发现 ECS 主机态（安全组/ufw/sshd/非 compose 容器/
# 运行时授权 env）在仓库零 IaC 表达，CI 与契约测试无法发现；本脚本把「当前态 vs 目标态」
# 显式化，供人工/值班定期跑，输出可直接作为漂移证据登记 manifest。
# 用法：host-baseline-audit.sh [--expected <file>] [--json] [--ssh <user@host>] [--self-test]
#   默认在主机上执行；--ssh 由 ECS 外部机器执行 ssh root@host ...（需 BatchMode 密钥）。
# 退出码：0 无漂移；1 有 FAIL；2 用法/环境错误。
# 只读承诺：不修改 ufw/sshd/容器/文件；仅 docker inspect / ss / ufw status / sshd -T。
set -eu

EXPECTED="$(dirname "$0")/host-baseline.expected.env"
JSON=0
SELFTEST=0
SSH_TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expected) EXPECTED=${2:?}; shift 2 ;;
    --json) JSON=1; shift ;;
    --self-test) SELFTEST=1; shift ;;
    --self-test-clean) SELFTEST=2; shift ;;
    --ssh) SSH_TARGET=${2:?}; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -f "$EXPECTED" ] || { echo "expected file not found: $EXPECTED" >&2; exit 2; }
# shellcheck disable=SC1090
. "$EXPECTED"
# 干净态自测用固定的示例白名单，避免依赖部署环境尚未配置的 CIDR（A9 R7 要求正常态 exit 0 可自证）
[ "$SELFTEST" = 2 ] && EXPECTED_SSH_ALLOWED_FROM="203.0.113.0/24"

FAIL=0
fail() { FAIL=1; echo "FAIL  $*"; }
pass() { echo "PASS  $*"; }
warn() { echo "WARN  $*"; }

read_state() {
  if [ "$SELFTEST" = 1 ]; then selftest_state "$1"; return; fi
  if [ "$SELFTEST" = 2 ]; then selftest_clean_state "$1"; return; fi
  if [ -n "$SSH_TARGET" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$SSH_TARGET" "$1"
  else
    sh -c "$1"
  fi
}

# 干净态夹具：全部满足基线，期望脚本 exit 0（A9 R7 AC：正常态不得假红）。
selftest_clean_state() {
  case "$1" in
    hostname) echo "selftest-clean" ;;
    *"command -v docker"*) echo "/usr/bin/docker" ;;
    *"ss -ltnp"*) printf '0.0.0.0:22\n127.0.0.1:8081\n' ;;
    *"docker ps -a --format"*) printf 'market-sense-e2e-api-1\n' ;;
    *"docker inspect"*"State.Status"*) echo 'running;unless-stopped;{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8081"}]};market-sense-e2e' ;;
    *"docker inspect"*".Config.Env"*) printf 'APP_PROFILE=prod\nENTITLEMENT_TIER=c_end_display\nENTITLEMENT_AUDIT=1\nENTITLEMENT_HOLD_CHECK=1\n' ;;
    *"ufw status numbered"*) printf '[ 1] 22/tcp ALLOW IN 203.0.113.0/24\n' ;;
    *"ufw status"*) printf 'Status: active\n22/tcp ALLOW 203.0.113.0/24\n' ;;
    *"sshd -T"*) printf 'permitrootlogin no\npasswordauthentication no\nmaxauthtries 3\n' ;;
    *"systemctl is-active fail2ban"*) echo "active" ;;
    *"fail2ban-client status"*) echo "Jail list: sshd" ;;
    *) echo "" ;;
  esac
}

# 自测夹具：用于「变异自证」——注入 0.0.0.0 绑定/非 compose 容器/多放行 ufw/弱 sshd/未启用 fail2ban/审计漂移，
# 脚本必须 exit 1 并输出对应 FAIL；不触碰真实主机。A9 R7 要求：只交付脚本不算闭环。
selftest_state() {
  case "$1" in
    hostname) echo "selftest-host" ;;
    *"command -v docker"*) echo "/usr/bin/docker" ;;
    *"ss -ltnp"*) printf '0.0.0.0:22\n0.0.0.0:8888\n[::]:9999\n127.0.0.1:8081\n' ;;
    *"docker ps -a --format"*) printf 'a13-drift-selftest-a\na13-drift-selftest-b\na13-drift-selftest-c\na13-drift-selftest-d\n' ;;
    *"docker inspect"*"State.Status"*"a13-drift-selftest-a"*) echo 'exited;no;{"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"80"}]};' ;;
    *"docker inspect"*"State.Status"*"a13-drift-selftest-b"*) echo 'running;no;{};market-sense-e2e' ;;
    *"docker inspect"*"State.Status"*"a13-drift-selftest-c"*) echo 'running;no;{};market-sense-e2e' ;;
    *"docker inspect"*"State.Status"*"a13-drift-selftest-d"*) echo 'running;no;{"80/tcp":[{"HostIp":"::","HostPort":"80"}]};market-sense-e2e' ;;
    *"docker inspect"*".Config.Env"*"a13-drift-selftest-a"*) printf 'ENTITLEMENT_TIER=c_end_display\nENTITLEMENT_AUDIT=0\nENTITLEMENT_HOLD_CHECK=0\n' ;;
    *"docker inspect"*".Config.Env"*"a13-drift-selftest-b"*) printf 'ENTITLEMENT_TIER=internal_eval\nENTITLEMENT_AUDIT=1\nENTITLEMENT_HOLD_CHECK=1\n' ;;
    *"docker inspect"*".Config.Env"*"a13-drift-selftest-c"*) printf 'APP_PROFILE=e2e\n' ;;
    *"docker inspect"*".Config.Env"*"a13-drift-selftest-d"*) printf 'APP_PROFILE=e2e\nENTITLEMENT_TIER=internal_eval\nENTITLEMENT_AUDIT=1\nENTITLEMENT_HOLD_CHECK=1\n' ;;
    *"ufw status numbered"*) printf '[ 1] 22/tcp ALLOW IN Anywhere\n[ 2] 8888/tcp ALLOW IN Anywhere\n' ;;
    *"ufw status"*) printf 'Status: active\n88/tcp ALLOW Anywhere\n' ;;
    *"sshd -T"*) printf 'permitrootlogin yes\npasswordauthentication yes\nmaxauthtries 6\n' ;;
    *"systemctl is-active fail2ban"*) echo "inactive" ;;
    *"fail2ban-client status"*) echo "" ;;
    *) echo "" ;;
  esac
}

export LC_ALL=C
echo "# host-baseline audit (read-only)"
echo "# time_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) host=$(read_state 'hostname' 2>/dev/null || echo unknown)"
echo "# expected=$EXPECTED"
echo

if [ -z "$(read_state "command -v docker" 2>/dev/null)" ]; then
  echo "UNKNOWN 无法检查：docker 不可用（需 root/目标主机）；exit 2"; exit 2
fi

# 1) 监听面：通配监听必须只出现在 EXPECTED_WILDCARD_LISTEN_PORTS
LISTEN=$(read_state "ss -ltnp 2>/dev/null | awk 'NR>1 {print \$4}'" || true)
BAD_LISTEN=""
for addr in $LISTEN; do
  port=${addr##*:}
  case "$addr" in
    0.0.0.0:*|\[::\]:*)
      allowed=0
      for p in $EXPECTED_WILDCARD_LISTEN_PORTS; do [ "$port" = "$p" ] && allowed=1; done
      [ "$allowed" -eq 0 ] && BAD_LISTEN="$BAD_LISTEN $addr"
      ;;
  esac
done
if [ -z "$BAD_LISTEN" ]; then pass "通配监听仅限 $EXPECTED_WILDCARD_LISTEN_PORTS"; else fail "出现非基线通配监听:$BAD_LISTEN"; fi

# 2) 所有容器（含 stopped）：0.0.0.0 绑定与 restart 策略
NAMES=$(read_state "docker ps -a --format '{{.Names}}'" || true)
for n in $NAMES; do
  [ -n "$n" ] || continue
  info=$(read_state "docker inspect -f '{{.State.Status}};{{.HostConfig.RestartPolicy.Name}};{{json .HostConfig.PortBindings}};{{index .Config.Labels \"com.docker.compose.project\"}}' $n" 2>/dev/null || echo "unknown;;;")
  st=$(printf '%s' "$info" | cut -d';' -f1)
  rest=$(printf '%s' "$info" | cut -d';' -f2)
  binds=$(printf '%s' "$info" | cut -d';' -f3)
  proj=$(printf '%s' "$info" | cut -d';' -f4)
  case "$binds" in
    *'"HostIp":"0.0.0.0"'*|*'"HostIp":"::"'*|*'"HostIp":""'*)
      allowed=0
      for c in $EXPECTED_PUBLIC_CONTAINERS; do [ "$n" = "$c" ] && allowed=1; done
      [ "$allowed" -eq 0 ] && fail "容器 $n 存在通配(0.0.0.0/::)端口绑定 (status=$st restart=$rest): $binds"
      ;;
  esac
  [ -z "$proj" ] && fail "非 compose/k8s 管理容器：${n}（主机手工残留，无法从仓库重建）"
  if [ "$st" = "running" ] && [ "$rest" = "no" ]; then
    case "$proj" in
      *e2e*) warn "e2e 栈容器 $n restart=no（允许，仅限 e2e/临时）" ;;
      *) fail "运行中容器 $n restart=no，生产必须 unless-stopped/always 或 k8s" ;;
    esac
  fi
done

# 3) ufw 允许清单
UFW_RAW=$(read_state "LC_ALL=C ufw status 2>/dev/null" || true)
case "$UFW_RAW" in *"Status: active"*) : ;; *) echo "UNKNOWN 无法检查：ufw 不可用或未激活；exit 2"; exit 2 ;; esac
UFW=$(printf '%s\n' "$UFW_RAW" | awk '/ALLOW/ {print $1}')
BAD_UFW=""
for p in $UFW; do
  allowed=0
  for e in $EXPECTED_UFW_ALLOW; do [ "$p" = "$e" ] && allowed=1; done
  [ "$allowed" -eq 0 ] && BAD_UFW="$BAD_UFW $p"
done
if [ -z "$BAD_UFW" ]; then pass "ufw 允许列表与基线一致"; else fail "ufw 多放行端口:${BAD_UFW}（期望: $EXPECTED_UFW_ALLOW）"; fi

# 3b) 22 来源限制（A9 R7：只查端口会把 allow 22/tcp Anywhere 误判为合规）
UFW_NUM=$(read_state "LC_ALL=C ufw status numbered 2>/dev/null" || true)
SSH_SRCS=$(printf '%s\n' "$UFW_NUM" | awk '/22\/tcp/ && /ALLOW/ {sub(/^.*ALLOW IN[ \t]*/, ""); print}')
if [ -z "$SSH_SRCS" ]; then fail "未找到 22/tcp 允许规则"; else
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    case "$src" in
      Anywhere*) fail "22/tcp 来源为 Anywhere（未白名单；待用户 CIDR，期望: ${EXPECTED_SSH_ALLOWED_FROM:-<未配置>}）" ;;
      *)
        ok=0
        for cidr in $EXPECTED_SSH_ALLOWED_FROM; do [ "$src" = "$cidr" ] && ok=1; done
        [ "$ok" -eq 1 ] && pass "22/tcp 来源受限: $src" || fail "22/tcp 来源 $src 不在期望白名单（${EXPECTED_SSH_ALLOWED_FROM:-<未配置>}）"
        ;;
    esac
  done <<EOF
$SSH_SRCS
EOF
fi

# 3c) fail2ban（R2：公网 22 需减速带）
F2B_ACTIVE=$(read_state "systemctl is-active fail2ban" 2>/dev/null || echo unknown)
if [ "$EXPECTED_FAIL2BAN_ACTIVE" = "1" ]; then
  [ "$F2B_ACTIVE" = "active" ] && pass "fail2ban active" || fail "fail2ban 未 active（当前: ${F2B_ACTIVE:-unknown}）"
  F2B_JAIL=$(read_state "fail2ban-client status 2>/dev/null" || true)
  case "$F2B_JAIL" in *sshd*) pass "fail2ban sshd jail 存在" ;; *) fail "fail2ban 未启用 sshd jail" ;; esac
fi

# 4) sshd 目标配置
SSHD=$(read_state "LC_ALL=C sshd -T 2>/dev/null" || true)
case "$SSHD" in *permitrootlogin*) : ;; *) echo "UNKNOWN 无法检查：sshd -T 失败（需 root）；exit 2"; exit 2 ;; esac
chk_sshd() {
  key=$1; want=$2; got=$(printf '%s\n' "$SSHD" | awk -v k="$key" '$1==k {print $2}')
  [ "$got" = "$want" ] && pass "sshd $key=$got" || fail "sshd $key=${got:-unset}（期望 ${want}）"
}
chk_sshd permitrootlogin "$EXPECTED_SSHD_PERMITROOTLOGIN"
chk_sshd passwordauthentication "$EXPECTED_SSHD_PASSWORD_AUTHENTICATION"
chk_sshd maxauthtries "$EXPECTED_SSHD_MAXAUTHTRIES"

# 5) 运行时授权 env 漂移（A3 KD-ENT-01：e2e 栈也不得靠默认关）
for n in $NAMES; do
  [ -n "$n" ] || continue
  envs=$(read_state "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $n" 2>/dev/null || true)
  case "$envs" in
    *ENTITLEMENT_TIER*|*APP_PROFILE*|*E2E_MODE*)
      audit=$(printf '%s\n' "$envs" | awk -F= '$1=="ENTITLEMENT_AUDIT"{print $2}')
      hold=$(printf '%s\n' "$envs" | awk -F= '$1=="ENTITLEMENT_HOLD_CHECK"{print $2}')
      [ "$audit" = "$EXPECTED_ENTITLEMENT_AUDIT" ] && pass "$n ENTITLEMENT_AUDIT=$audit" || fail "$n ENTITLEMENT_AUDIT=${audit:-unset}（期望 ${EXPECTED_ENTITLEMENT_AUDIT}）"
      [ "$hold" = "$EXPECTED_ENTITLEMENT_HOLD_CHECK" ] && pass "$n ENTITLEMENT_HOLD_CHECK=$hold" || fail "$n ENTITLEMENT_HOLD_CHECK=${hold:-unset}（期望 ${EXPECTED_ENTITLEMENT_HOLD_CHECK}）"
      ;;
  esac
done

echo
if [ "$SELFTEST" = 1 ]; then
  if [ "$FAIL" -eq 1 ]; then echo "SELFTEST PASS 注入漂移全部被检出"; exit 0; fi
  echo "SELFTEST FAIL 注入漂移未被检出"; exit 1
fi
if [ "$SELFTEST" = 2 ]; then
  if [ "$FAIL" -eq 0 ]; then echo "SELFTEST-CLEAN PASS 干净态 exit 0"; exit 0; fi
  echo "SELFTEST-CLEAN FAIL 干净态被误判为漂移"; exit 1
fi
if [ "$FAIL" -eq 0 ]; then echo "RESULT PASS 无漂移"; exit 0; else echo "RESULT DRIFT 存在基线漂移"; exit 1; fi
