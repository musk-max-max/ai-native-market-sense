"""同步服务：分块 + checkpoint 断点续跑 + 预算/中断 + raw 落库 + ODS 批次导出。

可中断/可续跑语义：
- 每完成一个 chunk 就推进 ``checkpoint(last_success_trade_date = chunk_end)``；
- 中断（信号/配额耗尽）只停止后续 chunk，已完成 chunk 的 checkpoint 与 ODS 批次已落盘；
- 下次运行从 ``checkpoint + 1 天`` 开始，重复区间不重抓（幂等，C15）。

只采「不复权」源真值（ADR-002 D2：DWD 存不复权 bar + 复权因子，复权在读侧/DWD 计算），
避免同一条事实以三种口径重复落 ODS 并放大配额消耗。

ODS 导出（A1 → A2 交换格式 v1）按块成批：
- 每个成功 chunk 写一个 ``bar.v1`` 批次（含该块内的停牌证据行 ``suspended: true``）；
- 每个标的每个运行窗口写一个 ``adj_factor.v1`` 批次（已按锚点归一化）；
- 中断后重跑只补剩余块，不会在已完成区间产生缺口。
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable, Iterator, Sequence
from contextlib import nullcontext
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

from . import ods
from .models import (
    AdjFactorRecord,
    AdjType,
    BarRecord,
    FundamentalRecord,
    InstrumentRecord,
    SourceRef,
    SuspensionRecord,
    market_close_at,
    market_now,
)
from .ports import (
    MarketDataSource,
    QuotaExhaustedError,
    RawPage,
    RejectedRow,
    SchemaDriftError,
    SourceAuthError,
    SourceUnavailableError,
)
from .quota import QuotaGuard
from .storage import SqliteStorage

#: 触发 ODS 导出所需的数据源扩展方法（不在 MarketDataSource 端口内，A2 专用）。
_ODS_SOURCE_METHODS = (
    "list_adj_factors",
    "factor_anchor",
    "list_trading_days",
    "list_suspensions",
    "fetch_market_snapshot",
    "fetch_market_factors",
    "fetch_market_suspensions",
)
#: market-wide 模式的 checkpoint scope：checkpoint = 已完成的最后一个交易日。
_MARKET_SCOPE = "market"
#: 快照数据集的 checkpoint scope（无交易日概念，按「同步日」幂等）。
_SNAPSHOT_SCOPE = "snapshot"


@dataclass(frozen=True, slots=True)
class SyncRequest:
    instruments: tuple[str, ...]
    start: date
    end: date
    chunk_days: int = 8766
    dataset: str = "bars"
    #: True = 按交易日全市场批量拉取（L11 P0 默认模式）；instruments 仅作 per-instrument 模式用。
    market_wide: bool = False

    def __post_init__(self) -> None:
        if not self.instruments and not self.market_wide:
            raise ValueError("instruments must not be empty in per-instrument mode")
        if self.chunk_days < 1:
            raise ValueError("chunk_days must be >= 1")
        if self.start > self.end:
            raise ValueError("start must be <= end")


@dataclass(frozen=True, slots=True)
class SyncResult:
    batch_id: str
    dataset: str
    status: str  # succeeded | interrupted | failed
    halted_reason: str | None
    instruments_total: int
    instruments_completed: int
    instruments_skipped: int
    chunks_done: int
    rows_ingested: int
    factor_rows: int
    suspended_rows: int
    rejected_rows: int
    calls_used: int
    ods_batches: int
    started_at: datetime
    finished_at: datetime
    checkpoint_scopes: dict[str, str] = field(default_factory=dict)

    def summary(self) -> dict[str, object]:
        return {
            "batch_id": self.batch_id,
            "dataset": self.dataset,
            "status": self.status,
            "halted_reason": self.halted_reason,
            "instruments_total": self.instruments_total,
            "instruments_completed": self.instruments_completed,
            "instruments_skipped": self.instruments_skipped,
            "chunks_done": self.chunks_done,
            "rows_ingested": self.rows_ingested,
            "factor_rows": self.factor_rows,
            "suspended_rows": self.suspended_rows,
            "rejected_rows": self.rejected_rows,
            "calls_used": self.calls_used,
            "ods_batches": self.ods_batches,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat(),
            "checkpoint_scopes": dict(self.checkpoint_scopes),
        }


def iter_chunks(start: date, end: date, chunk_days: int) -> Iterator[tuple[date, date]]:
    """按自然日切块，最后一块截断到 ``end``。"""
    cursor = start
    while cursor <= end:
        chunk_end = min(end, cursor + timedelta(days=chunk_days - 1))
        yield cursor, chunk_end
        cursor = chunk_end + timedelta(days=1)


def chunk_count(start: date, end: date, chunk_days: int) -> int:
    return sum(1 for _ in iter_chunks(start, end, chunk_days))


def _approx_pages(start: date, end: date, *, page_limit: int, trading_days_per_year: int = 243) -> int:
    days = (end - start).days + 1
    approx_rows = int(days / 366 * trading_days_per_year) + 1
    return max(1, -(-approx_rows // page_limit))


def estimate_calls(
    instruments: int,
    start: date,
    end: date,
    *,
    chunk_days: int,
    page_limit: int,
    trading_days_per_year: int = 243,
) -> int:
    """日线调用估算（兼容旧接口；优先用 :func:`estimate_plan` 看完整预算分解）。"""
    if instruments < 1:
        return 0
    total = 0
    for chunk_start, chunk_end in iter_chunks(start, end, chunk_days):
        total += _approx_pages(chunk_start, chunk_end, page_limit=page_limit, trading_days_per_year=trading_days_per_year)
    return total * instruments


def estimate_plan(
    instruments: int,
    start: date,
    end: date,
    *,
    chunk_days: int,
    page_limit: int,
    calls_per_minute: int = 500,
    reserve_ratio: float = 0.2,
    first_run: bool = True,
    trading_days_per_year: int = 243,
) -> dict[str, Any]:
    """回补预算分解（四列口径：每标的调用 × 标的数 = 总数 ÷ 单分钟配额 = 预计耗时）。

    - ``bars``：分块后每块的日线页数；
    - ``factors``：整个窗口的复权因子页数（每标的 1 次窗口抓取，含分页）；
    - ``anchor``：首次运行每标的 1 次锚点抓取（1990-12-19 起的因子页数，通常 2 页，按 2 计）；
    - ``suspensions``：按交易日批量取停牌，最多「区间内交易日数」次（全市场共享，非每标的）；
      实际只在出现「交易日无 bar」时才调用，正常行情下接近 0。
    """
    if instruments < 1:
        return {"instruments": 0, "calls_per_instrument": 0, "total_calls": 0}
    bars = estimate_calls(
        instruments, start, end, chunk_days=chunk_days, page_limit=page_limit,
        trading_days_per_year=trading_days_per_year,
    )
    factor_pages = _approx_pages(start, end, page_limit=page_limit, trading_days_per_year=trading_days_per_year)
    factors = factor_pages * instruments
    anchor_pages_per_instrument = _approx_pages(date(1990, 12, 19), end, page_limit=page_limit, trading_days_per_year=trading_days_per_year)
    anchors = anchor_pages_per_instrument * instruments if first_run else 0
    trading_days = int(((end - start).days + 1) / 366 * trading_days_per_year) + 1
    # 停牌证据：每交易日最多 1 次（全市场一次拿完），不是每标的一次（L8）。
    suspensions_upper = trading_days
    per_instrument = bars // instruments + factor_pages + (anchor_pages_per_instrument if first_run else 0)
    total = bars + factors + anchors + suspensions_upper
    effective_per_minute = max(1, int(calls_per_minute * (1.0 - reserve_ratio)))
    eta_minutes = -(-total // effective_per_minute)
    return {
        "instruments": instruments,
        "chunks_per_instrument": chunk_count(start, end, chunk_days),
        "bars_calls_per_instrument": bars // instruments,
        "factor_calls_per_instrument": factor_pages,
        "anchor_calls_per_instrument": anchor_pages_per_instrument if first_run else 0,
        "calls_per_instrument": per_instrument,
        "bars_calls": bars,
        "factor_calls": factors,
        "anchor_calls": anchors,
        "suspension_calls_upper_bound": suspensions_upper,
        "total_calls": total,
        "calls_per_minute": calls_per_minute,
        "effective_calls_per_minute": effective_per_minute,
        "eta_minutes": eta_minutes,
        "eta_hours": round(eta_minutes / 60, 2),
    }


def estimate_market_plan(
    start: date,
    end: date,
    *,
    calls_per_minute: int = 500,
    reserve_ratio: float = 0.2,
    include_factors: bool = True,
    anchors_first_run: int = 0,
    trading_days_per_year: int = 243,
) -> dict[str, Any]:
    """market-wide 预算：每交易日 3 次（日线 + 因子 + 停牌名单）+ 首次锚点。

    四列口径改为「每交易日调用 × 交易日数 = 总调用 ÷ 单分钟配额 = 预计耗时」；
    ``anchors_first_run`` = 首次运行需补锚点的标的数（走 per-instrument 锚点抓取，
    之后由 ``ingest_factor_anchor`` 缓存，增量运行不再消耗）。
    """
    calendar_days = (end - start).days + 1
    trading_days = max(1, int(calendar_days / 366 * trading_days_per_year) + 1)
    bars = trading_days  # 全市场日线 ~5400 行 < page_limit，通常 1 页/日
    factors = trading_days if include_factors else 0
    suspensions = trading_days if include_factors else 0
    calendar = 1
    total = bars + factors + suspensions + calendar + max(0, anchors_first_run)
    effective_per_minute = max(1, int(calls_per_minute * (1.0 - reserve_ratio)))
    eta_minutes = -(-total // effective_per_minute)
    per_day = 3 if include_factors else 1
    return {
        "mode": "market_wide",
        "trading_days": trading_days,
        "calls_per_trading_day": per_day,
        "bars_calls": bars,
        "factor_calls": factors,
        "suspension_calls": suspensions,
        "calendar_calls": calendar,
        "anchor_calls": max(0, anchors_first_run),
        "total_calls": total,
        "calls_per_minute": calls_per_minute,
        "effective_calls_per_minute": effective_per_minute,
        "eta_minutes": eta_minutes,
        "eta_hours": round(eta_minutes / 60, 2),
    }


class BarsSyncService:
    """日线同步编排：数据源端口 + 存储 + ODS 导出，不含任何数据源细节。"""

    def __init__(
        self,
        source: MarketDataSource,
        storage: SqliteStorage,
        *,
        guard: QuotaGuard | None = None,
        clock: Callable[[], datetime] = market_now,
        ods_root: str | Path | None = None,
    ) -> None:
        self._source = source
        self._storage = storage
        self._guard = guard
        self._clock = clock
        self._ods_root = Path(ods_root) if ods_root is not None else None
        if self._ods_root is not None:
            missing = [name for name in _ODS_SOURCE_METHODS if not callable(getattr(source, name, None))]
            if missing:
                raise ValueError(
                    f"ODS export requires source extension methods {missing} (adapter must implement them)"
                )

    # ---------- 主流程 ----------

    def sync(self, request: SyncRequest, *, interrupt: Callable[[], bool] | None = None) -> SyncResult:
        is_interrupted = interrupt or (lambda: False)
        if request.market_wide:
            return self._sync_market(request, is_interrupted)
        started_at = self._clock()
        run_id = self._new_batch_id(started_at)
        self._storage.create_batch(run_id, request.dataset, adapter_name(self._source), started_at)

        rows_ingested = 0
        factor_rows = 0
        suspended_rows = 0
        ods_batches = 0
        chunks_done = 0
        completed = 0
        skipped = 0
        checkpoints: dict[str, str] = {}
        status = "succeeded"
        halted: str | None = None

        raw_sink = lambda page: self._storage.append_raw_page(  # noqa: E731
            run_id, page, created_at=self._clock()
        )
        reject_sink = lambda row: self._storage.append_rejected(  # noqa: E731
            run_id, row, created_at=self._clock()
        )

        capture_factory = getattr(self._source, "capture", None)
        context = (
            capture_factory(raw_sink, reject_sink) if callable(capture_factory) else nullcontext()
        )

        suspension_cache: dict[date, frozenset[str]] = {}

        try:
            with context:
                trading_days = self._load_trading_days(request)
                for instrument_id in request.instruments:
                    resume_from = self._resume_point(request.dataset, instrument_id)
                    window_start = max(request.start, resume_from) if resume_from else request.start
                    if window_start > request.end:
                        skipped += 1
                        continue

                    instrument_ok = True
                    try:
                        if self._ods_root is not None:
                            factor_rows, ods_batches = self._fetch_and_write_factors(
                                request, instrument_id, window_start, run_id, factor_rows, ods_batches
                            )
                    except (QuotaExhaustedError, SourceAuthError, SchemaDriftError, SourceUnavailableError) as exc:
                        status, halted = self._classify_failure(exc)
                        instrument_ok = False

                    chunks = list(iter_chunks(window_start, request.end, max(1, request.chunk_days))) if instrument_ok else []
                    for chunk_start, chunk_end in chunks:
                        if is_interrupted():
                            status, halted = "interrupted", "interrupt_signal"
                            instrument_ok = False
                            break
                        rejected_before = self._storage.count_rejected(run_id)
                        try:
                            bars = self._source.list_bars(
                                instrument_id, chunk_start, chunk_end, AdjType.NONE
                            )
                        except (QuotaExhaustedError, SourceAuthError, SchemaDriftError, SourceUnavailableError) as exc:
                            status, halted = self._classify_failure(exc)
                            instrument_ok = False
                            break

                        chunk_rejected = self._storage.count_rejected(run_id) - rejected_before
                        suspensions = self._suspension_evidence(
                            instrument_id, bars, chunk_start, chunk_end, trading_days, suspension_cache, request
                        )
                        if self._ods_root is not None:
                            self._write_bar_batch(
                                request, instrument_id, chunk_start, bars, suspensions,
                                chunk_rejected, run_id,
                            )
                            ods_batches += 1
                        suspended_rows += len(suspensions)
                        rows_ingested += len(bars)
                        chunks_done += 1
                        self._storage.set_checkpoint(
                            request.dataset, instrument_id, chunk_end, run_id, self._clock()
                        )
                        checkpoints[instrument_id] = chunk_end.isoformat()

                    if instrument_ok:
                        completed += 1
                    else:
                        break

            finished_at = self._clock()
            self._storage.finish_batch(
                run_id,
                finished_at=finished_at,
                status=status,
                row_count=rows_ingested,
                rejected_count=self._storage.count_rejected(run_id),
                note=halted,
            )
        except BaseException:
            self._storage.finish_batch(
                run_id,
                finished_at=self._clock(),
                status="failed",
                row_count=rows_ingested,
                rejected_count=self._storage.count_rejected(run_id),
                note="unexpected_error",
            )
            raise

        finished_at = self._clock()
        return SyncResult(
            batch_id=run_id,
            dataset=request.dataset,
            status=status,
            halted_reason=halted,
            instruments_total=len(request.instruments),
            instruments_completed=completed,
            instruments_skipped=skipped,
            chunks_done=chunks_done,
            rows_ingested=rows_ingested,
            factor_rows=factor_rows,
            suspended_rows=suspended_rows,
            rejected_rows=self._storage.count_rejected(run_id),
            calls_used=self._guard.run_calls if self._guard is not None else 0,
            ods_batches=ods_batches,
            started_at=started_at,
            finished_at=finished_at,
            checkpoint_scopes=checkpoints,
        )

    # ---------- market-wide（按交易日全市场，L11/L12） ----------

    def _sync_market(self, request: SyncRequest, is_interrupted: Callable[[], bool]) -> SyncResult:
        """按交易日循环：日线/因子/停牌各 1 次/日；checkpoint 记「已完成到哪天」。"""
        started_at = self._clock()
        run_id = self._new_batch_id(started_at)
        self._storage.create_batch(run_id, request.dataset, adapter_name(self._source), started_at)

        rows_ingested = 0
        factor_rows = 0
        suspended_rows = 0
        ods_batches = 0
        days_done = 0
        status = "succeeded"
        halted: str | None = None
        checkpoints: dict[str, str] = {}
        anchors: dict[str, Decimal] = {}

        raw_sink = lambda page: self._storage.append_raw_page(  # noqa: E731
            run_id, page, created_at=self._clock()
        )
        reject_sink = lambda row: self._storage.append_rejected(  # noqa: E731
            run_id, row, created_at=self._clock()
        )
        capture_factory = getattr(self._source, "capture", None)
        context = (
            capture_factory(raw_sink, reject_sink) if callable(capture_factory) else nullcontext()
        )

        try:
            with context:
                all_days = self._load_trading_days(request)
                resume = self._storage.get_checkpoint(request.dataset, _MARKET_SCOPE)
                window = [day for day in all_days if resume is None or day > resume]
                for day in window:
                    if is_interrupted():
                        status, halted = "interrupted", "interrupt_signal"
                        break
                    rejected_before = self._storage.count_rejected(run_id)
                    try:
                        bars = self._source.fetch_market_snapshot(day)  # type: ignore[attr-defined]
                        suspensions: list[SuspensionRecord] = []
                        factors: list[AdjFactorRecord] = []
                        if self._ods_root is not None:
                            bar_ids = {bar.instrument_id for bar in bars}
                            # 防御：当天既有 bar 又在停牌名单的标的不重复出证据行（同一 (instrument, date) 唯一）。
                            suspensions = [
                                record
                                for record in self._source.fetch_market_suspensions(day)  # type: ignore[attr-defined]
                                if record.instrument_id not in bar_ids
                            ]
                            self._ensure_anchors([bar.instrument_id for bar in bars], anchors)
                            factors = self._source.fetch_market_factors(day, anchors=anchors)  # type: ignore[attr-defined]
                    except (QuotaExhaustedError, SourceAuthError, SchemaDriftError, SourceUnavailableError) as exc:
                        status, halted = self._classify_failure(exc)
                        break

                    day_rejected = self._storage.count_rejected(run_id) - rejected_before
                    if self._ods_root is not None:
                        self._write_ods_batch(
                            f"{run_id}-market-{day:%Y%m%d}",
                            "bar",
                            self._market_source(day, bars, suspensions),
                            ods.bar_rows(bars, suspensions),
                            rows_rejected=day_rejected,
                        )
                        ods_batches += 1
                        if factors:
                            self._write_ods_batch(
                                f"{run_id}-market-{day:%Y%m%d}-factor",
                                "adj_factor",
                                factors[0].source,
                                ods.adj_factor_rows(factors),
                                rows_rejected=day_rejected,
                            )
                            ods_batches += 1
                    rows_ingested += len(bars)
                    suspended_rows += len(suspensions)
                    factor_rows += len(factors)
                    days_done += 1
                    self._storage.set_checkpoint(
                        request.dataset, _MARKET_SCOPE, day, run_id, self._clock()
                    )
                    checkpoints[_MARKET_SCOPE] = day.isoformat()

            finished_at = self._clock()
            self._storage.finish_batch(
                run_id,
                finished_at=finished_at,
                status=status,
                row_count=rows_ingested,
                rejected_count=self._storage.count_rejected(run_id),
                note=halted,
            )
        except BaseException:
            self._storage.finish_batch(
                run_id,
                finished_at=self._clock(),
                status="failed",
                row_count=rows_ingested,
                rejected_count=self._storage.count_rejected(run_id),
                note="unexpected_error",
            )
            raise

        finished_at = self._clock()
        return SyncResult(
            batch_id=run_id,
            dataset=request.dataset,
            status=status,
            halted_reason=halted,
            instruments_total=0,
            instruments_completed=0,
            instruments_skipped=0,
            chunks_done=days_done,
            rows_ingested=rows_ingested,
            factor_rows=factor_rows,
            suspended_rows=suspended_rows,
            rejected_rows=self._storage.count_rejected(run_id),
            calls_used=self._guard.run_calls if self._guard is not None else 0,
            ods_batches=ods_batches,
            started_at=started_at,
            finished_at=finished_at,
            checkpoint_scopes=checkpoints,
        )

    def _ensure_anchors(self, instrument_ids: Sequence[str], cache: dict[str, Decimal]) -> None:
        """按需补锚点（SQLite 缓存；首次全市场回补每标的 1 次，之后不再消耗配额）。"""
        missing = sorted({instrument_id for instrument_id in instrument_ids if instrument_id not in cache})
        if not missing:
            return
        source = self._source
        for instrument_id in missing:
            stored = self._storage.get_factor_anchor(instrument_id)
            if stored is None:
                anchor_date, anchor_value = source.factor_anchor(instrument_id)  # type: ignore[attr-defined]
                self._storage.set_factor_anchor(
                    instrument_id,
                    anchor_date,
                    anchor_value,
                    source=adapter_name(source),
                    updated_at=self._clock(),
                )
            else:
                anchor_value = stored[1]
            cache[instrument_id] = anchor_value

    def _market_source(
        self, day: date, bars: Sequence[BarRecord], suspensions: Sequence[SuspensionRecord]
    ) -> SourceRef:
        if bars:
            return bars[0].source
        if suspensions:
            return suspensions[0].source
        return SourceRef(
            source=adapter_name(self._source), as_of=_close_as_of(day), fetched_at=self._clock()
        )

    # ---------- 复权因子（ODS adj_factor.v1） ----------

    def _fetch_and_write_factors(
        self,
        request: SyncRequest,
        instrument_id: str,
        window_start: date,
        run_id: str,
        factor_rows: int,
        ods_batches: int,
    ) -> tuple[int, int]:
        source = self._source
        anchor = self._storage.get_factor_anchor(instrument_id)
        if anchor is None:
            anchor = source.factor_anchor(instrument_id)  # type: ignore[attr-defined]
            self._storage.set_factor_anchor(
                instrument_id, anchor[0], anchor[1], source=adapter_name(source), updated_at=self._clock()
            )
        records: list[AdjFactorRecord] = source.list_adj_factors(  # type: ignore[attr-defined]
            instrument_id, window_start, request.end, anchor=anchor[1]
        )
        factor_rows += len(records)
        if self._ods_root is not None and records:
            self._write_ods_batch(
                f"{run_id}-{_slug(instrument_id)}-factor",
                "adj_factor",
                # 同 bar：信封 as_of 取批次内最新一条，避免行级 as_of 早于交易日。
                max(records, key=lambda record: record.trade_date).source,
                ods.adj_factor_rows(records),
            )
            ods_batches += 1
        return factor_rows, ods_batches

    # ---------- 停牌证据（L8：按交易日批量） ----------

    def _load_trading_days(self, request: SyncRequest) -> list[date]:
        if self._ods_root is None:
            return []
        return list(self._source.list_trading_days(request.start, request.end))  # type: ignore[attr-defined]

    def _suspension_evidence(
        self,
        instrument_id: str,
        bars: Sequence[BarRecord],
        chunk_start: date,
        chunk_end: date,
        trading_days: Sequence[date],
        cache: dict[date, frozenset[str]],
        request: SyncRequest,
    ) -> list[SuspensionRecord]:
        """该 chunk 内「交易日但无 bar」的日期 → 按日批量查停牌名单（全运行每天最多 1 次）。"""
        if self._ods_root is None:
            return []
        bar_dates = {bar.trade_date for bar in bars}
        missing = [day for day in trading_days if chunk_start <= day <= chunk_end and day not in bar_dates]
        if not missing:
            return []
        for day in missing:
            if day in cache:
                continue
            records = self._source.list_suspensions([day], request.instruments)  # type: ignore[attr-defined]
            cache[day] = frozenset(record.instrument_id for record in records)
        fetched_at = self._clock()
        return self._suspension_rows(instrument_id, missing, cache, fetched_at)

    def _suspension_rows(
        self,
        instrument_id: str,
        missing: Sequence[date],
        cache: dict[date, frozenset[str]],
        fetched_at: datetime,
    ) -> list[SuspensionRecord]:
        rows: list[SuspensionRecord] = []
        for day in missing:
            if instrument_id not in cache[day]:
                continue
            rows.append(
                SuspensionRecord(
                    instrument_id=instrument_id,
                    trade_date=day,
                    source=SourceRef(source=adapter_name(self._source), as_of=_close_as_of(day), fetched_at=fetched_at),
                )
            )
        return rows

    # ---------- ODS 写出 ----------

    def _write_bar_batch(
        self,
        request: SyncRequest,
        instrument_id: str,
        chunk_start: date,
        bars: Sequence[BarRecord],
        suspensions: Sequence[SuspensionRecord],
        rows_rejected: int,
        run_id: str,
    ) -> None:
        rows = ods.bar_rows(bars, suspensions)
        # 批次信封的 as_of 必须是「批次内最新交易日收盘」：A2 loader 让行级 source/as_of
        # 继承信封，若取最早一条会导致后续交易日的 as_of 早于交易日（COMP-02 blocker）。
        if bars:
            source = max(bars, key=lambda bar: bar.trade_date).source
        elif suspensions:
            source = max(suspensions, key=lambda record: record.trade_date).source
        else:
            source = None
        if source is None:
            return  # 空块（无 bar 且无停牌证据）不产空批次
        self._write_ods_batch(
            f"{run_id}-{_slug(instrument_id)}-{chunk_start:%Y%m%d}",
            "bar",
            source,
            rows,
            rows_rejected=rows_rejected,
        )

    def _write_ods_batch(
        self,
        batch_id: str,
        endpoint: str,
        source: SourceRef,
        rows: list[dict[str, Any]],
        *,
        rows_rejected: int = 0,
    ) -> None:
        assert self._ods_root is not None
        ods.write_batch(
            self._ods_root,
            ods.OdsBatch(
                batch_id=batch_id,
                endpoint=endpoint,
                source=source,
                rows=tuple(rows),
                rows_rejected=rows_rejected,
            ),
        )

    # ---------- 工具 ----------

    def _resume_point(self, dataset: str, instrument_id: str) -> date | None:
        checkpoint = self._storage.get_checkpoint(dataset, instrument_id)
        return None if checkpoint is None else checkpoint + timedelta(days=1)

    @staticmethod
    def _classify_failure(exc: Exception) -> tuple[str, str]:
        if isinstance(exc, QuotaExhaustedError):
            return "interrupted", "quota_exhausted"
        if isinstance(exc, SourceAuthError):
            return "failed", "source_auth"
        if isinstance(exc, SchemaDriftError):
            return "failed", "schema_drift"
        return "failed", "source_unavailable"

    @staticmethod
    def _new_batch_id(now: datetime) -> str:
        return f"ing-{now.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"


# --------------------------------------------------------------------------
# 主数据 / 财务摘要（L16/L17）：一次性批次，无 checkpoint（幂等覆盖由 A2 DWD 落库保证）
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class MasterSyncResult:
    """主数据 / 财务最小批次的运行结果。"""

    batch_id: str
    dataset: str
    status: str  # succeeded | failed
    rows: int
    rejected_rows: int
    calls_used: int
    started_at: datetime
    finished_at: datetime
    ods_path: str | None = None
    checksum_sha256: str = ""

    def summary(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "dataset": self.dataset,
            "status": self.status,
            "rows": self.rows,
            "rejected_rows": self.rejected_rows,
            "calls_used": self.calls_used,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat(),
            "ods_path": self.ods_path,
        }


def new_run_id(now: datetime) -> str:
    """运行 id：同一批次族的前缀（instrument/fundamental 共用）。"""
    return f"ing-{now.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"


def _master_source(source: object, records: Sequence[object], *, clock: Callable[[], datetime]) -> SourceRef:
    for record in records:
        ref = getattr(record, "source", None)
        if isinstance(ref, SourceRef):
            return ref
    now = clock()
    return SourceRef(source=adapter_name(source), as_of=market_close_at(now.date()), fetched_at=now)


def _require_method(source: object, name: str) -> None:
    if not callable(getattr(source, name, None)):
        raise ValueError(f"adapter {adapter_name(source)!r} does not provide {name}() (L16 master batch)")


def sync_instrument_master(
    source: object,
    storage: SqliteStorage,
    *,
    ods_root: str | Path | None = None,
    clock: Callable[[], datetime] = market_now,
    run_id: str | None = None,
    guard: QuotaGuard | None = None,
    display: bool = False,
) -> MasterSyncResult:
    """一次 ``stock_basic`` 取全量在册 → ``instrument.v1`` 批次（L17）。

    ``display=True`` 时按 H4 m01335 产 display 白名单 7 字段并做硬校验；
    internal 批次（默认）保留 ``code``/``lot_size``。

    调用数固定 1 次（不随标的变化）；不做 checkpoint：主数据是全量覆盖语义。
    """
    _require_method(source, "fetch_instruments")
    now = clock()
    run_id = run_id or new_run_id(now)
    batch_id = f"{run_id}-instrument"
    storage.create_batch(batch_id, "instrument", adapter_name(source), now)

    def _raw(page: RawPage) -> None:
        storage.append_raw_page(batch_id, page, created_at=clock())

    def _reject(row: RejectedRow) -> None:
        storage.append_rejected(batch_id, row, created_at=clock())

    started = now
    status = "succeeded"
    records: list[InstrumentRecord] = []
    capture_factory = getattr(source, "capture", None)
    try:
        with capture_factory(_raw, _reject) if callable(capture_factory) else nullcontext():
            records = list(source.fetch_instruments())  # type: ignore[attr-defined]
    except SourceUnavailableError:
        status = "failed"
    except SchemaDriftError:
        status = "failed"

    rejected = storage.count_rejected(batch_id)
    finished = clock()
    storage.finish_batch(
        batch_id,
        finished_at=finished,
        status=status,
        row_count=len(records),
        rejected_count=rejected,
        note=None if status == "succeeded" else "source failure during instrument master fetch",
    )
    ods_path: str | None = None
    rows = tuple(ods.instrument_rows(records, for_display=display))
    if display:
        ods.validate_display_instrument_rows(rows)
    if status == "succeeded" and ods_root is not None:
        batch = ods.OdsBatch(
            batch_id=batch_id,
            endpoint="instrument",
            source=_master_source(source, records, clock=clock),
            rows=rows,
            rows_rejected=rejected,
            partition_date_override=now.date(),
        )
        ods_path = str(ods.write_batch(ods_root, batch))
    checksum = ""
    if status == "succeeded":
        payload = json.dumps(list(rows), ensure_ascii=False, sort_keys=True)
        checksum = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return MasterSyncResult(
        batch_id=batch_id,
        dataset="instrument",
        status=status,
        rows=len(records),
        rejected_rows=rejected,
        calls_used=guard.run_calls if guard is not None else 0,
        started_at=started,
        finished_at=finished,
        ods_path=ods_path,
        checksum_sha256=checksum,
    )


def sync_fundamentals(
    source: object,
    storage: SqliteStorage,
    *,
    instrument_ids: Sequence[str],
    ods_root: str | Path | None = None,
    clock: Callable[[], datetime] = market_now,
    run_id: str | None = None,
    guard: QuotaGuard | None = None,
) -> MasterSyncResult:
    """切片标的的最近一期财务摘要 → ``fundamental.v1`` 批次（L16 最小批次）。

    每标的 2 次调用（财务指标 + 利润表绝对值）；无已披露数据的标的不产行（serving 返 404）。
    """
    if not instrument_ids:
        raise ValueError("instrument_ids must not be empty")
    _require_method(source, "fetch_fundamentals")
    now = clock()
    run_id = run_id or new_run_id(now)
    batch_id = f"{run_id}-fundamental"
    storage.create_batch(batch_id, "fundamental", adapter_name(source), now)

    def _raw(page: RawPage) -> None:
        storage.append_raw_page(batch_id, page, created_at=clock())

    def _reject(row: RejectedRow) -> None:
        storage.append_rejected(batch_id, row, created_at=clock())

    started = now
    status = "succeeded"
    records: list[FundamentalRecord] = []
    capture_factory = getattr(source, "capture", None)
    try:
        with capture_factory(_raw, _reject) if callable(capture_factory) else nullcontext():
            records = list(source.fetch_fundamentals(list(instrument_ids)))  # type: ignore[attr-defined]
    except SourceUnavailableError:
        status = "failed"
    except SchemaDriftError:
        status = "failed"

    rejected = storage.count_rejected(batch_id)
    finished = clock()
    storage.finish_batch(
        batch_id,
        finished_at=finished,
        status=status,
        row_count=len(records),
        rejected_count=rejected,
        note=None if status == "succeeded" else "source failure during fundamental fetch",
    )
    ods_path: str | None = None
    if status == "succeeded" and ods_root is not None:
        batch = ods.OdsBatch(
            batch_id=batch_id,
            endpoint="fundamental",
            source=_master_source(source, records, clock=clock),
            rows=tuple(ods.fundamental_rows(records)),
            rows_rejected=rejected,
            partition_date_override=(
                max(record.report_end_date for record in records) if records else now.date()
            ),
        )
        ods_path = str(ods.write_batch(ods_root, batch))
    return MasterSyncResult(
        batch_id=batch_id,
        dataset="fundamental",
        status=status,
        rows=len(records),
        rejected_rows=rejected,
        calls_used=guard.run_calls if guard is not None else 0,
        started_at=started,
        finished_at=finished,
        ods_path=ods_path,
    )


# --------------------------------------------------------------------------
# 研究数据集（KD-AIP0-INF-05）：按交易日 checkpoint，ODS 只读可查，DWD 归 A2
# --------------------------------------------------------------------------


def _research_mode(source: object, dataset: str) -> str:
    """数据集抓取形态由适配器声明（业务层不 import 适配层实现）。"""
    mode_fn = getattr(source, "research_mode", None)
    if callable(mode_fn):
        mode = mode_fn(dataset)
        if mode in ("daily", "snapshot", "per_instrument"):
            return str(mode)
    return "daily"


def estimate_research_plan(
    datasets: Sequence[str],
    start: date,
    end: date,
    *,
    index_codes: Sequence[str] = (),
    instruments: Sequence[str] = (),
    modes: Mapping[str, str] | None = None,
    calls_per_minute: int = 500,
    reserve_ratio: float = 0.2,
    trading_days_per_year: int = 243,
) -> dict[str, Any]:
    """研究接入预算：日频按交易日，快照按 1 次，逐标的按标的数。

    ``modes`` 缺省全部按日频（调用方无法拿到适配器形态时用，属保守上界）。
    """
    calendar_days = (end - start).days + 1
    trading_days = max(1, int(calendar_days / 366 * trading_days_per_year) + 1)
    modes = dict(modes or {})
    calls_by_dataset: dict[str, int] = {}
    per_day = 0
    for dataset in datasets:
        mode = modes.get(dataset, "daily")
        if mode == "per_instrument":
            calls = max(1, len(instruments))
            per_day = max(per_day, calls)
        elif mode == "snapshot":
            calls = 1
            per_day = max(per_day, 1)
        elif dataset == "index_daily" and index_codes:
            calls = trading_days * len(index_codes)
            per_day += len(index_codes)
        else:
            calls = trading_days
            per_day += 1
        calls_by_dataset[dataset] = calls
    calendar_calls = 1 if any(modes.get(name, "daily") != "snapshot" for name in datasets) else 0
    total = sum(calls_by_dataset.values()) + calendar_calls
    effective_per_minute = max(1, int(calls_per_minute * (1.0 - reserve_ratio)))
    eta_minutes = -(-total // effective_per_minute)
    return {
        "mode": "research",
        "datasets": list(datasets),
        "dataset_modes": {name: modes.get(name, "daily") for name in datasets},
        "trading_days": trading_days,
        "calls_per_trading_day": per_day,
        "calls_by_dataset": calls_by_dataset,
        "calendar_calls": calendar_calls,
        "total_calls": total,
        "calls_per_minute": calls_per_minute,
        "effective_calls_per_minute": effective_per_minute,
        "eta_minutes": eta_minutes,
        "eta_hours": round(eta_minutes / 60, 2),
    }


@dataclass(frozen=True, slots=True)
class ResearchSyncResult:
    """研究数据集同步结果（按 dataset 独立 checkpoint）。"""

    run_id: str
    datasets: tuple[str, ...]
    status: str  # succeeded | interrupted | failed
    halted_reason: str | None
    days_done: int
    rows_by_dataset: dict[str, int]
    ods_batches: int
    rejected_rows: int
    calls_used: int
    started_at: datetime
    finished_at: datetime
    checkpoints: dict[str, str] = field(default_factory=dict)
    #: 只有当前快照、缺历史进出成分的数据集（H4 m02718）：下游回测必须排除。
    current_snapshot_only: tuple[str, ...] = ()

    def summary(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "datasets": list(self.datasets),
            "status": self.status,
            "halted_reason": self.halted_reason,
            "days_done": self.days_done,
            "rows_by_dataset": dict(self.rows_by_dataset),
            "rows_total": sum(self.rows_by_dataset.values()),
            "ods_batches": self.ods_batches,
            "rejected_rows": self.rejected_rows,
            "calls_used": self.calls_used,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat(),
            "checkpoints": dict(self.checkpoints),
            "current_snapshot_only": list(self.current_snapshot_only),
        }


def sync_research(
    source: object,
    storage: SqliteStorage,
    *,
    datasets: Sequence[str],
    start: date,
    end: date,
    ods_root: str | Path | None = None,
    index_codes: Sequence[str] = (),
    instruments: Sequence[str] = (),
    clock: Callable[[], datetime] = market_now,
    guard: QuotaGuard | None = None,
    interrupt: Callable[[], bool] | None = None,
) -> ResearchSyncResult:
    """研究数据集同步：按数据集形态抓取 → canonical ODS 行 → checkpoint 续跑。

    三种形态（由适配器 ``research_mode`` 声明）：
    - ``daily``：按交易日逐日抓取，checkpoint 记到日；
    - ``snapshot``：无日期快照（行业树/成分表），一次写入，同日重跑跳过；
    - ``per_instrument``：逐标的按区间抓取（财务指标），checkpoint 记到标的。

    验收口径：只保证「数据正确落到 ODS + 字段映射清晰」；DWD/DWS 由 A2 建。
    接口无权限/不可用 → 显式 ``failed``，**绝不造数**。
    """
    requested = tuple(datasets)
    if not requested:
        raise ValueError("datasets must not be empty")
    if start > end:
        raise ValueError("start must be <= end")
    _require_method(source, "fetch_research")
    supported = getattr(source, "research_datasets", None)
    if supported is not None:
        unknown = [name for name in requested if name not in supported]
        if unknown:
            raise ValueError(f"adapter does not support research datasets {unknown}; supported={tuple(supported)}")

    modes = {name: _research_mode(source, name) for name in requested}
    per_instrument = [name for name in requested if modes[name] == "per_instrument"]
    if per_instrument and not instruments:
        raise ValueError(f"datasets {per_instrument} require instruments (per-instrument mode)")

    is_interrupted = interrupt or (lambda: False)
    started_at = clock()
    run_id = new_run_id(started_at)
    # 交易日历是控制查询（非研究数据集、不导出 ODS）：在 capture 外取一次，
    # 避免 raw sink 无批次可落，也避免同一日历被多个数据集重复消耗配额。
    trading_days: list[date] = []
    if any(modes[name] == "daily" for name in requested):
        _require_method(source, "list_trading_days")
        trading_days = list(source.list_trading_days(start, end))  # type: ignore[attr-defined]
    rows_by_dataset: dict[str, int] = {name: 0 for name in requested}
    checkpoints: dict[str, str] = {}
    ods_batches = 0
    days_done = 0
    rejected_total = 0
    coverage: dict[str, dict[str, Any]] = {}

    current: dict[str, str | None] = {"batch": None}

    def _raw(page: RawPage) -> None:
        batch_id = current["batch"]
        assert batch_id is not None
        storage.append_raw_page(batch_id, page, created_at=clock())

    def _reject(row: RejectedRow) -> None:
        batch_id = current["batch"]
        assert batch_id is not None
        storage.append_rejected(batch_id, row, created_at=clock())

    capture_factory = getattr(source, "capture", None)
    context = capture_factory(_raw, _reject) if callable(capture_factory) else nullcontext()

    status = "succeeded"
    halted: str | None = None

    def _fetch(dataset: str, **kwargs: Any) -> list[dict[str, Any]]:
        return list(
            source.fetch_research(dataset, **kwargs)  # type: ignore[attr-defined]
        )

    def _write(dataset: str, batch_id: str, rows: list[dict[str, Any]], rejected: int, **kwargs: Any) -> None:
        nonlocal ods_batches
        if ods_root is not None and rows:
            fetched = clock()
            ods.write_batch(
                ods_root,
                ods.OdsBatch(
                    batch_id=batch_id,
                    endpoint=dataset,
                    source=SourceRef(
                        source=adapter_name(source), as_of=fetched, fetched_at=fetched
                    ),
                    rows=tuple(ods.research_rows(rows, endpoint=dataset)),
                    rows_rejected=rejected,
                    partition_date_override=ods.partition_date_for(
                        dataset, rows, fallback=fetched.date()
                    ),
                ),
            )
            ods_batches += 1
        rows_by_dataset[dataset] += len(rows)

    try:
        with context:
            for dataset in requested:
                mode = modes[dataset]
                if mode == "snapshot":
                    batch_id = f"{run_id}-{dataset}"
                    current["batch"] = batch_id
                    storage.create_batch(batch_id, dataset, adapter_name(source), clock())
                    today = clock().date()
                    resume = storage.get_checkpoint(dataset, _SNAPSHOT_SCOPE)
                    if resume is not None and resume >= today:
                        storage.finish_batch(
                            batch_id,
                            finished_at=clock(),
                            status="succeeded",
                            row_count=0,
                            rejected_count=0,
                            note="already_synced_today",
                        )
                        checkpoints[dataset] = resume.isoformat()
                        continue
                    rejected_before = storage.count_rejected(batch_id)
                    try:
                        rows = _fetch(dataset)
                    except (QuotaExhaustedError, SourceAuthError, SchemaDriftError, SourceUnavailableError) as exc:
                        status, halted = BarsSyncService._classify_failure(exc)
                        storage.finish_batch(
                            batch_id,
                            finished_at=clock(),
                            status=status,
                            row_count=0,
                            rejected_count=storage.count_rejected(batch_id),
                            note=halted,
                        )
                        break
                    _write(dataset, batch_id, rows, storage.count_rejected(batch_id) - rejected_before)
                    meta = getattr(source, "last_research_meta", {}).get(dataset)
                    if isinstance(meta, Mapping):
                        coverage[dataset] = dict(meta)
                    storage.set_checkpoint(dataset, _SNAPSHOT_SCOPE, today, run_id, clock())
                    checkpoints[dataset] = today.isoformat()
                    days_done += 1
                    storage.finish_batch(
                        batch_id,
                        finished_at=clock(),
                        status="succeeded",
                        row_count=rows_by_dataset[dataset],
                        rejected_count=storage.count_rejected(batch_id),
                    )
                    continue

                if mode == "per_instrument":
                    dataset_failed = False
                    for instrument in instruments:
                        if is_interrupted():
                            status, halted, dataset_failed = "interrupted", "interrupt_signal", True
                            break
                        batch_id = f"{run_id}-{dataset}-{_slug(instrument)}"
                        current["batch"] = batch_id
                        storage.create_batch(batch_id, dataset, adapter_name(source), clock())
                        resume = storage.get_checkpoint(dataset, instrument)
                        if resume is not None and resume >= end:
                            storage.finish_batch(
                                batch_id,
                                finished_at=clock(),
                                status="succeeded",
                                row_count=0,
                                rejected_count=0,
                                note="already_synced_range",
                            )
                            checkpoints[f"{dataset}:{instrument}"] = resume.isoformat()
                            continue
                        window_start = start if resume is None else max(start, resume + timedelta(days=1))
                        rejected_before = storage.count_rejected(batch_id)
                        try:
                            rows = _fetch(
                                dataset, instrument_id=instrument, start=window_start, end=end
                            )
                        except (QuotaExhaustedError, SourceAuthError, SchemaDriftError, SourceUnavailableError) as exc:
                            status, halted = BarsSyncService._classify_failure(exc)
                            storage.finish_batch(
                                batch_id,
                                finished_at=clock(),
                                status=status,
                                row_count=0,
                                rejected_count=storage.count_rejected(batch_id),
                                note=halted,
                            )
                            dataset_failed = True
                            break
                        _write(dataset, batch_id, rows, storage.count_rejected(batch_id) - rejected_before)
                        storage.set_checkpoint(dataset, instrument, end, run_id, clock())
                        checkpoints[f"{dataset}:{instrument}"] = end.isoformat()
                        days_done += 1
                        storage.finish_batch(
                            batch_id,
                            finished_at=clock(),
                            status="succeeded",
                            row_count=rows_by_dataset[dataset],
                            rejected_count=storage.count_rejected(batch_id),
                        )
                    if dataset_failed:
                        break
                    continue

                # daily 模式
                batch_id = f"{run_id}-{dataset}"
                current["batch"] = batch_id
                storage.create_batch(batch_id, dataset, adapter_name(source), clock())
                resume = storage.get_checkpoint(dataset, _MARKET_SCOPE)
                window = [day for day in trading_days if resume is None or day > resume]
                dataset_failed = False
                for day in window:
                    if is_interrupted():
                        status, halted, dataset_failed = "interrupted", "interrupt_signal", True
                        break
                    rejected_before = storage.count_rejected(batch_id)
                    try:
                        rows = _fetch(dataset, trade_date=day, index_codes=tuple(index_codes))
                    except (QuotaExhaustedError, SourceAuthError, SchemaDriftError, SourceUnavailableError) as exc:
                        status, halted = BarsSyncService._classify_failure(exc)
                        dataset_failed = True
                        break
                    day_rejected = storage.count_rejected(batch_id) - rejected_before
                    if ods_root is not None and rows:
                        fetched = clock()
                        ods.write_batch(
                            ods_root,
                            ods.OdsBatch(
                                batch_id=f"{batch_id}-{day:%Y%m%d}",
                                endpoint=dataset,
                                source=SourceRef(
                                    source=adapter_name(source),
                                    as_of=_research_as_of(dataset, day),
                                    fetched_at=fetched,
                                ),
                                rows=tuple(ods.research_rows(rows, endpoint=dataset)),
                                rows_rejected=day_rejected,
                            ),
                        )
                        ods_batches += 1
                    rows_by_dataset[dataset] += len(rows)
                    days_done += 1
                    storage.set_checkpoint(dataset, _MARKET_SCOPE, day, run_id, clock())
                    checkpoints[dataset] = day.isoformat()
                storage.finish_batch(
                    batch_id,
                    finished_at=clock(),
                    status=status if dataset_failed else "succeeded",
                    row_count=rows_by_dataset[dataset],
                    rejected_count=storage.count_rejected(batch_id),
                    note=halted if dataset_failed else None,
                )
                if dataset_failed:
                    break
    except BaseException:
        failed_batch = current["batch"]
        if failed_batch is not None:
            storage.finish_batch(
                failed_batch,
                finished_at=clock(),
                status="failed",
                row_count=0,
                rejected_count=storage.count_rejected(failed_batch),
                note="unexpected_error",
            )
        raise

    for name in requested:
        rejected_total += storage.count_rejected(f"{run_id}-{name}")

    if ods_root is not None and coverage:
        _write_research_coverage(Path(ods_root), run_id, coverage, clock())

    return ResearchSyncResult(
        run_id=run_id,
        datasets=requested,
        status=status,
        halted_reason=halted,
        days_done=days_done,
        rows_by_dataset=rows_by_dataset,
        ods_batches=ods_batches,
        rejected_rows=rejected_total,
        calls_used=guard.run_calls if guard is not None else 0,
        started_at=started_at,
        finished_at=clock(),
        checkpoints=checkpoints,
        current_snapshot_only=tuple(
            name for name, meta in coverage.items() if meta.get("coverage") == "current_snapshot_only"
        ),
    )


def _write_research_coverage(
    root: Path, run_id: str, coverage: Mapping[str, Mapping[str, Any]], now: datetime
) -> Path:
    """写 ``<ods_root>/_meta/research_coverage.json``（快照覆盖率审计，H4 m02718）。

    该目录位于 endpoint 目录之外，A2 loader 按 ``<root>/<endpoint>/dt=*`` 读取时不会
    把它当批次文件；下游可用它判断 ``index_member_all`` 是否只是当前快照（回测排除）。
    """
    directory = root / "_meta"
    directory.mkdir(parents=True, exist_ok=True)
    datasets: dict[str, dict[str, Any]] = {}
    for name, meta in coverage.items():
        enriched = dict(meta)
        if enriched.get("mode") == "snapshot":
            # H4 m02923：index_classify 等快照数据集必须把「首快照日期」写进 coverage，
            # 下游据此判断历史分类/成分可回溯的最早时点（首快照之前不可回补）。
            enriched["first_snapshot_date"] = _first_snapshot_partition(
                root, name, fallback=enriched.get("snapshot_date")
            )
        datasets[name] = enriched
    payload = {
        "run_id": run_id,
        "generated_at": now.isoformat(),
        "datasets": datasets,
    }
    target = directory / "research_coverage.json"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(target)
    return target


def _first_snapshot_partition(root: Path, dataset: str, *, fallback: object = None) -> str | None:
    """扫描 ``<root>/<dataset>/dt=*`` 得到该快照数据集的首个快照分区日期。"""
    dates: list[str] = []
    directory = root / dataset
    if directory.is_dir():
        for entry in directory.iterdir():
            if not entry.is_dir() or not entry.name.startswith("dt="):
                continue
            value = entry.name[3:]
            try:
                date.fromisoformat(value)
            except ValueError:
                continue
            dates.append(value)
    if dates:
        return min(dates)
    return str(fallback) if fallback else None


def _slug(instrument_id: str) -> str:
    return instrument_id.replace(":", "-")


def _close_as_of(day: date) -> datetime:
    from .models import market_close_at

    return market_close_at(day)


def _research_as_of(dataset: str, day: date) -> datetime:
    """研究批次信封 as_of（A2 RES-04 阈值）。

    ``hk_hold`` 是北向持股 T+1 披露：as_of = 下一自然日 15:00；其余日频数据集为当日
    收盘 15:00。财报/行业快照无 trade_date，不在此函数内（时点由行内公告日/快照日承担）。
    """
    if dataset == "hk_hold":
        from .models import market_close_at

        return market_close_at(day + timedelta(days=1))
    return _close_as_of(day)


def adapter_name(source: object) -> str:
    """取适配器逻辑名用于批次记录；不依赖具体实现。"""
    name = getattr(source, "source_name", None)
    if isinstance(name, str) and name:
        return name
    return type(source).__module__.rsplit(".", 2)[-2] if "." in type(source).__module__ else type(source).__name__


__all__ = [
    "BarsSyncService",
    "MasterSyncResult",
    "SyncRequest",
    "SyncResult",
    "chunk_count",
    "estimate_calls",
    "estimate_market_plan",
    "estimate_plan",
    "estimate_research_plan",
    "iter_chunks",
    "new_run_id",
    "sync_fundamentals",
    "sync_instrument_master",
    "sync_research",
    "RawPage",
    "RejectedRow",
]
