"""限流 + 配额守卫单测（80% 预留、预算、台账持久化）。"""

from __future__ import annotations

import sqlite3

import pytest

from market_ingest.ports import QuotaExhaustedError
from market_ingest.quota import InMemoryCallLedger, QuotaGuard, QuotaPolicy
from market_ingest.storage import SqliteStorage
from support import FakeClock


def test_effective_rate_reserves_twenty_percent() -> None:
    policy = QuotaPolicy(calls_per_minute=10, reserve_ratio=0.2)
    assert policy.effective_calls_per_minute == 8
    assert policy.min_interval_s == 7.5


def test_acquire_throttles_between_calls() -> None:
    clock = FakeClock()
    guard = QuotaGuard(QuotaPolicy(calls_per_minute=10), InMemoryCallLedger(), clock=clock, sleep=clock.sleep)
    for _ in range(3):
        guard.acquire()
    assert clock.slept_s == pytest.approx(15.0)  # 2 个间隔 × 7.5s
    assert guard.run_calls == 3


def test_period_cap_uses_reserve() -> None:
    clock = FakeClock()
    ledger = InMemoryCallLedger()
    guard = QuotaGuard(
        QuotaPolicy(calls_per_minute=60000, period_cap_calls=10),
        ledger,
        clock=clock,
        sleep=clock.sleep,
    )
    for _ in range(8):  # 10 × 80% = 8
        guard.acquire()
    assert ledger.get_calls("20240105") == 8
    with pytest.raises(QuotaExhaustedError, match="daily quota reserve"):
        guard.acquire()


def test_run_budget_exhausted_does_not_sleep_more() -> None:
    clock = FakeClock()
    guard = QuotaGuard(
        QuotaPolicy(calls_per_minute=10, run_budget_calls=2),
        InMemoryCallLedger(),
        clock=clock,
        sleep=clock.sleep,
    )
    guard.acquire()
    guard.acquire()
    slept = clock.slept_s
    with pytest.raises(QuotaExhaustedError, match="run budget"):
        guard.acquire()
    assert clock.slept_s == slept
    assert guard.remaining_run_budget == 0


def test_quota_error_is_not_retryable() -> None:
    assert QuotaExhaustedError("x").retryable is False


def test_sqlite_ledger_persists_across_guards(tmp_path) -> None:
    path = tmp_path / "quota.db"
    with SqliteStorage(path) as storage:
        clock = FakeClock()
        first = QuotaGuard(QuotaPolicy(calls_per_minute=60000, period_cap_calls=10), storage, clock=clock, sleep=clock.sleep)
        first.acquire()
        second = QuotaGuard(QuotaPolicy(calls_per_minute=60000, period_cap_calls=10), storage, clock=clock, sleep=clock.sleep)
        assert second.remaining_run_budget is None
        second.acquire()
        assert storage.get_calls("20240105") == 2


def test_sqlite_ledger_is_append_only_by_api(tmp_path) -> None:
    with SqliteStorage(tmp_path / "q.db") as storage:
        storage.add_calls("20240105", 3, FakeClock()())
        storage.add_calls("20240105", 2, FakeClock()())
        assert storage.get_calls("20240105") == 5
        with pytest.raises(sqlite3.Error):
            storage.connection.execute("DELETE FROM quota_ledger")
