"""golden dataset 门禁：37 条正例全绿、12 条负例必须红灯阻断（task-6 验收）。"""

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
    "G22": "ST 限价取整边界（10.5525→10.55）",
    "G25": "主板 ST 2026-07-06 前 5% 恰好边界",
    "G26": "主板 ST 2026-07-06 起 10% 生效日边界",
    "G27": "创业板 2020-08-24 前 10%",
    "G28": "创业板 2020-08-24 起 20%",
    "G29": "主板 S 股 5%",
    "G30": "北交所 2021-11-15 前无口径（NULL）",
    "G31": "北交所 2021-11-15 起 30%",
    "G32": "新股首日无涨跌幅（NULL）",
    "G33": "RES-05 2026-07 后 ST 10% 档候选重算",
    "G34": "RES-05 北交所 920xxx 分档取整（截断）",
    "G35": "科创新股上市第 2 日 +30%：前 5 日无涨跌幅 → NULL",
    "G36": "创业板 2021 新股第 3 日 +30%：前 5 日无涨跌幅 → NULL",
    "G37": "主板 2023-04-10 新股第 2 日 +15%：前 5 日无涨跌幅 → NULL",
}


def _results():
    return {r.case_id: r for r in run_fixture(FIXTURE)}


def test_fixture_has_37_positive_and_12_negative():
    cases = load_fixture(FIXTURE)["cases"]
    positive = [c for c in cases if c["id"].startswith("G")]
    negative = [c for c in cases if c["id"].startswith("N")]
    assert len(positive) == 37, f"golden 正例应为 37 条，实际 {len(positive)}"
    assert len(negative) == 12, f"golden 负例应为 12 条，实际 {len(negative)}"


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
    assert len(negative) == 12
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
