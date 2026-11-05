#!/usr/bin/env python3
"""display_safe fail-closed 隔离门禁（KD-RES-FIX / H4 自签，2026-11-05）。

研究数据集（daily_basic/index_daily/top_list/top_inst/moneyflow/margin/hk_hold）
是 internal-only 数据，必须满足三条：

1. 不得写入 `display/` ODS root（只能 `internal/` 或旧平铺 root）；
2. 不得参与 `dim_instrument.display_safe` 派生；
3. 不得进入 C 端 serving 端口（`warehouse/serving/ports.yaml` 不出现 `serving_research_*`）。

检查方式：黑盒调用 A2 的真实命令（python -m warehouse.pipeline）+ 静态核对
`warehouse/dwd/build.py` / `warehouse/serving/ports.yaml`，不 mock A2 内部函数。

退出码：0 通过 / 1 失败 / 2 环境缺失（无 python 或仓库根找不到）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON = sys.executable

PROBE = "SSE:600519"
DAILY_BASIC_ROW = {
    "instrument_id": PROBE,
    "trade_date": "2024-01-02",
    "close": "1688.00",
}


def write_research_in_display(parent: Path) -> Path:
    """在 display root 写一个研究数据集批次（这是被禁止的布局）。"""
    d = parent / "display" / "daily_basic" / "dt=2024-01-02"
    d.mkdir(parents=True, exist_ok=True)
    target = d / "ing-20240103-market-daily_basic.json"
    envelope = {
        "batch_id": "ing-20240103-market-daily_basic",
        "endpoint": "daily_basic",
        "schema": "daily_basic.v1",
        "source": {
            "source": "a2.ci.display_isolation_probe",
            "as_of": "2024-01-03T20:05:00+08:00",
            "fetched_at": "2024-01-03T20:06:00+08:00",
        },
        "rows_total": 1,
        "rows_rejected": 0,
        "rows": [dict(DAILY_BASIC_ROW)],
    }
    target.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def run_pipeline(root: Path, *, profile: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [PYTHON, "-m", "warehouse.pipeline", "--ods-root", str(root), "--profile", profile, "--json"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(REPO_ROOT)},
    )


def check_research_never_in_display_root(tmp: Path) -> list[str]:
    errors: list[str] = []
    root = tmp / "ods"
    write_research_in_display(root)

    prod = run_pipeline(root, profile="prod")
    if prod.returncode == 0:
        errors.append("prod pipeline 接受了 display root 里的研究数据集批次（应拒绝）")
    if "研究数据集批次不得写入 display root" not in (prod.stderr + prod.stdout):
        errors.append(f"prod pipeline 拒绝原因未写明研究数据集隔离（stderr={prod.stderr.strip()[:300]!r}）")

    dev = run_pipeline(root, profile="dev")
    if "研究数据集批次出现在 display root" not in (dev.stderr + dev.stdout):
        errors.append(f"dev profile 未对研究数据集进 display root 告警（stderr={dev.stderr.strip()[:300]!r}）")
    return errors


def check_display_safe_derivation_sources() -> list[str]:
    errors: list[str] = []
    build_py = (REPO_ROOT / "warehouse/dwd/build.py").read_text(encoding="utf-8")
    # display_safe 只允许由 display root 的 instrument 批次 + manifest 证据派生；
    # 研究数据集状态（RESEARCH_VALUE_FIELDS）不得出现在 display_safe 派生路径里。
    for line_no, line in enumerate(build_py.splitlines(), start=1):
        if "display_safe" in line and "RESEARCH_VALUE_FIELDS" in line:
            errors.append(f"warehouse/dwd/build.py:{line_no} display_safe 派生引用了研究数据集：{line.strip()}")
        if "RESEARCH_VALUE_FIELDS" in line and "display" in line.lower():
            errors.append(f"warehouse/dwd/build.py:{line_no} 研究数据集与 display 语义混用：{line.strip()}")

    ports = (REPO_ROOT / "warehouse/serving/ports.yaml").read_text(encoding="utf-8")
    for endpoint in ("daily_basic", "index_daily", "top_list", "top_inst", "moneyflow", "margin", "hk_hold"):
        view = f"serving_research_{endpoint}"
        if view in ports:
            errors.append(f"warehouse/serving/ports.yaml 暴露了内部研究视图 {view}（C 端契约不得包含）")
    return errors


def main() -> int:
    if not (REPO_ROOT / "warehouse/pipeline.py").exists():
        print("[FAIL] 找不到仓库根 warehouse/pipeline.py", file=sys.stderr)
        return 2
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="a2-display-isolation-") as tmp:
        errors += check_research_never_in_display_root(Path(tmp))
    errors += check_display_safe_derivation_sources()

    if errors:
        for error in errors:
            print(f"[FAIL] {error}", file=sys.stderr)
        return 1
    print("✅ display_safe 隔离门禁通过：研究数据集不得进 display root / 不参与 display_safe / 不进 C 端 ports")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
