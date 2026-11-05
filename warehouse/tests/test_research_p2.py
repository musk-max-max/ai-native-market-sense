"""KD-DSW-P2：第 2 批研究数据集（stk_limit/fina_indicator/index_classify/
index_member_all）ODS→DWD→质量→serving 的链路校验。

测试数据使用真实代码空间（A 股 6 位代码、申万行业码、真实报告期），
不使用 A 股标识冒充其他资产（H4 KD-RES-FIX 教训）。
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from warehouse.dwd.build import build_dwd
from warehouse.load import RESEARCH_TABLES, build_statements
from warehouse.ods.loader import (
    ENDPOINT_SCHEMAS,
    RESEARCH_ENDPOINTS,
    Batch,
    SourceRef,
    load_ods_roots,
)
from warehouse.quality.checks import load_config, run_quality_checks

ROOT = Path(__file__).resolve().parents[2]
SERVING_SQL = ROOT / "warehouse/serving/schema.sql"
README = ROOT / "warehouse/README.md"
PORTS = ROOT / "warehouse/serving/ports.yaml"
A1_SMOKE = ROOT / "services/ingest/var/research-ods-smoke/internal"
CST = timezone(timedelta(hours=8))
AS_OF = datetime(2024, 1, 2, 20, 5, tzinfo=CST)
FETCHED_AT = datetime(2024, 1, 2, 20, 6, tzinfo=CST)
SNAPSHOT_AS_OF = datetime(2024, 1, 3, 20, 5, tzinfo=CST)

TABLE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\);", re.S)
COLUMN = re.compile(r"^\s{4}([a-z][a-z0-9_]*)\s+\S", re.M)

D = Decimal

INSTRUMENTS = [
    {
        "instrument_id": "SSE:600519",
        "exchange": "SSE",
        "code": "600519",
        "name": "贵州茅台",
        "board": "main",
        "security_type": "stock",
        "list_status": "listed",
        "lot_size": 100,
        "listed_at": date(2001, 8, 27),
    },
    {
        "instrument_id": "SSE:600036",
        "exchange": "SSE",
        "code": "600036",
        "name": "招商银行",
        "board": "main",
        "security_type": "stock",
        "list_status": "listed",
        "lot_size": 100,
        "listed_at": date(2002, 4, 9),
    },
]

STK_LIMIT = [
    {
        "instrument_id": "SSE:600519",
        "trade_date": date(2024, 1, 2),
        "previous_close": D("10.00"),
        "up_limit": D("11.00"),
        "down_limit": D("9.00"),
        "limit_pct": D("10.0"),
        "limit_pct_source": "exchange_price_ratio",
        "limit_pct": D("10.0"),
        "limit_pct_source": "exchange_price_ratio",
        "asset_type": "stock",
        "exchange": "SSE",
    },
    {
        "instrument_id": "SSE:600036",
        "trade_date": date(2024, 1, 2),
        "previous_close": D("30.00"),
        "up_limit": D("33.00"),
        "down_limit": D("27.00"),
        "asset_type": "stock",
        "exchange": "SSE",
    },
]

FINA = [
    {
        "instrument_id": "SSE:600519",
        "report_period": "2023Q4",
        "report_end_date": date(2023, 12, 31),
        "announced_at": date(2024, 4, 2),
        "update_flag": "1",
        "eps": D("49.9300"),
        "roe": D("34.1900"),
        "bps": D("190.8400"),
    },
    {
        "instrument_id": "SSE:600519",
        "report_period": "2024Q1",
        "report_end_date": date(2024, 3, 31),
        "announced_at": date(2024, 4, 29),
        "update_flag": "1",
        "eps": D("12.5000"),
        "roe": D("8.5000"),
        "bps": D("203.0000"),
    },
]

INDEX_CLASSIFY = [
    {
        "index_code": "801010",
        "industry_name": "农林牧渔",
        "parent_code": None,
        "level": "1",
        "industry_code": "801010",
        "is_published": "Y",
        "classification_source": "SW2021",
        "snapshot_date": date(2024, 1, 3),
    },
    {
        "index_code": "801011",
        "industry_name": "林业",
        "parent_code": "801010",
        "level": "2",
        "industry_code": "801011",
        "is_published": "Y",
        "classification_source": "SW2021",
        "snapshot_date": date(2024, 1, 3),
    },
    {
        "index_code": "80101101",
        "industry_name": "林业Ⅲ",
        "parent_code": "801011",
        "level": "3",
        "industry_code": "80101101",
        "is_published": "Y",
        "classification_source": "SW2021",
        "snapshot_date": date(2024, 1, 3),
    },
]

INDEX_MEMBER = [
    {
        "instrument_id": "SSE:600519",
        "name": "贵州茅台",
        "l1_code": "801120",
        "l1_name": "食品饮料",
        "l2_code": "801121",
        "l2_name": "白酒Ⅱ",
        "l3_code": "80112101",
        "l3_name": "白酒Ⅲ",
        "in_date": date(2020, 1, 1),
        "out_date": None,
        "is_new": "Y",
        "snapshot_date": date(2024, 1, 3),
    },
    {
        "instrument_id": "SSE:600036",
        "name": "招商银行",
        "l1_code": "801780",
        "l1_name": "银行",
        "l2_code": "801781",
        "l2_name": "银行Ⅱ",
        "l3_code": "80178101",
        "l3_name": "银行Ⅲ",
        "in_date": date(2019, 1, 1),
        "out_date": date(2023, 6, 30),
        "is_new": "N",
        "snapshot_date": date(2024, 1, 3),
    },
]


def _batch(endpoint: str, rows: list[dict], *, as_of: datetime = AS_OF) -> Batch:
    return Batch(
        batch_id=f"ing-test-{endpoint}",
        endpoint=endpoint,
        schema=ENDPOINT_SCHEMAS[endpoint],
        source=SourceRef(source="tushare.research.fixture", as_of=as_of, fetched_at=as_of + timedelta(minutes=1)),
        rows_total=len(rows),
        rows_rejected=0,
        rows=rows,
    )


def good_batches() -> list[Batch]:
    return [
        _batch("instrument", INSTRUMENTS),
        _batch("stk_limit", STK_LIMIT),
        _batch("fina_indicator", FINA, as_of=datetime(2024, 4, 30, 20, 5, tzinfo=CST)),
        _batch("index_classify", INDEX_CLASSIFY, as_of=SNAPSHOT_AS_OF),
        _batch("index_member_all", INDEX_MEMBER, as_of=SNAPSHOT_AS_OF),
    ]


@pytest.fixture()
def state():
    return build_dwd(good_batches())


# --------------------------------------------------------------------------
# loader 注册
def test_four_new_endpoints_are_registered():
    for endpoint in ("stk_limit", "fina_indicator", "index_classify", "index_member_all"):
        assert endpoint in ENDPOINT_SCHEMAS
        assert endpoint in RESEARCH_ENDPOINTS


def test_fina_report_period_survives_normalizer():
    """patterns 字段（report_period）必须落键——曾因 normalizer 只校验不输出而丢失主键。"""
    from warehouse.ods.loader import normalize_research_row

    row = normalize_research_row(
        "fina_indicator.v1",
        {
            "instrument_id": "SSE:600519",
            "report_period": "2023Q4",
            "report_end_date": "2023-12-31",
            "announced_at": "2024-04-02",
            "eps": "49.93",
        },
        where="test",
    )
    assert row["report_period"] == "2023Q4"
    assert row["eps"] == D("49.93")


@pytest.mark.skipif(not A1_SMOKE.is_dir(), reason="A1 research-ods-smoke 未生成")
def test_reads_a1_smoke_root_with_all_eleven_endpoints():
    batches = load_ods_roots(A1_SMOKE)
    endpoints = {batch.endpoint for batch in batches}
    assert set(ENDPOINT_SCHEMAS) - {"bar", "adj_factor", "instrument", "fundamental"} == endpoints
    state = build_dwd(batches)
    assert state.unmodeled_research == set()
    assert len(state.stk_limit) == 1
    assert len(state.fina_indicator) == 1


# --------------------------------------------------------------------------
# DWD 建模
def test_dwd_tables_and_keys(state):
    assert len(state.stk_limit) == 2
    assert ("SSE:600519", date(2024, 1, 2)) in state.stk_limit
    assert len(state.fina_indicator) == 2
    assert ("SSE:600519", "2023Q4") in state.fina_indicator
    fina = state.fina_indicator[("SSE:600519", "2023Q4")]
    assert fina["announced_at"] == date(2024, 4, 2)
    assert fina["eps"] == D("49.93")
    assert len(state.index_classify) == 3
    assert len(state.index_member_all) == 2


def test_snapshot_date_from_envelope_as_of(state):
    """快照类行内没有 trade_date：snapshot_date = 信封 as_of 的日期（A1 dt=运行日）。"""
    assert {row["snapshot_date"] for row in state.index_classify.values()} == {date(2024, 1, 3)}
    assert {row["snapshot_date"] for row in state.index_member_all.values()} == {date(2024, 1, 3)}


def test_index_member_keeps_point_in_time_fields(state):
    """H4：禁止只存最新快照——in_date/out_date/is_new 必须保留。"""
    row = next(r for r in state.index_member_all.values() if r["instrument_id"] == "SSE:600036")
    assert row["in_date"] == date(2019, 1, 1)
    assert row["out_date"] == date(2023, 6, 30)
    assert row["is_new"] == "N"


def test_unmodeled_endpoints_are_surfaced(monkeypatch):
    """已注册但未建模的 endpoint 不得静默丢弃（新 endpoint 先注册、后建模的过渡期）。"""
    import warehouse.dwd.build as build

    monkeypatch.setattr(build, "RESEARCH_VALUE_FIELDS", {k: v for k, v in build.RESEARCH_VALUE_FIELDS.items() if k != "index_classify"})
    state = build_dwd([_batch("index_classify", INDEX_CLASSIFY, as_of=SNAPSHOT_AS_OF)])
    assert state.unmodeled_research == {"index_classify"}


# --------------------------------------------------------------------------
# 质量规则 RES-05..08
def test_good_p2_data_is_green(state):
    report = run_quality_checks(state)
    assert report.blocked is False
    assert report.grade == "green"
    assert report.score == 100.0


def _flags(report, rule_id):
    return [v for rule in report.results if rule.rule_id == rule_id for v in rule.violations]


def test_res05_rejects_inconsistent_limit_prices():
    rows = [dict(STK_LIMIT[0])]
    rows[0].update({"up_limit": D("9.50"), "down_limit": D("9.00")})  # up < previous_close
    state = build_dwd([_batch("instrument", INSTRUMENTS), _batch("stk_limit", rows)])
    report = run_quality_checks(state)
    assert report.blocked is True
    assert _flags(report, "RES-05")


def test_res06_rejects_announcement_before_period_end():
    rows = [dict(FINA[0])]
    rows[0]["announced_at"] = date(2023, 12, 1)  # 报告期还没结束
    state = build_dwd(
        [_batch("instrument", INSTRUMENTS), _batch("fina_indicator", rows, as_of=datetime(2024, 4, 30, 20, 5, tzinfo=CST))]
    )
    report = run_quality_checks(state)
    assert _flags(report, "RES-06")


def test_res06_rejects_future_announcement():
    rows = [dict(FINA[0])]
    rows[0]["announced_at"] = date(2024, 5, 30)  # 晚于批次 as_of
    state = build_dwd(
        [_batch("instrument", INSTRUMENTS), _batch("fina_indicator", rows, as_of=datetime(2024, 4, 30, 20, 5, tzinfo=CST))]
    )
    report = run_quality_checks(state)
    assert _flags(report, "RES-06")


def test_res07_rejects_bad_level_and_parent():
    rows = [dict(INDEX_CLASSIFY[1])]
    rows[0]["parent_code"] = None  # level=2 缺 parent
    state = build_dwd([_batch("index_classify", rows, as_of=SNAPSHOT_AS_OF)])
    report = run_quality_checks(state)
    assert _flags(report, "RES-07")


def test_res08_rejects_out_before_in_and_new_with_out():
    rows = [dict(INDEX_MEMBER[0])]
    rows[0].update({"out_date": date(2019, 1, 1), "is_new": "Y"})  # out < in 且 is_new=Y
    state = build_dwd([_batch("index_member_all", rows, as_of=SNAPSHOT_AS_OF)])
    report = run_quality_checks(state)
    assert len(_flags(report, "RES-08")) >= 2


# --------------------------------------------------------------------------
# load.py 幂等 upsert
def test_load_statements_cover_four_new_tables(state):
    statements = build_statements(state)
    labels = {statement.label for statement in statements}
    for endpoint in ("stk_limit", "fina_indicator", "index_classify", "index_member_all"):
        assert f"upsert_{endpoint}" in labels
        table = RESEARCH_TABLES[endpoint][0]
        stmt = next(s for s in statements if s.label == f"upsert_{endpoint}")
        assert f"INSERT INTO {table}" in stmt.sql
        assert "ON CONFLICT" in stmt.sql


def test_load_columns_match_schema():
    tables = {name: set(COLUMN.findall(body)) for name, body in TABLE.findall((ROOT / "warehouse/dwd/schema.sql").read_text())}
    for endpoint, (table, columns, _pk, _attr) in RESEARCH_TABLES.items():
        assert set(columns) == tables[table], endpoint


# --------------------------------------------------------------------------
# serving 视图（internal-only，不进 ports.yaml）
def test_serving_views_exist_and_are_documented():
    schema = SERVING_SQL.read_text(encoding="utf-8")
    readme = README.read_text(encoding="utf-8")
    for view in (
        "serving_research_stk_limit",
        "serving_research_fina_indicator",
        "serving_research_index_classify",
        "serving_research_index_member_all",
    ):
        assert f"serving.serving_research_{view.removeprefix('serving_research_')}" in schema
        assert view in readme


def test_research_views_stay_out_of_c_end_ports():
    assert "serving_research" not in PORTS.read_text(encoding="utf-8")


def test_fina_view_exposes_announcement_time_not_report_end_for_join():
    sql = SERVING_SQL.read_text(encoding="utf-8")
    view = sql.split("serving_research_fina_indicator AS")[1].split(";")[0]
    assert "announced_at" in view


def test_stk_limit_limit_pct_is_passthrough_not_derived():
    """H4：limit_pct 由 A1 比值分档产出，A2 只透传；A2 不重复加工/不自行分档。"""
    state = build_dwd([_batch("instrument", INSTRUMENTS), _batch("stk_limit", STK_LIMIT)])
    row = state.stk_limit[("SSE:600519", date(2024, 1, 2))]
    assert row["limit_pct"] == D("10.00")
    assert row["limit_pct_source"] == "exchange_price_ratio"


def test_snapshot_coverage_is_propagated():
    """A1 _meta 的 coverage 必须落到 DWD，供消费方排除 current_snapshot_only。"""
    coverage = {
        ("index_member_all", "2024-01-03"): "current_snapshot_only",
        ("index_classify", "2024-01-03"): "full_history",
    }
    state = build_dwd(
        [_batch("index_member_all", INDEX_MEMBER, as_of=SNAPSHOT_AS_OF),
         _batch("index_classify", INDEX_CLASSIFY, as_of=SNAPSHOT_AS_OF)],
        research_coverage=coverage,
    )
    assert {r["coverage"] for r in state.index_member_all.values()} == {"current_snapshot_only"}
    assert {r["coverage"] for r in state.index_classify.values()} == {"full_history"}


def test_coverage_meta_file_reader(tmp_path):
    from warehouse.ods.loader import load_research_coverage

    meta = tmp_path / "_meta"
    meta.mkdir()
    (meta / "research_coverage.json").write_text(
        '{"datasets": {"index_member_all": {"coverage": "current_snapshot_only", "snapshot_date": "2026-11-04"}}}',
        encoding="utf-8",
    )
    assert load_research_coverage(tmp_path) == {("index_member_all", "2026-11-04"): "current_snapshot_only"}


def test_config_documents_new_rules():
    config = load_config()
    for rule_id in ("RES-05", "RES-06", "RES-07", "RES-08"):
        assert rule_id in config["rules"]
