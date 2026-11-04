#!/usr/bin/env python3
"""11-12 放行验收 · 数据侧 display_safe fail-closed 三条（H4 m01217/m01084，A2 m01329 实现口径）。

不进 8+4 主清单，H4 签；挂 release job，不阻塞日常 CI。黑盒调用 A2 的真实命令：

    python3 -m warehouse.pipeline --ods-root <display> --manifest-root <m> --profile prod|dev --json
    python3 -m warehouse.load    --ods-root <display> --manifest-root <m> --dry-run

覆盖三条（全部用临时目录构造 ODS/manifest 证据，不读不写 data/golden）：
1. tushare 批误写进 `ods/display/...`（display root 的展示权限是物理隔离，不信目录位置）：
   prod 必须非 0 退出（fail-closed 拒绝），dev 必须 `display_safe` 全 false、不得派生 true。
2. 删/清空 manifest：prod 必须非 0 退出，**不得静默全空/默认 true**。
3. manifest 里 `synthetic: true` 的样例事件必须整条忽略：不派生 true、不进 count/链；
   只给 synthetic 证据时 prod 必须非 0 退出，dev 不得出现 display_safe=true。
附加（H4 m01084 篡改侧）：快照文件字节被改（snapshot_sha256 不符）→ prod 必须非 0 退出。

判定只看被测程序行为（退出码 + stdout JSON + stderr），不 mock A2 内部函数。
退出码：0 通过 / 1 失败 / 2 环境缺失（无 python）。
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PYTHON = sys.executable
GENESIS = "0" * 64

PROBE = "SSE:600519"
INSTRUMENT_ROW = {
    "instrument_id": PROBE,
    "exchange": "SSE",
    "code": "600519",
    "name": "贵州茅台",
    "board": "main",
    "security_type": "stock",
    "list_status": "listed",
    "lot_size": 100,
    "listed_at": "2001-08-27",
}
SNAPSHOT_ROWS = [dict(INSTRUMENT_ROW)]


def canonical_bytes_body(event: dict) -> bytes:
    # 与 A2 loader `_canonical_event_bytes` 逐字一致：prev_hash 与 hash 都不进 canonical。
    body = {key: value for key, value in event.items() if key not in ("prev_hash", "hash")}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def write_ods(parent: Path, *, source_name: str) -> Path:
    """L34 标准布局：<parent>/display/instrument/... + 空 <parent>/internal/。"""
    (parent / "internal").mkdir(parents=True, exist_ok=True)
    dt = "2026-11-03"
    path = parent / "display" / "instrument" / f"dt={dt}" / "instr-001.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    envelope = {
        "batch_id": "20261103-instrument-001",
        "endpoint": "instrument",
        "schema": "instrument.v1",
        "source": {
            "source": source_name,
            "as_of": "2026-11-03T15:00:00+08:00",
            "fetched_at": "2026-11-03T15:01:00+08:00",
        },
        "rows_total": 1,
        "rows_rejected": 0,
        "rows": [dict(INSTRUMENT_ROW)],
    }
    path.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_manifest(
    root: Path,
    events: list[dict],
    *,
    snapshot_rows: list[dict] | None = None,
    head: bool = True,
    tamper_snapshot: bool = False,
) -> Path:
    """写 manifest.jsonl + snapshots/ + manifest.head（按 A2 m01329/README 格式）。"""
    root.mkdir(parents=True, exist_ok=True)
    snapshot_dir = root / "snapshots"
    snapshot_dir.mkdir(exist_ok=True)
    checksum = hashlib.sha256(
        json.dumps(snapshot_rows or SNAPSHOT_ROWS, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    snapshot_path = snapshot_dir / "instruments.json"
    snapshot_path.write_text(
        json.dumps({"checksum_sha256": checksum, "rows": snapshot_rows or SNAPSHOT_ROWS}, ensure_ascii=False),
        encoding="utf-8",
    )
    snapshot_sha = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
    if tamper_snapshot:
        # 事件记的是「原始字节」哈希，落盘后改内容 → loader 复算不一致。
        snapshot_path.write_text(
            json.dumps({"checksum_sha256": checksum, "rows": SNAPSHOT_ROWS, "tampered": True}, ensure_ascii=False),
            encoding="utf-8",
        )

    written: list[dict] = []
    previous_hash: str | None = None
    counted = 0
    for event in events:
        record = dict(event)
        if record.get("synthetic") is True:
            written.append(record)  # 整条跳过：不进链、不进 count
            continue
        counted += 1
        if record.get("status") == "succeeded" and "snapshot_path" not in record:
            record["snapshot_path"] = "snapshots/instruments.json"
            record["snapshot_sha256"] = snapshot_sha
        record["prev_hash"] = previous_hash or GENESIS
        # H4 m01228（M1）：hash = sha256(prev_hash + "\n" + canonical_json)，与 A2 loader 逐字一致。
        record["hash"] = hashlib.sha256(
            (record["prev_hash"] + "\n").encode("utf-8") + canonical_bytes_body(record)
        ).hexdigest()
        previous_hash = record["hash"]
        written.append(record)

    (root / "manifest.jsonl").write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in written) + "\n",
        encoding="utf-8",
    )
    if head:
        (root / "manifest.head").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "count": counted,
                    "last_hash": previous_hash or GENESIS,
                }
            ),
            encoding="utf-8",
        )
    return root


def event(
    *,
    event_id: str,
    channel: str,
    finished_at: str,
    status: str = "succeeded",
    synthetic: bool = False,
) -> dict:
    checksum = hashlib.sha256(
        json.dumps(SNAPSHOT_ROWS, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    return {
        "event_id": event_id,
        "event_type": "instrument_import",
        "channel": channel,
        "status": status,
        "started_at": "2026-11-04T08:00:00+08:00",
        "finished_at": finished_at,
        "operator": "a11-acceptance",
        "rows": 1,
        "checksum_sha256": checksum,
        "synthetic": synthetic,
    }


def run_pipeline(ods_root: Path, manifest: Path | None, profile: str) -> tuple[int, str, str]:
    command = [
        PYTHON,
        "-m",
        "warehouse.pipeline",
        "--ods-root",
        str(ods_root),
        "--profile",
        profile,
        "--json",
    ]
    if manifest is not None:
        command += ["--manifest-root", str(manifest)]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=180,
        cwd=REPO_ROOT,
        env=dict(os.environ, PYTHONPATH=str(REPO_ROOT)),
    )
    return completed.returncode, completed.stdout, completed.stderr


def run_load(ods_root: Path, manifest: Path | None) -> tuple[int, str, str]:
    command = [
        PYTHON,
        "-m",
        "warehouse.load",
        "--ods-root",
        str(ods_root),
        "--dry-run",
    ]
    if manifest is not None:
        command += ["--manifest-root", str(manifest)]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=180,
        cwd=REPO_ROOT,
        env=dict(os.environ, PYTHONPATH=str(REPO_ROOT)),
    )
    return completed.returncode, completed.stdout, completed.stderr


def parse_payload(stdout: str) -> dict:
    start = stdout.find("{")
    end = stdout.rfind("}")
    if start < 0 or end < 0:
        return {}
    try:
        return json.loads(stdout[start : end + 1])
    except json.JSONDecodeError:
        return {}


def case_tushare_miswrite(tmp: Path) -> list[str]:
    problems: list[str] = []
    display = tmp / "ods-tushare-miswrite"
    write_ods(display, source_name="tushare")
    manifest = write_manifest(
        tmp / "manifest-tushare",
        [event(event_id="evt-tushare-001", channel="tushare", finished_at="2026-11-04T08:10:00+08:00")],
    )

    code, stdout, stderr = run_pipeline(display, manifest, "prod")
    if code == 0:
        problems.append("① tushare 批误写 display root：prod pipeline 退出 0（应 fail-closed 非 0）")
    payload = parse_payload(stdout)
    if code != 0 and payload:
        problems.append("① tushare 误写：prod 失败时仍输出了 JSON（拒绝路径不应产出结果集）")

    code_dev, stdout_dev, _ = run_pipeline(display, manifest, "dev")
    dev_payload = parse_payload(stdout_dev)
    instruments = int(dev_payload.get("instruments") or 0)
    false_count = int(dev_payload.get("display_safe_false") or 0)
    if code_dev != 0:
        problems.append(f"① tushare 误写：dev pipeline 退出 {code_dev}（应可离线回归但全 false）")
    if instruments and false_count != instruments:
        problems.append(
            f"① tushare 误写：dev 下 display_safe_false={false_count} != instruments={instruments}（不得派生 true）"
        )
    if instruments and dev_payload.get("instruments") and "display_safe_true" in dev_payload:
        if int(dev_payload["display_safe_true"]) > 0:
            problems.append("① tushare 误写：出现 display_safe=true")
    return problems


def case_missing_manifest(tmp: Path) -> list[str]:
    problems: list[str] = []
    display = tmp / "ods-missing-manifest"
    write_ods(display, source_name="csv")

    code, _stdout, stderr = run_pipeline(display, None, "prod")
    if code == 0:
        problems.append("② 删 manifest：prod pipeline 退出 0（应非 0，不得静默全空）")
    if not any(token in stderr for token in ("manifest", "display_safe", "PROFILE", "生产")):
        problems.append(f"② 删 manifest：stderr 未写明 fail-closed 原因：{stderr.strip()[-300:]!r}")

    code_load, _out, _err = run_load(display, None)
    if code_load == 0:
        problems.append("② 删 manifest：load --dry-run 退出 0（应被门禁拒绝）")
    return problems


def case_synthetic_only(tmp: Path) -> list[str]:
    problems: list[str] = []
    display = tmp / "ods-synthetic"
    write_ods(display, source_name="csv")
    manifest = write_manifest(
        tmp / "manifest-synthetic",
        [event(event_id="evt-synthetic-001", channel="official_api", finished_at="2026-11-04T08:10:00+08:00", synthetic=True)],
    )

    code, _stdout, stderr = run_pipeline(display, manifest, "prod")
    if code == 0:
        problems.append("③ 只有 synthetic 事件：prod pipeline 退出 0（synthetic 不得当作 positive 证据）")

    code_dev, stdout_dev, _ = run_pipeline(display, manifest, "dev")
    payload = parse_payload(stdout_dev)
    instruments = int(payload.get("instruments") or 0)
    false_count = int(payload.get("display_safe_false") or 0)
    if code_dev != 0:
        problems.append(f"③ synthetic-only：dev pipeline 退出 {code_dev}（应可跑但全 false）")
    if instruments and false_count != instruments:
        problems.append(
            f"③ synthetic-only：dev 下 display_safe_false={false_count} != instruments={instruments}"
            "（synthetic 事件被错误用于派生 true）"
        )
    return problems


def case_tampered_snapshot(tmp: Path) -> list[str]:
    problems: list[str] = []
    display = tmp / "ods-tamper"
    write_ods(display, source_name="csv")
    manifest = write_manifest(
        tmp / "manifest-tamper",
        [event(event_id="evt-csv-001", channel="official_api", finished_at="2026-11-04T08:10:00+08:00")],
        tamper_snapshot=True,
    )
    code, _stdout, stderr = run_pipeline(display, manifest, "prod")
    if code == 0:
        problems.append("④ 快照字节被改：prod pipeline 退出 0（应拒绝入库）")
    if "snapshot" not in stderr and "sha" not in stderr.lower():
        problems.append(f"④ 快照篡改：stderr 未指出 snapshot 哈希不一致：{stderr.strip()[-300:]!r}")
    return problems


def main() -> int:
    if not (REPO_ROOT / "warehouse" / "pipeline.py").exists():
        print("[FAIL] 找不到 warehouse/pipeline.py（repo root 判定错误）")
        return 2
    with tempfile.TemporaryDirectory(prefix="a11-display-safe-") as directory:
        tmp = Path(directory)
        problems: list[str] = []
        problems.extend(case_tushare_miswrite(tmp))
        problems.extend(case_missing_manifest(tmp))
        problems.extend(case_synthetic_only(tmp))
        problems.extend(case_tampered_snapshot(tmp))
    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] display_safe fail-closed 三条（H4 m01217/m01084）")
    for problem in problems:
        print(f"  - {problem}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
