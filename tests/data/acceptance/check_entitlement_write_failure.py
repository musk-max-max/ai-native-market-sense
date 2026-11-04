#!/usr/bin/env python3
"""H4 m01875 / m01904 / H5 第 6 点：审计写失败的「非阻断 vs 阻断」分层验收。

两类降级不得混成一个 403（H4 m01713/H5）：
- 非阻断（audit_write_failed、expired_event_write_failed）：PG **瞬态**写失败时
  effective 保持原值、blocked 不置位，只 degraded 标记 + 寻呼；原 tier 有效则仍 200 且数据可判读。
- 阻断（control_unavailable/control_stale/control_missing/hold_active/config_mismatch/
  expired/audit_write_misconfigured）：effective=internal_eval、blocked=true、403。
  其中确定性写错误（INSERT 权限/表/列/类型/schema）属于 audit_write_misconfigured，
  启动即拒绝（不能让一次权限错配被当成"记账抖动"继续放行）。

本脚本同时做**双源校验**：源码里的 BLOCKING_REASONS / NON_BLOCKING_REASONS 必须与
H4 冻结名单完全相等（多/少/别名都红），避免只改源码绕开名单。

场景由 harness（tests/contract/live_harness/harness.ts）注入：
- A11_EVENT_WRITE=transient     → insert 抛连接错误（非阻断）；
- A11_EVENT_WRITE=deterministic → insert 抛 PG 42501（阻断，启动失败）。

用法：python3 tests/data/acceptance/check_entitlement_write_failure.py
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
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
HARNESS = os.path.join(REPO_ROOT, "tests", "contract", "live_harness", "harness.ts")
TSX_BINARY = os.path.join(REPO_ROOT, "services", "market", "node_modules", ".bin", "tsx")
GATE_SOURCE = os.path.join(REPO_ROOT, "services", "market", "src", "domain", "entitlement-gate.ts")
INSTRUMENT = os.environ.get("A11_PROBE_INSTRUMENT", "SSE:600519")

EXPECTED_BLOCKING = {
    "control_unavailable",
    "control_stale",
    "control_missing",
    "hold_active",
    "config_mismatch",
    "expired",
    "audit_write_misconfigured",
}
EXPECTED_NON_BLOCKING = {"audit_write_failed", "expired_event_write_failed"}
VALID_TIER = {"ENTITLEMENT_TIER": "c_end_display", "ENTITLEMENT_EXPIRES_AT": "2027-01-01T00:00:00+08:00"}
EXPIRED_TIER = {"ENTITLEMENT_TIER": "c_end_display", "ENTITLEMENT_EXPIRES_AT": "2026-11-01T00:00:00+08:00"}


def fail(messages: list[str]) -> int:
    print("[FAIL] 11-12/H5#6 审计写失败分层（非阻断 vs 阻断）")
    for message in messages:
        print(f"  - {message}")
    return 1


def http_json(base_url: str, path: str) -> tuple[int, dict]:
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"raw": raw}


def spawn_harness(extra_env: dict[str, str], timeout_seconds: float = 90) -> tuple[int, str | None, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ENTITLEMENT_") and key != "MARKET_NOW"}
    env.update(extra_env)
    process = subprocess.Popen(
        [TSX_BINARY, HARNESS],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        cwd=REPO_ROOT,
    )
    try:
        line = process.stdout.readline() if process.stdout else ""
        if not line.strip():
            stderr = process.stderr.read() if process.stderr else ""
            status = process.wait(timeout=timeout_seconds)
            return status, None, stderr
        payload = json.loads(line)
        return 0, str(payload["baseUrl"]), ""
    except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError) as error:
        process.kill()
        return 1, None, f"harness 启动失败：{error}"


def stop(process: subprocess.Popen | None) -> None:
    if process is None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def parse_reason_sets() -> tuple[set[str], set[str]]:
    source = open(GATE_SOURCE, encoding="utf-8").read()
    def block(name: str) -> set[str]:
        match = re.search(rf"export const {name} = new Set<DegradedReason>\(\[(.*?)\]\)", source, re.S)
        if match is None:
            raise SystemExit(f"[FAIL] 无法在 {GATE_SOURCE} 找到 {name}")
        return set(re.findall(r"'([a-z_]+)'", match.group(1)))
    return block("BLOCKING_REASONS"), block("NON_BLOCKING_REASONS")


def check_vocabulary(problems: list[str]) -> None:
    blocking, non_blocking = parse_reason_sets()
    if blocking != EXPECTED_BLOCKING:
        problems.append(
            f"阻断名单与 H4 冻结名单不一致：多 {sorted(blocking - EXPECTED_BLOCKING)} / 少 {sorted(EXPECTED_BLOCKING - blocking)}"
        )
    if non_blocking != EXPECTED_NON_BLOCKING:
        problems.append(
            f"非阻断名单与 H4 冻结名单不一致：多 {sorted(non_blocking - EXPECTED_NON_BLOCKING)} / 少 {sorted(EXPECTED_NON_BLOCKING - non_blocking)}"
        )
    if blocking & non_blocking:
        problems.append(f"同一原因同时出现在两类名单：{sorted(blocking & non_blocking)}")


def check_transient_valid(problems: list[str]) -> None:
    status, base_url, stderr = spawn_harness({**VALID_TIER, "A11_EVENT_WRITE": "transient"})
    if base_url is None:
        problems.append(f"瞬态写失败不应阻止启动（有效期内 c_end_display），实际 rc={status}：{stderr.strip()[:300]}")
        return
    process = getattr(check_transient_valid, "process", None)
    try:
        http_status, quote = http_json(base_url, f"/v1/instruments/{INSTRUMENT}/quote")
        if http_status != 200:
            problems.append(f"瞬态写失败把有效档打成 {http_status}（要求 200；403=把 PG 抖动误判为阻断）")
        else:
            last_price = ((quote.get("data") or {}).get("last_price"))
            if not isinstance(last_price, (int, float)) or last_price <= 0:
                problems.append(f"200 但数据不可判读：last_price={last_price!r}（要求可判读数值）")
            tier = (((quote.get("meta") or {}).get("entitlement") or {}).get("tier"))
            if tier != "c_end_display":
                problems.append(f"暂态写失败不得改 effective tier：期望 c_end_display，实际 {tier!r}")
        _, health = http_json(base_url, "/healthz")
        if health.get("entitlement_degraded") is not True:
            problems.append(f"/healthz 未标记 degraded：{health!r}")
        reason = health.get("entitlement_degraded_reason")
        if reason != "audit_write_failed":
            problems.append(f"/healthz degraded reason 期望 audit_write_failed，实际 {reason!r}")
    finally:
        # 通过 spawn 的进程句柄无法直接拿到（readline 后仍在运行）；用端口回收兜底。
        pass


def check_transient_expired(problems: list[str]) -> None:
    status, base_url, stderr = spawn_harness({**EXPIRED_TIER, "A11_EVENT_WRITE": "transient"})
    if base_url is None:
        problems.append(f"到期档 + 瞬态写失败不应启动失败，实际 rc={status}：{stderr.strip()[:300]}")
        return
    for path, label in (
        (f"/v1/instruments/{INSTRUMENT}/quote", "quote"),
        (f"/v1/instruments/{INSTRUMENT}/bars", "bars"),
        (f"/v1/instruments/{INSTRUMENT}/fundamental-summary", "fundamental"),
    ):
        http_status, payload = http_json(base_url, path)
        if http_status != 403:
            problems.append(f"到期档 {label} 期望 403（阻断=expired），实际 {http_status}")
        elif (payload.get("code")) != "ENTITLEMENT_RESTRICTED":
            problems.append(f"到期档 {label} 403 code 期望 ENTITLEMENT_RESTRICTED，实际 {payload.get('code')!r}")
    _, health = http_json(base_url, "/healthz")
    if health.get("entitlement_degraded") is not True:
        problems.append(f"到期档写失败 /healthz 未标记 degraded：{health!r}")
    if health.get("entitlement_degraded_reason") != "expired_event_write_failed":
        problems.append(
            f"到期档写失败 reason 期望 expired_event_write_failed，实际 {health.get('entitlement_degraded_reason')!r}"
        )


def check_deterministic_blocks(problems: list[str]) -> None:
    status, base_url, stderr = spawn_harness({**VALID_TIER, "A11_EVENT_WRITE": "deterministic"})
    if base_url is not None:
        problems.append("确定性写错误（42501）未阻断：服务仍启动（会被当成记账抖动继续放行）")
    elif status == 0:
        problems.append("确定性写错误应启动失败，实际 rc=0 但也没有 baseUrl")
    expected = "确定性错误"
    if expected not in stderr:
        problems.append(f"确定性写错误启动失败信息未标注原因（期望含「{expected}」）：{stderr.strip()[:300]}")


def main() -> int:
    problems: list[str] = []
    check_vocabulary(problems)
    check_transient_valid(problems)
    check_transient_expired(problems)
    check_deterministic_blocks(problems)
    if problems:
        return fail(problems)
    print("[PASS] 11-12/H5#6 审计写失败分层：瞬态=非阻断（200+可判读+degraded），确定性=阻断（启动拒绝）；名单双源一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
