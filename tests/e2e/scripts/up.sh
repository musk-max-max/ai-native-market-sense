#!/usr/bin/env bash
# 起 E2E 真栈（A12 owns）。顺序（Lead m01015）：
#   postgres/redis/replay → db-migrate → ingress → warehouse-load → ingest-report → api/web → preflight
# 任一步 seed 非零 = 整栈 fail（api/web 仍起，让 /healthz 能报 data_ready=false）；
# 最终退出码 = seed 链第一个非零（不拿 preflight 的码覆盖它）；seed 全 0 才看 preflight。
# 用法：
#   bash tests/e2e/scripts/up.sh              # 首次/变更后：构建 + seed + 起栈
#   bash tests/e2e/scripts/up.sh --no-seed    # 跳过 seed（只验证栈能起）
#   bash tests/e2e/scripts/up.sh --no-build   # 复用已有镜像
# 依赖：docker + docker compose v2（无 docker 时明确报错退出，不静默跳过）。
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$E2E_DIR"

NO_SEED=0
BUILD=(--build)
for arg in "$@"; do
  case "$arg" in
    --no-seed) NO_SEED=1 ;;
    --no-build) BUILD=() ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 本机没有 docker。E2E 真栈必须有 docker + docker compose v2（见 README §环境要求）。" >&2
  echo "       无 docker 环境下只能跑静态校验：python3 tests/e2e/scripts/validate_compose.py" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose v2 不可用（需要 'docker compose' 子命令）。" >&2
  exit 1
fi

# 1) 先做 compose 静态断言：结构退化（断网/挂载/token/镜像职责）不该等到 up 之后才发现
python3 scripts/validate_compose.py --quiet

COMPOSE=(docker compose -f docker-compose.yml)
RUN=(run --rm)

# /state 用 host bind（宿主 tests/e2e/.state，便于 preflight/报告可查）。容器内 uid 10001 需可写：
# A2 m01112：warehouse/Dockerfile 的 /state 属主是 10001，但 host bind 的属主是宿主用户 → 显式放开写。
STATE_DIR="$E2E_DIR/.state"
mkdir -p "$STATE_DIR"
chmod 0777 "$STATE_DIR" 2>/dev/null || true
[ "${#BUILD[@]}" -gt 0 ] && RUN=(run --rm --build)

echo "==> 启动基础设施（postgres / redis / tushare-replay）"
"${COMPOSE[@]}" up -d --wait "${BUILD[@]}" postgres redis tushare-replay

SEED_RC=0
SEED_FAILED_STEP=""
if [ "$NO_SEED" -eq 0 ]; then
  run_seed_step() {  # $1=step name, $2=service
    echo "==> seed 第 $1 步：$2"
    set +e
    "${COMPOSE[@]}" --profile seed "${RUN[@]}" "$2"
    local rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      SEED_FAILED_STEP="$1"
      echo "ERROR: seed 第 $1 步（$2）退出码 $rc —— 这是数据未就绪，不是 api/web 实现缺陷" >&2
      return "$rc"
    fi
    return 0
  }

  run_seed_step "0/4 db-migrate"  db-migrate          || SEED_RC=$?
  [ "$SEED_RC" -eq 0 ] && { run_seed_step "1/4 ingress" ingress || SEED_RC=$?; }
  [ "$SEED_RC" -eq 0 ] && { run_seed_step "2/4 warehouse-load" warehouse-load || SEED_RC=$?; }

  # report 无论前几步成败都要跑：让 /healthz 能给出 data_ready=false + 失败步骤
  if [ "$SEED_RC" -eq 0 ]; then
    run_seed_step "3/4 ingest-report" ingest-report || SEED_RC=$?
  else
    run_seed_step "3/4 ingest-report" ingest-report || true
  fi

  if [ -f .state/ingest-report.json ]; then
    echo "==> ingest-report：$(python3 - <<'PY'
import json
try:
    d = json.load(open(".state/ingest-report.json"))
    print(f"ready={d.get('ready')} failed_step={d.get('failed_step')} "
          f"reason={d.get('failed_reason')} quality={d.get('quality_level')}")
except Exception as exc:  # noqa: BLE001
    print(f"<不可读: {type(exc).__name__}>")
PY
)"
  else
    echo "ERROR: .state/ingest-report.json 缺失 —— 报告未写，data_ready 会按缺失处理（不掩盖）" >&2
  fi
else
  echo "==> 跳过 seed（--no-seed）：API 可能没有数据；preflight 会按 DATA_NOT_READY SKIP，不是 pass"
fi

echo "==> 启动 api / web"
"${COMPOSE[@]}" up -d --wait "${BUILD[@]}" api web

echo "==> preflight"
set +e
python3 scripts/preflight.py
PREFLIGHT_RC=$?
set -e

if [ "$SEED_RC" -ne 0 ]; then
  echo "ERROR: seed 链失败（步骤：${SEED_FAILED_STEP:-未知}，退出码 $SEED_RC）—— 栈/实现可能没问题，但数据没进来；不记 E2E 通过。" >&2
  exit "$SEED_RC"
fi
if [ "$PREFLIGHT_RC" -eq 1 ]; then
  echo "ERROR: preflight FAIL —— E2E 资产/配置有缺陷（compose/fixture/quarantine），见上方明细。" >&2
  exit 1
fi
if [ "$PREFLIGHT_RC" -eq 78 ]; then
  echo "WARN: preflight SKIP —— 栈已起，但数据/实现未就绪，E2E 用例会 skip（不是 pass）。" >&2
fi

echo
echo "栈已就绪：web=${E2E_WEB_URL:-http://127.0.0.1:3000} api=${E2E_API_URL:-http://127.0.0.1:8081} replay=${E2E_REPLAY_URL:-http://127.0.0.1:18081}"
echo "跑 E2E：cd tests/e2e && npm ci && npx playwright install chromium && npx playwright test"
