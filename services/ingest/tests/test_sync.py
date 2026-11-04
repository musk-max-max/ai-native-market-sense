"""同步编排单测：全链路、断点续跑、中断、配额中断、DLQ 计数。"""

from __future__ import annotations

from datetime import date, timedelta

from market_ingest.adapters.tushare import transport as ts_transport
from market_ingest.adapters.tushare.adapter import create_adapter
from market_ingest.quota import QuotaGuard, QuotaPolicy
from market_ingest.storage import SqliteStorage
from market_ingest.sync import BarsSyncService, SyncRequest, estimate_calls, iter_chunks
from support import FakeClock, bar_row, daily_entry, entries_for_chunks

START = date(2024, 1, 1)
END = date(2024, 1, 4)


def _service(entries, storage: SqliteStorage, *, budget: int | None = None):
    clock = FakeClock()
    guard = QuotaGuard(
        QuotaPolicy(calls_per_minute=60000, reserve_ratio=0.0, run_budget_calls=budget),
        storage,
        clock=clock,
        sleep=clock.sleep,
    )
    adapter = create_adapter(
        {},
        transport=ts_transport.ReplayTransport(entries),
        guard=guard,
        ledger=storage,
        clock=clock,
        sleep=clock.sleep,
    )
    service = BarsSyncService(adapter, storage, guard=guard, clock=clock)
    return service, guard


def test_full_chain_lands_raw_and_checkpoint(tmp_path) -> None:
    rows = {date(2024, 1, 2): bar_row(date(2024, 1, 2)), date(2024, 1, 3): bar_row(date(2024, 1, 3))}
    with SqliteStorage(tmp_path / "ingest.db") as storage:
        service, _ = _service(entries_for_chunks("600519.SH", START, END, 366, rows), storage)
        result = service.sync(SyncRequest(("SSE:600519",), START, END, chunk_days=366))

        assert result.status == "succeeded"
        assert result.rows_ingested == 2
        assert result.rejected_rows == 0
        assert result.chunks_done == 1
        assert result.calls_used == 1
        assert result.checkpoint_scopes == {"SSE:600519": "2024-01-04"}
        assert storage.get_checkpoint("bars", "SSE:600519") == END

        pages = list(storage.iter_raw_pages(dataset="bars"))
        assert len(pages) == 1
        assert len(pages[0]["payload"]) == 2
        assert pages[0]["payload"][0]["ts_code"] == "600519.SH"

        batch = storage.get_batch(result.batch_id)
        assert batch is not None and batch.status == "succeeded" and batch.row_count == 2


def test_interrupt_then_resume_from_checkpoint(tmp_path) -> None:
    rows = {date(2024, 1, 2): bar_row(date(2024, 1, 2)), date(2024, 1, 3): bar_row(date(2024, 1, 3))}
    entries = entries_for_chunks("600519.SH", START, END, 2, rows)
    with SqliteStorage(tmp_path / "ingest.db") as storage:
        service, _ = _service(entries, storage)
        checks = {"n": 0}

        def interrupt() -> bool:
            checks["n"] += 1
            return checks["n"] > 1  # 第一个 chunk 完成后置位

        first = service.sync(SyncRequest(("SSE:600519",), START, END, chunk_days=2), interrupt=interrupt)
        assert first.status == "interrupted"
        assert first.halted_reason == "interrupt_signal"
        assert first.chunks_done == 1
        assert first.rows_ingested == 1
        assert storage.get_checkpoint("bars", "SSE:600519") == date(2024, 1, 2)

        # 续跑：同一个数据库，只提供剩余 chunk 的夹具；不应重复抓已完成区间。
        remaining = [daily_entry("600519.SH", date(2024, 1, 3), END, [rows[date(2024, 1, 3)]])]
        service2, _ = _service(remaining, storage)
        second = service2.sync(SyncRequest(("SSE:600519",), START, END, chunk_days=2))
        assert second.status == "succeeded"
        assert second.rows_ingested == 1
        assert second.calls_used == 1
        assert storage.get_checkpoint("bars", "SSE:600519") == END


def test_completed_range_is_skipped_without_calls(tmp_path) -> None:
    rows = {date(2024, 1, 2): bar_row(date(2024, 1, 2))}
    with SqliteStorage(tmp_path / "ingest.db") as storage:
        service, _ = _service(entries_for_chunks("600519.SH", START, END, 366, rows), storage)
        assert service.sync(SyncRequest(("SSE:600519",), START, END)).status == "succeeded"

        service2, _ = _service([], storage)  # 无夹具：一旦发起调用就会 FixtureMiss
        again = service2.sync(SyncRequest(("SSE:600519",), START, END))
        assert again.status == "succeeded"
        assert again.instruments_skipped == 1
        assert again.calls_used == 0


def test_quota_exhaustion_stops_and_keeps_checkpoint(tmp_path) -> None:
    rows = {date(2024, 1, 2): bar_row(date(2024, 1, 2))}
    entries = entries_for_chunks("600519.SH", START, END, 366, rows) + entries_for_chunks(
        "000001.SZ", START, END, 366, {date(2024, 1, 2): bar_row(date(2024, 1, 2), ts_code="000001.SZ")}
    )
    with SqliteStorage(tmp_path / "ingest.db") as storage:
        service, _ = _service(entries, storage, budget=1)
        result = service.sync(SyncRequest(("SSE:600519", "SZSE:000001"), START, END))

        assert result.status == "interrupted"
        assert result.halted_reason == "quota_exhausted"
        assert result.instruments_completed == 1
        assert result.calls_used == 1
        assert storage.get_checkpoint("bars", "SSE:600519") == END
        assert storage.get_checkpoint("bars", "SZSE:000001") is None


def test_rejected_rows_are_counted_not_dropped(tmp_path) -> None:
    bad = {**bar_row(date(2024, 1, 2)), "close": "0"}
    rows = {date(2024, 1, 2): bar_row(date(2024, 1, 2)), date(2024, 1, 3): bad}
    with SqliteStorage(tmp_path / "ingest.db") as storage:
        service, _ = _service(entries_for_chunks("600519.SH", START, END, 366, rows), storage)
        result = service.sync(SyncRequest(("SSE:600519",), START, END))
        assert result.status == "succeeded"
        assert result.rows_ingested == 1
        assert result.rejected_rows == 1
        assert storage.count_rejected(result.batch_id) == 1


def test_planning_helpers() -> None:
    chunks = list(iter_chunks(date(2024, 1, 1), date(2024, 3, 1), 30))
    assert chunks[0][0] == date(2024, 1, 1)
    assert chunks[-1][1] == date(2024, 3, 1)
    assert all((end - start).days <= 29 for start, end in chunks)
    assert (
        estimate_calls(1, date(2005, 1, 1), date(2024, 12, 31), chunk_days=366, page_limit=6000)
        == len(list(iter_chunks(date(2005, 1, 1), date(2024, 12, 31), 366)))
    )


def test_chunk_end_truncation_single_day() -> None:
    day = date(2024, 1, 2)
    assert list(iter_chunks(day, day + timedelta(days=1), 1)) == [(day, day), (day + timedelta(days=1), day + timedelta(days=1))]
