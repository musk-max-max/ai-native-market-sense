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
from support import FakeClock, calendar_entry, entry, research_entry

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


def test_map_hk_hold_hk_branch_uses_hkex_namespace() -> None:
    row = hk_hold_row()
    row["ts_code"] = "00700.HK"
    row["code"] = "00700"
    row["exchange"] = "HK"
    canonical = research.map_row("hk_hold", row)
    assert canonical["instrument_id"] == "HKEX:00700"
    assert canonical["northbound_channel"] == "HK"
    # 逆向：审计/回放能把 canonical 还原成源代码
    assert research.hk_source_code(canonical["instrument_id"]) == "00700.HK"


def test_map_hk_hold_hk_branch_pads_short_code() -> None:
    row = hk_hold_row()
    row["ts_code"] = "7.HK"
    row["code"] = "7"
    row["exchange"] = "HK"
    canonical = research.map_row("hk_hold", row)
    assert canonical["instrument_id"] == "HKEX:00007"
    assert research.hk_source_code(canonical["instrument_id"]) == "00007.HK"


def test_map_hk_hold_rejects_non_hk_suffix() -> None:
    row = hk_hold_row()
    row["ts_code"] = "00700.US"
    with pytest.raises(research.ResearchRowError, match="invalid source code"):
        research.map_row("hk_hold", row)


def test_hk_namespace_rejected_outside_hk_hold() -> None:
    row = top_list_row()
    row["ts_code"] = "00700.HK"
    with pytest.raises(research.ResearchRowError, match="only valid for hk_hold"):
        research.map_row("top_list", row)


def test_map_hk_hold_derives_namespace_when_ts_code_missing() -> None:
    row = hk_hold_row()
    row.pop("ts_code")
    row["code"] = "00700"
    row["exchange"] = "HK"
    assert research.map_row("hk_hold", row)["instrument_id"] == "HKEX:00700"

    a_share = hk_hold_row()
    a_share.pop("ts_code")
    a_share["code"] = "600519"
    a_share["exchange"] = "SH"
    assert research.map_row("hk_hold", a_share)["instrument_id"] == "SSE:600519"


def test_hk_source_code_rejects_non_hkex_ids() -> None:
    with pytest.raises(research.ResearchRowError, match="not an HKEX"):
        research.hk_source_code("SSE:600519")
    with pytest.raises(research.ResearchRowError, match="invalid HKEX code"):
        research.hk_source_code("HKEX:700")


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
        "stk_limit",
        "fina_indicator",
        "index_classify",
        "index_member_all",
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
            datasets=("not_a_dataset",),
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


# ---------------------------------------------------------------------------
# 第 2 批（KD-INGEST-P2 / KD-INGEST-INDUSTRY）：fina_indicator、stk_limit、
# index_classify、index_member_all —— 字段映射 / 形态分派 / 不造数
# ---------------------------------------------------------------------------


def fina_row(**overrides: str) -> dict[str, object]:
    row: dict[str, object] = {
        "ts_code": "600519.SH",
        "ann_date": "20240402",
        "end_date": "20231231",
        "eps": "10.5",
        "roe": "34.2",
        "netprofit_yoy": "19.1",
        "profit_dedt": "74700000000",
        "update_flag": "1",
    }
    row.update(overrides)
    return row


def stk_limit_source_row(**overrides: str) -> dict[str, object]:
    row: dict[str, object] = {
        "trade_date": "20240102",
        "ts_code": "600519.SH",
        "pre_close": "10.0",
        "up_limit": "11.0",
        "down_limit": "9.0",
        "asset_type": "STK",
        "exchange": "SSE",
    }
    row.update(overrides)
    return row


def test_map_fina_indicator_canonical_fields_and_units() -> None:
    canonical = research.map_row("fina_indicator", fina_row())
    assert canonical["instrument_id"] == "SSE:600519"
    assert canonical["report_end_date"] == "2023-12-31"
    assert canonical["report_period"] == "2023Q4"
    assert canonical["announced_at"] == "2024-04-02"
    assert canonical["eps"] == "10.5"
    assert canonical["roe"] == "34.2"
    assert canonical["netprofit_yoy_pct"] == "19.1"
    assert canonical["profit_dedt"] == "74700000000"
    # 缺失字段为 None（禁止补 0，C10）
    assert canonical["bps"] is None
    assert set(canonical) == set(research.canonical_fields("fina_indicator"))


