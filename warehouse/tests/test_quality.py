"""质量分：权重/阈值/阻断语义必须与 docs/metrics/P0-metrics.md 一致。"""

from __future__ import annotations

import json

from warehouse.quality.checks import load_config, run_quality_checks
from warehouse.tests.helpers import bar_row, envelopes, factor_row, instrument_row, state_from_envelopes

DAYS = ["2026-09-28", "2026-09-29", "2026-09-30"]


def _chain(**overrides) -> list[dict]:
    """构造 prev_close 链连续的 3 根 bar（默认恒价 10.30，涨跌幅 0%）。"""
    return [
        bar_row(trade_date=day, prev_close="10.30", **overrides) for day in DAYS
    ]


def _state(tmp_path, instrument=None, bars=None, **bar_overrides):
    bars = bars if bars is not None else _chain(**bar_overrides)
    factors = [
        factor_row(trade_date=bar["trade_date"], instrument_id=bar["instrument_id"])
        for bar in bars
    ]
    return state_from_envelopes(
        tmp_path, envelopes(instrument=instrument or instrument_row(), bars=bars, factors=factors)
    )


def test_config_weights_and_thresholds_are_legislated_values():
    config = load_config()
    assert config["weights"] == {"struct": 0.2, "business": 0.3, "completeness": 0.3, "consistency": 0.2}
    assert sum(config["weights"].values()) == 1.0
    assert config["thresholds"] == {"green": 95, "yellow": 90, "red": 85}
    assert config["blocker_blocks_downstream"] is True


def test_clean_state_scores_100_green(tmp_path):
    report = run_quality_checks(_state(tmp_path))
    assert report.score == 100.0
    assert report.grade == "green"
    assert report.blocked is False


def test_high_low_violation_blocks_downstream(tmp_path):
    # 最后一天 high < low → STRUCT-03 blocker → 一票否决（改坏一条数据必须红灯）
    bars = _chain()
    bars[-1] = bar_row(trade_date=DAYS[-1], high="9.00", low="9.90", close="9.50", prev_close="10.30")
    report = run_quality_checks(_state(tmp_path, bars=bars))
    assert report.blocked is True
    assert report.grade == "black"
    assert "STRUCT-03" in [v.rule_id for v in report.blocker_violations]


def test_board_limit_enforced_not_hardcoded(tmp_path):
    # 主板 +11% → BIZ-01；同样幅度换成创业板（20%）则合法
    main_bars = [bar_row(trade_date=DAYS[-1], high="11.20", close="11.10", low="10.00", open="10.10", prev_close="10.00")]
    main_report = run_quality_checks(_state(tmp_path / "main", bars=main_bars))
    assert "BIZ-01" in [v.rule_id for v in main_report.blocker_violations]

    gem_bars = [bar_row(trade_date=DAYS[-1], instrument_id="SZSE:300750", high="11.20", close="11.10",
                        low="10.00", open="10.10", prev_close="10.00")]
    gem_instrument = instrument_row(instrument_id="SZSE:300750", board="gem", listed_at="2018-06-11")
    gem_report = run_quality_checks(_state(tmp_path / "gem", instrument=gem_instrument, bars=gem_bars))
    assert "BIZ-01" not in [v.rule_id for v in gem_report.blocker_violations]
    assert gem_report.blocked is False


def test_warn_does_not_block_or_drop_score(tmp_path):
    # 非首日缺 prev_close → BIZ-02 warn：不进 blocker、不阻断、不扣分
    bars = [bar_row(trade_date=DAYS[0], prev_close="10.30")]
    second = bar_row(trade_date=DAYS[1], prev_close="10.30")
    second.pop("prev_close")
    bars.append(second)
    report = run_quality_checks(_state(tmp_path, bars=bars))
    assert report.blocked is False
    assert report.score == 100.0
    assert [(r.category, v.rule_id) for r in report.results for v in r.violations] == [("business", "BIZ-02")]


