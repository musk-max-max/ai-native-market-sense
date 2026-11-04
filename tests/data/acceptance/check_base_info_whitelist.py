#!/usr/bin/env python3
"""H4 11-12 放行验收 · 第 2 项：基础信息响应字段 ⊆ H4 白名单（默认拒绝）。

H4 口径（2026-11-04 裁决，m00886）：
P0 允许展示 7 类 = 代码、名称、交易所、法定板块、证券类型、上市状态、上市日期；
`security_type` 由 H4 补进白名单；`lot_size` 不进白名单，走 D5 从契约删除（先确认无消费方）。
白名单外不放；任何价格/成交量额/涨跌幅/市值/PE/PB/财务数值进响应即失败。

用法：A11_IMPL_BASE_URL=http://127.0.0.1:PORT python3 tests/data/acceptance/check_base_info_whitelist.py
退出码：0=通过，1=失败（字段越界/缺字段/接口不可用），2=缺配置（按失败处理）。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# H4 白名单的契约字段名（instrument_id 承载「代码」，exchange 承载「交易所」）
H4_ALLOWED = {
    "instrument_id",  # 代码（EXCH:CODE）
    "exchange",       # 交易所
    "name",           # 证券名称
    "board",          # 法定板块（main/gem/star/bse）
    "security_type",  # 证券类型（stock/etf/index，H4 补入）
    "list_status",    # 上市状态
    "listed_at",      # 上市日期
}
# H4 裁决走 D5 删除的字段：白名单外且不应再由契约/实现提供
D5_REMOVED_FIELDS = {"lot_size"}
SENSITIVE = {
    "price", "last_price", "close", "open", "high", "low", "prev_close",
    "change", "change_pct", "volume", "amount", "market_cap", "pe", "pb",
    "revenue", "net_profit", "eps", "roe", "concepts", "concept_tags",
}
DEFAULT_INSTRUMENT = "SSE:600519"


def fetch(base_url: str, instrument_id: str, timeout: float = 5.0) -> tuple[int, dict]:
    url = f"{base_url.rstrip('/')}/v1/instruments/{instrument_id}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"raw": raw}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise SystemExit(f"[FAIL] 接口不可用：{error}")


def main() -> int:
    base_url = os.environ.get("A11_IMPL_BASE_URL")
    if not base_url:
        sys.stderr.write("[FAIL] 缺少 A11_IMPL_BASE_URL（验收脚本不 skip）\n")
        return 2
    instrument_id = os.environ.get("A11_PROBE_INSTRUMENT", DEFAULT_INSTRUMENT)

    status, payload = fetch(base_url, instrument_id)
    problems: list[str] = []
    if status != 200:
        problems.append(f"GET /v1/instruments/{instrument_id} 期望 200，实际 {status}")
        print(json.dumps({"status": status, "payload": payload}, ensure_ascii=False))
        return 1

    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    extra = sorted(set(data) - H4_ALLOWED)
    still_removed = sorted(set(data) & D5_REMOVED_FIELDS)
    missing = sorted(H4_ALLOWED - set(data))
    leaked = sorted(set(data) & SENSITIVE)
    if leaked:
        problems.append(f"白名单外敏感字段泄漏：{leaked}")
    if still_removed:
        problems.append(
            f"D5 已裁删除的字段仍出现在响应：{still_removed}（等 A0 契约 + A3 序列化移除后本断言转绿）"
        )
    if extra:
        problems.append(
            f"响应出现白名单外字段：{extra}（H4 口径是默认拒绝；字段要么删除，要么由 H4 书面扩白名单）"
        )
    if missing:
        problems.append(f"白名单内字段缺失：{missing}")

    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] 11-12/第2项 基础信息白名单 (data 字段集合 = {sorted(data)})")
    for problem in problems:
        print(f"  - {problem}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
