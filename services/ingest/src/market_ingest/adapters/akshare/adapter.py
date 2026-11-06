"""AKshare 实时行情适配器（东方财富 A 股全市场快照）。

边界（ADR-002 D3/D4）：
- 本文件是唯一允许出现 AKshare/东方财富字段名、单位换算的位置；
- 端口只吐出 canonical 记录（``EXCH:CODE``、元、股）；
- 实时行情走 ``stock_zh_a_spot_em()``（全市场单次快照），不逐标的查询；
- 合规：AKshare 为爬虫封装，仅限内部研究/展示，C 端商用需另行授权（F1 residual）。

单位口径：
- AKshare ``成交量`` 单位为手（1 手 = 100 股）→ canonical 为股；
- AKshare ``成交额`` 单位为元 → canonical 为元；
- AKshare ``最新价/今开/最高/最低/昨收`` 单位为元 → canonical 为元。
"""

from __future__ import annotations

import time
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Mapping, Sequence

from ...models import (
    Board,
    ExchangeCode,
    InstrumentRecord,
    LimitStatus,
    QuoteRecord,
    SourceRef,
    market_now,
    parse_instrument_id,
)
from ...ports import (
    MarketDataSource,
    SourceHealth,
    SourceUnavailableError,
)

#: canonical source 标识（契约 SourceRef.source 取值之一）。
SOURCE_NAME = "akshare_eastmoney"

#: 东方财富代码 → canonical exchange 前缀映射。
_CODE_PREFIX_MAP: dict[str, ExchangeCode] = {
    "6": ExchangeCode.SSE,
    "9": ExchangeCode.BSE,
    "0": ExchangeCode.SZSE,
    "3": ExchangeCode.SZSE,
    "8": ExchangeCode.BSE,
    "4": ExchangeCode.BSE,
}

#: AKshare 中文列名 → canonical 字段映射（仅本文件可见）。
_COL_CODE = "代码"
_COL_NAME = "名称"
_COL_LATEST = "最新价"
_COL_CHANGE_PCT = "涨跌幅"
_COL_CHANGE_AMT = "涨跌额"
_COL_VOLUME = "成交量"
_COL_AMOUNT = "成交额"
_COL_HIGH = "最高"
_COL_LOW = "最低"
_COL_OPEN = "今开"
_COL_PREV_CLOSE = "昨收"


def _code_to_instrument_id(code: str) -> str:
    """6 位数字代码 → canonical ``EXCH:CODE``。"""
    code = str(code).strip().zfill(6)
    prefix = code[0]
    exchange = _CODE_PREFIX_MAP.get(prefix)
    if exchange is None:
        raise ValueError(f"unknown stock code prefix: {code}")
    return f"{exchange}:{code}"


def _to_decimal(value: Any) -> Decimal | None:
    """AKshare 数值 → Decimal；NaN/None → None（禁止补 0，C10）。"""
    if value is None:
        return None
    try:
        d = Decimal(str(value))
        if d != d:  # NaN check
            return None
        return d
    except (InvalidOperation, ValueError):
        return None


def _board_limit_pct(instrument_id: str) -> Decimal | None:
    """按板块返回涨跌停涨跌幅限制（%）。非主板返回 None（无涨跌幅限制或未判定）。

    沪深主板 ±10%；科创板(688/689)/创业板(300/301) ±20%；北交所 ±30%。"""
    code = instrument_id.split(":", 1)[-1]
    exchange = instrument_id.split(":", 1)[0]
    if exchange == "BSE":
        return Decimal("30")
    if code.startswith(("688", "689")):  # 科创板
        return Decimal("20")
    if code.startswith(("300", "301")):  # 创业板
        return Decimal("20")
    return Decimal("10")  # 沪深主板


def _limit_status_for(instrument_id: str, change_pct: Decimal | None) -> LimitStatus:
    """按板块限制判定涨跌停；数据缺失时 fail-closed 归 NONE（不臆断）。"""
    if change_pct is None:
        return LimitStatus.NONE
    limit_pct = _board_limit_pct(instrument_id)
    if limit_pct is None:
        return LimitStatus.NONE
    # 用一个微小容差避免浮点/取整误差漏判，例如 9.97% 视为触板。
    threshold = limit_pct - Decimal("0.1")
    if change_pct >= threshold:
        return LimitStatus.LIMIT_UP
    if change_pct <= -threshold:
        return LimitStatus.LIMIT_DOWN
    return LimitStatus.NONE


def _to_int(value: Any) -> int | None:
    """AKshare 数值 → int；NaN/None → None。"""
    if value is None:
        return None
    try:
        f = float(value)
        if f != f:  # NaN check
            return None
        return int(f)
    except (ValueError, TypeError):
        return None


