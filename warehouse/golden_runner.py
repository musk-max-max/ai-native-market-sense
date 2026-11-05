"""golden dataset 回归执行器（task-6 验收 ① 20 条全过 ② 改坏一条能红灯）。

用法：python3 -m warehouse.pipeline --golden data/golden/p0_bars20.yaml
退出码：0 = 全部通过；1 = 有用例失败（阻断下游）。

fixture 格式（见 data/golden/README.md）：每个用例把数据写成 ODS 交换格式 v1 的批次文件到临时目录，
再走与生产相同的路径 `load_batches → build_dwd → quality`。因此 golden 同时回归了格式校验、
去重/幂等/修订留痕与质量规则，而不是直接调用内部函数比对。
"""

from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from warehouse.dwd.adjust import adjust_bars
from warehouse.dwd.build import build_dwd
from warehouse.ods.loader import (
    ENDPOINT_SCHEMAS,
    OdsFormatError,
    load_batches,
    parse_date,
    parse_shanghai_datetime,
)
from warehouse.quality.checks import run_quality_checks

DEFAULT_AS_OF_TIME = time(20, 5)
DEFAULT_FETCH_MARGIN = timedelta(minutes=1)


@dataclass
class CaseResult:
    case_id: str
    title: str
    passed: bool = False
    failures: list[str] = field(default_factory=list)
    grade: str | None = None
    score: float | None = None
    violations: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "title": self.title,
            "passed": self.passed,
            "failures": self.failures,
            "grade": self.grade,
            "score": self.score,
            "violations": self.violations,
        }


def load_fixture(path: str | Path) -> dict[str, Any]:
    payload = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or "cases" not in payload:
        raise ValueError(f"{path}: fixture 必须是含 cases 的 YAML mapping")
    return payload


def run_fixture(path: str | Path) -> list[CaseResult]:
    fixture = load_fixture(path)
    return [run_case(case) for case in fixture["cases"]]


def run_case(case: dict[str, Any]) -> CaseResult:
    result = CaseResult(case_id=case["id"], title=case.get("title", ""))
    tmpdir = Path(tempfile.mkdtemp(prefix=f"golden-{case['id']}-"))
    try:
        envelopes = _case_envelopes(case)
        for envelope in envelopes:
            _write_envelope(tmpdir, envelope)
        expect = case.get("expect", {})
        try:
            batches = load_batches(tmpdir)
        except OdsFormatError as exc:
            if expect.get("rejected"):
                needle = expect.get("error_contains", "")
                if needle and needle not in str(exc):
                    result.failures.append(f"拒绝原因不含 {needle!r}: {exc}")
            else:
                result.failures.append(f"不应被拒绝: {exc}")
            result.passed = not result.failures
            return result
        if expect.get("rejected"):
            result.failures.append("期望格式拒绝，但批次被接受")
            result.passed = False
            return result

        state = build_dwd(batches)
        report = run_quality_checks(state)
        result.grade = report.grade
        result.score = report.score
        result.violations = sorted({v.rule_id for r in report.results for v in r.violations})
        _compare_quality(result, expect, report)
        _compare_revisions(result, expect, state)
        _compare_adjust(result, expect, state)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    result.passed = not result.failures
    return result


# --------------------------------------------------------------------------
# 质量/修订/复权断言
# --------------------------------------------------------------------------


def _compare_quality(result: CaseResult, expect: dict[str, Any], report: Any) -> None:
    if "grade" in expect and report.grade != expect["grade"]:
        result.failures.append(f"grade 期望 {expect['grade']} 实际 {report.grade}")
    if "blocked" in expect and report.blocked != expect["blocked"]:
        result.failures.append(f"blocked 期望 {expect['blocked']} 实际 {report.blocked}")
    if "violations" in expect:
        expected = sorted(expect["violations"])
        if result.violations != expected:
            result.failures.append(f"violations 期望 {expected} 实际 {result.violations}")
    if "score_min" in expect and report.score < expect["score_min"]:
        result.failures.append(f"score {report.score} < {expect['score_min']}")
    if "score_max" in expect and report.score > expect["score_max"]:
        result.failures.append(f"score {report.score} > {expect['score_max']}")


