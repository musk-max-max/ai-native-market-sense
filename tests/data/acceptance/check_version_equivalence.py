#!/usr/bin/env python3
"""v7 与 v6-124entries 的证据等价门禁（H4 m03402 / H5 四元组要求）。

- 比较两包内嵌 manifest 的 entries（默认排除 manifest 与 SHA256SUMS*）；
- 证据范围默认 `a19-artifacts/ transcripts/ services/ infra/ docs/reference/ tests/data/acceptance/` + 根 tar；
- 断言：证据 path 集合相等；逐 path bytes 与 sha256 相等。
- 输出每一处差异并给出分类；仅当存在“不应有的差异”时失败。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile
from pathlib import Path

DEFAULT_SCOPE = (
    "a19-artifacts/", "transcripts/", "services/", "infra/",
    "docs/reference/", "tests/data/acceptance/", "tests/data/quality_policy.yaml",
    "tests/data/acceptance/artifacts/",
)
ROOT_TAR_SUFFIX = ".tar.gz"


def load(tar_path: Path) -> dict[str, tuple[str, bytes]]:
    with tarfile.open(tar_path) as tar:
        names = [n for n in tar.getnames() if n.endswith(".json") and "evidence-manifest" in n and "/" not in n]
        if not names:
            raise SystemExit(f"FAIL 配置：{tar_path} 内无包内 manifest")
        manifest = json.loads(tar.extractfile(names[0]).read())
        out: dict[str, tuple[str, bytes]] = {}
        for member in tar.getmembers():
            if not member.isfile():
                continue
            out[member.name] = (hashlib.sha256(tar.extractfile(member).read()).hexdigest(),
                                b"")
        return out


def in_scope(path: str) -> bool:
    return path.endswith(ROOT_TAR_SUFFIX) or any(path.startswith(prefix) for prefix in DEFAULT_SCOPE)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--previous", required=True, type=Path)
    parser.add_argument("--current", required=True, type=Path)
    args = parser.parse_args(argv)
    prev, cur = load(args.previous), load(args.current)
    prev_files = {p: s for p, (s, _) in prev.items() if in_scope(p)}
    cur_files = {p: s for p, (s, _) in cur.items() if in_scope(p)}
    missing = sorted(set(prev_files) - set(cur_files))
    extra = sorted(set(cur_files) - set(prev_files))
    changed = sorted(p for p in set(prev_files) & set(cur_files) if prev_files[p] != cur_files[p])
    if missing or extra or changed:
        print("FAIL 证据与 v6-124entries 不等价：")
        if missing:
            print(f"  缺少路径：{missing}")
        if extra:
            print(f"  新增路径：{extra}")
        for p in changed:
            print(f"  sha 变化：{p} {prev_files[p][:12]} -> {cur_files[p][:12]}")
        return 1
    print(f"PASS 证据与 v6-124entries 等价：{len(cur_files)} 个证据 path 的 bytes+sha256 全等（排除 manifest/SHA256SUMS）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
