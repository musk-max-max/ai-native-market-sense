"""研究数据集 schema（KD-AIP0-INF05）：接口名/积分档/字段/单位换算集中在适配层。

为什么集中在这里：
- 源字段名、接口名、积分档只能出现在 ``adapters/`` 内（ADR-002 D4 / C01）；
  下游只看到 canonical 行（``instrument_id`` + 十进制字符串 + 元/股）；
- H4 尚未确认接口字段/积分档（ADR-007 INF-05 前置），本模块是**唯一**需要随
  H4 结论改动的地方，``provisional=True`` 标记待对齐项，不动 ODS/sync 下游。

单位口径（与现有 bar/factor 一致）：
- 金额一律 **元**（十进制字符串）；量一律 **股**（整数字符串）；比率一律 **百分数**；
- 源侧 ``万元`` ×10000、``千元`` ×1000、``手`` ×100；
- 缺失值为 ``null``，**禁止补 0**（C10）；必需字段缺失/非法 → ``ResearchRowError``（落 DLQ）。

参考（tushare 官方文档，2026-11-05）：
top_list doc_id=106（2000 分）、top_inst doc_id=107（**5000 分**特色）、
moneyflow doc_id=170（2000 分）、margin doc_id=58（2000 分）、
hk_hold doc_id=188（2000 分）、daily_basic doc_id=32（2000 分）、
index_daily doc_id=95（2000 分，``ts_code`` 必填，不可按日拉全市场）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

from . import mapper


class ResearchRowError(ValueError):
    """单行无法映射为 canonical 行（调用方落 DLQ，不静默丢弃）。"""


@dataclass(frozen=True, slots=True)
class ColumnSpec:
    """canonical 列 ← 源字段 + 单位换算类型。"""

    canonical: str
    source: str
    kind: str  # instrument/date/text/int/price/decimal/pct/amount_*/volume_lots/shares_wan/exchange*
    required: bool = True


@dataclass(frozen=True, slots=True)
class ResearchDataset:
    """一个研究数据集：接口名、积分档、字段清单、行列定义。"""

    name: str
    api_name: str
    doc_id: int
    points_min: int
    columns: tuple[ColumnSpec, ...]
    #: 需要显式指数代码列表（index_daily 不能只按 trade_date 拉全市场）。
    requires_index_codes: bool = False
    #: 等 H4 确认接口字段/积分档（ADR-007 INF-05 前置）；确认后移除标记。
    provisional: bool = True
    note: str = ""

    @property
    def fields(self) -> tuple[str, ...]:
        """请求 fields（源字段清单）——去重保序。"""
        seen: dict[str, None] = {}
        for column in self.columns:
            seen.setdefault(column.source, None)
        return tuple(seen)


def _c(canonical: str, source: str, kind: str, *, required: bool = True) -> ColumnSpec:
    return ColumnSpec(canonical=canonical, source=source, kind=kind, required=required)


#: 7 个研究数据集的列定义（顺序即 ODS 行列顺序）。
_COLUMNS: dict[str, tuple[ColumnSpec, ...]] = {
    "top_list": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("trade_date", "trade_date", "date"),
        _c("name", "name", "text"),
        _c("close", "close", "price"),
        _c("pct_change_pct", "pct_change", "pct"),
        _c("turnover_rate_pct", "turnover_rate", "pct"),
        _c("amount", "amount", "amount_yuan"),
        _c("lhb_sell_amount", "l_sell", "amount_yuan"),
        _c("lhb_buy_amount", "l_buy", "amount_yuan"),
        _c("lhb_amount", "l_amount", "amount_yuan"),
        _c("lhb_net_amount", "net_amount", "amount_yuan"),
        _c("lhb_net_rate_pct", "net_rate", "pct"),
        _c("lhb_amount_rate_pct", "amount_rate", "pct"),
        _c("float_market_value", "float_values", "amount_yuan"),
        _c("reason", "reason", "text"),
    ),
    "top_inst": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("trade_date", "trade_date", "date"),
        _c("seat_name", "exalter", "text"),
        _c("side", "side", "int"),
        _c("buy_amount", "buy", "amount_yuan"),
        _c("buy_rate_pct", "buy_rate", "pct"),
        _c("sell_amount", "sell", "amount_yuan"),
        _c("sell_rate_pct", "sell_rate", "pct"),
        _c("net_buy_amount", "net_buy", "amount_yuan"),
        _c("reason", "reason", "text"),
    ),
    "moneyflow": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("trade_date", "trade_date", "date"),
        _c("buy_small_volume", "buy_sm_vol", "volume_lots", required=False),
        _c("buy_small_amount", "buy_sm_amount", "amount_wan", required=False),
        _c("sell_small_volume", "sell_sm_vol", "volume_lots", required=False),
        _c("sell_small_amount", "sell_sm_amount", "amount_wan", required=False),
        _c("buy_medium_volume", "buy_md_vol", "volume_lots", required=False),
        _c("buy_medium_amount", "buy_md_amount", "amount_wan", required=False),
        _c("sell_medium_volume", "sell_md_vol", "volume_lots", required=False),
        _c("sell_medium_amount", "sell_md_amount", "amount_wan", required=False),
        _c("buy_large_volume", "buy_lg_vol", "volume_lots", required=False),
        _c("buy_large_amount", "buy_lg_amount", "amount_wan", required=False),
        _c("sell_large_volume", "sell_lg_vol", "volume_lots", required=False),
        _c("sell_large_amount", "sell_lg_amount", "amount_wan", required=False),
        _c("buy_extra_large_volume", "buy_elg_vol", "volume_lots", required=False),
        _c("buy_extra_large_amount", "buy_elg_amount", "amount_wan", required=False),
        _c("sell_extra_large_volume", "sell_elg_vol", "volume_lots", required=False),
        _c("sell_extra_large_amount", "sell_elg_amount", "amount_wan", required=False),
        _c("net_inflow_volume", "net_mf_vol", "volume_lots", required=False),
        _c("net_inflow_amount", "net_mf_amount", "amount_wan", required=False),
    ),
    "margin": (
        _c("exchange", "exchange_id", "exchange_margin"),
        _c("trade_date", "trade_date", "date"),
        _c("financing_balance", "rzye", "amount_yuan"),
        _c("financing_buy_amount", "rzmre", "amount_yuan"),
        _c("financing_repayment_amount", "rzche", "amount_yuan"),
        _c("securities_balance", "rqye", "amount_yuan"),
        _c("securities_sell_volume", "rqmcl", "int"),
        _c("margin_balance", "rzrqye", "amount_yuan"),
        _c("securities_volume", "rqyl", "int"),
    ),
    "hk_hold": (
        _c("instrument_id", "ts_code", "instrument_hk"),
        _c("trade_date", "trade_date", "date"),
        _c("name", "name", "text"),
        _c("holding_volume", "vol", "int"),
        _c("holding_ratio_pct", "ratio", "pct"),
        _c("northbound_channel", "exchange", "exchange_hk"),
    ),
    "daily_basic": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("trade_date", "trade_date", "date"),
        _c("close", "close", "price"),
        _c("turnover_rate_pct", "turnover_rate", "pct", required=False),
        _c("free_float_turnover_rate_pct", "turnover_rate_f", "pct", required=False),
        _c("volume_ratio", "volume_ratio", "decimal", required=False),
        _c("pe", "pe", "decimal", required=False),
        _c("pe_ttm", "pe_ttm", "decimal", required=False),
        _c("pb", "pb", "decimal", required=False),
        _c("ps", "ps", "decimal", required=False),
        _c("ps_ttm", "ps_ttm", "decimal", required=False),
        _c("dividend_yield_pct", "dv_ratio", "pct", required=False),
        _c("dividend_yield_ttm_pct", "dv_ttm", "pct", required=False),
        _c("total_shares", "total_share", "shares_wan", required=False),
        _c("float_shares", "float_share", "shares_wan", required=False),
        _c("free_float_shares", "free_share", "shares_wan", required=False),
        _c("total_market_value", "total_mv", "amount_wan", required=False),
        _c("circulating_market_value", "circ_mv", "amount_wan", required=False),
        _c("limit_status", "limit_status", "text", required=False),
    ),
    "index_daily": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("trade_date", "trade_date", "date"),
        _c("open", "open", "price"),
        _c("high", "high", "price"),
        _c("low", "low", "price"),
        _c("close", "close", "price"),
        _c("prev_close", "pre_close", "price"),
        _c("change", "change", "decimal"),
        _c("pct_change_pct", "pct_chg", "pct"),
        _c("volume", "vol", "volume_lots"),
        _c("amount", "amount", "amount_thousand"),
    ),
}

_DATASET_META: dict[str, tuple[str, int, int, bool, str]] = {
    # name: (api_name, doc_id, points_min, requires_index_codes, note)
    "top_list": ("top_list", 106, 2000, False, "龙虎榜每日明细；单次最多 10000 行"),
    "top_inst": ("top_inst", 107, 5000, False, "龙虎榜机构/营业部明细（特色数据，5000 分）"),
    "moneyflow": ("moneyflow", 170, 2000, False, "个股资金流向（2010 起）；量=手、额=万元 → 股/元"),
    "margin": ("margin", 58, 2000, False, "融资融券交易汇总（交易所维度：SSE/SZSE/BSE）"),
    "hk_hold": ("hk_hold", 188, 2000, False, "沪深股通持股明细（港交所源，2000 分）"),
    "daily_basic": ("daily_basic", 32, 2000, False, "每日指标（PE/PB/换手/市值/涨跌停状态）"),
    "index_daily": ("index_daily", 95, 2000, True, "指数日线；ts_code 必填，按指数代码循环"),
}

#: dataset 名 → 定义（下游只按 name 取；源细节封闭在此）。
RESEARCH_DATASETS: dict[str, ResearchDataset] = {
    name: ResearchDataset(
        name=name,
        api_name=meta[0],
        doc_id=meta[1],
        points_min=meta[2],
        requires_index_codes=meta[3],
        note=meta[4],
        columns=_COLUMNS[name],
    )
    for name, meta in _DATASET_META.items()
}

#: 默认接入顺序（按功能点依赖 + 接口可得性；CLI 默认集合）。
DEFAULT_RESEARCH_DATASETS: tuple[str, ...] = (
    "daily_basic",
    "index_daily",
    "top_list",
    "top_inst",
    "moneyflow",
    "margin",
    "hk_hold",
)

#: 金额/量换算倍数（Decimal 运算，禁止 float 误差）。
_FACTORS: dict[str, Decimal] = {
    "price": Decimal(1),
    "decimal": Decimal(1),
    "pct": Decimal(1),
    "amount_yuan": Decimal(1),
    "amount_wan": Decimal("10000"),
    "amount_thousand": Decimal("1000"),
    "shares_wan": Decimal("10000"),
    "volume_lots": Decimal("100"),
}

_EXCHANGE_MARGIN = {"SSE": "SSE", "SZSE": "SZSE", "BSE": "BSE"}
_EXCHANGE_HK = {"SH": "SH", "SZ": "SZ", "HK": "HK"}

#: 港股通（南向）标的命名空间：仅 ``hk_hold`` 研究域使用。
#: 源返回 ``00700.HK``；P0 canonical pattern（SSE/SZSE/BSE:6 位）不变，
#: 港股不进入 A 股端口/展示态，只在研究数据集行里用 ``HKEX:00700``。
_HKEX_NAMESPACE = "HKEX"
_HKEX_CODE_LEN = 5
_HKEX_SUFFIX = ".HK"


def hk_instrument_id(value: Any, *, dataset: str) -> str:
    """``hk_hold`` 的港股通行源代码 → ``HKEX:#####``（其它数据集出现 ``.HK`` 一律拒绝）。"""
    if dataset != "hk_hold":
        raise ResearchRowError(
            f"HK namespace is only valid for hk_hold rows (got {value!r} in {dataset})"
        )
    try:
        return mapper.to_instrument_id(str(value))
    except ValueError as exc:
        raise ResearchRowError(f"invalid HK source code {value!r} for {dataset}") from exc


