"""质量分「运行时配置 vs 已批准口径」门禁。

红线含义：warehouse/quality/quality_config.json 被改动到与已批准口径（tests/data/quality_policy.yaml）
不一致 —— 可能是好心调参，也可能是为了让坏数据变绿。A11 只判定，不改配置：
  A2 改配置必须同时改 tests/data/quality_policy.yaml 并附 H4 签字（口径变更）。
"""

from __future__ import annotations

import pytest

from quality_lib import CATEGORY_ORDER, load_policy, load_runtime_config

SCALAR_KEYS = ("blocker_blocks_downstream", "st_limit_pct", "st_limit_boards", "limit_tolerance_pp")


@pytest.fixture(scope="module")
def policy():
    doc = load_policy()
    assert doc.get("approved_by", "").startswith("H4"), "已批准口径必须由 H4 签字"
    assert doc.get("decision_refs"), "口径必须可追溯到决策编号"
    return doc


@pytest.fixture(scope="module")
def runtime():
    return load_runtime_config()


def test_weights_are_approved_and_normalized(policy, runtime):
    assert runtime["weights"] == policy["weights"], (
        f"权重漂移: 运行时 {runtime['weights']} != 已批准 {policy['weights']}（task-6 指定 0.2/0.3/0.3/0.2）"
    )
    total = sum(runtime["weights"].values())
    assert abs(total - 1.0) < 1e-9, f"权重之和必须为 1，实际 {total}"
    assert set(runtime["weights"]) == set(CATEGORY_ORDER), "四类权重缺项"


def test_thresholds_are_approved(policy, runtime):
    assert runtime["thresholds"] == policy["thresholds"], (
        f"阈值漂移: 运行时 {runtime['thresholds']} != 已批准 {policy['thresholds']}（H4-D8：95/90/85）"
    )
    thresholds = runtime["thresholds"]
    assert thresholds["green"] > thresholds["yellow"] > thresholds["red"] > 0


def test_veto_and_market_rules_are_approved(policy, runtime):
    for key in SCALAR_KEYS:
        assert runtime[key] == policy[key], f"{key} 漂移: 运行时 {runtime[key]!r} != 已批准 {policy[key]!r}"
    assert runtime["board_limit_pct"] == policy["board_limit_pct"], "板块幅度漂移（C11 禁止硬编码 10%）"


def test_rule_catalog_matches_approved(policy, runtime):
    # A 股 bar 规则 + 研究数据集规则（KD-RES-FIX）分域登记；运行时不得多/少/降级。
    approved = dict(policy["rules"])
    approved.update(policy.get("research_rules") or {})
    actual = runtime.get("rules") or {}
    missing = sorted(set(approved) - set(actual))
    unknown = sorted(set(actual) - set(approved))
    assert not missing, f"运行时配置缺规则: {missing}（规则被删等于放过一类坏数据）"
    assert not unknown, f"运行时配置出现未登记规则: {unknown}（新增规则必须先改口径 + H4 签字）"
    for rule_id, meta in approved.items():
        assert actual[rule_id].get("severity") == meta["severity"], (
            f"{rule_id} 级别漂移: {actual[rule_id].get('severity')} != {meta['severity']}\n"
            "把 blocker 降级为 warn = 放宽门禁，A11 一票否决。"
        )


def test_score_mode_is_l9_blocker_rules(policy):
    """L9 裁定（待 H4 会签）：只由 blocker 计分，按「命中规则数/类别规则数」扣分。"""
    assert policy.get("score_counts") == "blocker_rules", (
        "计分口径必须是 L9：blocker_rules（warn 不进分子分母）"
    )
    formula = policy.get("formula", "")
    assert "distinct_blocker_rules_hit" in formula and "rules_in_category" in formula, (
        f"formula 未记录 L9 口径: {formula!r}"
    )
    assert "L9" in policy.get("decision_refs", []), "口径变更必须挂 decision_refs（L9）"
    questions = policy.get("open_questions") or []
    q = next((item for item in questions if item.get("id") == "Q-WARN-SCORE"), None)
    assert q is not None, "warn 计分口径必须在 open_questions 留痕（不得口口相传）"
    assert q.get("decision") == "L9" and q.get("status") == "decided_pending_H4_countersign"


def test_limit_rules_are_approved_time_aware(policy):
    """涨跌幅档位必须是 H4 2026-11-05 签的时点口径（L118/L119/L120），不得退回静态板块档。"""
    expected = {
        "st_main_before_2026_07_06": 5.0,
        "st_main_from_2026_07_06": 10.0,
        "gem_before_2020_08_24": 10.0,
        "gem_from_2020_08_24": 20.0,
        "star": 20.0,
        "bse_from_2021_11_15": 30.0,
        "s_share_main": 5.0,
        "st_main_switch_date": "2026-07-06",
        "gem_switch_date": "2020-08-24",
        "bse_open_date": "2021-11-15",
    }
    rules = policy["limit_rules"]
    for key, value in expected.items():
        assert rules.get(key) == value, f"limit_rules.{key} 应为 {value!r}，实际 {rules.get(key)!r}"
    assert rules["bse_before_2021_11_15"] is None, "北交所开市前必须 NULL（不猜精选层规则）"
    assert rules["registration_first_5"] == {
        "star": "2019-07-22",
        "gem": "2020-08-24",
        "main": "2023-04-10",
    }, "注册制前 5 交易日边界必须与 L120 一致"
    for ref in ("L118", "L119", "L120"):
        assert ref in policy["decision_refs"], f"limit_rules 变更缺 decision_refs {ref}"
