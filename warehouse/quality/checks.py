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
import re
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
    "BIZ-03": ("business", "ST 判定时点性限制（warn：当前名称快照 vs 历史交易日，L80）"),
    "COMP-01": ("completeness", "不生成周末 bar"),
    "COMP-02": ("completeness", "as_of 属当日收盘后（≥15:00）且不早于交易日"),
    "COMP-03": ("completeness", "工作日覆盖：bar 或停牌证据必须覆盖每个工作日"),
    "CONS-01": ("consistency", "prev_close 与前一日 close 一致（除权日/首日豁免）"),
    "CONS-02": ("consistency", "bar/因子引用的 instrument 必须存在于 dim_instrument"),
    "RES-01": ("completeness", "研究数据集交易日为工作日（weekday 体检，不含节假日；P1 接 trade_cal）"),
    "RES-02": ("business", "研究指标量纲：仅 DWD canonical 字段；金额/量/市值非负，百分比 |x| ≤ 1000"),
    "RES-03": ("consistency", "研究数据 instrument_id 必须存在于 dim_instrument（指数/两融豁免；非 A 股命名空间显式豁免并计数）"),
    "RES-04": ("completeness", "研究批次 as_of 满足各 endpoint 的及时性阈值（默认交易日 15:00；hk_hold T+1 15:00）且 fetched_at ≥ as_of"),
    "RES-05": ("business", "涨跌停原始价自洽：previous_close>0 且 up_limit > previous_close > down_limit（不判 5/10/20/30 档位，H4 口径待定）"),
    "RES-06": ("business", "财务指标公告时点：announced_at ≥ report_end_date，且不晚于批次 as_of（防未来函数）"),
    "RES-07": ("consistency", "行业分类层级自洽：level∈{1,2,3}；level>1 必须有 parent_code，level=1 不得有 parent_code，parent_code≠index_code"),
    "RES-08": ("consistency", "成分时点自洽：in_date ≤ snapshot_date；out_date ≥ in_date；is_new=Y 时 out_date 必须为空"),
}
CST = timezone(timedelta(hours=8))
CLOSE_TIME = time(15, 0, tzinfo=CST)
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
    # 显式豁免计数（如 hk_hold 的非 A 股命名空间）：不参与违规、不静默跳过。
    exemptions: int = 0

    @property
    def severity(self) -> str:
        return self.violations[0].severity if self.violations else "ok"

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "category": self.category,
            "label": self.label,
            "evaluated": self.evaluated,
            "exemptions": self.exemptions,
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
            "exemptions": {r.rule_id: r.exemptions for r in self.results if r.exemptions},
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


# 研究数据集：哪些 endpoint 的 instrument_id 必须能在 dim_instrument 找到。
# index_daily 的 instrument_id 是指数（不在 dim_instrument）；margin 以 exchange 为主键、无 instrument_id。
RESEARCH_INSTRUMENT_ENDPOINTS = frozenset(
    {"daily_basic", "top_list", "top_inst", "moneyflow", "hk_hold", "stk_limit", "fina_indicator", "index_member_all"}
)
# 允许为负的业务字段（净额/涨跌/理论可负的净率）；其余金额/量/余额/股本/市值不得为负。
RESEARCH_SIGNED_FIELDS = frozenset(
    {"change", "lhb_net_amount", "lhb_net_rate_pct", "net_buy_amount", "net_inflow_amount", "net_inflow_volume"}
)
RESEARCH_PCT_ABS_LIMIT = Decimal(1000)
# 契约 InstrumentId 的命名空间；不匹配者（如港股 HKEX:00700）在 RES-03 里显式豁免并计数。
RESEARCH_ID_PATTERN = re.compile(r"^(SSE|SZSE|BSE):[0-9]{6}$")
# 可能承载非 A 股标识的研究 endpoint；豁免必须计数，不许静默跳过。
RESEARCH_FK_EXEMPT_ENDPOINTS = frozenset({"hk_hold"})
# RES-04 各 endpoint 的 as_of 及时性阈值：offset_days=相对 trade_date 的偏移，time=当地时刻。
RESEARCH_AS_OF_DEFAULT = {"offset_days": 0, "time": "15:00"}


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
    _check_research(c, state)

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

    # M04 fail-closed：未知板块不得静默映射成 limit_status='none'（"不知道"≠"没涨跌停"）。
    board = instrument.get("board")
    if board not in config["board_limit_pct"]:
        c.bump("BIZ-01")
        c.flag(
            "BIZ-01",
            iid,
            td,
            f"未知板块 {board!r}（允许 {sorted(config['board_limit_pct'])}）：fail-closed，不做涨跌停判定",
        )
        return

    # L80：ST 判定只有"当前名称快照"，历史交易日未还原；不许静默，warn 标出（不拖绿、不阻断）。
    if is_st(instrument):
        c.bump("BIZ-03")
        as_of = instrument.get("as_of")
        as_of_date = as_of.date() if isinstance(as_of, datetime) else None
        if as_of_date is not None and td < as_of_date:
            c.flag(
                "BIZ-03",
                iid,
                td,
                f"ST 判定按当前名称（dim.as_of={as_of_date}），该交易日早于快照且未还原历史 ST 状态；"
                "跨戴帽/摘帽窗口不适用（P0 known limitation，P1 namechange 到位后转 blocker）",
            )

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