def _compare_revisions(result: CaseResult, expect: dict[str, Any], state: Any) -> None:
    if "revisions" not in expect:
        return
    expected = sorted(
        (
            {
                "field": item["field"],
                "revision": item["revision"],
                "old_value": item.get("old_value"),
                "new_value": item.get("new_value"),
            }
            for item in expect["revisions"]
        ),
        key=lambda item: (item["revision"], item["field"]),
    )
    actual = sorted(
        (
            {
                "field": rev.field,
                "revision": rev.revision,
                "old_value": rev.old_value,
                "new_value": rev.new_value,
            }
            for rev in state.revisions
        ),
        key=lambda item: (item["revision"], item["field"]),
    )
    if actual != expected:
        result.failures.append(f"revisions 期望 {expected} 实际 {actual}")


def _compare_adjust(result: CaseResult, expect: dict[str, Any], state: Any) -> None:
    if "hfq" not in expect and "qfq_first" not in expect:
        return
    instrument_id = next(iter(state.bars))[0]
    bars = state.bars_for(instrument_id)
    factors = {row["trade_date"]: row["factor"] for (iid, _), row in state.factors.items() if iid == instrument_id}
    if "hfq" in expect:
        adjusted = adjust_bars(bars, factors, "hfq")
        first, last = adjusted[0]["close"], adjusted[-1]["close"]
        want = expect["hfq"]
        if str(first) != want["first"] or str(last) != want["last"]:
            result.failures.append(f"hfq 期望 {want} 实际 first={first} last={last}")
    if "qfq_first" in expect:
        adjusted = adjust_bars(bars, factors, "qfq")
        if str(adjusted[0]["close"]) != expect["qfq_first"]:
            result.failures.append(f"qfq_first 期望 {expect['qfq_first']} 实际 {adjusted[0]['close']}")


# --------------------------------------------------------------------------
# fixture → ODS 批次信封
# --------------------------------------------------------------------------


def _source(as_of: datetime, fetched_at: datetime, name: str = "tushare") -> dict[str, str]:
    return {"source": name, "as_of": as_of.isoformat(), "fetched_at": fetched_at.isoformat()}


def _envelope(
    batch_id: str,
    endpoint: str,
    schema: str,
    source: dict[str, str],
    rows: list[dict[str, Any]],
    *,
    rows_total: int | None = None,
    rows_rejected: int = 0,
) -> dict[str, Any]:
    return {
        "batch_id": batch_id,
        "endpoint": endpoint,
        "schema": schema,
        "source": source,
        "rows_total": len(rows) if rows_total is None else rows_total,
        "rows_rejected": rows_rejected,
        "rows": rows,
    }


