"""DWD 构建：ODS 批次 → canonical 行（去重 / 幂等 / 修订留痕）。

设计约束（ADR-002 D2/D3/C15，task-6 验收）：
  * 主键 (instrument_id, trade_date) 幂等：同一批次重复执行得到完全相同的行，不产生修订。
  * 批次内重复主键 → 结构违规（无法判定哪一行可信）；批次间冲突 → 按 (as_of, fetched_at, batch_id)
    取较新者，并为每个变化字段写 dwd_bar_revision（revision 递增，只增不改）。
  * 停牌行（suspended:true）不生成 bar，只作为「该交易日确实无行情」的证据（C08）；
    证据写入 dwd_suspended_daily（同一 (instrument_id, trade_date) 以较新批次为准）。
  * 不写数据库：P0 用内存表 + schema.sql；写库在 P1 由 A1/A13 的 PG 环境启用。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable

from warehouse.ods.loader import Batch

BAR_VALUE_FIELDS = ("open", "high", "low", "close", "volume", "amount", "prev_close")
FACTOR_VALUE_FIELDS = ("factor",)
#: 研究数据集 DWD 表的业务列（不含 PK 与 source/as_of/fetched_at/batch_id/ingested_at）。
#: 顺序与 schema.sql 一致；字段名保持 A1 canonical，不在 DWD 重命名（provisional 等 H4 对齐）。
RESEARCH_VALUE_FIELDS: dict[str, tuple[str, ...]] = {
    "daily_basic": (
        "close",
        "turnover_rate_pct",
        "free_float_turnover_rate_pct",
        "volume_ratio",
        "pe",
        "pe_ttm",
        "pb",
        "ps",
        "ps_ttm",
        "dividend_yield_pct",
        "dividend_yield_ttm_pct",
        "total_shares",
        "float_shares",
        "free_float_shares",
        "total_market_value",
        "circulating_market_value",
        "limit_status",
    ),
    "index_daily": (
        "open",
        "high",
        "low",
        "close",
        "prev_close",
        "change",
        "pct_change_pct",
        "volume",
        "amount",
    ),
    "top_list": (
        "name",
        "close",
        "pct_change_pct",
        "turnover_rate_pct",
        "amount",
        "lhb_sell_amount",
        "lhb_buy_amount",
        "lhb_amount",
        "lhb_net_amount",
        "lhb_net_rate_pct",
        "lhb_amount_rate_pct",
        "float_market_value",
        "reason",
    ),
    "top_inst": (
        "seat_name",
        "side",
        "buy_amount",
        "buy_rate_pct",
        "sell_amount",
        "sell_rate_pct",
        "net_buy_amount",
        "reason",
    ),
    "moneyflow": (
        "buy_small_volume",
        "buy_small_amount",
        "sell_small_volume",
        "sell_small_amount",
        "buy_medium_volume",
        "buy_medium_amount",
        "sell_medium_volume",
        "sell_medium_amount",
        "buy_large_volume",
        "buy_large_amount",
        "sell_large_volume",
        "sell_large_amount",
        "buy_extra_large_volume",
        "buy_extra_large_amount",
        "sell_extra_large_volume",
        "sell_extra_large_amount",
        "net_inflow_volume",
        "net_inflow_amount",
    ),
    "margin": (
        "financing_balance",
        "financing_buy_amount",
        "financing_repayment_amount",
        "securities_balance",
        "securities_sell_volume",
        "margin_balance",
        "securities_volume",
    ),
    "hk_hold": (
        "name",
        "holding_volume",
        "holding_ratio_pct",
        "northbound_channel",
    ),
}

FUNDAMENTAL_VALUE_FIELDS = (
    "report_end_date",
    "announced_at",
    "currency",
    "revenue",
    "net_profit",
    "revenue_yoy_pct",
    "net_profit_yoy_pct",
    "eps",
    "roe_pct",
    "gross_margin_pct",
)


@dataclass
class BuildIssue:
    """构建阶段发现的结构性违规（进入质量分，不抛异常）。"""

    rule_id: str
    severity: str  # blocker | warn
    instrument_id: str
    trade_date: date | None
    detail: str


@dataclass
class Revision:
    instrument_id: str
    trade_date: date
    revision: int
    field: str
    old_value: str | None
    new_value: str | None
    detected_at: datetime
    batch_id: str


@dataclass
class DwdState:
    """DWD 的确定性内存表示（与 schema.sql 列一一对应，已按 ODS loader 规范序列化）。"""

    bars: dict[tuple[str, date], dict[str, Any]] = field(default_factory=dict)
    factors: dict[tuple[str, date], dict[str, Any]] = field(default_factory=dict)
    instruments: dict[str, dict[str, Any]] = field(default_factory=dict)
    revisions: list[Revision] = field(default_factory=list)
    suspended: set[tuple[str, date]] = field(default_factory=set)
    # 停牌证据行（dwd_suspended_daily 内存表示）；suspended 集合保留给质量规则 COMP-03 使用。
    suspended_rows: dict[tuple[str, date], dict[str, Any]] = field(default_factory=dict)
    issues: list[BuildIssue] = field(default_factory=list)
    # 财务摘要（dwd_fundamental_report 内存表示，PK=instrument_id+report_period+statement_basis）
    fundamentals: dict[tuple[str, str, str], dict[str, Any]] = field(default_factory=dict)
    # 批次元信息（质量规则 COMP-02 使用）
    bar_batches: list[Batch] = field(default_factory=list)
    # 研究数据集（KD-AIP0-INF-05）：last-write-wins，不参与 bar 修订留痕。
    # 主键：daily_basic/index_daily/top_list/moneyflow/hk_hold=(instrument_id, trade_date)；
    #       top_inst=(instrument_id, trade_date, seat_name, side)；
    #       margin=(exchange, trade_date)。
    daily_basic: dict[tuple[Any, ...], dict[str, Any]] = field(default_factory=dict)
    index_daily: dict[tuple[Any, ...], dict[str, Any]] = field(default_factory=dict)
    top_list: dict[tuple[Any, ...], dict[str, Any]] = field(default_factory=dict)
    top_inst: dict[tuple[Any, ...], dict[str, Any]] = field(default_factory=dict)
    moneyflow: dict[tuple[Any, ...], dict[str, Any]] = field(default_factory=dict)
    margin: dict[tuple[Any, ...], dict[str, Any]] = field(default_factory=dict)
    hk_hold: dict[tuple[Any, ...], dict[str, Any]] = field(default_factory=dict)

    def bars_for(self, instrument_id: str) -> list[dict[str, Any]]:
        return sorted(
            (b for (iid, _), b in self.bars.items() if iid == instrument_id),
            key=lambda b: b["trade_date"],
        )

    def factor_for(self, instrument_id: str, trade_date: date) -> Decimal | None:
        row = self.factors.get((instrument_id, trade_date))
        return None if row is None else row["factor"]

    def instrument_ids(self) -> set[str]:
        return set(self.instruments)


def _sort_key(batch: Batch) -> tuple[datetime, datetime, str]:
    return (batch.source.as_of, batch.source.fetched_at, batch.batch_id)


def _values(row: dict[str, Any], fields: Iterable[str]) -> dict[str, Any]:
    return {f: row.get(f) for f in fields}


def _fmt(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def build_dwd(
    batches: list[Batch],
    *,
    display_safety: dict[str, bool] | None = None,
) -> DwdState:
    """把 ODS 批次折叠为 DWD 状态。输入输出均为纯数据，可重复执行（幂等）。

    `display_safety` 是 `load_display_safety()` 派生的证据映射（instrument_id -> bool）；
    证据式派生（H4 2026-11-04 裁定，agents/decisions.md L42）：`display_safe = origin=='display' AND evidence==True`。
    internal 批次不参与展示态；旧平铺 root 没有可展示性证据，一律 false（离线回归需显式构造
    display root + manifest，或直接读 build 结果验证）。缺证据时 false，绝不默认 true。
    """
    state = DwdState()
    ordered = sorted(batches, key=_sort_key)
    evidence = display_safety or {}

    display_instruments: set[str] = set()
    for batch in ordered:
        if batch.endpoint == "instrument":
            for row in batch.rows:
                instrument_id = row["instrument_id"]
                if batch.origin == "display":
                    # L34：display root 是展示态唯一权威；但必须同时有 manifest 证据（H4）
                    display_instruments.add(instrument_id)
                    display_safe = bool(evidence.get(instrument_id, False))
                elif batch.origin == "internal":
                    # internal 只做审计/交叉校验：不得覆盖 display 的维表行
                    if instrument_id in display_instruments:
                        continue
                    display_safe = False
                else:
                    # 旧平铺 root：没有 root 证据，fail-closed；离线回归不产生可展示标的
                    display_safe = False
                state.instruments[instrument_id] = {
                    **row,
                    "display_safe": display_safe,
                    "source": batch.source.source,
                    "as_of": batch.source.as_of,
                    "fetched_at": batch.source.fetched_at,
                    "ingested_at": batch.source.fetched_at,
                }
            continue

        if batch.endpoint == "bar":
            state.bar_batches.append(batch)
            seen_in_batch: set[tuple[str, date]] = set()
            for row in batch.rows:
                key = (row["instrument_id"], row["trade_date"])
                if key in seen_in_batch:
                    state.issues.append(
                        BuildIssue(
                            rule_id="STRUCT-02",
                            severity="blocker",
                            instrument_id=key[0],
                            trade_date=key[1],
                            detail=f"同一批次 {batch.batch_id} 内主键重复",
                        )
                    )
                    continue
                seen_in_batch.add(key)
                if row.get("suspended"):
                    state.suspended.add(key)
                    state.suspended_rows[key] = {
                        "instrument_id": key[0],
                        "trade_date": key[1],
                        "source": batch.source.source,
                        "as_of": batch.source.as_of,
                        "fetched_at": batch.source.fetched_at,
                        "batch_id": batch.batch_id,
                        "ingested_at": batch.source.fetched_at,
                    }
                    state.bars.pop(key, None)  # 停牌证据优先于任何残留 bar
                    continue
                _upsert_bar(state, row, batch)
            continue

        if batch.endpoint == "adj_factor":
            for row in batch.rows:
                _upsert_factor(state, row, batch)
            continue

        if batch.endpoint == "fundamental":
            for row in batch.rows:
                _upsert_fundamental(state, row, batch)
            continue

        if batch.endpoint in RESEARCH_VALUE_FIELDS:
            _upsert_research(state, row_batch=batch)

    return state


def _upsert_bar(state: DwdState, row: dict[str, Any], batch: Batch) -> None:
    key = (row["instrument_id"], row["trade_date"])
    record = {
        "instrument_id": row["instrument_id"],
        "trade_date": row["trade_date"],
        "open": row["open"],
        "high": row["high"],
        "low": row["low"],
        "close": row["close"],
        "volume": row["volume"],
        "amount": row["amount"],
        "prev_close": row.get("prev_close"),
        "source": batch.source.source,
        "as_of": batch.source.as_of,
        "fetched_at": batch.source.fetched_at,
        "batch_id": batch.batch_id,
        "revision": 0,
        "ingested_at": batch.source.fetched_at,
    }
    existing = state.bars.get(key)
    if existing is None:
        state.bars[key] = record
        return

    changed = [f for f in BAR_VALUE_FIELDS if existing.get(f) != record.get(f)]
    if not changed:
        return  # 幂等：同值重复批次不改库、不留修订

    revision = existing["revision"] + 1
    for name in changed:
        state.revisions.append(
            Revision(
                instrument_id=key[0],
                trade_date=key[1],
                revision=revision,
                field=name,
                old_value=_fmt(existing.get(name)),
                new_value=_fmt(record.get(name)),
                detected_at=batch.source.fetched_at,
                batch_id=batch.batch_id,
            )
        )
    record["revision"] = revision
    state.bars[key] = record


def _upsert_factor(state: DwdState, row: dict[str, Any], batch: Batch) -> None:
    key = (row["instrument_id"], row["trade_date"])
    record = {
        "instrument_id": row["instrument_id"],
        "trade_date": row["trade_date"],
        "factor": row["factor"],
        "source": batch.source.source,
        "as_of": batch.source.as_of,
        "fetched_at": batch.source.fetched_at,
        "batch_id": batch.batch_id,
        "revision": 0,
        "ingested_at": batch.source.fetched_at,
    }
    existing = state.factors.get(key)
    if existing is None:
        state.factors[key] = record
        return
    changed = [f for f in FACTOR_VALUE_FIELDS if existing.get(f) != record.get(f)]
    if not changed:
        return
    revision = existing["revision"] + 1
    for name in changed:
        state.revisions.append(
            Revision(
                instrument_id=key[0],
                trade_date=key[1],
                revision=revision,
                field=name,
                old_value=_fmt(existing.get(name)),
                new_value=_fmt(record.get(name)),
                detected_at=batch.source.fetched_at,
                batch_id=batch.batch_id,
            )
        )
    record["revision"] = revision
    state.factors[key] = record


def _upsert_fundamental(state: DwdState, row: dict[str, Any], batch: Batch) -> None:
    """M06：reported/restated 两套并存（PK 含 statement_basis）；同键由较新批次覆盖。"""
    key = (row["instrument_id"], row["report_period"], row["statement_basis"])
    record = {
        "instrument_id": key[0],
        "report_period": key[1],
        "report_end_date": row["report_end_date"],
        "announced_at": row["announced_at"],
        "statement_basis": key[2],
        "currency": row["currency"],
        "revenue": row["revenue"],
        "net_profit": row["net_profit"],
        "revenue_yoy_pct": row.get("revenue_yoy_pct"),
        "net_profit_yoy_pct": row.get("net_profit_yoy_pct"),
        "eps": row.get("eps"),
        "roe_pct": row.get("roe_pct"),
        "gross_margin_pct": row.get("gross_margin_pct"),
        "source": batch.source.source,
        "as_of": batch.source.as_of,
        "fetched_at": batch.source.fetched_at,
        "batch_id": batch.batch_id,
        "ingested_at": batch.source.fetched_at,
    }
    existing = state.fundamentals.get(key)
    if existing is None or any(existing.get(f) != record.get(f) for f in FUNDAMENTAL_VALUE_FIELDS):
        state.fundamentals[key] = record


RESEARCH_KEY_FIELDS: dict[str, tuple[str, ...]] = {
    "top_inst": ("instrument_id", "trade_date", "seat_name", "side"),
    "margin": ("exchange", "trade_date"),
}


def _research_key(endpoint: str, row: dict[str, Any]) -> tuple[Any, ...]:
    fields = RESEARCH_KEY_FIELDS.get(endpoint, ("instrument_id", "trade_date"))
    return tuple(row[field] for field in fields)


def _upsert_research(state: DwdState, *, row_batch: Batch) -> None:
    """研究数据集 upsert：批次已按 (as_of, fetched_at, batch_id) 排序，后写覆盖。

    不做修订留痕（研究态快照；修订表只服务行情 bar）。批次内主键重复记 STRUCT-02，
    因为无法判定哪一行可信（与 bar 同规则）。
    """
    endpoint = row_batch.endpoint
    target: dict[tuple[Any, ...], dict[str, Any]] = getattr(state, endpoint)
    fields = RESEARCH_VALUE_FIELDS[endpoint]
    seen: set[tuple[Any, ...]] = set()
    for row in row_batch.rows:
        key = _research_key(endpoint, row)
        if key in seen:
            state.issues.append(
                BuildIssue(
                    rule_id="STRUCT-02",
                    severity="blocker",
                    instrument_id=str(row.get("instrument_id") or row.get("exchange") or ""),
                    trade_date=row.get("trade_date"),
                    detail=f"研究批次 {row_batch.batch_id} 内主键重复: {key}",
                )
            )
            continue
        seen.add(key)
        record = {field: row.get(field) for field in fields}
        record.update(
            {
                **{field: row[field] for field in RESEARCH_KEY_FIELDS.get(endpoint, ("instrument_id", "trade_date"))},
                "source": row_batch.source.source,
                "as_of": row_batch.source.as_of,
                "fetched_at": row_batch.source.fetched_at,
                "batch_id": row_batch.batch_id,
                "ingested_at": row_batch.source.fetched_at,
            }
        )
        existing = target.get(key)
        if existing is None or any(existing.get(field) != record.get(field) for field in fields):
            target[key] = record
