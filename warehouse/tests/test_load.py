"""落库路径的单测：SQL builder / 参数绑定 / 质量门禁 / 执行计划。

本机没有 PostgreSQL：这里只验证"生成什么 SQL、绑定什么参数、门禁在哪个点拒绝"，
真实写库由 compose/CI 的 PG 执行（`PG_TEST_DSN` 集成测试，本机 skip）。
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
from datetime import date
from types import SimpleNamespace

import pytest

import warehouse.load as load
from warehouse.dwd.build import DwdState
from warehouse.tests.helpers import (
    bar_row,
    envelopes,
    factor_row,
    fundamental_row,
    instrument_row,
    state_from_envelopes,
)
from warehouse.tests.test_schema_sync import schema_tables

INSERT_RE = re.compile(r"INSERT INTO (\w+) \(([^)]*)\)", re.S)
CONFLICT_RE = re.compile(r"ON CONFLICT \(([^)]*)\)")


@pytest.fixture(autouse=True)
def _quality_report_path(tmp_path, monkeypatch):
    """契约 §2：报告默认写 /state/quality.json；单测全部重定向到 tmp，不碰宿主 /state。"""
    monkeypatch.setenv("QUALITY_REPORT_PATH", str(tmp_path / "state" / "quality.json"))


# --------------------------------------------------------------------------
# builder：列清单必须与 schema.sql 逐列一致
# --------------------------------------------------------------------------


def test_builder_columns_match_schema():
    tables = schema_tables()
    declared = {
        "dim_instrument": load.INSTRUMENT_COLUMNS,
        "dwd_stock_bar_daily": load.BAR_COLUMNS,
        "dwd_adj_factor": load.FACTOR_COLUMNS,
        "dwd_suspended_daily": load.SUSPENDED_COLUMNS,
        "dwd_fundamental_report": load.FUNDAMENTAL_COLUMNS,
        "dwd_bar_revision": load.REVISION_COLUMNS,
    }
    for table, columns in declared.items():
        assert set(columns) == tables[table], (table, set(columns) ^ tables[table])


def test_builder_primary_keys_match_schema():
    assert load.INSTRUMENT_PK == ("instrument_id",)
    assert load.BAR_PK == ("instrument_id", "trade_date")
    assert load.FACTOR_PK == ("instrument_id", "trade_date")
    assert load.SUSPENDED_PK == ("instrument_id", "trade_date")
    assert load.FUNDAMENTAL_PK == ("instrument_id", "report_period", "statement_basis")


def _full_state(tmp_path) -> DwdState:
    return state_from_envelopes(
        tmp_path,
        envelopes(
            bars=[
                bar_row(trade_date="2026-09-29"),
                bar_row(trade_date="2026-09-30"),
            ],
            factors=[
                factor_row(trade_date="2026-09-29"),
                factor_row(trade_date="2026-09-30"),
            ],
            fundamentals=[fundamental_row()],
        ),
    )


def test_statements_cover_all_tables_in_order(tmp_path):
    statements = load.build_statements(_full_state(tmp_path))
    labels = [s.label for s in statements]
    assert labels == [
        "upsert_instrument",
        "upsert_bar",
        "upsert_factor",
        "upsert_fundamental",
    ]


def test_placeholders_and_params_align(tmp_path):
    state = _full_state(tmp_path)
    for statement in load.build_statements(state):
        table, columns_text = INSERT_RE.search(statement.sql).groups()
        columns = [c.strip() for c in columns_text.split(",")]
        assert statement.sql.count("%s") == len(columns), table
        for params in statement.params:
            assert len(params) == len(columns), (statement.label, len(params), len(columns))


def test_upserts_are_idempotent_on_schema_pk(tmp_path):
    statements = {s.label: s for s in load.build_statements(_full_state(tmp_path))}
    bar = statements["upsert_bar"]
    assert CONFLICT_RE.search(bar.sql).group(1) == "instrument_id, trade_date"
    assert "DO UPDATE SET" in bar.sql and "close = EXCLUDED.close" in bar.sql
    fund = statements["upsert_fundamental"]
    assert CONFLICT_RE.search(fund.sql).group(1) == "instrument_id, report_period, statement_basis"


def test_revision_insert_is_conflict_only(tmp_path):
    # 两个批次：同日 bar 的 close/amount 被修正 → build 产生 2 条 revision
    from warehouse.dwd.build import build_dwd
    from warehouse.golden_runner import _envelope, _write_envelope
    from warehouse.ods.loader import load_batches

    root = tmp_path / "ods"
    first_src = {"source": "tushare", "as_of": "2026-09-30T20:05:00+08:00", "fetched_at": "2026-09-30T20:06:00+08:00"}
    second_src = {"source": "tushare", "as_of": "2026-09-30T21:00:00+08:00", "fetched_at": "2026-09-30T21:01:00+08:00"}
    for envelope in envelopes(bars=[], factors=[]):
        _write_envelope(root, envelope)
    _write_envelope(root, _envelope("b-init", "bar", "bar.v1", first_src, [bar_row(trade_date="2026-09-30")]))
    _write_envelope(root, _envelope("b-rev", "bar", "bar.v1", second_src,
                                    [bar_row(trade_date="2026-09-30", close="10.40", amount="10400000.00")]))
    state = build_dwd(load_batches(root))
    assert {r.field for r in state.revisions} == {"close", "amount"}

    statements = {s.label: s for s in load.build_statements(state)}
    assert CONFLICT_RE.search(statements["insert_revision"].sql).group(1) == (
        "instrument_id, trade_date, revision, field"
    )
    assert "DO NOTHING" in statements["insert_revision"].sql


def test_values_are_bound_not_interpolated(tmp_path):
    evil = "贵州'; DROP TABLE dim_instrument; --"
    state = state_from_envelopes(
        tmp_path,
        envelopes(instrument=instrument_row(name=evil), bars=[bar_row()], factors=[factor_row()]),
    )
    statements = load.build_statements(state)
    instrument_stmt = next(s for s in statements if s.label == "upsert_instrument")
    assert evil not in instrument_stmt.sql
    assert evil in instrument_stmt.params[0]
    for statement in statements:
        assert "DROP TABLE" not in statement.sql


def test_suspended_evidence_deletes_same_key_bar(tmp_path):
    state = state_from_envelopes(
        tmp_path, envelopes(bars=[bar_row(trade_date="2026-09-29", suspended=True)])
    )
    statements = load.build_statements(state)
    labels = [s.label for s in statements]
    assert "delete_suspended_bars" in labels and "upsert_bar" not in labels
    delete = next(s for s in statements if s.label == "delete_suspended_bars")
    assert "DELETE FROM dwd_stock_bar_daily" in delete.sql
    assert delete.params == [("SSE:600519", date(2026, 9, 29))]


# --------------------------------------------------------------------------
# 质量门禁：red / black / blocked 一律拒绝
# --------------------------------------------------------------------------


def test_gate_allows_green_and_yellow():
    assert load.gate_reason(SimpleNamespace(score=100.0, grade="green", blocked=False)) is None
    assert load.gate_reason(SimpleNamespace(score=92.0, grade="yellow", blocked=False)) is None


@pytest.mark.parametrize(
    "grade,blocked",
    [("red", False), ("black", False), ("black", True), ("green", True)],
)
def test_gate_refuses_red_black_and_blocked(grade, blocked):
    reason = load.gate_reason(SimpleNamespace(score=80.0, grade=grade, blocked=blocked))
    assert reason and grade in reason


def test_cli_refuses_bad_quality_before_connecting(tmp_path, capsys, monkeypatch):
    # high < low → STRUCT-03 blocker → black；必须退出 3 且完全不碰数据库
    bad = bar_row(high="9.00", low="9.90", close="9.50")
    envs = envelopes(bars=[bad], factors=[factor_row()])
    from warehouse.golden_runner import _write_envelope

    for envelope in envs:
        _write_envelope(tmp_path, envelope)

    def _boom(dsn):  # 若被调用说明门禁失效
        raise AssertionError("质量门禁拒绝时不允许连接数据库")

    monkeypatch.setattr(load, "_connect", _boom)
    code = load.main(["--ods-root", str(tmp_path)])
    assert code == load.EXIT_QUALITY_REFUSED
    err = capsys.readouterr().err
    assert "拒绝写库" in err and "STRUCT-03" in err
    report = json.loads((tmp_path / "state" / "quality.json").read_text(encoding="utf-8"))
    assert report["schema_version"] == 1
    assert report["level"] == "red"
    assert any("STRUCT-03" in reason for reason in report["reasons"])
    assert report["checked_at"].endswith("Z")


def test_cli_fails_closed_without_instrument_master(tmp_path, capsys, monkeypatch):
    envs = envelopes(instrument=None, bars=[bar_row()], factors=[factor_row()])
    from warehouse.golden_runner import _write_envelope

    for envelope in envs:
        _write_envelope(tmp_path, envelope)
    monkeypatch.setattr(load, "_connect", lambda dsn: (_ for _ in ()).throw(AssertionError("不应连接")))
    assert load.main(["--ods-root", str(tmp_path)]) == load.EXIT_INPUT_MISSING
    assert "instrument.v1" in capsys.readouterr().err


def test_cli_dry_run_builds_plan_without_dsn_or_connection(tmp_path, capsys, monkeypatch):
    envs = envelopes(bars=[bar_row()], factors=[factor_row()])
    from warehouse.golden_runner import _write_envelope

    for envelope in envs:
        _write_envelope(tmp_path, envelope)
    monkeypatch.setattr(load, "_connect", lambda dsn: (_ for _ in ()).throw(AssertionError("dry-run 不应连接")))
    monkeypatch.delenv("DSN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert load.main(["--ods-root", str(tmp_path), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "dry-run" in out and "upsert_bar" in out and "未连接数据库" in out


def test_cli_requires_dsn_when_writing(tmp_path, capsys, monkeypatch):
    envs = envelopes(bars=[bar_row()], factors=[factor_row()])
    from warehouse.golden_runner import _write_envelope

    for envelope in envs:
        _write_envelope(tmp_path, envelope)
    monkeypatch.delenv("DSN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert load.main(["--ods-root", str(tmp_path)]) == load.EXIT_ENV_ERROR
    assert "DSN" in capsys.readouterr().err
    report = json.loads((tmp_path / "state" / "quality.json").read_text(encoding="utf-8"))
    assert report["level"] == "green" and report["score"] == 1.0
    assert report["counts"]["dwd_rows"] >= 1 and report["counts"]["serving_rows"] >= 1
    assert report["reasons"] == []


# --------------------------------------------------------------------------
# 执行计划：单事务、executemany、计数
# --------------------------------------------------------------------------


class FakeCursor:
    def __init__(self):
        self.calls: list[tuple[str, list[tuple]]] = []
        self.closed = False

    def executemany(self, sql, params):
        self.calls.append((sql, list(params)))

    def close(self):
        self.closed = True


class FakeConn:
    def __init__(self):
        self.cursor_obj = FakeCursor()

    def cursor(self):
        return self.cursor_obj


def test_execute_statements_runs_plan_in_order(tmp_path):
    statements = load.build_statements(_full_state(tmp_path))
    conn = FakeConn()
    written = load.execute_statements(conn, statements)
    assert list(written) == [s.label for s in statements]
    assert [call[0] for call in conn.cursor_obj.calls] == [s.sql for s in statements]
    assert written["upsert_bar"] == 2


def test_psycopg_dependency_is_optional_for_builders():
    # builder/门禁不应 import psycopg：本机未安装驱动也能跑单测
    assert isinstance(load.build_statements(DwdState()), list)


# --------------------------------------------------------------------------
# 契约 §1/§2：退出码与 quality.json 证据
# --------------------------------------------------------------------------


def test_empty_ods_input_exits_3_without_report(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(load, "_connect", lambda dsn: (_ for _ in ()).throw(AssertionError("不应连接")))
    assert load.main(["--ods-root", str(tmp_path)]) == load.EXIT_INPUT_MISSING
    assert "输入为空" in capsys.readouterr().err
    assert not (tmp_path / "state" / "quality.json").exists()


def test_bad_manifest_evidence_exits_3(tmp_path, capsys, monkeypatch):
    from warehouse.golden_runner import _write_envelope

    envs = envelopes(bars=[bar_row()], factors=[factor_row()])
    for envelope in envs:
        _write_envelope(tmp_path, envelope)
    bad_manifest = tmp_path / "audit"
    bad_manifest.mkdir()
    (bad_manifest / "manifest.jsonl").write_text("{not json}\n", encoding="utf-8")
    monkeypatch.setattr(load, "_connect", lambda dsn: (_ for _ in ()).throw(AssertionError("不应连接")))
    code = load.main(["--ods-root", str(tmp_path), "--manifest-root", str(bad_manifest)])
    assert code == load.EXIT_INPUT_MISSING


def test_quality_report_write_failure_is_env_error(tmp_path, capsys, monkeypatch):
    from warehouse.golden_runner import _write_envelope

    envs = envelopes(bars=[bar_row()], factors=[factor_row()])
    for envelope in envs:
        _write_envelope(tmp_path, envelope)
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setenv("QUALITY_REPORT_PATH", str(blocker / "quality.json"))
    monkeypatch.setattr(load, "_connect", lambda dsn: (_ for _ in ()).throw(AssertionError("不应连接")))
    assert load.main(["--ods-root", str(tmp_path)]) == load.EXIT_ENV_ERROR
    assert "无法原子写质量报告" in capsys.readouterr().err


def test_quality_report_payload_shape_and_atomicity(tmp_path):
    from warehouse.quality.checks import run_quality_checks

    state = state_from_envelopes(tmp_path, envelopes(bars=[bar_row()], factors=[factor_row()]))
    report = run_quality_checks(state)
    payload = load.build_quality_report(report, state)
    assert payload["schema_version"] == 1
    assert payload["level"] in {"green", "yellow", "red"}
    assert 0.0 <= payload["score"] <= 1.0
    assert set(payload["counts"]) == {"dwd_rows", "serving_rows"}
    target = tmp_path / "nested" / "quality.json"
    load.write_quality_report(target, payload)
    assert json.loads(target.read_text(encoding="utf-8")) == payload
    assert not list(target.parent.glob(".quality-*.tmp"))


PG_AVAILABLE = importlib.util.find_spec("psycopg") is not None and bool(os.environ.get("PG_TEST_DSN"))


@pytest.mark.skipif(
    not PG_AVAILABLE,
    reason="需要真实 PG（compose/CI，PG_TEST_DSN）；本机无 PG，静态验证覆盖 builder/gate/plan",
)
def test_real_pg_roundtrip_idempotent(tmp_path):  # pragma: no cover - 只在 compose/CI 跑
    from pathlib import Path

    import psycopg

    schema = Path(__file__).resolve().parents[1] / "dwd" / "schema.sql"
    dsn = os.environ["PG_TEST_DSN"]
    envs = envelopes(bars=[bar_row()], factors=[factor_row()])
    from warehouse.golden_runner import _write_envelope

    for envelope in envs:
        _write_envelope(tmp_path, envelope)

    with psycopg.connect(dsn) as conn:
        conn.execute(schema.read_text(encoding="utf-8"))
        conn.commit()
        for _ in range(2):  # 同批次重放两次：幂等
            assert load.main(["--ods-root", str(tmp_path), "--dsn", dsn]) == 0
        bars = conn.execute("SELECT count(*) FROM dwd_stock_bar_daily").fetchone()[0]
        revisions = conn.execute("SELECT count(*) FROM dwd_bar_revision").fetchone()[0]
        assert bars == 1 and revisions == 0