def _case_envelopes(case: dict[str, Any]) -> list[dict[str, Any]]:
    if "raw_batches" in case:
        return list(case["raw_batches"])

    case_id = case["id"].lower()
    instrument = dict(case["instrument"])
    iid = instrument["instrument_id"]
    bar_batches = case.get("batches")
    if bar_batches is None:
        bar_batches = [
            {
                "bars": case.get("bars", []),
                "factors": case.get("factors"),
                "suspended": case.get("suspended", []),
                "as_of": case.get("as_of"),
                "fetched_at": case.get("fetched_at"),
            }
        ]

    envelopes: list[dict[str, Any]] = []
    dim_as_of = parse_shanghai_datetime(
        case.get("as_of") or bar_batches[0].get("as_of") or _default_as_of(case),
        where=f"{case_id}.as_of",
    )
    dim_fetched = parse_shanghai_datetime(
        case.get("fetched_at") or bar_batches[0].get("fetched_at") or (dim_as_of + DEFAULT_FETCH_MARGIN).isoformat(),
        where=f"{case_id}.fetched_at",
    )
    envelopes.append(
        _envelope(
            f"{case_id}-dim",
            "instrument",
            "instrument.v1",
            _source(dim_as_of, dim_fetched),
            [instrument],
        )
    )

    for research in case.get("research_batches", []) or []:
        endpoint = research["endpoint"]
        if endpoint not in ENDPOINT_SCHEMAS:
            raise ValueError(f"{case_id}: research_batches endpoint 非法 {endpoint!r}")
        r_as_of = parse_shanghai_datetime(
            research.get("as_of") or case.get("as_of") or _default_as_of(case),
            where=f"{case_id}.research.{endpoint}.as_of",
        )
        r_fetched = parse_shanghai_datetime(
            research.get("fetched_at") or (r_as_of + DEFAULT_FETCH_MARGIN).isoformat(),
            where=f"{case_id}.research.{endpoint}.fetched_at",
        )
        envelopes.append(
            _envelope(
                f"{case_id}-{endpoint}",
                endpoint,
                ENDPOINT_SCHEMAS[endpoint],
                _source(r_as_of, r_fetched, research.get("source", "tushare")),
                list(research.get("rows", [])),
            )
        )

    for index, batch in enumerate(bar_batches, start=1):
        as_of = parse_shanghai_datetime(batch.get("as_of") or _default_as_of(case), where=f"{case_id}.batch{index}.as_of")
        fetched = parse_shanghai_datetime(
            batch.get("fetched_at") or (as_of + DEFAULT_FETCH_MARGIN).isoformat(),
            where=f"{case_id}.batch{index}.fetched_at",
        )
        source = _source(as_of, fetched, batch.get("source", "tushare"))

        rows = [{"instrument_id": iid, **bar} for bar in batch.get("bars", [])]
        for suspended_date in batch.get("suspended", []) or []:
            rows.append({"instrument_id": iid, "trade_date": suspended_date, "suspended": True})
        if rows:
            envelopes.append(_envelope(f"{case_id}-bar-{index}", "bar", "bar.v1", source, rows))

        factors = batch.get("factors")
        if factors is None:
            factors = [
                {"trade_date": bar["trade_date"], "factor": "1.0"} for bar in batch.get("bars", [])
            ]
        if factors:
            factor_rows = [{"instrument_id": iid, **row} for row in factors]
            envelopes.append(
                _envelope(f"{case_id}-factor-{index}", "adj_factor", "adj_factor.v1", source, factor_rows)
            )
    return envelopes


def _default_as_of(case: dict[str, Any]) -> str:
    """默认 as_of = 该用例最后一个 bar 的交易日 20:05（T 日收盘后取数）。"""
    dates: list[date] = []
    for batch in case.get("batches") or [{"bars": case.get("bars", [])}]:
        for bar in batch.get("bars", []):
            dates.append(parse_date(bar["trade_date"], where="fixture.bar.trade_date"))
        for suspended in batch.get("suspended", []) or []:
            dates.append(parse_date(suspended, where="fixture.suspended"))
    if not dates:
        return "2026-09-30T20:05:00+08:00"
    return f"{max(dates).isoformat()}T{DEFAULT_AS_OF_TIME.strftime('%H:%M')}:00+08:00"


def _write_envelope(root: Path, envelope: dict[str, Any]) -> None:
    endpoint = envelope.get("endpoint")
    if endpoint not in ENDPOINT_SCHEMAS:
        raise ValueError(f"fixture 批次 endpoint 非法: {endpoint!r}")
    rows = envelope.get("rows") or []
    dt = None
    for row in rows:
        if isinstance(row, dict):
            stamp = (
                row.get("trade_date")
                or row.get("report_end_date")
                or row.get("snapshot_date")
            )
            if stamp:
                dt = str(stamp)[:10]
                break
    dt = dt or "1970-01-01"
    target = root / endpoint / f"dt={dt}" / f"{envelope.get('batch_id', 'batch')}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
