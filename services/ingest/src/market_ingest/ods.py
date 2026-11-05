"""ODS canonical 批次文件写出（A1 → A2 交换格式 v1）。

布局与信封以 ``warehouse/README.md §2`` / ``warehouse/ods/loader.py`` 为准：

    <ODS_ROOT>/<endpoint>/dt=<batch 内最早 trade_date>/<batch_id>.json

约束（loader 整批拒绝，不猜测补齐）：
- 信封字段：``batch_id/endpoint/schema/source/rows_total/rows_rejected/rows``；
- ``schema`` 必须与 endpoint 匹配（bar.v1 / adj_factor.v1 / instrument.v1）；
- 价格/金额一律十进制字符串（禁 JSON float），``volume`` 为整数（股），``amount`` 元；
- ``rows_total == len(rows) + rows_rejected``；
- 行内不得出现数据源字段名（C01）——本模块只吃 canonical 记录，天然满足。

本模块不读数据库、不调用数据源：输入是 canonical 记录，输出是文件；便于单测与重放。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence

from .models import (
    AdjFactorRecord,
    BarRecord,
    FundamentalRecord,
    InstrumentRecord,
    SourceRef,
    SuspensionRecord,
    market_now,
)

#: 研究数据集 endpoint（KD-AIP0-INF-05，A2 建研 DWD/DWS 的 ODS 输入）。
RESEARCH_ENDPOINTS: tuple[str, ...] = (
    "top_list",
    "top_inst",
    "moneyflow",
    "margin",
    "hk_hold",
    "daily_basic",
    "index_daily",
)

#: endpoint -> schema（与 A2 loader 的 ENDPOINT_SCHEMAS 保持一致）。
ENDPOINT_SCHEMAS: dict[str, str] = {
    "bar": "bar.v1",
    "adj_factor": "adj_factor.v1",
    "instrument": "instrument.v1",
    "fundamental": "fundamental.v1",
    **{name: f"{name}.v1" for name in RESEARCH_ENDPOINTS},
}


class OdsFormatError(ValueError):
    """批次内容不满足交换格式 v1（本地侧提前失败，避免写坏文件）。"""


def _decimal_text(value: Decimal) -> str:
    """Decimal → 十进制字符串（禁止科学计数法，避免下游解析歧义）。"""
    return format(value, "f")


def bar_rows(
    bars: Sequence[BarRecord],
    suspension_rows: Sequence[SuspensionRecord] = (),
) -> list[dict[str, Any]]:
    """canonical bar + 停牌证据行 → ``bar.v1`` 行（股/元/十进制字符串）。"""
    rows: list[dict[str, Any]] = []
    for bar in bars:
        row: dict[str, Any] = {
            "instrument_id": bar.instrument_id,
            "trade_date": bar.trade_date.isoformat(),
            "open": _decimal_text(bar.open),
            "high": _decimal_text(bar.high),
            "low": _decimal_text(bar.low),
            "close": _decimal_text(bar.close),
            "volume": str(bar.volume),
            "amount": _decimal_text(bar.amount),
        }
        if bar.prev_close is not None:
            row["prev_close"] = _decimal_text(bar.prev_close)
        rows.append(row)
    for suspended in suspension_rows:
        rows.append(
            {
                "instrument_id": suspended.instrument_id,
                "trade_date": suspended.trade_date.isoformat(),
                "suspended": True,
            }
        )
    rows.sort(key=lambda row: (row["trade_date"], row["instrument_id"]))
    return rows


def adj_factor_rows(records: Sequence[AdjFactorRecord]) -> list[dict[str, Any]]:
    """canonical 复权因子 → ``adj_factor.v1`` 行。"""
    rows = [
        {
            "instrument_id": record.instrument_id,
            "trade_date": record.trade_date.isoformat(),
            "factor": _decimal_text(record.factor),
        }
        for record in records
    ]
    rows.sort(key=lambda row: (row["trade_date"], row["instrument_id"]))
    return rows


#: display root 的 instrument.v1 行**恰好**这 7 个字段（H4 m01335 §2）：
#: ``code`` 由 instrument_id 派生不重复存，``lot_size`` 只进 internal root。
DISPLAY_INSTRUMENT_FIELDS: tuple[str, ...] = (
    "instrument_id",
    "name",
    "exchange",
    "board",
    "security_type",
    "list_status",
    "listed_at",
)


def instrument_rows(
    records: Sequence[InstrumentRecord], *, for_display: bool = False
) -> list[dict[str, Any]]:
    """canonical 主数据 → ``instrument.v1`` 行（L17：一次 stock_basic 全量在册）。

    ``for_display=True`` 时只产 display 白名单的 7 字段（H4 m01335 §2）；
    默认产 internal 形状（9 字段，含 ``code``/``lot_size``）。
    """
    rows: list[dict[str, Any]] = []
    for record in records:
        if for_display:
            row: dict[str, Any] = {
                "instrument_id": record.instrument_id,
                "name": record.name,
                "exchange": record.exchange.value,
                "board": record.board.value,
                "security_type": record.security_type.value,
                "list_status": record.list_status.value,
                "listed_at": record.listed_at.isoformat() if record.listed_at is not None else None,
            }
        else:
            row = {
                "instrument_id": record.instrument_id,
                "exchange": record.exchange.value,
                "code": record.code,
                "name": record.name,
                "board": record.board.value,
                "security_type": record.security_type.value,
                "list_status": record.list_status.value,
                "lot_size": record.lot_size,
            }
            if record.listed_at is not None:
                row["listed_at"] = record.listed_at.isoformat()
        rows.append(row)
    rows.sort(key=lambda row: str(row["instrument_id"]))
    return rows


def validate_display_instrument_rows(rows: Sequence[Mapping[str, Any]]) -> None:
    """display root 硬校验：出现白名单外字段即整批失败（H4 m01335 §2）。"""
    allowed = set(DISPLAY_INSTRUMENT_FIELDS)
    for index, row in enumerate(rows):
        keys = set(row)
        if keys != allowed:
            extra = sorted(keys - allowed)
            missing = sorted(allowed - keys)
            raise OdsFormatError(
                f"display instrument row {index} field mismatch (H4 m01335): "
                f"extra={extra} missing={missing}"
            )


def fundamental_rows(records: Sequence[FundamentalRecord]) -> list[dict[str, Any]]:
    """canonical 财务摘要 → ``fundamental.v1`` 行（金额=元、比率=百分数、可为负）。"""
    rows: list[dict[str, Any]] = []
    for record in records:
        row: dict[str, Any] = {
            "instrument_id": record.instrument_id,
            "report_period": record.report_period,
            "report_end_date": record.report_end_date.isoformat(),
            "announced_at": record.announced_at.isoformat(),
            "statement_basis": record.statement_basis,
            "currency": record.currency,
            "revenue": _decimal_text(record.revenue),
            "net_profit": _decimal_text(record.net_profit),
        }
        for key, value in (
            ("revenue_yoy_pct", record.revenue_yoy_pct),
            ("net_profit_yoy_pct", record.net_profit_yoy_pct),
            ("eps", record.eps),
            ("roe_pct", record.roe_pct),
            ("gross_margin_pct", record.gross_margin_pct),
        ):
            if value is not None:
                row[key] = _decimal_text(value)
        rows.append(row)
    rows.sort(key=lambda row: (str(row["report_end_date"]), str(row["instrument_id"])))
    return rows


def research_rows(rows: Sequence[Mapping[str, Any]], *, endpoint: str) -> list[dict[str, Any]]:
    """研究数据集行 → ODS 行（canonical：金额元/量股/比率百分数，均为字符串）。

    行形状由适配层的 ``research.py`` 保证（字段映射与单位换算集中在适配层）；
    本函数只做 endpoint 校验、``trade_date`` 存在性校验与确定性排序。
    """
    if endpoint not in RESEARCH_ENDPOINTS:
        raise OdsFormatError(f"unsupported research endpoint: {endpoint!r}")
    out: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        if "trade_date" not in row:
            raise OdsFormatError(f"{endpoint} row {index} is missing trade_date")
        out.append(dict(row))
    out.sort(
        key=lambda row: (
            str(row["trade_date"]),
            str(row.get("instrument_id") or row.get("exchange") or ""),
        )
    )
    return out


@dataclass(frozen=True, slots=True)
class OdsBatch:
    """一个待写出的 canonical 批次。"""

    batch_id: str
    endpoint: str
    source: SourceRef
    rows: tuple[Mapping[str, Any], ...]
    rows_rejected: int = 0
    #: 非行情批次（instrument/fundamental）用显式分区日；缺省沿用「批次内最早 trade_date」。
    partition_date_override: date | None = None

    def __post_init__(self) -> None:
        if not self.batch_id.strip():
            raise OdsFormatError("batch_id must be non-empty")
        if self.endpoint not in ENDPOINT_SCHEMAS:
            raise OdsFormatError(f"unsupported endpoint: {self.endpoint!r}")
        if self.rows_rejected < 0:
            raise OdsFormatError("rows_rejected must be >= 0")

    @property
    def schema(self) -> str:
        return ENDPOINT_SCHEMAS[self.endpoint]

    @property
    def rows_total(self) -> int:
        return len(self.rows) + self.rows_rejected

    @property
    def partition_date(self) -> date:
        if self.partition_date_override is not None:
            return self.partition_date_override
        dates = [date.fromisoformat(str(row["trade_date"])) for row in self.rows if "trade_date" in row]
        return min(dates) if dates else market_now().date()


def write_batch(root: str | Path, batch: OdsBatch) -> Path:
    """按 v1 布局写出批次文件并返回路径（同 batch_id 重写覆盖，幂等）。"""
    root = Path(root)
    target = root / batch.endpoint / f"dt={batch.partition_date.isoformat()}" / f"{batch.batch_id}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "batch_id": batch.batch_id,
        "endpoint": batch.endpoint,
        "schema": batch.schema,
        "source": {
            "source": batch.source.source,
            "as_of": batch.source.as_of.isoformat(),
            "fetched_at": batch.source.fetched_at.isoformat(),
        },
        "rows_total": batch.rows_total,
        "rows_rejected": batch.rows_rejected,
        "rows": [dict(row) for row in batch.rows],
    }
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(target)  # 原子写：A2 不会读到半截 JSON
    return target


__all__ = [
    "ENDPOINT_SCHEMAS",
    "OdsBatch",
    "OdsFormatError",
    "RESEARCH_ENDPOINTS",
    "adj_factor_rows",
    "bar_rows",
    "fundamental_rows",
    "instrument_rows",
    "research_rows",
    "write_batch",
]
