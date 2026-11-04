#!/usr/bin/env python3
"""v7 与 v6-124entries 的证据等价门禁（H4 m03485 / H5 四元组要求）。

定义（H4 m03485 定稿，写死在代码里，不手写结论）：
- 证据集 = `a19-artifacts/**`、`transcripts/**`、`a2-evidence/**`、
  `services/market/evidence/**`、`a19-REPORT.md`；
- 非证据 = 顶层文档、`git-info.txt`、`tests/**`、`SHA256SUMS*`、包内 manifest；
- 等价断言只跑证据集：path 集合相等 + 逐 path bytes/sha256 全等；
- 非证据允许的变更**恰好**是下面 ALLOWED_NON_EVIDENCE_CHANGES 的 7 条，
  每条旧/新 sha256 都要对上；多一条（第 8 条）或 sha 不符即失败。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile
from collections import Counter
from pathlib import Path

# 证据集定义（H4 m03485）
EVIDENCE_PREFIXES = (
    "a19-artifacts/",
    "transcripts/",
    "a2-evidence/",
    "services/market/evidence/",
)
EVIDENCE_FILES = ("a19-REPORT.md",)

# 非证据中允许变更的 7 条：path -> (v6 sha256, v7 sha256)
ALLOWED_NON_EVIDENCE_CHANGES: dict[str, tuple[str, str]] = {
    "ADVERSARIAL.md": (
        "1f001088e38f49f9a92cdf78f5bbe040035ab40053b784cd50314a21629bed68",
        "4bf387a483883a351a1156e54bb2c014d13a9dd54bc469949f04767d585e6ba4",
    ),
    "git-info.txt": (
        "18efbffa72f6aa4b04bf2c0252ed9e895605c954b194129f1a91475165013739",
        "b2d60f7256420d8ccca9547768797af2732a2468bcbc433726338566e40e58a4",
    ),
    "tests/contract/CI_MOUNT.md": (
        "0f02c785fdbb1510fdac2a367988d72889a13b8d6d301f01edb8b0edbb615584",
        "d17f83a30b1f4a498a79d6eea454b263070355bf516380d07231926f2dd4738b",
    ),
    "tests/data/acceptance/build_evidence_manifest.py": (
        "fa1a8c8f510e27ae55bce0547e9fcf9218fc3033c4ece493a26a000fd717f877",
        "fae7d00d2317c3c585a9d5f63c5270d4858230b86420dc23975faf226e528644",
    ),
    "tests/data/acceptance/check_pack_matches_head.py": (
        "09e71b5b9fd9f020007742b596c72653b4a7d1096c82247fa22b72a5ffbe9861",
        "9e2cc5568b2d20e4dc10aab9b29ada1639aea992937c241231c7a4e8a2f0bd1a",
    ),
    "tests/data/test_evidence_manifest.py": (
        "7c866c759408978c85b1040aa6fc5a944f699d5cd0c23740c23baf3588580302",
        "324285543cc1e29268ac4fec4d1ecb07fbab0f4c2164b8ce405d5e46145ca0ac",
    ),
    "tests/data/test_pack_matches_head.py": (
        "56cf959f547211b35839d0d1194f0ae1113c9befadfe79ab286c01c33d0842f4",
        "223ffd0b863543e2e8e167e503a21355c6dcab20ee2a5e3b9d85acebb899708a",
    ),
}

MANIFEST_EXCLUDE_PREFIXES = ("evidence-manifest", "SHA256SUMS")


def load_entries(tar_path: Path) -> tuple[dict[str, dict], str]:
    """返回 {path: entry} 与包内 manifest 的 sha256。"""
    with tarfile.open(tar_path) as tar:
        names = [
            n
            for n in tar.getnames()
            if n.endswith(".json")
            and "evidence-manifest" in n
            and "/" not in n
        ]
        if not names:
            raise SystemExit(f"FAIL 配置：{tar_path} 内无包内 manifest")
        raw = tar.extractfile(names[0]).read()
        manifest = json.loads(raw)
        entries = {e["path"]: e for e in manifest["entries"]}
        return entries, hashlib.sha256(raw).hexdigest()


def is_evidence(path: str) -> bool:
    if path in EVIDENCE_FILES:
        return True
    return any(path.startswith(prefix) for prefix in EVIDENCE_PREFIXES)


def is_manifest_like(path: str) -> bool:
    base = path.rsplit("/", 1)[-1]
    return any(base.startswith(prefix) for prefix in MANIFEST_EXCLUDE_PREFIXES)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--previous", required=True, type=Path)
    parser.add_argument("--current", required=True, type=Path)
    args = parser.parse_args(argv)

    prev, prev_manifest_sha = load_entries(args.previous)
    cur, cur_manifest_sha = load_entries(args.current)

    prev_paths = {p for p in prev if not is_manifest_like(p)}
    cur_paths = {p for p in cur if not is_manifest_like(p)}
    missing = sorted(prev_paths - cur_paths)
    extra = sorted(cur_paths - prev_paths)

    prev_ev = {p for p in prev_paths if is_evidence(p)}
    cur_ev = {p for p in cur_paths if is_evidence(p)}
    ev_missing = sorted(prev_ev - cur_ev)
    ev_extra = sorted(cur_ev - prev_ev)
    ev_changed = sorted(
        p for p in prev_ev & cur_ev if prev[p]["sha256"] != cur[p]["sha256"]
    )

    non_ev = (prev_paths & cur_paths) - prev_ev
    changed_non_ev = sorted(p for p in non_ev if prev[p]["sha256"] != cur[p]["sha256"])
    allowed = ALLOWED_NON_EVIDENCE_CHANGES
    unexpected = [p for p in changed_non_ev if p not in allowed]
    sha_mismatch = []
    for p in changed_non_ev:
        if p not in allowed:
            continue
        old_expected, new_expected = allowed[p]
        if prev[p]["sha256"] != old_expected or cur[p]["sha256"] != new_expected:
            sha_mismatch.append(p)
    missing_allowed = sorted(set(allowed) - set(changed_non_ev))

    ok = not (
        missing
        or extra
        or ev_missing
        or ev_extra
        or ev_changed
        or unexpected
        or sha_mismatch
        or missing_allowed
    )

    counts = Counter()
    for p in sorted(cur_ev):
        prefix = next((x for x in EVIDENCE_PREFIXES if p.startswith(x)), "(root)")
        counts[prefix] += 1

    print(
        f"证据集定义：prefixes={EVIDENCE_PREFIXES} files={EVIDENCE_FILES}；"
        f"v6={len(prev_ev)} / v7={len(cur_ev)} 条"
    )
    for prefix, n in sorted(counts.items()):
        print(f"  证据计数 {prefix} = {n}")
    print(
        f"非证据差异允许清单 = {len(allowed)} 条；实际变化 = {len(changed_non_ev)} 条"
    )
    for p in changed_non_ev:
        old = prev[p]["sha256"][:12]
        new = cur[p]["sha256"][:12]
        mark = "OK" if p in allowed else "UNEXPECTED"
        print(f"  [{mark}] {p} {prev[p]['bytes']}B {old} -> {cur[p]['bytes']}B {new}")
    print(f"包内 manifest sha256：v6={prev_manifest_sha[:12]}… v7={cur_manifest_sha[:12]}…")

    if not ok:
        print("FAIL 证据等价或非证据变更清单不符（H4 m03485 定义）：")
        for label, items in (
            ("路径只在前包", missing),
            ("路径只在后包", extra),
            ("证据集缺 path", ev_missing),
            ("证据集多 path", ev_extra),
            ("证据集 sha 变化", ev_changed),
            ("非证据未登记变化", unexpected),
            ("允许清单 sha 不符", sha_mismatch),
            ("允许清单条目未变化", missing_allowed),
        ):
            if items:
                print(f"  {label}: {items}")
        return 1

    print(
        f"PASS 证据集等价：{len(cur_ev)} 个证据 path 的 bytes+sha256 全等；"
        f"非证据仅允许的 {len(allowed)} 条变化且 sha 逐一匹配"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