def test_map_fina_indicator_requires_period_fields() -> None:
    with pytest.raises(research.ResearchRowError, match="end_date"):
        research.map_row("fina_indicator", {"ts_code": "600519.SH", "eps": "1"})


def test_map_stk_limit_uses_previous_close_and_exchange() -> None:
    canonical = research.map_row("stk_limit", stk_limit_source_row())
    assert canonical["instrument_id"] == "SSE:600519"
    assert canonical["previous_close"] == "10.0"
    assert canonical["up_limit"] == "11.0"
    assert canonical["down_limit"] == "9.0"
    assert canonical["exchange"] == "SSE"
    assert canonical["asset_type"] == "STK"


def test_map_index_classify_and_member_envelopes() -> None:
    classify = research.map_row(
        "index_classify",
        {
            "index_code": "801050.SI",
            "industry_name": "有色金属",
            "level": "L1",
            "industry_code": "801050",
            "parent_code": "",
        },
    )
    assert classify["index_code"] == "801050.SI"
    assert classify["industry_name"] == "有色金属"
    assert classify["parent_code"] is None

    member = research.map_row(
        "index_member_all",
        {
            "l1_code": "801050.SI",
            "l1_name": "有色金属",
            "l2_code": "801051.SI",
            "l2_name": "工业金属",
            "l3_code": "850531.SI",
            "l3_name": "铝",
            "ts_code": "600519.SH",
            "name": "贵州茅台",
            "in_date": "20200101",
            "out_date": "",
            "is_new": "Y",
        },
    )
    assert member["instrument_id"] == "SSE:600519"
    assert member["in_date"] == "2020-01-01"
    assert member["out_date"] is None
    assert member["is_new"] == "Y"


def test_fetch_research_per_instrument_uses_range_params() -> None:
    entries = [
        entry(
            "fina_indicator",
            {
                "ts_code": "600519.SH",
                "start_date": "20240101",
                "end_date": "20241231",
                "offset": 0,
                "limit": 6000,
            },
            [fina_row(), fina_row(end_date="20240630", ann_date="20240830", eps="11.0")],
        )
    ]
    adapter, guard, _ = _adapter(entries)
    rows = adapter.fetch_research(
        "fina_indicator",
        instrument_id="SSE:600519",
        start=date(2024, 1, 1),
        end=date(2024, 12, 31),
    )
    assert [row["report_period"] for row in rows] == ["2023Q4", "2024Q2"]
    assert guard.run_calls == 1
    assert adapter.research_mode("fina_indicator") == "per_instrument"
    with pytest.raises(InvalidRequestError, match="requires instrument_id"):
        adapter.fetch_research("fina_indicator", start=date(2024, 1, 1), end=date(2024, 12, 31))


def test_fetch_research_snapshot_fans_out_batch_params() -> None:
    entries = [
        entry(
            "index_classify",
            {"level": "L1", "src": "SW2021", "offset": 0, "limit": 6000},
            [{"index_code": "801050.SI", "industry_name": "有色金属", "level": "L1", "industry_code": "801050"}],
        ),
        entry(
            "index_classify",
            {"level": "L2", "src": "SW2021", "offset": 0, "limit": 6000},
            [{"index_code": "801051.SI", "industry_name": "工业金属", "level": "L2", "industry_code": "801051", "parent_code": "801050.SI"}],
        ),
        entry(
            "index_classify",
            {"level": "L3", "src": "SW2021", "offset": 0, "limit": 6000},
            [{"index_code": "850531.SI", "industry_name": "铝", "level": "L3", "industry_code": "850531", "parent_code": "801051.SI"}],
        ),
    ]
    adapter, guard, _ = _adapter(entries)
    rows = adapter.fetch_research("index_classify")
    assert len(rows) == 3
    assert guard.run_calls == 3
    assert adapter.research_mode("index_classify") == "snapshot"
    assert [row["index_code"] for row in rows] == ["801050.SI", "801051.SI", "850531.SI"]


