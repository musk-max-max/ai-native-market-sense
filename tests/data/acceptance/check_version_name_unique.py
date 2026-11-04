#!/usr/bin/env python3
"""版本名校验（H4 m03397 / H5 m03395）：同名版本在 git 历史里只能对应一份字节。

- 从 `--archive` 文件名提取版本标签（如 `-v7`），扫 `git log --all --name-only` 中同标签的既有路径；
- 对每条历史路径取首个包含它的 commit 的 blob 字节，算 sha256 与当前包比较；
- 同标签 + 不同 sha → fail（同名版本失效，必须换版本号/加 commit 后缀）。
"""
from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from pathlib import Path


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True).stdout


def label_of(name: str) -> str:
    match = re.search(r"-(v\d+)(?:-[0-9a-f]{7,})?\.tar\.gz$", name)
    if not match:
        raise SystemExit(f"FAIL 配置：文件名无版本标签 -vN：{name}")
    return match.group(1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args(argv)
    label = label_of(args.archive.name)
    current = hashlib.sha256(args.archive.read_bytes()).hexdigest()

    historical = git(args.repo, "log", "--all", "--pretty=format:", "--name-only")
    candidates = sorted({
        line.strip() for line in historical.splitlines()
        if line.strip() and re.search(rf"-{label}(?:-[0-9a-f]{{7,}})?\.tar\.gz$", line.strip())
    })
    conflicts = []
    for path in candidates:
        commits = git(args.repo, "log", "--all", "--format=%H", "--", path).split()
        if not commits:
            continue
        blob = subprocess.run(["git", "-C", str(args.repo), "show", f"{commits[-1]}:{path}"],
                              check=True, capture_output=True).stdout
        digest = hashlib.sha256(blob).hexdigest()
        if digest != current:
            conflicts.append((path, commits[-1][:12], digest, len(blob)))

    if conflicts:
        print(f"FAIL 版本名 {label} 已存在且字节不同（同名版本失效）：")
        for path, commit, digest, size in conflicts:
            print(f"  - {path} @ {commit}: sha256 {digest} / {size}B")
        return 1
    same = f"（历史同名 {len(candidates)} 份，sha 一致）" if candidates else "（历史无同名版本）"
    print(f"PASS 版本名 {label} 唯一：当前 sha256 {current[:16]}…{same}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
