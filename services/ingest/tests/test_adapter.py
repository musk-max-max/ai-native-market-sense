"""适配器单测：录播重放 → canonical 记录、raw 交付、DLQ、分页、三口径。"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

import pytest

from market_ingest.adapters.tushare import transport as ts_transport
from market_ingest.adapters.tushare.adapter import create_adapter
from market_ingest.models import AdjType, market_close_at
from market_ingest.ports import InvalidRequestError, RawPage, RejectedRow, SchemaDriftError
from market_ingest.quota import InMemoryCallLedger, QuotaGuard, QuotaPolicy
from support import FIXED_NOW, FakeClock, bar_row, daily_entry, factor_entry, factor_row

START = date(2024, 1, 1)
END = date(2024, 1, 4)
ROWS = [
    bar_row(date(2024, 1, 2)),
    bar_row(date(2024, 1, 3), open="10.9", high="11.2", low="10.8", close="11.0"),
]


def _guard(clock: FakeClock) -> QuotaGuard:
    return QuotaGuard(QuotaPolicy(calls_per_minute=60000, reserve_ratio=0.0), InMemoryCallLedger(), clock=clock, sleep=clock.sleep)


def _adapter(entries, *, page_limit: int = 6000):
    clock = FakeClock()
    guard = _guard(clock)
    adapter = create_adapter(
        {"page_limit": page_limit},
        transport=ts_transport.ReplayTransport(entries),
        guard=guard,
        clock=clock,
        sleep=clock.sleep,
    )
    return adapter, guard


def test_list_bars_maps_canonical_records() -> None:
    adapter, guard = _adapter([daily_entry("600519.SH", START, END, ROWS)])
    bars = adapter.list_bars("SSE:600519", START, END, AdjType.NONE)

    assert [bar.trade_date for bar in bars] == [date(2024, 1, 2), date(2024, 1, 3)]
    first = bars[0]
    assert first.instrument_id == "SSE:600519"
    assert first.volume == 1000 * 100  # 1000 手
    assert first.amount == Decimal("5000000.0")  # 5000 千元
    assert first.adjustment is AdjType.NONE
    assert first.source.as_of == market_close_at(date(2024, 1, 2))
    assert first.source.as_of != first.source.fetched_at
    assert guard.run_calls == 1


def test_raw_pages_are_handed_to_sink_before_mapping() -> None:
    raw_pages: list[RawPage] = []
    rejected: list[RejectedRow] = []
    rows = [ROWS[0], {**ROWS[1], "close": "0"}]  # 第二行非法 → DLQ
    adapter, _ = _adapter([daily_entry("600519.SH", START, END, rows)])

    with adapter.capture(raw_pages.append, rejected.append):
        bars = adapter.list_bars("SSE:600519", START, END, AdjType.NONE)

    assert len(raw_pages) == 1
    assert raw_pages[0].endpoint == "daily"
    assert raw_pages[0].rows[0]["ts_code"] == "600519.SH"  # ODS 保留源原始结构
    assert raw_pages[0].as_of == market_close_at(date(2024, 1, 3))
    assert [bar.trade_date for bar in bars] == [date(2024, 1, 2)]
    assert len(rejected) == 1
    assert rejected[0].instrument_id == "SSE:600519"


def test_schema_drift_rejects_page_but_keeps_raw() -> None:
    raw_pages: list[RawPage] = []
    bad_rows = [{"ts_code": "600519.SH", "trade_date": "20240102", "open": "10.0"}]
    adapter, _ = _adapter([daily_entry("600519.SH", START, END, bad_rows)])

    with adapter.capture(raw_pages.append, None):
        with pytest.raises(SchemaDriftError):
            adapter.list_bars("SSE:600519", START, END, AdjType.NONE)
    assert len(raw_pages) == 1


def test_pagination_until_short_page() -> None:
    rows = [bar_row(date(2024, 1, 2)), bar_row(date(2024, 1, 3)), bar_row(date(2024, 1, 4))]
    entries = [
        daily_entry("600519.SH", START, END, rows[:2], offset=0, limit=2),
        daily_entry("600519.SH", START, END, rows[2:], offset=2, limit=2),
    ]
    raw_pages: list[RawPage] = []
    adapter, guard = _adapter(entries, page_limit=2)
    with adapter.capture(raw_pages.append, None):
        bars = adapter.list_bars("SSE:600519", START, END, AdjType.NONE)
    assert len(bars) == 3
    assert len(raw_pages) == 2
    assert guard.run_calls == 2


def test_qfq_uses_latest_factor_as_base() -> None:
    rows = [
        bar_row(date(2024, 1, 2), close="10.0"),
        bar_row(date(2024, 1, 3), open="19.0", high="20.5", low="18.8", close="20.0"),
    ]
    entries = [
        daily_entry("600519.SH", START, END, rows),
        factor_entry(
            "600519.SH",
            START,
            END,
            [factor_row(date(2024, 1, 2), adj_factor="1.0"), factor_row(date(2024, 1, 3), adj_factor="2.0")],
        ),
    ]
    adapter, guard = _adapter(entries)
    bars = adapter.list_bars("SSE:600519", START, END, AdjType.QFQ)

    assert guard.run_calls == 2  # 日线 + 因子各一次
    by_date = {bar.trade_date: bar for bar in bars}
    assert by_date[date(2024, 1, 2)].close == Decimal("5.00")  # × (1.0/2.0)
    assert by_date[date(2024, 1, 3)].close == Decimal("20.00")
    assert by_date[date(2024, 1, 2)].source.as_of == market_close_at(date(2024, 1, 3))
    assert all(bar.adjustment is AdjType.QFQ for bar in bars)


def test_empty_range_returns_empty_list() -> None:
    adapter, _ = _adapter([daily_entry("600519.SH", START, END, [])])
    assert adapter.list_bars("SSE:600519", START, END, AdjType.NONE) == []


def test_invalid_requests() -> None:
    adapter, _ = _adapter([])
    with pytest.raises(InvalidRequestError):
        adapter.list_bars("600519", START, END, AdjType.NONE)
    with pytest.raises(InvalidRequestError):
        adapter.list_bars("SSE:600519", END, START, AdjType.NONE)
    adapter2, _ = _adapter([])
    with pytest.raises(InvalidRequestError):
        adapter2.list_bars("SSE:600519", START, END, "bad")  # type: ignore[arg-type]


def test_health_reflects_last_call_without_extra_quota() -> None:
    adapter, guard = _adapter([daily_entry("600519.SH", START, END, ROWS)])
    assert adapter.health().available is True
    adapter.list_bars("SSE:600519", START, END, AdjType.NONE)
    assert adapter.health().available is True
    assert guard.run_calls == 1


def test_non_slice_methods_are_explicit() -> None:
    adapter, _ = _adapter([])
    with pytest.raises(NotImplementedError):
        adapter.get_quote("SSE:600519")


def test_replay_fixture_miss_is_loud() -> None:
    adapter, _ = _adapter([])
    with pytest.raises(ts_transport.FixtureMissError):
        adapter.list_bars("SSE:600519", START, END, AdjType.NONE)


def test_bar_carries_prev_close_from_source() -> None:
    adapter, _ = _adapter([daily_entry("600519.SH", START, END, ROWS)])
    bars = adapter.list_bars("SSE:600519", START, END, AdjType.NONE)
    assert bars[0].prev_close == Decimal("10.2")


def test_factor_anchor_uses_earliest_available_factor() -> None:
    entries = [
        factor_entry(
            "600519.SH",
            date(1990, 12, 19),
            FIXED_NOW.date(),
            [factor_row(date(2020, 1, 2), adj_factor="2.0"), factor_row(date(2021, 1, 4), adj_factor="4.0")],
        )
    ]
    adapter, guard = _adapter(entries)
    anchor = adapter.factor_anchor("SSE:600519")
    assert anchor == (date(2020, 1, 2), Decimal("2.0"))
    assert guard.run_calls == 1


def test_list_adj_factors_normalizes_by_anchor() -> None:
    entries = [
        factor_entry(
            "600519.SH",
            START,
            END,
            [factor_row(date(2024, 1, 2), adj_factor="4.0"), factor_row(date(2024, 1, 3), adj_factor="4.0")],
        )
    ]
    adapter, _ = _adapter(entries)
    records = adapter.list_adj_factors("SSE:600519", START, END, anchor=Decimal("2.0"))
    assert [record.trade_date for record in records] == [date(2024, 1, 2), date(2024, 1, 3)]
    assert [record.factor for record in records] == [Decimal("2.0"), Decimal("2.0")]
    assert records[0].source.as_of == market_close_at(date(2024, 1, 2))


def test_list_trading_days_keeps_open_days_only() -> None:
    from support import calendar_entry

    entries = [calendar_entry(START, END, [date(2024, 1, 2), date(2024, 1, 3)])]
    adapter, _ = _adapter(entries)
    assert adapter.list_trading_days(START, END) == [date(2024, 1, 2), date(2024, 1, 3)]


def test_list_suspensions_filters_to_requested_instruments() -> None:
    from support import suspend_entry

    entries = [suspend_entry(date(2024, 1, 3), ["600519.SH", "000001.SZ"])]
    adapter, _ = _adapter(entries)
    records = adapter.list_suspensions([date(2024, 1, 3)], ["SSE:600519"])
    assert [(record.instrument_id, record.trade_date) for record in records] == [("SSE:600519", date(2024, 1, 3))]
    assert records[0].source.as_of == market_close_at(date(2024, 1, 3))


def test_list_adj_factors_rejects_invalid_anchor() -> None:
    adapter, _ = _adapter([])
    with pytest.raises(InvalidRequestError):
        adapter.list_adj_factors("SSE:600519", START, END, anchor=Decimal("0"))


def test_replay_fixture_file_is_loaded(tmp_path) -> None:
    """A12 文件录播路径（adapter 内重放，跳过 HTTP）：JSONL 每行一个响应。"""
    fixture = tmp_path / "daily.jsonl"
    fixture.write_text(
        json.dumps(daily_entry("600519.SH", START, END, ROWS), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    clock = FakeClock()
    adapter = create_adapter({"replay_fixture": str(fixture)}, clock=clock, sleep=clock.sleep)
    bars = adapter.list_bars("SSE:600519", START, END, AdjType.NONE)
    assert [bar.trade_date for bar in bars] == [date(2024, 1, 2), date(2024, 1, 3)]
