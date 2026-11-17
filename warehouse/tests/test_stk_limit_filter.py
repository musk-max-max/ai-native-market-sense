"""L201：stk_limit PG schema CHECK 约束前置过滤测试。

dwd_stk_limit schema 有 CHECK (down_limit > 0) + up_limit < 99999 约束，生产 ingest 场景
（SKIP_ANCHOR_PRELOAD + production-sync.sh --skip-rule RES-05）下 tushare 返回哨兵值/脏数据
（BSE:920085 prev=17.79 up=99999.99 down=0.0）会在 load.py 过滤，避免 PG 违约整批回滚。
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from warehouse.load import _stk_limit_rows_filtered


def _row(**overrides):
    base = {
        "instrument_id": "SSE:600519",
        "trade_date": "2026-11-06",
        "previous_close": Decimal("17.79"),
        "up_limit": Decimal("19.57"),
        "down_limit": Decimal("16.01"),
        "limit_pct": Decimal("10"),
        "limit_pct_source": "10",
        "asset_type": "STK",
        "exchange": "SSE",
        "batch_id": "test-batch",
    }
    base.update(overrides)
    return base


def test_filter_drops_sentinel_zero_down_limit() -> None:
    rows = [_row(), _row(instrument_id="BSE:920085", down_limit=Decimal("0.0"), up_limit=Decimal("99999.99"))]
    out = _stk_limit_rows_filtered(rows)
    assert [r["instrument_id"] for r in out] == ["SSE:600519"]


def test_filter_drops_sentinel_up_limit_ge_99999() -> None:
    out = _stk_limit_rows_filtered([_row(up_limit=Decimal("99999.99"))])
    assert out == []


def test_filter_drops_non_positive_previous_close() -> None:
    out = _stk_limit_rows_filtered([_row(previous_close=Decimal("0"))])
    assert out == []


def test_filter_drops_null_prices() -> None:
    out = _stk_limit_rows_filtered([_row(down_limit=None)])
    assert out == []


def test_filter_keeps_valid_rows() -> None:
    rows = [_row(), _row(instrument_id="SZSE:000001")]
    out = _stk_limit_rows_filtered(rows)
    assert len(out) == 2