class AkshareAdapter:
    """``MarketDataSource`` 实现（仅 ``get_quote`` / ``list_realtime_quotes`` 为真实现）。

    其余方法抛 ``NotImplementedError``：AKshare 适配器专用于实时行情快照，
    历史日线仍走 tushare 适配器。
    """

    def __init__(
        self,
        *,
        clock: Callable[[], datetime] = market_now,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._clock = clock
        self._sleep = sleep
        self._snapshot_cache: list[QuoteRecord] | None = None
        self._snapshot_at: datetime | None = None

    def _fetch_snapshot(self) -> list[QuoteRecord]:
        """拉取全市场实时快照并映射为 canonical QuoteRecord 列表。"""
        try:
            import akshare as ak
        except ImportError as exc:
            raise SourceUnavailableError(
                "akshare not installed; pip install akshare",
                retry_after_s=None,
            ) from exc

        try:
            df = ak.stock_zh_a_spot_em()
        except Exception as exc:
            raise SourceUnavailableError(
                f"akshare stock_zh_a_spot_em failed: {exc!r}",
                retry_after_s=60.0,
            ) from exc

        now = self._clock()
        trade_date = now.date()
        source_ref = SourceRef(source=SOURCE_NAME, as_of=now, fetched_at=now)
        results: list[QuoteRecord] = []

        for _, row in df.iterrows():
            try:
                code = str(row[_COL_CODE]).strip()
                instrument_id = _code_to_instrument_id(code)
                parse_instrument_id(instrument_id)
            except (ValueError, KeyError):
                continue

            latest = _to_decimal(row.get(_COL_LATEST))
            prev_close = _to_decimal(row.get(_COL_PREV_CLOSE))
            change_amt = _to_decimal(row.get(_COL_CHANGE_AMT))
            change_pct = _to_decimal(row.get(_COL_CHANGE_PCT))
            open_price = _to_decimal(row.get(_COL_OPEN))
            high = _to_decimal(row.get(_COL_HIGH))
            low = _to_decimal(row.get(_COL_LOW))
            volume_lots = _to_int(row.get(_COL_VOLUME))
            amount = _to_decimal(row.get(_COL_AMOUNT))

            # 手 → 股（1 手 = 100 股）
            volume_shares = volume_lots * 100 if volume_lots is not None else None

            # 涨跌停判定：按板块取真实涨跌幅限制（主板 ±10%、科创/创业 ±20%、北交所 ±30%）。
            # 不可全市场用 ±9.9% 硬编码——科创(688/689)/创业板(300/301)/北交所会误标。
            limit_status = _limit_status_for(instrument_id, change_pct)

            try:
                record = QuoteRecord(
                    instrument_id=instrument_id,
                    trade_date=trade_date,
                    last_price=latest,
                    prev_close=prev_close,
                    change=change_amt,
                    change_pct=change_pct,
                    open=open_price,
                    high=high,
                    low=low,
                    volume=volume_shares,
                    amount=amount,
                    suspended=False,
                    limit_status=limit_status,
                    source=source_ref,
                )
                results.append(record)
            except ValueError:
                continue

        return results

    def list_realtime_quotes(self) -> list[QuoteRecord]:
        """全市场实时行情快照（带 60 秒缓存，避免频繁爬取）。"""
        now = self._clock()
        if (
            self._snapshot_cache is not None
            and self._snapshot_at is not None
            and (now - self._snapshot_at).total_seconds() < 60
        ):
            return self._snapshot_cache

        self._snapshot_cache = self._fetch_snapshot()
        self._snapshot_at = now
        return self._snapshot_cache

    def get_quote(self, instrument_id: str, trade_date: date | None = None) -> QuoteRecord | None:
        """单标的实时行情（从全市场快照中查找）。"""
        parse_instrument_id(instrument_id)
        quotes = self.list_realtime_quotes()
        for q in quotes:
            if q.instrument_id == instrument_id:
                return q
        return None

    def health(self) -> SourceHealth:
        """健康检查：尝试拉取快照，成功即 healthy。"""
        now = self._clock()
        try:
            quotes = self._fetch_snapshot()
            return SourceHealth(
                available=True,
                checked_at=now,
                detail=f"akshare_eastmoney: {len(quotes)} instruments",
            )
        except Exception as exc:
            return SourceHealth(
                available=False,
                checked_at=now,
                detail=f"akshare_eastmoney unavailable: {exc}",
            )

    # --- 以下方法 AKshare 适配器不支持（历史数据走 tushare） ---

    def get_instrument(self, instrument_id: str) -> InstrumentRecord | None:
        raise NotImplementedError("akshare adapter: use tushare for instrument master data")

    def list_instruments(self, exchange: ExchangeCode, as_of: date) -> list[InstrumentRecord]:
        raise NotImplementedError("akshare adapter: use tushare for instrument master data")

    def list_bars(
        self,
        instrument_id: str,
        start: date,
        end: date,
        adjustment: Any,
    ) -> list[Any]:
        raise NotImplementedError("akshare adapter: use tushare for historical bars")

    def get_fundamental_summary(self, instrument_id: str) -> Any:
        raise NotImplementedError("akshare adapter: use tushare for fundamentals")


def create_adapter(options: Mapping[str, Any] | None = None, **kwargs: Any) -> AkshareAdapter:
    """适配器工厂（注册到 ``_ADAPTER_FACTORIES``）。"""
    opts = dict(options or {})
    return AkshareAdapter(**kwargs)
