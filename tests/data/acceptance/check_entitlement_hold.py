#!/usr/bin/env python3
"""H4 11-12 放行验收 · 附加项：entitlement hold（控制表陈旧 / 读取不可达都必须 fail-closed）。

H4 m00967 口径：
1. `entitlement_hold` 的 `last_reconciled_at` 置为 16 分钟前 → 行情接口 403（不得 200）；
   hold=true → 行情接口 403（不得 200），且基础信息仍 200、meta.entitlement 降级为 internal_eval。
2. hold 表读取不可达（注入 PG 超时）→ 行情接口 403；延迟不得被打爆（5s 负缓存 + 熔断，
   P95 不超过阈值）。

设计约束（L23/L24）：
- P0 只落「启动时读 control + 无条件写 tier_state_observed」，reconciler 在 P1；因此
  `stale` 模式要求被测服务是在**control 表已被 seed 为 16 分钟前**之后启动的；
- 事件 schema owner 是 A5（L24），A3 只 INSERT，A13 出迁移/角色；A11 只读校验，不写库；
- hold 只能人工清（T2+H5 工单），脚本不 set/clear。

用法：
  A11_IMPL_BASE_URL=http://127.0.0.1:PORT A11_HOLD_MODE=stale \
  A11_HOLD_DSN=postgresql://... A11_HOLD_CONTROL_TABLE=audit.entitlement_hold \
  A11_HOLD_STALE_MINUTES=15 A11_HOLD_P95_MS=1500 \
  python3 tests/data/acceptance/check_entitlement_hold.py

  stale      ：校验控制表确实处于「hold 或 last_reconciled_at 早于 15 分钟」，再断言行情 403；
  hold       ：校验控制表 hold=true，断言行情 403、基础信息 200 且 tier=internal_eval/is_entitled=false；
  unreachable：被测服务以不可达的 PG 启动（A11_UNREACHABLE_BASE_URL），断言行情 403 且 P95 ≤ 阈值。

退出码：0 通过 / 1 失败 / 2 缺配置（按失败处理，不 skip）。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROBE_INSTRUMENT = os.environ.get("A11_PROBE_INSTRUMENT", "SSE:600519")
MARKET_PATHS = (
    f"/v1/instruments/{PROBE_INSTRUMENT}/quote",
    f"/v1/instruments/{PROBE_INSTRUMENT}/bars",
    f"/v1/instruments/{PROBE_INSTRUMENT}/fundamental-summary",
)
NUMERIC_LEAK_KEYS = {
    "last_price", "prev_close", "change", "change_pct", "open", "high", "low",
    "close", "volume", "amount", "revenue", "net_profit", "eps", "roe",
    "gross_margin", "total_assets", "market_cap", "pe", "pb",
}
PSQL_BINARY = shutil.which("psql") or "/opt/homebrew/bin/psql"


def http(base_url: str, path: str, timeout: float = 10.0) -> tuple[int, dict, float]:
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", headers={"Accept": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8")), (time.monotonic() - started) * 1000
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        elapsed = (time.monotonic() - started) * 1000
        try:
            return error.code, json.loads(raw), elapsed
        except json.JSONDecodeError:
            return error.code, {"raw": raw}, elapsed
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise SystemExit(f"[FAIL] 接口不可用：{error}")


def leaked_keys(node, found: set[str]) -> set[str]:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in NUMERIC_LEAK_KEYS:
                found.add(key)
            leaked_keys(value, found)
    elif isinstance(node, list):
        for item in node:
            leaked_keys(item, found)
    return found


def psql_one(dsn: str, sql: str) -> tuple[dict | None, str]:
    if not os.path.exists(PSQL_BINARY):
        return None, f"找不到 psql（{PSQL_BINARY}），无法读取控制表"
    completed = subprocess.run(
        [PSQL_BINARY, dsn, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode != 0:
        return None, f"控制表查询失败（表/角色未就绪？）：{completed.stderr.strip()[-500:]}"
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        return None, "控制表为空：需要 A13 迁移 + seed（hold 或 last_reconciled_at 置 16 分钟前）"
    try:
        return json.loads(lines[0]), ""
    except json.JSONDecodeError:
        return None, f"控制表行不是合法 JSON：{lines[0][:200]!r}"


def check_control_row(dsn: str, table: str, stale_minutes: int) -> list[str]:
    sql = (
        "select row_to_json(t) from (select * from " + table + " order by last_reconciled_at desc nulls first limit 1) t"
    )
    row, error = psql_one(dsn, sql)
    if error:
        return [error]
    problems: list[str] = []
    if "last_reconciled_at" not in row:
        return [f"控制表 {table} 缺少 last_reconciled_at 列：{sorted(row)}"]
    age_sql = (
        "select row_to_json(t) from (select now() - last_reconciled_at as age, "
        "extract(epoch from (now() - last_reconciled_at))/60 as age_minutes, last_reconciled_at "
        "from " + table + " order by last_reconciled_at desc nulls first limit 1) t"
    )
    aged, error = psql_one(dsn, age_sql)
    if error:
        return [error]
    age_minutes = float(aged.get("age_minutes") or 0)
    if age_minutes < stale_minutes:
        problems.append(
            f"控制表未处于陈旧态：last_reconciled_at 距今 {age_minutes:.1f} 分钟（要求 ≥{stale_minutes} 分钟，H4 用 16 分钟）"
        )
    return problems


def check_hold_flag(dsn: str, table: str) -> list[str]:
    row, error = psql_one(dsn, "select row_to_json(t) from (select * from " + table + " order by id limit 1) t")
    if error:
        return [error]
    if "hold" not in row:
        return [f"控制表 {table} 缺少 hold 列：{sorted(row)}"]
    if row.get("hold") is not True:
        return [f"控制表 hold 不为 true（实际 {row.get('hold')!r}），无法验证 hold 生效路径"]
    return []


def check_instrument_degraded(base_url: str) -> list[str]:
    status, payload, _ = http(base_url, f"/v1/instruments/{PROBE_INSTRUMENT}")
    problems: list[str] = []
    if status != 200:
        problems.append(f"hold 生效时基础信息应仍 200（不泄漏行情即可），实际 {status}")
        return problems
    entitlement = (payload.get("meta") or {}).get("entitlement") or {}
    if entitlement.get("tier") != "internal_eval":
        problems.append(f"hold 生效时 meta.entitlement.tier 应为 internal_eval，实际 {entitlement.get('tier')!r}")
    if entitlement.get("is_entitled") is not False:
        problems.append(f"hold 生效时 meta.entitlement.is_entitled 应为 false，实际 {entitlement.get('is_entitled')!r}")
    leaked = sorted(leaked_keys(payload, set()))
    if leaked:
        problems.append(f"基础信息响应含可判读数值字段：{leaked}")
    return problems


def check_market_denied(base_url: str) -> list[str]:
    problems: list[str] = []
    for path in MARKET_PATHS:
        status, payload, _ = http(base_url, path)
        if status != 403:
            problems.append(f"{path} 期望 403（hold/对账失效 fail-closed），实际 {status}")
            continue
        if payload.get("code") != "ENTITLEMENT_RESTRICTED":
            problems.append(f"{path} 403 但 code={payload.get('code')!r}（期望 ENTITLEMENT_RESTRICTED）")
        leaked = sorted(leaked_keys(payload, set()))
        if leaked:
            problems.append(f"{path} 403 响应体仍含可判读数值字段：{leaked}")
    return problems


def check_latency(base_url: str, p95_ms: float) -> list[str]:
    samples: list[float] = []
    problems = check_market_denied(base_url)
    if problems:
        return problems
    for _ in range(20):
        _, _, elapsed = http(base_url, MARKET_PATHS[0])
        samples.append(elapsed)
    samples.sort()
    p95 = samples[max(0, int(len(samples) * 0.95) - 1)]
    if p95 > p95_ms:
        return [f"hold 不可达时延迟被打爆：P95={p95:.1f}ms > 阈值 {p95_ms:.1f}ms（要求 5s 负缓存 + 熔断）"]
    print(f"  p95={p95:.1f}ms（阈值 {p95_ms:.1f}ms，样本 {len(samples)}）")
    return []


def main() -> int:
    mode = os.environ.get("A11_HOLD_MODE", "stale")
    if mode not in {"stale", "hold", "unreachable"}:
        sys.stderr.write("[FAIL] A11_HOLD_MODE 只能是 stale、hold 或 unreachable\n")
        return 2
    p95_ms = float(os.environ.get("A11_HOLD_P95_MS", "1500"))
    stale_minutes = int(os.environ.get("A11_HOLD_STALE_MINUTES", "15"))

    if mode == "stale":
        base_url = os.environ.get("A11_IMPL_BASE_URL")
        dsn = os.environ.get("A11_HOLD_DSN") or os.environ.get("DATABASE_URL", "")
        if not base_url or not dsn:
            sys.stderr.write("[FAIL] stale 模式需要 A11_IMPL_BASE_URL 与 A11_HOLD_DSN/DATABASE_URL\n")
            return 2
        table = os.environ.get("A11_HOLD_CONTROL_TABLE", "audit.entitlement_hold")
        problems = check_control_row(dsn, table, stale_minutes) + check_market_denied(base_url)
    elif mode == "hold":
        base_url = os.environ.get("A11_IMPL_BASE_URL")
        dsn = os.environ.get("A11_HOLD_DSN") or os.environ.get("DATABASE_URL", "")
        if not base_url or not dsn:
            sys.stderr.write("[FAIL] hold 模式需要 A11_IMPL_BASE_URL 与 A11_HOLD_DSN/DATABASE_URL\n")
            return 2
        table = os.environ.get("A11_HOLD_CONTROL_TABLE", "audit.entitlement_hold")
        problems = (
            check_hold_flag(dsn, table)
            + check_market_denied(base_url)
            + check_instrument_degraded(base_url)
        )
    else:
        base_url = os.environ.get("A11_UNREACHABLE_BASE_URL") or os.environ.get("A11_IMPL_BASE_URL")
        if not base_url:
            sys.stderr.write("[FAIL] unreachable 模式需要 A11_UNREACHABLE_BASE_URL（服务以不可达 PG 启动）\n")
            return 2
        problems = check_latency(base_url, p95_ms)

    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] 11-12/附加 hold（mode={mode}）")
    for problem in problems:
        print(f"  - {problem}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
