"""ODS 交换格式 v1 校验：拒绝路径必须报错，不得静默补齐。"""

from __future__ import annotations

import json

import pytest

from warehouse.ods.loader import (
    OdsFormatError,
    SchemaDriftError,
    load_batch,
    load_batches,
    write_batch,
)
from warehouse.tests.helpers import (
    AS_OF,
    FETCHED_AT,
    bar_row,
    factor_row,
    fundamental_row,
    instrument_row,
    source,
)

from warehouse.golden_runner import _envelope, _write_envelope, run_case


def _write(tmp_path, envelope) -> None:
    _write_envelope(tmp_path, envelope)


def test_valid_bar_batch_normalizes_types(tmp_path):
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(), [bar_row()]))
    (batch,) = load_batches(tmp_path)
    row = batch.rows[0]
    assert row["instrument_id"] == "SSE:600519"
    assert row["trade_date"].isoformat() == "2026-09-30"
    assert str(row["close"]) == "10.30"
    assert row["suspended"] is False


def test_float_price_rejected(tmp_path):
    bad = bar_row(close=10.30)  # JSON float，丢精度
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(), [bad]))
    with pytest.raises(OdsFormatError, match="禁止 JSON float"):
        load_batches(tmp_path)


def test_rows_total_invariant_enforced(tmp_path):
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(), [bar_row()], rows_total=2))
    with pytest.raises(OdsFormatError, match="不变式失败"):
        load_batches(tmp_path)


def test_tushare_field_leak_rejected(tmp_path):
    bad = bar_row(**{"ts_code": "600519.SH"})
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(), [bad]))
    with pytest.raises(SchemaDriftError, match="数据源字段名"):
        load_batches(tmp_path)


def test_naive_as_of_rejected(tmp_path):
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(as_of="2026-09-30T20:05:00"), [bar_row()]))
    with pytest.raises(OdsFormatError, match="必须带时区"):
        load_batches(tmp_path)


def test_fetched_before_as_of_rejected(tmp_path):
    src = source(as_of="2026-09-30T20:06:00+08:00", fetched_at="2026-09-30T20:05:00+08:00")
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", src, [bar_row()]))
    with pytest.raises(OdsFormatError, match="早于 as_of"):
        load_batches(tmp_path)


def test_duplicate_batch_id_rejected(tmp_path):
    _write(tmp_path, _envelope("dup", "bar", "bar.v1", source(), [bar_row()]))
    _write(tmp_path, _envelope("dup", "bar", "bar.v1", source(), [bar_row(trade_date="2026-09-29")]))
    with pytest.raises(OdsFormatError, match="batch_id 重复"):
        load_batches(tmp_path)


def test_invalid_instrument_id_rejected(tmp_path):
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(), [bar_row(instrument_id="600519")]))
    with pytest.raises(OdsFormatError, match="instrument_id 必须匹配"):
        load_batches(tmp_path)


def test_suspended_row_has_no_ohlc(tmp_path):
    row = {"instrument_id": "SSE:600519", "trade_date": "2026-09-30", "suspended": True}
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(), [row]))
    (batch,) = load_batches(tmp_path)
    assert batch.rows[0]["suspended"] is True
    assert "close" not in batch.rows[0]


def test_volume_must_be_integer_shares(tmp_path):
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(), [bar_row(volume="100.5")]))
    with pytest.raises(OdsFormatError, match="必须是整数"):
        load_batches(tmp_path)


def test_write_batch_roundtrip(tmp_path):
    _write(tmp_path, _envelope("b1", "bar", "bar.v1", source(), [bar_row()]))
    (batch,) = load_batches(tmp_path)
    out = tmp_path / "roundtrip"
    path = write_batch(out, batch)
    assert path.exists()
    (again,) = load_batches(out)
    assert again.rows == batch.rows
    assert again.batch_id == batch.batch_id
    assert again.source.as_of.isoformat() == AS_OF


def test_instrument_board_combination_checked(tmp_path):
    bad = instrument_row(board="gem")  # SSE 没有 gem 板块
    _write(tmp_path, _envelope("b1", "instrument", "instrument.v1", source(), [bad]))
    with pytest.raises(OdsFormatError, match="交易所/板块组合"):
        load_batches(tmp_path)


