"""KD-AIP0-INF-05 研究数据集接入：字段映射 / adapter 抽取 / sync 全链路 / CLI 预算。"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from market_ingest.adapters.tushare import research
from market_ingest.adapters.tushare import transport as ts_transport
from market_ingest.adapters.tushare.adapter import create_adapter
from market_ingest.cli import main as cli_main
from market_ingest.ports import InvalidRequestError
from market_ingest.quota import InMemoryCallLedger, QuotaGuard, QuotaPolicy
from market_ingest.storage import SqliteStorage
from market_ingest.sync import estimate_research_plan, sync_research
from support import FakeClock, calendar_entry, research_entry

DAY1 = date(2024, 1, 2)
DAY2 = date(2024, 1, 3)


# ---------------------------------------------------------------------------
# 夹具：各研究接口的源行（ts_code/东财式单位，仅在适配层测试出现）
# ---------------------------------------------------------------------------


def top_list_row(ts_code: str = "600519.SH", **overrides: str) -> dict[str, object]:
    row: dict[str, object] = {
        "trade_date": "20240102",
        "ts_code": ts_code,
        "name": "贵州茅台",
        "close": "10.0",
        "pct_change": "5.0",
        "turnover_rate": "3.0",
        "amount": "1000",
        "l_sell": "100",
        "l_buy": "200",
        "l_amount": "300",
        "net_amount": "100",
        "net_rate": "10.0",
        "amount_rate": "30.0",
        "float_values": "100000",
        "reason": "涨幅偏离",
    }
    row.update(overrides)
    return row


def top_inst_row(ts_code: str = "600519.SH") -> dict[str, object]:
    return {
        "trade_date": "20240102",
        "ts_code": ts_code,
        "exalter": "机构专用",
        "side": "0",
        "buy": "1000",
        "buy_rate": "12.5",
        "sell": "500",
        "sell_rate": "6.25",
        "net_buy": "500",
        "reason": "涨幅偏离",
    }


def moneyflow_row(ts_code: str = "600519.SH") -> dict[str, object]:
    return {
        "ts_code": ts_code,
        "trade_date": "20240102",
        "buy_sm_vol": "10",
        "buy_sm_amount": "2",
        "sell_sm_vol": "3",
        "sell_sm_amount": "0.6",
        "net_mf_vol": "7",
        "net_mf_amount": "1.4",
    }


def margin_row() -> dict[str, object]:
    return {
        "trade_date": "20240102",
        "exchange_id": "SSE",
        "rzye": "1000000",
        "rzmre": "2000",
        "rzche": "1000",
        "rqye": "3000",
        "rqmcl": "100",
        "rzrqye": "1003000",
        "rqyl": "200",
    }


def hk_hold_row(ts_code: str = "600519.SH") -> dict[str, object]:
    return {
        "code": "600519",
        "trade_date": "20240102",
        "ts_code": ts_code,
        "name": "贵州茅台",
        "vol": "1000",
        "ratio": "2.5",
        "exchange": "SH",
    }


def daily_basic_row(ts_code: str = "600519.SH") -> dict[str, object]:
    return {
        "ts_code": ts_code,
        "trade_date": "20240102",
        "close": "10.0",
        "turnover_rate": "1.2",
        "turnover_rate_f": "2.5",
        "volume_ratio": "0.8",
        "pe": "20.0",
        "pe_ttm": "19.0",
        "pb": "3.0",
        "total_share": "100",
        "float_share": "80",
        "free_share": "60",
        "total_mv": "10000",
        "circ_mv": "8000",
        "limit_status": "0",
    }


def index_daily_row(ts_code: str = "000300.SH") -> dict[str, object]:
    return {
        "ts_code": ts_code,
        "trade_date": "20240102",
        "close": "3000.0",
        "open": "2990.0",
        "high": "3010.0",
        "low": "2980.0",
        "pre_close": "2995.0",
        "change": "5.0",
        "pct_chg": "0.17",
        "vol": "1000",
        "amount": "2000",
    }


def _clock_guard(*, run_budget: int | None = None) -> tuple[FakeClock, QuotaGuard]:
    clock = FakeClock()
    guard = QuotaGuard(
        QuotaPolicy(calls_per_minute=60000, reserve_ratio=0.0, run_budget_calls=run_budget),
        InMemoryCallLedger(),
        clock=clock,
        sleep=clock.sleep,
    )
    return clock, guard


def _adapter(entries, *, run_budget: int | None = None):
    clock, guard = _clock_guard(run_budget=run_budget)
    adapter = create_adapter(
        {},
        transport=ts_transport.ReplayTransport(entries),
        guard=guard,
        clock=clock,
        sleep=clock.sleep,
    )
    return adapter, guard, clock


# ---------------------------------------------------------------------------
# 字段映射（单行 → canonical：元/股/百分数，禁止源字段泄漏）
# ---------------------------------------------------------------------------


def test_map_top_list_units_and_fields() -> None:
    canonical = research.map_row("top_list", top_list_row())
    assert canonical["instrument_id"] == "SSE:600519"
    assert canonical["trade_date"] == "2024-01-02"
    assert canonical["close"] == "10.0"
    assert canonical["pct_change_pct"] == "5.0"
    assert canonical["lhb_sell_amount"] == "100"
    assert canonical["lhb_net_amount"] == "100"
    assert canonical["reason"] == "涨幅偏离"
    assert "ts_code" not in canonical


def test_map_top_inst_side_and_seat() -> None:
    canonical = research.map_row("top_inst", top_inst_row())
    assert canonical["seat_name"] == "机构专用"
    assert canonical["side"] == "0"
    assert canonical["buy_amount"] == "1000"
    assert canonical["buy_rate_pct"] == "12.5"
    assert canonical["net_buy_amount"] == "500"


def test_map_moneyflow_converts_lots_and_ten_thousand_yuan() -> None:
    canonical = research.map_row("moneyflow", moneyflow_row())
    assert canonical["buy_small_volume"] == "1000"  # 10 手 × 100 股
    assert canonical["buy_small_amount"] == "20000"  # 2 万元 × 10000
    assert canonical["net_inflow_volume"] == "700"
    assert Decimal(canonical["net_inflow_amount"]) == Decimal("14000")


def test_map_margin_keeps_exchange_and_yuan() -> None:
    canonical = research.map_row("margin", margin_row())
    assert canonical["exchange"] == "SSE"
    assert canonical["financing_balance"] == "1000000"
    assert canonical["margin_balance"] == "1003000"


def test_map_hk_hold_northbound_channel() -> None:
    canonical = research.map_row("hk_hold", hk_hold_row())
    assert canonical["instrument_id"] == "SSE:600519"
    assert canonical["holding_volume"] == "1000"
    assert canonical["holding_ratio_pct"] == "2.5"
    assert canonical["northbound_channel"] == "SH"


def test_map_daily_basic_share_and_value_units() -> None:
    canonical = research.map_row("daily_basic", daily_basic_row())
    assert canonical["total_shares"] == "1000000"  # 100 万股 × 10000
    assert canonical["total_market_value"] == "100000000"  # 10000 万元 × 10000
    assert canonical["limit_status"] == "0"


def test_map_index_daily_units() -> None:
    canonical = research.map_row("index_daily", index_daily_row())
    assert canonical["instrument_id"] == "SSE:000300"
    assert canonical["prev_close"] == "2995.0"
    assert canonical["volume"] == "100000"  # 1000 手 × 100 股
    assert canonical["amount"] == "2000000"  # 2000 千元 × 1000


def test_map_rejects_missing_required_without_zero_fill() -> None:
    row = top_list_row()
    row.pop("close")
    with pytest.raises(research.ResearchRowError, match="close"):
        research.map_row("top_list", row)


def test_research_datasets_registry() -> None:
    names = research.research_datasets()
    assert set(names) == {
        "top_list",
        "top_inst",
        "moneyflow",
        "margin",
        "hk_hold",
        "daily_basic",
        "index_daily",
    }
    assert research.RESEARCH_DATASETS["top_inst"].points_min == 5000
    assert research.RESEARCH_DATASETS["index_daily"].requires_index_codes is True


# ---------------------------------------------------------------------------
# adapter：市场级抽取（raw 先落、坏行进 DLQ、index_daily 按指数多次调用）
# ---------------------------------------------------------------------------


def test_fetch_research_emits_raw_first_and_maps_rows() -> None:
    adapter, guard, _ = _adapter([research_entry("daily_basic", DAY1, [daily_basic_row()])])
    raw_pages = []
    rejects = []
    with adapter.capture(raw_pages.append, rejects.append):
        rows = adapter.fetch_research("daily_basic", DAY1)
    assert len(rows) == 1
    assert rows[0]["instrument_id"] == "SSE:600519"
    assert len(raw_pages) == 1
    assert raw_pages[0].dataset == "daily_basic"
    assert raw_pages[0].endpoint == "daily_basic"
    assert raw_pages[0].rows[0]["ts_code"] == "600519.SH"  # raw 保留源值供审计
    assert rejects == []
    assert guard.run_calls == 1


def test_fetch_research_rejects_bad_row_to_dlq() -> None:
    bad = top_list_row()
    bad.pop("close")
    adapter, _, _ = _adapter([research_entry("top_list", DAY1, [bad, top_list_row("000001.SZ")])])
    rejects = []
    with adapter.capture(lambda page: None, rejects.append):
        rows = adapter.fetch_research("top_list", DAY1)
    assert [row["instrument_id"] for row in rows] == ["SZSE:000001"]
    assert len(rejects) == 1
    assert rejects[0].dataset == "top_list"


def test_fetch_research_without_sink_refuses_silent_drop() -> None:
    bad = top_list_row()
    bad.pop("close")
    adapter, _, _ = _adapter([research_entry("top_list", DAY1, [bad])])
    with pytest.raises(Exception, match="DLQ"):
        adapter.fetch_research("top_list", DAY1)


def test_fetch_index_daily_calls_once_per_index_and_merges() -> None:
    adapter, guard, _ = _adapter(
        [
            research_entry("index_daily", DAY1, [index_daily_row("000300.SH")], ts_code="000300.SH"),
            research_entry("index_daily", DAY1, [index_daily_row("000001.SH")], ts_code="000001.SH"),
        ]
    )
    rows = adapter.fetch_research("index_daily", DAY1, index_codes=("SSE:000300", "SSE:000001"))
    assert {row["instrument_id"] for row in rows} == {"SSE:000300", "SSE:000001"}
    assert guard.run_calls == 2


def test_fetch_index_daily_requires_index_codes() -> None:
    adapter, _, _ = _adapter([])
    with pytest.raises(InvalidRequestError, match="index-codes"):
        adapter.fetch_research("index_daily", DAY1)


def test_fetch_research_unknown_dataset() -> None:
    adapter, _, _ = _adapter([])
    with pytest.raises(InvalidRequestError, match="unknown research dataset"):
        adapter.fetch_research("not_a_dataset", DAY1)


# ---------------------------------------------------------------------------
# sync：按交易日 checkpoint / 内部 ODS 落表 / 中断续跑 / 配额中断
# ---------------------------------------------------------------------------


def _sync_entries(*, day1_only: bool = False, include_margin: bool = True) -> list[dict[str, object]]:
    items: list[dict[str, object]] = [calendar_entry(DAY1, DAY2, [DAY1, DAY2])]
    items.append(research_entry("daily_basic", DAY1, [daily_basic_row()]))
    if not day1_only:
        items.append(research_entry("daily_basic", DAY2, [daily_basic_row()]))
    if include_margin:
        items.append(research_entry("margin", DAY1, [margin_row()]))
        if not day1_only:
            items.append(research_entry("margin", DAY2, [margin_row()]))
    return items


def test_sync_research_writes_ods_and_checkpoints(tmp_path: Path) -> None:
    adapter, guard, clock = _adapter(_sync_entries())
    storage = SqliteStorage(":memory:")
    ods_root = tmp_path / "internal"
    result = sync_research(
        adapter,
        storage,
        datasets=("daily_basic", "margin"),
        start=DAY1,
        end=DAY2,
        ods_root=ods_root,
        guard=guard,
        clock=clock,
    )
    assert result.status == "succeeded"
    assert result.days_done == 4
    assert result.rows_by_dataset == {"daily_basic": 2, "margin": 2}
    assert result.ods_batches == 4
    assert result.checkpoints == {"daily_basic": "2024-01-03", "margin": "2024-01-03"}
    assert result.calls_used == 5  # 日历 1 + 2 数据集 × 2 天
    files = sorted((ods_root / "daily_basic").glob("dt=*/*.json"))
    assert len(files) == 2
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    assert payload["schema"] == "daily_basic.v1"
    assert payload["rows"][0]["instrument_id"] == "SSE:600519"
    assert (storage.get_checkpoint("margin", "market")) == DAY2
    storage.close()


def test_sync_research_resumes_after_interrupt(tmp_path: Path) -> None:
    storage = SqliteStorage(":memory:")
    ods_root = tmp_path / "internal"
    adapter, guard, clock = _adapter(_sync_entries(day1_only=True, include_margin=False))
    checks = {"count": 0}

    def interrupt() -> bool:
        checks["count"] += 1
        return checks["count"] > 1  # 第一次检查放行 DAY1，第二次（DAY2 前）中断

    first = sync_research(
        adapter,
        storage,
        datasets=("daily_basic",),
        start=DAY1,
        end=DAY2,
        ods_root=ods_root,
        guard=guard,
        clock=clock,
        interrupt=interrupt,
    )
    assert first.status == "interrupted"
    assert first.halted_reason == "interrupt_signal"
    assert first.days_done == 1
    assert storage.get_checkpoint("daily_basic", "market") == DAY1

    adapter2, guard2, clock2 = _adapter(_sync_entries())
    second = sync_research(
        adapter2,
        storage,
        datasets=("daily_basic", "margin"),
        start=DAY1,
        end=DAY2,
        ods_root=ods_root,
        guard=guard2,
        clock=clock2,
    )
    assert second.status == "succeeded"
    assert second.days_done == 3  # daily_basic 只剩 DAY2 + margin 两天
    assert storage.get_checkpoint("daily_basic", "market") == DAY2
    assert storage.get_checkpoint("margin", "market") == DAY2
    assert second.checkpoints["margin"] == "2024-01-03"
    files = list((ods_root / "daily_basic").glob("dt=*/*.json"))
    assert len(files) == 2
    storage.close()


def test_sync_research_stops_on_quota_exhausted(tmp_path: Path) -> None:
    adapter, guard, clock = _adapter(_sync_entries(), run_budget=2)
    storage = SqliteStorage(":memory:")
    result = sync_research(
        adapter,
        storage,
        datasets=("daily_basic",),
        start=DAY1,
        end=DAY2,
        ods_root=tmp_path / "internal",
        guard=guard,
        clock=clock,
    )
    assert result.status == "interrupted"
    assert result.halted_reason == "quota_exhausted"
    assert result.days_done == 1
    assert storage.get_checkpoint("daily_basic", "market") == DAY1
    storage.close()


def test_sync_research_rejects_unknown_dataset() -> None:
    adapter, guard, clock = _adapter([])
    storage = SqliteStorage(":memory:")
    with pytest.raises(ValueError, match="does not support research datasets"):
        sync_research(
            adapter,
            storage,
            datasets=("stk_limit",),
            start=DAY1,
            end=DAY2,
            guard=guard,
            clock=clock,
        )
    storage.close()


# ---------------------------------------------------------------------------
# 预算与 CLI
# ---------------------------------------------------------------------------


def test_estimate_research_plan_counts_index_codes() -> None:
    plan = estimate_research_plan(
        ("daily_basic", "index_daily"),
        DAY1,
        DAY2,
        index_codes=("SSE:000300", "SSE:000001"),
    )
    assert plan["trading_days"] == 2
    assert plan["calls_per_trading_day"] == 3  # 1 + 2 指数
    assert plan["calls_by_dataset"] == {"daily_basic": 2, "index_daily": 4}
    assert plan["total_calls"] == 7  # + 日历 1
    assert plan["effective_calls_per_minute"] == 400


def test_cli_sync_research_dry_run_reports_budget(capsys: pytest.CaptureFixture[str]) -> None:
    code = cli_main([
        "sync-research",
        "--datasets", "daily_basic",
        "--start", "2024-01-02",
        "--end", "2024-01-03",
        "--index-codes", "SSE:000300",
        "--dry-run",
    ])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "research"
    assert payload["datasets"] == ["daily_basic"]
    assert payload["budget"]["total_calls"] == 3  # 2 天 + 日历
    assert payload["budget"]["eta_minutes"] == 1
    assert payload["budget_table"][-1][0] == "= eta_minutes"