def _instrument_id_from_code(row: Mapping[str, Any]) -> str | None:
    """``ts_code`` 缺失时的兜底：用源 ``code``+``exchange`` 拼回 TS 代码（仅 hk_hold）。"""
    code = str(row.get("code") or "").strip()
    exchange = str(row.get("exchange") or "").strip().upper()
    if not code.isdigit():
        return None
    if exchange in ("SH", "SZ") and len(code) == 6:
        return mapper.to_instrument_id(f"{code}.{exchange}")
    if exchange == "HK" and 1 <= len(code) <= _HKEX_CODE_LEN:
        return mapper.to_instrument_id(f"{code}.HK")
    return None


def instrument_id_for(value: Any, *, dataset: str) -> str:
    """研究域 instrument_id：A 股 ``EXCH:CODE``；``hk_hold`` 的港股通行 → ``HKEX:#####``。"""
    text = str(value).strip()
    if text.upper().endswith(".HK"):
        return hk_instrument_id(text, dataset=dataset)
    try:
        return mapper.to_instrument_id(text)
    except ValueError as exc:
        raise ResearchRowError(f"invalid source code {value!r} for {dataset}") from exc


def hk_source_code(instrument_id: str) -> str:
    """``HKEX:#####`` → 源代码 ``#####.HK``（``instrument_id_for`` 的逆映射，审计/回放用）。

    只接受研究域港股命名空间（5 位数字，左补 0，大写）；A 股 ``EXCH:CODE`` 不走这里。
    """
    if not str(instrument_id).startswith(f"{_HKEX_NAMESPACE}:"):
        raise ResearchRowError(f"not an HKEX instrument_id: {instrument_id!r}")
    try:
        return mapper.to_source_code(str(instrument_id))
    except ValueError as exc:
        raise ResearchRowError(f"invalid HKEX code: {instrument_id!r}") from exc


