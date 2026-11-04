"""版本名唯一性门禁测试（H4 m03397 / H5 m03395）。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CHECKER = REPO_ROOT / "tests" / "data" / "acceptance" / "check_version_name_unique.py"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


def _run(repo: Path, archive: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(CHECKER), "--repo", str(repo),
                           "--archive", str(archive)], capture_output=True, text=True)


def test_same_label_different_bytes_fails(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "a11@example.test")
    _git(repo, "config", "user.name", "A11")
    old = repo / "evidence" / "11-12-evidence-20261104-v7-abc1234.tar.gz"
    old.parent.mkdir()
    old.write_bytes(b"OLD")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "old v7")
    new = tmp_path / "11-12-evidence-20261104-v7-def5678.tar.gz"
    new.write_bytes(b"NEW")
    result = _run(repo, new)
    assert result.returncode == 1, result.stdout
    assert "同名版本失效" in result.stdout


def test_new_label_is_unique(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "a11@example.test")
    _git(repo, "config", "user.name", "A11")
    (repo / "README").write_text("x\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    archive = tmp_path / "11-12-evidence-20261104-v8-abc1234.tar.gz"
    archive.write_bytes(b"NEW")
    result = _run(repo, archive)
    assert result.returncode == 0, result.stdout
    assert "唯一" in result.stdout
