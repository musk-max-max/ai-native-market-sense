#!/usr/bin/env bash
# L32（Lead 2026-11-04 裁定）：**默认禁用**。录制真实 tushare 报文=把上游数据再分发，
# 违反 F1 个人非商业条款；「测试用」不是抗辩。仅 H4 书面批准后才可启用：
#   A12_ALLOW_REAL_TUSHARE=1 H4_APPROVAL_REF=<批准文号/邮件> bash scripts/record-fixtures.sh
# 真实上游录制 tushare fixture（A12 owns）——**默认禁用**，禁止进 CI。
#
# Lead L32（2026-11-04）裁定：不把真实 tushare 报文落仓库（F1 个人非商业条款；落仓=上游数据再分发，
# 「测试用」不是抗辩）。E2E 默认改用合成录制：
#   python3 tests/fixtures/tushare/synthetic/build_recordings.py
# 本脚本只在 H4 书面批准后使用，且必须显式 opt-in 两件事：
#   A12_ALLOW_REAL_TUSHARE=1   H4_APPROVAL_REF=<审批记录 ref/id>   TUSHARE_TOKEN=***
# 流程：起 record 模式代理（能出网、持 token）→ 真实产品跑一遍场景 → 代理把 tushare 原始响应落盘 → 关栈。
# 用法：
#   A12_ALLOW_REAL_TUSHARE=1 H4_APPROVAL_REF=... TUSHARE_TOKEN=*** bash tests/e2e/scripts/record-fixtures.sh [--keep-data]
# 前置：docker + docker compose v2；A1 adapter 的注入点已可用（TUSHARE_API_URL 环境变量契约）。
set -euo pipefail

if [ "${A12_ALLOW_REAL_TUSHARE:-0}" != "1" ] || [ -z "${H4_APPROVAL_REF:-}" ]; then
  echo "ERROR: 真实 tushare 录制默认禁用（Lead L32：F1 个人非商业条款，报文落仓=上游再分发）。" >&2
  echo "       需要 H4 书面批准后显式：A12_ALLOW_REAL_TUSHARE=1 H4_APPROVAL_REF=<批准文号> $0 ..." >&2
  echo "       E2E 常规路径用合成录制：python3 tests/fixtures/tushare/synthetic/build_recordings.py" >&2
  exit 2
fi

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$E2E_DIR"

if [ "${CI:-0}" = "1" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "ERROR: CI 禁止录制/直连真实 tushare（硬约束）。录制只能在本地人工执行。" >&2
  exit 2
fi
if [ "${A12_ALLOW_REAL_TUSHARE:-0}" != "1" ] || [ -z "${H4_APPROVAL_REF:-}" ]; then
  echo "ERROR: 真实上游录制默认禁用（Lead L32）。E2E 录制请用合成生成器：" >&2
  echo "  python3 tests/fixtures/tushare/synthetic/build_recordings.py" >&2
  echo "如已获 H4 书面批准，显式设置 A12_ALLOW_REAL_TUSHARE=1 与 H4_APPROVAL_REF=<审批记录> 后再跑。" >&2
  exit 2
fi
if [ -z "${TUSHARE_TOKEN:-}" ]; then
  echo "ERROR: 需要 TUSHARE_TOKEN（H4 提供）。token 只进容器环境，不会写入 fixtures。" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 需要 docker + docker compose v2。" >&2
  exit 1
fi

KEEP_DATA=0
for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

python3 scripts/validate_compose.py --quiet

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.record.yml)
cleanup() { echo "==> 关栈（record 模式）"; "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 干净数据：避免 api 从旧 PG 缓存直接返回，导致 adapter/replay 根本没被调用（录不到）
if [ "$KEEP_DATA" -eq 0 ]; then
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
fi

echo "==> 启动 record 模式代理 + 基础设施"
"${COMPOSE[@]}" up -d --wait postgres redis tushare-replay

# 确认代理确实处于 record（不自欺）：/__health 会暴露 mode
MODE="$(python3 - <<'PY'
import json, urllib.request
try:
    with urllib.request.urlopen("http://127.0.0.1:18081/__health", timeout=5) as r:
        print(json.load(r).get("mode", ""))
except Exception:
    print("")
PY
)"
if [ "$MODE" != "record" ]; then
  echo "ERROR: tushare-replay 未处于 record 模式（实际 '${MODE}'），拒绝继续。" >&2
  exit 1
