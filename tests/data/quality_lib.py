"""数据校验与质量分（A11 owns: tests/data/）。

独立性原则：本模块**不复用** warehouse/quality/checks.py 的实现，而是按
docs/metrics/P0-metrics.md §6 的规则清单独立实现一遍「参考实现」，再拿它的结论去对
data/golden/*.yaml 里 A2 写死的 expect（grade/blocked/violations）。这样 golden 才是
真正的 oracle，而不是「实现自己验证自己」。

输入是 golden fixture 格式（data/golden/p0_bars20.yaml）：
  meta: {version, ...}
  cases: [{id, title, instrument, as_of, fetched_at, bars|batches, factors, suspended, expect}]
批次语义：batches 只取最后一批作为「当前 DWD 状态」（G18/G19 幂等与修订用例）；
factors 缺省时按 fixture 约定视为每根 bar 因子 1.0（与 warehouse/golden_runner.py 一致），
显式给出 factors 时则要求每根 bar 都有因子（STRUCT-06）。

评分（H4-D8 / task-6）：
  类别分 = 100 × (1 − 计分违规数 / 评估数)；总分 = Σ 权重 × 类别分，保留 2 位；
  默认只把 severity=blocker 的违规计入分子（见 quality_policy.yaml score_counts 的 TODO）；
  任一 blocker 违规 → black + blocked（一票否决，阈值不放宽）。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
POLICY_PATH = HERE / "quality_policy.yaml"
DEFAULT_PACK_PATH = REPO_ROOT / "data" / "golden" / "p0_bars20.yaml"
RUNTIME_CONFIG_PATH = REPO_ROOT / "warehouse" / "quality" / "quality_config.json"

CATEGORY_ORDER = ("struct", "business", "completeness", "consistency")
SHANGHAI = timezone(timedelta(hours=8))
CLOSE_TIME = time(15, 0)
PRICE_FIELDS = ("open", "high", "low", "close")
REQUIRED_BAR_FIELDS = ("trade_date", "open", "high", "low", "close", "volume", "amount")
CENT = Decimal("0.01")


class DataError(Exception):
    """数据包/配置本身不可用：属于门禁红灯（不是 skip）。"""


# --------------------------------------------------------------------------
# 配置与数据包加载
# --------------------------------------------------------------------------


def load_policy() -> dict[str, Any]:
    return _load_yaml(POLICY_PATH, "已批准质量口径")


def load_runtime_config(path: Path | None = None) -> dict[str, Any]:
    path = path or RUNTIME_CONFIG_PATH
    if not path.exists():
        raise DataError(f"运行时质量配置缺失: {path}（A2 必须提供，门禁不允许跳过）")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DataError(f"质量配置 JSON 解析失败: {path}: {exc}") from exc


def pack_path_from_env() -> Path:
    """测试可用 A11_GOLDEN_PACK 指向变异副本（注入坏数据自证），默认读 P0 包。"""
    return Path(os.environ.get("A11_GOLDEN_PACK") or DEFAULT_PACK_PATH)


def _load_yaml(path: Path, what: str) -> dict[str, Any]:
    if not path.exists():
        raise DataError(f"{what}缺失: {path}")
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise DataError(f"{what} YAML 解析失败: {path}: {exc}") from exc
    if not isinstance(doc, dict):
        raise DataError(f"{what}顶层必须是 mapping: {path}")
    return doc


@dataclass
class CaseData:
    case_id: str
    title: str
    instrument: dict[str, Any]
    bars: list[dict[str, Any]]
    factors: list[dict[str, Any]] | None
    suspended: list[str]
    as_of: str | None
    fetched_at: str | None
    expect: dict[str, Any]


@dataclass
class Pack:
    path: Path
    meta: dict[str, Any]
    cases: list[CaseData]
    declared_instruments: set[str] = field(default_factory=set)


def load_pack(path: Path | None = None) -> Pack:
    path = path or pack_path_from_env()
    doc = _load_yaml(path, "golden 数据包")
    cases_raw = doc.get("cases")
    if not isinstance(cases_raw, list) or not cases_raw:
        raise DataError(f"{path}: cases 必须是非空列表")
    meta = doc.get("meta") or {}
    if "version" not in meta:
        raise DataError(f"{path}: meta.version 缺失（数据包必须版本化）")

    declared: set[str] = set()
    for item in doc.get("instruments") or []:
        iid = item.get("instrument_id")
        if iid:
            declared.add(iid)

    cases: list[CaseData] = []
    seen: set[str] = set()
    for raw in cases_raw:
        if not isinstance(raw, dict) or "id" not in raw:
            raise DataError(f"{path}: case 必须是含 id 的 mapping: {raw!r}")
        case_id = raw["id"]
        if case_id in seen:
            raise DataError(f"{path}: case id 重复: {case_id}")
        seen.add(case_id)
        instrument = raw.get("instrument")
        if not isinstance(instrument, dict) or not instrument.get("instrument_id"):
            raise DataError(f"{path}: {case_id} 缺 instrument.instrument_id")
        batches = raw.get("batches")
        if batches:
            final = batches[-1]
            bars = list(final.get("bars") or [])
            factors = final.get("factors")
            suspended = list(final.get("suspended") or [])
            as_of = final.get("as_of") or raw.get("as_of")
            fetched_at = final.get("fetched_at") or raw.get("fetched_at")
        else:
            bars = list(raw.get("bars") or [])
            factors = raw.get("factors")
            suspended = list(raw.get("suspended") or [])
            as_of = raw.get("as_of")
            fetched_at = raw.get("fetched_at")
        expect = raw.get("expect") or {}
        if "grade" not in expect or "blocked" not in expect:
            raise DataError(f"{path}: {case_id} expect 必须含 grade/blocked（golden 是 oracle）")
        declared.add(instrument["instrument_id"])
        cases.append(
            CaseData(
                case_id=case_id,
                title=raw.get("title", ""),
                instrument=instrument,
                bars=bars,
                factors=factors,
                suspended=suspended,
                as_of=as_of,
                fetched_at=fetched_at,
                expect=expect,
            )
        )
    return Pack(path=path, meta=meta, cases=cases, declared_instruments=declared)


# --------------------------------------------------------------------------
# 值解析
# --------------------------------------------------------------------------


def parse_decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def parse_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:  # 无时区 = 无法判定 as_of，按违规处理
        return parsed.replace(tzinfo=SHANGHAI)
    return parsed.astimezone(SHANGHAI)


# --------------------------------------------------------------------------
# 规则评估（结构 / 业务 / 完整性及时性 / 一致性）
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Violation:
    rule_id: str
    severity: str
    detail: str
    instrument_id: str | None = None
    trade_date: str | None = None


@dataclass
class CaseReport:
    case_id: str
    violations: list[Violation]
    rule_ids: set[str]
    evaluated: dict[str, int]
    category_scores: dict[str, float]
    score: float
    grade: str
    blocked: bool


class _Stats:
    def __init__(self, policy: dict[str, Any]):
        self.policy = policy
        self.evaluated: dict[str, int] = {rule_id: 0 for rule_id in policy["rules"]}
        self.violations: list[Violation] = []

    def bump(self, rule_id: str, count: int = 1) -> None:
        self.evaluated[rule_id] += count

    def flag(self, rule_id: str, detail: str, iid: str | None = None, td: str | None = None) -> None:
        severity = self.policy["rules"][rule_id]["severity"]
        self.violations.append(Violation(rule_id, severity, detail, iid, td))

    def rule_ids(self) -> set[str]:
        return {v.rule_id for v in self.violations}


def evaluate_case(pack: Pack, case: CaseData, policy: dict[str, Any] | None = None) -> CaseReport:
    policy = policy or load_policy()
    stats = _Stats(policy)
    iid = case.instrument["instrument_id"]
    board = case.instrument.get("board")
    name = case.instrument.get("name") or ""
    listed_at = parse_date(case.instrument.get("listed_at"))
    limits = policy["board_limit_pct"]
    tolerance = Decimal(str(policy["limit_tolerance_pp"]))
    is_st = board in policy["st_limit_boards"] and name.startswith(("ST", "*ST"))
    # L80：ST 判定只有当期名称快照（dim.as_of）；历史交易日未还原，只做 warn 标注。
    dim_as_of = parse_datetime(case.instrument.get("as_of") or case.as_of)
    limit_pct = Decimal(str(policy["st_limit_pct"] if is_st else limits.get(board, limits["main"])))

    # 排序后的 bar（fixture 允许乱序输入，规则按交易日顺序判定）
    indexed = [(parse_date(bar.get("trade_date")), bar) for bar in case.bars]
    indexed.sort(key=lambda item: (item[0] or date.min))
    bars: list[tuple[date | None, dict[str, Any]]] = indexed

    # ---------------- 结构 ----------------
    seen_keys: dict[tuple[str, date], int] = {}
    for trade_date, bar in bars:
        bar_iid = bar.get("instrument_id") or iid
        td_text = trade_date.isoformat() if trade_date else None
        stats.bump("STRUCT-01")
        missing = [f for f in REQUIRED_BAR_FIELDS if bar.get(f) in (None, "")]
        bad_values = []
        for f in ("volume", "amount"):
            if bar.get(f) not in (None, "") and parse_decimal(bar.get(f)) is None:
                bad_values.append(f)
        for f in PRICE_FIELDS:
            if bar.get(f) not in (None, "") and parse_decimal(bar.get(f)) is None:
                bad_values.append(f)
        if trade_date is None:
            bad_values.append("trade_date")
        if missing or bad_values:
            stats.flag(
                "STRUCT-01",
                f"必填/可解析性失败 missing={missing} unparsable={bad_values}",
                bar_iid,
                td_text,
            )

        if trade_date is not None:
            stats.bump("STRUCT-02")
            key = (bar_iid, trade_date)
            seen_keys[key] = seen_keys.get(key, 0) + 1

        prices = {f: parse_decimal(bar.get(f)) for f in PRICE_FIELDS}
        if all(value is not None for value in prices.values()):
            o, h, lo, cl = (prices["open"], prices["high"], prices["low"], prices["close"])
            stats.bump("STRUCT-03")
            if not (h >= lo and h >= max(o, cl) and lo <= min(o, cl)):
                stats.flag(
                    "STRUCT-03",
                    f"OHLC 关系非法 open={o} high={h} low={lo} close={cl}",
                    bar_iid,
                    td_text,
                )
            stats.bump("STRUCT-04")
            if min(o, h, lo, cl) <= 0:
                stats.flag("STRUCT-04", "价格必须 > 0", bar_iid, td_text)
            for f in ("volume", "amount"):
                value = parse_decimal(bar.get(f))
                if value is not None and value < 0:
                    stats.flag("STRUCT-04", f"{f} 不能为负: {value}", bar_iid, td_text)
            stats.bump("STRUCT-05")
            for f in PRICE_FIELDS:
                if prices[f].as_tuple().exponent < -2:
                    stats.flag("STRUCT-05", f"{f} 小数位超过人民币分: {prices[f]}", bar_iid, td_text)
                    break

    for (key_iid, key_date), count in seen_keys.items():
        if count > 1:
            stats.flag("STRUCT-02", f"主键重复 {key_iid} {key_date} × {count}", key_iid, key_date.isoformat())

    # 因子：显式 factors 时每根 bar 必须有；缺省时 fixture 语义为 1.0
    factor_by_date: dict[date, Decimal] = {}
    if case.factors is None:
        for trade_date, bar in bars:
            stats.bump("STRUCT-06")
            if trade_date is None:
                continue
            factor_by_date[trade_date] = Decimal("1.0")
    else:
        for row in case.factors:
            fdate = parse_date(row.get("trade_date"))
            factor = parse_decimal(row.get("factor"))
            stats.bump("STRUCT-06")
            if fdate is None or factor is None:
                stats.flag("STRUCT-06", f"因子行不可解析: {row!r}", iid)
                continue
            factor_by_date[fdate] = factor
            if factor <= 0:
                stats.flag("STRUCT-06", f"复权因子必须 > 0: {factor}", iid, fdate.isoformat())
        for trade_date, _bar in bars:
            stats.bump("STRUCT-06")
            if trade_date is not None and trade_date not in factor_by_date:
                stats.flag("STRUCT-06", f"该 bar 缺复权因子: {trade_date}", iid, trade_date.isoformat())

    # ---------------- 业务规则 ----------------
    for trade_date, bar in bars:
        td_text = trade_date.isoformat() if trade_date else None
        first_day = trade_date is not None and listed_at is not None and trade_date == listed_at
        if (name.startswith(("ST", "*ST")) and trade_date is not None
                and dim_as_of is not None and trade_date < dim_as_of.date()):
            stats.bump("BIZ-03")
            stats.flag(
                "BIZ-03",
                f"ST 按当期名称快照判定（dim.as_of={dim_as_of.date()}），{trade_date} 早于快照；"
                "历史 ST 状态未还原（L80 known limitation，warn）",
                iid,
                td_text,
            )
        if first_day:
            continue  # 上市首日：无涨跌幅限制、无前收基准（BIZ-01/BIZ-02 豁免）
        prev_close = parse_decimal(bar.get("prev_close"))
        stats.bump("BIZ-02")
        if prev_close is None:
            stats.flag("BIZ-02", "缺涨跌幅基准 prev_close（告警，不阻断）", iid, td_text)
            continue
        close = parse_decimal(bar.get("close"))
        stats.bump("BIZ-01")
        if close is not None and prev_close > 0:
            change_pct = (close / prev_close - 1) * 100
            if abs(change_pct) > limit_pct + tolerance:
                stats.flag(
                    "BIZ-01",
                    f"涨跌幅 {change_pct:.4f}% 超出板块幅度 {limit_pct}%±{tolerance}pp",
                    iid,
                    td_text,
                )

    # ---------------- 完整性 / 及时性 ----------------
    for trade_date, bar in bars:
        stats.bump("COMP-01")
        if trade_date is not None and trade_date.weekday() >= 5:
            stats.flag("COMP-01", f"周末不得生成 bar: {trade_date}", iid, trade_date.isoformat())

    trade_dates = [td for td, _ in bars if td is not None]
    suspended_dates = {d for d in (parse_date(item) for item in case.suspended) if d is not None}
    stats.bump("COMP-02")
    as_of = parse_datetime(case.as_of)
    if as_of is None:
        stats.flag("COMP-02", f"as_of 缺失或不可解析: {case.as_of!r}", iid)
    else:
        if as_of.time().replace(tzinfo=None) < CLOSE_TIME:
            stats.flag("COMP-02", f"as_of={as_of.isoformat()} 早于当日 15:00（T 日收盘后取数）", iid)
        if trade_dates and as_of.date() < max(trade_dates):
            stats.flag("COMP-02", f"as_of 日期 {as_of.date()} 早于最新 bar {max(trade_dates)}", iid)

    covered = set(trade_dates) | suspended_dates
    if covered:
        start, end = min(covered), max(covered)
        cursor = start
        while cursor <= end:
            if cursor.weekday() < 5:
                stats.bump("COMP-03")
                if cursor not in covered:
                    stats.flag("COMP-03", f"工作日缺 bar 且无停牌证据: {cursor}", iid, cursor.isoformat())
            cursor += timedelta(days=1)

    # ---------------- 一致性 ----------------
    for index in range(1, len(bars)):
        prev_date, prev_bar = bars[index - 1]
        trade_date, bar = bars[index]
        bar_iid = bar.get("instrument_id") or iid
        stats.bump("CONS-01")
        if trade_date is not None and listed_at is not None and trade_date == listed_at:
            continue
        prev_close = parse_decimal(bar.get("prev_close"))
        if prev_close is None:
            continue  # BIZ-02 已告警
        prior_close = parse_decimal(prev_bar.get("close"))
        if prior_close is None:
            continue
        factor_changed = (
            prev_date is not None
            and trade_date is not None
            and factor_by_date.get(prev_date) != factor_by_date.get(trade_date)
        )
        if factor_changed:
            continue  # 除权除息日：prev_close = 除权参考价，不是前一日 close
        if prev_close != prior_close:
            stats.flag(
                "CONS-01",
                f"prev_close={prev_close} ≠ 前一交易日 close={prior_close}",
                bar_iid,
                trade_date.isoformat() if trade_date else None,
            )

    declared = set(pack.declared_instruments) | {iid}
    for _trade_date, bar in bars:
        bar_iid = bar.get("instrument_id") or iid
        stats.bump("CONS-02")
        if bar_iid not in declared:
            stats.flag("CONS-02", f"bar 引用未登记标的: {bar_iid}", bar_iid)
    for row in case.factors or []:
        factor_iid = row.get("instrument_id") or iid
        stats.bump("CONS-02")
        if factor_iid not in declared:
            stats.flag("CONS-02", f"因子引用未登记标的: {factor_iid}", factor_iid)

    return _report(case.case_id, stats, policy)


# --------------------------------------------------------------------------
# 评分与分档
# --------------------------------------------------------------------------


def compute_score(
    evaluated: dict[str, int],
    violations: list[Violation],
    policy: dict[str, Any],
) -> tuple[float, dict[str, float]]:
    """按 L9 口径算分：只由 blocker 计分，按「命中的规则条数 / 类别规则总数」扣分。

    类别分 = 100 × (1 − 该类别命中 blocker 的**不同规则数** / 该类别规则总数)；
    warn 不进分子分母（展示用）；evaluated 保留给覆盖率检查，不参与算分。

    与 A2 现行实现（warehouse/quality/checks.py 用「违规条数/评估条数」）不同，
    差异已报 H4/A2 同步（decision L9，待 H4 会签；docs/metrics/P0-metrics.md §6 需同步）。
    """
    category_scores: dict[str, float] = {}
    for category in CATEGORY_ORDER:
        rule_ids = [rid for rid, meta in policy["rules"].items() if meta["category"] == category]
        if not rule_ids:
            category_scores[category] = 100.0
            continue
        hit_rules = {
            v.rule_id
            for v in violations
            if v.severity == "blocker" and v.rule_id in rule_ids
        }
        category_scores[category] = max(0.0, 100.0 * (1 - len(hit_rules) / len(rule_ids)))
    score = round(sum(policy["weights"][c] * category_scores[c] for c in CATEGORY_ORDER), 2)
    return score, category_scores


def grade_for(score: float, has_blocker: bool, policy: dict[str, Any]) -> tuple[str, bool]:
    thresholds = policy["thresholds"]
    if has_blocker and policy.get("blocker_blocks_downstream", True):
        return "black", True
    if score >= thresholds["green"]:
        return "green", False
    if score >= thresholds["yellow"]:
        return "yellow", False
    if score >= thresholds["red"]:
        return "red", False
    return "black", True


def _report(case_id: str, stats: _Stats, policy: dict[str, Any]) -> CaseReport:
    score, category_scores = compute_score(stats.evaluated, stats.violations, policy)
    has_blocker = any(v.severity == "blocker" for v in stats.violations)
    grade, blocked = grade_for(score, has_blocker, policy)
    return CaseReport(
        case_id=case_id,
        violations=stats.violations,
        rule_ids=stats.rule_ids(),
        evaluated=stats.evaluated,
        category_scores=category_scores,
        score=score,
        grade=grade,
        blocked=blocked,
    )
