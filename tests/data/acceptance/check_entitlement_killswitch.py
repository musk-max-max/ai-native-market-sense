#!/usr/bin/env python3
"""H4 11-12 放行验收 · 第 1 项（可执行部分）：受限档下 403 fail-closed 与响应形状。

前置：被测服务以受限档启动（tier=internal_eval，is_entitled=false）：
  ENTITLEMENT_TIER=internal_eval <启动命令>
用法：
  A11_IMPL_BASE_URL=http://127.0.0.1:PORT python3 tests/data/acceptance/check_entitlement_killswitch.py
退出码：0=通过，1=失败，2=缺配置（按失败处理）。

覆盖：服务判定（403 ENTITLEMENT_RESTRICTED，不退化成 200/404）、响应形状（Problem 体不含
任何可判读行情/财务数值）、基础信息不受影响但 entitlement.is_entitled=false、未知标的不误报 403。
**未覆盖**：F1 到期日置为已过后自动 fail-closed —— 实现尚无 deadline 配置（见回报）。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

NUMERIC_LEAK_KEYS = {
    "last_price", "close", "open", "high", "low", "prev_close", "change",
    "change_pct", "volume", "amount", "revenue", "net_profit", "eps", "roe",
    "gross_margin", "total_assets", "yoy", "pe", "pb", "market_cap",
}
RESTRICTED_PATHS = (
    "/v1/instruments/SSE:600519/quote",
    "/v1/instruments/SSE:600519/bars",
    "/v1/instruments/SSE:600519/fundamental-summary",
)
INSTRUMENT_PATH = "/v1/instruments/SSE:600519"
UNKNOWN_PATH = "/v1/instruments/SSE:999999/quote"


def request(base_url: str, path: str, timeout: float = 5.0) -> tuple[int, dict]:
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"raw": raw}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise SystemExit(f"[FAIL] 接口不可用：{error}")


def walk_keys(node, prefix="") -> list[str]:
    keys: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            keys.append(f"{prefix}{key}")
            keys.extend(walk_keys(value, f"{prefix}{key}."))
    elif isinstance(node, list):
        for item in node:
            keys.extend(walk_keys(item, prefix))
    return keys


def main() -> int:
    base_url = os.environ.get("A11_IMPL_BASE_URL")
    if not base_url:
        sys.stderr.write("[FAIL] 缺少 A11_IMPL_BASE_URL（验收脚本不 skip）\n")
        return 2
    problems: list[str] = []

    for path in RESTRICTED_PATHS:
        status, body = request(base_url, path)
        if status != 403:
            problems.append(f"{path}: 期望 403，实际 {status}（退化成 200/404 即 fail-open）")
            continue
        if body.get("code") != "ENTITLEMENT_RESTRICTED":
            problems.append(f"{path}: 403 但 code={body.get('code')!r}，期望 ENTITLEMENT_RESTRICTED")
        if not body.get("trace_id"):
            problems.append(f"{path}: Problem 缺 trace_id（无法审计定位）")
        leaked = sorted({k.split(".")[-1] for k in walk_keys(body)} & NUMERIC_LEAK_KEYS)
        if leaked:
            problems.append(f"{path}: 403 响应体泄漏可判读数值字段 {leaked}（fail-closed 必须无数据）")

    status, body = request(base_url, INSTRUMENT_PATH)
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    if status != 200:
        problems.append(f"{INSTRUMENT_PATH}: 基础信息应可展示（ADR-001：不因授权整体 403），实际 {status}")
    elif data and (body.get("meta", {}).get("entitlement", {}).get("is_entitled") is not False):
        problems.append(f"{INSTRUMENT_PATH}: 受限档下 meta.entitlement.is_entitled 必须为 false")
    if set(data) & NUMERIC_LEAK_KEYS:
        problems.append(f"{INSTRUMENT_PATH}: 基础信息出现受授权约束字段 {sorted(set(data) & NUMERIC_LEAK_KEYS)}")

    # L83/H4 m02822 语义变更：受限/降级档 403 短路先于存在性检查。
    # 本脚本是早期版本，新口径以 check_entitlement_ordering.py 为准；这里同步保持不误导。
    status, body = request(base_url, UNKNOWN_PATH)
    if status != 403 or body.get("code") != "ENTITLEMENT_RESTRICTED":
        problems.append(
            f"{UNKNOWN_PATH}: 受限档未收录标的期望 403 ENTITLEMENT_RESTRICTED（403 短路，不泄漏存在性），"
            f"实际 {status}/{body.get('code')!r}"
        )
    elif "INSTRUMENT_NOT_FOUND" in json.dumps(body, ensure_ascii=False):
        problems.append(f"{UNKNOWN_PATH}: 受限档泄漏 INSTRUMENT_NOT_FOUND（存在性可被判读）")

    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] 11-12/第1项 受限档 fail-closed（可执行部分）")
    for problem in problems:
        print(f"  - {problem}")
    print("  未覆盖：F1 到期日翻转（实现无 deadline 配置，等待 A3/A2 定义接口）")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