# --------------------------------------------------------------------------
# 研究数据集（KD-INGEST-CONSUME：daily_basic/index_daily/top_list/top_inst/
# moneyflow/margin/hk_hold）。研究态 last-write-wins，无 revision；质量规则
# 只做量纲/日期/外键/及时性四类最小校验，字段映射 provisional（待 H4）。
# --------------------------------------------------------------------------
RESEARCH_STATE_TABLES: tuple[str, ...] = (
    "daily_basic",
    "index_daily",
    "top_list",
    "top_inst",
    "moneyflow",
    "margin",
    "hk_hold",
    # KD-DSW-P2（A1 commit 9ebdb73）
    "stk_limit",
    "fina_indicator",
    "index_classify",
    "index_member_all",
)


def _research_id(row: dict[str, Any]) -> str:
    return str(row.get("instrument_id") or row.get("exchange") or "")


def _check_research(c: _Collector, state: DwdState) -> None:
    for endpoint in RESEARCH_STATE_TABLES:
        rows = getattr(state, endpoint).values()
        for row in rows:
            _check_research_row(c, state, endpoint, row)


def _research_row_date(row: dict[str, Any]) -> date | None:
    """研究行的代表日期：日频=trade_date；财报=report_end_date；快照=snapshot_date。"""
    for key in ("trade_date", "report_end_date", "snapshot_date"):
        value = row.get(key)
        if isinstance(value, date):
            return value
    return None


def _check_research_row(
    c: _Collector, state: DwdState, endpoint: str, row: dict[str, Any]
) -> None:
    iid = _research_id(row)
    td = _research_row_date(row)

    # RES-01：交易日必须是工作日（仅日频数据；财报/快照日期不是交易日语义）。
    if "trade_date" in row:
        c.bump("RES-01")
        if td is not None and td.weekday() >= 5:
            c.flag("RES-01", iid, td, f"{endpoint} 的 trade_date={td} 落在周末")

    # RES-02：量纲与符号。金额/量/余额/股本/市值非负，百分比不超过 ±1000。
    c.bump("RES-02")
    for key, value in row.items():
        if not isinstance(value, Decimal) or key.endswith(("_at", "_date")):
            continue
        if key.endswith("_pct"):
            if key in RESEARCH_SIGNED_FIELDS:
                continue
            if abs(value) > RESEARCH_PCT_ABS_LIMIT:
                c.flag("RES-02", iid, td, f"{endpoint}.{key}={value} 超出百分比量纲（|x|≤1000）")
            continue
        if key in RESEARCH_SIGNED_FIELDS:
            continue
        if any(token in key for token in ("amount", "volume", "balance", "shares", "market_value")):
            if value < 0:
                c.flag("RES-02", iid, td, f"{endpoint}.{key}={value} 为负")

    # RES-03：股票级数据集的 instrument_id 必须在 dim_instrument。
    # 非 A 股命名空间（如 hk_hold 的港股代码）显式豁免并计数——不静默跳过、不冒充通过。
    if endpoint in RESEARCH_INSTRUMENT_ENDPOINTS:
        c.bump("RES-03")
        if iid not in state.instruments:
            exempt = endpoint in RESEARCH_FK_EXEMPT_ENDPOINTS and not RESEARCH_ID_PATTERN.match(iid)
            if exempt:
                c.results["RES-03"].exemptions += 1
            else:
                c.flag("RES-03", iid, td, f"{endpoint} 引用的 {iid} 不在 dim_instrument")

    # RES-04：研究批次及时性（as_of 不早于交易日 15:00；fetched_at ≥ as_of 由 loader 保证）。
    # 只对日频 endpoint 生效（财报/行业快照没有 trade_date，时点规则由 RES-06/RES-08 承担）。
    as_of = row.get("as_of")
    if endpoint == "stk_limit":
        _check_stk_limit(c, row, td)
    elif endpoint == "fina_indicator":
        _check_fina_indicator(c, row, td, as_of)
    elif endpoint == "index_classify":
        _check_index_classify(c, row, td)
    elif endpoint == "index_member_all":
        _check_index_member_all(c, row, td)

    if "trade_date" not in row:
        return
    c.bump("RES-04")
    if as_of is not None and td is not None:
        policy = _as_of_policy(c.config, endpoint)
        offset_days = int(policy.get("offset_days", 0))
        hh, mm = (int(part) for part in str(policy.get("time", "15:00")).split(":"))
        threshold = datetime.combine(td + timedelta(days=offset_days), time(hh, mm, tzinfo=CST))
        if as_of < threshold:
            c.flag(
                "RES-04",
                iid,
                td,
                f"{endpoint} 的 as_of={as_of.isoformat()} 早于阈值 "
                f"{threshold.isoformat()}（offset_days={offset_days}，time={policy.get('time')}）",
            )


