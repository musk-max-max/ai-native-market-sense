"""ODS → DWD → PostgreSQL 落库（P0：A2 唯一写库路径）。

设计约束（lead 2026-11-04 落库裁定，方案 1）：
  * 质量门禁 red / black / blocked → **先原子写 quality.json（证据）再拒绝写库并退出码 1**；
    没有 --force，也不做"降级写入"
    （一旦允许降级，就会有人加 --force，然后 --force 会进 CI）。
  * SQL 由纯函数 builder 生成（`%s` 占位 + 参数绑定），builder 可脱离 psycopg 单测；
    值永不拼进 SQL 文本。
  * 与 `build_dwd` 共用同一份 DWD 行：load 不做二次计算、不做口径转换（价格/因子/财务原样落库）。
  * 幂等 upsert：主键与 `warehouse/dwd/schema.sql` 一致；同一批次重放得到完全相同的结果。
  * 唯一依赖 `psycopg[binary]>=3.1,<4`（仅本模块运行时导入；测试不需要驱动）。
  * 写库是单事务：任一语句失败整体回滚，serving 不会看到半批数据。

验证边界（如实声明）：本机没有 PostgreSQL，builder / 参数绑定 / 门禁 / 执行计划为纯单测；
真实落库只在 compose / CI 的 PG 上执行（`PG_TEST_DSN` 集成测试，本机 skip）。

用法：
    python3 -m warehouse.load --ods-root /path/to/ods --dry-run   # 只出计划，不连库
    python3 -m warehouse.load --ods-root /path/to/ods --dsn "postgresql://..."
    DSN=postgresql://... python3 -m warehouse.load --ods-root /path/to/ods
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from warehouse.dwd.build import DwdState, build_dwd
from warehouse.ods.loader import (
    OdsFormatError,
    display_instrument_ids,
    load_display_safety,
    ensure_research_origin,
    load_research_coverage,
    load_ods_roots,
    require_display_evidence,
)
from warehouse.quality.checks import QualityReport, RuleResult, run_quality_checks

# --------------------------------------------------------------------------
# 列清单：唯一真源是 warehouse/dwd/schema.sql；tests/test_load.py 交叉校验。
# 顺序即 INSERT 列顺序；参数按同一顺序绑定。
# --------------------------------------------------------------------------
INSTRUMENT_COLUMNS = (
    "instrument_id",
    "exchange",
    "code",
    "name",
    "board",
    "security_type",
    "list_status",
    "lot_size",
    "listed_at",
    "display_safe",
    "source",
    "as_of",
    "fetched_at",
    "ingested_at",
)
INSTRUMENT_PK = ("instrument_id",)

BAR_COLUMNS = (
    "instrument_id",
    "trade_date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "amount",
    "prev_close",
    "market_segment",
    "source",
    "as_of",
    "fetched_at",
    "batch_id",
    "revision",
    "ingested_at",
)
BAR_PK = ("instrument_id", "trade_date")

FACTOR_COLUMNS = (
    "instrument_id",
    "trade_date",
    "factor",
    "source",
    "as_of",
    "fetched_at",
    "batch_id",
    "revision",
    "ingested_at",
)
FACTOR_PK = ("instrument_id", "trade_date")

SUSPENDED_COLUMNS = (
    "instrument_id",
    "trade_date",
    "source",
    "as_of",
    "fetched_at",
    "batch_id",
    "ingested_at",
)
SUSPENDED_PK = ("instrument_id", "trade_date")

FUNDAMENTAL_COLUMNS = (
    "instrument_id",
    "report_period",
    "report_end_date",
    "announced_at",
    "statement_basis",
    "currency",
    "revenue",
    "net_profit",
    "revenue_yoy_pct",
    "net_profit_yoy_pct",
    "eps",
    "roe_pct",
    "gross_margin_pct",
    "source",
    "as_of",
    "fetched_at",
    "batch_id",
    "ingested_at",
)
# 契约以 report_period（YYYYQn）为期次标识；report_end_date 是同一报告期的结束日。
# M06 的 reported/restated 两套靠 statement_basis 区分，故 PK 必须含 statement_basis。
FUNDAMENTAL_PK = ("instrument_id", "report_period", "statement_basis")

# 研究数据集 DWD（7 张表）：列顺序与 schema.sql 一致；PK 见 *_PK。
# 注意：这些表不做修订留痕（研究态 last-write-wins），不写 dwd_bar_revision。
_RESEARCH_META_COLUMNS = ("source", "as_of", "fetched_at", "batch_id", "ingested_at")

DAILY_BASIC_COLUMNS = (
    "instrument_id",
    "trade_date",
    "close",
    "turnover_rate_pct",
    "free_float_turnover_rate_pct",
    "volume_ratio",
    "pe",
    "pe_ttm",
    "pb",
    "ps",
    "ps_ttm",
    "dividend_yield_pct",
    "dividend_yield_ttm_pct",
    "total_shares",
    "float_shares",
    "free_float_shares",
    "total_market_value",
    "circulating_market_value",
    "limit_status",
    *_RESEARCH_META_COLUMNS,
)
DAILY_BASIC_PK = ("instrument_id", "trade_date")

INDEX_DAILY_COLUMNS = (
    "instrument_id",
    "trade_date",
    "open",
    "high",
    "low",
    "close",
    "prev_close",
    "change",
    "pct_change_pct",
    "volume",
    "amount",
    *_RESEARCH_META_COLUMNS,
)
INDEX_DAILY_PK = ("instrument_id", "trade_date")

TOP_LIST_COLUMNS = (
    "instrument_id",
    "trade_date",
    "name",
    "close",
    "pct_change_pct",
    "turnover_rate_pct",
    "amount",
    "lhb_sell_amount",
    "lhb_buy_amount",
    "lhb_amount",
    "lhb_net_amount",
    "lhb_net_rate_pct",
    "lhb_amount_rate_pct",
    "float_market_value",
    "reason",
    *_RESEARCH_META_COLUMNS,
)
TOP_LIST_PK = ("instrument_id", "trade_date", "reason")  # L181: fa08b24 加 reason（同股可因多原因上榜）

TOP_INST_COLUMNS = (
    "instrument_id",
    "trade_date",
    "seat_name",
    "side",
    "buy_amount",
    "buy_rate_pct",
    "sell_amount",
    "sell_rate_pct",
    "net_buy_amount",
    "reason",
    *_RESEARCH_META_COLUMNS,
)
TOP_INST_PK = ("instrument_id", "trade_date", "seat_name", "side", "reason")  # L181: fa08b24 加 reason

MONEYFLOW_COLUMNS = (
    "instrument_id",
    "trade_date",
    "buy_small_volume",
    "buy_small_amount",
    "sell_small_volume",
    "sell_small_amount",
    "buy_medium_volume",
    "buy_medium_amount",
    "sell_medium_volume",
    "sell_medium_amount",
    "buy_large_volume",
    "buy_large_amount",
    "sell_large_volume",
    "sell_large_amount",
    "buy_extra_large_volume",
    "buy_extra_large_amount",
    "sell_extra_large_volume",
    "sell_extra_large_amount",
    "net_inflow_volume",
    "net_inflow_amount",
    *_RESEARCH_META_COLUMNS,
)
MONEYFLOW_PK = ("instrument_id", "trade_date")

MARGIN_COLUMNS = (
    "exchange",
    "trade_date",
    "financing_balance",
    "financing_buy_amount",
    "financing_repayment_amount",
    "securities_balance",
    "securities_sell_volume",
    "margin_balance",
    "securities_volume",
    *_RESEARCH_META_COLUMNS,
)
MARGIN_PK = ("exchange", "trade_date")

HK_HOLD_COLUMNS = (
    "instrument_id",
    "trade_date",
    "name",
    "holding_volume",
    "holding_ratio_pct",
    "northbound_channel",
    *_RESEARCH_META_COLUMNS,
)
HK_HOLD_PK = ("instrument_id", "trade_date")


STK_LIMIT_COLUMNS = (
    "instrument_id",
    "trade_date",
    "previous_close",
    "up_limit",
    "down_limit",
    "limit_pct",
    "limit_pct_source",
    "asset_type",
    "exchange",
    *_RESEARCH_META_COLUMNS,
)
STK_LIMIT_PK = ("instrument_id", "trade_date")

FINA_INDICATOR_COLUMNS = (
    "instrument_id",
    "report_period",
    "report_end_date",
    "announced_at",
    "revision_flag",
    "ar_turn",
    "assets_turn",
    "assets_yoy_pct",
    "bps",
    "bps_yoy_pct",
    "current_ratio",
    "debt_to_assets",
    "dt_eps",
    "dt_netprofit_yoy_pct",
    "ebit",
    "ebitda",
    "eps",
    "eqt_yoy_pct",
    "extra_item",
    "fixed_assets",
    "grossprofit_margin",
    "inv_turn",
    "netprofit_margin",
    "netprofit_yoy_pct",
    "npta",
    "ocfps",
    "op_yoy_pct",
    "or_yoy_pct",
    "profit_dedt",
    "q_eps",
    "q_gsprofit_margin",
    "q_netprofit_margin",
    "q_op_qoq_pct",
    "q_profit_qoq_pct",
    "q_roe",
    "q_sales_qoq_pct",
    "q_sales_yoy_pct",
    "quick_ratio",
    "revenue_ps",
    "roa",
    "roe",
    "roe_dt",
    "roe_waa",
    "roe_yoy_pct",
    "roic",
    "total_revenue_ps",
    "tr_yoy_pct",
    *_RESEARCH_META_COLUMNS,
)
FINA_INDICATOR_PK = ("instrument_id", "report_period")

INDEX_CLASSIFY_COLUMNS = (
    "index_code",
    "snapshot_date",
    "industry_name",
    "parent_code",
    "level",
    "industry_code",
    "is_published",
    "classification_source",
    "coverage",
    *_RESEARCH_META_COLUMNS,
)
INDEX_CLASSIFY_PK = ("index_code", "snapshot_date")

INDEX_MEMBER_ALL_COLUMNS = (
    "instrument_id",
    "snapshot_date",
    "name",
    "l1_code",
    "l1_name",
    "l2_code",
    "l2_name",
    "l3_code",
    "l3_name",
    "in_date",
    "out_date",
    "is_new",
    "coverage",
    *_RESEARCH_META_COLUMNS,
)
INDEX_MEMBER_ALL_PK = ("instrument_id", "l1_code", "l2_code", "l3_code", "snapshot_date")

#: endpoint -> (表名, 列清单, PK, state 属性)。
RESEARCH_TABLES: dict[str, tuple[str, tuple[str, ...], tuple[str, ...], str]] = {
    "daily_basic": ("dwd_daily_basic", DAILY_BASIC_COLUMNS, DAILY_BASIC_PK, "daily_basic"),
    "index_daily": ("dwd_index_daily", INDEX_DAILY_COLUMNS, INDEX_DAILY_PK, "index_daily"),
    "top_list": ("dwd_top_list", TOP_LIST_COLUMNS, TOP_LIST_PK, "top_list"),
    "top_inst": ("dwd_top_inst", TOP_INST_COLUMNS, TOP_INST_PK, "top_inst"),
    "moneyflow": ("dwd_moneyflow", MONEYFLOW_COLUMNS, MONEYFLOW_PK, "moneyflow"),
    "margin": ("dwd_margin", MARGIN_COLUMNS, MARGIN_PK, "margin"),
    "hk_hold": ("dwd_hk_hold", HK_HOLD_COLUMNS, HK_HOLD_PK, "hk_hold"),
    # KD-DSW-P2（A1 commit 9ebdb73）
    "stk_limit": ("dwd_stk_limit", STK_LIMIT_COLUMNS, STK_LIMIT_PK, "stk_limit"),
    "fina_indicator": ("dwd_fina_indicator", FINA_INDICATOR_COLUMNS, FINA_INDICATOR_PK, "fina_indicator"),
    "index_classify": ("dwd_index_classify", INDEX_CLASSIFY_COLUMNS, INDEX_CLASSIFY_PK, "index_classify"),
    "index_member_all": ("dwd_index_member_all", INDEX_MEMBER_ALL_COLUMNS, INDEX_MEMBER_ALL_PK, "index_member_all"),
}

REVISION_COLUMNS = (
    "instrument_id",
    "trade_date",
    "revision",
    "field",
    "old_value",
    "new_value",
    "detected_at",
    "batch_id",
)
REVISION_PK = ("instrument_id", "trade_date", "revision", "field")

REFUSED_GRADES = ("red", "black")
# 退出码（tests/e2e/docs/INGEST-ONCE-CONTRACT.md §1，A12 定）：
#   0 = 落库成功（含 yellow 放行）；
#   1 = 质量红/黑拒绝写库（报告照写，退出码是结论）；
#   2 = 环境/DB/schema 错误（DSN、驱动、连接、建表/写库失败、报告无法落盘）；
#   3 = 输入缺失/为空（ODS 无批次、缺 instrument 主数据、ODS/manifest 校验失败）。
EXIT_OK = 0
EXIT_QUALITY_REFUSED = 1
EXIT_ENV_ERROR = 2
EXIT_INPUT_MISSING = 3
GATE_EXIT_CODE = EXIT_QUALITY_REFUSED
QUALITY_REPORT_ENV = "QUALITY_REPORT_PATH"
DEFAULT_QUALITY_REPORT_PATH = "/state/quality.json"
ENV_DSN = ("DSN", "DATABASE_URL")


@dataclass(frozen=True)
class Statement:
    """一条可执行语句：固定 SQL + 参数行（executemany 用）。

    params 至少一行；空集合不生成 Statement（避免无意义语句）。
    """

    label: str
    sql: str
    params: list[tuple[Any, ...]] = field(default_factory=list)


# --------------------------------------------------------------------------
# SQL builder（纯函数，可单测）
# --------------------------------------------------------------------------


def _quoted(columns: Sequence[str]) -> str:
    return ", ".join(columns)


def _upsert_sql(
    table: str,
    columns: Sequence[str],
    primary_key: Sequence[str],
    *,
    conflict_only: bool = False,
) -> str:
    placeholders = ", ".join(["%s"] * len(columns))
    conflict = _quoted(primary_key)
    head = (
        f"INSERT INTO {table} ({_quoted(columns)}) VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict})"
    )
    if conflict_only:
        return head + " DO NOTHING"
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in columns if c not in primary_key)
    return head + f" DO UPDATE SET {updates}"


def _statement(
    label: str,
    table: str,
    columns: Sequence[str],
    primary_key: Sequence[str],
    rows: Iterable[dict[str, Any]],
    *,
    conflict_only: bool = False,
) -> Statement | None:
    params = [tuple(row[c] for c in columns) for row in rows]
    if not params:
        return None
    return Statement(
        label=label,
        sql=_upsert_sql(table, columns, primary_key, conflict_only=conflict_only),
        params=params,
    )


def delete_suspended_bars(keys: Iterable[tuple[str, Any]]) -> Statement | None:
    """停牌证据存在时，删除同键 bar：停牌日不建行（C08），upsert 无法表达"删行"。"""
    pairs = sorted(keys)
    if not pairs:
        return None
    placeholders = ", ".join(["(%s, %s)"] * len(pairs))
    flat = tuple(value for pair in pairs for value in pair)
    return Statement(
        label="delete_suspended_bars",
        sql=(
            "DELETE FROM dwd_stock_bar_daily "
            f"WHERE (instrument_id, trade_date) IN ({placeholders})"
        ),
        params=[flat],
    )


def build_statements(state: DwdState) -> list[Statement]:
    """把 DWD 内存状态展开为有序写库计划。顺序：维表 → bar → 停牌删除/证据 → 因子 → 财务 → 修订。"""
    plan: list[Statement | None] = [
        _statement(
            "upsert_instrument",
            "dim_instrument",
            INSTRUMENT_COLUMNS,
            INSTRUMENT_PK,
            state.instruments.values(),
        ),
        _statement("upsert_bar", "dwd_stock_bar_daily", BAR_COLUMNS, BAR_PK, state.bars.values()),
        delete_suspended_bars(state.suspended_rows.keys()),
        _statement(
            "upsert_suspended",
            "dwd_suspended_daily",
            SUSPENDED_COLUMNS,
            SUSPENDED_PK,
            state.suspended_rows.values(),
        ),
        _statement(
            "upsert_factor",
            "dwd_adj_factor",
            FACTOR_COLUMNS,
            FACTOR_PK,
            state.factors.values(),
        ),
        _statement(
            "upsert_fundamental",
            "dwd_fundamental_report",
            FUNDAMENTAL_COLUMNS,
            FUNDAMENTAL_PK,
            state.fundamentals.values(),
        ),
        *[
            _statement(
                f"upsert_{endpoint}",
                table,
                columns,
                primary_key,
                getattr(state, state_attr).values(),
            )
            for endpoint, (table, columns, primary_key, state_attr) in RESEARCH_TABLES.items()
        ],
        _statement(
            "insert_revision",
            "dwd_bar_revision",
            REVISION_COLUMNS,
            REVISION_PK,
            (
                {
                    "instrument_id": r.instrument_id,
                    "trade_date": r.trade_date,
                    "revision": r.revision,
                    "field": r.field,
                    "old_value": r.old_value,
                    "new_value": r.new_value,
                    "detected_at": r.detected_at,
                    "batch_id": r.batch_id,
                }
                for r in state.revisions
            ),
            conflict_only=True,
        ),
    ]
    return [statement for statement in plan if statement is not None]


# --------------------------------------------------------------------------
# 质量门禁
# --------------------------------------------------------------------------


def quality_level(report: QualityReport) -> str:
    """契约 §2 的 level 只有 green/yellow/red；black 归并为 red（同为禁止写库）。"""
    if report.blocked or report.grade in ("red", "black"):
        return "red"
    return report.grade


def quality_reasons(report: QualityReport) -> list[str]:
    """人类可读原因：红/黑给 blocker，黄给 warn；绿为空。没有原因的红/黄不允许出现。"""
    reasons = [
        f"{violation.rule_id} {violation.instrument_id} {violation.trade_date}: {violation.detail}"
        for violation in report.blocker_violations
    ]
    if quality_level(report) == "yellow":
        reasons.extend(
            f"{violation.rule_id} {violation.instrument_id} {violation.trade_date}: {violation.detail}"
            for result in report.results
            for violation in result.violations
            if result.category and violation not in report.blocker_violations
        )
        if not reasons:
            reasons.append(f"质量分 {report.score:.2f} 低于绿阈值，yellow 放行")
    elif quality_level(report) == "red" and not reasons:
        reasons.append(f"质量分 {report.score:.2f}，gate={gate_reason(report) or 'red/black'}")
    return reasons


def build_quality_report(
    report: QualityReport, state: DwdState, *, checked_at: datetime | None = None
) -> dict[str, Any]:
    """契约 §2 quality.json：score 归一化到 [0,1]，counts 用 DWD 行数（serving 就是这些行）。"""
    dwd_rows = (
        len(state.instruments)
        + len(state.bars)
        + len(state.factors)
        + len(state.suspended_rows)
        + len(state.fundamentals)
        + len(state.revisions)
    )
    serving_rows = (
        len(state.instruments)
        + len(state.bars)
        + len(state.factors)
        + len(state.suspended_rows)
        + len(state.fundamentals)
    )
    moment = checked_at or datetime.now(timezone.utc)
    return {
        "schema_version": 1,
        "level": quality_level(report),
        "score": round(report.score / 100.0, 4),
        "checked_at": moment.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "counts": {"dwd_rows": dwd_rows, "serving_rows": serving_rows},
        "reasons": quality_reasons(report),
    }


def quality_report_path(default: str = DEFAULT_QUALITY_REPORT_PATH) -> Path:
    return Path(os.environ.get(QUALITY_REPORT_ENV) or default)


def write_quality_report(path: Path, payload: dict[str, Any]) -> None:
    """原子写（tmp + fsync + rename），避免 A12 的 report 步骤读到半截文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".quality-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def gate_reason(report: QualityReport) -> str | None:
    """red / black / blocked → 拒绝写库（yellow 允许但会打警告）。"""
    if report.blocked or report.grade in REFUSED_GRADES:
        return f"质量分未过门禁：score={report.score} grade={report.grade} blocked={report.blocked}"
    return None


