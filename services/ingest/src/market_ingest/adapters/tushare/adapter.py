"""数据源适配器（首个竖切片：日线 ``list_bars``）。

边界（ADR-002 D3/D4）：
- 本文件及同目录是唯一允许出现数据源字段名/代码后缀/接口名的位置；
- 端口只吐出 canonical 记录；原始行先经 ``capture()`` 注入的 sink 落 ODS（不可变），再映射；
- 每次真实调用（含重试）都经 ``QuotaGuard``；配额耗尽/权限不足不重试，直接冒泡升级；
- 整页字段漂移 → ``SchemaDriftError``（拒绝入库）；单行异常 → ``RejectedRow``（DLQ，不静默丢弃）。
"""

from __future__ import annotations

import time
from urllib.parse import urlsplit
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Iterator, Mapping, Sequence

from ...models import (
    AdjFactorRecord,
    AdjType,
    BarRecord,
    ExchangeCode,
    FundamentalRecord,
    InstrumentRecord,
    QuoteRecord,
    SourceRef,
    SuspensionRecord,
    market_close_at,
    market_now,
    parse_instrument_id,
)
from ...ports import InvalidRequestError, MarketDataSource, RawPage, RawSink, RejectedRow, RejectSink, SchemaDriftError, SourceError, SourceHealth, SourceUnavailableError
from ...quota import CallLedger, InMemoryCallLedger, QuotaGuard, QuotaPolicy
from . import mapper, research, transport as ts_transport

#: canonical source 标识（契约 SourceRef.source 取值之一）。
SOURCE_NAME = "tushare"

#: 并发/分页预算：单次请求行数上限（源侧上限 6000，取保守值）。
DEFAULT_PAGE_LIMIT = 6000

#: 复权因子归一化锚点（老股最早可得因子日；老股无法早于此日锚定）。
#: 归一化约定：归一化因子 = 原始因子 / anchor_factor，1.0 = 该证券最早可得因子日（L3，待 H4 会签）。
ANCHOR_START = date(1990, 12, 19)
FACTOR_QUANT = Decimal("0.000001")

#: 日历/停牌接口字段（按交易日批量取停牌，一次拿全市场，禁止逐标的查询：L8）。
CALENDAR_FIELDS = ("cal_date", "is_open")
SUSPEND_FIELDS = ("ts_code", "trade_date", "suspend_type")
_SUSPEND_TYPE_SUSPENDED = "S"

#: 主数据/财务接口字段（L16/L17：instrument.v1 一次 stock_basic 取全量在册；财务只做切片标的）。
STOCK_BASIC_FIELDS = (
    "ts_code",
    "symbol",
    "name",
    "market",
    "list_date",
    "delist_date",
    "list_status",
    "exchange",
)
FINA_INDICATOR_FIELDS = ("ts_code", "ann_date", "end_date", "eps", "roe", "grossprofit_margin", "or_yoy", "netprofit_yoy")
INCOME_FIELDS = ("ts_code", "ann_date", "end_date", "total_revenue", "n_income_attr_p")
_STOCK_BASIC_API = "stock_basic"
_FINA_INDICATOR_API = "fina_indicator"
_INCOME_API = "income"
_LISTED_STATUS = "L"

#: 环境变量注入点（e2e 录播代理只认这三个中的前两个；FIXTURES_DIR 由代理消费）。
_ENV_API_URL = "TUSHARE_API_URL"
_ENV_MODE = "DATA_SOURCE_MODE"
_ENV_TOKEN = "TUSHARE_TOKEN"
_REPLAY_TOKEN_PLACEHOLDER = "replay-no-auth"


class _Capture:
    __slots__ = ("raw_sink", "reject_sink")

    def __init__(self, raw_sink: RawSink | None, reject_sink: RejectSink | None) -> None:
        self.raw_sink = raw_sink
        self.reject_sink = reject_sink


