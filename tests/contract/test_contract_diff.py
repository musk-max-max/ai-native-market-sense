"""契约 diff 门禁：当前 contracts/ 相对冻结 baseline 的破坏性变更为空。

红灯含义：有人改了契约字段且属破坏性变更（删字段/改类型/收窄枚举/改必填）而没走声明；
或工具链版本漂移；或 waiver 过期/失效。
修复方：A0 改契约 + H2 签字；A11 只判定，不改契约。
"""

from __future__ import annotations

import hashlib
import json

import yaml

from contract_diff_lib import (
    BASELINES_DIR,
    baseline_path,
    current_path,
    load_manifest,
    load_waivers,
    oasdiff_binary,
    assert_pinned_toolchain,
    classify,
    parse_findings,
    run_breaking,
)
from openapi_lib import CONTRACTS_DIR, DOMAINS, ContractRepo


import pytest


@pytest.fixture(scope="session")
def toolchain():
    binary = oasdiff_binary()
    assert_pinned_toolchain(binary)
    return binary


def test_baseline_snapshot_is_tamper_evident():
    """baseline 快照必须与 manifest 哈希一致；改 baseline 绕过门禁会被发现。"""
    manifest = load_manifest()
    problems = []
    for domain in DOMAINS:
        path = baseline_path(domain)
        if not path.exists():
            problems.append(f"baseline 缺 {domain}/openapi.yaml")
            continue
        recorded = (manifest.get("files") or {}).get(f"{domain}/openapi.yaml")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if recorded is None:
            problems.append(f"{domain}: manifest 未登记哈希（新增域必须同步 baseline_manifest.json）")
        elif recorded != actual:
            problems.append(
                f"{domain}: baseline 快照被改动（manifest={recorded[:12]}…, actual={actual[:12]}…）。"
                "baseline 只能由 A11 在契约评审后重新冻结并更新 manifest。"
            )
    assert not problems, "\n".join(problems)


def test_no_undeclared_breaking_changes(toolchain):
    """逐域对比 baseline：breaking 必须为零，或已被 H2 签字的 waiver 显式覆盖。"""
    waivers = load_waivers()
    problems, notes = [], []
    for domain in DOMAINS:
        code, stdout, stderr = run_breaking(baseline_path(domain), current_path(domain, CONTRACTS_DIR), toolchain)
        if code not in (0, 1):
            problems.append(f"{domain}: oasdiff 执行失败（退出码 {code}）: {stderr.strip()[:800]}")
            continue
        findings = parse_findings(stdout)
        waived, unwaived, advisory, stale = classify(findings, waivers)
        for finding in unwaived:
            problems.append(f"{domain}: 未声明的破坏性契约变更 -> {finding.key}: {finding.text}")
        for finding in waived:
            notes.append(f"{domain}: 已声明破坏性变更（{finding.key}）")
        for finding in advisory:
            notes.append(f"{domain}: 非破坏性观察项 {finding.severity} {finding.key}")
    assert not problems, "契约 diff 门禁红灯：\n" + "\n".join(problems)
    assert not [w for w in waivers if w.operation_id is None], "waiver 必须精确到 operation_id"
    if notes:
        import warnings

        warnings.warn("契约 diff 观察项:\n" + "\n".join(notes), stacklevel=2)


def test_waiver_ledger_has_no_stale_entries(toolchain):
    """waiver 必须仍命中真实 breaking 变更；修好后不清理等于台账失效，红灯。"""
    waivers = load_waivers()
    if not waivers:
        # 严格模式：没有 waiver 时无需检查失效条目，但保持「通过」而不是 skip，避免绿灯里藏跳过项
        return
    findings = []
    for domain in DOMAINS:
        code, stdout, _ = run_breaking(baseline_path(domain), current_path(domain, CONTRACTS_DIR), toolchain)
        if code in (0, 1):
            findings.extend(parse_findings(stdout))
    _, _, _, stale = classify(findings, waivers)
    assert not stale, "以下 waiver 已不再匹配任何破坏性变更，请删除（变更已回退/已升版）:\n" + "\n".join(
        f"{waiver.id} ({waiver.finding} @ {waiver.operation_id})" for waiver in stale
    )


# --- H2 L45：severity 配置是门禁的一部分，不是「配置存在」就算证明 ---

APPROVED_SEVERITY_LINES = {
    "response-optional-property-removed": "err",
    "response-optional-write-only-property-removed": "err",
}
# 升级 severity 后对冻结基线的预期：只允许 market 那 1 条 lot_size 删除。
ALLOWED_ERRORS = {
    "shared": set(),
    "market": {("getInstrument", "response-optional-property-removed")},
    "fundamental": set(),
    "watchlist": set(),
}


def test_severity_policy_is_approved_and_not_widened():
    """配置文件只能包含 H2 审过的两行；注释/空行/额外规则都会让 oasdiff 拒载或悄悄放宽。

    A0 实测：oasdiff severity 文件不接受注释/空行（首版带 `#` 直接 exit 106）。
    """
    from contract_diff_lib import severity_levels_file

    path = severity_levels_file()
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    parsed = {}
    for line in lines:
        parts = line.split()
        assert len(parts) == 2, f"severity 配置行格式必须是 '<id> <level>'：{line!r}"
        parsed[parts[0]] = parts[1]
    assert parsed == APPROVED_SEVERITY_LINES, (
        "severity 配置被改动（写宽配置会让门禁悄悄失效）：\n"
        f"实际 {parsed}\n期望 {APPROVED_SEVERITY_LINES}"
    )


def test_four_domain_baseline_has_only_declared_error(toolchain):
    """四域预检：升级 severity 后基线只允许 market 的 getInstrument 那条 ERR。

    多出来的 ERR = 配置写宽或契约出现未声明删除；少了 = 配置失效（盲区回来了）。
    """
    observed: dict[str, set[tuple[str, str]]] = {}
    for domain in DOMAINS:
        code, stdout, stderr = run_breaking(baseline_path(domain), current_path(domain, CONTRACTS_DIR), toolchain)
        assert code in (0, 1), f"{domain}: oasdiff 执行失败 exit={code}: {stderr.strip()[:800]}"
        observed[domain] = {
            (finding.operation_id, finding.id) for finding in parse_findings(stdout) if finding.level == 3
        }
    assert observed == ALLOWED_ERRORS, (
        "四域预检与 H2 批准的基线不一致（ERROR 集合）：\n"
        + "\n".join(f"  {domain}: {sorted(observed.get(domain, set()))}" for domain in DOMAINS)
        + f"\n期望：{ {domain: sorted(value) for domain, value in ALLOWED_ERRORS.items()} }"
    )
