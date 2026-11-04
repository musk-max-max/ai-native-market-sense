#!/usr/bin/env python3
"""合成录播 fixture 的 L32 合规审计 + path/sha256 清单生成。

背景（L32 / lead 2026-11-04 激活指令）：录播 fixture 必须是合成数据，不得把真实
tushare 报文落进仓库；同时按 L44，清单里的 sha256 只能由脚本重算，不许手抄。

本脚本只读 fixture 目录（默认 ``tests/fixtures/tushare``，A12 写域），校验：

1. ``manifest.json`` 存在、``schema_version == 1``；
2. manifest 的生成器与每条 ``recorded_at`` 都声明 ``synthetic``；
3. manifest 列出的文件存在，且没有 recordings 目录里未登记的孤儿文件；
4. 对每个文件重算 sha256，输出 markdown 表格（可直接贴 agents/BOARD.md 的清单段）。

退出码：0 合规；1 不合规（逐条 stderr）。

用法::

    python3 services/ingest/tools/audit_synthetic_fixtures.py
    python3 services/ingest/tools/audit_synthetic_fixtures.py --format json
    python3 services/ingest/tools/audit_synthetic_fixtures.py \
        --fixtures-root tests/fixtures/tushare --write services/ingest/var/fixture-inventory.md
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

DEFAULT_FIXTURES_ROOT = "tests/fixtures/tushare"
MANIFEST_NAME = "manifest.json"
RECORDINGS_DIR = "recordings"
SYNTHETIC_MARKER = "synthetic"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _display_path(path: Path) -> str:
    """清单里优先写仓库相对路径；tmp 树（单测）写绝对路径。"""
    try:
        return path.resolve().relative_to(_repo_root()).as_posix()
    except ValueError:
        return path.as_posix()


def audit(fixtures_root: Path) -> tuple[list[dict[str, str]], list[str]]:
    """返回 (清单行, 违规说明)。"""
    problems: list[str] = []
    rows: list[dict[str, str]] = []
    manifest_path = fixtures_root / MANIFEST_NAME
    if not manifest_path.is_file():
        return [], [f"missing manifest: {manifest_path}"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return [], [f"manifest is not valid JSON: {exc}"]

    if manifest.get("schema_version") != 1:
        problems.append(f"manifest.schema_version must be 1 (got {manifest.get('schema_version')!r})")
    generator = str(manifest.get("generated_by", ""))
    if SYNTHETIC_MARKER not in generator.lower():
        problems.append(f"manifest.generated_by must name the synthetic generator (got {generator!r})")
    recorded_at = str(manifest.get("updated_at", ""))
    if not recorded_at.lower().startswith(SYNTHETIC_MARKER):
        problems.append(f"manifest.updated_at must be synthetic:* (got {recorded_at!r})")

    entries = manifest.get("recordings")
    if not isinstance(entries, list) or not entries:
        return [], ["manifest.recordings must be a non-empty list"]

    listed: set[Path] = set()
    for entry in entries:
        relative = str(entry.get("file", ""))
        if not relative:
            problems.append("manifest entry without file")
            continue
        path = fixtures_root / relative
        listed.add(path.resolve())
        if not path.is_file():
            problems.append(f"listed fixture missing on disk: {relative}")
            continue
        stamp = str(entry.get("recorded_at", ""))
        if not stamp.lower().startswith(SYNTHETIC_MARKER):
            problems.append(f"{relative}: recorded_at must be synthetic:* (got {stamp!r})")
        rows.append(
            {
                "path": _display_path(path),
                "api_name": str(entry.get("api_name", "")),
                "sha256": _sha256(path),
            }
        )

    recordings_dir = fixtures_root / RECORDINGS_DIR
    if recordings_dir.is_dir():
        for on_disk in sorted(recordings_dir.rglob("*.json")):
            if on_disk.resolve() not in listed:
                problems.append(f"unlisted recording (orphan, must be registered): {on_disk}")
    else:
        problems.append(f"missing recordings dir: {recordings_dir}")

    rows.sort(key=lambda row: row["path"])
    return rows, problems


def _markdown(rows: list[dict[str, str]]) -> str:
    lines = [
        "| fixture | api_name | sha256 |",
        "|---|---|---|",
    ]
    for row in rows:
        lines.append(f"| `{row['path']}` | {row['api_name']} | `{row['sha256']}` |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures-root", default=DEFAULT_FIXTURES_ROOT)
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--write", type=Path, default=None, help="把清单写入文件（L44：只许脚本写）")
    args = parser.parse_args(argv)

    root = Path(args.fixtures_root)
    if not root.is_absolute():
        root = _repo_root() / root
    rows, problems = audit(root)
    if problems:
        for problem in problems:
            print(f"FAIL: {problem}", file=sys.stderr)
        return 1
    if args.format == "json":
        payload = json.dumps({"count": len(rows), "fixtures": rows}, ensure_ascii=False, indent=2)
    else:
        payload = _markdown(rows)
    if args.write is not None:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(payload, encoding="utf-8")
        print(f"wrote {args.write} ({len(rows)} fixtures)")
    else:
        print(payload, end="")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