class TushareAdapter:
    """``MarketDataSource`` 实现（仅 ``list_bars`` 为 S0 竖切片真实现）。"""

    def __init__(
        self,
        transport: ts_transport.SourceTransport,
        *,
        guard: QuotaGuard | None = None,
        source: str = SOURCE_NAME,
        page_limit: int = DEFAULT_PAGE_LIMIT,
        max_attempts: int = 3,
        backoff_s: float = 0.5,
        max_backoff_s: float = 30.0,
        clock: Callable[[], datetime] = market_now,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if page_limit < 1 or max_attempts < 1:
            raise ValueError("page_limit/max_attempts must be >= 1")
        self._transport = transport
        self._guard = guard or QuotaGuard(QuotaPolicy(), InMemoryCallLedger())
        self._source = source
        self._page_limit = page_limit
        self._max_attempts = max_attempts
        self._backoff_s = backoff_s
        self._max_backoff_s = max_backoff_s
        self._clock = clock
        self._sleep = sleep
        self._capture_stack: list[_Capture] = []
        self._last_error: str | None = None
        #: 最近一次 ``fetch_research`` 的批次级元数据（覆盖率等），供 sync 写审计元数据
        #: 而不让业务层解析源字段（H4 m02718：index_member_all 需能标记 current_snapshot_only）。
        self.last_research_meta: dict[str, dict[str, Any]] = {}

    # ---------- raw/DLQ 注入点（A12 fixture 机制与 sync 落库都走这里） ----------

    @contextmanager
    def capture(self, raw_sink: RawSink | None, reject_sink: RejectSink | None = None) -> Iterator[None]:
        """在上下文内把每次源响应交给 ``raw_sink``、每行映射失败交给 ``reject_sink``。"""
        frame = _Capture(raw_sink, reject_sink)
        self._capture_stack.append(frame)
        try:
            yield
        finally:
            self._capture_stack.pop()

    @property
    def _capture(self) -> _Capture | None:
        return self._capture_stack[-1] if self._capture_stack else None

    @property
    def source_endpoint(self) -> str:
        """传输层端点（审计/来源渠道判定；replay 无端点时返回 ``replay``）。"""
        return str(getattr(self._transport, "endpoint", "replay"))

    @property
    def source_channel(self) -> tuple[str, str]:
        """来源通道 + 授权状态（H4 m03258；仅供审计标注，不改变取数行为）。

        官方端点 ≠ 官方授权：token 未取得书面授权前仍标 pending。
        """
        endpoint = self.source_endpoint
        if endpoint == "replay":
            return "replay", "synthetic_replay"
        host = (urlsplit(endpoint).hostname or "").lower()
        if host in {"api.tushare.pro", "api.tushare.com"}:
            return "official_tushare", "pending_official_authorization"
        return "third_party_mirror", "unverified_third_party"

    @property
    def source_name(self) -> str:
        """批次记录/审计用的逻辑名（不暴露给业务逻辑分支）。"""
        return self._source

    # ---------- 端口实现 ----------

    def list_bars(
        self,
        instrument_id: str,
        start: date,
        end: date,
        adjustment: AdjType,
    ) -> list[BarRecord]:
        exchange, code = _require_instrument_id(instrument_id)
        if start > end:
            raise InvalidRequestError(f"start ({start}) must be <= end ({end})")
        try:
            adj = AdjType(adjustment)
        except ValueError as exc:
            raise InvalidRequestError(f"unsupported adjustment: {adjustment!r}") from exc

        source_code = f"{code}.{_SUFFIX[exchange]}"
        if adj is AdjType.NONE:
            rows = self._fetch_rows("daily", ts_transport.DAILY_FIELDS, _range_params(source_code, start, end), dataset="bars")
            mapper.check_bar_fields(rows, endpoint="daily")
            bars = self._map_bars(rows, instrument_id, adj, factor_rows=None)
        else:
            rows = self._fetch_rows("daily", ts_transport.DAILY_FIELDS, _range_params(source_code, start, end), dataset="bars")
            mapper.check_bar_fields(rows, endpoint="daily")
            factor_rows = self._fetch_rows(
                "adj_factor",
                ts_transport.ADJ_FACTOR_FIELDS,
                _range_params(source_code, start, end),
                dataset="adj_factor",
            )
            bars = self._map_bars(rows, instrument_id, adj, factor_rows=factor_rows)
        bars.sort(key=lambda bar: bar.trade_date)
        return bars

    # ---------- 切片外扩展（A2 复权因子 / 停牌证据所需；不属于 MarketDataSource 端口） ----------

    def factor_anchor(self, instrument_id: str) -> tuple[date, Decimal]:
        """取该证券最早可得复权因子作为归一化锚点（``ANCHOR_START`` 起，含老股）。

        结果由调用方持久化（``ingest_factor_anchor``），同一标的不重复抓；
        归一化因子 ``= 原始因子 / anchor``，保证 ``1.0 = 最早可得因子日``。
        """
        exchange, code = _require_instrument_id(instrument_id)
        today = self._clock().date()
        rows = self._fetch_rows(
            "adj_factor",
            ts_transport.ADJ_FACTOR_FIELDS,
            _range_params(f"{code}.{_SUFFIX[exchange]}", ANCHOR_START, today),
            dataset="adj_factor",
        )
        factors = _factor_map(rows)
        if not factors:
            raise SourceUnavailableError(f"no adjustment factor available for {instrument_id} since {ANCHOR_START}")
        first_date = min(factors)
        return first_date, factors[first_date]

    def list_adj_factors(
        self,
        instrument_id: str,
        start: date,
        end: date,
        *,
        anchor: Decimal,
    ) -> list[AdjFactorRecord]:
        """区间内累计复权因子（已按 ``anchor`` 归一化；A2 只存不算，STRUCT-06）。"""
        exchange, code = _require_instrument_id(instrument_id)
        if start > end:
            raise InvalidRequestError(f"start ({start}) must be <= end ({end})")
        if anchor <= 0:
            raise InvalidRequestError(f"anchor factor must be > 0, got {anchor}")
        rows = self._fetch_rows(
            "adj_factor",
            ts_transport.ADJ_FACTOR_FIELDS,
            _range_params(f"{code}.{_SUFFIX[exchange]}", start, end),
            dataset="adj_factor",
        )
        fetched_at = self._clock()
        factors = _factor_map(rows)
        records: list[AdjFactorRecord] = []
        for trade_date in sorted(factors):
            normalized = (factors[trade_date] / anchor).quantize(FACTOR_QUANT)
            if normalized <= 0:
                self._reject(
                    {"trade_date": trade_date.strftime("%Y%m%d"), "adj_factor": str(factors[trade_date])},
                    "normalized adjustment factor is <= 0",
                    instrument_id=instrument_id,
                    trade_date=trade_date,
                    dataset="adj_factor",
                    endpoint="adj_factor",
                )
                continue
            records.append(
                AdjFactorRecord(
                    instrument_id=instrument_id,
                    trade_date=trade_date,
                    factor=normalized,
                    source=SourceRef(source=self._source, as_of=market_close_at(trade_date), fetched_at=fetched_at),
                )
            )
        return records

    def list_trading_days(self, start: date, end: date) -> list[date]:
        """交易日历（一次拿区间内全部开市日；用于区分停牌日与缺数据日）。"""
        if start > end:
            raise InvalidRequestError(f"start ({start}) must be <= end ({end})")
        rows = self._fetch_rows(
            "trade_cal",
            CALENDAR_FIELDS,
            {
                "exchange": "SSE",
                "start_date": start.strftime("%Y%m%d"),
                "end_date": end.strftime("%Y%m%d"),
                "is_open": "1",
            },
            dataset="calendar",
        )
        days: set[date] = set()
        for row in rows:
            try:
                day = mapper.parse_trade_date(row.get("cal_date"))
            except mapper.RowMapError:
                continue
            if str(row.get("is_open", "1")) == "1":
                days.add(day)
        return sorted(days)

    def list_suspensions(
        self,
        dates: Sequence[date],
        instrument_ids: Sequence[str],
    ) -> list[SuspensionRecord]:
        """按交易日批量取全市场停牌名单，过滤出关心的标的（L8：禁止逐标的查询）。"""
        wanted = set(instrument_ids)
        for instrument_id in wanted:
            _require_instrument_id(instrument_id)
        fetched_at = self._clock()
        records: dict[tuple[str, date], SuspensionRecord] = {}
        for day in sorted(set(dates)):
            rows = self._fetch_rows(
                "suspend_d",
                SUSPEND_FIELDS,
                {"trade_date": day.strftime("%Y%m%d"), "suspend_type": _SUSPEND_TYPE_SUSPENDED},
                dataset="suspensions",
            )
            for row in rows:
                if str(row.get("suspend_type")) != _SUSPEND_TYPE_SUSPENDED:
                    continue
                try:
                    exchange, code = mapper.parse_source_code(str(row.get("ts_code")))
                except mapper.RowMapError:
                    continue
                instrument_id = f"{exchange.value}:{code}"
                if instrument_id not in wanted:
                    continue
                records[(instrument_id, day)] = SuspensionRecord(
                    instrument_id=instrument_id,
                    trade_date=day,
                    source=SourceRef(source=self._source, as_of=market_close_at(day), fetched_at=fetched_at),
                )
        return [records[key] for key in sorted(records, key=lambda item: (item[1], item[0]))]

    # ---------- 市场级批量抽取（L11/L12：按交易日一次拉全市场；不进端口） ----------
    #
    # 端口仍是 instrument 粒度的读接口（L12）；这三个方法是 adapter 的批量抽取能力，
    # 供 sync 的 market-wide 模式使用，与 per-instrument 模式共用同一套 mapper/ODS。

    def fetch_market_snapshot(self, trade_date: date) -> list[BarRecord]:
        """某交易日全市场日线（``daily`` 按 ``trade_date`` 一次覆盖全市场，必要时自动分页）。

        行内 ``instrument_id`` 由 ``ts_code`` 逐行换算；坏行落 DLQ，不静默丢（C10）。
        """
        rows = self._fetch_rows(
            "daily",
            ts_transport.DAILY_FIELDS,
            {"trade_date": trade_date.strftime("%Y%m%d")},
            dataset="bars",
        )
        mapper.check_bar_fields(rows, endpoint="daily")
        fetched_at = self._clock()
        source = SourceRef(source=self._source, as_of=market_close_at(trade_date), fetched_at=fetched_at)
        bars: dict[str, BarRecord] = {}
        for row in rows:
            instrument_id = _instrument_from_source_row(row)
            if instrument_id is None:
                self._reject(row, "invalid ts_code", instrument_id=None, trade_date=trade_date)
                continue
            try:
                bar = mapper.map_bar_row(
                    row, instrument_id=instrument_id, adjustment=AdjType.NONE, source=source
                )
            except (mapper.RowMapError, ValueError) as exc:
                self._reject(row, str(exc), instrument_id=instrument_id, trade_date=trade_date)
                continue
            bars[instrument_id] = bar  # 同页重复按源顺序后写覆盖（确定性 C07）
        return [bars[key] for key in sorted(bars)]

    def fetch_market_factors(
        self, trade_date: date, *, anchors: Mapping[str, Decimal]
    ) -> list[AdjFactorRecord]:
        """某交易日全市场复权因子，按各标的锚点归一化后返回（L3：下游不得二次归一）。

        缺锚点的标的行落 DLQ（调用方应先通过 :meth:`factor_anchor` 补齐锚点）。
        """
        rows = self._fetch_rows(
            "adj_factor",
            ts_transport.ADJ_FACTOR_FIELDS,
            {"trade_date": trade_date.strftime("%Y%m%d")},
            dataset="adj_factor",
        )
        fetched_at = self._clock()
        as_of = market_close_at(trade_date)
        records: dict[str, AdjFactorRecord] = {}
        for row in rows:
            instrument_id = _instrument_from_source_row(row)
            if instrument_id is None:
                self._reject(
                    row, "invalid ts_code", instrument_id=None, trade_date=trade_date,
                    dataset="adj_factor", endpoint="adj_factor",
                )
                continue
            try:
                factor = Decimal(str(row.get("adj_factor")))
            except (InvalidOperation, ValueError):
                self._reject(
                    row, "invalid adj_factor", instrument_id=instrument_id, trade_date=trade_date,
                    dataset="adj_factor", endpoint="adj_factor",
                )
                continue
            anchor = anchors.get(instrument_id)
            if anchor is None or anchor <= 0:
                self._reject(
                    row, f"missing anchor factor for {instrument_id}", instrument_id=instrument_id,
                    trade_date=trade_date, dataset="adj_factor", endpoint="adj_factor",
                )
                continue
            normalized = (factor / anchor).quantize(FACTOR_QUANT)
            if normalized <= 0:
                self._reject(
                    row, "normalized adjustment factor is <= 0", instrument_id=instrument_id,
                    trade_date=trade_date, dataset="adj_factor", endpoint="adj_factor",
                )
                continue
            records[instrument_id] = AdjFactorRecord(
                instrument_id=instrument_id,
                trade_date=trade_date,
                factor=normalized,
                source=SourceRef(source=self._source, as_of=as_of, fetched_at=fetched_at),
            )
        return [records[key] for key in sorted(records)]

    def fetch_market_suspensions(self, trade_date: date) -> list[SuspensionRecord]:
        """某交易日全市场停牌名单（一次 ``suspend_d`` 调用；L8 禁止逐标的查询）。"""
        rows = self._fetch_rows(
            "suspend_d",
            SUSPEND_FIELDS,
            {"trade_date": trade_date.strftime("%Y%m%d"), "suspend_type": _SUSPEND_TYPE_SUSPENDED},
            dataset="suspensions",
        )
        fetched_at = self._clock()
        as_of = market_close_at(trade_date)
        records: dict[str, SuspensionRecord] = {}
        for row in rows:
            if str(row.get("suspend_type")) != _SUSPEND_TYPE_SUSPENDED:
                continue
            instrument_id = _instrument_from_source_row(row)
            if instrument_id is None:
                continue
            records[instrument_id] = SuspensionRecord(
                instrument_id=instrument_id,
                trade_date=trade_date,
                source=SourceRef(source=self._source, as_of=as_of, fetched_at=fetched_at),
            )
        return [records[key] for key in sorted(records)]

    # ---------- 研究数据集（KD-AIP0-INF-05：adapter 批量抽取，不进 MarketDataSource 端口） ----------

    @property
    def research_datasets(self) -> tuple[str, ...]:
        """本适配器支持的研究数据集名（CLI/sync 只按名字调度，不认接口）。"""
        return research.research_datasets()

    def research_mode(self, dataset: str) -> str:
        """数据集的抓取形态：daily（按日全市场）/ snapshot（无日期快照）/ per_instrument。"""
        spec = research.RESEARCH_DATASETS.get(dataset)
        if spec is None:
            raise InvalidRequestError(f"unknown research dataset {dataset!r}")
        return spec.mode

    def fetch_research(
        self,
        dataset: str,
        trade_date: date | None = None,
        *,
        index_codes: Sequence[str] = (),
        instrument_id: str | None = None,
        start: date | None = None,
        end: date | None = None,
    ) -> list[dict[str, Any]]:
        """按数据集形态拉取 → canonical ODS 行（字段/单位已归一）。

        - ``daily``：全市场接口一次调用/日；``index_daily`` 按 ``index_codes``（canonical
          ``EXCH:CODE``）逐个指数调用（源要求代码必填）；
        - ``snapshot``：无日期快照，按 ``spec.batch_params`` 分批（如申万 L1/L2/L3）；
        - ``per_instrument``：按单只标的 + 日期区间取历史（财务指标接口形态）；
        - 单行映射失败落 DLQ（``capture()`` 注入），整页字段漂移抛 ``SchemaDriftError``；
        - 无可取数据（无权限/无记录）→ 空列表；**不造数、不补 0**。
        """
        spec = research.RESEARCH_DATASETS.get(dataset)
        if spec is None:
            raise InvalidRequestError(
                f"unknown research dataset {dataset!r}; supported={sorted(research.RESEARCH_DATASETS)}"
            )
        raw_rows: list[dict[str, Any]] = []
        if spec.mode == "per_instrument":
            if instrument_id is None or start is None or end is None:
                raise InvalidRequestError(
                    f"{dataset} requires instrument_id/start/end (per-instrument dataset)"
                )
            if start > end:
                raise InvalidRequestError(f"start {start} is after end {end}")
            try:
                source_code = mapper.to_source_code(instrument_id)
            except ValueError as exc:
                raise InvalidRequestError(f"invalid instrument_id {instrument_id!r}: {exc}") from exc
            raw_rows = self._fetch_rows(
                spec.api_name,
                spec.fields,
                {
                    "ts_code": source_code,
                    "start_date": start.strftime("%Y%m%d"),
                    "end_date": end.strftime("%Y%m%d"),
                },
                dataset=spec.name,
            )
        elif spec.mode == "snapshot":
            for params in spec.batch_params or ({},):
                raw_rows.extend(
                    self._fetch_rows(spec.api_name, spec.fields, dict(params), dataset=spec.name)
                )
        elif spec.requires_index_codes:
            codes = tuple(index_codes)
            if not codes:
                raise InvalidRequestError(f"{dataset} requires --index-codes (canonical EXCH:CODE list)")
            if trade_date is None:
                raise InvalidRequestError(f"{dataset} requires trade_date")
            for code in codes:
                try:
                    source_code = mapper.to_source_code(code)
                except ValueError as exc:
                    raise InvalidRequestError(f"invalid index code {code!r}: {exc}") from exc
                raw_rows.extend(
                    self._fetch_rows(
                        spec.api_name,
                        spec.fields,
                        {"ts_code": source_code, "trade_date": trade_date.strftime("%Y%m%d")},
                        dataset=spec.name,
                    )
                )
        else:
            if trade_date is None:
                raise InvalidRequestError(f"{dataset} requires trade_date")
            raw_rows = self._fetch_rows(
                spec.api_name,
                spec.fields,
                {"trade_date": trade_date.strftime("%Y%m%d")},
                dataset=spec.name,
            )

        rows: list[dict[str, Any]] = []
        for row in raw_rows:
            try:
                rows.append(research.map_row(dataset, row))
            except research.ResearchRowError as exc:
                self._reject(
                    row,
                    str(exc),
                    instrument_id=research.row_instrument(row),
                    trade_date=research.row_date(row) or trade_date,
                    dataset=dataset,
                    endpoint=spec.api_name,
                )
        if spec.mode == "snapshot":
            # H4 m02718：快照 append-only，主键含 snapshot_date（=拉取日，由适配层时钟
            # 决定、可被 MARKET_NOW 钉住），用于区分同日重复运行与历史快照。
            snapshot_date = (trade_date or self._clock().date()).isoformat()
            for canonical in rows:
                canonical[research.SNAPSHOT_DATE_FIELD] = snapshot_date
            rows = research.dedupe_rows(dataset, rows)
        self.last_research_meta[dataset] = {
            "mode": spec.mode,
            "snapshot_date": (trade_date or self._clock().date()).isoformat()
            if spec.mode == "snapshot"
            else None,
            "coverage": (
                "full_history"
                if research.has_historical_members(rows)
                else "current_snapshot_only"
            )
            if dataset == "index_member_all"
            else "full_history",
            "provisional": spec.provisional,
        }
        rows.sort(key=lambda canonical: research.sort_key(dataset, canonical))
        return rows

    def fetch_instruments(self) -> list[InstrumentRecord]:
        """一次 ``stock_basic`` 取全量在册（L17；禁止逐标的查询）。

        ``lot_size`` 源不提供，按板块推导；主数据不是行情快照，``as_of`` 取实际抓取
        时点（早于当日 15:00 时 if 用收盘价会倒挂 fetched_at，C04/A2 loader 会拒）。
        坏行落 DLQ，不整批失败。
        """
        rows = self._fetch_rows(
            _STOCK_BASIC_API, STOCK_BASIC_FIELDS, {"list_status": _LISTED_STATUS}, dataset="instrument"
        )
        fetched_at = self._clock()
        source = SourceRef(source=self._source, as_of=fetched_at, fetched_at=fetched_at)
        by_id: dict[str, InstrumentRecord] = {}
        for row in rows:
            try:
                record = mapper.map_instrument_row(row, source=source)
            except (mapper.RowMapError, ValueError) as exc:
                self._reject(
                    row,
                    str(exc),
                    instrument_id=_instrument_from_source_row(row),
                    trade_date=None,
                    dataset="instrument",
                    endpoint=_STOCK_BASIC_API,
                )
                continue
            by_id[record.instrument_id] = record
        return [by_id[key] for key in sorted(by_id)]

    def get_instrument(self, instrument_id: str) -> InstrumentRecord | None:
        _require_instrument_id(instrument_id)
        for record in self.fetch_instruments():
            if record.instrument_id == instrument_id:
                return record
        return None

    def list_instruments(self, exchange: ExchangeCode, as_of: date) -> list[InstrumentRecord]:
        if not isinstance(exchange, ExchangeCode):
            raise InvalidRequestError(f"exchange must be ExchangeCode: {exchange!r}")
        return [record for record in self.fetch_instruments() if record.exchange is exchange]

    def get_quote(self, instrument_id: str, trade_date: date | None = None) -> QuoteRecord | None:
        raise NotImplementedError("quotes are not in the S0 vertical slice (task-3 scope: bars)")

    def fetch_fundamentals(self, instrument_ids: Sequence[str]) -> list[FundamentalRecord]:
        """切片标的的最近一期财务摘要（``fina_indicator`` 比率 + ``income`` 绝对值）。

        每标的 2 次调用（L16 最小批次）；找不到已披露报告期 → 不产行（合法无数据，
        由 serving 返 404 NOT_FOUND，禁止空对象/0 冒充）。坏行落 DLQ。
        """
        parsed = [(instrument_id, _require_instrument_id(instrument_id)) for instrument_id in instrument_ids]
        results: list[FundamentalRecord] = []
        for instrument_id, (exchange, code) in parsed:
            source_code = mapper.to_source_code(instrument_id)
            fina_rows = self._fetch_rows(
                _FINA_INDICATOR_API,
                FINA_INDICATOR_FIELDS,
                {"ts_code": source_code},
                dataset="fundamental",
            )
            income_rows = self._fetch_rows(
                _INCOME_API, INCOME_FIELDS, {"ts_code": source_code}, dataset="fundamental"
            )
            income_by_end: dict[str, dict[str, Any]] = {}
            for row in income_rows:
                end_key = str(row.get("end_date") or "")
                if end_key:
                    income_by_end[end_key] = row  # 同报告期后写覆盖（取最新披露）
            latest: dict[str, Any] | None = None
            for fina_row in sorted(fina_rows, key=lambda item: str(item.get("end_date") or ""), reverse=True):
                end_key = str(fina_row.get("end_date") or "")
                if end_key and end_key in income_by_end:
                    latest = fina_row
                    break
            if latest is None:
                continue
            fetched_at = self._clock()
            try:
                announced_at = mapper.announced_at_from_date(
                    income_by_end[str(latest.get("end_date"))].get("ann_date") or latest.get("ann_date")
                )
                record = mapper.build_fundamental_record(
                    instrument_id=instrument_id,
                    fina_row=latest,
                    income_row=income_by_end[str(latest.get("end_date"))],
                    source=SourceRef(source=self._source, as_of=announced_at, fetched_at=fetched_at),
                )
            except (mapper.RowMapError, ValueError) as exc:
                self._reject(
                    {**latest, **income_by_end.get(str(latest.get("end_date")), {})},
                    str(exc),
                    instrument_id=instrument_id,
                    trade_date=None,
                    dataset="fundamental",
                    endpoint=_FINA_INDICATOR_API,
                )
                continue
            results.append(record)
        results.sort(key=lambda record: record.instrument_id)
        return results

    def get_fundamental_summary(self, instrument_id: str) -> FundamentalRecord | None:
        records = self.fetch_fundamentals([instrument_id])
        return records[0] if records else None

    def health(self) -> SourceHealth:
        """不额外消耗配额：只回显最近一次调用结果。"""
        return SourceHealth(available=self._last_error is None, checked_at=self._clock(), detail=self._last_error or "")

    # ---------- 内部：调用（限流+重试分类） ----------

    def _call(self, api_name: str, params: Mapping[str, Any], fields: tuple[str, ...]) -> list[dict[str, Any]]:
        last_exc: SourceError | None = None
        for attempt in range(1, self._max_attempts + 1):
            self._guard.acquire(endpoint=api_name)  # 每次真实调用（含重试）都占配额
            try:
                rows = self._transport.call(api_name, params, fields)
            except SourceError as exc:
                self._last_error = str(exc)
                last_exc = exc
                if not exc.retryable or attempt >= self._max_attempts:
                    raise
                wait_s = min(self._max_backoff_s, self._backoff_s * (2 ** (attempt - 1)))
                retry_after = getattr(exc, "retry_after_s", None)
                if retry_after:
                    wait_s = max(wait_s, float(retry_after))
                self._sleep(wait_s)
            else:
                self._last_error = None
                return rows
        assert last_exc is not None
        raise last_exc

    def _fetch_rows(
        self,
        api_name: str,
        fields: tuple[str, ...],
        base_params: Mapping[str, Any],
        *,
        dataset: str = "bars",
    ) -> list[dict[str, Any]]:
        """单接口分页抓取；每页先落 ODS 原始行再返回（重放/审计可追溯）。"""
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            params = dict(base_params, offset=offset, limit=self._page_limit)
            fetched_at = self._clock()
            page_rows = self._call(api_name, params, fields)
            fetched_at = self._clock()
            self._emit_raw_page(api_name, params, page_rows, fetched_at, dataset=dataset)
            rows.extend(page_rows)
            if len(page_rows) < self._page_limit:
                return rows
            offset += self._page_limit

    def _emit_raw_page(
        self,
        api_name: str,
        params: Mapping[str, Any],
        page_rows: list[dict[str, Any]],
        fetched_at: datetime,
        *,
        dataset: str = "bars",
    ) -> None:
        capture = self._capture
        if capture is None or capture.raw_sink is None:
            return
        as_of = _page_as_of(page_rows)
        capture.raw_sink(
            RawPage(
                dataset=dataset,
                endpoint=api_name,
                request_params=dict(params),
                rows=tuple(dict(row) for row in page_rows),
                source=self._source,
                as_of=as_of,
                fetched_at=fetched_at,
            )
        )

    # ---------- 内部：映射 ----------

    def _map_bars(
        self,
        rows: list[dict[str, Any]],
        instrument_id: str,
        adjustment: AdjType,
        *,
        factor_rows: list[dict[str, Any]] | None,
    ) -> list[BarRecord]:
        fetched_at = self._clock()
        factors: dict[date, Decimal] = {}
        base_date: date | None = None
        if factor_rows is not None:
            factors = _factor_map(factor_rows)
            if not factors:
                raise SourceUnavailableError(f"adjustment factor missing for {instrument_id} in requested range")
            base_date = max(factors)
            base_factor = factors[base_date]
            if base_factor == 0:
                raise SchemaDriftError(f"adjustment base factor is zero for {instrument_id} at {base_date}")

        by_date: dict[date, BarRecord] = {}
        for row in rows:
            trade_date: date | None = None
            try:
                trade_date = mapper.parse_trade_date(row.get("trade_date"))
                if factor_rows is not None:
                    assert base_date is not None
                    factor = factors.get(trade_date)
                    if factor is None:
                        raise mapper.RowMapError(f"missing adjustment factor for {trade_date}")
                    ratio = factor / factors[base_date]
                    as_of = market_close_at(base_date)
                else:
                    ratio = None
                    as_of = market_close_at(trade_date)
                bar = mapper.map_bar_row(
                    row,
                    instrument_id=instrument_id,
                    adjustment=adjustment,
                    source=SourceRef(source=self._source, as_of=as_of, fetched_at=fetched_at),
                    factor_ratio=ratio,
                )
            except (mapper.RowMapError, ValueError) as exc:
                self._reject(row, str(exc), instrument_id=instrument_id, trade_date=trade_date)
                continue
            by_date[trade_date] = bar  # 同页重复行按源顺序后写覆盖（确定性 C07）
        return list(by_date.values())

    def _reject(
        self,
        row: Mapping[str, Any],
        reason: str,
        *,
        instrument_id: str | None,
        trade_date: date | None,
        dataset: str = "bars",
        endpoint: str = "daily",
    ) -> None:
        capture = self._capture
        if capture is None or capture.reject_sink is None:
            raise SchemaDriftError(
                f"row cannot be mapped and no DLQ sink is bound ({reason}); refusing to drop silently "
                f"(instrument_id={instrument_id}, trade_date={trade_date})"
            )
        capture.reject_sink(
            RejectedRow(
                dataset=dataset,
                endpoint=endpoint,
                reason=reason,
                payload=dict(row),
                instrument_id=instrument_id,
                trade_date=trade_date,
            )
        )


_SUFFIX: dict[ExchangeCode, str] = {
    ExchangeCode.SSE: "SH",
    ExchangeCode.SZSE: "SZ",
    ExchangeCode.BSE: "BJ",
}


def _require_instrument_id(instrument_id: str) -> tuple[ExchangeCode, str]:
    try:
        return parse_instrument_id(instrument_id)
    except ValueError as exc:
        raise InvalidRequestError(str(exc)) from exc


def _range_params(source_code: str, start: date, end: date) -> dict[str, str]:
    return {
        "ts_code": source_code,
        "start_date": start.strftime("%Y%m%d"),
        "end_date": end.strftime("%Y%m%d"),
    }


def _page_as_of(page_rows: list[dict[str, Any]]) -> datetime | None:
    latest: date | None = None
    for row in page_rows:
        try:
            trade_date = mapper.parse_trade_date(row.get("trade_date"))
        except mapper.RowMapError:
            continue
        if latest is None or trade_date > latest:
            latest = trade_date
    return None if latest is None else market_close_at(latest)


def _factor_map(factor_rows: list[dict[str, Any]]) -> dict[date, Decimal]:
    factors: dict[date, Decimal] = {}
    for row in factor_rows:
        try:
            trade_date = mapper.parse_trade_date(row.get("trade_date"))
            value = row.get("adj_factor")
            if value is None or value == "":
                continue
            factor = Decimal(str(value))
        except (mapper.RowMapError, InvalidOperation):
            continue
        if factor > 0:
            factors[trade_date] = factor
    return factors


def _instrument_from_source_row(row: Mapping[str, Any]) -> str | None:
    """把源行里的证券代码换算成 canonical ``EXCH:CODE``；非法返回 None（调用方落 DLQ）。"""
    value = row.get("ts_code")
    if not value:
        return None
    try:
        exchange, code = mapper.parse_source_code(str(value))
    except mapper.RowMapError:
        return None
    return f"{exchange.value}:{code}"


def create_adapter(
    options: Mapping[str, Any],
    *,
    transport: ts_transport.SourceTransport | None = None,
    guard: QuotaGuard | None = None,
    ledger: CallLedger | None = None,
    clock: Callable[[], datetime] = market_now,
    sleep: Callable[[float], None] = time.sleep,
) -> MarketDataSource:
    """工厂：配置/环境驱动；CI 通过录播注入。

    注入点（A12 task-7 e2e 对齐）：
    - ``transport=`` 直接注入（单测/进程内重放，最高优先级）；
    - ``options["replay_fixture"]`` 文件录播（adapter 内重放，跳过 HTTP）；
    - HTTP 边界录播（默认路径）：所有调用发往 ``options["endpoint"]``，否则读
      ``TUSHARE_API_URL`` 环境变量，否则默认端点。``DATA_SOURCE_MODE=replay`` 仅放松
      占位 token 校验（真实令牌缺失时用占位符，代理不鉴权）；live 模式仍拒绝空令牌。
    选项：``token``/``token_env``（默认 ``TUSHARE_TOKEN``）、``endpoint``、``mode``、
    ``replay_fixture``、``record_path``、``page_limit``、``max_attempts``。
    """
    import os

    page_limit = int(options.get("page_limit", DEFAULT_PAGE_LIMIT))
    max_attempts = int(options.get("max_attempts", 3))

    active_transport = transport
    if active_transport is None:
        fixture = options.get("replay_fixture")
        if fixture:
            active_transport = ts_transport.ReplayTransport.from_file(str(fixture))
        else:
            mode = str(options.get("mode") or os.environ.get(_ENV_MODE, "live")).lower()
            token = str(
                options.get("token")
                or os.environ.get(str(options.get("token_env", _ENV_TOKEN)), "")
            )
            if not token and mode == "replay":
                token = _REPLAY_TOKEN_PLACEHOLDER
            endpoint = str(
                options.get("endpoint") or os.environ.get(_ENV_API_URL) or ts_transport.DEFAULT_ENDPOINT
            )
            active_transport = ts_transport.HttpTransport(token, endpoint=endpoint)
            record_path = options.get("record_path")
            if record_path:
                active_transport = ts_transport.RecordingTransport(active_transport, str(record_path))

    active_guard = guard or QuotaGuard(QuotaPolicy(), ledger or InMemoryCallLedger(), clock=clock, sleep=sleep)
    return TushareAdapter(
        active_transport,
        guard=active_guard,
        page_limit=page_limit,
        max_attempts=max_attempts,
        clock=clock,
        sleep=sleep,
    )
