#!/usr/bin/env python3
"""证据包 manifest 机械校验（H5-R18 / L74）。

规则（来自 Lead m02534，逐条机械执行，不靠人眼）：
1. manifest 内每个文件必须：存在 + size>0 + sha256 匹配；
2. 打包内的每个普通文件都必须在 manifest 登记（manifest 自身除外，避免自引用）；
3. 收件时“提交值 != 实算值”的文件必须进入 `rejected`，且不得出现在包里；
4. 明确声明为 excluded 的文件不得出现在包里；5. 权威版本标注必须存在：
   results.json = 修复前基线（保留不覆盖），results-r4.json / trustproxy-guard.json = 修复后权威。

用法：
  python3 tests/data/acceptance/check_evidence_manifest.py \
      --manifest tests/data/acceptance/artifacts/v3/manifest-20261104T0235Z.json \
      --archive  tests/data/acceptance/artifacts/11-12-evidence-20261104-v3.tar.gz

退出码：0 全部通过；1 有失败；2 用法错误。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Failure:
    path: str
    reason: str

    def __str__(self) -> str:
        return f"{self.path}: {self.reason}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:  # noqa: TRY003 - 明确失败原因
        raise SystemExit(f"manifest 不可读：{path}: {exc}")


def verify_manifest_schema(manifest: dict) -> list[Failure]:
    failures: list[Failure] = []
    for key in ("schema_version", "created_at", "archive", "entries"):
        if key not in manifest:
            failures.append(Failure("<manifest>", f"缺顶点字段 {key}"))
    if not isinstance(manifest.get("entries"), list) or not manifest.get("entries"):
        failures.append(Failure("<manifest>", "entries 为空"))
        return failures

    seen: set[str] = set()
    for index, entry in enumerate(manifest["entries"]):
        label = f"entries[{index}]"
        for key in ("path", "sha256", "bytes"):
            if key not in entry:
                failures.append(Failure(label, f"缺字段 {key}"))
        path = entry.get("path")
        if not isinstance(path, str) or not path or path.startswith("/") or ".." in Path(path).parts:
            failures.append(Failure(label, f"非法 path：{path!r}"))
            continue
        if path in seen:
            failures.append(Failure(path, "在 manifest 中重复登记"))
        seen.add(path)
        sha = entry.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            failures.append(Failure(path, f"sha256 不是 64 位小写 hex：{sha!r}"))
        size = entry.get("bytes")
        if not isinstance(size, int) or size <= 0:
            failures.append(Failure(path, f"bytes 必须 >0，实际 {size!r}"))
    return failures


def verify_entries_against_archive(manifest: dict, archive: Path) -> list[Failure]:
    failures: list[Failure] = []
    manifest_path = manifest.get("_manifest_member")  # 由调用方注入，不写进文件
    try:
        tar = tarfile.open(archive, "r:*")
    except (OSError, tarfile.TarError) as exc:
        return [Failure(str(archive), f"无法打开证据包：{exc}")]

    with tar:
        members = {m.name: m for m in tar.getmembers() if m.isfile()}
        # 1+2：登记的文件必须存在/非空/哈希匹配；包内文件必须全部登记
        registered = {e["path"]: e for e in manifest["entries"]}
        for path, entry in registered.items():
            member = members.get(path)
            if member is None:
                failures.append(Failure(path, "登记在 manifest，但证据包内不存在"))
                continue
            data = tar.extractfile(member)
            if data is None:
                failures.append(Failure(path, "无法从证据包读取"))
                continue
            raw = data.read()
            if len(raw) <= 0:
                failures.append(Failure(path, "size>0 失败：文件为 0 字节"))
            if len(raw) != entry["bytes"]:
                failures.append(Failure(path, f"bytes 不符：manifest {entry['bytes']}，实际 {len(raw)}"))
            actual = sha256_bytes(raw)
            if actual != entry["sha256"]:
                failures.append(Failure(path, f"sha256 不符：manifest {entry['sha256']}，实算 {actual}"))

        allowed_extra = {manifest_path} if manifest_path else set()
        for name in sorted(members):
            if name in registered or name in allowed_extra:
                continue
            failures.append(Failure(name, "包内文件未登记在 manifest（禁止夹带）"))

        # 3：rejected 必须不在包里；4：excluded 必须不在包里
        for entry in manifest.get("rejected", []):
            if entry.get("path") in members:
                failures.append(Failure(str(entry.get("path")), "已拒收文件仍被打进证据包"))
            for key in ("submitted_sha256", "actual_sha256", "reason"):
                if key not in entry:
                    failures.append(Failure(str(entry.get("path")), f"rejected 缺 {key}"))
            if entry.get("submitted_sha256") == entry.get("actual_sha256"):
                failures.append(Failure(str(entry.get("path")), "rejected 条目的提交值与实算值相同，不应拒收"))
        for entry in manifest.get("excluded", []):
            if entry.get("path") in members:
                failures.append(Failure(str(entry.get("path")), "excluded 文件仍被打进证据包"))
            if "reason" not in entry:
                failures.append(Failure(str(entry.get("path")), "excluded 缺 reason"))
    return failures


def verify_authority(manifest: dict) -> list[Failure]:
    """权威版本标注（H5-R18 第 3 条）。"""
    failures: list[Failure] = []
    by_path = {e["path"]: e for e in manifest["entries"]}
    expected = {
        "a19-artifacts/results.json": "pre_fix_baseline",
        "a19-artifacts/results-r4.json": "post_fix_authoritative",
        "a19-artifacts/trustproxy-guard.json": "post_fix_authoritative",
        "a19-artifacts/http-attempts-20261104T012350680Z.jsonl": "post_fix_run_scoped_raw_log",
    }
    for path, authority in expected.items():
        entry = by_path.get(path)
        if entry is None:
            failures.append(Failure(path, "缺权威版本文件"))
        elif entry.get("authority") != authority:
            failures.append(Failure(path, f"authority 应为 {authority}，实际 {entry.get('authority')!r}"))
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="证据包 manifest 机械校验（H5-R18）")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--manifest-member", default=None, help="manifest 在包内的路径（用于排除自引用）")
    args = parser.parse_args(argv)

    manifest = load_manifest(args.manifest)
    if args.manifest_member is None:
        try:
            with tarfile.open(args.archive, "r:*") as tar:
                names = [m.name for m in tar.getmembers() if m.isfile()]
        except (OSError, tarfile.TarError) as exc:
            print(f"FAIL 无法打开证据包：{exc}")
            return 1
        candidates = [n for n in names if Path(n).name == args.manifest.name]
        if len(candidates) != 1:
            print(f"FAIL 无法唯一确定包内 manifest：{candidates!r}")
            return 1
        args.manifest_member = candidates[0]
    manifest["_manifest_member"] = args.manifest_member

    failures = verify_manifest_schema(manifest)
    if not failures:
        failures += verify_entries_against_archive(manifest, args.archive)
        failures += verify_authority(manifest)

    if failures:
        print(f"FAIL 证据包 manifest 校验失败（{len(failures)} 项）：{args.archive}")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    total_bytes = sum(e["bytes"] for e in manifest["entries"])
    print(
        f"PASS 证据包 manifest 校验通过：{len(manifest['entries'])} 个文件 / {total_bytes} 字节 / "
        f"rejected {len(manifest.get('rejected', []))} 条 / excluded {len(manifest.get('excluded', []))} 条"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
