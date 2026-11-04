"""14 条数据校验规则的单元级触发测试（每条规则一例，互相隔离）。

目的：golden 包只证明「A2 的期望能被复现」，本文件证明「每条规则都能单独触发」——
否则某条规则可能从未被执行过，规则覆盖率高但实际是空转（数据缺陷逃逸的典型来源）。
"""

from __future__ import annotations

import copy

import pytest

from quality_lib import CaseData, Pack, evaluate_case, load_policy

INSTRUMENT = {
    "instrument_id": "SSE:600519",
    "exchange": "SSE",
    "code": "600519",
    "name": "测试股份",
    "board": "main",
    "security_type": "stock",
    "list_status": "listed",
    "lot_size": 100,
    "listed_at": "2000-01-04",
}


def bar(date: str, **overrides) -> dict:
    base = {
        "trade_date": date,
        "open": "9.98",
        "high": "10.02",
        "low": "9.97",
        "close": "10.00",
        "volume": "1000",
        "amount": "10000.00",
        "prev_close": "10.00",
    }
    base.update(overrides)
    return base


BASE_CASE = CaseData(
    case_id="U-BASE",
    title="干净基线",
    instrument=copy.deepcopy(INSTRUMENT),
    bars=[bar("2026-09-28")],
    factors=None,
    suspended=[],
    as_of="2026-09-28T20:05:00+08:00",
    fetched_at="2026-09-28T20:05:03+08:00",
    expect={"grade": "green", "blocked": False, "violations": []},
)


def make_case(**kwargs) -> CaseData:
    case = copy.deepcopy(BASE_CASE)
    for key, value in kwargs.items():
        setattr(case, key, value)
    return case


def run(case: CaseData, declared: set[str] | None = None):
    pack = Pack(
        path=__import__("pathlib").Path("unit://case"),
        meta={"version": 1},
        cases=[case],
        declared_instruments=declared if declared is not None else {INSTRUMENT["instrument_id"]},
    )
    return evaluate_case(pack, case, load_policy())


def test_clean_baseline_has_no_violation():
    report = run(BASE_CASE)
    assert report.violations == [], report.violations
    assert report.score == 100.0
    assert (report.grade, report.blocked) == ("green", False)


# --- 结构层 -------------------------------------------------------------
def test_struct_01_missing_required_field():
    bars = [bar("2026-09-28")]
    del bars[0]["open"]
    assert run(make_case(bars=bars)).rule_ids == {"STRUCT-01"}


def test_struct_02_duplicate_primary_key():
    report = run(make_case(bars=[bar("2026-09-28"), bar("2026-09-28", volume="2000")]))
    assert report.rule_ids == {"STRUCT-02"}


def test_struct_03_ohlc_relation():
    assert run(make_case(bars=[bar("2026-09-28", high="9.90")])).rule_ids == {"STRUCT-03"}


def test_struct_04_negative_volume_or_price():
    assert run(make_case(bars=[bar("2026-09-28", volume="-100")])).rule_ids == {"STRUCT-04"}


def test_struct_05_too_many_price_decimals():
    assert run(make_case(bars=[bar("2026-09-28", open="9.980")])).rule_ids == {"STRUCT-05"}


def test_struct_06_factor_must_be_positive_on_every_bar():
    case = make_case(factors=[{"trade_date": "2026-09-28", "factor": "0"}])
    assert run(case).rule_ids == {"STRUCT-06"}


# --- 业务规则层 ----------------------------------------------------------
def test_biz_01_board_price_limit():
    bars = [bar("2026-09-28", open="11.00", high="11.10", low="11.00", close="11.10")]
    assert run(make_case(bars=bars)).rule_ids == {"BIZ-01"}


def test_biz_02_missing_prev_close_is_warn_only():
    bars = [bar("2026-09-28")]
    del bars[0]["prev_close"]
    report = run(make_case(bars=bars))
    assert report.rule_ids == {"BIZ-02"}
    assert (report.grade, report.blocked) == ("green", False), "单条 warn 不应让数据变红"


# --- 完整性/及时性层 -----------------------------------------------------
def test_comp_01_no_weekend_bar():
    case = make_case(bars=[bar("2026-09-26")], as_of="2026-09-26T20:05:00+08:00")
    assert run(case).rule_ids == {"COMP-01"}


def test_comp_02_as_of_before_close():
    case = make_case(as_of="2026-09-28T09:00:00+08:00")
    assert run(case).rule_ids == {"COMP-02"}


def test_comp_03_missing_weekday_without_suspension_evidence():
    bars = [bar("2026-09-28"), bar("2026-09-30")]
    case = make_case(bars=bars, as_of="2026-09-30T20:05:00+08:00")
    assert run(case).rule_ids == {"COMP-03"}


def test_comp_03_suspension_evidence_clears_gap():
    bars = [bar("2026-09-28"), bar("2026-09-30")]
    case = make_case(bars=bars, suspended=["2026-09-29"], as_of="2026-09-30T20:05:00+08:00")
    assert run(case).rule_ids == set(), "停牌证据必须能解释缺口（C08 不补 0）"


# --- 一致性层 -----------------------------------------------------------
def test_cons_01_prev_close_must_match_previous_close():
    bars = [
        bar("2026-09-28"),
        bar("2026-09-29", prev_close="10.20", open="10.20", high="10.35", low="10.20", close="10.30", amount="10300.00"),
    ]
    case = make_case(bars=bars, as_of="2026-09-29T20:05:00+08:00")
    assert run(case).rule_ids == {"CONS-01"}


def test_cons_02_instrument_must_exist_in_dim():
    bars = [bar("2026-09-28", instrument_id="SSE:999999")]
    assert run(make_case(bars=bars)).rule_ids == {"CONS-02"}


def test_biz_03_st_name_on_historical_bar_is_warn():
    """L80：ST 判定只有当期名称快照；bar 早于 as_of 日期时 warn 标注，不改涨跌停口径。"""
    instrument = dict(INSTRUMENT, name="ST测试", instrument_id="SSE:600601")
    case = make_case(instrument=instrument, as_of="2026-09-30T20:05:00+08:00")
    assert run(case).rule_ids == {"BIZ-03"}


def test_biz_03_same_day_snapshot_has_no_warning():
    """bar 与快照同日：没有"历史未还原"问题，不得告警（防误报）。"""
    instrument = dict(INSTRUMENT, name="ST测试", instrument_id="SSE:600602")
    case = make_case(instrument=instrument, as_of="2026-09-28T20:05:00+08:00")
    assert run(case).rule_ids == set()


def test_biz_03_non_st_instrument_is_not_flagged():
    instrument = dict(INSTRUMENT, name="测试股份")
    case = make_case(instrument=instrument, as_of="2026-09-30T20:05:00+08:00")
    assert "BIZ-03" not in run(case).rule_ids


# --- 覆盖率门禁 ---------------------------------------------------------
RULESET = {
    "STRUCT-01", "STRUCT-02", "STRUCT-03", "STRUCT-04", "STRUCT-05", "STRUCT-06",
    "BIZ-01", "BIZ-02", "BIZ-03",
    "COMP-01", "COMP-02", "COMP-03",
    "CONS-01", "CONS-02",
}


def test_rule_catalog_is_fully_exercised():
    """14 条规则必须全部被本文件单独触发；新增规则必须在同一 PR 补单测。"""
    policy = load_policy()
    assert set(policy["rules"]) == RULESET, "口径规则清单变了：先补单测与质量分配置"
