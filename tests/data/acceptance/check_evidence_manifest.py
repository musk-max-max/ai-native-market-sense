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


PHASES = {"pre_fix", "post_fix", "not_applicable"}
AUTHORITIES = {
    "pre_fix_baseline",
    "pre_fix_control",
    "post_fix_authoritative",
    # H5 m03115：引用版 manifest 用字面 authoritative；等价 post_fix_authoritative
    "authoritative",
    # H4 m03103：被取代但保留历史快照的旧 manifest/证据
    "historical",
    "post_fix_control",
    "post_fix_run_scoped_raw_log",
    "evidence",
    "index",
    "receipt",
    "meta",
}


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
        if int(manifest.get("schema_version", 1)) >= 2:
            # H5-R19：每条带 authority / phase / case_ids
            authority = entry.get("authority")
            if authority not in AUTHORITIES:
                failures.append(Failure(path, f"authority 非法或缺失：{authority!r}（允许 {sorted(AUTHORITIES)}）"))
            phase = entry.get("phase")
            if phase not in PHASES:
                failures.append(Failure(path, f"phase 非法或缺失：{phase!r}（允许 {sorted(PHASES)}）"))
            case_ids = entry.get("case_ids")
            if (not isinstance(case_ids, list) or not case_ids
                    or any(not isinstance(c, str) or not c for c in case_ids)):
                failures.append(Failure(path, f"case_ids 必须是非空字符串数组：{case_ids!r}"))
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


def verify_exact_correspondence(manifest: dict, archive: Path) -> list[Failure]:
    """H4 m02705：tar 内除 manifest 自身外，文件集合与 manifest 条目一一对应（多一个少一个都红）。"""
    failures: list[Failure] = []
    if int(manifest.get("schema_version", 1)) < 2:
        return failures
    try:
        with tarfile.open(archive, "r:*") as tar:
            members = {m.name for m in tar.getmembers() if m.isfile()}
    except (OSError, tarfile.TarError) as exc:
        return [Failure(str(archive), f"无法打开证据包：{exc}")]
    manifest_member = manifest.get("_manifest_member")
    packed = members - ({manifest_member} if manifest_member else set())
    registered = {e["path"] for e in manifest["entries"]}
    for name in sorted(packed - registered):
        failures.append(Failure(name, "包内文件未登记（tar↔manifest 不一一对应）"))
    for name in sorted(registered - packed):
        failures.append(Failure(name, "manifest 登记但包内不存在（tar↔manifest 不一一对应）"))
    return failures


def _normalise_ref(ref: str) -> str:
    value = ref.strip().lstrip("./")
    while value.startswith("./"):
        value = value[2:]
    return value


def _resolve_pointer(ref: str, entries: list[dict]) -> dict | None:
    """把 repo-relative evidence 指针解析到包内条目（按 source_path / 包内路径 / basename 后缀）。"""
    value = _normalise_ref(ref)
    by_source = {e.get("source_path"): e for e in entries if isinstance(e.get("source_path"), str)}
    if value in by_source:
        return by_source[value]
    for entry in entries:
        if entry["path"] == value:
            return entry
        if value.endswith("/" + entry["path"]) or entry["path"].endswith("/" + value):
            return entry
    # repo 路径 .../artifacts/logs/x.log ↔ 包内 a19-artifacts/logs/x.log（A19 evidence 指针格式）
    if value.startswith("artifacts/"):
        value = "x/artifacts/" + value[len("artifacts/"):]
    if "/artifacts/" in value:
        suffix = value.split("/artifacts/", 1)[1]
        hits = [e for e in entries if e["path"].endswith("/" + suffix) or e["path"] == "a19-artifacts/" + suffix]
        if len(hits) == 1:
            return hits[0]
    basename = Path(value).name
    hits = [e for e in entries if Path(e["path"]).name == basename]
    return hits[0] if len(hits) == 1 else None


_PATH_REF = __import__("re").compile(r"^(?:[A-Za-z]:)?[\w./-]+\.(?:log|jsonl?|txt)$")


def _looks_like_path(value: str) -> bool:
    """observed.log 有时是日志文本而不是路径；只有「短、单行、以文件后缀结尾」才当指针。"""
    if not value or len(value) > 300 or "\n" in value or " " in value:
        return False
    return bool(_PATH_REF.match(value))


def _walk_evidence_refs(node, path: str = "") -> list[tuple[str, str]]:
    """收集 evidence.log / evidence.logs / meta.rawHttpLog 一类的指针。"""
    found: list[tuple[str, str]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}" if path else key
            if key in ("log", "logs", "rawHttpLog"):
                values = value if isinstance(value, list) else [value]
                for item in values:
                    if isinstance(item, str) and _looks_like_path(item):
                        found.append((child, item))
            else:
                found.extend(_walk_evidence_refs(value, child))
    elif isinstance(node, list):
        for index, item in enumerate(node):
            found.extend(_walk_evidence_refs(item, f"{path}[{index}]"))
    return found