def test_report_serializable(tmp_path):
    report = run_quality_checks(_state(tmp_path))
    payload = json.dumps(report.as_dict(), ensure_ascii=False)
    assert '"grade": "green"' in payload


def test_config_scoring_is_blocker_only_l9():
    # L9：质量分只由 blocker 计分；warn 不进分子/分母（配置显式声明，待 H4 会签）
    scoring = load_config()["scoring"]
    assert scoring["mode"] == "blocker_only"
    assert scoring["warn_affects_score"] is False
    assert scoring["decision_ref"] == "L9"


def test_violation_counts_is_independent_from_score(tmp_path):
    # 违规数与质量分是两个独立指标：warn 只进 violation_counts，不改 score
    bars = [bar_row(trade_date=DAYS[0], prev_close="10.30")]
    second = bar_row(trade_date=DAYS[1], prev_close="10.30")
    second.pop("prev_close")
    bars.append(second)
    report = run_quality_checks(_state(tmp_path, bars=bars))
    assert report.violation_counts == {"blocker": 0, "warn": 1}
    assert report.score == 100.0
    assert report.as_dict()["violation_counts"] == {"blocker": 0, "warn": 1}

    clean = run_quality_checks(_state(tmp_path / "clean"))
    assert clean.violation_counts == {"blocker": 0, "warn": 0}


def test_category_score_counts_distinct_blocker_rules(tmp_path):
    # L9：类别分 = 100 × (1 − 该类别命中 blocker 的不同规则数 / 该类规则总数)
    bars = _chain()
    bars[-1] = bar_row(trade_date=DAYS[-1], high="9.00", low="9.90", close="9.50", prev_close="10.30")
    report = run_quality_checks(_state(tmp_path, bars=bars))
    assert round(report.category_scores["struct"], 2) == round(100 * (1 - 1 / 6), 2)
    assert report.category_scores["business"] == 100.0
    assert report.score == round(0.2 * round(100 * (1 - 1 / 6), 2) + 80, 2)


def test_same_rule_hit_twice_counts_once(tmp_path):
    # 分子按规则去重：同一规则命中 2 条也只算 1（分数不随样本量放大）
    bars = _chain()
    for i in (1, 2):
        bars[i] = bar_row(trade_date=DAYS[i], high="9.00", low="9.90", close="9.50", prev_close="10.30")
    report = run_quality_checks(_state(tmp_path, bars=bars))
    assert round(report.category_scores["struct"], 2) == round(100 * (1 - 1 / 6), 2)
    assert len([v for v in report.blocker_violations if v.rule_id == "STRUCT-03"]) == 2


def test_business_rule_denominator_is_six(tmp_path):
    # 业务规则总数 6（BIZ-01/BIZ-02/BIZ-03 + RES-02 研究量纲 + RES-05/06 P2 研究规则）：
    # 命中 BIZ-01 → 类别分 83.33，总分 95.0；阈值不变，blocker 一票否决仍 black。
    bars = [bar_row(trade_date=DAYS[-1], high="11.20", close="11.10", low="10.00",
                    open="10.10", prev_close="10.00")]
    report = run_quality_checks(_state(tmp_path, bars=bars))
    assert round(report.category_scores["business"], 2) == round(100 * (1 - 1 / 6), 2)
    assert report.score == 95.0
    assert report.grade == "black" and report.blocked is True

def test_unknown_board_is_fail_closed_not_silent(tmp_path):
    # M04 fail-closed：未知板块不得被静默映射成"没涨跌停"，BIZ-01 必须 blocker。
    # ODS loader 已在入口拒收未知 board；这里模拟"绕过 loader 的脏维表"（DWD 直连/历史库），
    # 质量层必须再兜一次（defense in depth）。
    bars = [bar_row(trade_date=DAYS[-1], prev_close="10.30")]
    state = _state(tmp_path, bars=bars)
    state.instruments["SSE:600519"]["board"] = "other"
    report = run_quality_checks(state)
    hits = [v for v in report.blocker_violations if v.rule_id == "BIZ-01"]
    assert hits, [v.rule_id for v in report.violations]
    assert "未知板块" in hits[0].detail
    assert report.grade == "black" and report.blocked is True


