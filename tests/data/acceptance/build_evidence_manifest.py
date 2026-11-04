#!/usr/bin/env python3
"""证据包 manifest 生成器（H5-R19 / H4 m02623）。

纪律（生成器只写 sidecar，不碰被哈希文件）：
1. 只读 staging 目录，只写 `--out` 指定的 manifest；**禁止**把哈希回写进任何被哈希文件；
2. 每个条目必须带 `authority` / `phase` / `case_ids`（H5-R19），缺登记元数据即拒绝生成；
3. manifest 自身不登记自己（自引用不可能），其 sha256 由外部 `SHA256SUMS-*` 单独记录；
4. `rejected` / `excluded` 由 `--meta` 传入，生成器只校验其不出现在 staging。

用法：
  python3 tests/data/acceptance/build_evidence_manifest.py \
      --root /tmp/a11_v4 \
      --archive 11-12-evidence-20261104-v4.tar.gz \
      --meta tests/data/acceptance/artifacts/v4-meta.json \
      --out /tmp/a11_v4/evidence-manifest-20261104T....json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

PHASES = {"pre_fix", "post_fix", "not_applicable"}
AUTHORITY_BASE = {"authoritative", "historical"}
# H5 m03672：v8 起 authority 两值 + authority_detail 承载细分；旧细分值在此归一。
AUTHORITY_MIGRATION = {
    "pre_fix_baseline": ("historical", "pre_fix_baseline"),
    "pre_fix_control": ("historical", "pre_fix_control"),
    "historical": ("historical", "historical"),
    "authoritative": ("authoritative", "authoritative"),
    "post_fix_authoritative": ("authoritative", "post_fix_authoritative"),
    "post_fix_control": ("authoritative", "post_fix_control"),
    "post_fix_run_scoped_raw_log": ("authoritative", "post_fix_run_scoped_raw_log"),
    "evidence": ("authoritative", "evidence"),
    "index": ("authoritative", "index"),
    "receipt": ("authoritative", "receipt"),
    "meta": ("authoritative", "meta"),
}
AUTHORITIES = {
    "pre_fix_baseline",
    "pre_fix_control",
    "post_fix_authoritative",
    # H5 m03115：引用版 manifest 用字面 authoritative；H4 m03103：被取代的旧快照用 historical
    "authoritative",
    "historical",
    "post_fix_control",
    "post_fix_run_scoped_raw_log",
    "evidence",
    "index",
    "receipt",
    "meta",
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成证据包 manifest（H5-R19）")
    parser.add_argument("--root", required=True, type=Path, help="staging 目录（包内路径 = 相对 root）")
    parser.add_argument("--archive", required=True, help="包文件名（tar 内不含 manifest 自己）")
    parser.add_argument("--meta", required=True, type=Path, help="逐文件 authority/phase/case_ids 登记表")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--predecessors", type=Path, default=None,
                        help="JSON 数组：同名历史包 [{name,sha256,entries,status}]（版本名唯一性审计）")
    parser.add_argument("--packed-from-commit", default=None,
                        help="打包所依据的 git commit（H5/H4：证据包必须可追溯到单一 commit）")
    parser.add_argument("--created-at", default=None)
    args = parser.parse_args(argv)

    meta = json.loads(args.meta.read_text(encoding="utf-8"))
    per_file: dict[str, dict] = meta.get("entries", {})
    excluded = {e["path"] for e in meta.get("excluded", [])}
    rejected = {e["path"] for e in meta.get("rejected", [])}
    out_rel = args.out.relative_to(args.root).as_posix() if args.out.is_relative_to(args.root) else None

    failures: list[str] = []
    entries: list[dict] = []
    seen: set[str] = set()
    for path in sorted(p for p in args.root.rglob("*") if p.is_file()):
        rel = path.relative_to(args.root).as_posix()
        if rel == out_rel:
            continue
        if rel in excluded:
            failures.append(f"{rel}: 声明 excluded 但仍存在于 staging")
            continue
        if rel in rejected:
            failures.append(f"{rel}: 声明 rejected 但仍存在于 staging")
            continue
        spec = per_file.get(rel)
        if not spec:
            failures.append(f"{rel}: 缺登记元数据（authority/phase/case_ids），拒绝生成（不允许默认值蒙混）")
            continue
        authority = spec.get("authority")
        phase = spec.get("phase")
        case_ids = spec.get("case_ids")
        if authority not in AUTHORITY_MIGRATION and authority not in AUTHORITY_BASE:
            failures.append(f"{rel}: authority 非法 {authority!r}（v8 只接受 authoritative|historical，细分写 authority_detail）")
        if authority == "drill":
            failures.append(f"{rel}: authority=drill 禁止进入验收证据包（演练走 infra/evidence）")
        if phase not in PHASES:
            failures.append(f"{rel}: phase 非法 {phase!r}")
        if not isinstance(case_ids, list) or not case_ids or any(not isinstance(c, str) or not c for c in case_ids):
            failures.append(f"{rel}: case_ids 必须是非空字符串数组")
        if rel in seen:
            failures.append(f"{rel}: 重复登记")
        seen.add(rel)
        entries.append(
            {
                "path": rel,
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
                "authority": (
                    AUTHORITY_MIGRATION[authority][0]
                    if authority in AUTHORITY_MIGRATION
                    else authority
                ),
                **(
                    {"authority_detail": AUTHORITY_MIGRATION[authority][1]}
                    if authority in AUTHORITY_MIGRATION
                    else (
                        {"authority_detail": spec["authority_detail"]}
                        if spec.get("authority_detail")
                        else {}
                    )
                ),
                "phase": phase,
                "case_ids": case_ids,
                **{k: spec[k] for k in ("source_path", "source_mtime", "received_at", "note") if k in spec},
            }
        )
    if failures:
        print(f"FAIL manifest 生成被拒绝（{len(failures)} 项）：")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    manifest = {
        "schema_version": 2,
        "packed_from_commit": args.packed_from_commit,
        "predecessors": json.loads(args.predecessors.read_text(encoding="utf-8")) if args.predecessors else [],
        "created_at": args.created_at or datetime.now().astimezone().isoformat(timespec="seconds"),
        "archive": args.archive,
        "archive_sha256": "external:SHA256SUMS（tar 内不能嵌自身哈希；收件时单独复算）",
        "manifest_sha256": "external:SHA256SUMS（manifest 自身不能被自己哈希）",
        "rule": "生成器只写 sidecar；被哈希文件内不得出现自身哈希（H4 m02623）",
        "entries": entries,
        "rejected": meta.get("rejected", []),
        "excluded": meta.get("excluded", []),
        "authority_notes": meta.get("authority_notes", {}),
    }
    args.out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"WROTE {args.out}：{len(entries)} 个条目 / {sum(e['bytes'] for e in entries)} 字节")
    return 0


if __name__ == "__main__":
    sys.exit(main())
