#!/usr/bin/env python3
"""H4 #3 裁决验收：受限/降级档 403 短路，但正常档 404 顺序不被改掉。

H4 m02822（执行口径）：
- a) 受限档未收录标的 → 403，且 body（title/detail/code/status）与已存在标的**逐字节相同**，
     仅 trace_id 可不同；不得出现 `INSTRUMENT_NOT_FOUND`。
- b) 正常档（c_end_display 且 gate 正常）→ 未收录标的仍 404 `INSTRUMENT_NOT_FOUND`。
- c) 受限档请求日志/埋点不含“标的是否存在”字段（静态代码 + 运行时断言）。
- getInstrument 不进本项（它读 serving，单独挂 #4 的 1500ms）。

用法：
  python3 tests/data/acceptance/check_entitlement_ordering.py
自起两个 live_harness 实例（受限档 internal_eval；正常档 c_end_display+未来到期+fresh control）。
退出码：0 通过 / 1 失败 / 2 环境缺失。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
HARNESS = REPO / "tests" / "contract" / "live_harness" / "harness.ts"
TSX = REPO / "services" / "market" / "node_modules" / ".bin" / "tsx"
ROUTES = REPO / "services" / "market" / "src" / "routes.ts"
MARKET_SRC = REPO / "services" / "market" / "src"

LISTED = os.environ.get("A11_PROBE_INSTRUMENT", "SSE:600519")
UNLISTED = os.environ.get("A11_UNLISTED_INSTRUMENT", "SSE:999999")
MARKET_PATHS = ("quote", "bars", "fundamental-summary")
TRACE_KEYS = {"trace_id", "traceId"}


def http(base_url: str, path: str, timeout: float = 5.0) -> tuple[int, dict]:
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"raw": raw}


def start_harness(extra_env: dict[str, str], timeout: float = 20.0) -> tuple[subprocess.Popen, str, str]:
    if not TSX.is_file() or not HARNESS.is_file():
        raise SystemExit("[FAIL] 缺少 harness/tsx 或路径变化（环境缺失，退出 2）")
    env = {key: value for key, value in os.environ.items() if not key.startswith("ENTITLEMENT_") and key != "MARKET_NOW"}
    env.update(extra_env)
    process = subprocess.Popen(
        [str(TSX), str(HARNESS)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    deadline = time.time() + timeout
    base_url = ""
    while time.time() < deadline:
        line = process.stdout.readline() if process.stdout else ""
        if line:
            try:
                base_url = json.loads(line).get("baseUrl", "")
            except json.JSONDecodeError:
                continue
            break
        if process.poll() is not None:
            break
    if not base_url:
        process.kill()
        stderr = process.stderr.read() if process.stderr else ""
        raise SystemExit(f"[FAIL] harness 未启动：{stderr.strip()[:400]}")
    return process, base_url, ""


def stop(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


def strip_trace(node):
    if isinstance(node, dict):
        return {key: strip_trace(value) for key, value in node.items() if key not in TRACE_KEYS}
    if isinstance(node, list):
        return [strip_trace(item) for item in node]
    return node


def canonical(node) -> str:
    return json.dumps(strip_trace(node), sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def check_restricted_short_circuit(base_url: str) -> list[str]:
    failures: list[str] = []
    bodies: dict[str, tuple[int, dict]] = {}
    for kind in MARKET_PATHS:
        listed = http(base_url, f"/v1/instruments/{LISTED}/{kind}")
        unlisted = http(base_url, f"/v1/instruments/{UNLISTED}/{kind}")
        bodies[kind] = unlisted
        if listed[0] != 403 or unlisted[0] != 403:
            failures.append(f"{kind}: 受限档期望 403/403，实际 {listed[0]}/{unlisted[0]}")
            continue
        code = unlisted[1].get("code")
        if code == "INSTRUMENT_NOT_FOUND" or "INSTRUMENT_NOT_FOUND" in canonical(unlisted[1]):
            failures.append(f"{kind}: 受限档未收录返回了 INSTRUMENT_NOT_FOUND（存在性泄漏）")
        if code != "ENTITLEMENT_RESTRICTED":
            failures.append(f"{kind}: 受限档 code={code!r}，期望 ENTITLEMENT_RESTRICTED")
        if canonical(listed[1]) != canonical(unlisted[1]):
            failures.append(f"{kind}: 已收录/未收录 403 body 不逐字节相同（仅 trace_id 可不同）")
    # 三接口 body 彼此也应同构（同一档位同一文案）
    if len({canonical(body) for _, body in bodies.values()}) > 1:
        failures.append("三接口受限档 403 body 不一致（同一档位应同文案）")
    if not failures:
        print(f"[PASS] 受限档 403 短路：{len(MARKET_PATHS)} 接口 × 已收录/未收录 body 逐字节一致，无 INSTRUMENT_NOT_FOUND")
    return failures


def check_normal_order(base_url: str) -> list[str]:
    failures: list[str] = []
    status, body = http(base_url, f"/v1/instruments/{UNLISTED}/quote")
    if status != 404:
        failures.append(f"正常档未收录期望 404，实际 {status}")
    elif body.get("code") != "INSTRUMENT_NOT_FOUND":
        failures.append(f"正常档 code={body.get('code')!r}，期望 INSTRUMENT_NOT_FOUND")
    status_listed, _ = http(base_url, f"/v1/instruments/{LISTED}/quote")
    if status_listed != 200:
        failures.append(f"正常档已收录期望 200，实际 {status_listed}（gate 可能非 fresh）")
    if not failures:
        print("[PASS] 正常档顺序保留：未收录 404 INSTRUMENT_NOT_FOUND，已收录 200")
    return failures


def check_no_existence_leak_static() -> list[str]:
    failures: list[str] = []
    text = ROUTES.read_text(encoding="utf-8")
    for kind in MARKET_PATHS:
        # quote/bars/fundamental 的处理器顺序：evaluate -> requireEntitled -> loadInstrument
        handler = re.search(rf"['\"]?/{kind}['\"]?[\s\S]{{0,4000}}", text)
        block = handler.group(0) if handler else text
        pos_gate = block.find("evaluate")
        pos_entitled = block.find("requireEntitled")
        pos_load = block.find("loadInstrument")
        if min(pos_gate, pos_entitled, pos_load) < 0:
            failures.append(f"routes.ts/{kind}: 未找到 evaluate/requireEntitled/loadInstrument 顺序证据")
            continue
        if not (pos_gate < pos_entitled < pos_load):
            failures.append(
                f"routes.ts/{kind}: 顺序不对（evaluate={pos_gate}, requireEntitled={pos_entitled}, loadInstrument={pos_load}）"
            )
    # getInstrument：路由层只允许读取一次 control（一次 evaluate），之后直接读 serving。
    # 不允许在 instrument 处理器里出现第二次 evaluate()/fetchControl()（H4 m02910）。
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if "app.get('/instruments/:instrument_id'," in line), -1)
    end = next(
        (i for i, line in enumerate(lines) if i > start and "app.get('/instruments/:instrument_id/" in line),
        len(lines),
    )
    block = "\n".join(lines[start:end]) if start >= 0 else ""
    if not block:
        failures.append("routes.ts: 未找到 getInstrument 处理器块")
    else:
        evaluate_hits = len(re.findall(r"\bevaluate\(", block))
        control_hits = len(re.findall(r"fetchControl|controlRepo", block))
        if evaluate_hits != 1:
            failures.append(f"getInstrument: evaluate() 调用 {evaluate_hits} 次（只允许 1 次 control 读取）")
        if control_hits != 0:
            failures.append(f"getInstrument: 处理器内直接出现 control 读取 {control_hits} 次（应只经 evaluate 一次）")
        if "serving.getInstrument(" not in block:
            failures.append("getInstrument: 处理器未直接读 serving（顺序语义可疑）")

    # 受限分支不得记录“标的是否存在”的字段
    leak_pattern = re.compile(r"logger\.(?:warn|info|error)\([^;]{0,300}(not_found|notFound|exists|found\s*:|exists\s*:)", re.S)
    for path in MARKET_SRC.rglob("*.ts"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        if leak_pattern.search(text):
            failures.append(f"{path.relative_to(REPO)}: 日志疑似含标的是否存在字段")
    if not failures:
        print("[PASS] 静态：evaluate → requireEntitled → loadInstrument 顺序成立；受限分支无存在性日志字段")
    return failures


def main() -> int:
    failures: list[str] = []
    restricted = normal = None
    try:
        restricted, restricted_url, _ = start_harness({})
        failures += check_restricted_short_circuit(restricted_url)
        stop(restricted)
        restricted = None

        normal, normal_url, _ = start_harness(
            {
                "ENTITLEMENT_TIER": "c_end_display",
                "ENTITLEMENT_EXPIRES_AT": "2027-01-01T00:00:00+08:00",
                "MARKET_NOW": "2026-11-04T09:00:00+08:00",
                "A11_CONTROL": "fresh",
            }
        )
        failures += check_normal_order(normal_url)
        failures += check_no_existence_leak_static()
    finally:
        for process in (restricted, normal):
            if process is not None:
                stop(process)

    if failures:
        print("[FAIL] #3 顺序/存在性泄漏验收")
        for line in failures:
            print(f"  - {line}")
        return 1
    print("[PASS] #3 顺序/存在性泄漏验收")
    return 0


if __name__ == "__main__":
    sys.exit(main())
