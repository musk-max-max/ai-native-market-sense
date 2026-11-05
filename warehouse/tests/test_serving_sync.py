"""Serving 端口契约与 view/README 必须同源：ports.yaml ↔ serving/schema.sql ↔ README。"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
PORTS = ROOT / "warehouse/serving/ports.yaml"
SERVING_SQL = ROOT / "warehouse/serving/schema.sql"
README = ROOT / "warehouse/README.md"

VIEW = re.compile(r"CREATE OR REPLACE VIEW serving\.(\w+) AS", re.M)


def ports() -> dict:
    return yaml.safe_load(PORTS.read_text(encoding="utf-8"))


def schema_views() -> set[str]:
    return set(VIEW.findall(SERVING_SQL.read_text(encoding="utf-8")))


def test_ports_yaml_is_valid_and_owned_by_a2():
    data = ports()
    assert data["version"] == 1
    assert data["owner"] == "A2"
    assert data["status"].startswith("draft_for_review")
    assert data["consumers"] == ["a3-backend-market"]


RESEARCH_VIEWS = {
    "serving_research_daily_basic",
    "serving_research_index_daily",
    "serving_research_top_list",
    "serving_research_top_inst",
    "serving_research_moneyflow",
    "serving_research_margin",
    "serving_research_hk_hold",
    "serving_research_stk_limit",
    "serving_research_fina_indicator",
    "serving_research_index_classify",
    "serving_research_index_member_all",
}


def test_every_ports_view_exists_in_schema_sql():
    declared = {view["name"] for view in ports()["views"]}
    assert declared == {
        "serving_instrument",
        "serving_quote_latest",
        "serving_bar_daily",
        "serving_factor_latest",
        "serving_fundamental_summary",
    }
    # 研究数据集视图只供内部消费，不进入 C 端 ports.yaml（KD-INGEST-CONSUME 边界）
    assert schema_views() == declared | RESEARCH_VIEWS, declared ^ schema_views()


def test_every_view_has_a_method_and_vice_versa():
    data = ports()
    view_methods = {view["method"] for view in data["views"]}
    method_names = {method["name"] for method in data["methods"]}
    assert view_methods == method_names
    assert len(method_names) == 5


def test_research_views_are_documented_but_not_in_ports():
    text = README.read_text(encoding="utf-8")
    for view in RESEARCH_VIEWS:
        assert f"serving.{view}" in text, view
    declared = {view["name"] for view in ports()["views"]}
    assert declared.isdisjoint(RESEARCH_VIEWS)
    assert "不接 C 端契约" in text or "不接 C 端" in text


def test_readme_documents_all_serving_views_and_repo():
    text = README.read_text(encoding="utf-8")
    for view in ports()["views"]:
        assert f"serving.{view['name']}" in text, view["name"]
    assert "ServingRepo" in text
    assert "serving/schema.sql" in text
    for method in ports()["methods"]:
        assert method["name"] in text, method["name"]


def test_ports_fixes_price_caliber_and_states():
    data = ports()
    semantics = data["semantics"]
    # 读侧不得自己算复权价：三口径由 serving view 固化
    assert "三口径价格" in semantics["prices"]
    assert "不提供按 instrument 聚合" in data["forbidden"][1] or any(
        "聚合" in item for item in data["forbidden"]
    )
    # 三态必须显式：有行情 / 停牌 / 无数据
    quote = next(m for m in data["methods"] if m["name"] == "getQuote")
    assert "suspended=true" in quote["three_state"]
    # 404 语义对齐 contracts/shared 0.1.2：标的不存在 vs 存在但无数据
    codes = {error["code"] for error in data["errors"]}
    assert {"INSTRUMENT_NOT_FOUND", "NOT_FOUND"} <= codes
    assert "NOT_FOUND" in quote["three_state"]


def test_schema_exposes_serving_schema_and_staleness():
    sql = SERVING_SQL.read_text(encoding="utf-8")
    assert "CREATE SCHEMA IF NOT EXISTS serving;" in sql
    assert sql.count("staleness_ms") >= 5
    # 停牌时价格不得为 0：三态用 NULL 表达
    assert "CASE WHEN p.suspended THEN NULL ELSE p.close END" in sql


def test_market_segment_not_exposed_to_c_end():
    # market_segment 是内部 canonical（BSE 精选层语义），不得进 C 端契约/serving 响应。
    repo_root = Path(__file__).resolve().parents[2]
    serving_sql = (repo_root / "warehouse/serving/schema.sql").read_text(encoding="utf-8")
    ports = (repo_root / "warehouse/serving/ports.yaml").read_text(encoding="utf-8")
    assert "market_segment" not in serving_sql, "serving view 不得透出 market_segment"
    assert "market_segment" not in ports, "ServingRepo 端口不得透出 market_segment"
