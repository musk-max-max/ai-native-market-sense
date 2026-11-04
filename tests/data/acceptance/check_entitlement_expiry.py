#!/usr/bin/env python3
"""H4 11-12 放行验收 · 第 1 项：授权到期 fail-closed（三层：配置生效 / 服务判定 / 响应形状）。

H4 口径（m00886 定语义，m00947 撤回 VALID_UNTIL 改名）：
- 配置名定 `ENTITLEMENT_EXPIRES_AT`（lead L19，2026-11-04；不留别名）。
- 未设置时的行为（L18 ②）：`tier != internal_eval` 且未设 → **拒绝启动**（配置层快速失败，
  进程起不来，不是 200 也不是降级跑）；`tier == internal_eval` 且未设 → 可启动，行情/财务 403。
- effective_tier = (expires_at 已设置 && now < expires_at) ? configured_tier : internal_eval；
  单一判定点，启动与每次请求共用。
- 到期后 quote/bars/fundamental 一律 403 ENTITLEMENT_RESTRICTED，不得 200/404、不得空数据；
  响应体不得含任何可判读数值；getInstrument 仍 200（个股页先能渲染标识），
  meta.entitlement.tier 必须是 effective_tier=internal_eval（不接受 c_end_display+is_entitled=false 的含糊组合）。
- 凡响应含 meta.entitlement（含 getInstrument 的 200）一律 `Cache-Control: no-store`（lead L36）。
- 事件层（H4 m00947 改口径）：落 PG 最小表 `audit.entitlement_events`（不再 JSONL），
  schema=A2、写入=A3、迁移/权限=A13；本脚本只读，用 psql。

用法：
  A11_IMPL_BASE_URL=http://127.0.0.1:PORT A11_EXPIRY_MODE=expired|unset \
  A11_AUDIT_DSN=postgresql://... \
  python3 tests/data/acceptance/check_entitlement_expiry.py

  expired：服务以 c_end_display + ENTITLEMENT_EXPIRES_AT=过去时刻启动；
  unset  ：服务以 internal_eval 启动且不设 ENTITLEMENT_EXPIRES_AT（行情仍须 403）；
  bare   ：服务不设任何 ENTITLEMENT_* 裸启动（默认值反转验收，lead L36 第 8 条）。

  事件层 DSN 取 `A11_AUDIT_DSN`，回落到 `DATABASE_URL`；11-12 release job 用迁移高权限 DSN
  （应用角色 market_app 只有 INSERT，无 SELECT）。缺 DSN / 表未就绪 → 该层 FAIL（不 skip）。

退出码：0 通过 / 1 失败 / 2 缺配置（按失败处理，不 skip）。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

PROBE_INSTRUMENT = os.environ.get("A11_PROBE_INSTRUMENT", "SSE:600519")
MARKET_PATHS = (
    f"/v1/instruments/{PROBE_INSTRUMENT}/quote",
    f"/v1/instruments/{PROBE_INSTRUMENT}/bars",
    f"/v1/instruments/{PROBE_INSTRUMENT}/fundamental-summary",
)
# 可判读行情/财务数值的字段名（响应体任何层级出现即失败）
NUMERIC_LEAK_KEYS = {
    "last_price", "prev_close", "change", "change_pct", "open", "high", "low",
    "close", "volume", "amount", "revenue", "net_profit", "eps", "roe",
    "gross_margin", "total_assets", "market_cap", "pe", "pb",
}
# L21 白名单 7 类：基础信息可显示；出现白名单外字段即失败（不静默丢弃）。
BASE_INFO_FIELDS = ("instrument_id", "name", "exchange", "board", "security_type", "list_status", "listed_at")
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PROBE = os.path.join(HERE, "probe_market_config.ts")
HARNESS = os.path.join(HERE, "..", "..", "contract", "live_harness", "harness.ts")
TSX_BINARY = os.path.join(HERE, "..", "..", "..", "services", "market", "node_modules", ".bin", "tsx")
PSQL_BINARY = shutil.which("psql") or "/opt/homebrew/bin/psql"
EVENT_TABLE = "audit.entitlement_events"
EVENT_REQUIRED_FIELDS = {
    "schema_version", "event_id", "event_type", "occurred_at", "old_value", "new_value",
    "reason", "authorization_doc_id", "authorization_doc_sha256", "clause_locator",
    "rule_version", "operator", "trace_id", "prev_hash", "hash",
}


def http(base_url: str, path: str, timeout: float = 5.0) -> tuple[int, dict, dict[str, str]]:
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            headers = {key.lower(): value for key, value in response.headers.items()}
            return response.status, json.loads(response.read().decode("utf-8")), headers
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        headers = {key.lower(): value for key, value in error.headers.items()} if error.headers else {}
        try:
            return error.code, json.loads(raw), headers
        except json.JSONDecodeError:
            return error.code, {"raw": raw}, headers
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


def clean_env(extra_env: dict[str, str]) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ENTITLEMENT_") and key != "MARKET_NOW"}
    env.update(extra_env)
    return env


def probe_config(extra_env: dict[str, str]) -> tuple[dict, str]:
    completed = subprocess.run(
        [TSX_BINARY, CONFIG_PROBE],
        capture_output=True,
        text=True,
        timeout=120,
        env=clean_env(extra_env),
        cwd=HERE,
    )
    if completed.returncode != 0:
        return {}, f"配置探针执行失败 rc={completed.returncode}: {completed.stderr[-500:]}"
    try:
        return json.loads(completed.stdout.strip().splitlines()[-1]), ""
    except (json.JSONDecodeError, IndexError):
        return {}, f"配置探针输出无法解析: {completed.stdout[-500:]!r}"


def check_config_layer(mode: str) -> list[str]:
    """L18/L19：未设置时 tier!=internal_eval 必须拒绝启动；tier=internal_eval 可启动。"""
    problems: list[str] = []
    if mode == "unset":
        refused, error = probe_config({"ENTITLEMENT_TIER": "c_end_display"})
        if error:
            return [error]
        if refused.get("ok") is not False:
            problems.append("配置层：c_end_display 且未设 ENTITLEMENT_EXPIRES_AT 应拒绝启动，实际启动成功")
        allowed, error = probe_config({"ENTITLEMENT_TIER": "internal_eval"})
        if error:
            problems.append(error)
        elif allowed.get("ok") is not True:
            problems.append(f"配置层：internal_eval 且未设应允许启动，实际拒绝：{allowed.get('message')}")
    elif mode == "bare":
        ok, error = probe_config({})
        if error:
            problems.append(error)
        elif ok.get("ok") is not True:
            problems.append(f"配置层：裸启动（无任何 ENTITLEMENT_*）应允许启动，实际拒绝：{ok.get('message')}")
    else:
        expires = "2026-11-01T00:00:00+08:00"
        fingerprint = hashlib.sha256(f"c_end_display|{expires}".encode("utf-8")).hexdigest()
        ok, error = probe_config(
            {
                "ENTITLEMENT_TIER": "c_end_display",
                "ENTITLEMENT_EXPIRES_AT": expires,
                "ENTITLEMENT_CONFIG_EXPECTED_SHA256": fingerprint,
            }
        )
        if error:
            problems.append(error)
        elif ok.get("ok") is not True:
            problems.append(f"配置层：设置合法 ENTITLEMENT_EXPIRES_AT 后应允许启动，实际拒绝：{ok.get('message')}")
    return problems


def check_startup_refusal() -> list[str]:
    """H4 m00947：c_end_display 且无 ENTITLEMENT_EXPIRES_AT → 进程起不来（不是 200、也不是降级跑）。"""
    try:
        completed = subprocess.run(
            [TSX_BINARY, HARNESS],
            capture_output=True,
            text=True,
            timeout=60,
            env=clean_env({"ENTITLEMENT_TIER": "c_end_display"}),
            cwd=HERE,
        )
    except subprocess.TimeoutExpired:
        return ["启动断言：c_end_display 且未设 ENTITLEMENT_EXPIRES_AT 时进程仍在运行（应拒绝启动）"]
    if completed.returncode == 0:
        return ["启动断言：c_end_display 且未设 ENTITLEMENT_EXPIRES_AT 时进程正常退出（应拒绝启动）"]
    combined = f"{completed.stdout}\n{completed.stderr}"
    if "baseUrl" in combined:
        return ["启动断言：进程虽非零退出，但已打印 baseUrl（说明服务曾进入监听态）"]
    return []


def check_market_data_denied(base_url: str) -> list[str]:
    problems: list[str] = []
    for path in MARKET_PATHS:
        status, payload, headers = http(base_url, path)
        if status != 403:
            problems.append(f"{path} 期望 403 ENTITLEMENT_RESTRICTED，实际 {status}")
            continue
        if payload.get("code") != "ENTITLEMENT_RESTRICTED":
            problems.append(f"{path} 403 但 code={payload.get('code')!r}（期望 ENTITLEMENT_RESTRICTED）")
        leaked = sorted(leaked_keys(payload, set()))
        if leaked:
            problems.append(f"{path} 403 响应体仍含可判读数值字段：{leaked}")
        cache_control = headers.get("cache-control", "")
        if "no-store" not in cache_control.lower():
            problems.append(f"{path} 403 必须 Cache-Control: no-store（防止 CDN/ingress/SW 复用），实际 {cache_control!r}")
    return problems


def check_base_info_still_served(base_url: str) -> list[str]:
    status, payload, headers = http(base_url, f"/v1/instruments/{PROBE_INSTRUMENT}")
    problems: list[str] = []
    cache_control = headers.get("cache-control", "")
    if "no-store" not in cache_control.lower():
        problems.append(f"getInstrument 200 含 meta.entitlement，必须 Cache-Control: no-store，实际 {cache_control!r}")
    if status != 200:
        problems.append(f"降级后 getInstrument 应仍 200 以渲染证券标识，实际 {status}")
        return problems
    data = payload.get("data") or {}
    for field in BASE_INFO_FIELDS:
        if field not in data:
            problems.append(f"getInstrument 缺少基础字段 {field}")
    extra = sorted(set(data) - set(BASE_INFO_FIELDS))
    if extra:
        problems.append(f"降级后 getInstrument 出现白名单外字段：{extra}（L21：运行时兜底应 500，不得静默透出）")
    leaked = sorted(leaked_keys(data, set()))
    if leaked:
        problems.append(f"fail-closed 时基础信息响应仍含可判读数值：{leaked}")
    entitlement = (payload.get("meta") or {}).get("entitlement") or {}
    if entitlement.get("tier") != "internal_eval":
        problems.append(f"降级后 meta.entitlement.tier 应为 effective_tier=internal_eval，实际 {entitlement.get('tier')!r}")
    if entitlement.get("is_entitled") is not False:
        problems.append(f"降级后 meta.entitlement.is_entitled 必须为 false，实际 {entitlement.get('is_entitled')!r}")
    return problems


def psql_rows(dsn: str, sql: str) -> tuple[list[dict], str]:
    if not os.path.exists(PSQL_BINARY):
        return [], f"找不到 psql（{PSQL_BINARY}），无法校验事件表"
    completed = subprocess.run(
        [PSQL_BINARY, dsn, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode != 0:
        return [], f"事件表查询失败（表未就绪？）：{completed.stderr.strip()[-500:]}"
    rows: list[dict] = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            return [], f"事件表行不是合法 JSON：{line[:200]!r}"
    return rows, ""


def normalized_expires() -> str:
    """服务端把 ENTITLEMENT_EXPIRES_AT 规范化为 UTC ISO（parseExpiresAt → toISOString）。"""
    raw = os.environ.get("ENTITLEMENT_EXPIRES_AT", "")
    try:
        from datetime import datetime, timezone

        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    except ValueError:
        return ""


def check_expiry_event(dsn: str) -> list[str]:
    """H4：事件落 PG；本次降级必须写一条 entitlement_expired（event_key 幂等）。"""
    if not dsn:
        return ["事件层未验证：缺少 A11_AUDIT_DSN / DATABASE_URL（事件表 audit.entitlement_events 未接）"]
    rows, error = psql_rows(
        dsn,
        f"select row_to_json(t) from (select * from {EVENT_TABLE} where event_type = 'entitlement_expired') t",
    )
    if error:
        return [error]
    problems: list[str] = []
    expires = normalized_expires()
    expected_prefix = f"exp|c_end_display|{expires}|expires_at_passed" if expires else ""
    mine = [event for event in rows if expected_prefix and str(event.get("event_key", "")).startswith(expected_prefix)]
    if not mine:
        problems.append(
            "本次到期启动未写 entitlement_expired（期望 event_key 前缀 "
            f"{expected_prefix!r}；库中已有 {len(rows)} 条历史 expired 事件，但都不属于本次配置）"
        )
    for index, event in enumerate(mine or rows, start=1):
        missing = sorted(EVENT_REQUIRED_FIELDS - set(event))
        if missing:
            problems.append(f"entitlement_expired 第 {index} 条缺少字段：{missing}")
        if event.get("reason") != "expires_at_passed":
            problems.append(f"entitlement_expired 第 {index} 条 reason 期望 'expires_at_passed'（L49 六值），实际 {event.get('reason')!r}")
    # 幂等：event_key 是触发器权威幂等键；同一条配置重复启动不得新增行。
    seen: set[str] = set()
    for event in mine:
        key = str(event.get("event_key", ""))
        if key in seen:
            problems.append(f"entitlement_expired 不幂等：event_key 重复 {key!r}")
        seen.add(key)
    return problems


def main() -> int:
    base_url = os.environ.get("A11_IMPL_BASE_URL")
    mode = os.environ.get("A11_EXPIRY_MODE", "expired")
    if not base_url:
        sys.stderr.write("[FAIL] 缺少 A11_IMPL_BASE_URL（验收脚本不 skip）\n")
        return 2
    if mode not in {"expired", "unset", "bare"}:
        sys.stderr.write("[FAIL] A11_EXPIRY_MODE 只能是 expired / unset / bare\n")
        return 2

    problems: list[str] = []
    problems += check_config_layer(mode)
    if mode == "unset":
        problems += check_startup_refusal()
    problems += check_market_data_denied(base_url)
    problems += check_base_info_still_served(base_url)
    # 事件层只属于「到期降级」路径；unset/bare 不产生 entitlement_expired（#8 不含事件断言）。
    if mode == "expired":
        problems += check_expiry_event(os.environ.get("A11_AUDIT_DSN") or os.environ.get("DATABASE_URL", ""))

    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] 11-12/第1项 到期 fail-closed（mode={mode}）")
    for problem in problems:
        print(f"  - {problem}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
