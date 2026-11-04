"""schema.sql 的列名是唯一真源：build.py 行结构 / Revision 字段必须与之一致。"""

from __future__ import annotations

import re
from dataclasses import fields
from pathlib import Path

from warehouse.dwd.build import Revision
from warehouse.tests.helpers import (
    bar_row,
    envelopes,
    factor_row,
    fundamental_row,
    state_from_envelopes,
)

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "warehouse/dwd/schema.sql"

TABLE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\);", re.S)
COLUMN = re.compile(r"^\s{4}([a-z][a-z0-9_]*)\s+\S", re.M)


def schema_tables() -> dict[str, set[str]]:
    text = SCHEMA.read_text(encoding="utf-8")
    return {name: set(COLUMN.findall(body)) for name, body in TABLE.findall(text)}


def test_six_tables_present():
    assert set(schema_tables()) == {
        "dwd_stock_bar_daily",
        "dwd_adj_factor",
        "dim_instrument",
        "dwd_bar_revision",
        "dwd_suspended_daily",
        "dwd_fundamental_report",
    }


def test_build_row_keys_match_schema(tmp_path):
    state = state_from_envelopes(
        tmp_path, envelopes(bars=[bar_row()], factors=[factor_row()])
    )
    tables = schema_tables()
    bar = next(iter(state.bars.values()))
    factor = next(iter(state.factors.values()))
    instrument = next(iter(state.instruments.values()))
    assert set(bar) == tables["dwd_stock_bar_daily"], (
        set(bar) ^ tables["dwd_stock_bar_daily"]
    )
    assert set(factor) == tables["dwd_adj_factor"]
    assert set(instrument) == tables["dim_instrument"]


def test_revision_fields_match_schema():
    assert {f.name for f in fields(Revision)} == schema_tables()["dwd_bar_revision"]


def test_suspended_rows_never_create_bars(tmp_path):
    # C08：停牌日不建行、不补 0；schema 无 suspended 列（停牌是"无行"而不是"有行=停牌"）
    assert "suspended" not in schema_tables()["dwd_stock_bar_daily"]


def test_suspended_evidence_row_matches_schema(tmp_path):
    # L8：停牌证据写入独立表 dwd_suspended_daily，列集合必须与内存行一致
    from datetime import date

    state = state_from_envelopes(
        tmp_path, envelopes(bars=[bar_row(trade_date="2026-09-29", suspended=True)])
    )
    row = next(iter(state.suspended_rows.values()))
    assert set(row) == schema_tables()["dwd_suspended_daily"]
    assert ("SSE:600519", date(2026, 9, 29)) in state.suspended


def test_fundamental_table_supports_both_statement_bases():
    # M06：reported/restated 两套并存，靠 (report_period, statement_basis) 区分，不得互相覆盖
    columns = schema_tables()["dwd_fundamental_report"]
    assert {"report_period", "statement_basis", "announced_at", "revenue", "net_profit"} <= columns


def test_fundamental_row_keys_match_schema(tmp_path):
    # M06：reported/restated 两套并存，行结构必须与 schema.sql 逐列一致
    state = state_from_envelopes(
        tmp_path,
        envelopes(
            fundamentals=[
                fundamental_row(),
                fundamental_row(statement_basis="restated", revenue="99000000.00"),
            ]
        ),
    )
    assert len(state.fundamentals) == 2
    row = next(iter(state.fundamentals.values()))
    assert set(row) == schema_tables()["dwd_fundamental_report"]
