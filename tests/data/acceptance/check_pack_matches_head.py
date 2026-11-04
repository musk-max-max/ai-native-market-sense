#!/usr/bin/env python3
"""证据包防竞态门禁（H4 m03197 / H5 m03202）。

规则：证据包必须可追溯到单一 commit。
- 包内凡能映射到 repo 路径的文件，其 `git hash-object` 必须等于 `git rev-parse <commit>:<path>`，
  且该路径相对该 commit 无未提交改动（`git diff --quiet <commit> -- <path>`）。
- 包内-only 文件（由 `--allow-prefix` 显式声明，如 transcripts/、a19-artifacts/）豁免，但必须声明。
- 退出码：0 通过 / 1 不一致（fail，不出包）/ 2 配置错误。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--commit", default="HEAD")
    parser.add_argument("--allow-prefix", action="append", default=[],
                        help="包内-only 路径前缀（可多次），如 a19-artifacts/")
    parser.add_argument("--map", type=Path, default=None,
                        help="package-path -> repo-path 映射 JSON（重定位但可追溯的文件，如 a19-REPORT.md -> tests/.../REPORT.md）")
    args = parser.parse_args(argv)

    root, repo = args.root.resolve(), args.repo.resolve()
    if not (root / ".git").exists() and not (repo / ".git").exists():
        print("FAIL 配置：--repo 不是 git 仓库", file=sys.stderr)
        return 2
    try:
        sha = git(repo, "rev-parse", args.commit).strip()
    except subprocess.CalledProcessError as exc:
        print(f"FAIL 配置：commit 不可解析 {args.commit}: {exc.stderr.strip()}", file=sys.stderr)
        return 2

    path_map = json.loads(args.map.read_text(encoding="utf-8")) if args.map else {}
    checked = allowed = 0
    failures: list[str] = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        if any(rel.startswith(prefix) for prefix in args.allow_prefix):
            allowed += 1
            continue
        repo_rel = path_map.get(rel, rel)
        repo_path = repo / repo_rel
        if not repo_path.exists():
            failures.append(f"{rel}: 包内文件在 repo 不存在，也不是已声明的包内-only（加 --allow-prefix）")
            continue
        try:
            committed = git(repo, "rev-parse", f"{sha}:{repo_rel}").strip()
        except subprocess.CalledProcessError:
            failures.append(f"{rel}: 不在 commit {sha[:12]} 中（repo 路径 {repo_rel}；工作树新文件不得入包）")
            continue
        with path.open("rb") as fh:
            actual = subprocess.run(
                ["git", "-C", str(repo), "hash-object", "--stdin"], input=fh.read(),
                check=True, capture_output=True,
            ).stdout.decode().strip()
        if actual != committed:
            failures.append(f"{rel}: 包内 blob {actual[:12]} != {sha[:12]}:{rel} {committed[:12]}（打包竞态）")
            continue
        diff = subprocess.run(
            ["git", "-C", str(repo), "diff", "--quiet", sha, "--", repo_rel],
            capture_output=True,
        )
        if diff.returncode != 0:
            failures.append(f"{rel}: 相对 {sha[:12]} 有未提交改动（工作树与 commit 不一致）")
            continue
        checked += 1

    if failures:
        print(f"FAIL 证据包与 commit {sha[:12]} 不一致（{len(failures)} 项）：")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"PASS 证据包可追溯到 commit {sha}：{checked} 个 repo-mapped 文件逐一 blob 一致，{allowed} 个包内-only 已声明")
    return 0


if __name__ == "__main__":
    sys.exit(main())
