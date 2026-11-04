"""SQLite 存储后端：raw 不可变台账 + 批次 + checkpoint + 配额台账。

生产 PG 后端补同一接口即可（方法签名即接口）。本地与 CI 用 SQLite（stdlib），
避免 CI 依赖外部数据库；A2 的 ODS→DWD 直接读 ``ods_raw_page`` / ``ods_rejected_row``。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

from ..models import MARKET_TZ, require_market_tz
from ..ports import RawPage, RejectedRow

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def _dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    require_market_tz(value, field="timestamp")
    return value.isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=MARKET_TZ)


def _page_key(dataset: str, endpoint: str, params: Mapping[str, Any], rows: tuple[Mapping[str, Any], ...]) -> str:
    material = "\x1f".join((dataset, endpoint, _dumps(dict(params)), _dumps(list(rows))))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class BatchRecord:
    batch_id: str
    dataset: str
    adapter: str
    started_at: datetime
    finished_at: datetime | None
    status: str
    row_count: int
    rejected_count: int
    note: str | None


class SqliteStorage:
    """单一 SQLite 文件承载接入层全部状态。线程内单连接使用。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
        self._conn.commit()

    # ---------- 生命周期 ----------

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> SqliteStorage:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    @property
    def connection(self) -> sqlite3.Connection:
        """只读/对账用途（A2、测试）；写操作必须走本类方法以维持不可变约束。"""
        return self._conn

    # ---------- 批次 ----------

    def create_batch(self, batch_id: str, dataset: str, adapter: str, started_at: datetime) -> None:
        self._conn.execute(
            "INSERT INTO ods_batch (batch_id, dataset, adapter, started_at, status) VALUES (?, ?, ?, ?, 'running')",
            (batch_id, dataset, adapter, _iso(started_at)),
        )
        self._conn.commit()

    def finish_batch(
        self,
        batch_id: str,
        *,
        finished_at: datetime,
        status: str,
        row_count: int,
        rejected_count: int,
        note: str | None = None,
    ) -> None:
        if status not in {"succeeded", "failed", "interrupted"}:
            raise ValueError(f"invalid batch finish status: {status}")
        self._conn.execute(
            "UPDATE ods_batch SET finished_at = ?, status = ?, row_count = ?, rejected_count = ?, note = ? "
            "WHERE batch_id = ?",
            (_iso(finished_at), status, row_count, rejected_count, note, batch_id),
        )
        self._conn.commit()

    def get_batch(self, batch_id: str) -> BatchRecord | None:
        row = self._conn.execute("SELECT * FROM ods_batch WHERE batch_id = ?", (batch_id,)).fetchone()
        if row is None:
            return None
        return BatchRecord(
            batch_id=row["batch_id"],
            dataset=row["dataset"],
            adapter=row["adapter"],
            started_at=_parse_iso(row["started_at"]) or datetime.now(MARKET_TZ),
            finished_at=_parse_iso(row["finished_at"]),
            status=row["status"],
            row_count=row["row_count"],
            rejected_count=row["rejected_count"],
            note=row["note"],
        )

    # ---------- ODS 原始页（只追加） ----------

    def append_raw_page(self, batch_id: str, page: RawPage, *, created_at: datetime) -> bool:
        """追加一页原始响应；完全相同的重放返回 False（幂等，不产生重复行）。"""
        key = _page_key(page.dataset, page.endpoint, page.request_params, page.rows)
        cursor = self._conn.execute(
            "INSERT OR IGNORE INTO ods_raw_page "
            "(page_key, batch_id, dataset, endpoint, request_params, response_payload, row_count, source, as_of, "
            " fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                key,
                batch_id,
                page.dataset,
                page.endpoint,
                _dumps(dict(page.request_params)),
                _dumps(list(page.rows)),
                len(page.rows),
                page.source,
                _iso(page.as_of),
                _iso(page.fetched_at),
                _iso(created_at),
            ),
        )
        self._conn.commit()
        return cursor.rowcount > 0

    def iter_raw_pages(self, dataset: str | None = None, batch_id: str | None = None) -> Iterator[dict[str, Any]]:
        sql = "SELECT * FROM ods_raw_page"
        clauses: list[str] = []
        params: list[Any] = []
        if dataset is not None:
            clauses.append("dataset = ?")
            params.append(dataset)
        if batch_id is not None:
            clauses.append("batch_id = ?")
            params.append(batch_id)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at, page_key"
        for row in self._conn.execute(sql, params):
            yield {
                "page_key": row["page_key"],
                "batch_id": row["batch_id"],
                "dataset": row["dataset"],
                "endpoint": row["endpoint"],
                "request_params": json.loads(row["request_params"]),
                "payload": json.loads(row["response_payload"]),
                "row_count": row["row_count"],
                "source": row["source"],
                "as_of": row["as_of"],
                "fetched_at": row["fetched_at"],
            }

    # ---------- DLQ（只追加） ----------

    def append_rejected(self, batch_id: str, rejected: RejectedRow, *, created_at: datetime) -> None:
        self._conn.execute(
            "INSERT INTO ods_rejected_row "
            "(batch_id, dataset, endpoint, reason, instrument_id, trade_date, payload, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                batch_id,
                rejected.dataset,
                rejected.endpoint,
                rejected.reason,
                rejected.instrument_id,
                rejected.trade_date.isoformat() if rejected.trade_date else None,
                _dumps(dict(rejected.payload)),
                _iso(created_at),
            ),
        )
        self._conn.commit()

    def iter_rejected(self, batch_id: str | None = None) -> Iterator[dict[str, Any]]:
        sql = "SELECT * FROM ods_rejected_row"
        params: list[Any] = []
        if batch_id is not None:
            sql += " WHERE batch_id = ?"
            params.append(batch_id)
        sql += " ORDER BY id"
        for row in self._conn.execute(sql, params):
            yield {
                "batch_id": row["batch_id"],
                "dataset": row["dataset"],
                "endpoint": row["endpoint"],
                "reason": row["reason"],
                "instrument_id": row["instrument_id"],
                "trade_date": row["trade_date"],
                "payload": json.loads(row["payload"]),
            }

    def count_rejected(self, batch_id: str) -> int:
        row = self._conn.execute("SELECT COUNT(*) AS n FROM ods_rejected_row WHERE batch_id = ?", (batch_id,)).fetchone()
        return int(row["n"])

    # ---------- checkpoint ----------

    def get_checkpoint(self, dataset: str, scope: str) -> date | None:
        row = self._conn.execute(
            "SELECT last_success_trade_date FROM ingest_checkpoint WHERE dataset = ? AND scope = ?",
            (dataset, scope),
        ).fetchone()
        if row is None or row["last_success_trade_date"] is None:
            return None
        return date.fromisoformat(row["last_success_trade_date"])

    def set_checkpoint(self, dataset: str, scope: str, trade_date: date, batch_id: str, updated_at: datetime) -> None:
        self._conn.execute(
            "INSERT INTO ingest_checkpoint (dataset, scope, last_success_trade_date, last_batch_id, updated_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(dataset, scope) DO UPDATE SET "
            "last_success_trade_date = excluded.last_success_trade_date, "
            "last_batch_id = excluded.last_batch_id, updated_at = excluded.updated_at",
            (dataset, scope, trade_date.isoformat(), batch_id, _iso(updated_at)),
        )
        self._conn.commit()

    # ---------- 复权因子锚点 ----------

    def get_factor_anchor(self, instrument_id: str) -> tuple[date, Decimal] | None:
        """返回 (anchor_date, anchor_factor)；未锚定过返回 None（首次需向源取最早因子）。"""
        row = self._conn.execute(
            "SELECT anchor_date, anchor_factor FROM ingest_factor_anchor WHERE instrument_id = ?",
            (instrument_id,),
        ).fetchone()
        if row is None:
            return None
        return date.fromisoformat(row["anchor_date"]), Decimal(row["anchor_factor"])

    def set_factor_anchor(
        self,
        instrument_id: str,
        anchor_date: date,
        anchor_factor: Decimal,
        *,
        source: str,
        updated_at: datetime,
    ) -> None:
        if anchor_factor <= 0:
            raise ValueError("anchor_factor must be > 0")
        self._conn.execute(
            "INSERT INTO ingest_factor_anchor "
            "(instrument_id, anchor_date, anchor_factor, source, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(instrument_id) DO UPDATE SET "
            "anchor_date = excluded.anchor_date, anchor_factor = excluded.anchor_factor, "
            "source = excluded.source, updated_at = excluded.updated_at",
            (instrument_id, anchor_date.isoformat(), format(anchor_factor, "f"), source, _iso(updated_at)),
        )
        self._conn.commit()

    # ---------- 配额台账 ----------

    def get_calls(self, period_key: str) -> int:
        row = self._conn.execute("SELECT calls FROM quota_ledger WHERE period_key = ?", (period_key,)).fetchone()
        return 0 if row is None else int(row["calls"])

    def add_calls(self, period_key: str, count: int, updated_at: datetime) -> int:
        self._conn.execute(
            "INSERT INTO quota_ledger (period_key, calls, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(period_key) DO UPDATE SET calls = calls + excluded.calls, updated_at = excluded.updated_at",
            (period_key, count, _iso(updated_at)),
        )
        self._conn.commit()
        return self.get_calls(period_key)
