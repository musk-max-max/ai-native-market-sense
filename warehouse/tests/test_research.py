"""KD-INGEST-CONSUME：7 个研究数据集 ODS→DWD→质量→serving 的链路校验。

fixture 由 A1 适配层（services/ingest/src/market_ingest/adapters/tushare/research.py）
的 map_row 生成后落盘（一次性生成器不入库），保证 A2 读取的形状与 A1 写入一致。
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
import yaml

from warehouse.dwd.build import RESEARCH_VALUE_FIELDS, build_dwd
from warehouse.load import build_statements
from warehouse.ods.loader import (
    ENDPOINT_SCHEMAS,
    Batch,
    OdsFormatError,
    SourceRef,
    ensure_research_origin,
    load_batches,
    load_ods_roots,
    write_batch,
)
from warehouse.quality.checks import load_config, run_quality_checks

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "warehouse/tests/fixtures/research_ods"
SERVING_SQL = ROOT / "warehouse/serving/schema.sql"
README = ROOT / "warehouse/README.md"
CST = timezone(timedelta(hours=8))
AS_OF = datetime(2024, 1, 3, 20, 5, tzinfo=CST)
FETCHED_AT = datetime(2024, 1, 3, 20, 6, tzinfo=CST)

TABLE_BY_ENDPOINT = {
    "daily_basic": "dwd_daily_basic",
    "index_daily": "dwd_index_daily",
    "top_list": "dwd_top_list",
    "top_inst": "dwd_top_inst",
    "moneyflow": "dwd_moneyflow",
    "margin": "dwd_margin",
    "hk_hold": "dwd_hk_hold",
}
TABLE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\);", re.S)
COLUMN = re.compile(r"^\s{4}([a-z][a-z0-9_]*)\s+\S", re.M)


def schema_tables() -> dict[str, set[str]]:
    text = (ROOT / "warehouse/dwd/schema.sql").read_text(encoding="utf-8")
    return {name: set(COLUMN.findall(body)) for name, body in TABLE.findall(text)}


def build_fixture_state():
    return build_dwd(load_ods_roots(FIXTURE))


def _batch(endpoint: str, rows: list[dict], *, batch_id: str | None = None, schema: str | None = None) -> Batch:
    return Batch(
        batch_id=batch_id or f"ing-test-{endpoint}",
        endpoint=endpoint,
        schema=schema or f"{endpoint}.v1",
        source=SourceRef(source="tushare.research.fixture", as_of=AS_OF, fetched_at=FETCHED_AT),
        rows_total=len(rows),
        rows_rejected=0,
        rows=rows,
    )


def _load_single(tmp_path: Path, endpoint: str, rows: list[dict]) -> list[Batch]:
    write_batch(tmp_path / "internal", _batch(endpoint, rows))
    return load_batches(tmp_path / "internal", origin="internal")


# --------------------------------------------------------------------------
# fixture 链路
# --------------------------------------------------------------------------


def test_loader_registers_eleven_endpoints():
    assert len(ENDPOINT_SCHEMAS) == 11
    for endpoint in TABLE_BY_ENDPOINT:
        assert ENDPOINT_SCHEMAS.get(endpoint) == f"{endpoint}.v1"


def test_fixture_batches_and_rows():
    state = build_fixture_state()
    assert len(state.instruments) == 2
    assert len(state.daily_basic) == 4
    assert len(state.index_daily) == 2
    assert len(state.top_list) == 1
    assert len(state.top_inst) == 2
    assert len(state.moneyflow) == 1
    assert len(state.margin) == 1
    assert len(state.hk_hold) == 2
    assert {row["northbound_channel"] for row in state.hk_hold.values()} == {"HK"}
    assert state.issues == []


def test_build_rows_match_schema_columns():
    state = build_fixture_state()
    tables = schema_tables()
    for endpoint, table in TABLE_BY_ENDPOINT.items():
        rows = getattr(state, endpoint).values()
        row = next(iter(rows))
        assert set(row) == tables[table], (endpoint, set(row) ^ tables[table])


def test_top_inst_and_margin_key_fields():
    state = build_fixture_state()
    for (iid, td, seat, side), row in state.top_inst.items():
        assert iid.startswith(("SSE:", "SZSE:"))
        assert seat and side in (0, 1)
        assert row["instrument_id"] == iid
    for (exchange, td), row in state.margin.items():
        assert exchange in ("SSE", "SZSE", "BSE")
        assert row["trade_date"] == td


def test_fixture_pipeline_is_green():
    state = build_fixture_state()
    report = run_quality_checks(state)
    assert report.grade == "green", report.as_dict()
    assert report.score == 100.0
    assert report.blocked is False


# --------------------------------------------------------------------------
# loader 校验（canonical 量纲/枚举/十进制字符串）
# --------------------------------------------------------------------------


def test_loader_rejects_json_float(tmp_path):
    rows = [{"instrument_id": "SSE:600519", "trade_date": "2024-01-02", "close": 1.5}]
    with pytest.raises(OdsFormatError, match="禁止 JSON float"):
        _load_single(tmp_path, "daily_basic", rows)


def test_loader_rejects_unknown_margin_exchange(tmp_path):
    rows = [
        {
            "exchange": "HK",
            "trade_date": "2024-01-02",
            "financing_balance": "1.0",
            "financing_buy_amount": "1.0",
            "financing_repayment_amount": "1.0",
            "securities_balance": "1.0",
            "securities_sell_volume": "1",
            "margin_balance": "1.0",
            "securities_volume": "1",
        }
    ]
    with pytest.raises(OdsFormatError, match="exchange"):
        _load_single(tmp_path, "margin", rows)


def test_loader_rejects_non_integer_volume(tmp_path):
    rows = [{"instrument_id": "SSE:600519", "trade_date": "2024-01-02", "buy_small_volume": "1.5"}]
    with pytest.raises(OdsFormatError, match="整数"):
        _load_single(tmp_path, "moneyflow", rows)


def test_loader_rejects_missing_trade_date(tmp_path):
    with pytest.raises(OdsFormatError, match="trade_date"):
        _load_single(tmp_path, "index_daily", [{"instrument_id": "SSE:000300", "close": "1.0"}])


def test_loader_rejects_tushare_field_leak(tmp_path):
    rows = [{"instrument_id": "SSE:600519", "trade_date": "2024-01-02", "close": "1.0", "ts_code": "600519.SH"}]
    with pytest.raises(OdsFormatError, match="数据源字段名"):
        _load_single(tmp_path, "daily_basic", rows)


def test_loader_allows_canonical_pe_names(tmp_path):
    rows = [{"instrument_id": "SSE:600519", "trade_date": "2024-01-02", "close": "1.0", "pe": "12.5"}]
    batches = _load_single(tmp_path, "daily_basic", rows)
    assert batches[0].rows[0]["pe"] == Decimal("12.5")


# --------------------------------------------------------------------------
# 质量规则 RES-01..04
# --------------------------------------------------------------------------


def _mutated_state():
    state = build_fixture_state()
    return state


def test_res01_weekend_row_blocks():
    state = _mutated_state()
    key = ("SSE:600519", date(2024, 1, 6))  # 周六
    row = dict(next(iter(state.daily_basic.values())))
    row.update({"instrument_id": key[0], "trade_date": key[1], "as_of": AS_OF})
    state.daily_basic[key] = row
    report = run_quality_checks(state)
    assert report.grade == "black" and report.blocked
    assert "RES-01" in {v.rule_id for v in report.blocker_violations}


def test_res02_negative_amount_blocks():
    state = _mutated_state()
    row = next(iter(state.moneyflow.values()))
    row["buy_small_amount"] = Decimal("-1")
    report = run_quality_checks(state)
    assert "RES-02" in {v.rule_id for v in report.blocker_violations}


def test_res02_absurd_percentage_blocks():
    state = _mutated_state()
    row = next(iter(state.daily_basic.values()))
    row["turnover_rate_pct"] = Decimal("12345")
    report = run_quality_checks(state)
    assert "RES-02" in {v.rule_id for v in report.blocker_violations}


def test_res03_unknown_instrument_blocks():
    state = _mutated_state()
    key = ("SSE:600999", date(2024, 1, 2))
    row = dict(next(iter(state.daily_basic.values())))
    row.update({"instrument_id": key[0], "trade_date": key[1], "as_of": AS_OF})
    state.daily_basic[key] = row
    report = run_quality_checks(state)
    assert "RES-03" in {v.rule_id for v in report.blocker_violations}


def test_res03_index_rows_are_exempt():
    state = _mutated_state()
    report = run_quality_checks(state)
    assert "RES-03" not in {v.rule_id for v in report.blocker_violations}


def test_res04_early_as_of_blocks():
    state = _mutated_state()
    row = next(iter(state.daily_basic.values()))
    row["as_of"] = datetime(2024, 1, 2, 14, 0, tzinfo=CST)  # 早于 15:00
    report = run_quality_checks(state)
    assert "RES-04" in {v.rule_id for v in report.blocker_violations}


def test_res03_hk_namespace_is_explicitly_exempted_and_counted():
    # H4 备案附注 3：港股不在 A 股 dim_instrument，不得靠 A 股样例混绿、也不许静默跳过
    state = build_fixture_state()
    assert {iid for iid, _ in state.hk_hold} == {"HKEX:00700", "HKEX:09988"}
    report = run_quality_checks(state)
    result = next(r for r in report.results if r.rule_id == "RES-03")
    assert result.exemptions == 2
    assert report.as_dict()["exemptions"] == {"RES-03": 2}
    assert "RES-03" not in {v.rule_id for v in report.blocker_violations}


def test_res03_ashare_hk_hold_id_is_still_fk_checked():
    # hk_hold 里若出现 A 股标识但不在 dim，仍按外键 blocker 处理（豁免只针对非 A 股命名空间）
    state = build_fixture_state()
    row = dict(next(iter(state.hk_hold.values())))
    row.update({"instrument_id": "SSE:600999", "trade_date": date(2024, 1, 2)})
    state.hk_hold[("SSE:600999", date(2024, 1, 2))] = row
    report = run_quality_checks(state)
    assert "RES-03" in {v.rule_id for v in report.blocker_violations}


def test_res04_hk_hold_requires_t_plus_1():
    # H4 备案附注 4：hk_hold 是 T+1 披露，as_of 必须 ≥ 次日 15:00；其它 A 股研究数据仍当日 15:00
    state = build_fixture_state()
    # 取 HKEX:09988（trade_date=2024-01-03）：T+1 阈值是 2024-01-04 15:00，当日 20:05 仍不够
    row = state.hk_hold[("HKEX:09988", date(2024, 1, 3))]
    row["as_of"] = datetime(2024, 1, 3, 20, 5, tzinfo=CST)
    report = run_quality_checks(state)
    assert "RES-04" in {v.rule_id for v in report.blocker_violations}

    state2 = build_fixture_state()
    row2 = next(iter(state2.daily_basic.values()))
    row2["as_of"] = datetime(2024, 1, 3, 20, 5, tzinfo=CST)  # A 股研究数据当日收盘后即合格
    report2 = run_quality_checks(state2)
    assert "RES-04" not in {v.rule_id for v in report2.blocker_violations}


def test_hk_hold_loader_accepts_hkex_namespace(tmp_path):
    rows = [
        {"instrument_id": "HKEX:00700", "trade_date": "2024-01-02", "name": "腾讯控股",
         "holding_volume": "100", "holding_ratio_pct": "1.0", "northbound_channel": "HK"}
    ]
    batches = _load_single(tmp_path, "hk_hold", rows)
    assert batches[0].rows[0]["instrument_id"] == "HKEX:00700"


def test_hk_hold_loader_rejects_bad_hkex_code(tmp_path):
    rows = [
        {"instrument_id": "HKEX:700", "trade_date": "2024-01-02", "name": "腾讯控股",
         "holding_volume": "100", "holding_ratio_pct": "1.0", "northbound_channel": "HK"}
    ]
    with pytest.raises(OdsFormatError, match="EXCH:CODE"):
        _load_single(tmp_path, "hk_hold", rows)


def test_research_in_display_root_rejected_in_prod(tmp_path):
    # H4 自签门禁：研究数据集不得进 display root，也不得参与 display_safe 派生
    write_batch(tmp_path / "display", _batch("daily_basic", [
        {"instrument_id": "SSE:600519", "trade_date": "2024-01-02", "close": "1688.00", "as_of": "2024-01-03T20:05:00+08:00"}
    ]))
    batches = load_ods_roots(tmp_path)
    assert all(batch.origin == "display" for batch in batches)
    with pytest.raises(OdsFormatError, match="display root"):
        ensure_research_origin(batches, profile="prod")
    assert ensure_research_origin(batches, profile="dev")  # dev 返回违规批次供告警


def test_research_display_root_pipeline_exit_nonzero(tmp_path):
    from warehouse import pipeline

    write_batch(tmp_path / "display", _batch("daily_basic", [
        {"instrument_id": "SSE:600519", "trade_date": "2024-01-02", "close": "1688.00", "as_of": "2024-01-03T20:05:00+08:00"}
    ]))
    rc = pipeline.main(["--ods-root", str(tmp_path), "--profile", "prod"])
    assert rc == 1


def test_research_rules_declared_in_config():
    config = load_config()
    for rid in ("RES-01", "RES-02", "RES-03", "RES-04"):
        assert config["rules"][rid]["severity"] == "blocker"
    # 每个研究表至少两条规则覆盖：RES-01/RES-02 全表、RES-03 股票级、RES-04 全表
    assert len(config["rules"]) == 18
    policies = config["research_as_of"]
    assert policies["hk_hold"] == {"offset_days": 1, "time": "15:00"}
    for endpoint in ("daily_basic", "index_daily", "top_list", "top_inst", "moneyflow", "margin"):
        assert policies[endpoint] == {"offset_days": 0, "time": "15:00"}


# --------------------------------------------------------------------------
# 落库语句与 serving 视图
# --------------------------------------------------------------------------


def test_load_statements_cover_all_research_tables():
    state = build_fixture_state()
    statements = build_statements(state)
    labels = [stmt.label for stmt in statements]
    for endpoint in TABLE_BY_ENDPOINT:
        assert f"upsert_{endpoint}" in labels, endpoint
    # 顺序：instrument → bar → ... → fundamental → research → revision
    assert labels.index("upsert_instrument") < labels.index("upsert_daily_basic")
    if "upsert_fundamental" in labels:  # fixture 无财务批次时该语句不出现
        assert labels.index("upsert_fundamental") < labels.index("upsert_daily_basic")
    assert labels.index("upsert_daily_basic") < labels.index("upsert_hk_hold")


def test_serving_research_views_exist_and_use_dwd_tables():
    text = SERVING_SQL.read_text(encoding="utf-8")
    for endpoint, table in TABLE_BY_ENDPOINT.items():
        view = f"serving.serving_research_{endpoint}"
        assert f"CREATE OR REPLACE VIEW {view} AS" in text, view
        assert f"FROM {table}" in text, table


def test_readme_documents_research_views_and_boundary():
    text = README.read_text(encoding="utf-8")
    for endpoint in TABLE_BY_ENDPOINT:
        assert f"serving.serving_research_{endpoint}" in text, endpoint
    assert "不接 C 端" in text
    assert "provisional" in text


def test_quality_summary_exposes_exemptions(capsys):
    # H4 收口 ①：豁免必须出现在质量运行摘要，不能只留在内部计数器
    from warehouse import pipeline

    rc = pipeline.main(["--ods-root", "warehouse/tests/fixtures/research_ods", "--profile", "dev"])
    out = capsys.readouterr()
    assert rc == 0
    assert "exemptions={'RES-03': 2}" in out.out


def test_load_summary_exposes_exemptions(capsys):
    from warehouse import load

    rc = load.main(["--ods-root", "warehouse/tests/fixtures/research_ods", "--profile", "dev", "--dry-run"])
    out = capsys.readouterr()
    assert rc == 0
    assert "exemptions={'RES-03': 2}" in out.out
