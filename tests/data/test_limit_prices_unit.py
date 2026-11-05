"""限价取整的独立单元测试（H4 m04155 补缺口，B 股/北交所无 bar 路径覆盖）。

不依赖 golden 采样：直接对 `quality_lib.quote_unit` / `limit_prices` 断言交易所取整方向。
口径：docs/metrics/P0-metrics.md §6（H4 2026-11-05 已签 M04 + RES-05 取整）：
  沪深 A 0.01 half-up；北交所 43/83/87/88/92 涨停 floor、跌停 ceil；
  沪 B 900xxx 0.001 half-up；深 B 200xxx 0.01 half-up。
"""

from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from quality_lib import limit_prices, quote_unit  # noqa: E402


def instrument(instrument_id: str, board: str) -> dict[str, str]:
    return {"instrument_id": instrument_id, "board": board}


@pytest.mark.parametrize(
    ("instrument_id", "board", "unit"),
    [
        ("SSE:900901", "main", "0.001"),  # 沪市 B 股：0.001 美元
        ("SZSE:200011", "main", "0.01"),  # 深市 B 股：0.01 港元
        ("SSE:600519", "main", "0.01"),
        ("SZSE:000001", "main", "0.01"),
        ("BSE:920001", "bse", "0.01"),
    ],
)
def test_quote_unit_matches_market(instrument_id, board, unit):
    assert quote_unit(instrument(instrument_id, board)) == Decimal(unit)


def test_shanghai_b_share_uses_three_decimals_half_up():
    """沪 B 900xxx：报价单位 0.001，涨跌停价按 0.001 half-up。"""
    inst = instrument("SSE:900901", "main")
    up, down = limit_prices(Decimal("1.234"), Decimal("10"), instrument=inst)
    assert quote_unit(inst) == Decimal("0.001")
    assert up == Decimal("1.357")  # 1.234 × 1.10 = 1.3574 → 1.357
    assert down == Decimal("1.111")  # 1.234 × 0.90 = 1.1106 → 1.111


def test_shenzhen_b_share_uses_two_decimals_half_up():
    """深 B 200xxx：报价单位 0.01，10% 档 half-up（.005 进位）。"""
    inst = instrument("SZSE:200011", "main")
    up, down = limit_prices(Decimal("5.55"), Decimal("10"), instrument=inst)
    assert quote_unit(inst) == Decimal("0.01")
    assert up == Decimal("6.11")  # 5.55 × 1.10 = 6.105 → 6.11
    assert down == Decimal("5.00")  # 5.55 × 0.90 = 4.995 → 5.00


def test_bse_920_prefix_up_floor_down_ceil():
    """北交所 920 段：涨停 floor、跌停 ceil（H4 指定样例 1.26 × 30%）。"""
    inst = instrument("BSE:920001", "bse")
    up, down = limit_prices(Decimal("1.26"), Decimal("30"), instrument=inst)
    assert up == Decimal("1.63")  # 1.26 × 1.30 = 1.638 → floor 1.63
    assert down == Decimal("0.89")  # 1.26 × 0.70 = 0.882 → ceil 0.89


def test_bse_43_prefix_direction():
    """北交所 43 段：涨停 floor、跌停 ceil（非整分样例）。"""
    inst = instrument("BSE:430047", "bse")
    up, down = limit_prices(Decimal("8.33"), Decimal("30"), instrument=inst)
    assert up == Decimal("10.82")  # 8.33 × 1.30 = 10.829 → floor 10.82
    assert down == Decimal("5.84")  # 8.33 × 0.70 = 5.831 → ceil 5.84


def test_bse_83_prefix_direction():
    """北交所 83 段：涨停 floor、跌停 ceil（非整分样例）。"""
    inst = instrument("BSE:830799", "bse")
    up, down = limit_prices(Decimal("12.34"), Decimal("30"), instrument=inst)
    assert up == Decimal("16.04")  # 12.34 × 1.30 = 16.042 → floor 16.04
    assert down == Decimal("8.64")  # 12.34 × 0.70 = 8.638 → ceil 8.64


def test_hs_a_share_rounding_is_half_up():
    """沪深 A 0.01 half-up：10.05 × 5% = 10.5525 → 10.55（反例：floor 会得 10.55 同值，改用 .005 边界）。"""
    inst = instrument("SSE:600182", "main")
    up, down = limit_prices(Decimal("10.50"), Decimal("5"), instrument=inst)
    assert up == Decimal("11.03")  # 10.50 × 1.05 = 11.025 → half-up 11.03
    assert down == Decimal("9.98")  # 10.50 × 0.95 = 9.975 → half-up 9.98
