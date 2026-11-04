"""同步编排 × ODS 导出：因子归一化、停牌证据、断点续跑不产生缺口。"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

from market_ingest.adapters.tushare import transport as ts_transport
from market_ingest.adapters.tushare.adapter import create_adapter
from market_ingest.quota import QuotaGuard, QuotaPolicy
from market_ingest.storage import SqliteStorage
from market_ingest.sync import BarsSyncService, SyncRequest
from support import FIXED_NOW, FakeClock, bar_row, calendar_entry, daily_entry, factor_entry, factor_row, suspend_entry

START = date(2024, 1, 1)
END = date(2024, 1, 4)
ANCHOR_START = date(1990, 12, 19)
TODAY = FIXED_NOW.date()


def _service(entries, storage: SqliteStorage, ods_root, *, budget: int | None = None):
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
    service = BarsSyncService(adapter, storage, guard=guard, clock=clock, ods_root=ods_root)
    return service, guard


def _anchor_entry():
    return factor_entry(
        "600519.SH", ANCHOR_START, TODAY, [factor_row(date(2020, 1, 2), adj_factor="2.0")]
    )


def test_full_chain_writes_bar_and_factor_batches_with_suspension_evidence(tmp_path) -> None:
    ods_root = tmp_path / "ods"
    entries = [
        _anchor_entry(),
        factor_entry(
            "600519.SH",
            START,
            END,
            [factor_row(date(2024, 1, 2), adj_factor="4.0"), factor_row(date(2024, 1, 3), adj_factor="4.0")],
        ),
        calendar_entry(START, END, [date(2024, 1, 2), date(2024, 1, 3)]),
        daily_entry("600519.SH", START, END, [bar_row(date(2024, 1, 2))]),
        suspend_entry(date(2024, 1, 3), ["600519.SH"]),
    ]
    with SqliteStorage(tmp_path / "ingest.db") as storage:
        service, guard = _service(entries, storage, ods_root, budget=10)
        result = service.sync(SyncRequest(("SSE:600519",), START, END, chunk_days=8766))

        assert result.status == "succeeded"
        assert result.rows_ingested == 1
        assert result.factor_rows == 2
        assert result.suspended_rows == 1
        assert result.ods_batches == 2
        assert result.chunks_done == 1
        assert guard.run_calls == 5  # calendar + anchor + factor窗口 + daily + suspend
        assert storage.get_factor_anchor("SSE:600519") == (date(2020, 1, 2), Decimal("2.0"))

        bar_files = sorted((ods_root / "bar").glob("dt=*/**/*.json"))
        bar_files = sorted((ods_root / "bar").rglob("*.json"))
        assert len(bar_files) == 1
        bar_payload = json.loads(bar_files[0].read_text(encoding="utf-8"))
        assert bar_payload["schema"] == "bar.v1"
        assert bar_payload["rows_total"] == 2
        assert [row["trade_date"] for row in bar_payload["rows"]] == ["2024-01-02", "2024-01-03"]
        assert bar_payload["rows"][0]["prev_close"] == "10.2"  # bar_row 的 pre_close 原样映射
        assert bar_payload["rows"][1] == {"instrument_id": "SSE:600519", "trade_date": "2024-01-03", "suspended": True}

        factor_files = sorted((ods_root / "adj_factor").rglob("*.json"))
        assert len(factor_files) == 1
        factor_payload = json.loads(factor_files[0].read_text(encoding="utf-8"))
        assert factor_payload["schema"] == "adj_factor.v1"
        assert [row["factor"] for row in factor_payload["rows"]] == ["2.000000", "2.000000"]

        datasets = {page["dataset"] for page in storage.iter_raw_pages()}
        assert datasets == {"bars", "adj_factor", "calendar", "suspensions"}


def test_resume_writes_only_remaining_chunk_and_no_gap(tmp_path) -> None:
    ods_root = tmp_path / "ods"
    first_entries = [
        _anchor_entry(),
        factor_entry("600519.SH", START, END, [factor_row(date(2024, 1, 2), adj_factor="2.0")]),
        calendar_entry(START, END, [date(2024, 1, 2), date(2024, 1, 3)]),
        daily_entry("600519.SH", START, date(2024, 1, 2), [bar_row(date(2024, 1, 2))]),
    ]
    with SqliteStorage(tmp_path / "ingest.db") as storage:
        service, _ = _service(first_entries, storage, ods_root, budget=10)
        checks = {"n": 0}

        def interrupt() -> bool:
            checks["n"] += 1
            return checks["n"] > 1

        first = service.sync(SyncRequest(("SSE:600519",), START, END, chunk_days=2), interrupt=interrupt)
        assert first.status == "interrupted"
        assert first.chunks_done == 1
        assert storage.get_checkpoint("bars", "SSE:600519") == date(2024, 1, 2)
        assert len(list((ods_root / "bar").rglob("*.json"))) == 1

        second_entries = [
            calendar_entry(START, END, [date(2024, 1, 2), date(2024, 1, 3)]),
            factor_entry(
                "600519.SH", date(2024, 1, 3), END, [factor_row(date(2024, 1, 3), adj_factor="2.0")]
            ),
            daily_entry("600519.SH", date(2024, 1, 3), END, [bar_row(date(2024, 1, 4))]),
            suspend_entry(date(2024, 1, 3), ["600519.SH"]),
        ]
        service2, guard2 = _service(second_entries, storage, ods_root, budget=10)
        second = service2.sync(SyncRequest(("SSE:600519",), START, END, chunk_days=2))

        assert second.status == "succeeded"
        assert second.rows_ingested == 1
        assert second.suspended_rows == 1
        assert guard2.run_calls == 4  # calendar + factor + daily + suspend（anchor 已缓存，不再抓）
        bar_files = sorted((ods_root / "bar").rglob("*.json"))
        assert len(bar_files) == 2
        payloads = [json.loads(path.read_text(encoding="utf-8")) for path in bar_files]
        dates = sorted(row["trade_date"] for payload in payloads for row in payload["rows"])
        assert dates == ["2024-01-02", "2024-01-03", "2024-01-04"]  # 已完成块未重复、未缺口
        assert any(row.get("suspended") is True for payload in payloads for row in payload["rows"])
