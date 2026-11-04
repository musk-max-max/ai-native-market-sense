"""质量分公式与阈值（L9 裁定，待 H4 会签；阈值 H4-D8：≥95 绿 / ≥90 黄 / ≥85 红 / <85 黑）。

L9 口径：只由 blocker 计分，
    类别分 = 100 × (1 − 该类别命中 blocker 的不同规则数 / 该类别规则总数)
warn 不进分子分母，只作展示；「违规数」与「质量分」是两个独立指标。

这些测试锁「分数怎么算、怎么分级」：改权重、改阈值、改一票否决、把 warn 计入，
都必须先过这里 + H4 签字。
"""

from __future__ import annotations

import pytest

from quality_lib import Violation, compute_score, grade_for, load_policy

# 各类别规则数（policy.rules 的派生量；改规则清单必须同步这里）
RULE_COUNTS = {"struct": 6, "business": 3, "completeness": 3, "consistency": 2}

# evaluated 在 L9 下不参与算分；保留非零值以证明「分母不是评估条数」
EVAL = {rule_id: 100 for rule_id in ("STRUCT-01", "BIZ-01", "COMP-02", "CONS-01")}


@pytest.fixture(scope="module")
def policy():
    return load_policy()


def _blocker(rule_id: str, count: int = 1) -> list[Violation]:
    return [Violation(rule_id, "blocker", f"injected {i}") for i in range(count)]


def test_rule_count_denominator_not_evaluation_count(policy):
    """struct 有 6 条规则，命中 1 条 → 类别分 100×(1−1/6)=83.33，而不是 99.x。

    若分母退回「评估条数」，这里的 96.67 会变成接近 100 的数——断言会立刻抓住。
    """
    score, category_scores = compute_score(EVAL, _blocker("STRUCT-01", 5), policy)
    assert category_scores["struct"] == pytest.approx(100 * (1 - 1 / RULE_COUNTS["struct"]))
    assert score == pytest.approx(96.67)


def test_hitting_multiple_rules_accumulates(policy):
    violations = _blocker("STRUCT-01") + _blocker("STRUCT-02") + _blocker("BIZ-01")
    score, category_scores = compute_score(EVAL, violations, policy)
    assert category_scores["struct"] == pytest.approx(100 * (1 - 2 / 6))
    assert category_scores["business"] == pytest.approx(100 * (1 - 1 / RULE_COUNTS["business"]))
    # 0.2*66.666… + 0.3*66.666… + 0.3*100 + 0.2*100 = 83.33
    assert score == pytest.approx(83.33)


def test_same_rule_hit_by_many_bars_counts_once(policy):
    one = compute_score(EVAL, _blocker("STRUCT-01"), policy)
    many = compute_score(EVAL, _blocker("STRUCT-01", 50), policy)
    assert one == many, "同一规则多根 bar 命中只应按规则去重计 1 次"


def test_all_rules_in_a_category_hit_scores_zero(policy):
    violations = (
        _blocker("STRUCT-01") + _blocker("STRUCT-02") + _blocker("STRUCT-03")
        + _blocker("STRUCT-04") + _blocker("STRUCT-05") + _blocker("STRUCT-06")
    )
    score, category_scores = compute_score(EVAL, violations, policy)
    assert category_scores["struct"] == pytest.approx(0.0)
    assert score == pytest.approx(80.0), "权重不是 0.2/0.3/0.3/0.2"


def test_warn_never_enters_score(policy):
    """L9：warn 不进分子分母（BIZ-02/BIZ-03 是 warn 规则，命中多少次分都不动）。"""
    warnings_only = [Violation("BIZ-02", "warn", f"missing prev_close {i}") for i in range(10)]
    warnings_only += [Violation("BIZ-03", "warn", f"st snapshot {i}") for i in range(5)]
    score, category_scores = compute_score(EVAL, warnings_only, policy)
    assert category_scores["business"] == pytest.approx(100.0)
    assert score == pytest.approx(100.0)


def test_categories_without_evaluation_are_100(policy):
    score, category_scores = compute_score({}, [], policy)
    assert score == 100.0
    assert all(value == 100.0 for value in category_scores.values())


@pytest.mark.parametrize(
    "score,expect_grade,expect_blocked",
    [
        (100.0, "green", False),
        (95.0, "green", False),      # 绿区下边界（含）
        (94.99, "yellow", False),
        (90.0, "yellow", False),     # 黄区下边界（含）
        (89.99, "red", False),
        (85.0, "red", False),        # 红区下边界（含）
        (84.99, "black", True),
        (0.0, "black", True),
    ],
)
def test_grade_thresholds(policy, score, expect_grade, expect_blocked):
    assert grade_for(score, False, policy) == (expect_grade, expect_blocked)


def test_any_blocker_forces_black_even_with_perfect_score(policy):
    score, _ = compute_score(EVAL, [], policy)
    assert score == 100.0
    grade, blocked = grade_for(score, True, policy)
    assert grade == "black" and blocked is True, "blocker 必须一票否决（阈值不放宽）"


def test_score_is_rounded_to_two_decimals(policy):
    score, _ = compute_score(EVAL, _blocker("STRUCT-01"), policy)
    assert score == pytest.approx(96.67)
    assert len(f"{score:.2f}".split(".")[-1]) == 2