def test_fetch_research_bad_row_without_sink_refuses_silent_drop() -> None:
    entries = [
        entry(
            "stk_limit",
            {"trade_date": "20240102", "offset": 0, "limit": 6000},
            [stk_limit_source_row(up_limit="not-a-number")],
        )
    ]
    adapter, _, _ = _adapter(entries)
    from market_ingest.ports import SchemaDriftError

    with pytest.raises(SchemaDriftError):
        adapter.fetch_research("stk_limit", DAY1)


def test_sync_research_per_instrument_writes_one_batch_per_instrument(tmp_path: Path) -> None:
    entries = [
        entry(
            "fina_indicator",
            {
                "ts_code": "600519.SH",
                "start_date": "20240101",
                "end_date": "20241231",
                "offset": 0,
                "limit": 6000,
            },
            [fina_row()],
        ),
        entry(
            "fina_indicator",
            {
                "ts_code": "000001.SZ",
                "start_date": "20240101",
                "end_date": "20241231",
                "offset": 0,
                "limit": 6000,
            },
            [fina_row(ts_code="000001.SZ", eps="1.2", end_date="20240630", ann_date="20240830")],
        ),
    ]
    adapter, guard, clock = _adapter(entries)
    storage = SqliteStorage(":memory:")
    ods_root = tmp_path / "ods"
    result = sync_research(
        adapter,
        storage,
        datasets=["fina_indicator"],
        start=date(2024, 1, 1),
        end=date(2024, 12, 31),
        instruments=["SSE:600519", "SZSE:000001"],
        ods_root=ods_root,
        clock=clock,
    )
    assert result.status == "succeeded"
    assert result.days_done == 2
    assert result.rows_by_dataset == {"fina_indicator": 2}
    assert result.ods_batches == 2
    assert result.checkpoints["fina_indicator:SSE:600519"] == "2024-12-31"
    files = sorted((ods_root / "fina_indicator").rglob("*.json"))
    assert len(files) == 2
    assert any("dt=2023-12-31" in str(path) for path in files)
    assert guard.run_calls == 2


def test_sync_research_snapshot_is_idempotent_per_day(tmp_path: Path) -> None:
    entries = [
        entry(
            "index_member_all",
            {"is_new": "Y", "offset": 0, "limit": 6000},
            [
                {
                    "l1_code": "801050.SI",
                    "l1_name": "有色金属",
                    "l2_code": "801051.SI",
                    "l2_name": "工业金属",
                    "l3_code": "850531.SI",
                    "l3_name": "铝",
                    "ts_code": "600519.SH",
                    "name": "贵州茅台",
                    "in_date": "20200101",
                    "is_new": "Y",
                }
            ],
        )
    ]
    adapter, guard, clock = _adapter(entries)
    storage = SqliteStorage(":memory:")
    ods_root = tmp_path / "ods"
    first = sync_research(
        adapter,
        storage,
        datasets=["index_member_all"],
        start=DAY1,
        end=DAY2,
        ods_root=ods_root,
        clock=clock,
    )
    assert first.status == "succeeded"
    assert first.days_done == 1
    assert first.rows_by_dataset == {"index_member_all": 1}
    assert guard.run_calls == 1
    second = sync_research(
        adapter,
        storage,
        datasets=["index_member_all"],
        start=DAY1,
        end=DAY2,
        ods_root=ods_root,
        clock=clock,
    )
    assert second.status == "succeeded"
    assert second.days_done == 0
    assert guard.run_calls == 1  # 同日快照幂等，不再调用上游


def test_estimate_research_plan_honours_dataset_modes() -> None:
    plan = estimate_research_plan(
        ["fina_indicator", "index_classify"],
        date(2024, 1, 1),
        date(2024, 12, 31),
        instruments=["SSE:600519", "SZSE:000001"],
        modes={"fina_indicator": "per_instrument", "index_classify": "snapshot"},
    )
    assert plan["dataset_modes"] == {"fina_indicator": "per_instrument", "index_classify": "snapshot"}
    assert plan["calls_by_dataset"]["fina_indicator"] == 2
    assert plan["calls_by_dataset"]["index_classify"] == 1
