"""KD-ENT-01 启动矩阵契约门禁（A11，H5 m03570，2026-11-04）。

缺陷背景：`E2E_MODE=1` 默认关 hold/audit 且跳过 EXPECTED_SHA256 自检，导致
`e2e + c_end_display + raise_hold` 下 quote 返回 200 真实行情（H5 实测）。

本门禁钉住修复方向：
- `tier != internal_eval` 时，**任何 profile**（prod/e2e/test）都必须
  `ENTITLEMENT_HOLD_CHECK=1` + `ENTITLEMENT_AUDIT=1` + `ENTITLEMENT_CONFIG_EXPECTED_SHA256` 非空，否则拒启；
- `E2E_MODE` 不再改变 hold/audit 默认值（默认 fail-closed）；
- 应拒启的组合：配置解析/启动抛错即视为“未监听”（runner 不 listen）；
- 应放行的组合：插件真实挂载并 listen；启动后生效的 hold/audit 必须为 true；
- 拒绝原因必须落在阻断集合（`BLOCKING_REASONS` 含 `config_mismatch`），不允许静默放行。
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER = REPO_ROOT / "tests/data/acceptance/startup_matrix_runner.ts"
TSX = REPO_ROOT / "services/market/node_modules/.bin/tsx"
GATE_SRC = REPO_ROOT / "services/market/src/domain/entitlement-gate.ts"

EXPIRES_RAW = "2027-01-01T00:00:00+08:00"
EXPIRES_UTC = (
    datetime.fromisoformat(EXPIRES_RAW).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
)
TIER = "c_end_display"
FINGERPRINT = hashlib.sha256(f"{TIER}|{EXPIRES_UTC}".encode()).hexdigest()


def blocking_reasons() -> set[str]:
    source = GATE_SRC.read_text(encoding="utf-8")
    block = re.search(r"BLOCKING_REASONS\s*=\s*new Set<DegradedReason>\(\[(.*?)\]\)", source, re.S)
    assert block, "无法从 entitlement-gate.ts 解析 BLOCKING_REASONS"
    return set(re.findall(r"'([a-z_]+)'", block.group(1)))


def build_cases() -> list[dict]:
    profiles = ("prod", "e2e", "test")
    cases: list[dict] = []
    for profile in profiles:
        base = {"APP_PROFILE": profile}
        if profile == "prod":
            base["DEPLOYMENT_UID"] = "a11-matrix"
        if profile == "e2e":
            base["E2E_MODE"] = "1"
        base["DATABASE_URL"] = "postgresql://a11:a11@127.0.0.1:1/a11_matrix"
        # tier=internal_eval：不应要求 hold/audit/sha（但 prod 的显式 0 仍按 L73 拒启）
        cases.append({"id": f"{profile}-internal-missing", "env": {**base, "ENTITLEMENT_TIER": "internal_eval"}})
        cases.append(
            {
                "id": f"{profile}-internal-zero",
                "env": {
                    **base,
                    "ENTITLEMENT_TIER": "internal_eval",
                    "ENTITLEMENT_HOLD_CHECK": "0",
                    "ENTITLEMENT_AUDIT": "0",
                },
            }
        )
        # tier=c_end_display：missing/zero 必须拒启，complete 必须放行
        cases.append(
            {
                "id": f"{profile}-cend-missing",
                "env": {**base, "ENTITLEMENT_TIER": TIER, "ENTITLEMENT_EXPIRES_AT": EXPIRES_RAW},
            }
        )
        cases.append(
            {
                "id": f"{profile}-cend-zero",
                "env": {
                    **base,
                    "ENTITLEMENT_TIER": TIER,
                    "ENTITLEMENT_EXPIRES_AT": EXPIRES_RAW,
                    "ENTITLEMENT_HOLD_CHECK": "0",
                    "ENTITLEMENT_AUDIT": "0",
                    "ENTITLEMENT_CONFIG_EXPECTED_SHA256": FINGERPRINT,
                },
            }
        )
        cases.append(
            {
                "id": f"{profile}-cend-complete",
                "env": {
                    **base,
                    "ENTITLEMENT_TIER": TIER,
                    "ENTITLEMENT_EXPIRES_AT": EXPIRES_RAW,
                    "ENTITLEMENT_HOLD_CHECK": "1",
                    "ENTITLEMENT_AUDIT": "1",
                    "ENTITLEMENT_CONFIG_EXPECTED_SHA256": FINGERPRINT,
                },
            }
        )
    return cases


def expected_start(case_id: str) -> bool:
    profile = case_id.split("-", 1)[0]
    if "-internal-" in case_id:
        # prod 显式关 hold/audit = 放行 flag（L73）→ 拒启；dev/e2e/test 的 internal 档本来恒 403
        return not (profile == "prod" and case_id.endswith("-zero"))
    return case_id.endswith("-complete")


@pytest.fixture(scope="module")
def matrix() -> dict[str, dict]:
    if not TSX.is_file():
        pytest.fail(f"缺少 tsx：{TSX}")
    cases = build_cases()
    assert len(cases) >= 12, f"启动矩阵至少 12 组合，实际 {len(cases)}"
    payload = Path(__file__).resolve().parent / "acceptance" / ".startup-matrix-cases.json"
    payload.write_text(json.dumps(cases, ensure_ascii=False), encoding="utf-8")
    proc = subprocess.run(
        [str(TSX), str(RUNNER), "--cases", str(payload)],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=180,
        env={"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "NODE_ENV": "test"},
    )
    assert proc.returncode == 0, f"runner 失败 rc={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr[-3000:]}"
    rows = json.loads(proc.stdout.strip().splitlines()[-1])
    return {row["id"]: row for row in rows}


@pytest.mark.parametrize("case", build_cases(), ids=lambda c: c["id"])
def test_startup_matrix_matches_contract(case: dict, matrix: dict[str, dict]) -> None:
    row = matrix[case["id"]]
    want = expected_start(case["id"])
    if want:
        assert row["started"] is True, f"{case['id']} 应放行却拒启：{row.get('refusal')}"
        assert isinstance(row.get("port"), int) and row["port"] > 0, f"{case['id']} 未真实监听"
        flags = row["flags"]
        if flags["tier"] != "internal_eval":
            # tier 有数据权限时：hold/audit/sha 三者必须同时为真（KD-ENT-01）
            assert flags["holdCheck"] is True, f"{case['id']} 启动后 hold 检查被关闭（fail-open）"
            assert flags["auditEnabled"] is True, f"{case['id']} 启动后审计链被关闭（fail-open）"
            assert flags["expectedSha256Present"] is True, f"{case['id']} 缺 EXPECTED_SHA256 却放行（KD-ENT-01）"
        elif case["id"].endswith("-internal-missing"):
            # internal_eval：E2E_MODE 不得改变默认值，默认仍 fail-closed
            assert flags["holdCheck"] is True, f"{case['id']} 默认 hold 被 E2E_MODE 关闭"
            assert flags["auditEnabled"] is True, f"{case['id']} 默认 audit 被 E2E_MODE 关闭"
    else:
        assert row["started"] is False, f"{case['id']} 应拒启却启动（fail-open；KD-ENT-01）"
        refusal = row.get("refusal") or {}
        category = refusal.get("category")
        assert category in blocking_reasons(), f"{case['id']} 拒绝原因 {category!r} 不在阻断集合"
        assert refusal.get("message"), f"{case['id']} 拒启无原因消息"


def test_matrix_has_no_fail_open_combination(matrix: dict[str, dict]) -> None:
    """全局不变量：任何启动成功的 c_end_display 组合，三个 fail-closed 条件必须同时为真。"""
    for case_id, row in matrix.items():
        if row.get("started") and "-cend-" in case_id:
            flags = row["flags"]
            assert flags["holdCheck"] and flags["auditEnabled"] and flags["expectedSha256Present"], (
                f"{case_id} 属于 fail-open 组合：{flags}"
            )


def test_matrix_covers_required_dimensions(matrix: dict[str, dict]) -> None:
    ids = set(matrix)
    for profile in ("prod", "e2e", "test"):
        for state in ("missing", "zero", "complete"):
            assert f"{profile}-cend-{state}" in ids, f"矩阵缺组合 {profile}-cend-{state}"
        for state in ("missing", "zero"):
            assert f"{profile}-internal-{state}" in ids, f"矩阵缺组合 {profile}-internal-{state}"
