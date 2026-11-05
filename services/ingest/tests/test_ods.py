"""ODS 交换格式 v1 单测：行形状、信封、路径、原子写。"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

import pytest

from market_ingest.models import (
    AdjFactorRecord,
    AdjType,
    BarRecord,
    Board,
    ExchangeCode,
    InstrumentRecord,
    ListStatus,
    SecurityType,
    SourceRef,
    SuspensionRecord,
    market_close_at,
)
from market_ingest.ods import (
    DISPLAY_INSTRUMENT_FIELDS,
    OdsBatch,
    OdsFormatError,
    adj_factor_rows,
    bar_rows,
    instrument_rows,
    validate_display_instrument_rows,
    write_batch,
)
from support import FIXED_NOW

START = date(2024, 1, 2)
SOURCE = SourceRef(source="tushare", as_of=market_close_at(date(2024, 1, 2)), fetched_at=FIXED_NOW)


def _bar(trade_date: date = START, *, close: str = "10.20", prev_close: str | None = "10.00") -> BarRecord:
    return BarRecord(
        instrument_id="SSE:600519",
        trade_date=trade_date,
        open=Decimal("10.00"),
        high=Decimal("10.50"),
        low=Decimal("9.80"),
        close=Decimal(close),
        volume=123400,
        amount=Decimal("5678900.00"),
        adjustment=AdjType.NONE,
        source=SOURCE,
        prev_close=None if prev_close is None else Decimal(prev_close),
    )


def test_bar_rows_use_decimal_strings_and_integer_volume() -> None:
    rows = bar_rows([_bar()])
    assert rows == [
        {
            "instrument_id": "SSE:600519",
            "trade_date": "2024-01-02",
            "open": "10.00",
            "high": "10.50",
            "low": "9.80",
            "close": "10.20",
            "volume": "123400",
            "amount": "5678900.00",
            "prev_close": "10.00",
        }
    ]
    assert isinstance(rows[0]["volume"], str)  # 交换格式要求十进制字符串，禁 JSON float


def test_bse_pre_continuous_auction_bars_are_tagged_neeq_select() -> None:
    """H4 m03705 ②：2021-11-15 前的北交所代码成交属精选层，bar 行须打段标记。"""
    legacy = BarRecord(
        instrument_id="BSE:920000",
        trade_date=date(2019, 5, 24),
        open=Decimal("10.00"),
        high=Decimal("10.50"),
        low=Decimal("9.80"),
        close=Decimal("10.20"),
        volume=1000,
        amount=Decimal("10000.00"),
        adjustment=AdjType.NONE,
        source=SOURCE,
        prev_close=Decimal("10.00"),
    )
    rows = bar_rows([legacy])
    assert rows[0]["market_segment"] == "neeq_select"

    # 连续竞价后与沪深 A 股：不写该字段（避免下游误判）。
    from dataclasses import replace

    rows = bar_rows([replace(legacy, trade_date=date(2021, 11, 15))])
    assert "market_segment" not in rows[0]
    assert "market_segment" not in bar_rows([_bar()])[0]


def test_bar_rows_omit_prev_close_on_listing_day_and_include_suspended_evidence() -> None:
    suspension = SuspensionRecord(instrument_id="SSE:600519", trade_date=date(2024, 1, 3), source=SOURCE)
    rows = bar_rows([_bar()], [suspension])
    assert "prev_close" not in bar_rows([_bar(prev_close=None)])[0]
    assert rows[-1] == {"instrument_id": "SSE:600519", "trade_date": "2024-01-03", "suspended": True}
    assert [row["trade_date"] for row in rows] == ["2024-01-02", "2024-01-03"]


def test_adj_factor_rows() -> None:
    record = AdjFactorRecord(
        instrument_id="SSE:600519", trade_date=START, factor=Decimal("2.000000"), source=SOURCE
    )
    assert adj_factor_rows([record]) == [
        {"instrument_id": "SSE:600519", "trade_date": "2024-01-02", "factor": "2.000000"}
    ]


def test_batch_envelope_counts_and_partition_date() -> None:
    batch = OdsBatch(
        batch_id="ing-20240105T193000-deadbeef-SSE-600519-20240101",
        endpoint="bar",
        source=SOURCE,
        rows=tuple(bar_rows([_bar()])),
        rows_rejected=2,
    )
    assert batch.schema == "bar.v1"
    assert batch.rows_total == 3
    assert batch.partition_date == START

    empty = OdsBatch(batch_id="b", endpoint="adj_factor", source=SOURCE, rows=())
    assert isinstance(empty.partition_date, date)  # 空批次回落当天（正常路径不会写出空批次）

    with pytest.raises(OdsFormatError):
        OdsBatch(batch_id="  ", endpoint="bar", source=SOURCE, rows=())
    with pytest.raises(OdsFormatError):
        OdsBatch(batch_id="b", endpoint="daily", source=SOURCE, rows=())
    with pytest.raises(OdsFormatError):
        OdsBatch(batch_id="b", endpoint="bar", source=SOURCE, rows=(), rows_rejected=-1)


def test_write_batch_path_and_envelope(tmp_path) -> None:
    batch = OdsBatch(
        batch_id="ing-20240105T193000-deadbeef-SSE-600519-20240101",
        endpoint="bar",
        source=SOURCE,
        rows=tuple(bar_rows([_bar()])),
    )
    path = write_batch(tmp_path, batch)
    assert path == tmp_path / "bar" / "dt=2024-01-02" / f"{batch.batch_id}.json"

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["batch_id"] == batch.batch_id
    assert payload["endpoint"] == "bar"
    assert payload["schema"] == "bar.v1"
    assert payload["source"] == {
        "source": "tushare",
        "as_of": "2024-01-02T15:00:00+08:00",
        "fetched_at": FIXED_NOW.isoformat(),
    }
    assert payload["rows_total"] == 1
    assert payload["rows_rejected"] == 0
    assert payload["rows"][0]["close"] == "10.20"
    # 重写同一 batch_id 幂等覆盖，不产生 .tmp 残留
    assert write_batch(tmp_path, batch) == path
    assert not list(path.parent.glob("*.tmp"))


def _instrument() -> InstrumentRecord:
    return InstrumentRecord(
        instrument_id="SSE:600519",
        exchange=ExchangeCode.SSE,
        code="600519",
        name="贵州茅台",
        board=Board.MAIN,
        security_type=SecurityType.STOCK,
        list_status=ListStatus.LISTED,
        lot_size=100,
        listed_at=date(2001, 8, 27),
        source=SOURCE,
    )


def test_display_instrument_rows_are_exactly_seven_fields() -> None:
    display = instrument_rows([_instrument()], for_display=True)
    assert set(display[0]) == set(DISPLAY_INSTRUMENT_FIELDS)
    assert "code" not in display[0] and "lot_size" not in display[0]
    validate_display_instrument_rows(display)
    internal = instrument_rows([_instrument()])
    assert internal[0]["code"] == "600519" and internal[0]["lot_size"] == 100


def test_display_rows_reject_non_whitelisted_fields() -> None:
    row = instrument_rows([_instrument()], for_display=True)[0]
    row["lot_size"] = 100
    with pytest.raises(OdsFormatError):
        validate_display_instrument_rows([row])
