"""合成录播 fixture 审计脚本（L32）的回归测试。

脚本只读 `tests/fixtures/tushare/`（A12 写域）；测试在 tmp 目录造等价结构，
不写仓库 fixture。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

_TOOL = Path(__file__).resolve().parents[1] / "tools" / "audit_synthetic_fixtures.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location("audit_synthetic_fixtures", _TOOL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_manifest(root: Path, *, generator: str = "synthetic/build_recordings.py",
                    recorded_at: str = "synthetic:2026-11-03",
                    files: list[Path] | None = None) -> None:
    files = files or []
    payload = {
        "schema_version": 1,
        "generated_by": generator,
        "updated_at": recorded_at,
        "recordings": [
            {
                "file": path.relative_to(root).as_posix(),
                "api_name": "daily",
                "recorded_at": recorded_at,
            }
            for path in files
        ],
    }
    (root / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")


def test_audit_accepts_synthetic_fixtures(tmp_path: Path) -> None:
    tool = _load_tool()
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    fixture = recordings / "a.json"
    fixture.write_text('{"response": {"items": []}}', encoding="utf-8")
    _write_manifest(tmp_path, files=[fixture])
    rows, problems = tool.audit(tmp_path)
    assert problems == []
    assert rows[0]["sha256"] == hashlib.sha256(fixture.read_bytes()).hexdigest()


def test_audit_rejects_real_recording_marker(tmp_path: Path) -> None:
    tool = _load_tool()
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    fixture = recordings / "a.json"
    fixture.write_text("{}", encoding="utf-8")
    _write_manifest(tmp_path, recorded_at="2026-11-03T10:00:00+08:00", files=[fixture])
    _, problems = tool.audit(tmp_path)
    assert any("synthetic" in problem for problem in problems)


def test_audit_rejects_orphan_recording(tmp_path: Path) -> None:
    tool = _load_tool()
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    (recordings / "orphan.json").write_text("{}", encoding="utf-8")
    listed = recordings / "listed.json"
    listed.write_text("{}", encoding="utf-8")
    _write_manifest(tmp_path, files=[listed])  # 登记 1 条，磁盘多一条孤儿
    _, problems = tool.audit(tmp_path)
    assert any("orphan" in problem for problem in problems)


def test_audit_rejects_non_synthetic_generator(tmp_path: Path) -> None:
    tool = _load_tool()
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    fixture = recordings / "a.json"
    fixture.write_text("{}", encoding="utf-8")
    _write_manifest(tmp_path, generator="record-fixtures.sh (real token)", files=[fixture])
    _, problems = tool.audit(tmp_path)
    assert any("generated_by" in problem for problem in problems)


def test_cli_writes_inventory(tmp_path: Path, capsys) -> None:
    tool = _load_tool()
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    fixture = recordings / "a.json"
    fixture.write_text("{}", encoding="utf-8")
    _write_manifest(tmp_path, files=[fixture])
    out = tmp_path / "inventory.md"
    assert tool.main(["--fixtures-root", str(tmp_path), "--write", str(out)]) == 0
    text = out.read_text(encoding="utf-8")
    assert "| fixture | api_name | sha256 |" in text
    assert "recordings/a.json" in text


def test_repo_fixtures_are_synthetic() -> None:
    """仓库现状必须合规（L32）；fixtures 缺失时 skip，避免跨域硬依赖。"""
    tool = _load_tool()
    root = tool._repo_root() / "tests" / "fixtures" / "tushare"
    if not (root / "manifest.json").is_file():
        pytest.skip("tushare synthetic fixtures not present in this checkout")
    rows, problems = tool.audit(root)
    assert problems == []
    assert len(rows) >= 10
