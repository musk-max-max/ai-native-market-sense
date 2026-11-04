#!/usr/bin/env python3
"""11-12 放行验收 · 限流桶（4 条，lead L36 / H4 m01055）。

口径：
1. 第 61 次请求 → 429，`Retry-After` 为整数且 ≥1 秒；
2. 429 响应为 application/problem+json，code=RATE_LIMITED；
3. 伪造 `X-Forwarded-For` 不换桶（同一客户端仍被限）；
4. 429 文案不露内部码/阈值/桶 key（不出现 rate_limit_key、limit=60、bucket 等）。

前置：被测服务开限流（默认按客户端 IP 桶，N=60/窗口）。脚本用第 61 次触发。
用法：
  A11_IMPL_BASE_URL=http://127.0.0.1:PORT python3 tests/data/acceptance/check_rate_limit.py
  A11_RATE_LIMIT_N=60（窗口内配额，默认 60）
退出码：0 通过 / 1 失败 / 2 缺配置。
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

PROBE_INSTRUMENT = os.environ.get("A11_PROBE_INSTRUMENT", "SSE:600519")
PROBE_PATH = f"/v1/instruments/{PROBE_INSTRUMENT}"
INTERNAL_HINTS = re.compile(r"(?i)(rate_limit_key|bucket|limit=?\d+|window=?\d+|RATE_LIMITED|throttl)")


def call(base_url: str, xff: str) -> tuple[int, dict, dict[str, str]]:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{PROBE_PATH}",
        headers={"Accept": "application/json", "X-Forwarded-For": xff},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8")), dict(response.headers)
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        headers = dict(error.headers) if error.headers else {}
        try:
            return error.code, json.loads(raw), headers
        except json.JSONDecodeError:
            return error.code, {"raw": raw}, headers
    except (urllib.error.URLError, TimeoutError) as error:
        raise SystemExit(f"[FAIL] 接口不可用：{error}")


def main() -> int:
    base_url = os.environ.get("A11_IMPL_BASE_URL")
    if not base_url:
        sys.stderr.write("[FAIL] 缺少 A11_IMPL_BASE_URL（限流验收不 skip）\n")
        return 2
    quota = int(os.environ.get("A11_RATE_LIMIT_N", "60"))
    problems: list[str] = []

    last_status = 0
    last_payload: dict = {}
    last_headers: dict[str, str] = {}
    for index in range(1, quota + 2):
        last_status, last_payload, last_headers = call(base_url, "203.0.113.10")
        if last_status == 429:
            break
    if last_status != 429:
        problems.append(f"第 {quota + 1} 次请求仍非 429（实际 {last_status}），限流未生效或配额口径不同")
    else:
        retry_after = last_headers.get("retry-after") or last_headers.get("Retry-After") or ""
        if not re.fullmatch(r"\d+", str(retry_after)):
            problems.append(f"Retry-After 必须是整数秒，实际 {retry_after!r}")
        elif int(retry_after) < 1:
            problems.append(f"Retry-After 必须 ≥1s，实际 {retry_after}")
        content_type = (last_headers.get("content-type") or last_headers.get("Content-Type") or "").lower()
        if "application/problem+json" not in content_type:
            problems.append(f"429 必须是 application/problem+json，实际 {content_type!r}")
        if last_payload.get("code") != "RATE_LIMITED":
            problems.append(f"429 code 期望 RATE_LIMITED，实际 {last_payload.get('code')!r}")
        title = str(last_payload.get("title", ""))
        detail = str(last_payload.get("detail", ""))
        match = INTERNAL_HINTS.search(f"{title} {detail}")
        if match:
            problems.append(f"429 文案泄露内部码/阈值：{match.group(0)!r}（title={title!r} detail={detail!r}）")

    # XFF 伪造不换桶：换一个伪造来源仍应 429
    status, payload, _ = call(base_url, "198.51.100.77")
    if status != 429:
        problems.append(f"伪造 X-Forwarded-For 后换到了新桶（实际 {status}，应仍 429）")

    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] 11-12/限流桶（quota={quota}）")
    for problem in problems:
        print(f"  - {problem}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
