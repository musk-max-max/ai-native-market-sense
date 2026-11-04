"""L30/L34 + H4 证据裁定：dim_instrument.display_safe 必须证据式、fail-closed。

覆盖：
- manifest 证据链（event_id 唯一、finished_at 非降序、prev_hash/hash 链、manifest.head）
- display_safe = origin=='display' AND succeeded 事件 AND channel 合法 AND 快照一致
- tushare 批误写入 display root / blocked 批 / synthetic 样例 都不产生 true
- 生产 profile 缺证据直接失败；dev 降为 false
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from warehouse.dwd.build import build_dwd
from warehouse.golden_runner import _write_envelope
from warehouse.ods.loader import (
    OdsFormatError,
    load_batches,
    load_display_safety,
    load_ods_roots,
    require_display_evidence,
)
from warehouse.tests.helpers import envelopes, instrument_row

GENESIS = "0" * 64


def _canonical(event: dict) -> bytes:
    body = {key: value for key, value in event.items() if key not in ("prev_hash", "hash")}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _event_hash(prev_hash: str, event: dict) -> str:
    # H4 m01228 / lead L52：hash = sha256(prev_hash + "\n" + canonical_json)
    return hashlib.sha256(prev_hash.encode() + b"\n" + _canonical(event)).hexdigest()


def _event(
    *,
    event_id: str,
    channel: str,
    checksum: str,
    rows: int,
    finished_at: str,
    status: str = "succeeded",
    synthetic: bool = False,
) -> dict:
    return {
        "event_id": event_id,
        "event_type": "instrument_import",
        "channel": channel,
        "status": status,
        "started_at": "2026-11-04T08:00:00+08:00",
        "finished_at": finished_at,
        "operator": "ci",
        "rows": rows,
        "checksum_sha256": checksum,
        "display_safe": channel != "tushare",
        "synthetic": synthetic,
    }


def _checksum(rows: list[dict]) -> str:
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _manifest(
    root: Path,
    events: list[dict],
    snapshots: dict[str, list[dict]] | None = None,
    *,
    head: bool = True,
    chain: bool = True,
    head_count: int | None = None,
    refs: bool = True,
) -> Path:
    """写 manifest.jsonl + snapshots/（+ manifest.head）。events 为未加链字段的事件。

    synthetic 事件按 H4 m01084 整条跳过：不进链、不进 head.count（仍原样写在文件里）。
    """
    root.mkdir(parents=True, exist_ok=True)
    snapshots = snapshots or {}
    if snapshots:
        snapshot_dir = root / "snapshots"
        snapshot_dir.mkdir(exist_ok=True)
        for checksum, rows in snapshots.items():
            snapshot_dir.joinpath(f"instruments-{checksum}.json").write_text(
                json.dumps({"checksum_sha256": checksum, "rows": rows}, ensure_ascii=False),
                encoding="utf-8",
            )

    written: list[dict] = []
    previous_hash: str | None = None
    counted = 0
    for event in events:
        record = dict(event)
        # H4 m01172：成功事件带 snapshot_path + 快照文件字节 sha256；有快照的测试默认注入
        checksum = record.get("checksum_sha256")
        if refs and checksum in snapshots:
            relative = f"snapshots/instruments-{checksum}.json"
            record["snapshot_path"] = relative
            record["snapshot_sha256"] = hashlib.sha256(
                root.joinpath(relative).read_bytes()
            ).hexdigest()
        if record.get("synthetic") is True:
            # synthetic 不能声明 display_safe:true（样例不得充当展示证据）
            if record.get("display_safe") is True:
                record["display_safe"] = False
            written.append(record)  # 不参与链/count
            continue
        counted += 1
        if chain:
            previous = previous_hash or GENESIS
            record["prev_hash"] = previous
            record["hash"] = _event_hash(previous, record)
            previous_hash = record["hash"]
        written.append(record)
    root.joinpath("manifest.jsonl").write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in written) + "\n",
        encoding="utf-8",
    )
    if head:
        root.joinpath("manifest.head").write_text(
            json.dumps({"schema_version": 1,
                        "count": counted if head_count is None else head_count,
                        "last_hash": previous_hash or GENESIS,
                        "updated_at": "2026-11-04T08:10:00Z"}),
            encoding="utf-8",
        )
    return root


def _snapshot_rows(instrument_id: str = "SSE:600519") -> list[dict]:
    return [{"instrument_id": instrument_id, "name": "贵州茅台"}]


def _display_batch(directory: Path, instrument_id: str = "SSE:600519",
                   *, batch_id: str = "display-instrument") -> None:
    for envelope in envelopes(instrument=instrument_row(instrument_id)):
        envelope["batch_id"] = batch_id
        _write_envelope(directory, envelope)


def _internal_batch(directory: Path, instrument_id: str = "SZSE:000001",
                    *, batch_id: str = "internal-instrument") -> None:
    for envelope in envelopes(instrument=instrument_row(instrument_id)):
        envelope["batch_id"] = batch_id
        _write_envelope(directory, envelope)


def _flat_batch(directory: Path, instrument_id: str = "SSE:600519",
                *, batch_id: str = "flat-instrument") -> None:
    for envelope in envelopes(instrument=instrument_row(instrument_id)):
        envelope["batch_id"] = batch_id
        _write_envelope(directory, envelope)


def _evidence_manifest(root: Path, *, channel: str = "manual_import", checksum: str | None = None) -> Path:
    rows = _snapshot_rows()
    checksum = checksum or _checksum(rows)
    return _manifest(
        root,
        [_event(event_id="mft-1", channel=channel, checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
    )


# ---------------------------------------------------------------------------
# manifest 证据派生
# ---------------------------------------------------------------------------


def test_manifest_evidence_derives_true(tmp_path: Path) -> None:
    manifest = _evidence_manifest(tmp_path / "audit")
    assert load_display_safety(manifest, strict=True) == {"SSE:600519": True}


def test_tushare_event_is_not_display_evidence(tmp_path: Path) -> None:
    manifest = _evidence_manifest(tmp_path / "audit", channel="tushare")
    assert load_display_safety(manifest, strict=True) == {"SSE:600519": False}


def test_blocked_event_never_derives_true(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00", status="blocked")],
        {checksum: rows},
    )
    assert load_display_safety(manifest, strict=True) == {}


def test_synthetic_event_is_ignored(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-demo", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00", synthetic=True)],
        {checksum: rows},
    )
    # synthetic 不进 count、不进链、不参与派生；空 manifest 在 strict 下也合法
    assert json.loads(manifest.joinpath("manifest.head").read_text())["count"] == 0
    assert load_display_safety(manifest, strict=True) == {}


def test_missing_manifest_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(OdsFormatError, match="manifest 不存在"):
        load_display_safety(tmp_path / "missing", strict=True)


def test_missing_snapshot_fails_closed(tmp_path: Path) -> None:
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum="a" * 64, rows=3,
                finished_at="2026-11-04T08:10:00+08:00")],
    )
    with pytest.raises(OdsFormatError, match="缺少 snapshot_path/snapshot_sha256"):
        load_display_safety(manifest, strict=True)


def test_snapshot_checksum_mismatch_fails(tmp_path: Path) -> None:
    checksum = "b" * 64
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: [{"instrument_id": "SSE:600519"}]},
    )
    snapshot = manifest / "snapshots" / f"instruments-{checksum}.json"
    snapshot.write_text(json.dumps({"checksum_sha256": "c" * 64, "rows": [{"instrument_id": "SSE:600519"}]}),
                        encoding="utf-8")
    with pytest.raises(OdsFormatError, match="快照文件字节哈希"):
        load_display_safety(manifest, strict=True)


def test_snapshot_row_count_mismatch_fails(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=9,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
    )
    with pytest.raises(OdsFormatError, match="快照行数"):
        load_display_safety(manifest, strict=True)


def test_event_id_duplicate_fails(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [
            _event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                   finished_at="2026-11-04T08:10:00+08:00"),
            _event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                   finished_at="2026-11-04T08:11:00+08:00"),
        ],
        {checksum: rows},
    )
    with pytest.raises(OdsFormatError, match="event_id 重复"):
        load_display_safety(manifest, strict=True)


def test_finished_at_out_of_order_fails(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [
            _event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                   finished_at="2026-11-04T09:00:00+08:00"),
            _event(event_id="mft-2", channel="manual_import", checksum=checksum, rows=1,
                   finished_at="2026-11-04T08:00:00+08:00"),
        ],
        {checksum: rows},
    )
    with pytest.raises(OdsFormatError, match="倒序"):
        load_display_safety(manifest, strict=True)


def test_hash_chain_tamper_fails(tmp_path: Path) -> None:
    manifest = _evidence_manifest(tmp_path / "audit")
    line = json.loads(manifest.joinpath("manifest.jsonl").read_text(encoding="utf-8").strip())
    line["operator"] = "tampered"
    manifest.joinpath("manifest.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
    with pytest.raises(OdsFormatError, match="hash 复算不一致"):
        load_display_safety(manifest, strict=True)


def test_head_count_mismatch_fails(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
        head_count=2,
    )
    with pytest.raises(OdsFormatError, match="head.count"):
        load_display_safety(manifest, strict=True)


def test_head_missing_fails_in_prod_but_dev_allows(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
        head=False,
    )
    with pytest.raises(OdsFormatError, match="manifest.head"):
        load_display_safety(manifest, strict=True)
    assert load_display_safety(manifest, strict=False) == {"SSE:600519": True}


def test_legacy_manifest_without_chain_only_in_dev(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
        head=False,
        chain=False,
    )
    assert load_display_safety(manifest, strict=False) == {"SSE:600519": True}
    with pytest.raises(OdsFormatError, match="hash 链"):
        load_display_safety(manifest, strict=True)


def test_latest_succeeded_event_wins(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [
            _event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                   finished_at="2026-11-04T08:10:00+08:00"),
            _event(event_id="mft-2", channel="tushare", checksum=checksum, rows=1,
                   finished_at="2026-11-04T08:20:00+08:00"),
        ],
        {checksum: rows},
    )
    assert load_display_safety(manifest, strict=True) == {"SSE:600519": False}


def test_synthetic_claiming_display_safe_true_is_rejected(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-demo", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00", synthetic=True)],
        {checksum: rows},
    )
    # helper 会自动把 synthetic 的 display_safe 压成 false；手工改回 true 模拟写错
    line = json.loads(manifest.joinpath("manifest.jsonl").read_text(encoding="utf-8").strip())
    line["display_safe"] = True
    manifest.joinpath("manifest.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
    with pytest.raises(OdsFormatError, match="不得声明 display_safe"):
        load_display_safety(manifest, strict=False)


def test_head_schema_version_missing_or_wrong_fails(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
    )
    manifest.joinpath("manifest.head").write_text(
        json.dumps({"count": 1, "last_hash": GENESIS}), encoding="utf-8"
    )
    with pytest.raises(OdsFormatError, match="schema_version 必须为 1"):
        load_display_safety(manifest, strict=True)


def test_head_unknown_keys_are_ignored(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
    )
    head = json.loads(manifest.joinpath("manifest.head").read_text(encoding="utf-8"))
    head["future_field"] = {"anything": [1, 2, 3]}
    manifest.joinpath("manifest.head").write_text(json.dumps(head), encoding="utf-8")
    assert load_display_safety(manifest, strict=True) == {"SSE:600519": True}


def test_all_synthetic_dir_may_omit_head(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-demo", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00", synthetic=True)],
        {checksum: rows},
        head=False,
    )
    assert load_display_safety(manifest, strict=True) == {}


def test_missing_snapshot_ref_is_evidence_gap_only_in_dev(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
        refs=False,
    )
    assert load_display_safety(manifest, strict=False) == {"SSE:600519": False}
    with pytest.raises(OdsFormatError, match="snapshot_path/snapshot_sha256"):
        load_display_safety(manifest, strict=True)


def test_snapshot_path_escaping_root_is_rejected(tmp_path: Path) -> None:
    rows = _snapshot_rows()
    checksum = _checksum(rows)
    manifest = _manifest(
        tmp_path / "audit",
        [_event(event_id="mft-1", channel="manual_import", checksum=checksum, rows=1,
                finished_at="2026-11-04T08:10:00+08:00")],
        {checksum: rows},
    )
    # 把事件里的 snapshot_path 改成 ../outside.json；sha 保留，越界检查应先生效
    line = json.loads(manifest.joinpath("manifest.jsonl").read_text(encoding="utf-8").strip())
    line["snapshot_path"] = "../outside.json"
    manifest.joinpath("manifest.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
    # 改字段会破坏 hash，重建 head 前先单独验证越界路径（不依赖 strict 链）
    line["prev_hash"] = GENESIS
    line["hash"] = _event_hash(GENESIS, line)
    manifest.joinpath("manifest.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
    manifest.joinpath("manifest.head").write_text(
        json.dumps({"schema_version": 1, "count": 1, "last_hash": line["hash"],
                    "updated_at": "2026-11-04T08:10:00Z"}), encoding="utf-8"
    )
    with pytest.raises(OdsFormatError, match="越出 manifest root"):
        load_display_safety(manifest, strict=True)


# ---------------------------------------------------------------------------
# build_dwd / L34 root 语义
# ---------------------------------------------------------------------------


def test_build_requires_origin_display_and_evidence(tmp_path: Path) -> None:
    manifest = _evidence_manifest(tmp_path / "audit")
    safety = load_display_safety(manifest, strict=True)

    repo = tmp_path / "repo"
    _display_batch(repo / "display")
    state = build_dwd(load_ods_roots(repo), display_safety=safety)
    assert state.instruments["SSE:600519"]["display_safe"] is True

    # 同一标的只有 internal 批次：即使 manifest 有证据也不是展示态
    _internal_batch(repo / "internal", "SSE:600519")
    state = build_dwd(load_ods_roots(repo), display_safety=safety)
    assert state.instruments["SSE:600519"]["display_safe"] is True  # display 仍权威

    # 平铺 root：没有 root 证据 → false，不回退 manifest
    flat = tmp_path / "flat"
    _flat_batch(flat)
    state = build_dwd(load_batches(flat), display_safety=safety)
    assert state.instruments["SSE:600519"]["display_safe"] is False


def test_tushare_batch_written_into_display_root_is_false(tmp_path: Path) -> None:
    manifest = _evidence_manifest(tmp_path / "audit", channel="tushare")
    safety = load_display_safety(manifest, strict=True)
    repo = tmp_path / "repo"
    _display_batch(repo / "display")
    batches = load_ods_roots(repo)
    state = build_dwd(batches, display_safety=safety)
    assert state.instruments["SSE:600519"]["display_safe"] is False
    with pytest.raises(OdsFormatError, match="缺少可展示证据"):
        require_display_evidence(batches, safety)


def test_display_authority_over_newer_internal_row(tmp_path: Path) -> None:
    manifest = _evidence_manifest(tmp_path / "audit")
    safety = load_display_safety(manifest, strict=True)
    repo = tmp_path / "repo"
    _display_batch(repo / "display")
    # internal 批次更新（as_of 更晚）也不得覆盖 display 行
    for envelope in envelopes(
        instrument=instrument_row("SSE:600519", name="贵州茅台-内部"),
        source_ref={"source": "tushare", "as_of": "2026-11-04T09:00:00+08:00",
                    "fetched_at": "2026-11-04T09:01:00+08:00"},
    ):
        envelope["batch_id"] = "internal-instrument"
        _write_envelope(repo / "internal", envelope)
    state = build_dwd(load_ods_roots(repo), display_safety=safety)
    row = state.instruments["SSE:600519"]
    assert row["display_safe"] is True
    assert row["name"] == "贵州茅台"


# ---------------------------------------------------------------------------
# pipeline 生产门禁 / dev 降级
# ---------------------------------------------------------------------------


def test_pipeline_prod_fails_without_manifest(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from warehouse import pipeline

    repo = tmp_path / "repo"
    _display_batch(repo / "display")
    code = pipeline.main(["--ods-root", str(repo), "--json"])
    assert code == 1
    assert "manifest" in capsys.readouterr().err


def test_pipeline_prod_rejects_tushare_in_display_root(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from warehouse import pipeline

    manifest = _evidence_manifest(tmp_path / "audit", channel="tushare")
    repo = tmp_path / "repo"
    _display_batch(repo / "display")
    code = pipeline.main(["--ods-root", str(repo), "--manifest-root", str(manifest), "--json"])
    assert code == 1
    assert "可展示证据" in capsys.readouterr().err


def test_pipeline_dev_allows_missing_evidence_as_false(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from warehouse import pipeline

    repo = tmp_path / "repo"
    _display_batch(repo / "display")
    code = pipeline.main(["--ods-root", str(repo), "--profile", "dev", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["display_safe_false"] == 1


def test_pipeline_prod_with_evidence_is_green(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from warehouse import pipeline

    manifest = _evidence_manifest(tmp_path / "audit")
    repo = tmp_path / "repo"
    _display_batch(repo / "display")
    code = pipeline.main(["--ods-root", str(repo), "--manifest-root", str(manifest), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["display_safe_false"] == 0


def test_pipeline_auto_detects_standard_layout(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from warehouse import pipeline

    manifest = _evidence_manifest(tmp_path / "audit")
    root = tmp_path / "root"
    _display_batch(root / "display")
    _internal_batch(root / "internal")
    code = pipeline.main(["--ods-root", str(root), "--manifest-root", str(manifest), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["display_safe_false"] == 1


def test_duplicate_batch_across_roots_is_rejected(tmp_path: Path) -> None:
    display = tmp_path / "display"
    internal = tmp_path / "internal"
    _display_batch(display, batch_id="same-batch")
    for envelope in envelopes(instrument=instrument_row("SSE:600519")):
        envelope["batch_id"] = "same-batch"
        _write_envelope(internal, envelope)
    with pytest.raises(OdsFormatError, match="batch_id 重复"):
        load_ods_roots(display, internal)


FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "display_manifest"


def test_read_side_fixture_is_valid_and_documents_expected_hashes() -> None:
    """A2 侧跨 agent 校验产物：A1 用 verify-manifest 反向读它，必须 strict 通过。

    链里故意夹一条 synthetic（不参与 count/链），第二真实事件 prev_hash 跨过它接第一条真实 hash；
    head 故意多带未知键（note），读取方必须忽略（H4 m01228）。
    """
    safety = load_display_safety(FIXTURE_ROOT, strict=True)
    assert safety == {"SSE:600519": True, "SZSE:000001": True, "BSE:830799": True}
