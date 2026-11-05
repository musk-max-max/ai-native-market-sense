"""研究来源边界门禁的测试（H4 m03419 第 ④ 条）。

门禁脚本在 ``services/ingest/tools/check_research_source_boundary.py``（A1 写域）；
H4 要求最终挂到 ``check_display_safe_failclosed.py``——那属 A11/A13 写域，
这里先锁死断言本身的行为，owner 接线后可直接复用。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "tools" / "check_research_source_boundary.py"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_boundary_clean_root_passes(tmp_path: Path) -> None:
    ods = tmp_path / "ods"
    (ods / "internal" / "stk_limit" / "dt=2024-01-02").mkdir(parents=True)
    (ods / "internal" / "_meta").mkdir(parents=True)
    (ods / "internal" / "_meta" / "research_sources.jsonl").write_text(
        json.dumps(
            {
                "run_id": "ing-1",
                "source_channel": "official_tushare",
                "authorization_status": "pending_official_authorization",
                "datasets": ["stk_limit"],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    manifest = tmp_path / "audit"
    manifest.mkdir()
    (manifest / "manifest.jsonl").write_text(
        json.dumps(
            {
                "channel": "third_party_mirror",
                "display_safe": False,
                "status": "succeeded",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    proc = _run("--ods-root", str(ods), "--manifest-root", str(manifest), "--json")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["ok"] is True


def test_boundary_rejects_research_in_display_root(tmp_path: Path) -> None:
    ods = tmp_path / "ods"
    (ods / "display" / "top_list").mkdir(parents=True)
    proc = _run("--ods-root", str(ods), "--json")
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["ok"] is False
    assert any("display root" in item for item in payload["violations"])


def test_boundary_rejects_mirror_display_safe(tmp_path: Path) -> None:
    ods = tmp_path / "ods"
    ods.mkdir()
    manifest = tmp_path / "audit"
    manifest.mkdir()
    (manifest / "manifest.jsonl").write_text(
        json.dumps(
            {
                "channel": "tushare",
                "source_channel": "third_party_mirror",
                "display_safe": True,
                "status": "succeeded",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    proc = _run("--ods-root", str(ods), "--manifest-root", str(manifest), "--json")
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert any("mirror batch cannot be display_safe=true" in item for item in payload["violations"])


def test_boundary_rejects_credentials_in_research_sources(tmp_path: Path) -> None:
    ods = tmp_path / "ods"
    meta = ods / "internal" / "_meta"
    meta.mkdir(parents=True)
    (meta / "research_sources.jsonl").write_text(
        json.dumps({"run_id": "ing-1", "token": "should-not-be-here"}) + "\n",
        encoding="utf-8",
    )
    proc = _run("--ods-root", str(ods), "--json")
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert any("credential-like keys" in item for item in payload["violations"])


def test_boundary_repo_research_smoke_passes() -> None:
    """仓库内研究 ODS 冒烟目录必须过门禁（存在才跑；缺目录交给 test_ods_smoke 逻辑）。"""
    repo = Path(__file__).resolve().parents[3]
    smoke = repo / "services/ingest/var/research-ods-smoke"
    if not smoke.is_dir():
        import pytest

        pytest.skip("research-ods-smoke missing")
    proc = _run("--ods-root", str(smoke), "--json")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout)["ok"] is True


def test_boundary_rejects_manifest_root_under_display(tmp_path: Path) -> None:
    ods = tmp_path / "ods"
    ods.mkdir()
    manifest = tmp_path / "display" / "audit"
    manifest.mkdir(parents=True)
    proc = _run("--ods-root", str(ods), "--manifest-root", str(manifest), "--json")
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert any("must not live under display path" in item for item in payload["violations"])
