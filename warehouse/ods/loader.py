"""ODS 批次文件读取（A1 → A2 的唯一数据入口）。

交换格式 v1（warehouse/README.md §ODS 交换格式 v1）：

    <ODS_ROOT>/<endpoint>/dt=<YYYY-MM-DD>/<batch_id>.json

批次信封字段（缺一即 OdsFormatError，见 ADR-002 D3：ODS 保留 source/as_of/fetched_at/批次 id）：

    batch_id      非空字符串，同一 endpoint 内唯一（幂等键）
    endpoint      bar | adj_factor | instrument | fundamental
    schema        bar.v1 | adj_factor.v1 | instrument.v1 | fundamental.v1（必须与 endpoint 匹配）
    source        {source, as_of, fetched_at}；as_of/fetched_at 必须是 +08:00 时点
    rows_total    源端返回行数
    rows_rejected 被适配层拒绝的行数
    rows          落地行（canonical，snake_case，金额/价格为十进制字符串）

不变式：rows_total == len(rows) + rows_rejected。

硬约束：canonical 行里禁止出现 tushare 字段名（C01 / ADR-002）；金额与价格禁止 JSON float
（JSON number 会丢精度，必须传字符串）。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterator

INSTRUMENT_ID_RE = re.compile(r"^(SSE|SZSE|BSE):[0-9]{6}$")
# hk_hold 的港股标识命名空间（如 HKEX:00700）；港股不在 A 股 dim_instrument，质量层显式豁免并计数。
HKEX_ID_RE = re.compile(r"^HKEX:[0-9]{5}$")
SOURCE_RE = re.compile(r"^[a-z0-9_.:-]+$")
TZ_SHANGHAI = timedelta(hours=8)

# endpoint -> schema 的唯一映射；新增必须同时改 README 与本处并通知 A1/A0。
ENDPOINT_SCHEMAS: dict[str, str] = {
    "bar": "bar.v1",
    "adj_factor": "adj_factor.v1",
    "instrument": "instrument.v1",
    "fundamental": "fundamental.v1",
    # 研究数据集（KD-AIP0-INF-05 / ADR-007 第 2 批）：只进 internal root + DWD/serving，
    # 不接 C 端契约；字段映射 provisional，保持 A1 canonical 字段名不改写。
    "daily_basic": "daily_basic.v1",
    "index_daily": "index_daily.v1",
    "top_list": "top_list.v1",
    "top_inst": "top_inst.v1",
    "moneyflow": "moneyflow.v1",
    "margin": "margin.v1",
    "hk_hold": "hk_hold.v1",
    # 研究数据集第三批（A1 research-ods-smoke）：涨跌停价、财务指标、行业分类、指数成分快照。
    "stk_limit": "stk_limit.v1",
    "fina_indicator": "fina_indicator.v1",
    "index_classify": "index_classify.v1",
    "index_member_all": "index_member_all.v1",
}

BAR_FIELDS = ("instrument_id", "trade_date")
BAR_PRICE_FIELDS = ("open", "high", "low", "close")
BAR_VOLUME_FIELDS = ("volume", "amount")
FACTOR_FIELDS = ("instrument_id", "trade_date", "factor")
INSTRUMENT_FIELDS = (
    "instrument_id",
    "exchange",
    "name",
    "board",
    "security_type",
    "list_status",
)
FUNDAMENTAL_REPORT_PERIOD_RE = re.compile(r"^[0-9]{4}Q[1-4]$")
FUNDAMENTAL_STATEMENT_BASES = ("reported", "restated")
FUNDAMENTAL_CURRENCIES = ("CNY",)
FUNDAMENTAL_REQUIRED_DECIMALS = ("revenue", "net_profit")
FUNDAMENTAL_OPTIONAL_DECIMALS = (
    "revenue_yoy_pct",
    "net_profit_yoy_pct",
    "eps",
    "roe_pct",
    "gross_margin_pct",
)
FUNDAMENTAL_FORBIDDEN_KEYS = ("trade_date", "adjustment", "suspended", "factor")

# C01 的落地检查：tushare 概念只允许出现在 services/ingest/adapters/ 内。
FORBIDDEN_ROW_KEYS = frozenset(
    {
        "ts_code",
        "vol",
        "pct_chg",
        "turnover_rate",
        "turnover_rate_f",
        "pe",
        "pe_ttm",
        "pb",
        "total_mv",
        "circ_mv",
    }
)

EXCHANGES = ("SSE", "SZSE", "BSE")
BOARDS = ("main", "gem", "star", "bse")
SECURITY_TYPES = ("stock", "etf", "index")
LIST_STATUSES = ("listed", "delisted", "pre_listed")
BOARD_BY_EXCHANGE = {"SSE": ("main", "star"), "SZSE": ("main", "gem"), "BSE": ("bse",)}

#: 研究数据集 canonical 行规格（schema -> 字段类别）。
#: 字段名/单位由 A1 适配层保证：金额元、量股、比率百分数、十进制字符串；本层只做类型校验。
#: provisional=True（A1）意味着字段清单可能随 H4 对齐变化；这里按当前 canonical 字段固定，
#: 未知扩展字段被忽略（与现有 bar/instrument 行为一致），但不允许数据源字段名泄漏（C01）。
RESEARCH_ENDPOINTS: tuple[str, ...] = (
    "daily_basic",
    "index_daily",
    "top_list",
    "top_inst",
    "moneyflow",
    "margin",
    "hk_hold",
    # 第三批（KD-DSW-P2 / A1 commit 9ebdb73）
    "stk_limit",
    "fina_indicator",
    "index_classify",
    "index_member_all",
)

RESEARCH_ROW_SPECS: dict[str, dict[str, Any]] = {
    "daily_basic.v1": {
        "required": ("close",),
        "decimal": (
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
        ),
        "text": ("limit_status",),
        # C01 允许表：这些名字既是 tushare 源字段，也是 A1 研究数据 canonical 字段
        # （H4 字段映射 provisional）。C01 的用途是禁止适配层之外的原始列名泄漏；
        # pe/pb 在研究域是正式指标名，故按 schema 白名单放行，bar/instrument 仍严格。
        "allowed_source_like": ("pe", "pe_ttm", "pb"),
    },
    "index_daily.v1": {
        "required": ("open", "high", "low", "close", "prev_close", "change", "pct_change_pct"),
        "decimal": (
            "open",
            "high",
            "low",
            "close",
            "prev_close",
            "change",
            "pct_change_pct",
            "amount",
        ),
        "integer": ("volume",),
    },
    "top_list.v1": {
        "required": (
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
        ),
        "decimal": (
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
        ),
        "text": ("name", "reason"),
    },
    "top_inst.v1": {
        "required": (
            "seat_name",
            "side",
            "buy_amount",
            "buy_rate_pct",
            "sell_amount",
            "sell_rate_pct",
            "net_buy_amount",
            "reason",
        ),
        "decimal": (
            "buy_amount",
            "buy_rate_pct",
            "sell_amount",
            "sell_rate_pct",
            "net_buy_amount",
        ),
        "integer": ("side",),
        "text": ("seat_name", "reason"),
    },
    "moneyflow.v1": {
        "required": (),
        "decimal": (
            "buy_small_amount",
            "sell_small_amount",
            "buy_medium_amount",
            "sell_medium_amount",
            "buy_large_amount",
            "sell_large_amount",
            "buy_extra_large_amount",
            "sell_extra_large_amount",
            "net_inflow_amount",
        ),
        "integer": (
            "buy_small_volume",
            "sell_small_volume",
            "buy_medium_volume",
            "sell_medium_volume",
            "buy_large_volume",
            "sell_large_volume",
            "buy_extra_large_volume",
            "sell_extra_large_volume",
            "net_inflow_volume",
        ),
    },
    "margin.v1": {
        "id_field": "exchange",
        "required": (
            "financing_balance",
            "financing_buy_amount",
            "financing_repayment_amount",
            "securities_balance",
            "securities_sell_volume",
            "margin_balance",
            "securities_volume",
        ),
        "decimal": (
            "financing_balance",
            "financing_buy_amount",
            "financing_repayment_amount",
            "securities_balance",
            "margin_balance",
        ),
        "integer": ("securities_sell_volume", "securities_volume"),
        "enums": {"exchange": EXCHANGES},
    },
    "hk_hold.v1": {
        "required": ("name", "holding_volume", "holding_ratio_pct", "northbound_channel"),
        "decimal": ("holding_ratio_pct",),
        "integer": ("holding_volume",),
        "text": ("name", "northbound_channel"),
        "enums": {"northbound_channel": ("SH", "SZ", "HK")},
    },
    # 日频：交易所涨跌停价（asset_type 取值待 A1 确认，先按 text 收）。
    "stk_limit.v1": {
        "required": ("previous_close", "up_limit", "down_limit"),
        # limit_pct 是 A1 已加工的 5/10/20/30 档（H4 口径，A2 不派生、只透传），可空。
        "decimal": ("previous_close", "up_limit", "down_limit", "limit_pct"),
        "text": ("asset_type", "limit_pct_source"),
        "enums": {"exchange": EXCHANGES},
    },
    # 财务指标：dt=report_end_date，行内无 trade_date；45 列中除主键/日期/文本外均为数值。
    "fina_indicator.v1": {
        "required": ("report_end_date", "report_period", "announced_at"),
        "trade_date": False,
        "dates": ("report_end_date", "announced_at"),
        "patterns": {"report_period": FUNDAMENTAL_REPORT_PERIOD_RE},
        "text": ("update_flag",),
        "decimal": ("*",),
        # update_flag 是 tushare fina_indicator 源侧列名，正式 canonical 名待 A1/H4 定；
        # 先白名单放行，避免 ODS 已落盘数据读不进来（已报 A1）。
        "allowed_source_like": ("update_flag",),
    },
    # 行业分类快照：dt=运行日，行内无 instrument_id/trade_date；index_code 为业务主键。
    "index_classify.v1": {
        "id_field": "index_code",
        "trade_date": False,
        "required": ("snapshot_date", "industry_code", "industry_name", "level", "classification_source", "is_published"),
        "dates": ("snapshot_date",),
        "text": ("index_code", "industry_name", "parent_code", "level", "industry_code",
                 "is_published", "classification_source"),
    },
    # 指数成分快照：dt=运行日，行内无 trade_date；在退市/调出日期在 in_date/out_date。
    "index_member_all.v1": {
        "trade_date": False,
        "required": ("snapshot_date", "name", "l1_code", "l1_name", "in_date", "is_new"),
        "dates": ("snapshot_date", "in_date", "out_date"),
        "text": ("name", "l1_code", "l1_name", "l2_code", "l2_name", "l3_code", "l3_name"),
        "enums": {"is_new": ("Y", "N")},
    },
}



class OdsFormatError(ValueError):
    """批次文件不符合交换格式 v1。拒绝入库，不得猜测补齐。"""


class SchemaDriftError(OdsFormatError):
    """字段/类型漂移（含 tushare 字段泄漏）。告警并拒绝入库（ADR-002 D1）。"""


@dataclass(frozen=True)
class SourceRef:
    source: str
    as_of: datetime
    fetched_at: datetime

    def as_dict(self) -> dict[str, str]:
        return {
            "source": self.source,
            "as_of": self.as_of.isoformat(),
            "fetched_at": self.fetched_at.isoformat(),
        }


@dataclass
class Batch:
    """一个已通过格式校验的 ODS 批次。rows 为原始 canonical 行（Decimal 已解析）。"""

    batch_id: str
    endpoint: str
    schema: str
    source: SourceRef
    rows_total: int
    rows_rejected: int
    rows: list[dict[str, Any]] = field(default_factory=list)
    path: str | None = None
    # L34：批次来源 root。display=只接 csv/official_api（可展示），internal=tushare 交叉校验，
    # flat=旧平铺单 root（兼容模式，display_safe 退回按 manifest 派生）。
    origin: str = "flat"

    @property
    def trade_dates(self) -> list[date]:
        # bar/adj_factor 用 trade_date；fundamental 无 trade_date，用 report_end_date 做 dt= 分区
        return sorted(
            {
                value
                for row in self.rows
                for key in ("trade_date", "report_end_date")
                if isinstance((value := row.get(key)), date) and not isinstance(value, datetime)
            }
        )


# --------------------------------------------------------------------------
# 解析原语
# --------------------------------------------------------------------------


def parse_decimal(value: Any, *, where: str) -> Decimal:
    """十进制解析：只接受 str/int/Decimal；float 一律拒绝（精度不可信）。"""
    if isinstance(value, bool):
        raise OdsFormatError(f"{where}: 布尔值不能当数字")
    if isinstance(value, float):
        raise OdsFormatError(
            f"{where}: 金额/价格禁止 JSON float（会丢精度），必须传十进制字符串"
        )
    if isinstance(value, Decimal):
        return value
    try:
        if isinstance(value, int):
            return Decimal(value)
        if isinstance(value, str) and value.strip():
            return Decimal(value.strip())
    except (InvalidOperation, ValueError) as exc:  # pragma: no cover - 防御
        raise OdsFormatError(f"{where}: 无法解析为十进制: {value!r}") from exc
    raise OdsFormatError(f"{where}: 期望十进制字符串，得到 {type(value).__name__}")


def parse_date(value: Any, *, where: str) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        raise OdsFormatError(f"{where}: 期望 trade_date 日期，得到 datetime")
    try:
        return date.fromisoformat(str(value))
    except ValueError as exc:
        raise OdsFormatError(f"{where}: 非法日期 {value!r}（要求 YYYY-MM-DD）") from exc


def parse_shanghai_datetime(value: Any, *, where: str) -> datetime:
    if not isinstance(value, str):
        raise OdsFormatError(f"{where}: 期望 ISO8601 字符串")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise OdsFormatError(f"{where}: 无法解析为 ISO8601: {value!r}") from exc
    if parsed.tzinfo is None:
        raise OdsFormatError(f"{where}: 必须带时区（A 股统一 +08:00），禁止裸时间")
    if parsed.utcoffset() != TZ_SHANGHAI:
        raise OdsFormatError(f"{where}: 必须是 +08:00 时点（C18），得到 {value!r}")
    return parsed


def _require(obj: dict[str, Any], key: str, *, where: str) -> Any:
    if key not in obj:
        raise OdsFormatError(f"{where}: 缺必填字段 {key}")
    return obj[key]


# --------------------------------------------------------------------------
# 行校验
# --------------------------------------------------------------------------


def _check_no_source_leak(
    row: dict[str, Any], *, where: str, allow: frozenset[str] = frozenset()
) -> None:
    leaked = (FORBIDDEN_ROW_KEYS - allow) & set(row)
    if leaked:
        raise SchemaDriftError(
            f"{where}: 出现数据源字段名 {sorted(leaked)}；适配层外不许泄漏 tushare 概念（C01）"
        )


def _check_instrument_id(value: Any, *, where: str) -> str:
    if not isinstance(value, str) or not INSTRUMENT_ID_RE.match(value):
        raise OdsFormatError(f"{where}: instrument_id 必须匹配 EXCH:CODE（如 SSE:600519），得到 {value!r}")
    return value


def _check_research_instrument_id(schema: str, value: Any, *, where: str) -> str:
    """研究数据集标识：A 股用契约 EXCH:CODE；hk_hold 额外允许港股 HKEX:#####。

    港股不在 A 股 dim_instrument（ADR-002 exchange 枚举只有 SSE/SZSE/BSE），因此
    hk_hold 的港股行由质量规则 RES-03 显式豁免并计数，不静默跳过、也不冒充 A 股。
    """
    if schema == "hk_hold.v1" and isinstance(value, str) and HKEX_ID_RE.match(value):
        return value
    return _check_instrument_id(value, where=where)


def normalize_bar_row(row: dict[str, Any], *, where: str) -> dict[str, Any]:
    _check_no_source_leak(row, where=where)
    instrument_id = _check_instrument_id(_require(row, "instrument_id", where=where), where=where)
    trade_date = parse_date(_require(row, "trade_date", where=where), where=f"{where}.trade_date")
    suspended = row.get("suspended", False)
    if not isinstance(suspended, bool):
        raise OdsFormatError(f"{where}.suspended: 必须是布尔值")

    out: dict[str, Any] = {
        "instrument_id": instrument_id,
        "trade_date": trade_date,
        "suspended": suspended,
    }
    if suspended:
        # 停牌日无有效 OHLC：只作为「该日无 bar」的证据（C08：不补 0、不合成 K 线）。
        return out

    for key in BAR_PRICE_FIELDS:
        out[key] = parse_decimal(_require(row, key, where=where), where=f"{where}.{key}")
    for key in BAR_VOLUME_FIELDS:
        out[key] = parse_decimal(_require(row, key, where=where), where=f"{where}.{key}")
    if out["volume"] != out["volume"].to_integral_value():
        raise OdsFormatError(f"{where}.volume: 成交量单位为股，必须是整数（C09）")
    if "prev_close" in row and row["prev_close"] is not None:
        out["prev_close"] = parse_decimal(row["prev_close"], where=f"{where}.prev_close")
    else:
        out["prev_close"] = None
    return out


def normalize_factor_row(row: dict[str, Any], *, where: str) -> dict[str, Any]:
    _check_no_source_leak(row, where=where)
    instrument_id = _check_instrument_id(_require(row, "instrument_id", where=where), where=where)
    trade_date = parse_date(_require(row, "trade_date", where=where), where=f"{where}.trade_date")
    factor = parse_decimal(_require(row, "factor", where=where), where=f"{where}.factor")
    return {"instrument_id": instrument_id, "trade_date": trade_date, "factor": factor}


def normalize_instrument_row(row: dict[str, Any], *, where: str) -> dict[str, Any]:
    _check_no_source_leak(row, where=where)
    for key in INSTRUMENT_FIELDS:
        _require(row, key, where=where)
    instrument_id = _check_instrument_id(row["instrument_id"], where=where)
    exchange = row["exchange"]
    board = row["board"]
    if exchange not in EXCHANGES:
        raise OdsFormatError(f"{where}.exchange: 非法取值 {exchange!r}，允许 {EXCHANGES}")
    if board not in BOARDS:
        raise OdsFormatError(f"{where}.board: 非法取值 {board!r}，允许 {BOARDS}")
    if board not in BOARD_BY_EXCHANGE[exchange]:
        raise OdsFormatError(f"{where}: 非法交易所/板块组合 {exchange}/{board}（C02）")
    if row["security_type"] not in SECURITY_TYPES:
        raise OdsFormatError(f"{where}.security_type: 非法取值 {row['security_type']!r}")
    if row["list_status"] not in LIST_STATUSES:
        raise OdsFormatError(f"{where}.list_status: 非法取值 {row['list_status']!r}")
    if not INSTRUMENT_ID_RE.match(instrument_id) or instrument_id.split(":")[0] != exchange:
        raise OdsFormatError(f"{where}: instrument_id 与 exchange 不一致")
    # display root 的 instrument 行只有 7 个展示字段（H4 2026-11-04 裁定 §2）：code 由 instrument_id
    # 派生、lot_size 只进 internal；internal 若显式给了就必须合法。DWD 内部仍保存两者。
    code = row.get("code")
    if code is None:
        code = instrument_id.split(":", 1)[1]
    code = str(code)
    if not re.fullmatch(r"[0-9]{6}", code):
        raise OdsFormatError(f"{where}.code: 必须 6 位数字")
    lot_size = row.get("lot_size", 100)
    if isinstance(lot_size, bool) or not isinstance(lot_size, (int, str)):
        raise OdsFormatError(f"{where}.lot_size: 必须是正整数（股）")
    try:
        lot_size_value = int(lot_size)
    except ValueError as exc:
        raise OdsFormatError(f"{where}.lot_size: 必须是正整数（股）") from exc
    if lot_size_value <= 0:
        raise OdsFormatError(f"{where}.lot_size: 必须是正整数（股）")
    out = {
        "instrument_id": instrument_id,
        "exchange": exchange,
        "code": code,
        "name": str(row["name"]),
        "board": board,
        "security_type": row["security_type"],
        "list_status": row["list_status"],
        "lot_size": lot_size_value,
        "listed_at": (
            parse_date(row["listed_at"], where=f"{where}.listed_at")
            if row.get("listed_at")
            else None
        ),
    }
    return out


def normalize_fundamental_row(row: dict[str, Any], *, where: str) -> dict[str, Any]:
    """财务摘要 canonical 行（M06：reported/restated 双口径；金额=元、十进制字符串）。"""
    _check_no_source_leak(row, where=where)
    leaked = set(FUNDAMENTAL_FORBIDDEN_KEYS) & set(row)
    if leaked:
        raise OdsFormatError(
            f"{where}: 财务行不得出现 {sorted(leaked)}（无行情字段；statement_basis 区分口径）"
        )
    instrument_id = _check_instrument_id(_require(row, "instrument_id", where=where), where=where)
    report_period = _require(row, "report_period", where=where)
    if not isinstance(report_period, str) or not FUNDAMENTAL_REPORT_PERIOD_RE.match(report_period):
        raise OdsFormatError(f"{where}.report_period: 必须匹配 YYYYQn（如 2026Q3），得到 {report_period!r}")
    report_end_date = parse_date(
        _require(row, "report_end_date", where=where), where=f"{where}.report_end_date"
    )
    announced_at = parse_shanghai_datetime(
        _require(row, "announced_at", where=where), where=f"{where}.announced_at"
    )
    statement_basis = _require(row, "statement_basis", where=where)
    if statement_basis not in FUNDAMENTAL_STATEMENT_BASES:
        raise OdsFormatError(
            f"{where}.statement_basis: 非法取值 {statement_basis!r}，允许 {FUNDAMENTAL_STATEMENT_BASES}"
        )
    currency = _require(row, "currency", where=where)
    if currency not in FUNDAMENTAL_CURRENCIES:
        raise OdsFormatError(f"{where}.currency: 非法取值 {currency!r}，允许 {FUNDAMENTAL_CURRENCIES}")
    if announced_at.date() < report_end_date:
        raise OdsFormatError(f"{where}: announced_at 早于 report_end_date（披露不能早于报告期结束）")

    out: dict[str, Any] = {
        "instrument_id": instrument_id,
        "report_period": report_period,
        "report_end_date": report_end_date,
        "announced_at": announced_at,
        "statement_basis": statement_basis,
        "currency": currency,
    }
    for key in FUNDAMENTAL_REQUIRED_DECIMALS:
        out[key] = parse_decimal(_require(row, key, where=where), where=f"{where}.{key}")
    for key in FUNDAMENTAL_OPTIONAL_DECIMALS:
        value = row.get(key)
        out[key] = None if value is None else parse_decimal(value, where=f"{where}.{key}")
    return out


def normalize_research_row(schema: str, row: dict[str, Any], *, where: str) -> dict[str, Any]:
    """研究数据集 canonical 行校验（金额/比率/量纲由 A1 适配层归一，本层不换算）。

    * 主键字段：instrument_id（除 margin 用 exchange）与 trade_date 必填；
    * 数值一律十进制字符串解析为 Decimal（JSON float 拒绝，积分/量必须整数）；
    * 缺省可选字段为 None，禁止补 0（C10 由适配层保证，本层保留 None）。
    """
    spec = RESEARCH_ROW_SPECS[schema]
    _check_no_source_leak(
        row, where=where, allow=frozenset(spec.get("allowed_source_like", ()))
    )
    id_field = spec.get("id_field", "instrument_id")
    if id_field == "instrument_id":
        raw_id = _check_research_instrument_id(
            schema, _require(row, id_field, where=where), where=where
        )
    else:
        raw_id = _require(row, id_field, where=where)
        if not isinstance(raw_id, str) or not raw_id.strip():
            raise OdsFormatError(f"{where}.{id_field}: 必须是非空字符串")
    out: dict[str, Any] = {id_field: raw_id}
    if spec.get("trade_date", True):
        out["trade_date"] = parse_date(
            _require(row, "trade_date", where=where), where=f"{where}.trade_date"
        )
    required_keys = set(spec.get("required", ()))
    for key in spec.get("dates", ()):
        if key in required_keys:
            out[key] = parse_date(_require(row, key, where=where), where=f"{where}.{key}")
        else:
            # 可选日期（如 index_member_all.out_date）：缺失/None 保留 None，不补值。
            raw = row.get(key)
            out[key] = None if raw is None else parse_date(raw, where=f"{where}.{key}")
    for key in spec.get("required", ()):
        if row.get(key) is None:
            raise OdsFormatError(f"{where}: 缺必填字段 {key}")
    decimal_fields = spec.get("decimal", ())
    if decimal_fields == ("*",):
        # 财务指标等宽表：除主键/日期/文本/枚举外，其余字段一律按十进制字符串收，
        # 拒绝 JSON float（丢精度）并保留 None（缺失不补 0）。
        handled = {id_field, "trade_date", *spec.get("dates", ()), *spec.get("text", ()),
                   *spec.get("enums", {}), *spec.get("patterns", {})}
        for key, value in row.items():
            if key in handled:
                continue
            out[key] = None if value is None else parse_decimal(value, where=f"{where}.{key}")
    else:
        for key in decimal_fields:
            value = row.get(key)
            out[key] = None if value is None else parse_decimal(value, where=f"{where}.{key}")
    for key in spec.get("integer", ()):
        value = row.get(key)
        if value is None:
            out[key] = None
            continue
        parsed = parse_decimal(value, where=f"{where}.{key}")
        if parsed != parsed.to_integral_value():
            raise OdsFormatError(f"{where}.{key}: 必须是整数（股/手/方向），得到 {value!r}")
        out[key] = parsed
    for key in spec.get("text", ()):
        value = row.get(key)
        out[key] = None if value is None else str(value)
    for key, allowed in spec.get("enums", {}).items():
        # 枚举字段（exchange/side/is_new 等）必须落键——曾只校验不输出，导致 DWD 列为 NULL。
        raw = row.get(key)
        out[key] = None if raw is None else str(raw)
        value = out.get(key)
        if value is not None and value not in allowed:
            raise OdsFormatError(f"{where}.{key}: 非法取值 {value!r}，允许 {allowed}")
    for key, pattern in spec.get("patterns", {}).items():
        # 模式字段（如 report_period）本身也是 canonical 输出，必须落键后再校验。
        raw = row.get(key)
        out[key] = None if raw is None else str(raw)
        value = out.get(key)
        if value is not None and not pattern.match(str(value)):
            raise OdsFormatError(f"{where}.{key}: 不符合模式 {pattern.pattern}，得到 {value!r}")
    return out


def _make_research_normalizer(schema: str):
    def _normalizer(row: dict[str, Any], *, where: str) -> dict[str, Any]:
        return normalize_research_row(schema, row, where=where)

    return _normalizer


ROW_NORMALIZERS = {
    "bar.v1": normalize_bar_row,
    "adj_factor.v1": normalize_factor_row,
    "instrument.v1": normalize_instrument_row,
    "fundamental.v1": normalize_fundamental_row,
    **{schema: _make_research_normalizer(schema) for schema in RESEARCH_ROW_SPECS},
}


# --------------------------------------------------------------------------
# 批次读写
# --------------------------------------------------------------------------


def load_batch(path: str | Path) -> Batch:
    path = Path(path)
    where = str(path)
    try:
        # 不用 parse_float=Decimal：JSON number 必须先被识别为 float 再拒绝，
        # 否则 "把价格写成 10.30 数字" 这种丢精度写法会被悄悄接受（违约交换格式 v1）。
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise OdsFormatError(f"{where}: 不是合法 JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise OdsFormatError(f"{where}: 批次信封必须是 JSON object")

    batch_id = payload.get("batch_id")
    if not isinstance(batch_id, str) or not batch_id.strip():
        raise OdsFormatError(f"{where}: batch_id 必须是非空字符串")
    endpoint = payload.get("endpoint")
    if endpoint not in ENDPOINT_SCHEMAS:
        raise OdsFormatError(f"{where}: 非法 endpoint {endpoint!r}，允许 {sorted(ENDPOINT_SCHEMAS)}")
    schema = payload.get("schema")
    if schema != ENDPOINT_SCHEMAS[endpoint]:
        raise OdsFormatError(f"{where}: endpoint={endpoint} 必须配 schema={ENDPOINT_SCHEMAS[endpoint]}，得到 {schema!r}")

    src = payload.get("source")
    if not isinstance(src, dict):
        raise OdsFormatError(f"{where}: 缺 source 对象（C03/C04）")
    source_name = src.get("source")
    if not isinstance(source_name, str) or not SOURCE_RE.match(source_name):
        raise OdsFormatError(f"{where}.source.source: 非法 canonical 来源标识 {source_name!r}")
    source = SourceRef(
        source=source_name,
        as_of=parse_shanghai_datetime(src.get("as_of"), where=f"{where}.source.as_of"),
        fetched_at=parse_shanghai_datetime(src.get("fetched_at"), where=f"{where}.source.fetched_at"),
    )
    if source.fetched_at < source.as_of:
        raise OdsFormatError(f"{where}: fetched_at 早于 as_of（C04 两者不得混用/倒挂）")

    raw_rows = payload.get("rows")
    if not isinstance(raw_rows, list):
        raise OdsFormatError(f"{where}: rows 必须是数组")
    rows_total = payload.get("rows_total")
    rows_rejected = payload.get("rows_rejected")
    for key, value in (("rows_total", rows_total), ("rows_rejected", rows_rejected)):
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise OdsFormatError(f"{where}: {key} 必须是非负整数")
    if rows_total != len(raw_rows) + rows_rejected:
        raise OdsFormatError(
            f"{where}: 不变式失败 rows_total({rows_total}) != len(rows)({len(raw_rows)}) + rows_rejected({rows_rejected})"
        )

    normalizer = ROW_NORMALIZERS[schema]
    rows = []
    for idx, row in enumerate(raw_rows):
        if not isinstance(row, dict):
            raise OdsFormatError(f"{where}: rows[{idx}] 必须是 object")
        rows.append(normalizer(row, where=f"{where}#rows[{idx}]"))

    return Batch(
        batch_id=batch_id,
        endpoint=endpoint,
        schema=schema,
        source=source,
        rows_total=rows_total,
        rows_rejected=rows_rejected,
        rows=rows,
        path=str(path),
    )


def iter_batch_files(root: str | Path) -> Iterator[Path]:
    """按 endpoint 与路径排序遍历 `<root>/<endpoint>/dt=<date>/<batch_id>.json`。"""
    root = Path(root)
    if not root.exists():
        return iter(())
    files: list[Path] = []
    for endpoint in ENDPOINT_SCHEMAS:
        files.extend(sorted((root / endpoint).glob("dt=*/*.json")))
    return iter(files)


def load_batches(root: str | Path, *, origin: str = "flat") -> list[Batch]:
    batches = [load_batch(p) for p in iter_batch_files(root)]
    for batch in batches:
        batch.origin = origin
    _ensure_unique_batches(batches)
    return batches


def _ensure_unique_batches(batches: list[Batch]) -> None:
    seen: dict[tuple[str, str], str] = {}
    for batch in batches:
        key = (batch.endpoint, batch.batch_id)
        if key in seen:
            raise OdsFormatError(
                f"batch_id 重复：endpoint={batch.endpoint} batch_id={batch.batch_id} 同时出现在 "
                f"{seen[key]} 与 {batch.path}（批次幂等键必须唯一，C15）"
            )
        seen[key] = batch.path or "<memory>"


def _has_endpoint_dirs(root: Path) -> bool:
    return any((root / endpoint).is_dir() for endpoint in ENDPOINT_SCHEMAS)


def load_ods_roots(
    display_root: str | Path,
    internal_root: str | Path | None = None,
) -> list[Batch]:
    """按 L34 读取 ODS root（display / internal 物理隔离）。

    三种形态，按顺序判定：
    1. 显式 `internal_root`：display_root 读 display，internal_root 读 internal；
    2. 只给一个 root，且其下有 display/ 或 internal/ 子目录（L34 标准布局）：各读各的；
    3. 只给一个 root，且根目录直接就是 bar/adj_factor/...（旧平铺布局，var/ods-smoke）：
       保持旧行为，origin=flat，display_safe 退回按 manifest 派生。

    返回的 Batch.origin 供 build_dwd 决定 dim_instrument.display_safe：
    display=True，internal=False，flat=看 manifest。
    """
    display = Path(display_root)
    if internal_root is not None:
        batches = load_batches(display, origin="display") + load_batches(internal_root, origin="internal")
    elif (display / "display").is_dir() or (display / "internal").is_dir():
        batches = []
        if (display / "display").is_dir():
            batches += load_batches(display / "display", origin="display")
        if (display / "internal").is_dir():
            batches += load_batches(display / "internal", origin="internal")
    else:
        batches = load_batches(display, origin="flat")
    _ensure_unique_batches(batches)
    return batches


RESEARCH_COVERAGE_FILE = "research_coverage.json"
RESEARCH_COVERAGE_VALUES = ("full_history", "current_snapshot_only")


def load_research_coverage(root: Path) -> dict[tuple[str, str], str]:
    """读取 A1 生成的 <root>/_meta/research_coverage.json（也兼容 internal/display 子目录）。

    返回 (endpoint, snapshot_date_str) -> coverage；`current_snapshot_only` 表示该快照
    只有最新成分、无历史时点，消费方（回测/as-of 查询）必须排除，不能当全历史用。
    文件缺失返回空映射（不报错：老 fixture 无此文件）。
    """
    root = Path(root)
    result: dict[tuple[str, str], str] = {}
    candidates = [root / "_meta" / RESEARCH_COVERAGE_FILE,
                  root / "internal" / "_meta" / RESEARCH_COVERAGE_FILE,
                  root / "display" / "_meta" / RESEARCH_COVERAGE_FILE]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise OdsFormatError(f"{path}: 无法解析研究覆盖元数据: {exc}") from exc
        datasets = payload.get("datasets") if isinstance(payload, dict) else None
        if not isinstance(datasets, dict):
            raise OdsFormatError(f"{path}: 缺 datasets 对象")
        for endpoint, meta in datasets.items():
            if not isinstance(meta, dict):
                raise OdsFormatError(f"{path}.datasets.{endpoint}: 必须是对象")
            coverage = str(meta.get("coverage") or "")
            snapshot_date = str(meta.get("snapshot_date") or "")
            if coverage not in RESEARCH_COVERAGE_VALUES:
                raise OdsFormatError(f"{path}.datasets.{endpoint}.coverage: 非法取值 {coverage!r}")
            if not snapshot_date:
                raise OdsFormatError(f"{path}.datasets.{endpoint}: 缺 snapshot_date")
            result[(endpoint, snapshot_date)] = coverage
    return result


def ensure_research_origin(batches: list[Batch], *, profile: str = "prod") -> list[Batch]:
    """研究数据集批次只允许出现在 internal root（或旧平铺 root），不得进 display root。

    L34 的 display root 是「展示可用」通道；研究数据集（daily_basic/index_daily/
    top_list/top_inst/moneyflow/margin/hk_hold）是内部评测数据，不参与 display_safe
    派生、也不得影响展示态。prod 直接拒绝（fail-closed），dev 返回违规批次供调用方告警，
    但 display_safe 仍恒为 false。
    """
    offenders = [
        batch
        for batch in batches
        if batch.origin == "display" and batch.endpoint in RESEARCH_ENDPOINTS
    ]
    if offenders and profile == "prod":
        detail = ", ".join(f"{batch.endpoint}/{batch.batch_id}" for batch in offenders[:5])
        raise OdsFormatError(
            f"研究数据集批次不得写入 display root（内部评测数据不得参与展示/display_safe 派生）：{detail}"
        )
    return offenders


MANIFEST_FILE = "manifest.jsonl"
MANIFEST_HEAD_FILES = ("manifest.head", "manifest.head.json")
MANIFEST_SNAPSHOT_DIR = "snapshots"
MANIFEST_INSTRUMENT_EVENT = "instrument_import"
MANIFEST_SUCCEEDED = "succeeded"
MANIFEST_GENESIS_HASH = "0" * 64
# L34 + H4 裁定：只有这些渠道可以产生 display_safe=true（tushare 只能进 internal）。
DISPLAY_CHANNELS = frozenset({"manual_import", "authorized_download", "official_api"})


def _canonical_event_bytes(event: dict[str, Any]) -> bytes:
    body = {key: value for key, value in event.items() if key not in ("prev_hash", "hash")}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _event_hash(prev_hash: str, event: dict[str, Any]) -> str:
    """H4 2026-11-04 口径 M1（agents/decisions.md L52）：hash = sha256(prev_hash + "\n" + canonical_json)。"""
    return hashlib.sha256(prev_hash.encode("utf-8") + b"\n" + _canonical_event_bytes(event)).hexdigest()


def _read_manifest_head(root: Path) -> dict[str, Any] | None:
    for name in MANIFEST_HEAD_FILES:
        path = root / name
        if path.is_file():
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise OdsFormatError(f"{path}: JSON 解析失败: {exc}") from exc
            if not isinstance(payload, dict):
                raise OdsFormatError(f"{path}: manifest.head 必须是 JSON object")
            return payload
    return None


def load_display_safety(manifest_root: str | Path, *, strict: bool = False) -> dict[str, bool]:
    """从 A1 的主数据 manifest 派生 instrument_id -> display_safe（L30/L34 + H4 证据裁定）。

    证据式派生（H4 2026-11-04 裁定，agents/decisions.md L42/L43；不再信任目录位置或 DEFAULT）：
      display_safe = 该 instrument 最近一条 succeeded instrument_import 事件；
                     channel ∈ {manual_import, authorized_download, official_api}；
                     snapshot 文件存在且其内嵌 checksum_sha256 与事件一致。
    另外校验 append-only 完整性：event_id 唯一、finished_at 非降序、`prev_hash`/`hash` 链连续、
    `manifest.head` 的 count/last_hash 与文件一致；`synthetic: true` 事件整条跳过（不计数、不派生）。

    strict=True（生产 profile）时上述完整性缺一即 OdsFormatError；strict=False（离线回归）允许
    旧 manifest 没有 hash 链/head，但已有字段仍会校验。缺证据一律返回 False，绝不默认 True。
    """
    root = Path(manifest_root)
    manifest_path = root / MANIFEST_FILE
    if not manifest_path.is_file():
        raise OdsFormatError(f"{manifest_path}: manifest 不存在，无法派生 dim_instrument.display_safe")

    events: list[dict[str, Any]] = []
    seen_event_ids: set[str] = set()
    previous_finished: datetime | None = None
    for index, line in enumerate(manifest_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            raise OdsFormatError(f"{manifest_path}:{index}: 空行（append-only manifest 不允许空行）")
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise OdsFormatError(f"{manifest_path}:{index}: JSON 解析失败: {exc}") from exc
        if not isinstance(event, dict):
            raise OdsFormatError(f"{manifest_path}:{index}: 每行必须是 JSON object")
        if event.get("synthetic") is True:
            if event.get("display_safe") is True:
                raise OdsFormatError(
                    f"{manifest_path}:{index}: synthetic:true 事件不得声明 display_safe:true（样例不得充当展示证据）"
                )
            continue
        event_id = event.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise OdsFormatError(f"{manifest_path}:{index}: event_id 必须是非空字符串")
        if event_id in seen_event_ids:
            raise OdsFormatError(f"{manifest_path}:{index}: event_id 重复: {event_id}")
        seen_event_ids.add(event_id)
        finished_at = event.get("finished_at")
        if not isinstance(finished_at, str):
            raise OdsFormatError(f"{manifest_path}:{index}: finished_at 必须是 ISO 时间字符串")
        try:
            finished = datetime.fromisoformat(finished_at)
        except ValueError as exc:
            raise OdsFormatError(f"{manifest_path}:{index}: finished_at 非法: {exc}") from exc
        if previous_finished is not None and finished < previous_finished:
            raise OdsFormatError(f"{manifest_path}:{index}: finished_at 倒序（append-only 只允许非降序）")
        previous_finished = finished
        events.append(event)

    # hash 链：要么全有，要么全无（全无只允许在 strict=False 的离线回归）
    hashed = [event for event in events if "hash" in event or "prev_hash" in event]
    chain: list[dict[str, Any]] = []
    if hashed:
        if len(hashed) != len(events):
            raise OdsFormatError(f"{manifest_path}: 部分事件缺 hash/prev_hash，链不完整")
        previous_hash: str | None = None
        for event in events:
            record_hash = event.get("hash")
            prev_hash = event.get("prev_hash")
            if not isinstance(record_hash, str) or len(record_hash) != 64:
                raise OdsFormatError(f"{manifest_path}: event_id={event.get('event_id')} 的 hash 非法")
            expected_prev = MANIFEST_GENESIS_HASH if previous_hash is None else previous_hash
            if prev_hash != expected_prev:
                if previous_hash is None:
                    raise OdsFormatError(f"{manifest_path}: 首条事件 prev_hash 必须是 64 个 0")
                raise OdsFormatError(
                    f"{manifest_path}: event_id={event.get('event_id')} 的 prev_hash 与上一条 hash 不一致"
                )
            if _event_hash(prev_hash, event) != record_hash:
                raise OdsFormatError(f"{manifest_path}: event_id={event.get('event_id')} 的 hash 复算不一致")
            previous_hash = record_hash
            chain.append(event)
    elif strict and events:
        raise OdsFormatError(f"{manifest_path}: 生产 profile 要求 manifest 带 prev_hash/hash 链")

    head = _read_manifest_head(root)
    if head is None:
        # H4 2026-11-04 口径 M2（agents/decisions.md L52）：全 synthetic 目录没有 head；除此之外生产 profile 必须有
        if strict and events:
            raise OdsFormatError(f"{manifest_path}: 生产 profile 要求 manifest.head（schema_version/count/last_hash）")
    else:
        if head.get("schema_version") != 1 or isinstance(head.get("schema_version"), bool):
            raise OdsFormatError(
                f"{manifest_path}: manifest.head.schema_version 必须为 1（实际 {head.get('schema_version')!r}）；"
                "未知键忽略"
            )
        count = head.get("count")
        expected = len(events)
        if not isinstance(count, int) or isinstance(count, bool) or count != expected:
            raise OdsFormatError(
                f"{manifest_path}: manifest.head.count={count!r} 与非 synthetic 事件数 {expected} 不一致"
            )
        last_hash = head.get("last_hash")
        if events and chain and last_hash != events[-1].get("hash"):
            raise OdsFormatError(f"{manifest_path}: manifest.head.last_hash 与末条事件 hash 不一致")
        if not events and last_hash not in (None, MANIFEST_GENESIS_HASH):
            raise OdsFormatError(f"{manifest_path}: 空 manifest 的 head.last_hash 必须为空或 64 个 0")

    safety: dict[str, bool] = {}
    for event in events:
        if event.get("event_type") != MANIFEST_INSTRUMENT_EVENT:
            continue
        if event.get("status") != MANIFEST_SUCCEEDED:
            continue
        channel = event.get("channel")
        if not isinstance(channel, str):
            raise OdsFormatError(f"{manifest_path}: event_id={event.get('event_id')} 缺少 channel")
        checksum = event.get("checksum_sha256")
        if not isinstance(checksum, str) or not checksum:
            raise OdsFormatError(f"{manifest_path}: event_id={event.get('event_id')} 缺少 checksum_sha256")
        rows_recorded = event.get("rows")
        if not isinstance(rows_recorded, int) or isinstance(rows_recorded, bool) or rows_recorded < 0:
            raise OdsFormatError(f"{manifest_path}: event_id={event.get('event_id')} rows 非法")

        display_channel = channel in DISPLAY_CHANNELS
        snapshot_path, byte_verified = _resolve_snapshot(
            root, manifest_path, event, checksum, strict=strict and display_channel
        )
        if snapshot_path is None:
            # 生产 profile 缺证据已在 _resolve_snapshot 报错；dev 下无法定位标的，交给 build 默认 false
            continue
        payload = _read_snapshot(snapshot_path)
        if payload.get("checksum_sha256") != checksum:
            raise OdsFormatError(
                f"{snapshot_path}: 内嵌 checksum_sha256 与事件 {event.get('event_id')} 不一致"
            )
        rows = payload.get("rows")
        if not isinstance(rows, list):
            raise OdsFormatError(f"{snapshot_path}: 快照必须包含 rows 数组")
        if rows_recorded != len(rows):
            raise OdsFormatError(f"{snapshot_path}: 快照行数 {len(rows)} 与事件 rows={rows_recorded} 不一致")
        for instrument_id in _snapshot_instrument_ids(snapshot_path, payload=payload):
            safety[instrument_id] = bool(display_channel and byte_verified)
    return safety


def _resolve_snapshot(
    root: Path,
    manifest_path: Path,
    event: dict[str, Any],
    checksum: str,
    *,
    strict: bool,
) -> tuple[Path | None, bool]:
    """定位并（能定位时）校验快照文件字节哈希。

    H4 2026-11-04 裁定：成功事件必须带 `snapshot_path` + `snapshot_sha256`（快照文件字节 sha256）。
    缺失按"无证据"处理：strict（生产）直接报错；dev 返回 None（不产生 true）。
    旧格式没有这两个字段时回退 `snapshots/instruments-<checksum>.json`，但字节哈希未验证，
    因此即使能读到快照也只算 False。
    """
    record_path = event.get("snapshot_path")
    if record_path is None:
        path = root / MANIFEST_SNAPSHOT_DIR / f"instruments-{checksum}.json"
    elif not isinstance(record_path, str) or not record_path:
        raise OdsFormatError(f"{manifest_path}: event_id={event.get('event_id')} snapshot_path 非法")
    else:
        candidate = Path(record_path)
        path = candidate if candidate.is_absolute() else root / candidate
        try:
            path.resolve().relative_to(root.resolve())
        except ValueError as exc:
            raise OdsFormatError(
                f"{manifest_path}: event_id={event.get('event_id')} snapshot_path 越出 manifest root"
            ) from exc

    record_sha = event.get("snapshot_sha256")
    if record_sha is None and record_path is None:
        if strict:
            raise OdsFormatError(
                f"{manifest_path}: event_id={event.get('event_id')} 缺少 snapshot_path/snapshot_sha256，"
                "无法证明快照文件未被篡改（生产 profile 拒绝）"
            )
        return (path if path.is_file() else None), False

    if not isinstance(record_sha, str) or len(record_sha) != 64:
        if strict:
            raise OdsFormatError(
                f"{manifest_path}: event_id={event.get('event_id')} 缺少合法的 snapshot_sha256"
            )
        return (path if path.is_file() else None), False
    if not path.is_file():
        if strict:
            raise OdsFormatError(
                f"{manifest_path}: event_id={event.get('event_id')} 的快照缺失（{path}），"
                "无法把 display_safe 派生到具体标的"
            )
        return None, False
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != record_sha:
        raise OdsFormatError(
            f"{path}: 快照文件字节哈希 {actual} 与事件 snapshot_sha256={record_sha} 不一致"
        )
    return path, True


def _read_snapshot(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise OdsFormatError(f"{path}: JSON 解析失败: {exc}") from exc
    if not isinstance(payload, dict):
        raise OdsFormatError(f"{path}: 快照必须是 JSON object")
    return payload


def _snapshot_instrument_ids(path: Path, *, payload: dict[str, Any] | None = None) -> list[str]:
    payload = payload or _read_snapshot(path)
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise OdsFormatError(f"{path}: 快照必须包含 rows 数组")
    instrument_ids: list[str] = []
    for row in rows:
        instrument_id = row.get("instrument_id") if isinstance(row, dict) else None
        if not isinstance(instrument_id, str) or not INSTRUMENT_ID_RE.match(instrument_id):
            raise OdsFormatError(f"{path}: 快照行 instrument_id 非法: {instrument_id!r}")
        instrument_ids.append(instrument_id)
    return instrument_ids


def display_instrument_ids(batches: list[Batch]) -> list[str]:
    """L34 display root 里出现过的 instrument_id（生产 profile 必须每条都有展示证据）。"""
    ids = {
        row["instrument_id"]
        for batch in batches
        if batch.endpoint == "instrument" and batch.origin == "display"
        for row in batch.rows
    }
    return sorted(ids)


def require_display_evidence(batches: list[Batch], safety: dict[str, bool]) -> None:
    """生产 profile：display root 里的每个标的都必须有 positive manifest 证据。

    缺证据 / 渠道不可展示 / 快照不一致都会在这里变成硬失败，而不是悄悄落成 false
    （否则维表会整片空掉，没人发现——H4 2026-11-04 裁定第 3 条）。
    """
    missing = [instrument_id for instrument_id in display_instrument_ids(batches) if not safety.get(instrument_id, False)]
    if missing:
        raise OdsFormatError(
            "display root 的 instrument 批次缺少可展示证据（manifest succeeded + 合法 channel + 快照一致）："
            + ", ".join(missing[:20])
            + ("..." if len(missing) > 20 else "")
            + "。生产 profile 拒绝落库；离线回归请显式构造 manifest 或使用 --profile dev 并确认全部 display_safe=false"
        )


def write_batch(root: str | Path, batch: Batch) -> Path:
    """按 v1 布局写出批次文件（供 golden fixture 物化与本地回放；A1 侧自行实现同等格式）。"""
    root = Path(root)
    dates = batch.trade_dates
    dt = dates[0].isoformat() if dates else "1970-01-01"
    target = root / batch.endpoint / f"dt={dt}" / f"{batch.batch_id}.json"
    target.parent.mkdir(parents=True, exist_ok=True)

    def _jsonable(value: Any) -> Any:
        if isinstance(value, Decimal):
            return format(value, "f")
        if isinstance(value, datetime) or isinstance(value, date):
            return value.isoformat()
        if isinstance(value, dict):
            return {k: _jsonable(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_jsonable(v) for v in value]
        return value

    payload = {
        "batch_id": batch.batch_id,
        "endpoint": batch.endpoint,
        "schema": batch.schema,
        "source": batch.source.as_dict(),
        "rows_total": batch.rows_total,
        "rows_rejected": batch.rows_rejected,
        "rows": [_jsonable(r) for r in batch.rows],
    }
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target
