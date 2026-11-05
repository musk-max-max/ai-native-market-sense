"""文档即法规：docs/metrics/P0-metrics.md 与 SQL / 配置必须逐字节一致。

口径变更流程（roster 硬约束）：先改 docs 并获 H4 签字 → 再改 SQL。
本测试防止"只改 SQL 不改文档"或"文档贴的 SQL 与实现不同步"。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from warehouse.quality.checks import load_config

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "docs/metrics/P0-metrics.md"
REGISTRY = ROOT / "docs/metrics/p0_metrics.json"
SQL_DIR = ROOT / "warehouse/metrics"

FENCE = re.compile(r"```sql\n(.*?)```", re.S)
SECTION = re.compile(r"^## \d+\.\s+(M\d{2})\b", re.M)


def normalize(text: str) -> str:
    """归一化：去行尾空白、去首尾空行；其余字符必须完全一致。"""
    lines = [line.rstrip() for line in text.strip("\n").splitlines()]
    return "\n".join(lines).strip("\n")


def doc_sql_blocks() -> dict[str, str]:
    text = DOC.read_text(encoding="utf-8")
    headings = list(SECTION.finditer(text))
    blocks: dict[str, str] = {}
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        body = text[heading.end():end]
        match = FENCE.search(body)
        if match:
            blocks[heading.group(1)] = normalize(match.group(1))
    return blocks


def registry() -> dict:
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def test_doc_sql_matches_sql_files_byte_for_byte():
    blocks = doc_sql_blocks()
    assert set(blocks) == {"M01", "M02", "M04", "M08"}, set(blocks)
    for metric_id, doc_sql in blocks.items():
        entry = next(m for m in registry()["metrics"] if m["metric_id"] == metric_id)
        sql_path = ROOT / entry["sql_file"]
        assert sql_path.exists(), f"{metric_id} 的 {entry['sql_file']} 不存在"
        assert doc_sql == normalize(sql_path.read_text(encoding="utf-8")), (
            f"{metric_id}: docs/metrics/P0-metrics.md 内嵌 SQL 与 {entry['sql_file']} 不一致；"
            "先改文档并获 H4 签字，再改 SQL"
        )


def test_registry_covers_all_eight_metrics():
    metrics = registry()["metrics"]
    assert [m["metric_id"] for m in metrics] == ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08"]
    executable = [m for m in metrics if m["status"] == "executable"]
    pending = [m for m in metrics if m["status"] == "pending-data"]
    assert [m["metric_id"] for m in executable] == ["M01", "M02", "M04", "M08"]
    assert [m["metric_id"] for m in pending] == ["M03", "M05", "M06", "M07"]
    for entry in pending:
        assert entry["sql_file"] is None, f"{entry['metric_id']} 未落地不得挂 SQL"
    for entry in executable:
        assert (ROOT / entry["sql_file"]).exists(), entry["sql_file"]


def test_registry_quality_matches_executable_config():
    config = load_config()
    quality = registry()["quality"]
    assert quality["config"] == "warehouse/quality/quality_config.json"
    assert quality["weights"] == config["weights"]
    assert quality["thresholds"] == config["thresholds"]
    assert quality["blocker_blocks_downstream"] == config["blocker_blocks_downstream"]


def test_legislation_is_signed_by_h4_not_approved_by_agent():
    # 只有 H4（人类席位）能签字；A2 只能改状态与留痕，不能自批。
    sign = registry()["sign_off"]
    assert sign["status"] == "signed"
    assert "H4" in sign["approved_by"]
    assert sign["approved_at"] >= "2026-11-04"  # 2026-11-04 首签；M04/RES-05 于 2026-11-05 补签
    assert sign["conditions"], "会签必须带条件"
    assert any("前 5 个交易日" in c for c in sign["conditions"]), "补签条件缺注册制前 5 日"
    assert any("listed_at" in c for c in sign["conditions"]), "补签条件缺 listed_at 覆盖率"
    assert sign["note"] and "H4" in sign["note"]


def test_board_limits_in_doc_sql_match_config():
    config = load_config()
    sql = (SQL_DIR / "m04_limit_status.sql").read_text(encoding="utf-8")
    for board, pct in config["board_limit_pct"].items():
        assert f"'{board}'" in sql, f"M04 SQL 缺板块 {board}"
        assert str(pct) in sql, f"M04 SQL 缺板块 {board} 的 {pct}% 限制"
    assert str(config["st_limit_pct"]) in sql


def test_doc_lists_pending_metrics_and_p0_limits():
    text = DOC.read_text(encoding="utf-8")
    for metric_id in ["M03", "M05", "M06", "M07"]:
        assert metric_id in text
    assert "pending-data" in text
    assert "blocker" in text
    assert "待 H4" in text or "待确认" in text


def test_doc_has_h4_signoff_record():
    # 会签记录必须覆盖 8 条口径 + L3 + L9，并写明签字人/日期/条件引用
    text = DOC.read_text(encoding="utf-8")
    assert "## 8. H4 会签记录" in text and "已签" in text
    for metric_id in ["M01", "M02", "M04", "M08"]:
        assert metric_id in text
    assert "L3" in text and "L9" in text
    assert "签字栏（H4）" in text
    assert "sign_off.conditions" in text
    assert registry()["sign_off"]["status"] == "signed"


def test_m04_pre5d_and_sst_conditions_present():
    """H4 2026-11-05 补签条件：BIZ-01 文本、S*ST flag、listed_at 覆盖率诊断、首日缺失提示。"""
    from warehouse.quality.checks import is_st

    assert is_st({"name": "S*ST示例"}) is True
    sql = (SQL_DIR / "m04_limit_status.sql").read_text(encoding="utf-8")
    assert "S*ST%" in sql and "SST%" in sql, "st_by_current_name 必须覆盖 S*ST/SST"
    assert "窗口整体后移 1 日" in sql, "known_limitation 必须写明首日 bar 缺失的后果"
    assert (SQL_DIR / "m04_listed_at_coverage.sql").is_file(), "缺 listed_at 覆盖率诊断 SQL"
    coverage = (SQL_DIR / "m04_listed_at_coverage.sql").read_text(encoding="utf-8")
    assert "pct_bars_missing_listed_at" in coverage and "dwd_stock_bar_daily" in coverage
    from warehouse.quality.checks import RULE_META

    assert "前 5 个交易日不判" in RULE_META["BIZ-01"][1]
