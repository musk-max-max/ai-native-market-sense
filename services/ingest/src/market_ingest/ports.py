"""数据源端口（六边形端口，ADR-002 D1）与适配层→接入层的边界类型。

端口只返回 canonical 记录或 ``None``，不返回数据源原始结构；不返回 entitlement。
错误分类（适配层内部，禁止把数据源异常直接穿透到 API）：

- ``None``：合法标识但无数据/未收录（API 映射 404）。
- ``InvalidRequestError``：参数非法（API 映射 400 VALIDATION_ERROR）。
- ``SourceUnavailableError``：源不可用/超时/限流 → API 走降级（C17）。
- ``SchemaDriftError``：源字段/类型变化 → 告警 + 拒绝入库，不得猜测补齐。

配额与权限是 ``SourceUnavailableError`` 的非重试子类：
- ``QuotaExhaustedError``：配额/积分耗尽 → 停止重试、落 checkpoint、留待续跑（must_escalate）。
- ``SourceAuthError``：接口权限不足/授权范围不足 → 停止重试并升级（must_escalate）。
两者仍是 ``SourceUnavailableError``，因此 API 降级路径不变（ADR-002 分类不被扩改），
而 ``retryable`` 让重试器能区分「可重试」与「配额/权限」。见 roster system_prompt 规则 2。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Mapping, Protocol, runtime_checkable

from .models import AdjType, BarRecord, ExchangeCode, FundamentalRecord, InstrumentRecord, QuoteRecord


class SourceError(Exception):
    """适配层错误基类；``retryable`` 供重试器判定。"""

    retryable: bool = False


class InvalidRequestError(SourceError):
    """参数非法（不是源故障，不重试）。"""

    retryable = False


class SourceUnavailableError(SourceError):
    """源不可用/超时/限流（默认可重试，带退避）。"""

    retryable = True

    def __init__(self, message: str, *, retry_after_s: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class QuotaExhaustedError(SourceUnavailableError):
    """配额/积分耗尽：不得重试，必须落 checkpoint 可续跑，并升级。"""

    retryable = False


class SourceAuthError(SourceUnavailableError):
    """接口权限/授权范围不足：不得重试，必须升级（must_escalate）。"""

    retryable = False


class SchemaDriftError(SourceError):
    """源字段/类型变化：告警 + 拒绝入库，不得猜测补齐。"""

    retryable = False


@dataclass(frozen=True, slots=True)
class SourceHealth:
    """健康状态；适配器不得为探测健康而额外消耗配额（基于最近一次调用结果）。"""

    available: bool
    checked_at: datetime
    detail: str = ""


@dataclass(frozen=True, slots=True)
class RawPage:
    """一次源接口调用的原始响应用于 ODS 审计与重放（ADR-002 D3）。

    ``payload`` 是数据源原始结构（源字段名只在其内部出现）；ODS 层不解析它，
    只保证「不可变、可追溯、可重放」。``as_of`` 是数据市场时点，``fetched_at`` 是采集时间。
    """

    dataset: str
    endpoint: str
    request_params: Mapping[str, Any]
    rows: tuple[Mapping[str, Any], ...]
    source: str
    as_of: datetime | None
    fetched_at: datetime


@dataclass(frozen=True, slots=True)
class RejectedRow:
    """映射失败被拒绝的原始行（必须落 DLQ 并告警，禁止静默丢弃，ADR-002 D5）。"""

    dataset: str
    endpoint: str
    reason: str
    payload: Mapping[str, Any]
    instrument_id: str | None = None
    trade_date: date | None = None


class RawSink(Protocol):
    def __call__(self, page: RawPage, /) -> None: ...


class RejectSink(Protocol):
    def __call__(self, row: RejectedRow, /) -> None: ...


@runtime_checkable
class MarketDataSource(Protocol):
    """数据源端口。首个竖切片实现 ``list_bars``，其余方法为 P0 后续扩展点位。

    签名变更须 A0 评审 + H2/H4 按跨域数据模型变更门禁（ADR-002）。
    """

    def get_instrument(self, instrument_id: str) -> InstrumentRecord | None: ...

    def list_instruments(self, exchange: ExchangeCode, as_of: date) -> list[InstrumentRecord]: ...

    def get_quote(self, instrument_id: str, trade_date: date | None = None) -> QuoteRecord | None: ...

    def list_bars(
        self,
        instrument_id: str,
        start: date,
        end: date,
        adjustment: AdjType,
    ) -> list[BarRecord]: ...

    def get_fundamental_summary(self, instrument_id: str) -> FundamentalRecord | None: ...

    def health(self) -> SourceHealth: ...
