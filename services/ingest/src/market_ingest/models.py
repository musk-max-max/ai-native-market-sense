"""canonical 内部模型（ADR-002 D2）。

规则：
- 这是唯一允许跨层传递的数据结构；业务层只认这里的字段与 ``EXCH:CODE`` 标识。
- 金额一律 ``Decimal``（禁止 float 累计误差），存储层按 numeric 落库。
- 数据源字段名、代码格式、接口名只允许出现在 ``market_ingest/adapters/`` 下。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from enum import StrEnum

# A 股市场时区固定 +08:00（无夏令时）；C18：所有日期按 Asia/Shanghai。
MARKET_TZ = timezone(timedelta(hours=8))

#: 收盘快照时点：当日 15:00:00+08:00（ADR-002 D4）。
MARKET_CLOSE = time(15, 0, 0)

INSTRUMENT_ID_PATTERN = r"^(SSE|SZSE|BSE):[0-9]{6}$"
_INSTRUMENT_ID_RE = re.compile(r"^(SSE|SZSE|BSE):([0-9]{6})$")
_CODE_RE = re.compile(r"^[0-9]{6}$")


class ExchangeCode(StrEnum):
    SSE = "SSE"
    SZSE = "SZSE"
    BSE = "BSE"


class Board(StrEnum):
    MAIN = "main"
    GEM = "gem"
    STAR = "star"
    BSE = "bse"


class SecurityType(StrEnum):
    STOCK = "stock"
    ETF = "etf"
    INDEX = "index"


class ListStatus(StrEnum):
    LISTED = "listed"
    DELISTED = "delisted"
    PRE_LISTED = "pre_listed"


class AdjType(StrEnum):
    """复权口径（shared AdjType）。缺省 none；新增取值属破坏性变更。"""

    NONE = "none"
    QFQ = "qfq"
    HFQ = "hfq"


class LimitStatus(StrEnum):
    NONE = "none"
    LIMIT_UP = "limit_up"
    LIMIT_DOWN = "limit_down"


def market_now() -> datetime:
    """当前市场时点（+08:00）。注入 clock 时测试可替换。

    ``MARKET_NOW``（ISO 8601，必须带时区，例如 ``2026-11-03T15:00:00+08:00``）
    用于 e2e/回放的确定性时钟：录播的 adj_factor 锚点区间依赖它，否则隔天
    重放就会 fixture miss（A12 m01420）。
    """
    raw = os.environ.get("MARKET_NOW", "").strip()
    if raw:
        try:
            value = datetime.fromisoformat(raw)
        except ValueError as exc:
            raise ValueError(
                f"MARKET_NOW must be ISO 8601 datetime, got {raw!r}"
            ) from exc
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("MARKET_NOW must be timezone-aware, e.g. 2026-11-03T15:00:00+08:00")
        return value.astimezone(MARKET_TZ)
    return datetime.now(tz=MARKET_TZ)


def market_close_at(trade_date: date) -> datetime:
    """某交易日的收盘市场时点 15:00:00+08:00。"""
    return datetime.combine(trade_date, MARKET_CLOSE, tzinfo=MARKET_TZ)


def require_market_tz(value: datetime, *, field: str) -> datetime:
    """强制 +08:00 时区且 tz-aware（C04/C18）。"""
    if value.tzinfo is None:
        raise ValueError(f"{field} must be timezone-aware (+08:00)")
    if value.utcoffset() != MARKET_TZ.utcoffset(value):
        raise ValueError(f"{field} must be Asia/Shanghai (+08:00), got {value.utcoffset()}")
    return value


def parse_instrument_id(instrument_id: str) -> tuple[ExchangeCode, str]:
    """``EXCH:CODE`` → (交易所, 6 位代码)；非法格式抛 ValueError。"""
    match = _INSTRUMENT_ID_RE.fullmatch(instrument_id)
    if match is None:
        raise ValueError(f"instrument_id must match {INSTRUMENT_ID_PATTERN}: {instrument_id!r}")
    return ExchangeCode(match.group(1)), match.group(2)


def make_instrument_id(exchange: ExchangeCode, code: str) -> str:
    """(交易所, 6 位代码) → ``EXCH:CODE``。"""
    if _CODE_RE.fullmatch(code) is None:
        raise ValueError(f"code must be 6 digits: {code!r}")
    return f"{exchange.value}:{code}"


@dataclass(frozen=True, slots=True)
class SourceRef:
    """来源与时效元数据（ADR-002 D2）。

    - ``source``：canonical 源标识（换源只换取值，不改结构）。
    - ``as_of``：数据对应的市场时点（+08:00），不是抓取时间。
    - ``fetched_at``：采集时间，仅内部审计用；禁止与 ``as_of`` 混用（C04）。
    """

    source: str
    as_of: datetime
    fetched_at: datetime

    def __post_init__(self) -> None:
        if not self.source:
            raise ValueError("source.source must be non-empty (C03)")
        require_market_tz(self.as_of, field="source.as_of")
        require_market_tz(self.fetched_at, field="source.fetched_at")


@dataclass(frozen=True, slots=True)
class InstrumentRecord:
    instrument_id: str
    exchange: ExchangeCode
    code: str
    name: str
    board: Board
    security_type: SecurityType
    list_status: ListStatus
    lot_size: int
    listed_at: date | None
    source: SourceRef

    def __post_init__(self) -> None:
        parse_instrument_id(self.instrument_id)
        if self.lot_size < 1:
            raise ValueError("lot_size must be >= 1")


@dataclass(frozen=True, slots=True)
class QuoteRecord:
    instrument_id: str
    trade_date: date
    last_price: Decimal | None
    prev_close: Decimal | None
    change: Decimal | None
    change_pct: Decimal | None
    open: Decimal | None
    high: Decimal | None
    low: Decimal | None
    volume: int | None
    amount: Decimal | None
    suspended: bool
    limit_status: LimitStatus
    source: SourceRef

    def __post_init__(self) -> None:
        parse_instrument_id(self.instrument_id)
        if self.volume is not None and self.volume < 0:
            raise ValueError("volume must be >= 0")


@dataclass(frozen=True, slots=True)
class BarRecord:
    """单日 K 线 canonical 记录。

    ``open/high/low/close`` 为 Decimal（元）；``volume`` 为股（int）；``amount`` 为元。
    ``adjustment`` 回显实际生效口径（C06）；缺失价格禁止补 0（C10）。
    """

    instrument_id: str
    trade_date: date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    amount: Decimal
    adjustment: AdjType
    source: SourceRef
    #: 前收盘价（M08 涨跌幅基准；ODS bar.v1 可选字段）。上市首日/无前收为 None，禁止补 0。
    prev_close: Decimal | None = None

    def __post_init__(self) -> None:
        parse_instrument_id(self.instrument_id)
        for field in ("open", "high", "low", "close"):
            value = getattr(self, field)
            if not isinstance(value, Decimal):
                raise TypeError(f"bar.{field} must be Decimal")
            if value <= 0:
                raise ValueError(f"bar.{field} must be > 0 (缺失价格禁止补 0，C10)")
        if self.prev_close is not None:
            if not isinstance(self.prev_close, Decimal):
                raise TypeError("bar.prev_close must be Decimal or None")
            if self.prev_close <= 0:
                raise ValueError("bar.prev_close must be > 0 (缺失禁止补 0，C10)")
        if self.volume < 0:
            raise ValueError("bar.volume must be >= 0")
        if self.amount < 0:
            raise ValueError("bar.amount must be >= 0")
        if self.high < max(self.open, self.close) or self.low > min(self.open, self.close):
            raise ValueError("bar OHLC inconsistent: high>=max(open,close)>=min(open,close)>=low")


@dataclass(frozen=True, slots=True)
class AdjFactorRecord:
    """累计复权因子 canonical 记录（ODS ``adj_factor.v1`` 行）。

    ``factor`` 为累计因子，归一化约定 ``1.0 = 该证券最早可得因子日``
    （老股锚点 = 1990-12-19，因 A 股历史数据起点早于此日的老股无法更早锚定）。
    DWD 只存该因子与不复权 OHLC，qfq/hfq 由 A2 确定性重算（ADR-002 D2）。
    """

    instrument_id: str
    trade_date: date
    factor: Decimal
    source: SourceRef

    def __post_init__(self) -> None:
        parse_instrument_id(self.instrument_id)
        if not isinstance(self.factor, Decimal):
            raise TypeError("factor must be Decimal")
        if self.factor <= 0:
            raise ValueError("factor must be > 0 (STRUCT-06)")


@dataclass(frozen=True, slots=True)
class SuspensionRecord:
    """停牌证据记录（ODS ``bar.v1`` 的 ``suspended: true`` 行，C08）。

    停牌日没有 OHLC：这里只记录「该交易日确实无行情」这一事实，禁止补 0 或合成 K 线。
    A2 的 COMP-03 用它区分「停牌」与「缺数据」，避免整批判 blocker。
    """

    instrument_id: str
    trade_date: date
    source: SourceRef

    def __post_init__(self) -> None:
        parse_instrument_id(self.instrument_id)


@dataclass(frozen=True, slots=True)
class FundamentalRecord:
    instrument_id: str
    report_period: str
    report_end_date: date
    announced_at: datetime
    statement_basis: str
    currency: str
    revenue: Decimal
    net_profit: Decimal
    revenue_yoy_pct: Decimal | None
    net_profit_yoy_pct: Decimal | None
    eps: Decimal | None
    roe_pct: Decimal | None
    gross_margin_pct: Decimal | None
    total_assets: Decimal | None
    source: SourceRef

    def __post_init__(self) -> None:
        parse_instrument_id(self.instrument_id)
        if re.fullmatch(r"[0-9]{4}Q[1-4]", self.report_period) is None:
            raise ValueError("report_period must match ^\\d{4}Q[1-4]$ (C13)")
        require_market_tz(self.announced_at, field="announced_at")
        if self.announced_at.date() < self.report_end_date:
            raise ValueError("announced_at must be >= report_end_date (C13)")
