"""复权计算：hfq/qfq 口径固定，禁止缺因子时静默用 1.0。"""

from __future__ import annotations

from decimal import Decimal

import pytest

from warehouse.dwd.adjust import (
    AdjustmentError,
    adjust_bars,
    hfq_price,
    qfq_price,
)


def test_hfq_price_multiplies_factor():
    assert hfq_price(Decimal("10.00"), Decimal("1.2")) == Decimal("12.0000")


def test_qfq_price_normalizes_by_latest_factor():
    assert qfq_price(Decimal("10.00"), Decimal("1.2"), Decimal("1.5")) == Decimal("8.0000")


def test_factor_must_be_positive():
    with pytest.raises(AdjustmentError):
        hfq_price(Decimal("10.00"), Decimal("0"))


def _bars():
    return [
        {"instrument_id": "SSE:600519", "trade_date": "2026-09-28", "open": Decimal("9.90"),
         "high": Decimal("10.10"), "low": Decimal("9.80"), "close": Decimal("10.00"),
         "volume": 1000, "amount": Decimal("10000.00")},
        {"instrument_id": "SSE:600519", "trade_date": "2026-09-29", "open": Decimal("10.20"),
         "high": Decimal("10.50"), "low": Decimal("10.10"), "close": Decimal("10.40"),
         "volume": 1000, "amount": Decimal("10400.00")},
    ]


def test_adjust_bars_hfq_and_none():
    from datetime import date

    factors = {date(2026, 9, 28): Decimal("1.0"), date(2026, 9, 29): Decimal("1.2")}
    none_rows = adjust_bars(_bars(), factors, "none")
    assert none_rows[0]["close"] == Decimal("10.00")
    hfq_rows = adjust_bars(_bars(), factors, "hfq")
    assert hfq_rows[0]["close"] == Decimal("10.0000")
    assert hfq_rows[1]["close"] == Decimal("12.4800")
    # volume/amount 不随复权变化
    assert hfq_rows[0]["volume"] == none_rows[0]["volume"]


def test_adjust_bars_missing_factor_raises():
    with pytest.raises(AdjustmentError, match="缺复权因子"):
        adjust_bars(_bars(), {}, "hfq")


def test_invalid_adj_type_rejected():
    with pytest.raises(AdjustmentError, match="非法 adj_type"):
        adjust_bars(_bars(), {}, "adjusted")
