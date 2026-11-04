"""测试共用的 ODS 批次构造（走与生产相同的 load_batches → build_dwd）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from warehouse.dwd.build import DwdState, build_dwd
from warehouse.golden_runner import _envelope, _write_envelope
from warehouse.ods.loader import load_batches

AS_OF = "2026-09-30T20:05:00+08:00"
FETCHED_AT = "2026-09-30T20:06:00+08:00"


def source(as_of: str = AS_OF, fetched_at: str = FETCHED_AT, name: str = "tushare") -> dict[str, str]:
    return {"source": name, "as_of": as_of, "fetched_at": fetched_at}


def instrument_row(instrument_id: str = "SSE:600519", **overrides: Any) -> dict[str, Any]:
    exchange, code = instrument_id.split(":")
    row = {
        "instrument_id": instrument_id,
        "exchange": exchange,
        "code": code,
        "name": "贵州茅台" if instrument_id == "SSE:600519" else "测试证券",
        "board": "main",
        "security_type": "stock",
        "list_status": "listed",
        "lot_size": 100,
        "listed_at": "2001-08-27",
    }
    row.update(overrides)
    return row


def bar_row(trade_date: str = "2026-09-30", instrument_id: str = "SSE:600519", **overrides: Any) -> dict[str, Any]:
    row = {
        "instrument_id": instrument_id,
        "trade_date": trade_date,
        "open": "10.00",
        "high": "10.50",
        "low": "9.90",
        "close": "10.30",
        "volume": "1000000",
        "amount": "10300000.00",
        "prev_close": "10.20",
    }
    row.update(overrides)
    return row


def factor_row(trade_date: str = "2026-09-30", instrument_id: str = "SSE:600519", factor: str = "1.0") -> dict[str, Any]:
    return {"instrument_id": instrument_id, "trade_date": trade_date, "factor": factor}


def fundamental_row(instrument_id: str = "SSE:600519", **overrides: Any) -> dict[str, Any]:
    row = {
        "instrument_id": instrument_id,
        "report_period": "2026Q2",
        "report_end_date": "2026-06-30",
        "announced_at": "2026-08-20T19:00:00+08:00",
        "statement_basis": "reported",
        "currency": "CNY",
        "revenue": "100000000.00",
        "net_profit": "20000000.00",
        "revenue_yoy_pct": "12.5000",
        "net_profit_yoy_pct": None,
        "eps": "1.2345",
        "roe_pct": None,
        "gross_margin_pct": "88.0000",
    }
    row.update(overrides)
    return row


def envelopes(
    *,
    instrument: dict[str, Any] | None = instrument_row(),
    bars: list[dict[str, Any]] | None = None,
    factors: list[dict[str, Any]] | None = None,
    fundamentals: list[dict[str, Any]] | None = None,
    source_ref: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    src = source_ref or source()
    out: list[dict[str, Any]] = []
    if instrument is not None:
        out.append(_envelope("t-dim", "instrument", "instrument.v1", src, [instrument]))
    if bars:
        out.append(_envelope("t-bar", "bar", "bar.v1", src, bars))
    if factors:
        out.append(_envelope("t-factor", "adj_factor", "adj_factor.v1", src, factors))
    if fundamentals:
        out.append(_envelope("t-fundamental", "fundamental", "fundamental.v1", src, fundamentals))
    return out


def state_from_envelopes(tmp_path: Path, envs: list[dict[str, Any]]) -> DwdState:
    tmp_path = Path(tmp_path)
    for envelope in envs:
        _write_envelope(tmp_path, envelope)
    return build_dwd(load_batches(tmp_path))
