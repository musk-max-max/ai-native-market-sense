"""主数据导入 manifest：append-only 事件流 + 条款文本内容寻址快照。

H4 11-12 前置口径（m00801）：

- 事件**写一次**，本模块不提供覆盖/删除接口；失败、中断、冲突阻断也写事件；
- 渠道类型显式记录（``tushare`` 内部交叉校验 vs 交易所授权下载/人工导入/官方接口）；
- 条款版本 + 条款全文快照（sha256 内容寻址，快照存全文不只哈希）；
- 每条事件记录字段级来源渠道（展示态校验会拒绝来自 ``tushare`` 渠道的字段）；
- 操作人必填、凭证只记路径或 sha256，不落明文；
- JSONL + 快照目录落在服务写域（``services/ingest/var/audit``），不进 PG。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

#: 渠道类型（H4 m00801：tushare 也要纳入 manifest，靠 channel 区分）。
CHANNEL_TUSHARE = "tushare"
CHANNEL_AUTHORIZED_DOWNLOAD = "authorized_download"
CHANNEL_MANUAL_IMPORT = "manual_import"
CHANNEL_OFFICIAL_API = "official_api"
CHANNELS: tuple[str, ...] = (
    CHANNEL_TUSHARE,
    CHANNEL_AUTHORIZED_DOWNLOAD,
    CHANNEL_MANUAL_IMPORT,
    CHANNEL_OFFICIAL_API,
)

#: 数据来源通道（H4 m03258）：tushare 官方端点 vs 第三方 reseller/mirror。
SOURCE_CHANNEL_OFFICIAL = "official_tushare"
SOURCE_CHANNEL_MIRROR = "third_party_mirror"
SOURCE_CHANNEL_REPLAY = "replay"
SOURCE_CHANNELS: tuple[str, ...] = (
    SOURCE_CHANNEL_OFFICIAL,
    SOURCE_CHANNEL_MIRROR,
    SOURCE_CHANNEL_REPLAY,
)

#: 授权状态：mirror 一律 unverified；官方 token 到手前为 pending。
AUTHORIZATION_UNVERIFIED = "unverified_third_party"
AUTHORIZATION_PENDING = "pending_official_authorization"
AUTHORIZATION_REPLAY = "synthetic_replay"
AUTHORIZATION_STATUSES: tuple[str, ...] = (
    AUTHORIZATION_UNVERIFIED,
    AUTHORIZATION_PENDING,
    AUTHORIZATION_REPLAY,
)

#: 允许进入 C 端展示的渠道（tushare 一律不得作为展示依据）。
DISPLAY_CHANNELS: frozenset[str] = frozenset(
    {CHANNEL_AUTHORIZED_DOWNLOAD, CHANNEL_MANUAL_IMPORT, CHANNEL_OFFICIAL_API}
)

STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"
STATUS_INTERRUPTED = "interrupted"
STATUS_BLOCKED = "blocked"
STATUSES: tuple[str, ...] = (STATUS_SUCCEEDED, STATUS_FAILED, STATUS_INTERRUPTED, STATUS_BLOCKED)

EVENT_TYPE_INSTRUMENT_IMPORT = "instrument_import"


class ManifestError(ValueError):
    """manifest 事件/快照非法。"""


def _utc_iso(value: datetime) -> str:
    """审计流统一 UTC（H4 m01335 §5）：秒级 + 毫秒，后缀 ``Z``。"""
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def assert_durable_audit_root(root: str | Path, *, require: bool, rootfs: str | Path = "/") -> None:
    """生产 profile fail-closed：manifest root 不得落在容器根文件系统上（H4 m01335）。

    容器 rootfs 里的 ``var/audit`` 在重启/替换后即丢，写进去的审计流比没有更坏。
    ``require=False``（本地/CI/e2e 默认）时不做检查。
    """
    if not require:
        return
    directory = Path(root)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        if os.stat(directory).st_dev == os.stat(rootfs).st_dev:
            raise ManifestError(
                f"audit manifest root {directory} is on the container root filesystem device; "
                "mount a PVC/object-store volume (H4 m01064/m01335) or disable strict audit root for local runs"
            )
    except FileNotFoundError:
        raise ManifestError(f"audit root {directory} or rootfs {rootfs} does not exist")


@dataclass(frozen=True, slots=True)
class ManifestEvent:
    """一条主数据导入事件（写入后不可变）。"""

    event_id: str
    event_type: str
    channel: str
    status: str
    started_at: datetime
    finished_at: datetime
    operator: str
    rows: int = 0
    checksum_sha256: str = ""
    field_set: tuple[str, ...] = ()
    field_sources: Mapping[str, str] = field(default_factory=dict)
    source_url: str | None = None
    terms_version: str | None = None
    terms_snapshot_path: str | None = None
    terms_snapshot_sha256: str | None = None
    credential_ref: str | None = None
    conflicts: tuple[str, ...] = ()
    reason: str | None = None
    note: str | None = None
    #: 成功批必须能回指本批行快照（H4 m01335 §3）：路径 + sha256。
    snapshot_path: str | None = None
    snapshot_sha256: str | None = None
    #: synthetic 样例事件必须自证；真实事件**不得**带该字段（H4 m01335 §4）。
    synthetic: bool = False
    #: 本批运行标识与原始来源载荷哈希：内容身份（checksum_sha256）≠ 取数凭证（H4 m01346）。
    run_id: str | None = None
    source_sha256: str | None = None
    #: 来源通道与授权状态（H4 m03258）：经第三方 mirror 的批次必须可审计，不得进展示态。
    source_channel: str | None = None
    authorization_status: str | None = None

    def __post_init__(self) -> None:
        if not self.event_id.strip():
            raise ManifestError("event_id must not be empty")
        if self.event_type != EVENT_TYPE_INSTRUMENT_IMPORT:
            raise ManifestError(f"unsupported event_type {self.event_type!r}")
        if self.channel not in CHANNELS:
            raise ManifestError(f"unsupported channel {self.channel!r}; expected one of {', '.join(CHANNELS)}")
        if self.status not in STATUSES:
            raise ManifestError(f"unsupported status {self.status!r}; expected one of {', '.join(STATUSES)}")
        if not self.operator.strip():
            raise ManifestError("operator is required (CI actor or explicit import parameter)")
        for name in ("started_at", "finished_at"):
            value = getattr(self, name)
            if value.tzinfo is None or value.utcoffset() is None:
                raise ManifestError(f"{name} must be timezone-aware (audit stream uses UTC)")
        if self.finished_at < self.started_at:
            raise ManifestError("finished_at must not be earlier than started_at")
        if self.rows < 0:
            raise ManifestError("rows must be >= 0")
        if self.source_channel is not None and self.source_channel not in SOURCE_CHANNELS:
            raise ManifestError(
                f"unsupported source_channel {self.source_channel!r}; expected one of {', '.join(SOURCE_CHANNELS)}"
            )
        if (
            self.authorization_status is not None
            and self.authorization_status not in AUTHORIZATION_STATUSES
        ):
            raise ManifestError(
                f"unsupported authorization_status {self.authorization_status!r}; "
                f"expected one of {', '.join(AUTHORIZATION_STATUSES)}"
            )
        if self.source_channel == SOURCE_CHANNEL_MIRROR and self.channel != CHANNEL_TUSHARE:
            raise ManifestError("third_party_mirror source_channel requires channel='tushare'")
        unknown = sorted(set(self.field_sources) - set(FIELD_SOURCES_ALLOWED))
        if unknown:
            raise ManifestError(f"unknown field_sources keys: {', '.join(unknown)}")
        for name, channel in self.field_sources.items():
            if channel not in CHANNELS:
                raise ManifestError(f"field {name!r} has unsupported channel {channel!r}")
        if self.channel != CHANNEL_TUSHARE and self.status == STATUS_SUCCEEDED:
            missing = [
                name
                for name, value in (
                    ("source_url", self.source_url),
                    ("terms_version", self.terms_version),
                    ("terms_snapshot_path", self.terms_snapshot_path),
                    ("terms_snapshot_sha256", self.terms_snapshot_sha256),
                    ("credential_ref", self.credential_ref),
                )
                if not value
            ]
            if missing:
                raise ManifestError(
                    f"channel {self.channel!r} import is missing required evidence: {', '.join(missing)}"
                )
        if self.status == STATUS_SUCCEEDED:
            if not self.checksum_sha256:
                raise ManifestError("succeeded import must record checksum_sha256")
            if (
                self.channel in DISPLAY_CHANNELS
                and self.rows > 0
                and not (self.snapshot_path and self.snapshot_sha256)
            ):
                raise ManifestError(
                    "succeeded display import must record snapshot_path and snapshot_sha256 (H4 m01335 §3)"
                )
            if self.snapshot_sha256 is not None and len(self.snapshot_sha256) != 64:
                raise ManifestError("snapshot_sha256 must be a sha256 hex digest")

    @property
    def display_safe(self) -> bool:
        """是否可作为 C 端展示依据（H4 m01335 §1 派生规则，不许手写）。

        只有 ``status == succeeded`` 且渠道与全部字段来源都落在展示白名单里才为
        True；blocked / failed / interrupted 一律 False（本批没有可展示产物）。
        """
        if self.status != STATUS_SUCCEEDED:
            return False
        if self.synthetic:
            # synthetic 是形状样例，永远不能作为展示依据（H4 m01552 M1 附条 ②）。
            return False
        if self.channel not in DISPLAY_CHANNELS:
            return False
        return all(channel in DISPLAY_CHANNELS for channel in self.field_sources.values())

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "channel": self.channel,
            "status": self.status,
            "started_at": _utc_iso(self.started_at),
            "finished_at": _utc_iso(self.finished_at),
            "operator": self.operator,
            "rows": self.rows,
            "checksum_sha256": self.checksum_sha256,
            "field_set": list(self.field_set),
            "field_sources": dict(sorted(self.field_sources.items())),
            "source_url": self.source_url,
            "terms_version": self.terms_version,
            "terms_snapshot_path": self.terms_snapshot_path,
            "terms_snapshot_sha256": self.terms_snapshot_sha256,
            "credential_ref": self.credential_ref,
            "conflicts": list(self.conflicts),
            "reason": self.reason,
            "note": self.note,
            "snapshot_path": self.snapshot_path,
            "snapshot_sha256": self.snapshot_sha256,
            "run_id": self.run_id,
            "source_sha256": self.source_sha256,
            "display_safe": self.display_safe,
        }
        if self.source_channel is not None:
            payload["source_channel"] = self.source_channel
        if self.authorization_status is not None:
            payload["authorization_status"] = self.authorization_status
        if self.synthetic:
            payload["synthetic"] = True
        return payload


#: canonical instrument.v1 字段（展示态校验按字段来源渠道判定）。
FIELD_SOURCES_ALLOWED: tuple[str, ...] = (
    "instrument_id",
    "exchange",
    "code",
    "name",
    "board",
    "security_type",
    "list_status",
    "lot_size",
    "listed_at",
)


#: 哈希链首条事件的 prev_hash（H4 m01552 M1：定宽 64 个 "0"，不用 GENESIS 字样）。
ZERO_HASH = "0" * 64
#: 兼容旧名（等同 ZERO_HASH）；新代码用 ZERO_HASH。
GENESIS = ZERO_HASH
#: 链头文件；与 manifest.jsonl 同 root，随审计卷一起持久化。
HEAD_NAME = "manifest.head"
#: demo 标记文件（H4 m01620）：存在即拒绝被 release 证据脚本引用。
DEMO_MARKER = "DEMO"


def is_demo_root(root: str | Path) -> bool:
    """该审计根是否为 demo（``DEMO`` 标记文件存在）。

    demo 只能做机制冒烟，不能作为 11-12 证据；``verify-manifest`` 默认拒绝（需显式
    ``--allow-demo``），release 证据脚本必须直接报错。
    """
    return (Path(root) / DEMO_MARKER).is_file()


def assert_not_demo_root(root: str | Path, *, allow_demo: bool = False) -> None:
    if not allow_demo and is_demo_root(root):
        raise ManifestError(
            f"audit root {Path(root)} is marked DEMO and cannot be used as release evidence "
            "(H4 m01620); pass allow_demo only for mechanism smoke tests"
        )


def manifest_path(root: str | Path) -> Path:
    return Path(root) / "manifest.jsonl"


def head_path(root: str | Path) -> Path:
    return Path(root) / HEAD_NAME


def _canonical(payload: Mapping[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _chain_hash(prev_hash: str, payload: Mapping[str, Any]) -> str:
    body = dict(payload)
    body.pop("prev_hash", None)
    body.pop("hash", None)
    return hashlib.sha256(prev_hash.encode("utf-8") + b"\n" + _canonical(body)).hexdigest()


def read_head(root: str | Path) -> dict[str, Any] | None:
    target = head_path(root)
    if not target.exists():
        return None
    return json.loads(target.read_text(encoding="utf-8"))


def _write_head(root: Path, *, last_hash: str, count: int, updated_at: str) -> None:
    target = head_path(root)
    payload = {
        "schema_version": 1,
        "last_hash": last_hash,
        "count": count,
        "updated_at": updated_at,
    }
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, target)


def terms_dir(root: str | Path) -> Path:
    return Path(root) / "terms"


def snapshots_dir(root: str | Path) -> Path:
    return Path(root) / "snapshots"


def write_terms_snapshot(root: str | Path, text: str) -> tuple[str, str]:
    """条款全文 → sha256 内容寻址快照；返回 (相对路径, sha256)。

    同名文件已存在时校验内容一致（内容寻址必须幂等），从不覆盖已有内容。
    """
    payload = text.encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    directory = terms_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{digest}.txt"
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ManifestError(f"terms snapshot hash mismatch: {target}")
        return f"terms/{digest}.txt", digest
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(payload)
    os.replace(tmp, target)
    return f"terms/{digest}.txt", digest


def append_event(root: str | Path, event: ManifestEvent) -> Path:
    """追加一条事件（O_APPEND + fsync）并更新哈希链/链头（H4 m01376）。

    真实事件：``hash = sha256(prev_hash + "\n" + canonical_json(event 去掉 prev_hash/hash))``，
    首条 ``prev_hash=ZERO_HASH``（64 个 "0"）；``manifest.head`` 原子更新（tmp + ``os.replace``）。
    ``synthetic`` 样例同样带 ``prev_hash``/``hash``（每条事件可自证未被手改），但不参与
    ``manifest.head``/count，读取方（A2 派生/verify-manifest）直接忽略。
    本模块不提供改写/删除入口。
    """
    directory = Path(root)
    directory.mkdir(parents=True, exist_ok=True)
    target = manifest_path(directory)
    payload = event.to_dict()
    payload.pop("prev_hash", None)
    payload.pop("hash", None)
    if event.synthetic:
        # synthetic 单独成链（不与真实链/head 混链），读取方仍可直接忽略。
        previous_synthetic = next(
            (
                str(item.get("hash"))
                for item in reversed(read_events(directory))
                if item.get("synthetic") and item.get("hash")
            ),
            ZERO_HASH,
        )
        prev_hash = previous_synthetic
    else:
        head = read_head(directory)
        prev_hash = str(head["last_hash"]) if head else ZERO_HASH
    event_hash = _chain_hash(prev_hash, payload)
    payload["prev_hash"] = prev_hash
    payload["hash"] = event_hash
    line = json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n"
    fd = os.open(target, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        os.write(fd, line.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    if not event.synthetic:
        previous = read_head(directory)
        count = int(previous["count"]) + 1 if previous else 1
        _write_head(
            directory,
            last_hash=payload["hash"],
            count=count,
            updated_at=_utc_iso(event.finished_at),
        )
    return target


def _parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _verify_snapshots(directory: Path, real: list[dict[str, Any]]) -> None:
    """读取侧证明快照文件未被改：字节 sha256 + 内嵌 checksum + rows 数（H4 m01496/A2 m01525）。"""
    for event in real:
        if event.get("status") != STATUS_SUCCEEDED:
            continue
        snapshot_path = event.get("snapshot_path")
        if not snapshot_path:
            continue
        relative = Path(str(snapshot_path))
        if relative.is_absolute() or ".." in relative.parts:
            raise ManifestError(f"snapshot path must stay under manifest root: {snapshot_path}")
        snapshot = directory / relative
        if not snapshot.is_file():
            raise ManifestError(f"snapshot file missing for event {event.get('event_id')}: {snapshot_path}")
        data = snapshot.read_bytes()
        expected_file_hash = event.get("snapshot_sha256")
        if not expected_file_hash:
            raise ManifestError(
                f"event {event.get('event_id')} has snapshot_path but no snapshot_sha256"
            )
        actual_file_hash = hashlib.sha256(data).hexdigest()
        if actual_file_hash != expected_file_hash:
            raise ManifestError(
                f"snapshot file changed for event {event.get('event_id')}: "
                f"expected sha256 {expected_file_hash}, got {actual_file_hash}"
            )
        try:
            payload = json.loads(data)
        except ValueError as exc:
            raise ManifestError(f"snapshot for event {event.get('event_id')} is not valid JSON") from exc
        if payload.get("checksum_sha256") != event.get("checksum_sha256"):
            raise ManifestError(
                f"snapshot checksum mismatch for event {event.get('event_id')}: "
                f"{payload.get('checksum_sha256')!r} != {event.get('checksum_sha256')!r}"
            )
        rows = payload.get("rows")
        if not isinstance(rows, list) or len(rows) != int(event.get("rows", -1)):
            raise ManifestError(
                f"snapshot row count mismatch for event {event.get('event_id')}"
            )


def verify_manifest_chain(
    root: str | Path, *, require_head: bool = True, allow_demo: bool = False
) -> dict[str, Any]:
    """校验 manifest 哈希链、head、event_id 唯一性与 finished_at 顺序（H4 m01376）。

    审计根带 ``DEMO`` 标记时默认拒绝（``allow_demo=True`` 仅供机制冒烟）。

    链断裂 / count 与真实事件行数不符 / head 缺失（``require_head=True``）/
    event_id 重复 / finished_at 倒序 → ``ManifestError``。``synthetic`` 事件不参与。
    """
    assert_not_demo_root(root, allow_demo=allow_demo)
    events = read_events(root)
    real = [event for event in events if not event.get("synthetic")]
    # synthetic 行整行跳过、不校验其链、不计入 count（H4 m01552 M1）。
    seen_ids: set[str] = set()
    previous_finished: datetime | None = None
    prev_hash = ZERO_HASH
    for index, event in enumerate(real):
        event_id = str(event.get("event_id"))
        if event_id in seen_ids:
            raise ManifestError(f"duplicate event_id at chain position {index}: {event_id}")
        seen_ids.add(event_id)
        finished_at = _parse_utc(str(event.get("finished_at")))
        if previous_finished is not None and finished_at < previous_finished:
            raise ManifestError(f"finished_at decreasing at chain position {index}: {event_id}")
        previous_finished = finished_at
        expected = _chain_hash(prev_hash, event)
        actual = str(event.get("hash"))
        if actual != expected:
            raise ManifestError(
                f"hash chain broken at event {event_id}: expected {expected}, got {actual}"
            )
        prev_hash = actual
    directory = Path(root)
    _verify_snapshots(directory, real)
    head = read_head(directory)
    if require_head and real and head is None:
        raise ManifestError("manifest.head is missing; audit chain cannot be trusted")
    if head is not None:
        if head.get("schema_version") != 1:
            raise ManifestError(
                f"manifest.head schema_version must be 1 (got {head.get('schema_version')!r})"
            )
        head_hash = str(head.get("last_hash"))
        head_count = int(head.get("count", -1))
        if head_count != len(real):
            raise ManifestError(f"manifest.head count {head_count} != real events {len(real)}")
        expected_last = prev_hash if real else ZERO_HASH
        if head_hash != expected_last:
            raise ManifestError(f"manifest.head last_hash {head_hash} != chain tail {expected_last}")
    return {
        "events_total": len(events),
        "events_real": len(real),
        "events_synthetic": len(events) - len(real),
        "last_hash": prev_hash,
        "head": head,
    }


def read_events(root: str | Path) -> list[dict[str, Any]]:
    target = manifest_path(root)
    if not target.exists():
        return []
    events: list[dict[str, Any]] = []
    for line in target.read_text(encoding="utf-8").splitlines():
        if line.strip():
            events.append(json.loads(line))
    return events


def latest_succeeded(
    root: str | Path,
    *,
    event_type: str = EVENT_TYPE_INSTRUMENT_IMPORT,
    include_synthetic: bool = False,
) -> dict[str, Any] | None:
    """最近一条成功事件（用于「与上版 diff」；默认忽略 synthetic 样例）。"""
    for event in reversed(read_events(root)):
        if event.get("synthetic") and not include_synthetic:
            continue
        if event.get("event_type") == event_type and event.get("status") == STATUS_SUCCEEDED:
            return event
    return None


def write_snapshot(
    root: str | Path, checksum: str, rows: Iterable[Mapping[str, Any]]
) -> tuple[Path, str]:
    """把成功导入的行快照落盘（内容寻址），返回 ``(path, 文件字节 sha256)``。

    ``checksum`` 是批次内容身份（canonical rows 哈希），用于文件名；返回值第二部分是
    **快照文件字节**的 sha256，写进事件 ``snapshot_sha256``，供读取侧证明文件未被改。
    """
    directory = snapshots_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"instruments-{checksum}.json"
    payload = json.dumps(
        {"checksum_sha256": checksum, "rows": list(rows)}, ensure_ascii=False, sort_keys=True
    )
    data = payload.encode("utf-8")
    if target.exists():
        if target.read_bytes() != data:
            raise ManifestError(f"snapshot content mismatch for checksum {checksum}")
        return target, hashlib.sha256(data).hexdigest()
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return target, hashlib.sha256(data).hexdigest()


def read_snapshot(path: str | Path) -> list[dict[str, Any]]:
    return list(json.loads(Path(path).read_text(encoding="utf-8"))["rows"])


__all__ = [
    "CHANNELS",
    "CHANNEL_AUTHORIZED_DOWNLOAD",
    "CHANNEL_MANUAL_IMPORT",
    "CHANNEL_OFFICIAL_API",
    "AUTHORIZATION_PENDING",
    "AUTHORIZATION_REPLAY",
    "AUTHORIZATION_UNVERIFIED",
    "CHANNEL_TUSHARE",
    "DISPLAY_CHANNELS",
    "SOURCE_CHANNEL_MIRROR",
    "SOURCE_CHANNEL_OFFICIAL",
    "SOURCE_CHANNEL_REPLAY",
    "SOURCE_CHANNELS",
    "EVENT_TYPE_INSTRUMENT_IMPORT",
    "FIELD_SOURCES_ALLOWED",
    "ManifestError",
    "ManifestEvent",
    "STATUSES",
    "STATUS_BLOCKED",
    "STATUS_FAILED",
    "STATUS_INTERRUPTED",
    "STATUS_SUCCEEDED",
    "GENESIS",
    "DEMO_MARKER",
    "assert_not_demo_root",
    "is_demo_root",
    "HEAD_NAME",
    "append_event",
    "assert_durable_audit_root",
    "head_path",
    "read_head",
    "verify_manifest_chain",
    "latest_succeeded",
    "manifest_path",
    "read_events",
    "read_snapshot",
    "terms_dir",
    "write_snapshot",
    "write_terms_snapshot",
]
