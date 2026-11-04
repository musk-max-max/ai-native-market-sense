"""golden dataset 门禁：21 条正例全绿、9 条负例必须红灯阻断（task-6 验收）。"""

from __future__ import annotations

from pathlib import Path

from warehouse.golden_runner import load_fixture, run_fixture

FIXTURE = Path(__file__).resolve().parents[2] / "data/golden/p0_bars20.yaml"

BOUNDARY_CASES = {
    "G05": "主板 ST",
    "G06": "主板 *ST",
    "G12": "停牌日",
    "G11": "除权除息",
    "G07": "主板涨停",
    "G08": "主板跌停",
    "G13": "新股首日",
    "G21": "ST 恰好 +5.00% 边界",
}


def _results():
    return {r.case_id: r for r in run_fixture(FIXTURE)}


def test_fixture_has_21_positive_and_9_negative():
    cases = load_fixture(FIXTURE)["cases"]
    positive = [c for c in cases if c["id"].startswith("G")]
    negative = [c for c in cases if c["id"].startswith("N")]
    assert len(positive) == 21, f"golden 正例应为 21 条，实际 {len(positive)}"
    assert len(negative) == 9, f"golden 负例应为 9 条，实际 {len(negative)}"


def test_all_positive_cases_green_and_not_blocked():
    results = _results()
    for case_id, result in results.items():
        if not case_id.startswith("G"):
            continue
        assert result.passed, (case_id, result.failures)
        assert result.grade == "green", (case_id, result.grade)
        assert result.score == 100.0, (case_id, result.score)


def test_all_negative_cases_block_downstream():
    results = _results()
    negative = {cid: r for cid, r in results.items() if cid.startswith("N")}
    assert len(negative) == 9
    # N07 是唯一"告警不阻断"的负例：缺 prev_close 只 warn，其余必须 black+blocked
    for case_id, result in negative.items():
        assert result.passed, (case_id, result.failures)
        if case_id == "N07":
            assert result.grade == "green" and result.violations == ["BIZ-02"]
        else:
            assert result.grade == "black", (case_id, result.grade)
            assert result.violations, case_id


def test_boundary_cases_present():
    cases = {c["id"]: c for c in load_fixture(FIXTURE)["cases"]}
    for case_id, label in BOUNDARY_CASES.items():
        assert case_id in cases, f"缺边界用例 {case_id}（{label}）"
    assert len(BOUNDARY_CASES) >= 5


def test_revision_case_records_history():
    results = _results()
    assert results["G19"].passed, results["G19"].failures
    assert results["G18"].passed  # 幂等：无修订
