#!/usr/bin/env python3
"""契约 §1 第 4 步（report）：聚合 db-migrate/ingress/load 结果 + A2 quality.json → ingest-report.json。

由 compose `ingest-report` 服务执行（A12 写域）。输入：
  /state/step-ingest.json  {"exit_code": n, "detail": "..."}
  /state/step-load.json    {"exit_code": n, "detail": "..."}
  /state/quality.json      A2 质量报告（schema_version=1）
输出：/state/ingest-report.json（原子写），字段见 docs/INGEST-ONCE-CONTRACT.md §3。
退出码：0 = 报告写成功；30 = 报告不可写/质量报告不合法（报告仍尽量写）。
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

REPORT = os.environ.get("INGEST_REPORT_PATH", "/state/ingest-report.json")
QUALITY = os.environ.get("QUALITY_REPORT_PATH", "/state/quality.json")
STEP_INGEST = os.environ.get("STEP_INGEST_FILE", "/state/step-ingest.json")
STEP_LOAD = os.environ.get("STEP_LOAD_FILE", "/state/step-load.json")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return None


def step(path):
    data = read_json(path)
    if data is None or not isinstance(data.get("exit_code"), int):
        return {"exit_code": None, "ok": False, "detail": "MISSING"}
    return {"exit_code": data["exit_code"], "ok": data["exit_code"] == 0,
            "detail": str(data.get("detail") or "")}


ingest = step(STEP_INGEST)
load = step(STEP_LOAD)
quality = read_json(QUALITY)
quality_ok = quality is not None and quality.get("schema_version") == 1 and quality.get("level") in (
    "green", "yellow", "red")
quality_step = {"exit_code": 0 if quality_ok else 30, "ok": quality_ok,
                "detail": "OK" if quality_ok else "REPORT_INVALID"}

steps = {"ingest": ingest, "load": load, "quality": quality_step}
failed_step = None
for name in ("ingest", "load", "quality"):
    if not steps[name]["ok"]:
        failed_step = name
        break

detail_code = {"QUALITY_RED": "QUALITY_RED", "ENV": "ENV", "INPUT_MISSING": "INPUT_MISSING",
               "QUOTA": "QUOTA", "UPSTREAM": "UPSTREAM", "REPORT_INVALID": "REPORT_INVALID",
               "UNKNOWN": "UNKNOWN", "MISSING": "UNKNOWN"}
if failed_step is None:
    failed_reason = None
    if quality.get("level") == "red":
        failed_step, failed_reason = "quality", "QUALITY_RED"
else:
    failed_reason = f"INGEST_FAILED:{failed_step}:{detail_code.get(steps[failed_step]['detail'], 'UNKNOWN')}"

report = {
    "schema_version": 1,
    "ready": failed_step is None,
    "failed_step": failed_step,
    "failed_reason": failed_reason,
    "quality_level": (quality or {}).get("level"),
    "quality_score": (quality or {}).get("score"),
    "steps": {name: {"exit_code": s["exit_code"], "ok": s["ok"]} for name, s in steps.items()},
    "counts": (quality or {}).get("counts") or {},
    "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}

try:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(REPORT) or ".", prefix=".ingest-report.")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, sort_keys=True, indent=2)
        fh.write("\n")
    os.replace(tmp, REPORT)
    print(f"[report] ready={report['ready']} failed_step={failed_step} "
          f"reason={failed_reason} quality={report['quality_level']}")
except OSError as exc:
    print(f"[report] 写 {REPORT} 失败：{exc}", file=sys.stderr)
    sys.exit(30)
sys.exit(0 if quality_ok else 30)