def test_st_historical_bar_gets_biz03_warn_not_block(tmp_path):
    # L80：当前 ST 名称 + trade_date 早于 dim.as_of → BIZ-03 warn（不拖绿、不阻断）
    report = run_quality_checks(_state(tmp_path, instrument=instrument_row(name="ST测试")))
    warns = [v for r in report.results for v in r.violations if v.rule_id == "BIZ-03"]
    assert warns and all(v.severity == "warn" for v in warns)
    assert report.grade == "green" and report.blocked is False
    assert report.score == 100.0


def test_st_same_day_bar_has_no_biz03(tmp_path):
    # 同一交易日（trade_date == dim.as_of 日期）不需要"历史还原"，不应告警
    bars = [bar_row(trade_date=DAYS[-1], prev_close="10.30")]
    report = run_quality_checks(_state(tmp_path, instrument=instrument_row(name="ST测试"), bars=bars))
    assert not [v for r in report.results for v in r.violations if v.rule_id == "BIZ-03"]


def test_ipo_first_5_days_no_limit_skipped(tmp_path):
    # 科创新股上市第 2 日 +30%：无涨跌幅，BIZ-01 不得误判涨停；第 6 日恢复正常判定。
    instrument = instrument_row("SSE:688001", board="star", listed_at="2026-05-04")
    bars = [
        bar_row(trade_date="2026-05-04", instrument_id="SSE:688001", prev_close=None, close="10.00", high="10.00", low="9.50", open="9.50"),
        bar_row(trade_date="2026-05-05", instrument_id="SSE:688001", prev_close="10.00", close="13.00", high="13.00", low="11.00", open="11.00"),
    ]
    report = run_quality_checks(_state(tmp_path, instrument=instrument, bars=bars))
    assert "BIZ-01" not in {r.rule_id for r in report.results if r.violations}

    day6 = [
        bar_row(trade_date="2026-05-04", instrument_id="SSE:688001", prev_close=None, close="10.00", high="10.00", low="9.50", open="9.50"),
        bar_row(trade_date="2026-05-05", instrument_id="SSE:688001", prev_close="10.00", close="10.10", high="10.20", low="10.00", open="10.00"),
        bar_row(trade_date="2026-05-06", instrument_id="SSE:688001", prev_close="10.10", close="10.20", high="10.30", low="10.10", open="10.10"),
        bar_row(trade_date="2026-05-07", instrument_id="SSE:688001", prev_close="10.20", close="10.10", high="10.30", low="10.10", open="10.20"),
        bar_row(trade_date="2026-05-08", instrument_id="SSE:688001", prev_close="10.10", close="10.00", high="10.10", low="10.00", open="10.10"),
        bar_row(trade_date="2026-05-11", instrument_id="SSE:688001", prev_close="10.00", close="12.50", high="12.50", low="11.50", open="11.50"),
    ]
    report6 = run_quality_checks(_state(tmp_path / "d6", instrument=instrument, bars=day6))
    assert "BIZ-01" in {v.rule_id for v in report6.blocker_violations}


def test_listed_at_missing_skips_limit_check_fail_closed(tmp_path):
    # listed_at 缺失：无法判首日/上市初期 → BIZ-01 不做涨跌停判定（M04 同口径 NULL）。
    instrument = instrument_row("SSE:600900", listed_at=None)
    bars = [bar_row(trade_date=DAYS[-1], instrument_id="SSE:600900", prev_close="10.00", close="11.10", high="11.10", low="10.00", open="10.10")]
    report = run_quality_checks(_state(tmp_path, instrument=instrument, bars=bars))
    assert "BIZ-01" not in {r.rule_id for r in report.results if r.violations}