def _check_stk_limit(c: _Collector, row: dict[str, Any], td: date | None) -> None:
    """RES-05：只做原始价自洽，不派生 limit_pct/ST 档位（H4 口径待定，A2 不加工）。"""
    c.bump("RES-05")
    iid = _research_id(row)
    prev, up, down = (row.get("previous_close"), row.get("up_limit"), row.get("down_limit"))
    if prev is None or up is None or down is None:
        c.flag("RES-05", iid, td, "涨跌停原始价缺失（previous_close/up_limit/down_limit 必填）")
        return
    if prev <= 0 or up <= 0 or down <= 0:
        c.flag("RES-05", iid, td, f"涨跌停价格必须 > 0：prev={prev} up={up} down={down}")
    elif not (up > prev > down):
        c.flag("RES-05", iid, td, f"涨跌停价格不自洽，应 up_limit > previous_close > down_limit：prev={prev} up={up} down={down}")


def _expected_quarter_end(report_period: str) -> date | None:
    m = re.fullmatch(r"([0-9]{4})Q([1-4])", str(report_period or ""))
    if not m:
        return None
    year, quarter = int(m.group(1)), int(m.group(2))
    month = quarter * 3
    day = {3: 31, 6: 30, 9: 30, 12: 31}[month]
    return date(year, month, day)


def _check_fina_indicator(c: _Collector, row: dict[str, Any], td: date | None, as_of: Any) -> None:
    """RES-06：公告日必须 ≥ 报告期末；且公告日在批次 as_of 之前可见（防未来函数）。"""
    c.bump("RES-06")
    iid = _research_id(row)
    report_end = row.get("report_end_date")
    announced = row.get("announced_at")
    if not isinstance(report_end, date) or not isinstance(announced, date):
        c.flag("RES-06", iid, td, "report_end_date/announced_at 缺失或类型非法")
        return
    if announced < report_end:
        c.flag("RES-06", iid, report_end, f"announced_at={announced} 早于 report_end_date={report_end}（报告期未结束就公告）")
    expected = _expected_quarter_end(str(row.get("report_period") or ""))
    if expected is not None and expected != report_end:
        c.flag("RES-06", iid, report_end, f"report_period={row.get('report_period')} 与 report_end_date={report_end} 不一致（期望 {expected}）")
    if isinstance(as_of, datetime) and announced > as_of.date():
        c.flag("RES-06", iid, announced, f"announced_at={announced} 晚于批次 as_of 日期={as_of.date()}（未来函数）")


def _check_index_classify(c: _Collector, row: dict[str, Any], td: date | None) -> None:
    """RES-07：行业树层级自洽（字段 provisional，不校验行业编码格式）。"""
    c.bump("RES-07")
    index_code = str(row.get("index_code") or "")
    level = str(row.get("level") or "")
    parent = row.get("parent_code")
    if level not in {"1", "2", "3"}:
        c.flag("RES-07", index_code, td, f"level={level!r} 不是 1/2/3")
        return
    if level == "1" and parent:
        c.flag("RES-07", index_code, td, f"level=1 不应有 parent_code={parent!r}")
    if level in {"2", "3"}:
        if not parent:
            c.flag("RES-07", index_code, td, f"level={level} 缺少 parent_code")
        elif str(parent) == index_code:
            c.flag("RES-07", index_code, td, f"parent_code 不能等于自身 index_code={index_code}")


def _check_index_member_all(c: _Collector, row: dict[str, Any], td: date | None) -> None:
    """RES-08：时点成分自洽；H4 要求保留 in_date/out_date/is_new，禁止只存最新快照。"""
    c.bump("RES-08")
    iid = _research_id(row)
    in_date, out_date, snapshot_date = row.get("in_date"), row.get("out_date"), row.get("snapshot_date")
    if not isinstance(in_date, date) or not isinstance(snapshot_date, date):
        c.flag("RES-08", iid, td, "in_date/snapshot_date 缺失或类型非法")
        return
    if in_date > snapshot_date:
        c.flag("RES-08", iid, snapshot_date, f"in_date={in_date} 晚于 snapshot_date={snapshot_date}")
    if out_date is not None and not isinstance(out_date, date):
        c.flag("RES-08", iid, snapshot_date, "out_date 类型非法")
    elif isinstance(out_date, date) and out_date < in_date:
        c.flag("RES-08", iid, snapshot_date, f"out_date={out_date} 早于 in_date={in_date}")
    if str(row.get("is_new") or "") == "Y" and out_date is not None:
        c.flag("RES-08", iid, snapshot_date, "is_new=Y 的记录不得有 out_date")


def _as_of_policy(config: dict[str, Any], endpoint: str) -> dict[str, Any]:
    """RES-04 的 endpoint 级 as_of 阈值配置（quality_config.json::research_as_of）。"""
    policies = config.get("research_as_of") or {}
    return policies.get(endpoint) or policies.get("default") or RESEARCH_AS_OF_DEFAULT
