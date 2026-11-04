#!/usr/bin/env python3
"""11-12 放行验收 · 第 4 条（no-store 部分，lead L38 定稿）。

口径：**对所有 `/v1/*` 响应无条件加 `Cache-Control: no-store`**，不按"有没有 meta.entitlement"判断。
理由：行情数据带 as_of，缓存一次就是一次静默陈旧；按内容判断等于给每个新接口埋一次漏配机会。

做法：读 consumer 录播样本（`tests/contract/specimens/consumer/*.json`），把每个 call 原样打到被测服务，
逐条断言响应头 no-store。覆盖 7 个 operation；样本缺 operation 视为失败（防漏扫）。

用法：
  A11_IMPL_BASE_URL=http://127.0.0.1:PORT python3 tests/data/acceptance/check_no_store_all.py
  A11_NO_STORE_TOKEN=…（自选接口需要的 Bearer；缺省不覆盖样本自带 token）
退出码：0 通过 / 1 失败 / 2 缺配置。
"""

from __future__ import annotations

import glob
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
CONSUMER_DIR = os.path.join(REPO_ROOT, "tests", "contract", "specimens", "consumer")


def load_calls() -> list[dict]:
    calls: list[dict] = []
    for path in sorted(glob.glob(os.path.join(CONSUMER_DIR, "*.json"))):
        with open(path, encoding="utf-8") as handle:
            specimen = json.load(handle)
        for call in specimen.get("calls", []):
            calls.append({"operation_id": specimen.get("operation_id", os.path.basename(path)), "call": call})
    return calls


def send(base_url: str, request_spec: dict) -> tuple[int, dict[str, str]]:
    method = request_spec.get("method", "GET").upper()
    path = request_spec.get("path", "")
    query = request_spec.get("query") or {}
    if query:
        from urllib.parse import urlencode

        path = f"{path}?{urlencode(query)}"
    headers = dict(request_spec.get("headers") or {})
    headers.setdefault("Accept", "application/json")
    token = os.environ.get("A11_NO_STORE_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = request_spec.get("body")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data is not None:
        headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
            return response.status, {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as error:
        error.read()
        parsed = {key.lower(): value for key, value in error.headers.items()} if error.headers else {}
        return error.code, parsed
    except (urllib.error.URLError, TimeoutError) as error:
        raise SystemExit(f"[FAIL] 接口不可用：{error}")


def main() -> int:
    base_url = os.environ.get("A11_IMPL_BASE_URL")
    if not base_url:
        sys.stderr.write("[FAIL] 缺少 A11_IMPL_BASE_URL（验收脚本不 skip）\n")
        return 2
    calls = load_calls()
    if not calls:
        print("[FAIL] 11-12/第4条 no-store\n  - 没有 consumer 样本可打，无法覆盖 /v1/*")
        return 1
    problems: list[str] = []
    checked_operations: set[str] = set()
    for item in calls:
        operation_id = item["operation_id"]
        request_spec = item["call"].get("request") or {}
        status, headers = send(base_url, request_spec)
        checked_operations.add(operation_id)
        cache_control = headers.get("cache-control", "")
        if "no-store" not in cache_control.lower():
            problems.append(
                f"{operation_id} {request_spec.get('method', 'GET')} {request_spec.get('path')} → {status} "
                f"缺 Cache-Control: no-store（实际 {cache_control!r}）"
            )
    if len(checked_operations) < 7:
        problems.append(f"只覆盖了 {len(checked_operations)} 个 operation（应覆盖全部 7 个）")
    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] 11-12/第4条 no-store（{len(calls)} 次调用 / {len(checked_operations)} 个 operation）")
    for problem in problems:
        print(f"  - {problem}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
