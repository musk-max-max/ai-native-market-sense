"""复权计算（M02 后复权收益口径；qfq 仅用于画图）。

唯一输入是 dwd_adj_factor 的累计因子（归一化 1.0 = 首个上市交易日）：
    hfq_close = close × factor
    qfq_close = close × factor / factor(区间内最新交易日)
除 qfq 外都是逐行确定性变换，不依赖未来数据；qfq 依赖 as_of 当日的最新因子，不用于收益计算。

因子口径若变更属于 must_escalate（复权算法变更），必须先改 docs/metrics/P0-metrics.md
并获 H4 签字，再改本文件。
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

QUANT = Decimal("0.0001")
ONE = Decimal("1")


class AdjustmentError(ValueError):
    """复权计算前置条件不满足（缺因子、因子非正）。"""


def _q(value: Decimal) -> Decimal:
    return value.quantize(QUANT, rounding=ROUND_HALF_UP)


def hfq_price(close: Decimal, factor: Decimal) -> Decimal:
    """后复权价（M02：用于区间收益与多期比较，不受后续除权影响）。"""
    if factor <= 0:
        raise AdjustmentError(f"复权因子必须 > 0，得到 {factor}")
    return _q(close * factor)


def qfq_price(close: Decimal, factor: Decimal, latest_factor: Decimal) -> Decimal:
    """前复权价（仅画图；latest_factor 为区间内最新交易日的累计因子）。"""
    if factor <= 0 or latest_factor <= 0:
        raise AdjustmentError("复权因子必须 > 0")
    return _q(close * factor / latest_factor)


def hfq_return_pct(first_close: Decimal, last_close: Decimal, factors: dict[Decimal, Decimal] | None = None) -> Decimal:
    """后复权区间收益率（%）。factors 参数仅为保持签名对称，实际使用调用方的 hfq 价。"""
    del factors
    if first_close <= 0 or last_close <= 0:
        raise AdjustmentError("复权价必须 > 0")
    return _q((last_close / first_close - ONE) * Decimal(100))


def adjust_bars(bars: list[dict], factors: dict, adj_type: str, *, latest_factor: Decimal | None = None) -> list[dict]:
    """把 DWD bar 行映射为指定复权口径的 API 行（契约 BarsResponse.data.bars 形状）。

    adj_type：
      none → 原样返回不复权 OHLC（M01 主口径、K 线默认）
      hfq  → OHLC × factor（M02 收益口径）
      qfq  → OHLC × factor / latest_factor（仅画图）
    volume/amount 不随复权调整（成交量本就是股数，复权不改变股数语义）。
    """
    from warehouse.ods.loader import parse_date

    if adj_type not in ("none", "hfq", "qfq"):
        raise AdjustmentError(f"非法 adj_type {adj_type!r}，允许 none|hfq|qfq")
    if adj_type == "qfq" and latest_factor is None:
        # qfq 需要区间内最新交易日的因子；缺因子必须显式报错，不能用 1.0 冒充
        seen: list[Decimal] = []
        for bar in bars:
            trade_date = bar["trade_date"] if hasattr(bar["trade_date"], "isoformat") else parse_date(bar["trade_date"], where="bar.trade_date")
            if trade_date not in factors:
                raise AdjustmentError(f"{bar['instrument_id']} {trade_date} 缺复权因子，禁止用 1.0 冒充")
            seen.append(factors[trade_date])
        latest_factor = max(seen, default=None)
    out = []
    for bar in bars:
        trade_date = bar["trade_date"] if hasattr(bar["trade_date"], "isoformat") else parse_date(bar["trade_date"], where="bar.trade_date")
        prices = {k: Decimal(str(bar[k])) for k in ("open", "high", "low", "close")}
        if adj_type != "none":
            factor = factors.get(trade_date)
            if factor is None:
                raise AdjustmentError(f"{bar['instrument_id']} {trade_date} 缺复权因子，禁止用 1.0 冒充")
            for key in prices:
                if adj_type == "hfq":
                    prices[key] = hfq_price(prices[key], factor)
                else:
                    prices[key] = qfq_price(prices[key], factor, latest_factor)
        out.append(
            {
                "trade_date": trade_date.isoformat(),
                "open": prices["open"],
                "high": prices["high"],
                "low": prices["low"],
                "close": prices["close"],
                "volume": bar["volume"],
                "amount": bar["amount"],
            }
        )
    return out
