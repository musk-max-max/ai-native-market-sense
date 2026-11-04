"""A1 ↔ A2 的 ODS 冒烟批次验收（录播夹具，仅验格式，不代表真实行情）。

数据由 A1 生成在 `services/ingest/var/ods-smoke/`；该目录是运行时产物、可能被重建，
因此本测试在目录不存在时 skip，且只断言"形状/语义约束"，不断言具体标的清单。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from warehouse.dwd.build import build_dwd
from warehouse.ods.loader import load_batches
from warehouse.quality.checks import run_quality_checks

ODS_SMOKE = (
    Path(__file__).resolve().parents[2] / "services" / "ingest" / "var" / "ods-smoke"
)

pytestmark = pytest.mark.skipif(
    not ODS_SMOKE.is_dir(),
    reason="A1 的 ODS 冒烟批次尚未生成（services/ingest/var/ods-smoke）",
)

INSTRUMENT_ID = re.compile(r"^(SSE|SZSE|BSE):[0-9]{6}$")
REPORT_PERIOD = re.compile(r"^[0-9]{4}Q[1-4]$")


def test_a1_smoke_batches_load_and_normalize():
    batches = load_batches(ODS_SMOKE)
    assert {b.endpoint for b in batches} >= {"instrument", "fundamental"}

    state = build_dwd(batches)
    assert state.instruments, "instrument.v1 应至少落一条 dim 行"
    assert state.fundamentals, "fundamental.v1 应至少落一条财务行"
    assert state.bars, "bar.v1 应至少落一条 bar"
    assert state.factors, "adj_factor.v1 应至少落一条因子"
    assert set(state.bars) <= set(state.factors), "每根 bar 必须有复权因子（STRUCT-06）"
    assert state.issues == []

    for instrument_id, row in state.instruments.items():
        assert INSTRUMENT_ID.match(instrument_id)
        assert row["instrument_id"] == instrument_id
        assert row["board"] in {"main", "gem", "star", "bse"}
        assert row["security_type"] in {"stock", "etf", "index"}
        assert row["list_status"] in {"listed", "delisted", "pre_listed"}
        assert row["lot_size"] > 0
        assert row["source"] and row["as_of"] and row["fetched_at"]

    for (instrument_id, report_period, basis), row in state.fundamentals.items():
        assert INSTRUMENT_ID.match(instrument_id)
        assert REPORT_PERIOD.match(report_period)
        assert basis in {"reported", "restated"}
        assert row["statement_basis"] == basis
        assert row["currency"] == "CNY"
        assert row["revenue"] >= 0 and row["net_profit"] is not None
        assert row["source"] and row["as_of"] and row["fetched_at"]


def test_a1_smoke_batches_pass_quality_gate():
    state = build_dwd(load_batches(ODS_SMOKE))
    report = run_quality_checks(state)
    # 冒烟批次当前无 bar：bar 类规则 evaluated=0，门禁只应给出 green。
    assert report.score == 100.0
    assert report.grade == "green" and report.blocked is False
    assert report.violation_counts == {"blocker": 0, "warn": 0}
