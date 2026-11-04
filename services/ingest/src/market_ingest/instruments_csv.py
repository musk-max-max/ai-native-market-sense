"""交易所基础信息 CSV 的解析、校验与冲突检测（C 端白名单主数据来源）。

背景（lead m00796 / H4 m00801）：C 端白名单内的基础信息（证券代码、简称、交易所、
法定板块、上市状态、上市日期）**不得经 tushare 取得**。本模块负责自建导入路径的
数据侧规则：

- CSV 只承载白名单字段；概念板块等不在白名单的字段一律不导入（未知列即格式错误）；
- 冲突自动阻断、裁决人工：代码唯一性、名称↔代码映射、板块与代码前缀不一致、
  以及相对上一版快照的「无公告依据的更名 / 状态变更 / 消失」；
- 单批冲突 ≤ ``CONFLICT_LIMIT`` 条时输出 diff 供人工终审，超限整批退回查来源。

本模块不写文件、不发事件；manifest 事件与快照由 :mod:`market_ingest.manifest`
与 :mod:`market_ingest.instruments_import` 负责。
"""

from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Mapping, Sequence

from .instruments import board_for_code, lot_size_for_board
from .models import (
    Board,
    ExchangeCode,
    InstrumentRecord,
    ListStatus,
    SecurityType,
    SourceRef,
    parse_instrument_id,
)

#: CSV 必填列（顺序不敏感；大小写敏感，避免和源字段混淆）。
REQUIRED_COLUMNS: tuple[str, ...] = (
    "instrument_id",
    "name",
    "board",
    "list_status",
    "list_date",
)

#: 可选列：变更公告依据（更名/退市/恢复上市时填写，供人工裁决与 manifest 取证）。
OPTIONAL_COLUMNS: tuple[str, ...] = ("change_basis_url",)

#: 单批冲突超过该值时整批退回查来源，不逐条裁决（H4 m00801）。
CONFLICT_LIMIT = 5


class CsvFormatError(ValueError):
    """CSV 结构/字段非法：整批拒绝，不做部分导入。"""


@dataclass(frozen=True, slots=True)
class BaseInfoRow:
    """一行基础信息（已校验，尚未附加 canonical source）。"""

    instrument_id: str
    name: str
    board: Board
    list_status: ListStatus
    list_date: date | None
    change_basis_url: str | None
    line_number: int

    @property
    def exchange(self) -> ExchangeCode:
        return parse_instrument_id(self.instrument_id)[0]

    @property
    def code(self) -> str:
        return parse_instrument_id(self.instrument_id)[1]


@dataclass(frozen=True, slots=True)
class BaseInfoBatch:
    """一次导入的 CSV 全量内容 + 校验和（manifest 用）。"""

    path: Path
    checksum: str
    text: str
    rows: tuple[BaseInfoRow, ...]
    field_set: tuple[str, ...]

    @property
    def rows_total(self) -> int:
        return len(self.rows)


@dataclass(frozen=True, slots=True)
class Conflict:
    """一条需要阻断/人工裁决的冲突。"""

    kind: str
    instrument_id: str
    detail: str

    def as_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "instrument_id": self.instrument_id, "detail": self.detail}

    def render(self) -> str:
        return f"[{self.kind}] {self.instrument_id}: {self.detail}"


def _enum_or_error(enum_type: Any, raw: str, *, column: str, line: int) -> Any:
    try:
        return enum_type(raw)
    except ValueError as exc:
        allowed = ", ".join(item.value for item in enum_type)
        raise CsvFormatError(f"line {line}: invalid {column} {raw!r}, expected one of: {allowed}") from exc


def _parse_list_date(raw: str, *, line: int) -> date | None:
    text = raw.strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise CsvFormatError(f"line {line}: invalid list_date {text!r}, expected YYYY-MM-DD") from exc


def parse_base_info(text: str, *, path: Path) -> BaseInfoBatch:
    """解析并校验 CSV 文本；任何结构/字段问题整批拒绝。"""
    checksum = hashlib.sha256(text.encode("utf-8")).hexdigest()
    reader = csv.DictReader(io.StringIO(text))
    header = tuple(name.strip() for name in (reader.fieldnames or ()))
    if not header:
        raise CsvFormatError("empty CSV: missing header row")
    missing = [column for column in REQUIRED_COLUMNS if column not in header]
    if missing:
        raise CsvFormatError(f"missing required columns: {', '.join(missing)}")
    unknown = [column for column in header if column not in REQUIRED_COLUMNS + OPTIONAL_COLUMNS]
    if unknown:
        raise CsvFormatError(f"unknown columns (concept/sector fields are not whitelisted): {', '.join(unknown)}")
    if len(set(header)) != len(header):
        raise CsvFormatError("duplicate column names in header")

    rows: list[BaseInfoRow] = []
    for line_number, raw_row in enumerate(reader, start=2):
        if raw_row is None or not any((value or "").strip() for value in raw_row.values()):
            continue
        if None in raw_row:
            raise CsvFormatError(
                f"line {line_number}: more values than header columns "
                f"({len(raw_row[None])} extra); unknown fields are not whitelisted"
            )
        instrument_id = (raw_row.get("instrument_id") or "").strip()
        try:
            parse_instrument_id(instrument_id)
        except ValueError as exc:
            raise CsvFormatError(f"line {line_number}: invalid instrument_id {instrument_id!r}: {exc}") from exc
        name = (raw_row.get("name") or "").strip()
        if not name:
            raise CsvFormatError(f"line {line_number}: empty name for {instrument_id}")
        board = _enum_or_error(Board, (raw_row.get("board") or "").strip(), column="board", line=line_number)
        list_status = _enum_or_error(
            ListStatus, (raw_row.get("list_status") or "").strip(), column="list_status", line=line_number
        )
        list_date = _parse_list_date(raw_row.get("list_date") or "", line=line_number)
        basis = (raw_row.get("change_basis_url") or "").strip() or None
        rows.append(
            BaseInfoRow(
                instrument_id=instrument_id,
                name=name,
                board=board,
                list_status=list_status,
                list_date=list_date,
                change_basis_url=basis,
                line_number=line_number,
            )
        )
    if not rows:
        raise CsvFormatError("CSV contains no data rows")
    return BaseInfoBatch(
        path=path,
        checksum=checksum,
        text=text,
        rows=tuple(rows),
        field_set=tuple(column for column in header if column in REQUIRED_COLUMNS),
    )