def verify_evidence_pointers(manifest: dict, archive: Path) -> list[Failure]:
    """H5/H4：包内每个 artifact 引用的 evidence 路径必须命中包内条目（悬空即红灯）。"""
    failures: list[Failure] = []
    if int(manifest.get("schema_version", 1)) < 2:
        return failures
    referenced: set[str] = set()
    excluded_names = {str(entry.get("path", "")) for entry in manifest.get("excluded", [])}
    try:
        with tarfile.open(archive, "r:*") as tar:
            members = {m.name: m for m in tar.getmembers() if m.isfile()}
            for entry in manifest["entries"]:
                if not entry["path"].lower().endswith(".json"):
                    continue
                member = members.get(entry["path"])
                if member is None:
                    continue  # 对应性检查已单独报
                data = tar.extractfile(member)
                if data is None:
                    continue
                try:
                    payload = json.loads(data.read().decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue  # 非 JSON 语义文件不参与指针校验
                for label, ref in _walk_evidence_refs(payload):
                    if not ref or "://" in ref or ref.startswith(("http:", "https:")):
                        continue
                    target = _resolve_pointer(ref, manifest["entries"])
                    if target is None:
                        normalised = _normalise_ref(ref)
                        if any(
                            normalised.endswith(name) or name.endswith(normalised) or Path(normalised).name == Path(name).name
                            for name in excluded_names
                        ):
                            continue  # 指向已声明 excluded 的占位文件（带 reason），不算悬空
                        failures.append(
                            Failure(entry["path"], f"{label} 指向的 evidence 不在包内：{ref!r}（悬空指针）")
                        )
                    else:
                        referenced.add(target["path"])
    except (OSError, tarfile.TarError) as exc:
        return [Failure(str(archive), f"无法打开证据包：{exc}")]
    for path in sorted(referenced):
        target = next(e for e in manifest["entries"] if e["path"] == path)
        if target["bytes"] <= 0:
            failures.append(Failure(path, "被 evidence 指针引用但为 0 字节"))
    return failures


def verify_receipts(manifest: dict) -> list[Failure]:
    """receipt 也是 artifact：包内若有凭证类文件，必须登记且带自己的 sha256（H5-R18 第 3 条）。"""
    failures: list[Failure] = []
    entries = manifest["entries"]
    receipt_like = [e for e in entries if "RECEIPT" in e["path"].upper() or "receipt" in Path(e["path"]).name.lower()]
    for entry in receipt_like:
        if len(entry.get("sha256", "")) != 64:
            failures.append(Failure(entry["path"], "receipt 必须有独立 sha256"))
        if int(manifest.get("schema_version", 1)) >= 2 and entry.get("authority") != "receipt":
            failures.append(Failure(entry["path"], f"receipt 类 artifact 的 authority 应为 receipt，实际 {entry.get('authority')!r}"))
    return failures


def verify_authority(manifest: dict) -> list[Failure]:
    """权威版本标注（H5-R18 第 3 条）。"""
    failures: list[Failure] = []
    by_path = {e["path"]: e for e in manifest["entries"]}
    if int(manifest.get("schema_version", 1)) < 2:
        return failures  # v3 冻结包（schema 1）按当时口径，不追溯改判
    expected = {
        # H5-R22：A19 新 run 后 results.json 为 post-fix 权威；修复前基线以新文件名保留。
        "a19-artifacts/results.json": "post_fix_authoritative",
        "a19-artifacts/results-r4.json": "post_fix_authoritative",
        "a19-artifacts/trustproxy-guard.json": "post_fix_authoritative",
    }
    required = bool(manifest.get("a19_authority_required", False))
    for path, authority in expected.items():
        entry = by_path.get(path)
        if entry is None:
            if required:
                failures.append(Failure(path, "缺权威版本文件"))
            continue
        if entry.get("authority") != authority:
            failures.append(Failure(path, f"authority 应为 {authority}，实际 {entry.get('authority')!r}"))

    # 以下 A19 专属断言只在声明了 a19_authority_required 的包上生效（合成自检包不误报）
    if not required:
        return failures
    # pre-fix 必须保留（不覆盖、不删）：G3 基线 + R4/TRUST_PROXY 修复前控制组
    prefix = [e for e in manifest["entries"] if e["path"].startswith("a19-artifacts/results-prefix-g3-")]
    if not prefix:
        failures.append(Failure("a19-artifacts/results-prefix-g3-*", "缺 G3 修复前基线（不得覆盖/删除 pre-fix）"))
    else:
        for entry in prefix:
            if entry.get("authority") != "pre_fix_baseline" or entry.get("phase") != "pre_fix":
                failures.append(Failure(entry["path"], "G3 修复前基线必须标 pre_fix_baseline/pre_fix"))
    for path in ("a19-artifacts/r4-before-fix.json", "a19-artifacts/trustproxy-guard-before-fix.json"):
        entry = by_path.get(path)
        if entry is not None and (entry.get("authority") != "pre_fix_control" or entry.get("phase") != "pre_fix"):
            failures.append(Failure(path, "修复前控制组必须标 pre_fix_control/pre_fix"))
    if not any(e["path"].startswith("a19-artifacts/http-attempts-") for e in manifest["entries"]):
        failures.append(Failure("a19-artifacts/http-attempts-*", "缺 raw HTTP 往返日志（run-scoped）"))
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
        failures += verify_exact_correspondence(manifest, args.archive)
        failures += verify_evidence_pointers(manifest, args.archive)
        failures += verify_receipts(manifest)
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
