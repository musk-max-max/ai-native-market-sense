"""数仓 CLI。

    # golden 回归（task-6 验收入口）
    python3 -m warehouse.pipeline --golden data/golden/p0_bars20.yaml

    # 接 A1 的 ODS 落地目录跑一次质量检查（P0 用内存表，不写库）
    python3 -m warehouse.pipeline --ods-root /path/to/ods --json

退出码：0 通过；1 失败/质量分阻断（供 CI 与下游任务做硬门禁）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from warehouse.dwd.build import build_dwd
from warehouse.golden_runner import run_fixture
from warehouse.ods.loader import (
    OdsFormatError,
    display_instrument_ids,
    load_display_safety,
    load_ods_roots,
    require_display_evidence,
)
from warehouse.quality.checks import run_quality_checks


def _run_golden(path: Path, as_json: bool) -> int:
    results = run_fixture(path)
    passed = [r for r in results if r.passed]
    failed = [r for r in results if not r.passed]
    if as_json:
        print(
            json.dumps(
                {
                    "fixture": str(path),
                    "total": len(results),
                    "passed": len(passed),
                    "failed": len(failed),
                    "cases": [r.as_dict() for r in results],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for r in results:
            mark = "PASS" if r.passed else "FAIL"
            print(f"[{mark}] {r.case_id} {r.title}")
            for failure in r.failures:
                print(f"       - {failure}")
        print(f"\n{len(passed)}/{len(results)} 通过")
    return 0 if not failed else 1


def _run_ods(
    root: Path,
    as_json: bool,
    manifest_root: Path | None = None,
    internal_root: Path | None = None,
    profile: str = "prod",
) -> int:
    try:
        batches = load_ods_roots(root, internal_root)
        has_display_instruments = bool(display_instrument_ids(batches))
        strict = profile == "prod" and has_display_instruments
        if strict and manifest_root is None:
            raise OdsFormatError(
                "生产 profile 下 display root 有 instrument 批次但没有 --manifest-root，"
                "无法派生 display_safe（拒绝静默落 false）"
            )
        if profile == "prod" and any(batch.origin == "flat" for batch in batches):
            print(
                "[WARN] 平铺 ODS root：没有 root 隔离证据，所有 instrument.display_safe 将为 false（离线回归语义）",
                file=sys.stderr,
            )
        display_safety = (
            load_display_safety(manifest_root, strict=strict) if manifest_root is not None else None
        )
        if strict:
            require_display_evidence(batches, display_safety or {})
    except OdsFormatError as exc:
        print(f"[FAIL] ODS/manifest 校验失败（拒绝入库）: {exc}", file=sys.stderr)
        return 1
    state = build_dwd(batches, display_safety=display_safety)
    if state.bars and not state.instruments:
        # fail-closed：缺 instrument master 时无法建 dim_instrument，BIZ-01（板块涨跌停）、
        # 首日豁免、serving_instrument 全部失去依据；不要在缺维表的情况下出质量分。
        print(
            "[FAIL] ODS 缺少 instrument.v1 批次：无法建 dim_instrument（BIZ-01 板块涨跌停/首日豁免/"
            "serving_instrument 依赖证券主数据）。请 A1 补 instrument.v1 后重跑。",
            file=sys.stderr,
        )
        return 2
    report = run_quality_checks(state)
    payload: dict[str, Any] = {
        "ods_root": str(root),
        "batches": len(batches),
        "bars": len(state.bars),
        "factors": len(state.factors),
        "instruments": len(state.instruments),
        "display_safe_false": sum(1 for row in state.instruments.values() if not row["display_safe"]),
        "fundamentals": len(state.fundamentals),
        "revisions": len(state.revisions),
        "quality": report.as_dict(),
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(
            f"batches={len(batches)} bars={len(state.bars)} factors={len(state.factors)} "
            f"fundamentals={len(state.fundamentals)} revisions={len(state.revisions)}"
        )
        print(f"quality score={report.score} grade={report.grade} blocked={report.blocked}")
        for violation in report.blocker_violations[:20]:
            print(f"  [blocker] {violation.rule_id} {violation.instrument_id} {violation.trade_date}: {violation.detail}")
    return 1 if report.blocked else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m warehouse.pipeline", description="market-sense-h5 P0 数仓流水线")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--golden", type=Path, help="golden dataset YAML（走 ODS→DWD→质量 全链路）")
    source.add_argument("--ods-root", type=Path, help="A1 落地的 ODS 批次根目录")
    parser.add_argument(
        "--profile",
        choices=("prod", "dev"),
        default="prod",
        help="prod（默认）：display root 必须每条标的都有 manifest 展示证据且校验 hash 链/head；dev：离线回归，缺证据降为 false",
    )
    parser.add_argument(
        "--internal-ods-root",
        type=Path,
        help="L34 内部 ODS root（tushare 交叉校验批次）；也支持单 --ods-root 下含 display/ + internal/ 的标准布局（自动识别）",
    )
    parser.add_argument(
        "--manifest-root",
        type=Path,
        help="A1 主数据 manifest 根目录（含 manifest.jsonl/snapshots/），用于派生 dim_instrument.display_safe（L30）",
    )
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    args = parser.parse_args(argv)

    if args.golden is not None:
        return _run_golden(args.golden, args.json)
    return _run_ods(args.ods_root, args.json, args.manifest_root, args.internal_ods_root, args.profile)


if __name__ == "__main__":
    raise SystemExit(main())
