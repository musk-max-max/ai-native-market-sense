"""映射与单位换算单测（手→股、千元→元、复权、缺失值不补 0）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from market_ingest.adapters.tushare import mapper
from market_ingest.models import AdjType, SourceRef
from support import FIXED_NOW, bar_row, factor_row


def _source() -> SourceRef:
    return SourceRef(source="test-source", as_of=FIXED_NOW, fetched_at=FIXED_NOW)


def test_source_code_roundtrip() -> None:
    assert mapper.to_instrument_id("600519.SH") == "SSE:600519"
    assert mapper.to_instrument_id("000001.SZ") == "SZSE:000001"
    assert mapper.to_instrument_id("430047.BJ") == "BSE:430047"
    assert mapper.to_source_code("SSE:600519") == "600519.SH"


@pytest.mark.parametrize("bad", ["600519", "60051.SH", "600519.HK", "600519.sh."])
def test_bad_source_code_rejected(bad: str) -> None:
    with pytest.raises(mapper.RowMapError):
        mapper.to_instrument_id(bad)


def test_units_lots_to_shares_and_k_yuan_to_yuan() -> None:
    bar = mapper.map_bar_row(
        bar_row(date(2024, 1, 2), vol="1234", amount="5678.9"),
        instrument_id="SSE:600519",
        adjustment=AdjType.NONE,
        source=_source(),
    )
    assert bar.volume == 123400  # 手 → 股
    assert bar.amount == Decimal("5678900.0")  # 千元 → 元
    assert bar.open == Decimal("10.0")
    assert bar.trade_date == date(2024, 1, 2)
    assert bar.adjustment is AdjType.NONE


def test_missing_price_is_rejected_not_zero() -> None:
    row = bar_row(date(2024, 1, 2))
    row["close"] = None
    with pytest.raises(mapper.RowMapError, match="missing close"):
        mapper.map_bar_row(row, instrument_id="SSE:600519", adjustment=AdjType.NONE, source=_source())


def test_inconsistent_ohlc_is_rejected() -> None:
    row = bar_row(date(2024, 1, 2), open="10.0", high="9.0", low="8.0", close="10.0")
    with pytest.raises(ValueError, match="OHLC"):
        mapper.map_bar_row(row, instrument_id="SSE:600519", adjustment=AdjType.NONE, source=_source())


def test_qfq_ratio_scales_prices_with_two_decimals() -> None:
    bar = mapper.map_bar_row(
        bar_row(date(2024, 1, 2), open="10.0", high="10.5", low="9.8", close="10.2"),
        instrument_id="SSE:600519",
        adjustment=AdjType.QFQ,
        source=_source(),
        factor_ratio=Decimal("0.5"),
    )
    assert bar.open == Decimal("5.00")
    assert bar.close == Decimal("5.10")
    assert bar.adjustment is AdjType.QFQ


def test_check_bar_fields_detects_schema_drift() -> None:
    from market_ingest.ports import SchemaDriftError

    row = bar_row(date(2024, 1, 2))
    del row["close"]
    with pytest.raises(SchemaDriftError, match="missing fields"):
        mapper.check_bar_fields([row], endpoint="daily")
    mapper.check_bar_fields([], endpoint="daily")  # 空页合法（非交易日）


def test_parse_trade_date() -> None:
    assert mapper.parse_trade_date("20240102") == date(2024, 1, 2)
    with pytest.raises(mapper.RowMapError):
        mapper.parse_trade_date("2024-01-02")
    with pytest.raises(mapper.RowMapError):
        mapper.parse_trade_date("20240230")


def test_factor_row_shape() -> None:
    assert factor_row(date(2024, 1, 2))["adj_factor"] == "1.0"