fi

echo "==> 启动产品栈（api/web/ingest 仍指向代理，业务代码无感知）"
"${COMPOSE[@]}" up -d --build --wait api web

echo "==> 一次性 ingest：驱动 adapter → 代理 → 真实 tushare → 落盘"
"${COMPOSE[@]}" --profile seed run --rm ingest-once || echo "WARN: ingest-once 失败（实现可能未就绪）；继续用产品 API 驱动录制"

echo "==> 按场景驱动产品调用"
python3 - <<'PY'
import json, os, urllib.error, urllib.request
from pathlib import Path

base = os.environ.get("E2E_WEB_URL", "http://127.0.0.1:3000").rstrip("/")
scenario = json.loads(Path("../fixtures/tushare/scenarios/p0-stock-page.json").read_text())
inst = scenario["instrument_id"]
token = os.environ.get("E2E_AUTH_TOKEN", "")
failed = 0
for call in scenario["calls"]:
    if call.get("auth") and not token:
        print(f"SKIP  {call['name']}（需要 E2E_AUTH_TOKEN，watchlist 不涉 tushare）")
        continue
    path = call["path"].format(instrument_id=inst)
    body = json.loads(json.dumps(call.get("body") or {}).replace("{instrument_id}", inst)) if call.get("body") else None
    headers = {"Accept": "application/json"}
    if body:
        headers["Content-Type"] = "application/json"
    if token and call.get("auth"):
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(base + path, method=call["method"], headers=headers,
                                     data=json.dumps(body).encode() if body else None)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except Exception as exc:
        print(f"FAIL  {call['name']}: {type(exc).__name__}: {exc}")
        failed += 1
        continue
    marker = "OK  " if status == call.get("expect_status") else "DIFF"
    print(f"{marker} {call['name']}: status={status}（期望 {call.get('expect_status')}） hop={call.get('hop')}")
print(f"产品调用完成，非预期 {failed} 次（实现未就绪时属于预期）")
PY

echo "==> 等待录制落盘（RECORD_SETTLE_SECONDS=${RECORD_SETTLE_SECONDS:-5}s）"
sleep "${RECORD_SETTLE_SECONDS:-5}"

echo "==> 录制结果"
python3 - <<'PY'
import json, os, urllib.request
from pathlib import Path

try:
    with urllib.request.urlopen("http://127.0.0.1:18081/__health", timeout=5) as r:
        health = json.load(r)
    print(json.dumps(health, ensure_ascii=False, indent=2))
except Exception as exc:
    print(f"WARN: 读 /__health 失败：{exc}")

recordings = Path("../fixtures/tushare/recordings")
files = sorted(recordings.glob("*.json"))
print(f"\n录制文件：{len(files)} 条")
apis = []
for path in files:
    try:
        doc = json.loads(path.read_text())
        apis.append((doc.get("request") or {}).get("api_name"))
        print(f"  - {path.name}  api={apis[-1]}  bytes={path.stat().st_size}")
    except Exception as exc:
        print(f"  ! {path.name} 解析失败：{exc}")
print(f"覆盖 tushare 接口：{sorted(set(a for a in apis if a))}")
if not files:
    print("\nWARN: 一条都没录到。常见原因：ingest-once 未真正调用 adapter / adapter 没走 TUSHARE_API_URL 注入点 / token 无效。")
PY

echo
echo "录制完成。请检查 tests/fixtures/tushare/recordings/ 与 manifest.json，然后 commit。"
echo "验证回放：python3 scripts/validate_compose.py && bash scripts/up.sh && python3 scripts/preflight.py（应 READY 或 FIXTURE 相关 FAIL→修正）"
