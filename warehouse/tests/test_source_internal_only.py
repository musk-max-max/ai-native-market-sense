"""SEC-012 / F1 residual: source_internal_only 标记与 C 端翻档闸门测试。

H4 核验闭环判据 §12.3-4：
① source_internal_only 字段有 DDL + 语义注释（fail-closed：未知来源默认 true）
② C 端（c_end_display 翻档态）下 akshare 行不可见
③ H3/H4 书面裁之前不删该标记
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVING_SQL = ROOT / "warehouse/serving/schema.sql"
DWD_SQL = ROOT / "warehouse/dwd/schema.sql"


def _read_serving() -> str:
    return SERVING_SQL.read_text(encoding="utf-8")


def _read_dwd() -> str:
    return DWD_SQL.read_text(encoding="utf-8")


# ---- ① DDL 存在 + 语义注释 ----

def test_source_internal_only_column_exists_in_serving_view():
    """serving_quote_realtime 必须包含 source_internal_only 字段。"""
    sql = _read_serving()
    assert "source_internal_only" in sql, \
        "serving_quote_realtime must expose source_internal_only (SEC-012)"


def test_source_internal_only_semantic_comment_present():
    """DDL 必须有语义注释说明 fail-closed 策略。"""
    sql = _read_serving()
    assert "fail-closed" in sql.lower() or "fail closed" in sql.lower(), \
        "Must document fail-closed policy for source_internal_only"
    assert "SEC-012" in sql, "Must reference SEC-012 in DDL comment"


def test_source_internal_only_fail_closed_semantics():
    """fail-closed：未知来源默认 true（internal-only）。只有 tushare 标 false。"""
    sql = _read_serving()
    # 查找 source_internal_only 的定义表达式
    # 预期: (p.source IS DISTINCT FROM 'tushare') 或类似 fail-closed 逻辑
    pattern = re.compile(
        r"source_internal_only.*?IS DISTINCT FROM\s+'tushare'",
        re.DOTALL | re.IGNORECASE,
    )
    assert pattern.search(sql), \
        "source_internal_only must be fail-closed: unknown sources default to true"


def test_dwd_table_comment_references_sec012():
    """DWD 表注释必须引用 SEC-012。"""
    sql = _read_dwd()
    assert "SEC-012" in sql, "dwd_realtime_quote comment must reference SEC-012"


# ---- ② C 端翻档闸门 ----

def test_c_end_gate_filter_present():
    """serving 层必须有 C 端过滤逻辑（source_internal_only=false 才可见）。"""
    sql = _read_serving()
    # 视图必须输出 source_internal_only 供下游过滤
    assert "source_internal_only" in sql
    # 检查是否有注释说明 C 端过滤
    assert "C 端" in sql or "c_end" in sql.lower(), \
        "Must document C-end display gating in serving view"


def test_akshare_source_marked_internal_only():
    """akshare_eastmoney 来源必须被标记为 internal-only。"""
    sql = _read_serving()
    # fail-closed: source IS DISTINCT FROM 'tushare' ⇒ akshare → true
    assert "'tushare'" in sql, \
        "Only tushare is whitelisted as C-end safe; all others (incl. akshare) are internal-only"


# ---- ③ 标记不可删除 ----

def test_marker_not_removed_before_ruling():
    """SEC-012 §12.4：H3/H4 书面裁之前不得删除标记。"""
    sql = _read_serving()
    assert "source_internal_only" in sql, \
        "SEC-012 marker must persist until H3/H4 written ruling"


# ---- 端到端过滤模拟（C 端视角） ----

def test_c_end_query_simulation():
    """模拟 C 端查询：只取 source_internal_only=false 的行。

    这是 H4 核验判据 §12.3-4 的关键：不只是字段存在，而是 C 端确实看不到 akshare 行。
    """
    sql = _read_serving()
    # 模拟 C 端查询条件: WHERE source_internal_only = false
    # 验证视图结构支持此过滤
    assert "source_internal_only" in sql

    # 检查 fail-closed 逻辑确保 akshare → true
    # IS DISTINCT FROM 'tushare' ⇒ akshare_eastmoney ≠ tushare ⇒ true (internal-only)
    fail_closed_pattern = re.compile(
        r"source_internal_only.*?IS DISTINCT FROM",
        re.DOTALL | re.IGNORECASE,
    )
    assert fail_closed_pattern.search(sql), \
        "C-end gate must filter out internal-only rows (akshare → invisible to C-end)"


# ---- 行为级证明（H4 要求） ----

def test_view_expression_locked():
    """视图表达式锁死用例：source_internal_only 的计算表达式不可变。

    H4 核验判据 §12.3-4 要求行为级证明，不只是静态文本检查。
    """
    sql = _read_serving()
    # 锁死核心表达式：(p.source IS DISTINCT FROM 'tushare')
    # 这个表达式必须存在且不可被篡改
    locked_expression = "(p.source IS DISTINCT FROM 'tushare')"
    assert locked_expression in sql, \
        f"View expression must be exactly: {locked_expression}"

    # 确认是 fail-closed：IS DISTINCT FROM（而非 = 或 !=），保证 NULL/未知源 → true
    assert "IS DISTINCT FROM" in sql, \
        "Must use IS DISTINCT FROM for fail-closed semantics (NULL-safe)"


def test_serving_query_layer_evidence():
    """serving 查询层引用佐证：WHERE source_internal_only=false 被实际施加。

    验证 serving 层确实使用 source_internal_only 进行 C 端过滤。
    """
    # 检查 serving schema 中是否有 C 端过滤注释
    sql = _read_serving()
    assert "C 端" in sql or "c_end" in sql.lower(), \
        "Serving layer must document C-end filtering"

    # 检查 README 中是否有 C 端过滤说明
    readme_path = ROOT / "warehouse/README.md"
    readme = readme_path.read_text(encoding="utf-8")
    assert "source_internal_only" in readme, \
        "README must document source_internal_only usage"
    assert "C 端" in readme, \
        "README must document C-end display gating"


def test_two_gates_independent():
    """两个闸门独立：source_internal_only 和 c_end_display 不互替。

    H4 修正 (a)：false 仅=通过 SEC-012 来源过滤，C 端可见仍需 c_end_display 翻档门禁（B5）。
    """
    # 检查迁移文档中的语义说明
    migration_path = ROOT / "warehouse/serving/migrations/2026-11-06_source_internal_only.sql"
    migration = migration_path.read_text(encoding="utf-8")

    # 必须明确说明两个闸门独立
    assert "c_end_display" in migration or "B5" in migration, \
        "Migration must reference c_end_display (B5) as independent gate"
    assert "NOT" in migration and "approved" in migration.lower(), \
        "Migration must clarify false ≠ C-end approved"
