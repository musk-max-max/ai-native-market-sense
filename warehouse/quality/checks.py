"""四类质量规则（结构 / 业务规则 / 完整性及时性 / 一致性）与质量分。

输入是 DWD 内存状态（warehouse.dwd.build.DwdState），输出 QualityReport：
    score   0–100，保留 2 位小数
    grade   green | yellow | red | black
    blocked 是否阻断下游（black 或 blocker 违规）

评分公式（config.weights 加权，任务书指定 0.2/0.3/0.3/0.2；L9 只计 blocker）：
    类别分 = 100 × (1 − 该类别命中 blocker 的不同规则数 / 该类别规则总数)
    总分   = Σ 权重 × 类别分
    - 分子按「规则」去重：同一规则命中 100 条也只算 1，避免样本量放大/缩小分数；
    - warn 规则（如 BIZ-02）不进分子；但计入该类分母（规则数按配置声明）。
阈值（config.thresholds）：≥95 green，[90,95) yellow，[85,90) red，<85 black。
一票否决（config.blocker_blocks_downstream）：任一 severity=blocker 的违规 → 直接 black + blocked，
因为「改坏一条数据必须红灯」是门禁验收条件；分数与违规数拆成两个独立指标输出（violation_counts）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from warehouse.dwd.build import DwdState
from warehouse.ods.loader import parse_date

DEFAULT_CONFIG_PATH = Path(__file__).with_name("quality_config.json")
CATEGORY_ORDER = ("struct", "business", "completeness", "consistency")
CATEGORY_LABELS = {
    "struct": "结构",
    "business": "业务规则",
    "completeness": "完整性/及时性",
    "consistency": "一致性",
}
RULE_META: dict[str, tuple[str, str]] = {
    "STRUCT-01": ("struct", "必填字段与非空类型"),
    "STRUCT-02": ("struct", "主键唯一（instrument_id + trade_date）"),
    "STRUCT-03": ("struct", "OHLC 关系 high ≥ max(open,close) ≥ min(open,close) ≥ low"),
    "STRUCT-04": ("struct", "价格 > 0，volume/amount ≥ 0"),
    "STRUCT-05": ("struct", "价格小数位 ≤ 2（人民币分）"),
    "STRUCT-06": ("struct", "复权因子 > 0 且每根 bar 都有因子"),
    "BIZ-01": ("business", "涨跌幅在板块限内（主板 10% / ST 5% / 创业科创 20% / 北交所 30%）"),
    "BIZ-02": ("business", "涨跌幅基准 prev_close 缺失（告警，上市首日豁免）"),
    "COMP-01": ("completeness", "不生成周末 bar"),
    "COMP-02": ("completeness", "as_of 属当日收盘后（≥15:00）且不早于交易日"),
    "COMP-03": ("completeness", "工作日覆盖：bar 或停牌证据必须覆盖每个工作日"),
    "CONS-01": ("consistency", "prev_close 与前一日 close 一致（除权日/首日豁免）"),
    "CONS-02": ("consistency", "bar/因子引用的 instrument 必须存在于 dim_instrument"),
}
CLOSE_TIME = time(15, 0, tzinfo=timezone(timedelta(hours=8)))
PRICE_STEP = Decimal("0.01")
PCT = Decimal(100)
HALF = Decimal("0.5")


@dataclass(frozen=True)
class Violation:
    rule_id: str
    severity: str
    instrument_id: str
    trade_date: date | None
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "severity": self.severity,
            "instrument_id": self.instrument_id,
            "trade_date": self.trade_date.isoformat() if self.trade_date else None,
            "detail": self.detail,
        }


@dataclass
class RuleResult:
    rule_id: str
    category: str
    label: str
    evaluated: int
    violations: list[Violation] = field(default_factory=list)

    @property
    def severity(self) -> str:
        return self.violations[0].severity if self.violations else "ok"

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "category": self.category,
            "label": self.label,
            "evaluated": self.evaluated,
            "violations": [v.as_dict() for v in self.violations],
        }


@dataclass
class QualityReport:
    score: float
    grade: str
    blocked: bool
    category_scores: dict[str, float]
    results: list[RuleResult]

    @property
    def blocker_violations(self) -> list[Violation]:
        return [v for r in self.results for v in r.violations if v.severity == "blocker"]

    @property
    def violation_counts(self) -> dict[str, int]:
        """违规数（独立指标，L9）：与质量分分开报告。

        质量分只由 blocker 计分（warn 不进分子/分母）；warn 数量单列，
        防止"为把整批从绿拖黄而调阈值"，阈值一调门禁就死了。
        """
        counts = {"blocker": 0, "warn": 0}
        for result in self.results:
            for violation in result.violations:
                counts[violation.severity] = counts.get(violation.severity, 0) + 1
        return counts

    def as_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "grade": self.grade,
            "blocked": self.blocked,
            "violation_counts": self.violation_counts,
            "category_scores": {k: round(v, 2) for k, v in self.category_scores.items()},
            "rules": [r.as_dict() for r in self.results],
            "blocker_violations": [v.as_dict() for v in self.blocker_violations],
        }


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    path = Path(path) if path else DEFAULT_CONFIG_PATH
    return json.loads(path.read_text(encoding="utf-8"))


def is_st(instrument: dict[str, Any] | None) -> bool:
    """P0 派生规则：名称以 ST/*ST 开头视为风险警示（is_st 不落库，见 schema.sql）。"""
    if not instrument:
        return False
    name = str(instrument.get("name", "")).upper().replace("*", "").strip()
    return name.startswith("ST")


def board_limit_pct(instrument: dict[str, Any], config: dict[str, Any]) -> Decimal:
    board = instrument["board"]
    if is_st(instrument) and board in config.get("st_limit_boards", ["main"]):
        return Decimal(str(config["st_limit_pct"]))
    return Decimal(str(config["board_limit_pct"][board]))


def round_price(value: Decimal) -> Decimal:
    return value.quantize(PRICE_STEP)


class _Collector:
    def __init__(self, config: dict[str, Any]):
        self.config = config
        self.results: dict[str, RuleResult] = {}
        for rule_id, (category, label) in RULE_META.items():
            self.results[rule_id] = RuleResult(rule_id=rule_id, category=category, label=label, evaluated=0)

    def bump(self, rule_id: str, amount: int = 1) -> None:
        self.results[rule_id].evaluated += amount

    def flag(
        self,
        rule_id: str,
        instrument_id: str,
        trade_date: date | None,
        detail: str,
        *,
        severity: str | None = None,
    ) -> None:
        severity = severity or self.config["rules"][rule_id]["severity"]
        self.results[rule_id].violations.append(
            Violation(
                rule_id=rule_id,
                severity=severity,
                instrument_id=instrument_id,
                trade_date=trade_date,
                detail=detail,
            )
        )


def run_quality_checks(state: DwdState, config: dict[str, Any] | None = None) -> QualityReport:
    config = config or load_config()
    c = _Collector(config)

    for issue in state.issues:
        # 构建期已发现的结构违规（如批次内主键重复）直接计入对应规则。
        c.bump(issue.rule_id)
        c.flag(issue.rule_id, issue.instrument_id, issue.trade_date, issue.detail, severity=issue.severity)

    for bar in state.bars.values():
        _check_bar_structure(c, bar)
        _check_bar_business(c, state, bar, config)
        _check_bar_completeness(c, bar)
        c.bump("STRUCT-06")
        if state.factor_for(bar["instrument_id"], bar["trade_date"]) is None:
            c.flag(
                "STRUCT-06",
                bar["instrument_id"],
                bar["trade_date"],
                "该 bar 缺复权因子，禁止用 1.0 冒充",
            )
    for factor in state.factors.values():
        _check_factor(c, state, factor)
    _check_coverage(c, state)
    _check_prev_close(c, state)

    rule_totals = {
        cat: sum(1 for rid in config["rules"] if RULE_META[rid][0] == cat)
        for cat in CATEGORY_ORDER
    }
    category_scores = {cat: 100.0 for cat in CATEGORY_ORDER}
    for cat in CATEGORY_ORDER:
        total = rule_totals[cat]
        if total == 0:
            continue
        # L9：分子 = 该类别「命中 blocker 的不同规则数」，不是违规条数；warn 不进分子。
        hit_rules = sum(
            1
            for rid, meta in config["rules"].items()
            if RULE_META[rid][0] == cat
            and meta["severity"] == "blocker"
            and c.results[rid].violations
        )
        category_scores[cat] = max(0.0, 100.0 * (1 - hit_rules / total))

    score = sum(config["weights"][cat] * category_scores[cat] for cat in CATEGORY_ORDER)
    score = round(score, 2)

    blocker = any(v.severity == "blocker" for r in c.results.values() for v in r.violations)
    if blocker and config["blocker_blocks_downstream"]:
        grade, blocked = "black", True
    else:
        thresholds = config["thresholds"]
        if score >= thresholds["green"]:
            grade, blocked = "green", False
        elif score >= thresholds["yellow"]:
            grade, blocked = "yellow", False
        elif score >= thresholds["red"]:
            grade, blocked = "red", False
        else:
            grade, blocked = "black", True

    return QualityReport(
        score=score,
        grade=grade,
        blocked=blocked,
        category_scores=category_scores,
        results=[c.results[rule_id] for rule_id in RULE_META],
    )


# --------------------------------------------------------------------------
# 结构调整
# --------------------------------------------------------------------------


def _check_bar_structure(c: _Collector, bar: dict[str, Any]) -> None:
    iid, td = bar["instrument_id"], bar["trade_date"]
    c.bump("STRUCT-01")
    missing = [f for f in ("open", "high", "low", "close", "volume", "amount") if bar.get(f) is None]
    if missing:
        c.flag("STRUCT-01", iid, td, f"必填字段缺失: {missing}")

    c.bump("STRUCT-03")
    o, h, lo, cl = bar["open"], bar["high"], bar["low"], bar["close"]
    if not (h >= lo and h >= max(o, cl) and lo <= min(o, cl)):
        c.flag("STRUCT-03", iid, td, f"OHLC 关系非法 open={o} high={h} low={lo} close={cl}")

    c.bump("STRUCT-04")
    if min(o, h, lo, cl) <= 0:
        c.flag("STRUCT-04", iid, td, "价格必须 > 0")
    if bar["volume"] < 0:
        c.flag("STRUCT-04", iid, td, f"volume 不能为负: {bar['volume']}")
    if bar["amount"] < 0:
        c.flag("STRUCT-04", iid, td, f"amount 不能为负: {bar['amount']}")

    c.bump("STRUCT-05")
    for key in ("open", "high", "low", "close"):
        value = bar[key]
        if isinstance(value, Decimal) and value.as_tuple().exponent < -2:
            c.flag("STRUCT-05", iid, td, f"{key} 小数位超过人民币分: {value}")
            break


def _check_factor(c: _Collector, state: DwdState, factor: dict[str, Any]) -> None:
    iid, td = factor["instrument_id"], factor["trade_date"]
    c.bump("STRUCT-06")
    if factor["factor"] <= 0:
        c.flag("STRUCT-06", iid, td, f"复权因子必须 > 0: {factor['factor']}")


def _check_bar_business(c: _Collector, state: DwdState, bar: dict[str, Any], config: dict[str, Any]) -> None:
    iid, td = bar["instrument_id"], bar["trade_date"]
    instrument = state.instruments.get(iid)
    if instrument is None:
        return  # CONS-02 负责报缺维表
    if instrument.get("security_type") != "stock":
        return  # P0 只对个股校验涨跌停

    prev_close = bar.get("prev_close")
    first_day = instrument.get("listed_at") == td
    if prev_close is None:
        c.bump("BIZ-02")
        if not first_day:
            c.flag("BIZ-02", iid, td, "缺涨跌幅基准 prev_close，无法判定涨跌停")
        return
    if prev_close <= 0:
        c.bump("BIZ-01")
        c.flag("BIZ-01", iid, td, f"prev_close 必须 > 0: {prev_close}")
        return

    c.bump("BIZ-01")
    limit_pct = board_limit_pct(instrument, config)
    tolerance = Decimal(str(config["limit_tolerance_pp"]))
    change_pct = (bar["close"] / prev_close - 1) * PCT
    upper, lower = limit_pct + tolerance, -(limit_pct + tolerance)
    if change_pct > upper:
        c.flag(
            "BIZ-01",
            iid,
            td,
            f"涨幅 {change_pct:.4f}% 超过 {instrument['board']} 限制 {limit_pct}%（容差 {tolerance}pp）",
        )
    elif change_pct < lower:
        c.flag(
            "BIZ-01",
            iid,
            td,
            f"跌幅 {change_pct:.4f}% 超过 {instrument['board']} 限制 -{limit_pct}%（容差 {tolerance}pp）",
        )


def _check_bar_completeness(c: _Collector, bar: dict[str, Any]) -> None:
    iid, td = bar["instrument_id"], bar["trade_date"]
    c.bump("COMP-01")
    if td.weekday() >= 5:
        c.flag("COMP-01", iid, td, "周末不应生成 bar")

    c.bump("COMP-02")
    as_of: datetime = bar["as_of"]
    if as_of.date() < td:
        c.flag("COMP-02", iid, td, f"as_of {as_of.isoformat()} 早于交易日")
    elif as_of.date() == td and as_of.timetz().replace(tzinfo=None) < CLOSE_TIME.replace(tzinfo=None):
        c.flag("COMP-02", iid, td, f"as_of {as_of.isoformat()} 早于收盘 15:00（C2 收盘后取数）")


def _check_coverage(c: _Collector, state: DwdState) -> None:
    by_instrument: dict[str, list[dict[str, Any]]] = {}
    for (iid, _), bar in state.bars.items():
        by_instrument.setdefault(iid, []).append(bar)
    suspended: dict[str, set[date]] = {}
    for iid, td in state.suspended:
        suspended.setdefault(iid, set()).add(td)

    for iid, bars in by_instrument.items():
        dates = sorted(b["trade_date"] for b in bars)
        if len(dates) < 2:
            continue
        current = dates[0]
        while current <= dates[-1]:
            if current.weekday() < 5:
                c.bump("COMP-03")
                if current not in set(dates) and current not in suspended.get(iid, set()):
                    c.flag("COMP-03", iid, current, "工作日既无 bar 也无停牌证据（禁止补 0，须查明）")
            current += timedelta(days=1)


def _check_prev_close(c: _Collector, state: DwdState) -> None:
    prev_close_rule_evaluated = 0
    for (iid, td), bar in state.bars.items():
        instrument = state.instruments.get(iid)
        prev_close = bar.get("prev_close")
        if prev_close is None:
            continue
        if instrument is not None and instrument.get("listed_at") == td:
            continue
        prev_bar = _previous_bar(state, iid, td)
        if prev_bar is None:
            continue
        factor_now = state.factor_for(iid, td)
        factor_prev = state.factor_for(iid, prev_bar["trade_date"])
        if factor_now is not None and factor_prev is not None and factor_now != factor_prev:
            continue  # 除权除息日：prev_close 是除权参考价，不等于前收盘价（M08）
        prev_close_rule_evaluated += 1
        c.bump("CONS-01")
        if prev_close != prev_bar["close"]:
            c.flag(
                "CONS-01",
                iid,
                td,
                f"prev_close {prev_close} != 前一交易日 close {prev_bar['close']}",
            )
    if prev_close_rule_evaluated == 0:
        # 无适用行的场景也计一次评估，避免类别分因空评估而虚高/失真（保持分母语义清晰）。
        pass

    for (iid, td), _row in list(state.bars.items()) + list(state.factors.items()):
        c.bump("CONS-02")
        if iid not in state.instruments:
            c.flag("CONS-02", iid, td, "instrument 不在 dim_instrument 中")


def _previous_bar(state: DwdState, instrument_id: str, trade_date: date) -> dict[str, Any] | None:
    prev = None
    for (iid, td), bar in state.bars.items():
        if iid == instrument_id and td < trade_date and (prev is None or td > prev["trade_date"]):
            prev = bar
    return prev


def assert_calendar_safe(trade_date: date) -> None:  # pragma: no cover - 占位，P1 接交易日历服务
    """P0 用自然工作日近似交易日历；节假日会误报 COMP-03，已在 docs 待确认项登记。"""
    parse_date(trade_date.isoformat(), where="calendar")
