"""存储层单测：raw 不可变、幂等重放、checkpoint、DLQ。"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime

import pytest

from market_ingest.ports import RawPage, RejectedRow
from market_ingest.storage import SqliteStorage
from support import FIXED_NOW


def _page(rows: list[dict[str, object]] | None = None) -> RawPage:
    return RawPage(
        dataset="bars",
        endpoint="daily",
        request_params={"symbol": "X", "start": "20240101"},
        rows=tuple(rows or [{"d": "20240102", "c": "10.0"}]),
        source="test-source",
        as_of=None,
        fetched_at=FIXED_NOW,
    )


def test_raw_page_append_is_idempotent(tmp_path) -> None:
    with SqliteStorage(tmp_path / "s.db") as storage:
        storage.create_batch("b1", "bars", "test-adapter", FIXED_NOW)
        assert storage.append_raw_page("b1", _page(), created_at=FIXED_NOW) is True
        assert storage.append_raw_page("b1", _page(), created_at=FIXED_NOW) is False
        pages = list(storage.iter_raw_pages(dataset="bars"))
        assert len(pages) == 1
        assert pages[0]["payload"][0]["d"] == "20240102"


def test_raw_page_is_immutable(tmp_path) -> None:
    with SqliteStorage(tmp_path / "s.db") as storage:
        storage.create_batch("b1", "bars", "test-adapter", FIXED_NOW)
        storage.append_raw_page("b1", _page(), created_at=FIXED_NOW)
        with pytest.raises(sqlite3.IntegrityError):
            storage.connection.execute("UPDATE ods_raw_page SET source = 'tampered'")
        with pytest.raises(sqlite3.IntegrityError):
            storage.connection.execute("DELETE FROM ods_raw_page")


def test_rejected_rows_are_kept_and_immutable(tmp_path) -> None:
    with SqliteStorage(tmp_path / "s.db") as storage:
        storage.create_batch("b1", "bars", "test-adapter", FIXED_NOW)
        storage.append_rejected(
            "b1",
            RejectedRow(dataset="bars", endpoint="daily", reason="bad close", payload={"c": "0"}),
            created_at=FIXED_NOW,
        )
        assert storage.count_rejected("b1") == 1
        with pytest.raises(sqlite3.IntegrityError):
            storage.connection.execute("DELETE FROM ods_rejected_row")


def test_checkpoint_upsert_and_batch_lifecycle(tmp_path) -> None:
    with SqliteStorage(tmp_path / "s.db") as storage:
        assert storage.get_checkpoint("bars", "SSE:600519") is None
        storage.create_batch("b1", "bars", "test-adapter", FIXED_NOW)
        storage.set_checkpoint("bars", "SSE:600519", date(2024, 1, 2), "b1", FIXED_NOW)
        storage.set_checkpoint("bars", "SSE:600519", date(2024, 1, 3), "b1", FIXED_NOW)
        assert storage.get_checkpoint("bars", "SSE:600519") == date(2024, 1, 3)

        storage.finish_batch(
            "b1",
            finished_at=FIXED_NOW,
            status="succeeded",
            row_count=2,
            rejected_count=0,
            note=None,
        )
        batch = storage.get_batch("b1")
        assert batch is not None
        assert batch.status == "succeeded"
        assert batch.row_count == 2

        storage.create_batch("b2", "bars", "test-adapter", FIXED_NOW)
        with pytest.raises(ValueError):
            storage.finish_batch(
                "b2",
                finished_at=FIXED_NOW,
                status="done",
                row_count=0,
                rejected_count=0,
            )


def test_market_tz_is_enforced_on_timestamps(tmp_path) -> None:
    with SqliteStorage(tmp_path / "s.db") as storage:
        storage.create_batch("b1", "bars", "test-adapter", FIXED_NOW)
        with pytest.raises(ValueError):
            storage.append_raw_page(
                "b1",
                RawPage(
                    dataset="bars",
                    endpoint="daily",
                    request_params={},
                    rows=(),
                    source="test-source",
                    as_of=None,
                    fetched_at=datetime(2024, 1, 2, 12, 0, 0),
                ),
                created_at=FIXED_NOW,
            )
