"""证据包 manifest v2（H5-R19）机械校验自证。

用合成小包证明门禁不是空转：
- 干净包 → PASS；
- results.json 的 evidence.log 指向的日志不在包内 → 红灯（悬空指针）；
- tar 内夹带未登记文件 / manifest 缺 phase → 红灯；
- artifact 字节被改 → 红灯。
"""
from __future__ import annotations

import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BUILDER = REPO_ROOT / "tests" / "data" / "acceptance" / "build_evidence_manifest.py"
CHECKER = REPO_ROOT / "tests" / "data" / "acceptance" / "check_evidence_manifest.py"
MANIFEST_NAME = "evidence-manifest-20261104T9999Z.json"


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _make_package(tmp_path: Path, *, dangling: bool = False, extra: bool = False) -> tuple[Path, Path]:
    root = tmp_path / "pkg"
    _write(root / "a19-artifacts" / "results.json", json.dumps({
        "checks": [{"id": "G3", "evidence": {"log": "tests/adversarial/entitlement-bypass/artifacts/logs/api-prod.log"}}],
    }, ensure_ascii=False))
    _write(root / "index.md", "# index\n")
    _write(root / "receipt.md", "# receipt\n")
    if not dangling:
        _write(root / "a19-artifacts" / "logs" / "api-prod.log", "listened 18081\ndev-token 401\n")
    if extra:
        _write(root / "a19-artifacts" / "stale.jsonl", "{}\n")
    entries = {
        "a19-artifacts/results.json": {
            "authority": "pre_fix_baseline", "phase": "pre_fix", "case_ids": ["G3"],
            "source_path": "tests/adversarial/entitlement-bypass/artifacts/results.json",
        },
        "a19-artifacts/logs/api-prod.log": {
            "authority": "post_fix_run_scoped_raw_log", "phase": "post_fix", "case_ids": ["G3"],
        },
        "index.md": {"authority": "index", "phase": "not_applicable", "case_ids": ["meta"]},
        "receipt.md": {"authority": "receipt", "phase": "not_applicable", "case_ids": ["meta"]},
    }
    if extra:
        entries["a19-artifacts/stale.jsonl"] = {
            "authority": "evidence", "phase": "post_fix", "case_ids": ["G3"],
        }
    meta = {"entries": entries, "excluded": [], "rejected": []}
    meta_path = tmp_path / "meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    manifest = root / MANIFEST_NAME
    result = subprocess.run(
        [sys.executable, str(BUILDER), "--root", str(root), "--archive", "pkg.tar.gz",
         "--meta", str(meta_path), "--out", str(manifest)],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    archive = tmp_path / "pkg.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            tar.add(path, arcname=str(path.relative_to(root)))
    return manifest, archive


def _run_checker(manifest: Path, archive: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), "--manifest", str(manifest), "--archive", str(archive),
         "--manifest-member", MANIFEST_NAME],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )


def test_clean_v2_package_passes(tmp_path: Path) -> None:
    manifest, archive = _make_package(tmp_path)
    result = _run_checker(manifest, archive)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS" in result.stdout


def test_dangling_evidence_pointer_red(tmp_path: Path) -> None:
    manifest, archive = _make_package(tmp_path, dangling=True)
    result = _run_checker(manifest, archive)
    assert result.returncode == 1
    assert "悬空" in result.stdout


def test_extra_file_in_tar_breaks_one_to_one(tmp_path: Path) -> None:
    manifest, archive = _make_package(tmp_path, extra=True)
    # 从 manifest 中删掉 stale.jsonl 登记，制造 tar 多文件
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["entries"] = [e for e in payload["entries"] if e["path"] != "a19-artifacts/stale.jsonl"]
    manifest.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    result = _run_checker(manifest, archive)
    assert result.returncode == 1
    assert "不一一对应" in result.stdout or "未登记" in result.stdout


def test_missing_phase_is_rejected(tmp_path: Path) -> None:
    manifest, archive = _make_package(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["entries"][0].pop("phase")
    manifest.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    result = _run_checker(manifest, archive)
    assert result.returncode == 1
    assert "phase" in result.stdout


def test_byte_drift_is_rejected(tmp_path: Path) -> None:
    manifest, archive = _make_package(tmp_path)
    # 重打包时改一个 artifact 内容 → bytes/sha 都应红灯
    root = tmp_path / "pkg"
    (root / "index.md").write_text("# tampered\n", encoding="utf-8")
    with tarfile.open(archive, "w:gz") as tar:
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            tar.add(path, arcname=str(path.relative_to(root)))
    result = _run_checker(manifest, archive)
    assert result.returncode == 1
    assert "sha256 不符" in result.stdout or "bytes 不符" in result.stdout