def test_factor_requires_positive_decimal_string(tmp_path):
    _write(tmp_path, _envelope("b1", "adj_factor", "adj_factor.v1", source(), [factor_row(factor="1.2")]))
    (batch,) = load_batches(tmp_path)
    assert str(batch.rows[0]["factor"]) == "1.2"


def test_golden_runner_reports_envelope_rejection():
    case = {
        "id": "T1",
        "title": "rows_total 不匹配",
        "raw_batches": [
            {
                "batch_id": "x",
                "endpoint": "bar",
                "schema": "bar.v1",
                "source": {"source": "tushare", "as_of": AS_OF, "fetched_at": FETCHED_AT},
                "rows_total": 5,
                "rows_rejected": 0,
                "rows": [],
            }
        ],
        "expect": {"rejected": True, "error_contains": "不变式失败"},
    }
    result = run_case(case)
    assert result.passed, result.failures


# --------------------------------------------------------------------------
# fundamental.v1（M06：reported/restated 双口径，金额=元）
# --------------------------------------------------------------------------


def test_valid_fundamental_batch_normalizes(tmp_path):
    _write(tmp_path, _envelope("b-f1", "fundamental", "fundamental.v1", source(), [fundamental_row()]))
    (batch,) = load_batches(tmp_path)
    row = batch.rows[0]
    assert row["report_period"] == "2026Q2"
    assert row["report_end_date"].isoformat() == "2026-06-30"
    assert row["announced_at"].isoformat() == "2026-08-20T19:00:00+08:00"
    assert row["statement_basis"] == "reported"
    assert str(row["revenue"]) == "100000000.00"
    assert str(row["net_profit"]) == "20000000.00"
    assert str(row["eps"]) == "1.2345"
    assert row["roe_pct"] is None


def test_fundamental_partition_uses_report_end_date(tmp_path):
    _write(tmp_path, _envelope("b-f1", "fundamental", "fundamental.v1", source(), [fundamental_row()]))
    (batch,) = load_batches(tmp_path)
    assert batch.trade_dates == [__import__("datetime").date(2026, 6, 30)]


def test_fundamental_float_revenue_rejected(tmp_path):
    _write(tmp_path, _envelope("b-f1", "fundamental", "fundamental.v1", source(),
                               [fundamental_row(revenue=1.5e8)]))
    with pytest.raises(OdsFormatError, match="禁止 JSON float"):
        load_batches(tmp_path)


def test_fundamental_report_period_pattern_enforced(tmp_path):
    _write(tmp_path, _envelope("b-f1", "fundamental", "fundamental.v1", source(),
                               [fundamental_row(report_period="2026-06-30")]))
    with pytest.raises(OdsFormatError, match="YYYYQn"):
        load_batches(tmp_path)


def test_fundamental_statement_basis_enum(tmp_path):
    _write(tmp_path, _envelope("b-f1", "fundamental", "fundamental.v1", source(),
                               [fundamental_row(statement_basis="adjusted")]))
    with pytest.raises(OdsFormatError, match="statement_basis"):
        load_batches(tmp_path)


def test_fundamental_rejects_market_fields(tmp_path):
    # 财务行没有行情语义：trade_date/adjustment 出现即格式错误，不静默忽略
    _write(tmp_path, _envelope("b-f1", "fundamental", "fundamental.v1", source(),
                               [fundamental_row(trade_date="2026-06-30")]))
    with pytest.raises(OdsFormatError, match="财务行不得出现"):
        load_batches(tmp_path)


def test_fundamental_announced_at_requires_shanghai_tz(tmp_path):
    _write(tmp_path, _envelope("b-f1", "fundamental", "fundamental.v1", source(),
                               [fundamental_row(announced_at="2026-08-20T19:00:00")]))
    with pytest.raises(OdsFormatError, match="必须带时区"):
        load_batches(tmp_path)


def test_fundamental_roundtrip_write_batch_layout(tmp_path):
    _write(tmp_path, _envelope("b-f1", "fundamental", "fundamental.v1", source(),
                               [fundamental_row(), fundamental_row(statement_basis="restated")]))
    (batch,) = load_batches(tmp_path)
    assert len(batch.rows) == 2
    out = write_batch(tmp_path / "out", batch)
    assert out.parent.name == "dt=2026-06-30"
    assert out.parent.parent.name == "fundamental"
