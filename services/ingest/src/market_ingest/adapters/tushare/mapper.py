"""原始行 → canonical 记录的映射与单位换算（只在适配层内执行）。

单位约定（ADR-002 D2 / C09）：
- 源 ``vol`` 单位是「手」，canonical 的 ``volume`` 单位是「股」→ ×100；
- 源 ``amount`` 单位是「千元」，canonical 的 ``amount`` 单位是「元」→ ×1000；
- 价格单位两边一致（元），不做换算，只做 Decimal 化。
- 缺失价格不得补 0；非法/缺失行必须走 DLQ（``RowMapError``），由调用方落 ``RejectedRow``。
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Mapping, Sequence

from ...models import (
    AdjType,
    BarRecord,
    Board,
    ExchangeCode,
    FundamentalRecord,
    InstrumentRecord,
    ListStatus,
    SecurityType,
    SourceRef,
    make_instrument_id,
    market_close_at,
    parse_instrument_id,
)

#: 交易所后缀映射（源代码格式只在适配层出现）。
_EXCHANGE_SUFFIX: dict[str, ExchangeCode] = {
    "SH": ExchangeCode.SSE,
    "SZ": ExchangeCode.SZSE,
    "BJ": ExchangeCode.BSE,
}
_SUFFIX_BY_EXCHANGE: dict[ExchangeCode, str] = {v: k for k, v in _EXCHANGE_SUFFIX.items()}

#: 价格复权后保留小数位（与 A 股报价一致）；四舍五入保持 OHLC 偏序不变。
_PRICE_QUANT = Decimal("0.01")

_REQUIRED_BAR_FIELDS = ("trade_date", "open", "high", "low", "close", "vol", "amount")


class RowMapError(ValueError):
    """单行映射失败：进 DLQ，禁止静默丢弃。"""


def parse_source_code(value: Any) -> tuple[ExchangeCode, str]:
    """源代码 ``600519.SH`` → (SSE, ``600519``)。格式非法抛 ``RowMapError``。"""
    if not isinstance(value, str) or "." not in value:
        raise RowMapError(f"invalid source code: {value!r}")
    code, _, suffix = value.partition(".")
    exchange = _EXCHANGE_SUFFIX.get(suffix.upper())
    if exchange is None:
        raise RowMapError(f"unknown exchange suffix: {suffix!r} in {value!r}")
    if len(code) != 6 or not code.isdigit():
        raise RowMapError(f"invalid 6-digit code: {code!r} in {value!r}")
    return exchange, code


def to_source_code(instrument_id: str) -> str:
    """``EXCH:CODE`` → 源代码格式（仅适配层内部/测试使用）。"""
    exchange, code = parse_instrument_id(instrument_id)
    return f"{code}.{_SUFFIX_BY_EXCHANGE[exchange]}"


def to_instrument_id(value: Any) -> str:
    exchange, code = parse_source_code(value)
    return make_instrument_id(exchange, code)


def parse_trade_date(value: Any) -> date:
    """源交易日 ``YYYYMMDD`` → ``date``。"""
    if not isinstance(value, str) or len(value) != 8 or not value.isdigit():
        raise RowMapError(f"invalid trade_date: {value!r}")
    try:
        return datetime.strptime(value, "%Y%m%d").date()
    except ValueError as exc:
        raise RowMapError(f"invalid trade_date: {value!r}") from exc


def check_bar_fields(rows: Sequence[Mapping[str, Any]], *, endpoint: str) -> None:
    """整页字段缺失/类型漂移 → SchemaDriftError（拒绝入库，不猜测补齐）。"""
    from ...ports import SchemaDriftError

    if not rows:
        return
    first = rows[0]
    missing = [field for field in _REQUIRED_BAR_FIELDS if field not in first]
    if missing:
        raise SchemaDriftError(f"source schema drift on {endpoint}: missing fields {missing}; present={sorted(first)}")


def _dec(value: Any, field: str) -> Decimal:
    if value is None or value == "":
        raise RowMapError(f"missing {field} (禁止补 0/C10)")
    try:
        return Decimal(str(value))
    except InvalidOperation as exc:
        raise RowMapError(f"invalid {field}: {value!r}") from exc


def _int(value: Any, field: str) -> int:
    if value is None or value == "":
        raise RowMapError(f"missing {field}")
    try:
        return int(Decimal(str(value)))
    except (InvalidOperation, ValueError) as exc:
        raise RowMapError(f"invalid {field}: {value!r}") from exc


def map_bar_row(
    row: Mapping[str, Any],
    *,
    instrument_id: str,
    adjustment: AdjType,
    source: SourceRef,
    factor_ratio: Decimal | None = None,
) -> BarRecord:
    """一行原始日线 → ``BarRecord``（含手→股、千元→元换算）。"""
    trade_date = parse_trade_date(row.get("trade_date"))

    open_ = _dec(row.get("open"), "open")
    high = _dec(row.get("high"), "high")
    low = _dec(row.get("low"), "low")
    close = _dec(row.get("close"), "close")
    volume_lots = _int(row.get("vol"), "vol")
    amount_k = _dec(row.get("amount"), "amount")

    if factor_ratio is not None:
        open_ = (open_ * factor_ratio).quantize(_PRICE_QUANT, rounding=ROUND_HALF_UP)
        high = (high * factor_ratio).quantize(_PRICE_QUANT, rounding=ROUND_HALF_UP)
        low = (low * factor_ratio).quantize(_PRICE_QUANT, rounding=ROUND_HALF_UP)
        close = (close * factor_ratio).quantize(_PRICE_QUANT, rounding=ROUND_HALF_UP)

    prev_close: Decimal | None = None
    raw_prev = row.get("pre_close")
    if raw_prev not in (None, ""):
        prev_close = _dec(raw_prev, "pre_close")
        if prev_close <= 0:
            raise RowMapError(f"invalid pre_close: {raw_prev!r} (缺失/非法禁止补 0，C10)")
        if factor_ratio is not None:
            prev_close = (prev_close * factor_ratio).quantize(_PRICE_QUANT, rounding=ROUND_HALF_UP)

    return BarRecord(
        instrument_id=instrument_id,
        trade_date=trade_date,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume_lots * 100,  # 手 → 股
        amount=amount_k * 1000,  # 千元 → 元
        adjustment=adjustment,
        source=source,
        prev_close=prev_close,
    )


# --------------------------------------------------------------------------
# 主数据（instrument.v1）：一次 stock_basic 取全量在册
# --------------------------------------------------------------------------

#: 源 list_status → canonical。源只暴露三态；新增取值必须显式补映射（否则行进 DLQ）。
_LIST_STATUS_MAP: dict[str, ListStatus] = {
    "L": ListStatus.LISTED,
    "D": ListStatus.DELISTED,
    "P": ListStatus.PRE_LISTED,
}

#: 板块由代码前缀推导（源 ``market`` 是中文枚举，禁止漏进 canonical）。
#: 688/689=科创板；300/301=创业板；8xx/4xx=北交所；其余按主板。
from ...instruments import board_for_code, lot_size_for_code, lot_size_for_board  # noqa: F401  (canonical 领域规则)


def map_instrument_row(row: Mapping[str, Any], *, source: SourceRef) -> InstrumentRecord:
    """一行 ``stock_basic`` → ``InstrumentRecord``；缺字段/非法枚举抛 ``RowMapError``。"""
    raw_code = row.get("ts_code")
    exchange, code = parse_source_code(raw_code)
    name = row.get("name")
    if not isinstance(name, str) or not name.strip():
        raise RowMapError(f"missing name for {raw_code!r}")
    raw_status = row.get("list_status")
    status = _LIST_STATUS_MAP.get(str(raw_status)) if raw_status is not None else None
    if status is None:
        raise RowMapError(f"unknown list_status {raw_status!r} for {raw_code!r}")
    listed_at: date | None = None
    raw_listed = row.get("list_date")
    if raw_listed not in (None, ""):
        listed_at = parse_trade_date(raw_listed)
    board = board_for_code(exchange, code)
    return InstrumentRecord(
        instrument_id=make_instrument_id(exchange, code),
        exchange=exchange,
        code=code,
        name=name.strip(),
        board=board,
        security_type=SecurityType.STOCK,
        list_status=status,
        lot_size=lot_size_for_code(exchange, code),
        listed_at=listed_at,
        source=source,
    )


# --------------------------------------------------------------------------
# 财务摘要（fundamental.v1）：fina_indicator（比率）+ income（绝对值）
# --------------------------------------------------------------------------

#: 报告期 → 季度（Q4 = 年报口径）。源只有 3/6/9/12 月末，其余视为漂移。
_QUARTER_BY_MONTH: dict[int, int] = {3: 1, 6: 2, 9: 3, 12: 4}


def parse_report_period(end_date: date) -> str:
    quarter = _QUARTER_BY_MONTH.get(end_date.month)
    if quarter is None:
        raise RowMapError(f"invalid report_end_date {end_date.isoformat()} (只接受 3/6/9/12 月末)")
    return f"{end_date.year}Q{quarter}"


def announced_at_from_date(value: Any) -> datetime:
    """源公告日只有日期：按「公告日收盘时点」作为可得时点（保守下界），统一 +08:00。"""
    day = parse_trade_date(value)
    return market_close_at(day)


def _opt_dec(value: Any) -> Decimal | None:
    """可空字段：缺失/空 → None（禁止补 0，C10）。"""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation as exc:
        raise RowMapError(f"invalid decimal: {value!r}") from exc


def build_fundamental_record(
    *,
    instrument_id: str,
    fina_row: Mapping[str, Any],
    income_row: Mapping[str, Any],
    source: SourceRef,
) -> FundamentalRecord:
    """``fina_indicator`` 行 + 同报告期 ``income`` 行 → ``FundamentalRecord``（reported 口径）。"""
    if fina_row.get("end_date") != income_row.get("end_date"):
        raise RowMapError(
            f"report period mismatch: fina={fina_row.get('end_date')!r} income={income_row.get('end_date')!r}"
        )
    end_date = parse_trade_date(income_row.get("end_date"))
    announced_raw = income_row.get("ann_date") or fina_row.get("ann_date")
    if announced_raw in (None, ""):
        raise RowMapError(f"missing ann_date for {instrument_id} period {end_date.isoformat()}")
    announced_at = announced_at_from_date(announced_raw)
    if announced_at.date() < end_date:
        raise RowMapError(f"ann_date {announced_raw!r} earlier than report_end_date {end_date.isoformat()}")
    return FundamentalRecord(
        instrument_id=instrument_id,
        report_period=parse_report_period(end_date),
        report_end_date=end_date,
        announced_at=announced_at,
        statement_basis="reported",  # 首版只产原始披露口径；restated 待 tushare 口径确认（L3 会签范围）
        currency="CNY",
        revenue=_dec(income_row.get("total_revenue"), "total_revenue"),
        net_profit=_dec(income_row.get("n_income_attr_p"), "n_income_attr_p"),
        revenue_yoy_pct=_opt_dec(fina_row.get("or_yoy")),
        net_profit_yoy_pct=_opt_dec(fina_row.get("netprofit_yoy")),
        eps=_opt_dec(fina_row.get("eps")),
        roe_pct=_opt_dec(fina_row.get("roe")),
        gross_margin_pct=_opt_dec(fina_row.get("grossprofit_margin")),
        total_assets=None,
        source=source,
    )