def read_base_info(path: str | Path) -> BaseInfoBatch:
    """读文件并按 UTF-8（容忍 BOM）解析；读不到即整批失败。"""
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8-sig")
    return parse_base_info(text, path=file_path)


def rows_to_instrument_records(batch: BaseInfoBatch, *, source: SourceRef) -> list[InstrumentRecord]:
    """CSV 行 → canonical ``InstrumentRecord``（板块来自文件，lot_size 按板块规则）。"""
    records = []
    for row in batch.rows:
        exchange, code = parse_instrument_id(row.instrument_id)
        records.append(
            InstrumentRecord(
                instrument_id=row.instrument_id,
                exchange=exchange,
                code=code,
                name=row.name,
                board=row.board,
                security_type=SecurityType.STOCK,
                list_status=row.list_status,
                lot_size=lot_size_for_board(row.board),
                listed_at=row.list_date,
                source=source,
            )
        )
    return records


def snapshot_rows(batch: BaseInfoBatch) -> list[dict[str, str | None]]:
    """manifest 快照用的稳定行形状（用于下一版 diff）。"""
    return [
        {
            "instrument_id": row.instrument_id,
            "name": row.name,
            "board": row.board.value,
            "list_status": row.list_status.value,
            "list_date": row.list_date.isoformat() if row.list_date else None,
            "change_basis_url": row.change_basis_url,
        }
        for row in sorted(batch.rows, key=lambda item: item.instrument_id)
    ]


def detect_conflicts(
    rows: Sequence[BaseInfoRow],
    previous: Sequence[Mapping[str, Any]] | None,
) -> list[Conflict]:
    """自动阻断类冲突（H4 m00801 三类 + 代码前缀板块不一致）。

    ``previous`` 是上一版成功导入的快照行（``snapshot_rows`` 的形状）；首版为 ``None``。
    """
    conflicts: list[Conflict] = []

    seen: dict[str, BaseInfoRow] = {}
    for row in rows:
        if row.instrument_id in seen:
            conflicts.append(
                Conflict(
                    "duplicate_code",
                    row.instrument_id,
                    f"代码在批次内重复（第 {seen[row.instrument_id].line_number} 行与第 {row.line_number} 行）",
                )
            )
        else:
            seen[row.instrument_id] = row

    by_name: dict[str, list[str]] = {}
    for row in seen.values():
        by_name.setdefault(row.name, []).append(row.instrument_id)
    for name, instrument_ids in by_name.items():
        if len(instrument_ids) > 1:
            joined = ", ".join(sorted(instrument_ids))
            for instrument_id in sorted(instrument_ids):
                conflicts.append(
                    Conflict("name_code_conflict", instrument_id, f"简称 {name!r} 映射到多个代码：{joined}")
                )

    for row in seen.values():
        expected = board_for_code(row.exchange, row.code)
        if row.board is not expected:
            conflicts.append(
                Conflict(
                    "board_mismatch",
                    row.instrument_id,
                    f"法定板块 {row.board.value!r} 与代码前缀推导 {expected.value!r} 不一致",
                )
            )

    if previous:
        previous_by_id = {str(item["instrument_id"]): item for item in previous}
        for row in seen.values():
            old = previous_by_id.get(row.instrument_id)
            if old is None:
                continue
            if str(old.get("name")) != row.name and not row.change_basis_url:
                conflicts.append(
                    Conflict(
                        "rename_without_basis",
                        row.instrument_id,
                        f"简称由上版 {old.get('name')!r} 变为 {row.name!r}，但未提供公告依据",
                    )
                )
            if str(old.get("list_status")) != row.list_status.value and not row.change_basis_url:
                conflicts.append(
                    Conflict(
                        "status_change_without_basis",
                        row.instrument_id,
                        f"上市状态由上版 {old.get('list_status')!r} 变为 {row.list_status.value!r}，但未提供公告依据",
                    )
                )
        for instrument_id, old in sorted(previous_by_id.items()):
            if instrument_id in seen:
                continue
            if str(old.get("list_status")) == ListStatus.DELISTED.value:
                continue
            if not old.get("change_basis_url"):
                conflicts.append(
                    Conflict(
                        "removed_without_basis",
                        instrument_id,
                        "上版在册但本版消失，且未提供退市/暂停上市公告依据",
                    )
                )
    return conflicts


def too_many_conflicts(conflicts: Sequence[Conflict]) -> bool:
    return len(conflicts) > CONFLICT_LIMIT


def render_conflicts(conflicts: Sequence[Conflict]) -> list[str]:
    return [conflict.render() for conflict in conflicts]


__all__ = [
    "CONFLICT_LIMIT",
    "OPTIONAL_COLUMNS",
    "REQUIRED_COLUMNS",
    "BaseInfoBatch",
    "BaseInfoRow",
    "Conflict",
    "CsvFormatError",
    "detect_conflicts",
    "parse_base_info",
    "read_base_info",
    "render_conflicts",
    "rows_to_instrument_records",
    "snapshot_rows",
    "too_many_conflicts",
]
