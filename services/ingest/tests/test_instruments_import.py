"""主数据导入：CSV 校验、冲突阻断、manifest 事件流、CLI 端到端。

边界（对应 lead m00796 / H4 m00801）：
- 展示用基础信息只能来自交易所 CSV 导入（channel != tushare）；
- tushare 路径的批次也写 manifest，但 display_safe=False，仅内部交叉校验；
- 冲突自动阻断：≤5 条输出 diff 待人工终审，>5 条整批退回；
- manifest 事件 append-only，失败/中断/阻断也写；条款快照 sha256 内容寻址。
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path

import pytest

from market_ingest import manifest as mf
from market_ingest.instruments_csv import (
    CONFLICT_LIMIT,
    CsvFormatError,
    detect_conflicts,
    parse_base_info,
    read_base_info,
    snapshot_rows,
)
from market_ingest.instruments_import import (
    import_instruments_csv,
    preview_instruments_csv,
    record_internal_instrument_import,
)
from market_ingest.models import ListStatus, market_now
from market_ingest.storage import SqliteStorage
from market_ingest.sync import MasterSyncResult

from support import FakeClock

HEADER = "instrument_id,name,board,list_status,list_date,change_basis_url"

CSV_TEXT = HEADER + "\n" + "\n".join(
    [
        "SSE:600519,贵州茅台,main,listed,2001-08-27,",
        "SZSE:000001,平安银行,main,listed,1991-04-03,",
        "SZSE:300750,宁德时代,gem,listed,2018-06-11,",
        "SSE:688981,中芯国际,star,listed,2020-07-16,",
        "BSE:830799,贝特瑞,bse,listed,2021-11-15,",
    ]
) + "\n"


def _write_csv(tmp_path: Path, text: str = CSV_TEXT, name: str = "base_info.csv") -> Path:
    path = tmp_path / "instruments" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _run_import(tmp_path: Path, csv_path: Path, **overrides):
    storage = SqliteStorage(tmp_path / "ingest.db")
    kwargs = dict(
        csv_path=csv_path,
        storage=storage,
        ods_root=tmp_path / "ods",
        manifest_root=tmp_path / "audit",
        channel=mf.CHANNEL_MANUAL_IMPORT,
        operator="ci-test",
        source_url="https://example.test/public-list",
        terms_version="terms-v1",
        terms_text="示例条款全文 v1：允许内部使用，禁止再分发。",
        credential_ref="sha256:deadbeef",
        clock=FakeClock(),
    )
    kwargs.update(overrides)
    try:
        return import_instruments_csv(**kwargs)
    finally:
        storage.close()


# ---------- CSV 解析 ----------


def test_parse_valid_base_info(tmp_path: Path) -> None:
    path = _write_csv(tmp_path)
    batch = read_base_info(path)
    assert len(batch.rows) == 5
    assert batch.field_set == ("instrument_id", "name", "board", "list_status", "list_date")
    assert len(batch.checksum) == 64
    first = batch.rows[0]
    assert first.instrument_id == "SSE:600519"
    assert first.name == "贵州茅台"
    assert first.list_date == date(2001, 8, 27)
    assert first.change_basis_url is None


def test_parse_tolerates_bom_and_optional_basis_column(tmp_path: Path) -> None:
    text = "\ufeff" + HEADER + "\nSSE:600519,贵州茅台,main,listed,2001-08-27,https://example.test/ann\n"
    path = _write_csv(tmp_path, text)
    batch = read_base_info(path)
    assert batch.rows[0].change_basis_url == "https://example.test/ann"


@pytest.mark.parametrize(
    "text",
    [
        "instrument_id,name,board\nSSE:600519,贵州茅台,main\n",  # 缺列
        HEADER + "\nSSE:600519,贵州茅台,main,listed,2001-08-27,,industry\n",  # 多一列
        HEADER + "\n600519.SH,贵州茅台,main,listed,2001-08-27,\n",  # 点号格式
        HEADER + "\nSSE:600519,贵州茅台,main,listed,2001/08/27,\n",  # 日期格式
        HEADER + "\nSSE:600519,,main,listed,2001-08-27,\n",  # 空名称
        HEADER + "\nSSE:600519,贵州茅台,concept,listed,2001-08-27,\n",  # 非法板块
        "",
    ],
)
def test_parse_rejects_invalid_csv(tmp_path: Path, text: str) -> None:
    path = _write_csv(tmp_path, text)
    with pytest.raises(CsvFormatError):
        read_base_info(path)


# ---------- 冲突检测 ----------


def _rows(text: str):
    return parse_base_info(text, path=Path("mem.csv")).rows


def test_duplicate_code_conflict(tmp_path: Path) -> None:
    text = HEADER + "\nSSE:600519,贵州茅台,main,listed,2001-08-27,\nSSE:600519,贵州茅台,main,listed,2001-08-27,\n"
    conflicts = detect_conflicts(_rows(text), None)
    assert [conflict.kind for conflict in conflicts] == ["duplicate_code"]


def test_name_code_conflict(tmp_path: Path) -> None:
    text = HEADER + "\nSSE:600519,同名,main,listed,2001-08-27,\nSZSE:000001,同名,main,listed,1991-04-03,\n"
    conflicts = detect_conflicts(_rows(text), None)
    assert sorted(conflict.kind for conflict in conflicts) == ["name_code_conflict", "name_code_conflict"]


def test_board_mismatch_conflict() -> None:
    text = HEADER + "\nSSE:688981,中芯国际,main,listed,2020-07-16,\n"
    conflicts = detect_conflicts(_rows(text), None)
    assert [conflict.kind for conflict in conflicts] == ["board_mismatch"]


def test_diff_without_basis_is_blocked() -> None:
    previous = snapshot_rows(parse_base_info(CSV_TEXT, path=Path("mem.csv")))
    renamed = CSV_TEXT.replace("贵州茅台", "茅台改名")
    status_changed = CSV_TEXT.replace("SZSE:000001,平安银行,main,listed", "SZSE:000001,平安银行,main,delisted")
    removed = "\n".join(
        line for line in CSV_TEXT.splitlines() if not line.startswith("BSE:830799")
    ) + "\n"
    for text, expected in (
        (renamed, "rename_without_basis"),
        (status_changed, "status_change_without_basis"),
        (removed, "removed_without_basis"),
    ):
        kinds = [conflict.kind for conflict in detect_conflicts(_rows(text), previous)]
        assert expected in kinds
    # 带公告依据的变更是可接受的（不再阻断）
    with_basis = renamed.replace("茅台改名,main,listed,2001-08-27,", "茅台改名,main,listed,2001-08-27,https://example.test/ann")
    assert detect_conflicts(_rows(with_basis), previous) == []


def test_conflict_limit_threshold() -> None:
    lines = [HEADER]
    for index in range(CONFLICT_LIMIT + 1):
        code = f"6005{index:02d}"
        lines.append(f"SSE:{code},同名单,main,listed,2001-08-27,")
        lines.append(f"SSE:{code},同名单,main,listed,2001-08-27,")
    from market_ingest.instruments_csv import too_many_conflicts

    conflicts = detect_conflicts(_rows("\n".join(lines) + "\n"), None)
    assert len(conflicts) > CONFLICT_LIMIT
    assert too_many_conflicts(conflicts)


# ---------- manifest 事件与快照 ----------


def test_manifest_event_appends_and_validates(tmp_path: Path) -> None:
    event = mf.ManifestEvent(
        event_id="mft-test",
        event_type=mf.EVENT_TYPE_INSTRUMENT_IMPORT,
        channel=mf.CHANNEL_MANUAL_IMPORT,
        status=mf.STATUS_SUCCEEDED,
        started_at=market_now(),
        finished_at=market_now(),
        operator="ci-test",
        rows=5,
        source_url="https://example.test/list",
        terms_version="v1",
        terms_snapshot_path="terms/abc.txt",
        terms_snapshot_sha256="abc",
        credential_ref="sha256:deadbeef",
        checksum_sha256="c" * 64,
        snapshot_path="snapshots/instruments-" + "c" * 64 + ".json",
        snapshot_sha256="c" * 64,
        run_id="run-test",
        field_sources={field: mf.CHANNEL_MANUAL_IMPORT for field in mf.FIELD_SOURCES_ALLOWED},
    )
    assert event.display_safe is True
    path = mf.append_event(tmp_path / "audit", event)
    assert path.read_text(encoding="utf-8").count("\n") == 1
    mf.append_event(tmp_path / "audit", event)
    assert len(mf.read_events(tmp_path / "audit")) == 2

    with pytest.raises(mf.ManifestError):
        mf.ManifestEvent(
            event_id="x",
            event_type=mf.EVENT_TYPE_INSTRUMENT_IMPORT,
            channel=mf.CHANNEL_MANUAL_IMPORT,
            status=mf.STATUS_SUCCEEDED,
            started_at=market_now(),
            finished_at=market_now(),
            operator="",
        )
    with pytest.raises(mf.ManifestError):
        mf.ManifestEvent(
            event_id="x",
            event_type=mf.EVENT_TYPE_INSTRUMENT_IMPORT,
            channel=mf.CHANNEL_MANUAL_IMPORT,
            status=mf.STATUS_SUCCEEDED,
            started_at=market_now(),
            finished_at=market_now(),
            operator="ci-test",
        )


def test_tushare_event_is_not_display_safe(tmp_path: Path) -> None:
    event = mf.ManifestEvent(
        event_id="mft-ts",
        event_type=mf.EVENT_TYPE_INSTRUMENT_IMPORT,
        channel=mf.CHANNEL_TUSHARE,
        status=mf.STATUS_SUCCEEDED,
        started_at=market_now(),
        finished_at=market_now(),
        operator="ci-test",
        rows=1,
        checksum_sha256="a" * 64,
        field_sources={field: mf.CHANNEL_TUSHARE for field in mf.FIELD_SOURCES_ALLOWED},
    )
    assert event.display_safe is False


def test_terms_snapshot_is_content_addressed(tmp_path: Path) -> None:
    rel, digest = mf.write_terms_snapshot(tmp_path / "audit", "条款全文 v1")
    assert rel == f"terms/{digest}.txt"
    assert (tmp_path / "audit" / rel).read_text(encoding="utf-8") == "条款全文 v1"
    again_rel, again_digest = mf.write_terms_snapshot(tmp_path / "audit", "条款全文 v1")
    assert (again_rel, again_digest) == (rel, digest)


# ---------- 导入编排 ----------


def test_import_success_writes_ods_snapshot_and_event(tmp_path: Path) -> None:
    csv_path = _write_csv(tmp_path)
    result = _run_import(tmp_path, csv_path)
    assert result.status == "succeeded"
    assert result.exit_code == 0
    assert result.rows == 5
    ods_files = list((tmp_path / "ods" / "instrument").glob("dt=*/*.json"))
    assert len(ods_files) == 1
    payload = json.loads(ods_files[0].read_text(encoding="utf-8"))
    assert payload["schema"] == "instrument.v1"
    assert len(payload["rows"]) == 5
    assert payload["rows"][0]["exchange"] in {"SSE", "SZSE", "BSE"}
    assert all("ts_code" not in row for row in payload["rows"])

    events = mf.read_events(tmp_path / "audit")
    assert len(events) == 1
    event = events[0]
    assert event["status"] == "succeeded"
    assert event["channel"] == "manual_import"
    assert event["display_safe"] is True
    assert event["source_url"] == "https://example.test/public-list"
    assert event["terms_version"] == "terms-v1"
    assert event["terms_snapshot_sha256"]
    assert event["operator"] == "ci-test"
    assert result.snapshot_path and Path(result.snapshot_path).exists()
    # snapshot_sha256 是快照**文件字节**哈希（H4 m01496 / A2 m01525），不是内容 checksum。
    snapshot_bytes = Path(result.snapshot_path).read_bytes()
    assert event["snapshot_sha256"] == hashlib.sha256(snapshot_bytes).hexdigest()
    assert event["snapshot_path"] == f"snapshots/instruments-{event['checksum_sha256']}.json"
    assert event["snapshot_sha256"] != event["checksum_sha256"]


def test_import_same_csv_again_has_no_conflicts(tmp_path: Path) -> None:
    csv_path = _write_csv(tmp_path)
    assert _run_import(tmp_path, csv_path).status == "succeeded"
    second = _run_import(tmp_path, csv_path)
    assert second.status == "succeeded"


def test_import_rename_without_basis_is_blocked(tmp_path: Path) -> None:
    csv_path = _write_csv(tmp_path)
    assert _run_import(tmp_path, csv_path).status == "succeeded"
    renamed = _write_csv(tmp_path, CSV_TEXT.replace("贵州茅台", "茅台改名"), name="renamed.csv")
    result = _run_import(tmp_path, renamed)
    assert result.status == "blocked"
    assert result.exit_code == 4
    assert result.conflicts_total == 1
    assert result.conflicts[0].kind == "rename_without_basis"
    assert list((tmp_path / "ods" / "instrument").glob("dt=*/*.json"))
    assert len(list((tmp_path / "ods" / "instrument").glob("dt=*/*.json"))) == 1  # 未写第二个批次
    events = mf.read_events(tmp_path / "audit")
    assert events[-1]["status"] == "blocked"
    assert "rename_without_basis" in events[-1]["conflicts"][0]


def test_import_unreadable_csv_writes_failed_event(tmp_path: Path) -> None:
    result = _run_import(tmp_path, tmp_path / "missing.csv")
    assert result.status == "failed"
    assert result.exit_code == 1
    events = mf.read_events(tmp_path / "audit")
    assert events[-1]["status"] == "failed"
    assert events[-1]["reason"] == "csv_unreadable_or_invalid"


def test_preview_does_not_write_manifest(tmp_path: Path) -> None:
    csv_path = _write_csv(tmp_path)
    preview = preview_instruments_csv(csv_path=csv_path, manifest_root=tmp_path / "audit")
    assert preview["rows"] == 5
    assert preview["blocked"] is False
    assert not (tmp_path / "audit" / "manifest.jsonl").exists()


def test_tushare_import_is_recorded_but_not_display_safe(tmp_path: Path) -> None:
    clock = FakeClock()
    result = MasterSyncResult(
        batch_id="ing-test-instrument",
        dataset="instrument",
        status="succeeded",
        rows=1,
        rejected_rows=0,
        calls_used=1,
        started_at=clock(),
        finished_at=clock(),
        checksum_sha256="abc123",
    )
    path = record_internal_instrument_import(
        manifest_root=tmp_path / "audit",
        result=result,
        operator="ci-test",
        clock=clock,
    )
    assert path is not None
    event = mf.read_events(tmp_path / "audit")[-1]
    assert event["channel"] == "tushare"
    assert event["display_safe"] is False
    assert event["checksum_sha256"] == "abc123"


# ---------- CLI ----------

TERMS = "示例条款全文：允许内部使用。"


def test_cli_csv_import_success(tmp_path: Path, capsys) -> None:
    from market_ingest.cli import main as cli_main

    csv_path = _write_csv(tmp_path)
    terms_path = tmp_path / "terms.txt"
    terms_path.write_text(TERMS, encoding="utf-8")
    code = cli_main(
        [
            "sync-instruments",
            "--source",
            "csv",
            "--csv-file",
            str(csv_path),
            "--channel",
            "authorized_download",
            "--source-url",
            "https://example.test/list",
            "--terms-version",
            "v1",
            "--terms-file",
            str(terms_path),
            "--credential-ref",
            "sha256:deadbeef",
            "--operator",
            "ci-test",
            "--manifest-root",
            str(tmp_path / "audit"),
            "--db",
            str(tmp_path / "ingest.db"),
            "--ods-root",
            str(tmp_path / "ods"),
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "succeeded"
    assert payload["rows"] == 5
    assert payload["exit_code"] == 0


def test_cli_synthetic_import_covers_synthetic_branch(tmp_path: Path, capsys) -> None:
    """e2e seed 去掉了 --synthetic，这里保住 synthetic 分支的 CI 覆盖（lead m01622）。

    synthetic 批次仍走完整执行路径并落 ODS，但事件 display_safe 必须 false、head 不写，
    读取方（A2/verify-manifest）整行跳过。
    """
    from market_ingest.cli import main as cli_main

    csv_path = _write_csv(tmp_path)
    terms_path = tmp_path / "terms.txt"
    terms_path.write_text(TERMS, encoding="utf-8")
    code = cli_main(
        [
            "sync-instruments", "--source", "csv", "--csv-file", str(csv_path),
            "--channel", "manual_import",
            "--source-url", "https://example.test/list",
            "--terms-version", "v1", "--terms-file", str(terms_path),
            "--credential-ref", "sha256:deadbeef", "--operator", "ci-test",
            "--synthetic",
            "--manifest-root", str(tmp_path / "audit"),
            "--db", str(tmp_path / "ingest.db"),
            "--ods-root", str(tmp_path / "ods"),
        ]
    )
    assert code == 0
    capsys.readouterr()
    events = mf.read_events(tmp_path / "audit")
    assert len(events) == 1
    assert events[0]["synthetic"] is True
    assert events[0]["display_safe"] is False
    assert mf.read_head(tmp_path / "audit") is None
    assert mf.verify_manifest_chain(tmp_path / "audit")["events_real"] == 0
    # 机制真实跑过：display 批次仍存在（只是不能派生 display_safe）。
    assert list((tmp_path / "ods" / "display" / "instrument").glob("dt=*/*.json"))


def test_verify_manifest_detects_snapshot_tampering(tmp_path: Path) -> None:
    """snapshot_sha256 是文件字节哈希：快照被改/被删，读取侧必须拒绝（H4 m01496）。"""
    csv_path = _write_csv(tmp_path)
    result = _run_import(tmp_path, csv_path)
    assert result.snapshot_path is not None
    snapshot = Path(result.snapshot_path)
    original = snapshot.read_bytes()
    mf.verify_manifest_chain(tmp_path / "audit")

    snapshot.write_bytes(original.replace(b"\xe8\x8c\x85", b"\xe8\x8c\x86"))
    with pytest.raises(mf.ManifestError, match="snapshot file changed"):
        mf.verify_manifest_chain(tmp_path / "audit")

    snapshot.write_bytes(original)
    snapshot.unlink()
    with pytest.raises(mf.ManifestError, match="snapshot file missing"):
        mf.verify_manifest_chain(tmp_path / "audit")


def test_verify_manifest_rejects_demo_root(tmp_path: Path) -> None:
    root = tmp_path / "audit"
    mf.append_event(root, _audit_event("e1", root=root))
    (root / mf.DEMO_MARKER).write_text("DEMO", encoding="utf-8")
    with pytest.raises(mf.ManifestError):
        mf.verify_manifest_chain(root)
    assert mf.verify_manifest_chain(root, allow_demo=True)["events_real"] == 1


def test_cli_verify_manifest_demo_requires_flag(tmp_path: Path) -> None:
    from market_ingest.cli import main as cli_main

    root = tmp_path / "audit"
    mf.append_event(root, _audit_event("e1", root=root))
    (root / mf.DEMO_MARKER).write_text("DEMO", encoding="utf-8")
    assert cli_main(["verify-manifest", "--manifest-root", str(root)]) == 1
    assert cli_main(["verify-manifest", "--manifest-root", str(root), "--allow-demo"]) == 0


def test_cli_csv_import_requires_operator(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    from market_ingest.cli import main as cli_main

    monkeypatch.delenv("DATA_IMPORT_OPERATOR", raising=False)
    csv_path = _write_csv(tmp_path)
    terms_path = tmp_path / "terms.txt"
    terms_path.write_text(TERMS, encoding="utf-8")
    code = cli_main(
        ["sync-instruments", "--source", "csv", "--csv-file", str(csv_path),
         "--channel", "manual_import",
         "--source-url", "https://example.test/list",
         "--terms-version", "v1", "--terms-file", str(terms_path),
         "--credential-ref", "sha256:deadbeef",
         "--manifest-root", str(tmp_path / "audit"), "--db", str(tmp_path / "ingest.db")]
    )
    assert code == 2
    assert "missing operator" in capsys.readouterr().err


def test_cli_csv_import_blocked_exit_4(tmp_path: Path, capsys) -> None:
    from market_ingest.cli import main as cli_main

    terms_path = tmp_path / "terms.txt"
    terms_path.write_text(TERMS, encoding="utf-8")
    base_args = [
        "sync-instruments", "--source", "csv",
        "--channel", "manual_import",
        "--source-url", "https://example.test/list",
        "--terms-version", "v1",
        "--terms-file", str(terms_path),
        "--credential-ref", "sha256:deadbeef",
        "--operator", "ci-test",
        "--manifest-root", str(tmp_path / "audit"),
        "--db", str(tmp_path / "ingest.db"),
        "--ods-root", str(tmp_path / "ods"),
    ]
    assert cli_main(base_args + ["--csv-file", str(_write_csv(tmp_path))]) == 0
    renamed = _write_csv(tmp_path, CSV_TEXT.replace("贵州茅台", "茅台改名"), name="renamed.csv")
    assert cli_main(base_args + ["--csv-file", str(renamed)]) == 4


def test_list_status_enum_imported(tmp_path: Path) -> None:
    csv_path = _write_csv(tmp_path, HEADER + "\nSSE:600519,贵州茅台,main,delisted,2001-08-27,\n")
    batch = read_base_info(csv_path)
    assert batch.rows[0].list_status is ListStatus.DELISTED


# ---------- manifest 哈希链 / head（H4 m01376） ----------


def _audit_event(
    event_id: str, *, synthetic: bool = False, root: Path | None = None
) -> mf.ManifestEvent:
    checksum = "d" * 64
    snapshot_path = "snapshots/instruments-" + checksum + ".json"
    snapshot_sha256 = "d" * 64
    if root is not None:
        # 快照文件字节哈希必须可复算（verify_manifest_chain 会检查）。
        written, snapshot_sha256 = mf.write_snapshot(
            root, checksum, [{"instrument_id": "SSE:600519", "name": "贵州茅台"}]
        )
        snapshot_path = f"snapshots/{written.name}"
    return mf.ManifestEvent(
        event_id=event_id,
        event_type=mf.EVENT_TYPE_INSTRUMENT_IMPORT,
        channel=mf.CHANNEL_MANUAL_IMPORT,
        status=mf.STATUS_SUCCEEDED,
        started_at=market_now(),
        finished_at=market_now(),
        operator="ci-test",
        rows=1,
        checksum_sha256=checksum,
        snapshot_path=snapshot_path,
        snapshot_sha256=snapshot_sha256,
        source_url="https://example.test/list",
        terms_version="v1",
        terms_snapshot_path="terms/abc.txt",
        terms_snapshot_sha256="abc",
        credential_ref="sha256:deadbeef",
        field_sources={field: mf.CHANNEL_MANUAL_IMPORT for field in mf.FIELD_SOURCES_ALLOWED},
        synthetic=synthetic,
    )


def test_manifest_chain_and_head_are_verifiable(tmp_path: Path) -> None:
    root = tmp_path / "audit"
    mf.append_event(root, _audit_event("e1", root=root))
    mf.append_event(root, _audit_event("e2", root=root))
    summary = mf.verify_manifest_chain(root)
    assert summary["events_real"] == 2
    assert summary["events_synthetic"] == 0
    head = mf.read_head(root)
    assert head is not None and head["count"] == 2
    events = mf.read_events(root)
    assert events[0]["prev_hash"] == mf.ZERO_HASH
    assert events[1]["prev_hash"] == events[0]["hash"]
    assert head["last_hash"] == events[1]["hash"]
    assert head["schema_version"] == 1


def test_manifest_chain_detects_tampering(tmp_path: Path) -> None:
    root = tmp_path / "audit"
    mf.append_event(root, _audit_event("e1", root=root))
    mf.append_event(root, _audit_event("e2", root=root))
    target = mf.manifest_path(root)
    events = mf.read_events(root)
    events[0]["operator"] = "mallory"
    target.write_text(
        "".join(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n" for event in events),
        encoding="utf-8",
    )
    with pytest.raises(mf.ManifestError):
        mf.verify_manifest_chain(root)


def test_synthetic_events_are_ignored_by_head_and_count(tmp_path: Path) -> None:
    root = tmp_path / "audit"
    synthetic_event = _audit_event("s1", synthetic=True)
    assert synthetic_event.display_safe is False  # manual_import + succeeded，但 synthetic → 永不展示
    mf.append_event(root, synthetic_event)
    assert mf.read_head(root) is None
    mf.append_event(root, _audit_event("r1", root=root))
    head = mf.read_head(root)
    assert head is not None and head["count"] == 1
    real = [event for event in mf.read_events(root) if not event.get("synthetic")]
    assert [event["event_id"] for event in real] == ["r1"]
    summary = mf.verify_manifest_chain(root)
    assert summary["events_synthetic"] == 1 and summary["events_real"] == 1
    head_file = mf.head_path(root)
    head_file.write_text(json.dumps({"count": 1, "last_hash": head["last_hash"]}), encoding="utf-8")
    with pytest.raises(mf.ManifestError):
        mf.verify_manifest_chain(root)  # M2：schema_version 缺失=报错


def test_verify_manifest_cli_reports_ok(tmp_path: Path) -> None:
    from market_ingest.cli import main

    root = tmp_path / "audit"
    mf.append_event(root, _audit_event("e1", root=root))
    assert main(["verify-manifest", "--manifest-root", str(root)]) == 0
    target = mf.manifest_path(root)
    target.write_text(target.read_text(encoding="utf-8").replace('"rows": 1', '"rows": 2'), encoding="utf-8")
    assert main(["verify-manifest", "--manifest-root", str(root)]) == 1


def test_verify_manifest_accepts_a2_read_side_fixture() -> None:
    """双向校验的「A1 读 A2」：A2 的读取侧 fixture 必须能被我们的 verifier 复算通过。

    fixture 在 A2 写域（warehouse/tests/fixtures/display_manifest，只读引用）；缺失则 skip，
    避免把跨域目录变成硬依赖。
    """
    root = Path(__file__).resolve().parents[3] / "warehouse" / "tests" / "fixtures" / "display_manifest"
    if not root.is_dir():
        pytest.skip("A2 read-side fixture not present in this checkout")
    summary = mf.verify_manifest_chain(root)
    assert summary["events_real"] == 2
    assert summary["events_synthetic"] == 1
    real = [event for event in mf.read_events(root) if not event.get("synthetic")]
    assert [event["event_id"] for event in real] == ["fixture-a2-0001", "fixture-a2-0002"]
    assert real[0]["prev_hash"] == mf.ZERO_HASH
    assert real[1]["prev_hash"] == real[0]["hash"]
    assert real[1]["hash"] == "65b8bcb513dd13b14b4eb92433dfae78513ba793cc01b7dcb70f75e4d6365dfe"
    assert summary["head"]["count"] == 2
    assert summary["head"]["last_hash"] == real[1]["hash"]


def test_manifest_timestamps_serialize_as_utc_z(tmp_path: Path) -> None:
    event = _audit_event("e1")
    payload = event.to_dict()
    assert payload["started_at"].endswith("Z") and "+08:00" not in payload["started_at"]
    assert "synthetic" not in payload
