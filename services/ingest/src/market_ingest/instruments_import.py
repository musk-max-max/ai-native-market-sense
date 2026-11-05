"""主数据导入编排：CSV 基础信息导入 + manifest 事件 + 冲突阻断。

职责边界（lead m00796 / H4 m00801）：
- 只处理 C 端白名单主数据（instrument.v1）；行情/财务不在本模块；
- 冲突自动阻断、裁决人工：≤``CONFLICT_LIMIT`` 条输出 diff 供 H4 终审，超限整批退回；
- 事件/快照 append-only；失败、中断、阻断也写 manifest 事件；
- 操作人必填、凭证只记路径或 sha256。

tushare ``stock_basic`` 路径的产物只作内部交叉校验：本模块提供
:func:`record_tushare_instrument_import` 把它的批次也写进同一 manifest（channel=tushare），
供切换期 diff 与展示态校验使用。
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from . import manifest as mf
from .instruments_csv import (
    CONFLICT_LIMIT,
    BaseInfoBatch,
    Conflict,
    CsvFormatError,
    detect_conflicts,
    read_base_info,
    render_conflicts,
    rows_to_instrument_records,
    snapshot_rows,
    too_many_conflicts,
)
from .models import SourceRef, market_now
from .storage import SqliteStorage
from .sync import MasterSyncResult, adapter_name, new_run_id, sync_instrument_master

#: CSV 列 → canonical instrument.v1 字段（manifest 字段级来源渠道用）。
CSV_FIELD_MAP: dict[str, str] = {
    "instrument_id": "instrument_id",
    "name": "name",
    "board": "board",
    "list_status": "list_status",
    "list_date": "listed_at",
}

#: 交易所 CSV 路径下 canonical 字段全部来自同一渠道（含由导入规则派生的字段）。
CANONICAL_INSTRUMENT_FIELDS: tuple[str, ...] = mf.FIELD_SOURCES_ALLOWED

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_BLOCKED = 4


@dataclass(frozen=True, slots=True)
class ImportResult:
    status: str
    event_id: str
    channel: str
    rows: int
    conflicts: tuple[Conflict, ...] = ()
    conflicts_total: int = 0
    manifest_path: str | None = None
    snapshot_path: str | None = None
    ods_path: str | None = None
    batch_id: str | None = None
    note: str | None = None

    @property
    def exit_code(self) -> int:
        if self.status == mf.STATUS_SUCCEEDED:
            return EXIT_OK
        if self.status == mf.STATUS_BLOCKED:
            return EXIT_BLOCKED
        return EXIT_FAILED

    def summary(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "event_id": self.event_id,
            "channel": self.channel,
            "rows": self.rows,
            "conflicts_total": self.conflicts_total,
            "conflicts": [conflict.as_dict() for conflict in self.conflicts],
            "conflicts_rendered": render_conflicts(self.conflicts),
            "manifest_path": self.manifest_path,
            "snapshot_path": self.snapshot_path,
            "ods_path": self.ods_path,
            "batch_id": self.batch_id,
            "note": self.note,
            "exit_code": self.exit_code,
        }


def _event_id(now: datetime) -> str:
    return f"mft-{now.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"


def _field_sources(fields: Mapping[str, str] | None = None, *, channel: str) -> dict[str, str]:
    mapping = fields or {field: field for field in CANONICAL_INSTRUMENT_FIELDS}
    return {field: channel for field in mapping.values()}


def _previous_snapshot(manifest_root: Path) -> list[dict[str, Any]] | None:
    # synthetic 样例 root 里没有真实事件；样例生成需要能看到上一版 synthetic 快照。
    latest = mf.latest_succeeded(manifest_root, include_synthetic=True)
    if latest is None:
        return None
    checksum = latest.get("checksum_sha256") or ""
    if not checksum:
        return None
    path = mf.snapshots_dir(manifest_root) / f"instruments-{checksum}.json"
    if not path.exists():
        return None
    return mf.read_snapshot(path)


def _append_manifest(
    manifest_root: Path,
    *,
    event_id: str,
    channel: str,
    status: str,
    started_at: datetime,
    finished_at: datetime,
    operator: str,
    rows: int = 0,
    checksum: str = "",
    field_sources: Mapping[str, str] | None = None,
    source_url: str | None,
    terms_version: str | None,
    terms_snapshot: tuple[str, str] | None,
    credential_ref: str | None,
    conflicts: tuple[Conflict, ...] = (),
    reason: str | None = None,
    note: str | None = None,
    run_id: str | None = None,
    source_sha256: str | None = None,
    snapshot: tuple[str, str] | None = None,
    synthetic: bool = False,
    source_channel: str | None = None,
    authorization_status: str | None = None,
) -> Path:
    event = mf.ManifestEvent(
        event_id=event_id,
        event_type=mf.EVENT_TYPE_INSTRUMENT_IMPORT,
        channel=channel,
        status=status,
        started_at=started_at,
        finished_at=finished_at,
        operator=operator,
        rows=rows,
        checksum_sha256=checksum,
        field_set=CANONICAL_INSTRUMENT_FIELDS,
        field_sources=_field_sources(field_sources, channel=channel),
        source_url=source_url,
        terms_version=terms_version,
        terms_snapshot_path=terms_snapshot[0] if terms_snapshot else None,
        terms_snapshot_sha256=terms_snapshot[1] if terms_snapshot else None,
        credential_ref=credential_ref,
        conflicts=tuple(conflict.render() for conflict in conflicts),
        reason=reason,
        note=note,
        run_id=run_id,
        source_sha256=source_sha256,
        source_channel=source_channel,
        authorization_status=authorization_status,
        snapshot_path=snapshot[0] if snapshot else None,
        snapshot_sha256=snapshot[1] if snapshot else None,
        synthetic=synthetic,
    )
    return mf.append_event(manifest_root, event)


def import_instruments_csv(
    *,
    csv_path: str | Path,
    storage: SqliteStorage,
    ods_root: str | Path | None,
    manifest_root: str | Path,
    channel: str,
    operator: str,
    source_url: str | None = None,
    terms_version: str | None = None,
    terms_text: str | None = None,
    credential_ref: str | None = None,
    clock: Any = market_now,
    synthetic: bool = False,
    require_durable_manifest: bool = False,
    rootfs: str | Path = "/",
) -> ImportResult:
    """导入一份基础信息 CSV：冲突→阻断（写 blocked 事件），否则落 ODS + 成功事件。

    ``synthetic=True`` 用于生成审计样例：事件自证 ``synthetic: true``，真实批次
    不得携带该字段（H4 m01335 §4）。``require_durable_manifest=True`` 时对 manifest
    root 做设备校验（容器 rootfs 上的审计流 fail-closed，H4 m01335）。
    """
    root = Path(manifest_root)
    mf.assert_durable_audit_root(root, require=require_durable_manifest, rootfs=rootfs)
    started = clock()
    event_id = _event_id(started)
    run_id = new_run_id(started)
    checksum = ""
    terms_snapshot: tuple[str, str] | None = None

    try:
        batch = read_base_info(csv_path)
        checksum = batch.checksum
    except (OSError, CsvFormatError) as exc:
        finished = clock()
        path = _append_manifest(
            root,
            event_id=event_id,
            channel=channel,
            status=mf.STATUS_FAILED,
            started_at=started,
            finished_at=finished,
            operator=operator,
            source_url=source_url,
            terms_version=terms_version,
            terms_snapshot=terms_snapshot,
            credential_ref=credential_ref,
            reason="csv_unreadable_or_invalid",
            note=str(exc),
            run_id=run_id,
            synthetic=synthetic,
        )
        return ImportResult(
            status=mf.STATUS_FAILED,
            event_id=event_id,
            channel=channel,
            rows=0,
            manifest_path=str(path),
            note=str(exc),
        )

    if terms_text is not None:
        terms_snapshot = mf.write_terms_snapshot(root, terms_text)

    conflicts = detect_conflicts(batch.rows, _previous_snapshot(root))
    if conflicts:
        finished = clock()
        if too_many_conflicts(conflicts):
            reason = "too_many_conflicts"
            note = f"冲突 {len(conflicts)} 条 > {CONFLICT_LIMIT}，整批退回查来源，不逐条裁决"
        else:
            reason = "conflicts_require_adjudication"
            note = f"冲突 {len(conflicts)} 条（≤{CONFLICT_LIMIT}）：请人工终审 diff + 来源依据 + 建议"
        path = _append_manifest(
            root,
            event_id=event_id,
            channel=channel,
            status=mf.STATUS_BLOCKED,
            started_at=started,
            finished_at=finished,
            operator=operator,
            rows=len(batch.rows),
            checksum=checksum,
            source_url=source_url,
            terms_version=terms_version,
            terms_snapshot=terms_snapshot,
            credential_ref=credential_ref,
            conflicts=tuple(conflicts),
            reason=reason,
            note=note,
            run_id=run_id,
            source_sha256=checksum,
            synthetic=synthetic,
        )
        return ImportResult(
            status=mf.STATUS_BLOCKED,
            event_id=event_id,
            channel=channel,
            rows=len(batch.rows),
            conflicts=tuple(conflicts),
            conflicts_total=len(conflicts),
            manifest_path=str(path),
            note=note,
        )

    from .adapters import load_adapter

    source = load_adapter(
        "csv",
        options={"csv_path": str(csv_path), "channel": channel, "source_url": source_url, "clock": clock},
    )
    result: MasterSyncResult = sync_instrument_master(
        source,
        storage,
        ods_root=ods_root,
        clock=clock,
        run_id=run_id,
        display=True,
    )
    finished = clock()
    if result.status != "succeeded":
        path = _append_manifest(
            root,
            event_id=event_id,
            channel=channel,
            status=mf.STATUS_FAILED,
            started_at=started,
            finished_at=finished,
            operator=operator,
            rows=result.rows,
            checksum=checksum,
            source_url=source_url,
            terms_version=terms_version,
            terms_snapshot=terms_snapshot,
            credential_ref=credential_ref,
            reason="ods_write_failed",
            note=None if result.status == "succeeded" else "instrument master sync failed",
            run_id=run_id,
            source_sha256=checksum,
            synthetic=synthetic,
        )
        return ImportResult(
            status=mf.STATUS_FAILED,
            event_id=event_id,
            channel=channel,
            rows=result.rows,
            manifest_path=str(path),
            ods_path=result.ods_path,
            batch_id=result.batch_id,
        )

    content_checksum = result.checksum_sha256 or checksum
    snapshot_file, snapshot_file_sha256 = mf.write_snapshot(
        root, content_checksum, snapshot_rows(batch)
    )
    snapshot_rel = f"snapshots/{snapshot_file.name}"
    path = _append_manifest(
        root,
        event_id=event_id,
        channel=channel,
        status=mf.STATUS_SUCCEEDED,
        started_at=started,
        finished_at=finished,
        operator=operator,
        rows=result.rows,
        checksum=content_checksum,
        source_url=source_url,
        terms_version=terms_version,
        terms_snapshot=terms_snapshot,
        credential_ref=credential_ref,
        note="csv base-info import",
        run_id=run_id,
        source_sha256=checksum,
        snapshot=(snapshot_rel, snapshot_file_sha256),
        synthetic=synthetic,
    )
    return ImportResult(
        status=mf.STATUS_SUCCEEDED,
        event_id=event_id,
        channel=channel,
        rows=result.rows,
        manifest_path=str(path),
        snapshot_path=str(snapshot_file),
        ods_path=result.ods_path,
        batch_id=result.batch_id,
    )


def preview_instruments_csv(*, csv_path: str | Path, manifest_root: str | Path) -> dict[str, Any]:
    """dry-run：只解析 CSV 并与上版快照 diff，不写事件/快照/ODS。"""
    root = Path(manifest_root)
    batch: BaseInfoBatch = read_base_info(csv_path)
    conflicts = detect_conflicts(batch.rows, _previous_snapshot(root))
    return {
        "rows": len(batch.rows),
        "checksum_sha256": batch.checksum,
        "field_set": list(batch.field_set),
        "conflicts": [conflict.as_dict() for conflict in conflicts],
        "conflicts_total": len(conflicts),
        "blocked": bool(conflicts),
        "too_many_conflicts": too_many_conflicts(conflicts),
    }


def _records_checksum(rows: list[Mapping[str, Any]]) -> str:
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def record_internal_instrument_import(
    *,
    manifest_root: str | Path,
    result: MasterSyncResult,
    operator: str,
    records: list[Mapping[str, Any]] | None = None,
    source_url: str = "https://tushare.pro",
    terms_version: str | None = None,
    terms_text: str | None = None,
    credential_ref: str | None = None,
    clock: Any = market_now,
    synthetic: bool = False,
    source_channel: str | None = None,
    authorization_status: str | None = None,
) -> Path | None:
    """把 tushare ``stock_basic`` 批次也写进 manifest（channel=tushare，仅内部交叉校验）。

    H4 m00801：tushare 渠道同样入 manifest（同一 schema、channel 区分），但展示态
    校验会拒绝来自该渠道的字段；因此事件 ``display_safe`` 为 False。
    """
    if result.status != "succeeded":
        return None
    root = Path(manifest_root)
    finished = clock()
    terms_snapshot = mf.write_terms_snapshot(root, terms_text) if terms_text is not None else None
    return _append_manifest(
        root,
        event_id=_event_id(finished),
        channel=mf.CHANNEL_TUSHARE,
        status=mf.STATUS_SUCCEEDED,
        started_at=result.started_at,
        finished_at=finished,
        operator=operator,
        rows=result.rows,
        checksum=result.checksum_sha256 or _records_checksum(records or []),
        source_url=source_url,
        terms_version=terms_version,
        terms_snapshot=terms_snapshot,
        credential_ref=credential_ref or "env:TUSHARE_TOKEN",
        note="tushare stock_basic: internal cross-check only, never display",
        run_id=result.batch_id.rsplit("-instrument", 1)[0],
        synthetic=synthetic,
        source_channel=source_channel,
        authorization_status=authorization_status,
    )


#: 兼容旧名（manifest 域内允许出现渠道标识；CLI/业务层只用 ``record_internal_instrument_import``）。
record_tushare_instrument_import = record_internal_instrument_import


__all__ = [
    "CANONICAL_INSTRUMENT_FIELDS",
    "CSV_FIELD_MAP",
    "EXIT_BLOCKED",
    "EXIT_OK",
    "ImportResult",
    "import_instruments_csv",
    "preview_instruments_csv",
    "record_internal_instrument_import",
    "record_tushare_instrument_import",
]
