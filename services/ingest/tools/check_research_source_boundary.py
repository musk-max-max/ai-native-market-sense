#!/usr/bin/env python3
"""研究数据来源边界门禁（H4 m03419 第 ④ 条，A1 侧断言实现）。

检查三件事，任一违反 → 退出 1（fail-closed）：

1. 研究数据集不得出现在 ``display`` root（展示白名单只有 P0 instrument/bar/adj_factor/
   fundamental；研究域 internal-only）。
2. 第三方 mirror 批次不得被标为展示可用：manifest 事件 ``source_channel``/
   ``channel`` 为 ``third_party_mirror``/``tushare`` 且 ``display_safe=true`` → 失败；
   manifest root 落在 display 目录下同样失败。
3. ``_meta/research_sources.jsonl`` 只允许审计元数据：出现 token/凭证类键名即失败
   （本文件是 append-only 审计记录，**不得**含任何凭证，哪怕哈希）。

用法：

    python services/ingest/tools/check_research_source_boundary.py \
        --ods-root services/ingest/var/research-ods-smoke \
        --manifest-root services/ingest/var/research-ods-smoke-audit

退出码：0 通过 / 1 违规 / 2 用法错误。

H4 要求把它挂到 ``check_display_safe_failclosed.py``；该脚本属 A11/A13 写域，
A1 侧先提供可执行断言，由 owner 接线（见回执）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

RESEARCH_ENDPOINTS = (
    "daily_basic",
    "index_daily",
    "top_list",
    "top_inst",
    "moneyflow",
    "margin",
    "hk_hold",
    "stk_limit",
    "fina_indicator",
    "index_classify",
    "index_member_all",
)
MIRROR_CHANNELS = {"third_party_mirror"}
CREDENTIAL_KEYS = {
    "token",
    "api_key",
    "apikey",
    "secret",
    "password",
    "credential",
    "credential_ref",
    "authorization_header",
}
SOURCES_FILE = "research_sources.jsonl"


class BoundaryResult:
    def __init__(self) -> None:
        self.violations: list[str] = []
        self.checked: dict[str, int] = {}

    def fail(self, message: str) -> None:
        self.violations.append(message)

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": not self.violations,
            "violations": self.violations,
            "checked": self.checked,
        }


def _candidate_roots(ods_root: Path) -> list[Path]:
    roots = [ods_root]
    for sub in ("internal", "display"):
        candidate = ods_root / sub
        if candidate.is_dir():
            roots.append(candidate)
    return roots


def check_ods_root(ods_root: Path, result: BoundaryResult) -> None:
    for root in _candidate_roots(ods_root):
        display = root / "display"
        if display.is_dir():
            for endpoint in RESEARCH_ENDPOINTS:
                if (display / endpoint).is_dir():
                    result.fail(
                        f"research endpoint {endpoint!r} found under display root {display}"
                    )
        sources = root / "_meta" / SOURCES_FILE
        if sources.is_file():
            result.checked["research_sources_files"] = (
                result.checked.get("research_sources_files", 0) + 1
            )
            for lineno, line in enumerate(sources.read_text(encoding="utf-8").splitlines(), 1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    result.fail(f"{sources}:{lineno}: invalid JSON ({exc})")
                    continue
                keys = {str(k).lower() for k in record}
                leaked = keys & CREDENTIAL_KEYS
                if leaked:
                    result.fail(
                        f"{sources}:{lineno}: credential-like keys {sorted(leaked)} "
                        "must not be recorded (H4 m03419)"
                    )


def check_manifest_root(manifest_root: Path, result: BoundaryResult) -> None:
    if "display" in manifest_root.parts:
        result.fail(f"manifest root must not live under display path: {manifest_root}")
    manifest = manifest_root / "manifest.jsonl"
    if not manifest.is_file():
        return
    result.checked["manifest_events"] = 0
    for lineno, line in enumerate(manifest.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        result.checked["manifest_events"] += 1
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            result.fail(f"{manifest}:{lineno}: invalid JSON ({exc})")
            continue
        channel = str(event.get("channel") or "")
        source_channel = str(event.get("source_channel") or "")
        display_safe = event.get("display_safe")
        if (channel in MIRROR_CHANNELS or source_channel in MIRROR_CHANNELS) and display_safe is True:
            result.fail(
                f"{manifest}:{lineno}: mirror batch cannot be display_safe=true "
                f"(channel={channel!r}, source_channel={source_channel!r})"
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ods-root", type=Path, required=True)
    parser.add_argument("--manifest-root", type=Path)
    parser.add_argument("--json", action="store_true", help="输出 JSON 结果")
    args = parser.parse_args(argv)
    if not args.ods_root.is_dir():
        print(f"ods root not found: {args.ods_root}", file=sys.stderr)
        return 2
    result = BoundaryResult()
    check_ods_root(args.ods_root, result)
    if args.manifest_root is not None:
        check_manifest_root(args.manifest_root, result)
    payload = result.as_dict()
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print("research source boundary: " + ("OK" if payload["ok"] else "FAIL"))
        for violation in payload["violations"]:
            print(f"  - {violation}")
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
