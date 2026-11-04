"""market-wide（L11/L12）：adapter 市场级抽取 + sync 按交易日模式 + CLI 预算。"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path

from market_ingest.adapters.tushare import transport as ts_transport
from market_ingest.adapters.tushare.adapter import ANCHOR_START, create_adapter
from market_ingest.cli import main as cli_main
from market_ingest.models import market_close_at
from market_ingest.quota import InMemoryCallLedger, QuotaGuard, QuotaPolicy
from market_ingest.storage import SqliteStorage
from market_ingest.sync import BarsSyncService, SyncRequest, estimate_market_plan
from support import (
    FIXED_NOW,
    FakeClock,
    bar_row,
    calendar_entry,
    factor_entry,
    factor_row,
    market_daily_entry,
    market_factor_entry,
    suspend_entry,
)

DAY1 = date(2024, 1, 2)
DAY2 = date(2024, 1, 3)
DAY3 = date(2024, 1, 4)
START = DAY1
END = DAY3
TODAY = FIXED_NOW.date()


def _clock_guard() -> tuple[FakeClock, QuotaGuard]:
    clock = FakeClock()
    guard = QuotaGuard(
        QuotaPolicy(calls_per_minute=60000, reserve_ratio=0.0),
        InMemoryCallLedger(),
        clock=clock,
        sleep=clock.sleep,
    )
    return clock, guard


def _adapter(entries):
    clock, guard = _clock_guard()
    adapter = create_adapter(
        {}, transport=ts_transport.ReplayTransport(entries), guard=guard, clock=clock, sleep=clock.sleep
    )
    return adapter, guard


def _anchor_entries() -> list[dict[str, object]]:
    return [
        factor_entry(
            "600519.SH",
            ANCHOR_START,
            TODAY,
            [factor_row(date(2020, 1, 2), ts_code="600519.SH", adj_factor="2.0")],
        ),
        factor_entry(
            "000001.SZ",
            ANCHOR_START,
            TODAY,
            [factor_row(date(2010, 1, 4), ts_code="000001.SZ", adj_factor="1.5")],
        ),
    ]


def _market_entries() -> list[dict[str, object]]:
    return [
        calendar_entry(START, END, [DAY1, DAY2, DAY3]),
        market_daily_entry(
            DAY1,
            [
                bar_row(DAY1, ts_code="600519.SH"),
                bar_row(DAY1, ts_code="000001.SZ", open="12.0", high="12.6", low="11.8", close="12.2"),
            ],
        ),
        market_factor_entry(
            DAY1,
            [
                factor_row(DAY1, ts_code="600519.SH", adj_factor="4.0"),
                factor_row(DAY1, ts_code="000001.SZ", adj_factor="3.0"),
            ],
        ),
        suspend_entry(DAY1, []),
        market_daily_entry(
            DAY2,
            [bar_row(DAY2, ts_code="000001.SZ", open="12.2", high="12.8", low="12.0", close="12.5")],
        ),
        market_factor_entry(
            DAY2,
            [
                factor_row(DAY2, ts_code="600519.SH", adj_factor="4.0"),
                factor_row(DAY2, ts_code="000001.SZ", adj_factor="3.0"),
            ],
        ),
        suspend_entry(DAY2, ["600519.SH"]),
        market_daily_entry(
            DAY3,
            [
                bar_row(DAY3, ts_code="600519.SH"),
                bar_row(DAY3, ts_code="000001.SZ", open="12.5", high="13.0", low="12.3", close="12.8"),
            ],
        ),
        market_factor_entry(
            DAY3,
            [
                factor_row(DAY3, ts_code="600519.SH", adj_factor="4.0"),
                factor_row(DAY3, ts_code="000001.SZ", adj_factor="3.0"),
            ],
        ),
        suspend_entry(DAY3, []),
    ]


# ---------- adapter：市场级抽取 ----------


def test_fetch_market_snapshot_maps_all_instruments() -> None:
    adapter, guard = _adapter(
        [
            market_daily_entry(
                DAY1,
                [
                    bar_row(DAY1, ts_code="600519.SH"),
                    bar_row(DAY1, ts_code="000001.SZ", open="12.0", high="12.6", low="11.8", close="12.2"),
                ],
            )
        ]
    )
    bars = adapter.fetch_market_snapshot(DAY1)

    assert [bar.instrument_id for bar in bars] == ["SSE:600519", "SZSE:000001"]
    assert bars[0].volume == 1000 * 100  # 手 → 股
    assert bars[0].source.as_of == market_close_at(DAY1)
    assert bars[1].source.as_of == market_close_at(DAY1)
    assert guard.run_calls == 1  # 全市场 1 页 = 1 次调用


def test_fetch_market_snapshot_rejects_bad_rows() -> None:
    rejected: list[object] = []
    good = bar_row(DAY1, ts_code="600519.SH")
    bad_code = {**good, "ts_code": "BROKEN"}
    bad_price = {**good, "ts_code": "000001.SZ", "close": "0"}
    adapter, _ = _adapter([market_daily_entry(DAY1, [good, bad_code, bad_price])])

    with adapter.capture(None, rejected.append):
        bars = adapter.fetch_market_snapshot(DAY1)

    assert [bar.instrument_id for bar in bars] == ["SSE:600519"]
    assert len(rejected) == 2


def test_fetch_market_factors_normalizes_with_anchors() -> None:
    adapter, _ = _adapter(
        [
            market_factor_entry(
                DAY1,
                [
                    factor_row(DAY1, ts_code="600519.SH", adj_factor="4.0"),
                    factor_row(DAY1, ts_code="000001.SZ", adj_factor="3.0"),
                ],
            )
        ]
    )
    anchors = {"SSE:600519": Decimal("2.0"), "SZSE:000001": Decimal("1.5")}
    records = adapter.fetch_market_factors(DAY1, anchors=anchors)

    assert [(r.instrument_id, r.factor) for r in records] == [
        ("SSE:600519", Decimal("2.0")),
        ("SZSE:000001", Decimal("2.0")),
    ]
    assert records[0].source.as_of == market_close_at(DAY1)


def test_fetch_market_factors_missing_anchor_goes_to_dlq() -> None:
    rejected: list[object] = []
    adapter, _ = _adapter(
        [market_factor_entry(DAY1, [factor_row(DAY1, ts_code="600519.SH", adj_factor="4.0")])]
    )
    with adapter.capture(None, rejected.append):
        records = adapter.fetch_market_factors(DAY1, anchors={})

    assert records == []
    assert len(rejected) == 1


def test_fetch_market_suspensions_returns_full_day_list() -> None:
    adapter, guard = _adapter([suspend_entry(DAY1, ["600519.SH", "000001.SZ"])])
    records = adapter.fetch_market_suspensions(DAY1)

    assert [record.instrument_id for record in records] == ["SSE:600519", "SZSE:000001"]
    assert all(record.trade_date == DAY1 for record in records)
    assert guard.run_calls == 1


# ---------- sync：market-wide 全链路 ----------


def _service(entries, storage: SqliteStorage, ods_root: Path):
    clock, guard = _clock_guard()
    adapter = create_adapter(
        {}, transport=ts_transport.ReplayTransport(entries), guard=guard, clock=clock, sleep=clock.sleep
    )
    service = BarsSyncService(adapter, storage, guard=guard, clock=clock, ods_root=ods_root)
    return service, guard


def _market_request() -> SyncRequest:
    return SyncRequest(instruments=(), start=START, end=END, market_wide=True)


def test_market_sync_writes_daily_batches_and_checkpoint(tmp_path: Path) -> None:
    storage = SqliteStorage(":memory:")
    ods_root = tmp_path / "ods"
    service, guard = _service(_market_entries() + _anchor_entries(), storage, ods_root)

    result = service.sync(_market_request())

    assert result.status == "succeeded"
    assert result.chunks_done == 3
    assert result.rows_ingested == 5
    assert result.factor_rows == 6
    assert result.suspended_rows == 1
    assert result.ods_batches == 6  # 3 日 × (bar + factor)
    assert result.checkpoint_scopes == {"market": DAY3.isoformat()}
    assert storage.get_checkpoint("bars", "market") == DAY3
    # 1 次日历 + 2 次锚点 + 3 日 × 3 次
    assert guard.run_calls == 12

    bar_files = sorted((ods_root / "bar").glob("dt=*/*.json"))
    factor_files = sorted((ods_root / "adj_factor").glob("dt=*/*.json"))
    assert len(bar_files) == 3
    assert len(factor_files) == 3

    day2 = next(path for path in bar_files if "dt=2024-01-03" in str(path))
    payload = json.loads(day2.read_text(encoding="utf-8"))
    assert payload["schema"] == "bar.v1"
    assert payload["rows_total"] == 2  # 1 bar + 1 停牌证据行
    assert any(row.get("suspended") is True for row in payload["rows"])
    assert all("ts_code" not in row for row in payload["rows"])


def test_market_sync_resumes_from_day_checkpoint(tmp_path: Path) -> None:
    storage = SqliteStorage(":memory:")
    ods_root = tmp_path / "ods"
    request = _market_request()
    first_run_entries = [
        calendar_entry(START, END, [DAY1, DAY2, DAY3]),
        market_daily_entry(
            DAY1,
            [
                bar_row(DAY1, ts_code="600519.SH"),
                bar_row(DAY1, ts_code="000001.SZ", open="12.0", high="12.6", low="11.8", close="12.2"),
            ],
        ),
        market_factor_entry(
            DAY1,
            [
                factor_row(DAY1, ts_code="600519.SH", adj_factor="4.0"),
                factor_row(DAY1, ts_code="000001.SZ", adj_factor="3.0"),
            ],
        ),
        suspend_entry(DAY1, []),
    ] + _anchor_entries()
    service, _ = _service(first_run_entries, storage, ods_root)

    checks = {"calls": 0}

    def interrupt() -> bool:
        checks["calls"] += 1
        return checks["calls"] > 1  # 跑完第 1 天后再停

    first = service.sync(request, interrupt=interrupt)

    assert first.status == "interrupted"
    assert first.halted_reason == "interrupt_signal"
    assert first.chunks_done == 1
    assert storage.get_checkpoint("bars", "market") == DAY1

    second_entries = [
        calendar_entry(START, END, [DAY1, DAY2, DAY3]),
        market_daily_entry(
            DAY2,
            [bar_row(DAY2, ts_code="000001.SZ", open="12.2", high="12.8", low="12.0", close="12.5")],
        ),
        market_factor_entry(
            DAY2,
            [
                factor_row(DAY2, ts_code="600519.SH", adj_factor="4.0"),
                factor_row(DAY2, ts_code="000001.SZ", adj_factor="3.0"),
            ],
        ),
        suspend_entry(DAY2, ["600519.SH"]),
        market_daily_entry(
            DAY3,
            [
                bar_row(DAY3, ts_code="600519.SH"),
                bar_row(DAY3, ts_code="000001.SZ", open="12.5", high="13.0", low="12.3", close="12.8"),
            ],
        ),
        market_factor_entry(
            DAY3,
            [
                factor_row(DAY3, ts_code="600519.SH", adj_factor="4.0"),
                factor_row(DAY3, ts_code="000001.SZ", adj_factor="3.0"),
            ],
        ),
        suspend_entry(DAY3, []),
    ]
    service2, guard2 = _service(second_entries, storage, ods_root)
    second = service2.sync(request)

    assert second.status == "succeeded"
    assert second.chunks_done == 2
    assert second.rows_ingested == 3
    assert storage.get_checkpoint("bars", "market") == DAY3
    assert guard2.run_calls == 7  # 日历 1 + 剩余 2 日 × 3 次；锚点走 SQLite 缓存不再消耗
    bar_files = sorted((ods_root / "bar").glob("dt=*/*.json"))
    assert len(bar_files) == 3  # 两轮合计 3 个交易日，无重复/缺口


# ---------- 预算与 CLI ----------


def test_estimate_market_plan_matches_approved_budget() -> None:
    plan = estimate_market_plan(date(2005, 1, 1), date(2025, 12, 31))

    assert plan["trading_days"] == 5093
    assert plan["calls_per_trading_day"] == 3
    assert plan["total_calls"] == 15280
    assert plan["eta_minutes"] == 39
    assert plan["effective_calls_per_minute"] == 400


def test_cli_omitted_instruments_defaults_to_market_wide(capsys) -> None:
    code = cli_main(["sync-bars", "--start", "2024-01-02", "--end", "2024-01-02", "--dry-run"])

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "market_wide"
    assert payload["budget"]["total_calls"] == 4  # 1 个交易日 × 3 + 日历 1 次


def test_cli_instruments_selects_per_instrument_mode(capsys) -> None:
    code = cli_main(
        ["sync-bars", "--instruments", "SSE:600519", "--start", "2024-01-02", "--end", "2024-01-04", "--dry-run"]
    )

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "per_instrument"
    assert payload["instruments"] == ["SSE:600519"]
