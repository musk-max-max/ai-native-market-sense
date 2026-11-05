"""测试支撑：录播夹具构造器 + 假时钟（仅测试用，允许出现源字段名）。

夹具格式与 A12 的录制格式一致：``{"api_name","params","rows"}`` 的 JSONL 行。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

MARKET_TZ = timezone(timedelta(hours=8))
FIXED_NOW = datetime(2024, 1, 5, 19, 30, tzinfo=MARKET_TZ)


class FakeClock:
    """可推进的时钟：``sleep`` 同时推进时间，使限流等待在测试中零耗时。"""

    def __init__(self, now: datetime = FIXED_NOW) -> None:
        self.now = now
        self.slept_s = 0.0

    def __call__(self) -> datetime:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept_s += seconds
        self.now += timedelta(seconds=seconds)


def bar_row(
    trade_date: date,
    *,
    ts_code: str = "600519.SH",
    open: str = "10.0",
    high: str = "10.5",
    low: str = "9.8",
    close: str = "10.2",
    vol: str = "1000",
    amount: str = "5000",
) -> dict[str, Any]:
    return {
        "ts_code": ts_code,
        "trade_date": trade_date.strftime("%Y%m%d"),
        "open": open,
        "high": high,
        "low": low,
        "close": close,
        "pre_close": close,
        "change": "0.0",
        "pct_chg": "0.0",
        "vol": vol,
        "amount": amount,
    }


def factor_row(trade_date: date, *, ts_code: str = "600519.SH", adj_factor: str = "1.0") -> dict[str, Any]:
    return {"ts_code": ts_code, "trade_date": trade_date.strftime("%Y%m%d"), "adj_factor": adj_factor}


def entry(
    api_name: str,
    params: dict[str, Any],
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    return {"api_name": api_name, "params": params, "rows": rows}


def range_params(
    ts_code: str,
    start: date,
    end: date,
    *,
    offset: int = 0,
    limit: int = 6000,
) -> dict[str, Any]:
    return {
        "ts_code": ts_code,
        "start_date": start.strftime("%Y%m%d"),
        "end_date": end.strftime("%Y%m%d"),
        "offset": offset,
        "limit": limit,
    }


def daily_entry(
    ts_code: str,
    start: date,
    end: date,
    rows: list[dict[str, Any]],
    *,
    offset: int = 0,
    limit: int = 6000,
) -> dict[str, Any]:
    return entry("daily", range_params(ts_code, start, end, offset=offset, limit=limit), rows)


def factor_entry(
    ts_code: str,
    start: date,
    end: date,
    rows: list[dict[str, Any]],
    *,
    offset: int = 0,
    limit: int = 6000,
) -> dict[str, Any]:
    return entry("adj_factor", range_params(ts_code, start, end, offset=offset, limit=limit), rows)


def entries_for_chunks(
    ts_code: str,
    start: date,
    end: date,
    chunk_days: int,
    rows_by_date: dict[date, dict[str, Any]],
    *,
    limit: int = 6000,
) -> list[dict[str, Any]]:
    from market_ingest.sync import iter_chunks

    entries: list[dict[str, Any]] = []
    for chunk_start, chunk_end in iter_chunks(start, end, chunk_days):
        rows = [rows_by_date[d] for d in sorted(rows_by_date) if chunk_start <= d <= chunk_end]
        entries.append(daily_entry(ts_code, chunk_start, chunk_end, rows, limit=limit))
    return entries


def calendar_entry(
    start: date,
    end: date,
    days: list[date],
    *,
    offset: int = 0,
    limit: int = 6000,
) -> dict[str, Any]:
    """trade_cal 录播条目（只收录开市日，is_open=1）。"""
    return entry(
        "trade_cal",
        {
            "exchange": "SSE",
            "start_date": start.strftime("%Y%m%d"),
            "end_date": end.strftime("%Y%m%d"),
            "is_open": "1",
            "offset": offset,
            "limit": limit,
        },
        [{"cal_date": day.strftime("%Y%m%d"), "is_open": "1"} for day in days],
    )


def suspend_entry(day: date, ts_codes: list[str], *, offset: int = 0, limit: int = 6000) -> dict[str, Any]:
    """suspend_d 录播条目（按交易日批量：一次拿当天全市场停牌名单）。"""
    return entry(
        "suspend_d",
        {
            "trade_date": day.strftime("%Y%m%d"),
            "suspend_type": "S",
            "offset": offset,
            "limit": limit,
        },
        [
            {"ts_code": code, "trade_date": day.strftime("%Y%m%d"), "suspend_type": "S"}
            for code in ts_codes
        ],
    )


def market_daily_entry(day, rows, *, offset: int = 0, limit: int = 6000):
    """market-wide 日线：``daily`` 按 trade_date 一次返回全市场。"""
    return entry("daily", {"trade_date": day.strftime("%Y%m%d"), "offset": offset, "limit": limit}, rows)


def market_factor_entry(day, rows, *, offset: int = 0, limit: int = 6000):
    """market-wide 复权因子：``adj_factor`` 按 trade_date 一次返回全市场。"""
    return entry("adj_factor", {"trade_date": day.strftime("%Y%m%d"), "offset": offset, "limit": limit}, rows)


def research_entry(
    api_name: str,
    day: date,
    rows: list[dict[str, Any]],
    *,
    ts_code: str | None = None,
    offset: int = 0,
    limit: int = 6000,
) -> dict[str, Any]:
    """研究数据集录播条目；``index_daily`` 之类按标的取数的接口额外带 ts_code。"""
    params: dict[str, Any] = {"trade_date": day.strftime("%Y%m%d")}
    if ts_code is not None:
        params["ts_code"] = ts_code
    params["offset"] = offset
    params["limit"] = limit
    return entry(api_name, params, rows)


def stock_basic_row(
    ts_code: str,
    name: str,
    *,
    list_date: str = "20010827",
    delist_date: str = "",
    list_status: str = "L",
    symbol: str | None = None,
    market: str = "主板",
    exchange: str = "SSE",
) -> dict[str, Any]:
    return {
        "ts_code": ts_code,
        "symbol": symbol or ts_code.split(".")[0],
        "name": name,
        "market": market,
        "list_date": list_date,
        "delist_date": delist_date,
        "list_status": list_status,
        "exchange": exchange,
    }


def stock_basic_entry(rows: list[dict[str, Any]], *, offset: int = 0, limit: int = 6000) -> dict[str, Any]:
    return entry("stock_basic", {"list_status": "L", "offset": offset, "limit": limit}, rows)


def fina_row(
    ann_date: date,
    end_date: date,
    *,
    ts_code: str = "600519.SH",
    eps: str = "1.0",
    roe: str = "12.0",
    grossprofit_margin: str = "45.0",
    or_yoy: str = "10.0",
    netprofit_yoy: str = "8.0",
) -> dict[str, Any]:
    return {
        "ts_code": ts_code,
        "ann_date": ann_date.strftime("%Y%m%d"),
        "end_date": end_date.strftime("%Y%m%d"),
        "eps": eps,
        "roe": roe,
        "grossprofit_margin": grossprofit_margin,
        "or_yoy": or_yoy,
        "netprofit_yoy": netprofit_yoy,
    }


def fina_entry(ts_code: str, rows: list[dict[str, Any]], *, offset: int = 0, limit: int = 6000) -> dict[str, Any]:
    return entry("fina_indicator", {"ts_code": ts_code, "offset": offset, "limit": limit}, rows)


def income_row(
    ann_date: date,
    end_date: date,
    *,
    ts_code: str = "600519.SH",
    total_revenue: str = "123000000.0",
    n_income_attr_p: str = "45000000.0",
) -> dict[str, Any]:
    return {
        "ts_code": ts_code,
        "ann_date": ann_date.strftime("%Y%m%d"),
        "end_date": end_date.strftime("%Y%m%d"),
        "total_revenue": total_revenue,
        "n_income_attr_p": n_income_attr_p,
        "update_flag": "0",
    }


def income_entry(ts_code: str, rows: list[dict[str, Any]], *, offset: int = 0, limit: int = 6000) -> dict[str, Any]:
    return entry("income", {"ts_code": ts_code, "offset": offset, "limit": limit}, rows)
