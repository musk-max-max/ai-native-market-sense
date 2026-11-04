"""证据包防竞态门禁测试（H4 m03197 / H5 m03202）。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CHECKER = REPO_ROOT / "tests" / "data" / "acceptance" / "check_pack_matches_head.py"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


def _make_repo(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "a11@example.test")
    _git(repo, "config", "user.name", "A11")
    (repo / "evidence").mkdir()
    (repo / "evidence" / "a.json").write_text('{"a":1}\n', encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    staging = tmp_path / "pkg"
    (staging / "evidence").mkdir(parents=True)
    (staging / "evidence" / "a.json").write_text('{"a":1}\n', encoding="utf-8")
    return repo, staging


def _run(staging: Path, repo: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), "--root", str(staging), "--repo", str(repo), *extra],
        capture_output=True, text=True,
    )


def test_clean_package_matches_head(tmp_path: Path) -> None:
    repo, staging = _make_repo(tmp_path)
    result = _run(staging, repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS 证据包可追溯到 commit" in result.stdout


def test_stale_package_fails(tmp_path: Path) -> None:
    repo, staging = _make_repo(tmp_path)
    (staging / "evidence" / "a.json").write_text('{"a":2}\n', encoding="utf-8")
    result = _run(staging, repo)
    assert result.returncode == 1, result.stdout
    assert "打包竞态" in result.stdout


def test_package_only_prefix_must_be_declared(tmp_path: Path) -> None:
    repo, staging = _make_repo(tmp_path)
    (staging / "transcripts").mkdir()
    (staging / "transcripts" / "run.log").write_text("ok\n", encoding="utf-8")
    undeclared = _run(staging, repo)
    assert undeclared.returncode == 1 and "已声明的包内-only" in undeclared.stdout
    declared = _run(staging, repo, "--allow-prefix", "transcripts/")
    assert declared.returncode == 0, declared.stdout + declared.stderr


def test_relocated_file_is_traceable_via_map(tmp_path: Path) -> None:
    repo, staging = _make_repo(tmp_path)
    (staging / "report.md").write_text('{"a":1}\n', encoding="utf-8")
    (staging / "package-only.log").write_text("gen\n", encoding="utf-8")
    mapping = tmp_path / "map.json"
    mapping.write_text('{"report.md": "evidence/a.json"}\n', encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(CHECKER), "--root", str(staging), "--repo", str(repo),
         "--map", str(mapping), "--allow-prefix", "package-only.log"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "repo-mapped" in result.stdout
