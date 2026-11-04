"""主数据 / 最小财务批次（L16/L17）：mapper → adapter → ODS → sync → CLI。

覆盖 lead 在 L16/L17 拍板的两项：
- ``instrument.v1``：一次 ``stock_basic`` 全量在册（9 字段，主板/科创/创业/北交所推导）；
- ``fundamental.v1``：切片标的最近一期财务摘要（每标的 2 次调用，无数据不产行 = 404）。
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from market_ingest import ods
from market_ingest.adapters.tushare import mapper
from market_ingest.adapters.tushare import transport as ts_transport
from market_ingest.adapters.tushare.adapter import create_adapter
from market_ingest.cli import main as cli_main
from market_ingest.models import (
    AdjType,
    Board,
    ExchangeCode,
    ListStatus,
    SecurityType,
    SourceRef,
    market_close_at,
)
from market_ingest.ports import RawPage, RejectedRow
from market_ingest.quota import InMemoryCallLedger, QuotaGuard, QuotaPolicy
from market_ingest.storage import SqliteStorage
from market_ingest.sync import sync_fundamentals, sync_instrument_master
from support import (
    FIXED_NOW,
    FakeClock,
    fina_entry,
    fina_row,
    income_entry,
    income_row,
    stock_basic_entry,
    stock_basic_row,
)

SOURCE = SourceRef(source="tushare", as_of=market_close_at(date(2024, 1, 5)), fetched_at=FIXED_NOW)


def _guard(clock: FakeClock) -> QuotaGuard:
    return QuotaGuard(
        QuotaPolicy(calls_per_minute=60000, reserve_ratio=0.0),
        InMemoryCallLedger(),
        clock=clock,
        sleep=clock.sleep,
    )


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


# ---------- mapper：板块/手数推导与主数据行 ----------


def test_board_and_lot_size_are_derived_from_code() -> None:
    assert mapper.board_for_code(ExchangeCode.SSE, "600519") is Board.MAIN
    assert mapper.board_for_code(ExchangeCode.SSE, "688001") is Board.STAR
    assert mapper.board_for_code(ExchangeCode.SZSE, "000001") is Board.MAIN
    assert mapper.board_for_code(ExchangeCode.SZSE, "300750") is Board.GEM
    assert mapper.board_for_code(ExchangeCode.SSE, "689009") is Board.STAR
    assert mapper.board_for_code(ExchangeCode.SZSE, "301001") is Board.GEM
    assert mapper.board_for_code(ExchangeCode.BSE, "830799") is Board.BSE
    assert mapper.lot_size_for_code(ExchangeCode.SSE, "688001") == 200
    assert mapper.lot_size_for_code(ExchangeCode.SSE, "600519") == 100


def test_map_instrument_row_canonical_fields() -> None:
    row = stock_basic_row("600519.SH", "贵州茅台")
    record = mapper.map_instrument_row(row, source=SOURCE)
    assert record.instrument_id == "SSE:600519"
    assert record.exchange is ExchangeCode.SSE
    assert record.code == "600519"
    assert record.name == "贵州茅台"
    assert record.board is Board.MAIN
    assert record.security_type is SecurityType.STOCK
    assert record.list_status is ListStatus.LISTED
    assert record.lot_size == 100
    assert record.listed_at == date(2001, 8, 27)


def test_map_instrument_row_status_and_optional_list_date() -> None:
    pre = stock_basic_row("688001.SH", "华兴源创", list_status="P", list_date="")
    record = mapper.map_instrument_row(pre, source=SOURCE)
    assert record.list_status is ListStatus.PRE_LISTED
    assert record.listed_at is None
    assert record.board is Board.STAR
    assert record.lot_size == 200


def test_map_instrument_row_rejects_missing_name_or_unknown_status() -> None:
    bad_name = dict(stock_basic_row("600519.SH", "贵州茅台"), name="")
    with pytest.raises(mapper.RowMapError):
        mapper.map_instrument_row(bad_name, source=SOURCE)
    bad_status = dict(stock_basic_row("600519.SH", "贵州茅台"), list_status="X")
    with pytest.raises(mapper.RowMapError):
        mapper.map_instrument_row(bad_status, source=SOURCE)


# ---------- mapper：财务摘要 ----------


def test_parse_report_period_requires_quarter_end() -> None:
    assert mapper.parse_report_period(date(2024, 3, 31)) == "2024Q1"
    assert mapper.parse_report_period(date(2024, 6, 30)) == "2024Q2"
    assert mapper.parse_report_period(date(2024, 9, 30)) == "2024Q3"
    assert mapper.parse_report_period(date(2024, 12, 31)) == "2024Q4"
    with pytest.raises(mapper.RowMapError):
        mapper.parse_report_period(date(2024, 5, 31))


def test_build_fundamental_record_joins_income_and_ratios() -> None:
    end = date(2024, 9, 30)
    fina = fina_row(date(2024, 10, 25), end, eps="1.5", roe="12.5")
    income = income_row(
        date(2024, 10, 25), end, total_revenue="123000000.0", n_income_attr_p="-5000000.0"
    )
    record = mapper.build_fundamental_record(
        instrument_id="SSE:600519", fina_row=fina, income_row=income, source=SOURCE
    )
    assert record.report_period == "2024Q3"
    assert record.report_end_date == end
    assert record.announced_at.isoformat() == "2024-10-25T15:00:00+08:00"
    assert record.statement_basis == "reported"
    assert record.currency == "CNY"
    assert record.revenue == Decimal("123000000.0")
    assert record.net_profit == Decimal("-5000000.0")
    assert record.eps == Decimal("1.5")
    assert record.roe_pct == Decimal("12.5")
    assert record.gross_margin_pct == Decimal("45.0")
    assert record.revenue_yoy_pct == Decimal("10.0")
    assert record.net_profit_yoy_pct == Decimal("8.0")


def test_build_fundamental_record_rejects_mismatched_end_date() -> None:
    with pytest.raises(mapper.RowMapError):
        mapper.build_fundamental_record(
            instrument_id="SSE:600519",
            fina_row=fina_row(date(2024, 10, 25), date(2024, 9, 30)),
            income_row=income_row(date(2024, 10, 25), date(2024, 6, 30)),
            source=SOURCE,
        )


# ---------- adapter：主数据 ----------


def test_fetch_instruments_maps_and_rejects_bad_rows() -> None:
    rows = [
        stock_basic_row("600519.SH", "贵州茅台"),
        stock_basic_row("000001.SZ", "平安银行", list_date="19910403", exchange="SZSE"),
        stock_basic_row("830799.BJ", "艾融软件", list_date="20200727", exchange="BSE"),
        dict(stock_basic_row("600000.SH", "", list_date="19991110")),
    ]
    rejects: list[RejectedRow] = []
    adapter, guard = _adapter([stock_basic_entry(rows)])
    adapter.capture(None, rejects.append)  # type: ignore[attr-defined]
    with adapter.capture(None, rejects.append):  # type: ignore[attr-defined]
        records = adapter.fetch_instruments()  # type: ignore[attr-defined]
    assert [r.instrument_id for r in records] == ["BSE:830799", "SSE:600519", "SZSE:000001"]
    assert len(rejects) == 1
    assert rejects[0].reason and "name" in rejects[0].reason
    assert guard.run_calls == 1


def test_fetch_instruments_source_ref_is_not_inverted() -> None:
    """C04：fetched_at 不得早于 as_of（主数据 as_of 取抓取时点，不是当日收盘）。"""
    adapter, _ = _adapter([stock_basic_entry([stock_basic_row("600519.SH", "贵州茅台")])])
    record = adapter.fetch_instruments()[0]  # type: ignore[attr-defined]
    assert record.source.as_of <= record.source.fetched_at


def test_fetch_instruments_is_one_call_and_emits_raw_page() -> None:
    raw: list[RawPage] = []
    adapter, guard = _adapter([stock_basic_entry([stock_basic_row("600519.SH", "贵州茅台")])])
    with adapter.capture(raw.append):  # type: ignore[attr-defined]
        records = adapter.fetch_instruments()  # type: ignore[attr-defined]
    assert len(records) == 1
    assert guard.run_calls == 1
    assert raw[0].dataset == "instrument"
    assert raw[0].rows[0]["ts_code"] == "600519.SH"


def test_get_instrument_and_list_instruments_filter() -> None:
    rows = [
        stock_basic_row("600519.SH", "贵州茅台"),
        stock_basic_row("000001.SZ", "平安银行", exchange="SZSE"),
    ]
    adapter, _ = _adapter([stock_basic_entry(rows) for _ in range(3)])
    assert adapter.get_instrument("SSE:600519").name == "贵州茅台"  # type: ignore[union-attr]
    assert adapter.get_instrument("SSE:600000") is None
    listed = adapter.list_instruments(ExchangeCode.SSE, date(2024, 1, 5))
    assert [r.instrument_id for r in listed] == ["SSE:600519"]


# ---------- adapter：财务 ----------


def test_fetch_fundamentals_latest_reported_period() -> None:
    end_q3 = date(2024, 9, 30)
    end_q2 = date(2024, 6, 30)
    entries = [
        fina_entry("600519.SH", [
            fina_row(date(2024, 10, 25), end_q3, eps="1.5"),
            fina_row(date(2024, 8, 2), end_q2, eps="1.2"),
        ]),
        income_entry("600519.SH", [
            income_row(date(2024, 10, 25), end_q3, total_revenue="123000000.0", n_income_attr_p="45000000.0"),
            income_row(date(2024, 8, 2), end_q2, total_revenue="90000000.0", n_income_attr_p="30000000.0"),
        ]),
    ]
    adapter, guard = _adapter(entries)
    with adapter.capture(None):  # type: ignore[attr-defined]
        records = adapter.fetch_fundamentals(["SSE:600519"])  # type: ignore[attr-defined]
    assert len(records) == 1
    assert records[0].report_period == "2024Q3"
    assert records[0].revenue == Decimal("123000000.0")
    assert guard.run_calls == 2


def test_fetch_fundamentals_without_disclosed_income_yields_no_row() -> None:
    entries = [
        fina_entry("600519.SH", [fina_row(date(2024, 10, 25), date(2024, 9, 30))]),
        income_entry("600519.SH", []),
    ]
    adapter, _ = _adapter(entries)
    assert adapter.fetch_fundamentals(["SSE:600519"]) == []  # type: ignore[attr-defined]
    adapter, _ = _adapter(income_only := [
        fina_entry("600519.SH", []),
        income_entry("600519.SH", [income_row(date(2024, 10, 25), date(2024, 9, 30))]),
    ])
    assert adapter.get_fundamental_summary("SSE:600519") is None  # type: ignore[attr-defined]
    assert income_only


# ---------- ODS：instrument.v1 / fundamental.v1 行形状 ----------


def test_instrument_rows_are_v1_shaped() -> None:
    record = mapper.map_instrument_row(stock_basic_row("600519.SH", "贵州茅台"), source=SOURCE)
    no_date = mapper.map_instrument_row(
        stock_basic_row("688001.SH", "华兴源创", list_status="P", list_date=""), source=SOURCE
    )
    rows = ods.instrument_rows([record, no_date])
    assert rows[0] == {
        "instrument_id": "SSE:600519",
        "exchange": "SSE",
        "code": "600519",
        "name": "贵州茅台",
        "board": "main",
        "security_type": "stock",
        "list_status": "listed",
        "lot_size": 100,
        "listed_at": "2001-08-27",
    }
    assert "listed_at" not in rows[1]
    assert rows[1]["board"] == "star" and rows[1]["lot_size"] == 200


def test_fundamental_rows_use_decimal_strings_and_omit_missing_ratios() -> None:
    record = mapper.build_fundamental_record(
        instrument_id="SSE:600519",
        fina_row=fina_row(date(2024, 10, 25), date(2024, 9, 30), eps="", roe="", grossprofit_margin="", or_yoy="", netprofit_yoy=""),
        income_row=income_row(date(2024, 10, 25), date(2024, 9, 30), n_income_attr_p="-5000000.0"),
        source=SOURCE,
    )
    row = ods.fundamental_rows([record])[0]
    assert row["report_period"] == "2024Q3"
    assert row["report_end_date"] == "2024-09-30"
    assert row["announced_at"] == "2024-10-25T15:00:00+08:00"
    assert row["revenue"] == "123000000.0"
    assert row["net_profit"] == "-5000000.0"
    assert "eps" not in row and "roe_pct" not in row


def test_ods_batch_partition_override(tmp_path: Path) -> None:
    record = mapper.map_instrument_row(stock_basic_row("600519.SH", "贵州茅台"), source=SOURCE)
    batch = ods.OdsBatch(
        batch_id="run-instrument",
        endpoint="instrument",
        source=SOURCE,
        rows=tuple(ods.instrument_rows([record])),
        partition_date_override=date(2024, 1, 5),
    )
    path = ods.write_batch(tmp_path, batch)
    assert path == tmp_path / "instrument" / "dt=2024-01-05" / "run-instrument.json"
    payload = json.loads(path.read_text())
    assert payload["schema"] == "instrument.v1"
    assert payload["rows_total"] == 1
    assert payload["rows"][0]["instrument_id"] == "SSE:600519"


# ---------- sync：主数据 / 财务批次 ----------


def test_sync_instrument_master_writes_batch_and_ods(tmp_path: Path) -> None:
    rows = [
        stock_basic_row("600519.SH", "贵州茅台"),
        stock_basic_row("000001.SZ", "平安银行", exchange="SZSE"),
    ]
    adapter, guard = _adapter([stock_basic_entry(rows)])
    storage = SqliteStorage(tmp_path / "ingest.db")
    try:
        result = sync_instrument_master(
            adapter, storage, ods_root=tmp_path / "ods", clock=FakeClock(), guard=guard
        )
    finally:
        storage.close()
    assert result.status == "succeeded"
    assert result.rows == 2
    assert result.calls_used == 1
    assert result.ods_path is not None
    assert result.ods_path.endswith("run-instrument.json") or result.ods_path.endswith("-instrument.json")
    path = Path(result.ods_path)
    assert path.parent == tmp_path / "ods" / "instrument" / "dt=2024-01-05"
    payload = json.loads(path.read_text())
    assert payload["schema"] == "instrument.v1"
    assert [row["instrument_id"] for row in payload["rows"]] == ["SSE:600519", "SZSE:000001"]


def test_sync_fundamentals_writes_two_calls_per_instrument(tmp_path: Path) -> None:
    entries = [
        fina_entry("600519.SH", [fina_row(date(2024, 10, 25), date(2024, 9, 30))]),
        income_entry("600519.SH", [income_row(date(2024, 10, 25), date(2024, 9, 30))]),
        fina_entry("000001.SZ", [fina_row(date(2024, 10, 25), date(2024, 9, 30), ts_code="000001.SZ")]),
        income_entry("000001.SZ", [
            income_row(date(2024, 10, 25), date(2024, 9, 30), ts_code="000001.SZ",
                       total_revenue="5000000000.0", n_income_attr_p="1200000000.0")
        ]),
    ]
    adapter, guard = _adapter(entries)
    storage = SqliteStorage(tmp_path / "ingest.db")
    try:
        result = sync_fundamentals(
            adapter,
            storage,
            instrument_ids=["SSE:600519", "SZSE:000001"],
            ods_root=tmp_path / "ods",
            clock=FakeClock(),
            guard=guard,
        )
    finally:
        storage.close()
    assert result.status == "succeeded"
    assert result.rows == 2
    assert result.calls_used == 4
    assert result.ods_path is not None
    path = Path(result.ods_path)
    assert path.parent == tmp_path / "ods" / "fundamental" / "dt=2024-09-30"
    payload = json.loads(path.read_text())
    assert payload["schema"] == "fundamental.v1"
    assert [row["instrument_id"] for row in payload["rows"]] == ["SSE:600519", "SZSE:000001"]
    assert payload["rows"][1]["revenue"] == "5000000000.0"


# ---------- CLI：dry-run 预算与端到端 ----------


def test_cli_sync_instruments_dry_run(capsys) -> None:
    assert cli_main(["sync-instruments", "--dry-run"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "sync-instruments"
    assert payload["budget"]["total_calls"] == 1


def test_cli_sync_fundamentals_dry_run(capsys) -> None:
    assert (
        cli_main(
            [
                "sync-fundamentals",
                "--instruments",
                "SSE:600519,SZSE:000001",
                "--dry-run",
            ]
        )
        == 0
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["budget"]["total_calls"] == 4
    assert payload["budget_table"][0] == ["calls_per_instrument", 2]


def test_cli_sync_instruments_end_to_end(tmp_path: Path, capsys) -> None:
    fixture = tmp_path / "fixture.jsonl"
    records = [stock_basic_entry([stock_basic_row("600519.SH", "贵州茅台")])]
    fixture.write_text("\n".join(json.dumps(record, ensure_ascii=False) for record in records))
    code = cli_main(
        [
            "sync-instruments",
            "--replay-fixture",
            str(fixture),
            "--db",
            str(tmp_path / "ingest.db"),
            "--ods-root",
            str(tmp_path / "ods"),
            "--manifest-root",
            str(tmp_path / "audit"),
            "--operator",
            "ci-test",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["rows"] == 1
    assert payload["ods_path"]
    assert (tmp_path / "ods" / "internal" / "instrument").exists()


def test_cli_sync_fundamentals_requires_instruments() -> None:
    with pytest.raises(SystemExit) as excinfo:
        cli_main(["sync-fundamentals"])
    assert excinfo.value.code == 2
