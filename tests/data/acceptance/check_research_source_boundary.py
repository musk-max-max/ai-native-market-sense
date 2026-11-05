#!/usr/bin/env python3
"""研究数据来源边界门禁的 A11 薄封装（H4 m03988，KD-RES-FIX 家族）。

被测对象是 A1 的工具 `services/ingest/tools/check_research_source_boundary.py`
（A1 commit `bc118ce`，不复制、不修改）。本封装只做三件事：

1. 正样本：A1 的 smoke 产物（`services/ingest/var/research-ods-smoke` +
   `research-ods-smoke-audit`）必须 exit 0；
2. 负样本 ①：mirror 批次被标 `display_safe=true` → 必须非 0（复制 smoke 到临时目录，
   追加一条 `third_party_mirror` + `display_safe=true` 的 manifest 事件）；
3. 负样本 ②：`_meta/research_sources.jsonl` 出现 `token` 键 → 必须非 0（复制 ODS root，
   追加一条含 token 的审计记录）。

与 `check_display_safe_failclosed.py` 同族但**不合并**：那个校验 manifest/display_safe 派生，
这个校验来源边界；失败原因分开定位。属 11-12 release job 桶，不进日常 pytest。

用法：

    python3 tests/data/acceptance/check_research_source_boundary.py
    python3 tests/data/acceptance/check_research_source_boundary.py \
        --evidence tests/data/acceptance/artifacts/research-source-boundary-<UTC>.md

退出码：0 通过 / 1 失败 / 2 环境缺失（A1 脚本或 smoke 产物不存在）。
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CHECKER = REPO_ROOT / "services/ingest/tools/check_research_source_boundary.py"
SMOKE_ODS = REPO_ROOT / "services/ingest/var/research-ods-smoke"
SMOKE_MANIFEST = REPO_ROOT / "services/ingest/var/research-ods-smoke-audit"


TMP_PATH_RE = re.compile(r"/var/folders/[^\s]+/a11-research-boundary-[A-Za-z0-9_]+")


class Transcript:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.failures: list[str] = []

    def record(
        self,
        title: str,
        command: list[str],
        code: int,
        stdout: str,
        stderr: str,
        provenance: str | None = None,
    ) -> None:
        self.lines.append(f"### {title}")
        if provenance:
            self.lines.append(f"输入构造：{provenance}")
            self.lines.append("")
        self.lines.append("```")
        rendered = TMP_PATH_RE.sub("<tmp>", " ".join(command))
        self.lines.append("$ " + rendered)
        self.lines.append("```")
        self.lines.append(f"exit_code: `{code}`")
        self.lines.append("stdout:")
        self.lines.append("```")
        self.lines.append(stdout.rstrip())
        self.lines.append("```")
        if stderr.strip():
            self.lines.append("stderr:")
            self.lines.append("```")
            self.lines.append(stderr.rstrip())
            self.lines.append("```")
        self.lines.append("")

    def require(self, condition: bool, message: str) -> None:
        if not condition:
            self.failures.append(message)


def run_checker(ods_root: Path, manifest_root: Path | None) -> tuple[list[str], int, str, str]:
    command = [
        sys.executable,
        str(CHECKER.relative_to(REPO_ROOT)),
        "--ods-root",
        str(ods_root),
        "--json",
    ]
    if manifest_root is not None:
        command += ["--manifest-root", str(manifest_root)]
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return command, completed.returncode, completed.stdout, completed.stderr


def positive_case(transcript: Transcript, ods_root: Path, manifest_root: Path) -> None:
    command, code, stdout, stderr = run_checker(ods_root, manifest_root)
    transcript.record("正样本：A1 smoke 产物（research-ods-smoke）", command, code, stdout, stderr)
    transcript.require(code == 0, f"正样本 smoke 应 exit 0，实际 {code}: {stderr.strip()[:300]}")
    try:
        payload = json.loads(stdout[stdout.find("{") : stdout.rfind("}") + 1])
    except (json.JSONDecodeError, ValueError):
        payload = {}
    transcript.require(payload.get("ok") is True, f"正样本 JSON ok 不为 true: {payload!r}")
    transcript.require(
        bool(payload.get("checked")),
        "正样本未报告 checked 计数（脚本可能空转）",
    )


def negative_mirror_display_safe(
    transcript: Transcript, tmp: Path, ods_root: Path, manifest_root: Path
) -> None:
    manifest_copy = tmp / "manifest-mirror"
    shutil.copytree(manifest_root, manifest_copy)
    mirror_event = {
        "event_id": "mft-a11-negative-mirror",
        "event_type": "research_import",
        "channel": "third_party_mirror",
        "source_channel": "third_party_mirror",
        "display_safe": True,
        "status": "succeeded",
        "rows": 1,
    }
    with (manifest_copy / "manifest.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(mirror_event, ensure_ascii=False) + "\n")

    command, code, stdout, stderr = run_checker(ods_root, manifest_copy)
    transcript.record(
        "负样本①：mirror 批次 display_safe=true",
        command,
        code,
        stdout,
        stderr,
        provenance=(
            "复制 A1 smoke 的 manifest root，向 manifest.jsonl **追加**一条"
            " `channel=third_party_mirror` 且 `display_safe=true` 的 research_import 事件；"
            "其余字节不变。"
        ),
    )
    combined = stdout + stderr
    transcript.require(code != 0, "mirror 批次被标 display_safe=true 时必须非 0")
    transcript.require(
        "display_safe" in combined and "mirror" in combined.lower(),
        f"失败原因未点名 mirror/display_safe：{combined.strip()[:300]!r}",
    )


def negative_credential_in_sources(
    transcript: Transcript, tmp: Path, ods_root: Path, manifest_root: Path
) -> None:
    ods_copy = tmp / "ods-credential"
    shutil.copytree(ods_root, ods_copy)
    sources = ods_copy / "internal" / "_meta" / "research_sources.jsonl"
    sources.parent.mkdir(parents=True, exist_ok=True)
    with sources.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"run_id": "a11-negative", "token": "must-not-be-recorded"}) + "\n")

    command, code, stdout, stderr = run_checker(ods_copy, manifest_root)
    transcript.record(
        "负样本②：research_sources 记录含 token 键",
        command,
        code,
        stdout,
        stderr,
        provenance=(
            "复制 A1 smoke 的 ODS root，向 `internal/_meta/research_sources.jsonl` **追加**一条"
            " `{\"run_id\": \"a11-negative\", \"token\": \"must-not-be-recorded\"}` 审计记录；"
            "其余字节不变。"
        ),
    )
    combined = stdout + stderr
    transcript.require(code != 0, "sources 文件出现 token 键时必须非 0")
    transcript.require(
        "credential" in combined.lower() and "token" in combined.lower(),
        f"失败原因未点名 credential/token：{combined.strip()[:300]!r}",
    )


def missing_root_exits_2(transcript: Transcript, tmp: Path) -> None:
    command, code, stdout, stderr = run_checker(tmp / "does-not-exist", None)
    transcript.record("用法/环境错误：ods root 不存在应 exit 2", command, code, stdout, stderr)
    transcript.require(code == 2, f"ods root 不存在时应 exit 2，实际 {code}")


def git_commit() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True
    )
    return completed.stdout.strip() if completed.returncode == 0 else "unknown"


def write_evidence(path: Path, transcript: Transcript, verdict: str) -> None:
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        "# 研究数据来源边界门禁证据（A11 薄封装）",
        "",
        f"- 生成时间（UTC）：{now}",
        f"- 仓库 HEAD：`{git_commit()}`",
        f"- 被测工具：`services/ingest/tools/check_research_source_boundary.py`（A1 `bc118ce`，未修改）",
        f"- 输入（A1 smoke 产物）：`services/ingest/var/research-ods-smoke`、"
        f"`services/ingest/var/research-ods-smoke-audit`",
        "- 判定：正样本 exit 0；负样本①mirror+display_safe=true、②sources 含 token 均非 0；ods root 不存在 exit 2",
        f"- 结论：**{verdict}**",
        "",
    ]
    lines.extend(transcript.lines)
    if transcript.failures:
        lines.append("## 失败项")
        for failure in transcript.failures:
            lines.append(f"- {failure}")
        lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ods-root",
        type=Path,
        default=SMOKE_ODS,
        help="研究 ODS root（默认 A1 smoke 产物 services/ingest/var/research-ods-smoke）",
    )
    parser.add_argument(
        "--manifest-root",
        type=Path,
        default=SMOKE_MANIFEST,
        help="研究 manifest root（默认 services/ingest/var/research-ods-smoke-audit）",
    )
    parser.add_argument("--evidence", type=Path, help="写出 Markdown 证据文件")
    args = parser.parse_args(argv)
    ods_root = args.ods_root.resolve()
    manifest_root = args.manifest_root.resolve()

    if not CHECKER.is_file():
        print(f"[SKIP] 找不到 A1 门禁脚本 {CHECKER}", file=sys.stderr)
        return 2
    if not ods_root.is_dir() or not manifest_root.is_dir():
        print(f"[SKIP] 找不到输入根：ods={ods_root} manifest={manifest_root}", file=sys.stderr)
        return 2

    transcript = Transcript()
    with tempfile.TemporaryDirectory(prefix="a11-research-boundary-") as directory:
        tmp = Path(directory)
        positive_case(transcript, ods_root, manifest_root)
        negative_mirror_display_safe(transcript, tmp, ods_root, manifest_root)
        negative_credential_in_sources(transcript, tmp, ods_root, manifest_root)
        missing_root_exits_2(transcript, tmp)

    verdict = "PASS" if not transcript.failures else "FAIL"
    print(f"[{verdict}] research source boundary（正样本 1 + 负样本 2 + 用法 1）")
    for failure in transcript.failures:
        print(f"  - {failure}")
    if args.evidence is not None:
        write_evidence(args.evidence, transcript, verdict)
        print(f"evidence: {args.evidence}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