def row_date(row: Mapping[str, Any]) -> date | None:
    """尽力取源行交易日（用于 DLQ 元数据）；非法返回 None。"""
    try:
        return mapper.parse_trade_date(row.get("trade_date"))
    except mapper.RowMapError:
        return None


def row_instrument(row: Mapping[str, Any], *, dataset: str | None = None) -> str | None:
    """尽力取 canonical instrument_id（用于 DLQ 元数据）；非法返回 None。"""
    value = row.get("ts_code")
    if not value:
        return None
    if dataset == "hk_hold" and str(value).upper().endswith(".HK"):
        try:
            return instrument_id_for(value, dataset="hk_hold")
        except ResearchRowError:
            return None
    try:
        exchange, code = mapper.parse_source_code(str(value))
    except mapper.RowMapError:
        return None
    return f"{exchange.value}:{code}"


def _required(row: Mapping[str, Any], key: str) -> Any:
    if key not in row or row[key] in (None, ""):
        raise ResearchRowError(f"missing required field {key!r}")
    return row[key]


def _decimal(value: Any, *, field: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ResearchRowError(f"invalid number for {field!r}: {value!r}") from exc


def _convert(column: ColumnSpec, raw: Any, dataset: str) -> Any:
    kind = column.kind
    if kind == "text":
        return str(raw)
    if kind == "int":
        value = _decimal(raw, field=column.source)
        if value != value.to_integral_value():
            raise ResearchRowError(f"non-integral value for {column.source!r}: {raw!r} ({dataset})")
        return str(int(value))
    if kind in _FACTORS:
        value = _decimal(raw, field=column.source) * _FACTORS[kind]
        if kind == "volume_lots":
            value = value.to_integral_value()
        return format(value, "f")
    if kind == "exchange_margin":
        text = str(raw)
        if text not in _EXCHANGE_MARGIN:
            raise ResearchRowError(f"unknown exchange_id {text!r} ({dataset})")
        return _EXCHANGE_MARGIN[text]
    if kind == "exchange_hk":
        text = str(raw)
        if text not in _EXCHANGE_HK:
            raise ResearchRowError(f"unknown northbound exchange {text!r} ({dataset})")
        return _EXCHANGE_HK[text]
    raise ResearchRowError(f"unsupported column kind {kind!r} ({dataset})")


def map_row(dataset: str, row: Mapping[str, Any]) -> dict[str, Any]:
    """源行 → canonical ODS 行（字段名/单位都已归一，值均为 str/None）。"""
    spec = RESEARCH_DATASETS.get(dataset)
    if spec is None:
        raise ResearchRowError(f"unknown research dataset {dataset!r}")
    result: dict[str, Any] = {}
    for column in spec.columns:
        raw = row.get(column.source)
        if column.kind == "instrument_hk" and raw in (None, ""):
            derived = _instrument_id_from_code(row)
            if derived is not None:
                result[column.canonical] = derived
                continue
        if raw in (None, ""):
            if column.required:
                raise ResearchRowError(
                    f"missing required field {column.source!r} for {dataset} "
                    f"(缺失禁止补 0，C10)"
                )
            result[column.canonical] = None
            continue
        if column.kind in ("instrument", "instrument_hk"):
            result[column.canonical] = instrument_id_for(raw, dataset=dataset)
        elif column.kind == "date":
            try:
                result[column.canonical] = mapper.parse_trade_date(raw).isoformat()
            except mapper.RowMapError as exc:
                raise ResearchRowError(str(exc)) from exc
        else:
            result[column.canonical] = _convert(column, raw, dataset)
    return result


def canonical_fields(dataset: str) -> tuple[str, ...]:
    """该数据集的 canonical 列顺序（供文档/测试断言）。"""
    return tuple(column.canonical for column in RESEARCH_DATASETS[dataset].columns)


def research_datasets() -> tuple[str, ...]:
    return tuple(RESEARCH_DATASETS)


__all__ = [
    "ColumnSpec",
    "DEFAULT_RESEARCH_DATASETS",
    "RESEARCH_DATASETS",
    "ResearchDataset",
    "ResearchRowError",
    "canonical_fields",
    "hk_source_code",
    "instrument_id_for",
    "map_row",
    "research_datasets",
    "row_date",
    "row_instrument",
]
