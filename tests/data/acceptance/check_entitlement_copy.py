#!/usr/bin/env python3
"""H4 11-12 放行验收 · 附加项：fail-closed 文案一致性（四种原因逐字节相同、不含标识）。

H4 m00997 口径：
- expired / hold_active / hold_stale / unauthorized_config 四种原因触发的 403，人类可读文案
  （title + detail）必须**逐字节相同**；
- 文案不得含任何原因/渠道/供应商标识（不得出现 expired/hold/stale/config/tier/tushare/
  platform_* 等词，也不得出现数字或"授权/到期"这类可推断原因的表述）。

场景如何产生（被测服务侧）：
- expired             ：c_end_display + ENTITLEMENT_EXPIRES_AT=过去时刻；
- unauthorized_config ：research_only + 未来到期（层级本身不许可 C 端展示）；
- hold_active / hold_stale：需要 A3 的 control 表支持 + A13 seed，脚本通过
  `A11_HOLD_ACTIVE_BASE_URL` / `A11_HOLD_STALE_BASE_URL` 指向已就绪实例；
  未提供则这两条 FAIL（BLOCKED，不 skip）。

用法：
  python3 tests/data/acceptance/check_entitlement_copy.py
  # 可选：A11_COPY_TIMEOUT_SECONDS（默认 60，每个场景起 harness 的超时）

退出码：0 通过 / 1 失败 / 2 缺配置（按失败处理，不 skip）。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "..", "..", "contract", "live_harness", "harness.ts")
TSX_BINARY = os.path.join(HERE, "..", "..", "..", "services", "market", "node_modules", ".bin", "tsx")
PROBE_INSTRUMENT = os.environ.get("A11_PROBE_INSTRUMENT", "SSE:600519")
QUOTE_PATH = f"/v1/instruments/{PROBE_INSTRUMENT}/quote"

# 文案里不得出现的标识（原因/渠道/供应商）。数字一并禁止：价格类文案不应带数字。
FORBIDDEN_IN_COPY = re.compile(
    r"(?i)(expired|expire|hold|stale|config|tier|tushare|wind|choice|ifind|akshare|eastmoney|"
    r"platform_|source_id|delayed|eod|snapshot|reconcile|授权|到期|过期|降级|渠道|供应商|\d)"
)

SPAWNED_SCENARIOS = {
    "expired": {
        "ENTITLEMENT_TIER": "c_end_display",
        "ENTITLEMENT_EXPIRES_AT": "2026-11-01T00:00:00+08:00",
    },
    "unauthorized_config": {
        "ENTITLEMENT_TIER": "research_only",
        "ENTITLEMENT_EXPIRES_AT": "2027-01-01T00:00:00+08:00",
    },
}
EXTERNAL_SCENARIOS = {
    "hold_active": "A11_HOLD_ACTIVE_BASE_URL",
    "hold_stale": "A11_HOLD_STALE_BASE_URL",
}


def http_json(base_url: str, path: str) -> tuple[int, dict]:
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"raw": raw}
    except (urllib.error.URLError, TimeoutError) as error:
        raise SystemExit(f"[FAIL] 接口不可用：{error}")


def spawn_harness(extra_env: dict[str, str], timeout_seconds: float) -> tuple[subprocess.Popen | None, str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ENTITLEMENT_") and key != "MARKET_NOW"}
    env.update(extra_env)
    process = subprocess.Popen(
        [TSX_BINARY, HARNESS],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        cwd=HERE,
    )
    try:
        line = process.stdout.readline() if process.stdout else ""
        if not line.strip():
            stderr = process.stderr.read()[-500:] if process.stderr else ""
            return process, "", f"harness 未输出 baseUrl（rc={process.poll()}）: {stderr}"
        return process, json.loads(line)["baseUrl"], ""
    except (json.JSONDecodeError, KeyError) as error:
        return process, "", f"harness 输出无法解析：{error}"


def collect_copy(base_url: str) -> tuple[tuple[str, str] | None, list[str]]:
    status, payload = http_json(base_url, QUOTE_PATH)
    problems: list[str] = []
    if status != 403:
        return None, [f"{QUOTE_PATH} 期望 403，实际 {status}"]
    if payload.get("code") != "ENTITLEMENT_RESTRICTED":
        problems.append(f"403 但 code={payload.get('code')!r}（期望 ENTITLEMENT_RESTRICTED）")
    copy = (str(payload.get("title", "")), str(payload.get("detail", "")))
    for part_name, text in zip(("title", "detail"), copy):
        match = FORBIDDEN_IN_COPY.search(text)
        if match:
            problems.append(f"{part_name} 含原因/渠道/供应商标识或数字：{match.group(0)!r}（文案={text!r}）")
    if not copy[0] or not copy[1]:
        problems.append("title/detail 不得为空（人类可读文案必须存在）")
    return copy, problems


def main() -> int:
    if not os.path.exists(TSX_BINARY):
        sys.stderr.write(f"[FAIL] 找不到 tsx：{TSX_BINARY}\n")
        return 2
    timeout_seconds = float(os.environ.get("A11_COPY_TIMEOUT_SECONDS", "60"))

    copies: dict[str, tuple[str, str]] = {}
    problems: list[str] = []

    for name, extra_env in SPAWNED_SCENARIOS.items():
        process, base_url, error = spawn_harness(extra_env, timeout_seconds)
        try:
            if error:
                problems.append(f"{name}: {error}")
                continue
            copy, item_problems = collect_copy(base_url)
            problems += [f"{name}: {problem}" for problem in item_problems]
            if copy is not None:
                copies[name] = copy
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()

    for name, env_name in EXTERNAL_SCENARIOS.items():
        base_url = os.environ.get(env_name)
        if not base_url:
            problems.append(f"{name}: BLOCKED，未提供 {env_name}（需要 control 表 + A3 hold 判定就绪）")
            continue
        copy, item_problems = collect_copy(base_url)
        problems += [f"{name}: {problem}" for problem in item_problems]
        if copy is not None:
            copies[name] = copy

    if len(copies) >= 2:
        baseline_name = next(iter(copies))
        baseline = copies[baseline_name]
        for name, copy in copies.items():
            if copy != baseline:
                problems.append(
                    f"{name} 文案与 {baseline_name} 不一致：{copy!r} != {baseline!r}"
                    f"（H4 m00997 要求逐字节相同）"
                )

    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] 11-12/附加 fail-closed 文案一致性（{len(copies)}/4 场景可比）")
    for problem in problems:
        print(f"  - {problem}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
