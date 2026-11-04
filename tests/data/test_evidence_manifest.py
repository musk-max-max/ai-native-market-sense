"""证据包 manifest 机械校验（H5-R18）：CI 门禁入口。

Lead m02534 要求：manifest 内每个文件“存在 + size>0 + sha256 匹配”，做成脚本进 CI；
本测试是 `evidence-manifest-check` 的 pytest 包装，失败即红灯（不 skip）。

证据包 v3 由 `tests/data/acceptance/artifacts/11-12-evidence-20261104-v3.tar.gz`
携带；manifest 在包内，测试先解出到临时目录，再调用独立脚本做机械校验。
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = REPO_ROOT / "tests" / "data" / "acceptance" / "artifacts"
ARCHIVE = ARTIFACTS / "11-12-evidence-20261104-v3.tar.gz"
MANIFEST_MEMBER = "manifest-20261104T0235Z.json"
CHECKER = REPO_ROOT / "tests" / "data" / "acceptance" / "check_evidence_manifest.py"


def _extract_manifest(tmp_path: Path) -> Path:
    if not ARCHIVE.exists():
        pytest.fail(f"证据包不存在：{ARCHIVE}", pytrace=False)
    with tarfile.open(ARCHIVE, "r:*") as tar:
        try:
            member = tar.getmember(MANIFEST_MEMBER)
        except KeyError:
            pytest.fail(f"证据包内缺 manifest：{MANIFEST_MEMBER}", pytrace=False)
        data = tar.extractfile(member)
        if data is None:
            pytest.fail(f"证据包内 manifest 不可读：{MANIFEST_MEMBER}", pytrace=False)
        target = tmp_path / MANIFEST_MEMBER
        target.write_bytes(data.read())
    return target


def test_evidence_manifest_passes_mechanical_check(tmp_path: Path) -> None:
    manifest = _extract_manifest(tmp_path)
    result = subprocess.run(
        [sys.executable, str(CHECKER), "--manifest", str(manifest), "--archive", str(ARCHIVE)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, f"证据包 manifest 校验红灯：\nstdout={result.stdout}\nstderr={result.stderr}"
    assert "PASS 证据包 manifest 校验通过" in result.stdout


def test_evidence_archive_hash_is_pinned_in_sums_file() -> None:
    sums = ARTIFACTS / "SHA256SUMS-v3"
    assert sums.exists(), f"缺 SHA256SUMS-v3：{sums}"
    expected = None
    for line in sums.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == ARCHIVE.name:
            expected = parts[0]
            break
    assert expected is not None, f"SHA256SUMS-v3 未登记 {ARCHIVE.name}"
    actual = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    assert actual == expected, f"证据包 sha256 不符：SHA256SUMS-v3={expected} 实算={actual}"


def test_manifest_rejects_zero_byte_or_hash_drift(tmp_path: Path) -> None:
    """负向：0 字节 / 哈希漂移必须红灯（证明校验不是空转）。"""
    import json

    manifest = json.loads(_extract_manifest(tmp_path).read_text(encoding="utf-8"))
    assert manifest["entries"], "manifest entries 不能为空"
    manifest["entries"][0]["sha256"] = "0" * 64
    manifest["entries"][0]["bytes"] = 0
    broken = tmp_path / "broken-manifest.json"
    broken.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(CHECKER), "--manifest", str(broken), "--archive", str(ARCHIVE),
         "--manifest-member", MANIFEST_MEMBER],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 1, f"篡改 manifest 仍通过，门禁失效：\n{result.stdout}"
    assert "bytes 必须 >0" in result.stdout or "sha256 不符" in result.stdout or "size>0 失败" in result.stdout


# ---- v4（H5-R22 / H4 m02623：logs 入包、指针命中、receipt 自哈希）---------------------------

ARCHIVE_V4 = ARTIFACTS / "11-12-evidence-20261104-v4.tar.gz"
MANIFEST_V4 = "evidence-manifest-v4-20261104T0600Z.json"


def _extract_member(archive: Path, member: str, tmp_path: Path) -> Path:
    if not archive.exists():
        pytest.fail(f"证据包不存在：{archive}", pytrace=False)
    with tarfile.open(archive, "r:*") as tar:
        try:
            item = tar.getmember(member)
        except KeyError:
            pytest.fail(f"证据包内缺 {member}", pytrace=False)
        data = tar.extractfile(item)
        if data is None:
            pytest.fail(f"证据包内 {member} 不可读", pytrace=False)
        target = tmp_path / member
        target.write_bytes(data.read())
    return target


def test_v4_manifest_passes_mechanical_check(tmp_path: Path) -> None:
    manifest = _extract_member(ARCHIVE_V4, MANIFEST_V4, tmp_path)
    result = subprocess.run(
        [sys.executable, str(CHECKER), "--manifest", str(manifest), "--archive", str(ARCHIVE_V4),
         "--manifest-member", MANIFEST_V4],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, f"v4 manifest 校验红灯：\nstdout={result.stdout}\nstderr={result.stderr}"
    assert "PASS 证据包 manifest 校验通过" in result.stdout


def test_v4_archive_hash_is_pinned_in_sums_file() -> None:
    sums = ARTIFACTS / "SHA256SUMS-v4"
    assert sums.exists(), f"缺 SHA256SUMS-v4：{sums}"
    expected = None
    for line in sums.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == ARCHIVE_V4.name:
            expected = parts[0]
            break
    assert expected is not None, f"SHA256SUMS-v4 未登记 {ARCHIVE_V4.name}"
    actual = hashlib.sha256(ARCHIVE_V4.read_bytes()).hexdigest()
    assert actual == expected, f"v4 sha256 不符：登记={expected} 实算={actual}"


def test_v4_registers_run_scoped_logs_and_pointers(tmp_path: Path) -> None:
    """v4 必须真的把 A19 logs/ 收进来（不是只有 results.json）。"""
    manifest = json.loads(_extract_member(ARCHIVE_V4, MANIFEST_V4, tmp_path).read_text(encoding="utf-8"))
    paths = {entry["path"] for entry in manifest["entries"]}
    logs = [path for path in paths if path.startswith("a19-artifacts/logs/")]
    assert len(logs) >= 11, f"run-scoped 日志数量异常少：{sorted(logs)}"
    assert any("api-prod-profile.log" in path for path in logs), "缺 G3 post-fix 的 api-prod-profile.log"
    run_scoped = [entry for entry in manifest["entries"] if entry["path"].startswith("a19-artifacts/http-attempts-")]
    assert run_scoped, "缺 run-scoped http-attempts 原始往返日志"
    excluded = {entry["path"] for entry in manifest.get("excluded", [])}
    assert any(path.endswith("/http-attempts.jsonl") for path in excluded), "0 字节旧占位必须在 excluded 中显式登记"