# --------------------------------------------------------------------------
# 执行（psycopg 只在此处导入）
# --------------------------------------------------------------------------


def execute_statements(conn: Any, statements: Sequence[Statement]) -> dict[str, int]:
    """单事务执行写库计划；返回每个 label 写入/更新行数。调用方负责 commit/rollback。"""
    written: dict[str, int] = {}
    cursor = conn.cursor()
    try:
        for statement in statements:
            cursor.executemany(statement.sql, statement.params)
            written[statement.label] = len(statement.params)
    finally:
        cursor.close()
    return written


def _connect(dsn: str) -> Any:
    try:
        import psycopg  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - 依赖缺失时走 CLI 报错
        raise RuntimeError(
            "缺少 psycopg：请安装 `pip install 'psycopg[binary]>=3.1,<4'`（唯一允许的落库依赖）"
        ) from exc
    return psycopg.connect(dsn)


def resolve_dsn(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    for name in ENV_DSN:
        value = os.environ.get(name)
        if value:
            return value
    return None


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _print_plan(state: DwdState, statements: Sequence[Statement], *, dry_run: bool) -> None:
    print(
        f"[plan] instruments={len(state.instruments)} bars={len(state.bars)} "
        f"factors={len(state.factors)} suspended={len(state.suspended_rows)} "
        f"fundamentals={len(state.fundamentals)} revisions={len(state.revisions)}"
    )
    for statement in statements:
        print(f"[plan] {statement.label}: {len(statement.params)} 行")
    if dry_run:
        print("[plan] dry-run：未连接数据库、未写入任何行")


def _downgrade_rules(report: QualityReport, skip_rules: tuple[str, ...]) -> QualityReport:
    """L182 运行时把指定 rule_id 的 severity 降为 warn，重算 grade/blocked。

    用途：SKIP_ANCHOR_PRELOAD 场景下 bars 无 factors，STRUCT-06 blocker 是预期冲突；
    不改 quality_config.json，仅在 CLI 显式传入时生效。
    """
    import dataclasses
    skip = set(skip_rules)
    new_results: list[RuleResult] = []
    for result in report.results:
        if result.rule_id in skip:
            new_violations = [
                dataclasses.replace(v, severity="warn") for v in result.violations
            ]
            new_results.append(
                dataclasses.replace(result, violations=new_violations)
            )
        else:
            new_results.append(result)
    blocked = any(v.severity == "blocker" for r in new_results for v in r.violations)
    has_warn = any(v.severity == "warn" for r in new_results for v in r.violations)
    grade = "black" if blocked else ("yellow" if has_warn else "green")
    return dataclasses.replace(
        report, grade=grade, blocked=blocked, results=new_results
    )




def run(
    ods_root: Path,
    *,
    dsn: str | None,
    dry_run: bool,
    manifest_root: Path | None = None,
    internal_ods_root: Path | None = None,
    profile: str = "prod",
    skip_rules: tuple[str, ...] = (),
) -> int:
    try:
        batches = load_ods_roots(ods_root, internal_ods_root)
        research_in_display = ensure_research_origin(batches, profile=profile)
        if research_in_display:
            print(
                "[WARN] 研究数据集批次出现在 display root：display_safe 保持 false"
                "（dev profile 放行；prod profile 会拒绝）",
                file=sys.stderr,
            )
        if not batches:
            print(
                f"[FAIL] ODS 输入为空：{ods_root} 下没有任何批次（契约 exit 3 = INPUT_MISSING）",
                file=sys.stderr,
            )
            return EXIT_INPUT_MISSING
        has_display_instruments = bool(display_instrument_ids(batches))
        strict = profile == "prod" and has_display_instruments
        if strict and manifest_root is None:
            raise OdsFormatError(
                "生产 profile 下 display root 有 instrument 批次但没有 --manifest-root，"
                "无法派生 display_safe（拒绝静默落 false）"
            )
        if profile == "prod" and any(batch.origin == "flat" for batch in batches):
            print(
                "[WARN] 平铺 ODS root：没有 root 隔离证据，所有 instrument.display_safe 将为 false（离线回归语义）",
                file=sys.stderr,
            )
        display_safety = (
            load_display_safety(manifest_root, strict=strict) if manifest_root is not None else None
        )
        if strict:
            require_display_evidence(batches, display_safety or {})
    except OdsFormatError as exc:
        print(f"[FAIL] ODS/manifest 校验失败（拒绝落库）: {exc}", file=sys.stderr)
        return EXIT_INPUT_MISSING

    research_coverage = load_research_coverage(ods_root)
    if internal_ods_root is not None:
        research_coverage.update(load_research_coverage(internal_ods_root))
    state = build_dwd(
        batches, display_safety=display_safety, research_coverage=research_coverage
    )
    if state.bars and not state.instruments:
        print(
            "[FAIL] ODS 缺少 instrument.v1 批次：dim_instrument 缺失时不得落库"
            "（BIZ-01/首日豁免/serving_instrument 依赖证券主数据）",
            file=sys.stderr,
        )
        return EXIT_INPUT_MISSING

    report = run_quality_checks(state)
    if skip_rules:
        report = _downgrade_rules(report, skip_rules)
        print(f"[WARN] 运行时降级规则 {','.join(skip_rules)} → warn（L182）", file=sys.stderr)
    exemptions = report.as_dict().get("exemptions") or {}
    suffix = f" exemptions={exemptions}" if exemptions else ""
    print(f"quality score={report.score} grade={report.grade} blocked={report.blocked}{suffix}")
    reason = gate_reason(report)

    if not dry_run:
        report_path = quality_report_path()
        try:
            write_quality_report(report_path, build_quality_report(report, state))
        except OSError as exc:
            print(f"[FAIL] 无法原子写质量报告 {report_path}: {exc}", file=sys.stderr)
            return EXIT_ENV_ERROR
        print(f"[report] quality.json → {report_path}")
    if reason is not None:
        print(f"[REFUSED] {reason}；拒绝写库，未连接数据库。", file=sys.stderr)
        for violation in report.blocker_violations[:20]:
            print(
                f"  [blocker] {violation.rule_id} {violation.instrument_id} "
                f"{violation.trade_date}: {violation.detail}",
                file=sys.stderr,
            )
        return EXIT_QUALITY_REFUSED
    if report.grade == "yellow":
        print("[WARN] 质量分 yellow（放行但需告警）：落库继续", file=sys.stderr)

    statements = build_statements(state)
    _print_plan(state, statements, dry_run=dry_run)
    if dry_run:
        return 0

    resolved = resolve_dsn(dsn)
    if not resolved:
        print(
            "[FAIL] 未提供数据库连接串：用 --dsn 或环境变量 DSN / DATABASE_URL",
            file=sys.stderr,
        )
        return EXIT_ENV_ERROR
    try:
        conn = _connect(resolved)
    except RuntimeError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return EXIT_ENV_ERROR

    try:
        written = execute_statements(conn, statements)
        conn.commit()
    except Exception as exc:  # pragma: no cover - 真实 PG 路径
        conn.rollback()
        print(f"[FAIL] 落库失败，已回滚: {exc}", file=sys.stderr)
        return EXIT_ENV_ERROR
    finally:
        conn.close()

    print(f"[OK] 已写入：{written}")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python3 -m warehouse.load",
        description="ODS → DWD 幂等落库（质量门禁 red/black/blocked 拒绝写入）",
    )
    parser.add_argument("--ods-root", type=Path, required=True, help="A1 落地的 ODS 批次根目录")
    parser.add_argument(
        "--profile",
        choices=("prod", "dev"),
        default="prod",
        help="prod（默认）：display root 必须有 manifest 展示证据并校验 hash 链/head；dev：离线回归，缺证据降为 false",
    )
    parser.add_argument(
        "--internal-ods-root",
        type=Path,
        help="L34 内部 ODS root（tushare 交叉校验批次）；也支持单 --ods-root 下含 display/ + internal/ 的标准布局（自动识别）",
    )
    parser.add_argument(
        "--manifest-root",
        type=Path,
        help="A1 主数据 manifest 根目录（manifest.jsonl/snapshots/），派生 dim_instrument.display_safe（L30）",
    )
    parser.add_argument("--dsn", help="PostgreSQL DSN；缺省读 DSN / DATABASE_URL")
    parser.add_argument("--dry-run", action="store_true", help="只输出写库计划，不连接数据库")
    parser.add_argument("--skip-rule", action="append", default=[], metavar="RULE_ID", help="运行时把指定规则从 blocker 降为 warn（L182；可重复）")
    args = parser.parse_args(argv)
    return run(
        args.ods_root,
        dsn=args.dsn,
        dry_run=args.dry_run,
        manifest_root=args.manifest_root,
        internal_ods_root=args.internal_ods_root,
        profile=args.profile,
        skip_rules=tuple(args.skip_rule),
    )


if __name__ == "__main__":
    raise SystemExit(main())
