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
from warehouse.ods.loader import OdsFormatError
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
        "revision_flag": "1",
        "eps": D("49.9300"),
        "roe": D("34.1900"),
        "bps": D("190.8400"),
    },
    {
        "instrument_id": "SSE:600519",
        "report_period": "2024Q1",
        "report_end_date": date(2024, 3, 31),
        "announced_at": date(2024, 4, 29),
        "revision_flag": "1",
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
    try:
        batches = load_ods_roots(A1_SMOKE)
    except OdsFormatError as exc:
        # A1 受控真实采样在途（新列/新批次 id），冒烟根是 A1 写域、结构由 A1 定稿；
        # 这里只做形状联调，不在 A2 测试里断言 A1 在途格式。
        pytest.skip(f"A1 research-ods-smoke 正在重生成，结构未定稿：{exc}")
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
    for rule_id in ("RES-05", "RES-06", "RES-07", "RES-08", "RES-09"):
        assert rule_id in config["rules"]
    assert config["rules"]["RES-09"]["severity"] == "warn"


# --------------------------------------------------------------------------
# H4 KD-RES-HARDEN：三条规则加固
def _quality(*, stk=None, classify=None, member=None):
    batches = [
        _batch("instrument", INSTRUMENTS),
        _batch("stk_limit", stk if stk is not None else STK_LIMIT),
        _batch("fina_indicator", FINA, as_of=datetime(2024, 4, 30, 20, 5, tzinfo=CST)),
        _batch("index_classify", classify if classify is not None else INDEX_CLASSIFY, as_of=SNAPSHOT_AS_OF),
        _batch("index_member_all", member if member is not None else INDEX_MEMBER, as_of=SNAPSHOT_AS_OF),
    ]
    return run_quality_checks(build_dwd(batches))


def _rules(report) -> list[str]:
    return [v.rule_id for v in report.blocker_violations]


def test_res_05_cross_checks_limit_pct_against_prices():
    """H4：质量层不能信 A1 透传的 limit_pct，必须用原始价独立交叉验证。"""
    stk = [dict(STK_LIMIT[0], limit_pct=D("20")), STK_LIMIT[1]]  # prev=10 up=11 → 10%，声明 20%
    report = _quality(stk=stk)
    assert "RES-05" in _rules(report)
    assert report.blocked and report.grade == "black"


def test_res_05_accepts_limit_pct_within_rounding_tolerance():
    # 10.05×1.05=10.5525 → up_limit 10.55 舍入，比值 4.975% 与 5% 差 0.025pp，应放行。
    stk = [
        {
            "instrument_id": "SSE:600519",
            "trade_date": date(2024, 1, 2),
            "previous_close": D("10.05"),
            "up_limit": D("10.55"),
            "down_limit": D("9.55"),
            "limit_pct": D("5"),
            "limit_pct_source": "exchange_price_ratio",
            "asset_type": "stock",
            "exchange": "SSE",
        }
    ] + [STK_LIMIT[1]]
    report = _quality(stk=stk)
    assert "RES-05" not in _rules(report)


def _stk_row(prev, up, down, pct, *, iid="SSE:600519", td=date(2024, 1, 2), exchange="SSE"):
    return {
        "instrument_id": iid,
        "trade_date": td,
        "previous_close": D(prev),
        "up_limit": D(up),
        "down_limit": D(down),
        "limit_pct": D(pct),
        "limit_pct_source": "exchange_price_ratio",
        "asset_type": "stock",
        "exchange": "SSE",
    }


def test_res_05_bse_920_rounding_truncates():
    """北交所 920xxx：涨停向下截断、跌停向上截断（A1 受控样本证据）。"""
    row = _stk_row("1.26", "1.63", "0.89", "30", iid="BSE:920001", exchange="BSE")
    report = _quality(stk=[row, {**STK_LIMIT[1], "instrument_id": "BSE:920001", "exchange": "BSE"}])
    assert "RES-05" not in _rules(report)


def test_res_05_bse_920_half_up_would_be_wrong():
    row = _stk_row("1.26", "1.64", "0.88", "30", iid="BSE:920001", exchange="BSE")
    report = _quality(stk=[row, {**STK_LIMIT[1], "instrument_id": "BSE:920001", "exchange": "BSE"}])
    assert "RES-05" in _rules(report)


# H4 2026-11-05 已签：沪市 B 股 900xxx 0.001 美元 half-up（41/41 命中），按「交易所+报价单位」启用。
def test_res_05_sse_b_share_3dp_rounding():  # pragma: no cover
    row = _stk_row("1.234", "1.357", "1.111", "10", iid="SSE:900901", exchange="SSE")
    assert "RES-05" not in _rules(_quality(stk=[row]))


# H4 2026-11-05 已签：深市 B 股 200xxx 0.01 港元 half-up（35/35 命中），按「交易所+报价单位」启用。
def test_res_05_szse_b_share_rounding():  # pragma: no cover
    row = _stk_row("1.23", "1.35", "1.11", "10", iid="SZSE:200002", exchange="SZSE")
    assert "RES-05" not in _rules(_quality(stk=[row]))


def test_res_05_low_price_rounding_135_is_valid():
    """prev=1.35、10% 档：交易所取整 up=1.49/down=1.22；候选档重算不得误伤（比值法会报 10.37%）。"""
    report = _quality(stk=[_stk_row("1.35", "1.49", "1.22", "10"), STK_LIMIT[1]])
    assert "RES-05" not in _rules(report)


def test_res_05_low_price_rounding_045_is_valid():
    """prev=0.45、10% 档：0.495 半入 → up=0.50，0.405 半入 → down=0.41。"""
    report = _quality(stk=[_stk_row("0.45", "0.50", "0.41", "10"), STK_LIMIT[1]])
    assert "RES-05" not in _rules(report)


def test_res_05_flags_wrong_rounding_at_low_price():
    # prev=1.35 声明 10% 档，但 up=1.48（错档/漏半入）→ blocker。
    report = _quality(stk=[_stk_row("1.35", "1.48", "1.22", "10"), STK_LIMIT[1]])
    assert "RES-05" in _rules(report)


def test_res_07_flags_parent_missing_in_same_snapshot():
    classify = [dict(r) for r in INDEX_CLASSIFY]
    classify[1] = dict(classify[1], parent_code="899999")
    report = _quality(classify=classify)
    assert "RES-07" in _rules(report)
    assert report.blocked


def test_res_07_flags_cross_level_parent():
    classify = [dict(r) for r in INDEX_CLASSIFY]
    classify[2] = dict(classify[2], parent_code="801010")  # L3 挂到 L1，跨层
    report = _quality(classify=classify)
    assert "RES-07" in _rules(report)


def test_res_07_flags_cycle():
    classify = [
        dict(INDEX_CLASSIFY[0]),
        dict(INDEX_CLASSIFY[1], index_code="A001", parent_code="B001"),
        dict(INDEX_CLASSIFY[1], index_code="B001", parent_code="A001"),
    ]
    report = _quality(classify=classify)
    assert "RES-07" in _rules(report)


def test_res_08_flags_new_n_without_out_date():
    member = [dict(INDEX_MEMBER[0]), dict(INDEX_MEMBER[1], out_date=None)]
    report = _quality(member=member)
    assert "RES-08" in _rules(report)


def test_res_09_warns_future_out_date_without_blocking():
    member = [dict(INDEX_MEMBER[0]), dict(INDEX_MEMBER[1], out_date=date(2025, 1, 1))]
    report = _quality(member=member)
    assert "RES-09" not in _rules(report)              # warn 不进 blocker
    assert report.violation_counts["warn"] >= 1
    assert not report.blocked and report.grade == "green"


def test_res_06_null_announced_at_is_blocker():
    fina = [dict(FINA[0], announced_at=None), FINA[1]]
    batches = [
        _batch("instrument", INSTRUMENTS),
        _batch("fina_indicator", fina, as_of=datetime(2024, 4, 30, 20, 5, tzinfo=CST)),
    ]
    report = run_quality_checks(build_dwd(batches))
    assert "RES-06" in _rules(report)
