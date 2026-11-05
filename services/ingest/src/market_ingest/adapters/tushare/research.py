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
第 2 批新增（KD-INGEST-P2 / KD-INGEST-INDUSTRY）：
fina_indicator doc_id=79（2000 分，**只能按单只股票**取历史）、
stk_limit doc_id=183（2000 分，按 trade_date 全市场）、
index_classify doc_id=181（2000 分，申万行业分类树，snapshot）、
index_member_all doc_id=335（2000 分，申万三级成分，snapshot；拉全量含 is_new=N，
历史进出成分保留 in_date/out_date，避免幸存者偏差）。

接入模式（``ResearchDataset.mode``）：
- ``daily``：按 trade_date 逐日全市场拉取；
- ``snapshot``：一次拉全量快照（行业分类树/最新成分），按运行日分区；
- ``per_instrument``：按单只标的 + 报告期区间拉取（fina_indicator 不支持全市场）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
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
    #: 接入模式：daily（按交易日）/ snapshot（全量快照）/ per_instrument（按标的）。
    mode: str = "daily"
    #: snapshot 模式的分批参数（如申万分类树按 L1/L2/L3 三次调用；空=单次调用）。
    batch_params: tuple[Mapping[str, str], ...] = ()
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
    # ---- 第 2 批（KD-INGEST-P2）----
    "fina_indicator": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("report_end_date", "end_date", "date_yyyymmdd"),
        _c("report_period", "end_date", "quarter"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("eps", "eps", "decimal", required=False),
        _c("dt_eps", "dt_eps", "decimal", required=False),
        _c("bps", "bps", "decimal", required=False),
        _c("ocfps", "ocfps", "decimal", required=False),
        _c("total_revenue_ps", "total_revenue_ps", "decimal", required=False),
        _c("revenue_ps", "revenue_ps", "decimal", required=False),
        _c("roe", "roe", "decimal", required=False),
        _c("roe_waa", "roe_waa", "decimal", required=False),
        _c("roe_dt", "roe_dt", "decimal", required=False),
        _c("roa", "roa", "decimal", required=False),
        _c("npta", "npta", "decimal", required=False),
        _c("roic", "roic", "decimal", required=False),
        _c("grossprofit_margin", "grossprofit_margin", "decimal", required=False),
        _c("netprofit_margin", "netprofit_margin", "decimal", required=False),
        _c("debt_to_assets", "debt_to_assets", "decimal", required=False),
        _c("current_ratio", "current_ratio", "decimal", required=False),
        _c("quick_ratio", "quick_ratio", "decimal", required=False),
        _c("assets_turn", "assets_turn", "decimal", required=False),
        _c("ar_turn", "ar_turn", "decimal", required=False),
        _c("inv_turn", "inv_turn", "decimal", required=False),
        _c("profit_dedt", "profit_dedt", "amount_yuan", required=False),
        _c("extra_item", "extra_item", "amount_yuan", required=False),
        _c("ebit", "ebit", "amount_yuan", required=False),
        _c("ebitda", "ebitda", "amount_yuan", required=False),
        _c("fixed_assets", "fixed_assets", "amount_yuan", required=False),
        _c("or_yoy_pct", "or_yoy", "pct", required=False),
        _c("tr_yoy_pct", "tr_yoy", "pct", required=False),
        _c("netprofit_yoy_pct", "netprofit_yoy", "pct", required=False),
        _c("dt_netprofit_yoy_pct", "dt_netprofit_yoy", "pct", required=False),
        _c("op_yoy_pct", "op_yoy", "pct", required=False),
        _c("roe_yoy_pct", "roe_yoy", "pct", required=False),
        _c("bps_yoy_pct", "bps_yoy", "pct", required=False),
        _c("assets_yoy_pct", "assets_yoy", "pct", required=False),
        _c("eqt_yoy_pct", "eqt_yoy", "pct", required=False),
        _c("q_eps", "q_eps", "decimal", required=False),
        _c("q_roe", "q_roe", "decimal", required=False),
        _c("q_netprofit_margin", "q_netprofit_margin", "decimal", required=False),
        _c("q_gsprofit_margin", "q_gsprofit_margin", "decimal", required=False),
        _c("q_sales_yoy_pct", "q_sales_yoy", "pct", required=False),
        _c("q_sales_qoq_pct", "q_sales_qoq", "pct", required=False),
        _c("q_profit_qoq_pct", "q_profit_qoq", "pct", required=False),
        _c("q_op_qoq_pct", "q_op_qoq", "pct", required=False),
        _c("revision_flag", "update_flag", "text", required=False),
    ),
    "stk_limit": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("trade_date", "trade_date", "date"),
        _c("previous_close", "pre_close", "price", required=False),
        _c("up_limit", "up_limit", "price"),
        _c("down_limit", "down_limit", "price"),
        _c("asset_type", "asset_type", "text", required=False),
        _c("exchange", "exchange", "exchange_margin", required=False),
    ),
    # ---- 第 2 批（KD-INGEST-INDUSTRY）----
    "index_classify": (
        _c("index_code", "index_code", "text"),
        _c("industry_name", "industry_name", "text"),
        _c("parent_code", "parent_code", "text", required=False),
        _c("level", "level", "text"),
        _c("industry_code", "industry_code", "text"),
        _c("is_published", "is_pub", "text", required=False),
        _c("classification_source", "src", "text", required=False),
    ),
    "index_member_all": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("name", "name", "text", required=False),
        _c("l1_code", "l1_code", "text"),
        _c("l1_name", "l1_name", "text"),
        _c("l2_code", "l2_code", "text"),
        _c("l2_name", "l2_name", "text"),
        _c("l3_code", "l3_code", "text"),
        _c("l3_name", "l3_name", "text"),
        _c("in_date", "in_date", "date_yyyymmdd", required=False),
        _c("out_date", "out_date", "date_yyyymmdd", required=False),
        _c("is_new", "is_new", "text", required=False),
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
    "fina_indicator": (
        "fina_indicator",
        79,
        2000,
        False,
        "财务指标（只能按单只股票取历史；单次最多 100 行）",
    ),
    "stk_limit": ("stk_limit", 183, 2000, False, "每日涨跌停价（2007-01-04 起，2000 分）"),
    "index_classify": (
        "index_classify",
        181,
        2000,
        False,
        "申万行业分类树（2021 版按 L1/L2/L3 快照）",
    ),
    "index_member_all": (
        "index_member_all",
        335,
        2000,
        False,
        "申万三级成分（时点成分；Y/N 两次调用拉全量含历史退出，保留 in_date/out_date）",
    ),
}

#: 数据集接入模式（研究接口形态决定，非业务策略）。
_DATASET_MODES: dict[str, str] = {
    "fina_indicator": "per_instrument",
    "index_classify": "snapshot",
    "index_member_all": "snapshot",
}

#: snapshot 模式的分批参数（申万行业树按层级三次调用；成分表一次拉最新）。
_DATASET_BATCH_PARAMS: dict[str, tuple[Mapping[str, str], ...]] = {
    "index_classify": (
        {"level": "L1", "src": "SW2021"},
        {"level": "L2", "src": "SW2021"},
        {"level": "L3", "src": "SW2021"},
    ),
    # 全量 = 当前成分 + 历史退出成分（H4 m02718：只拉 is_new=Y 会引入幸存者偏差）。
    # 若源对 N 无数据，sync 侧会把该数据集标记为 current_snapshot_only 并落 coverage 元数据。
    "index_member_all": ({"is_new": "Y"}, {"is_new": "N"}),
}

#: dataset 名 → 定义（下游只按 name 取；源细节封闭在此）。
RESEARCH_DATASETS: dict[str, ResearchDataset] = {
    name: ResearchDataset(
        name=name,
        api_name=meta[0],
        doc_id=meta[1],
        points_min=meta[2],
        requires_index_codes=meta[3],
        mode=_DATASET_MODES.get(name, "daily"),
        batch_params=_DATASET_BATCH_PARAMS.get(name, ()),
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
    "stk_limit",
    "fina_indicator",
    "index_classify",
    "index_member_all",
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

#: ``stk_limit`` 涨跌幅档位（H4 m02718）：只用交易所公布的限价/前收比值分档，
#: 不重算限价、不改精度、不从证券简称/``asset_type`` 推 ST（M04 已否过按今天的名字
#: 定历史 ST）。容差 ±0.3pp 吸收交易所四舍五入。
LIMIT_PCT_BUCKETS: tuple[Decimal, ...] = (
    Decimal("5"),
    Decimal("10"),
    Decimal("20"),
    Decimal("30"),
)
LIMIT_PCT_PRICE_STEP = Decimal("0.01")
LIMIT_PCT_FLOAT_TOLERANCE = Decimal("0.005")
LIMIT_PCT_SOURCE = "exchange_price_candidate"
LIMIT_PCT_FIELDS: tuple[str, ...] = ("limit_pct", "limit_pct_source")

#: snapshot 数据集的主键/审计字段：主键含 ``snapshot_date``（拉取日），
#: 快照 append-only，不原地 UPDATE，历史快照不可回补（H4 m02718）。
SNAPSHOT_DATE_FIELD = "snapshot_date"
SNAPSHOT_DATASETS: frozenset[str] = frozenset({"index_classify", "index_member_all"})

#: 历史成分标记值（源 ``is_new``：Y=当前成分、N=历史退出成分）。
_HISTORICAL_IS_NEW = frozenset({"N", "0", "否", "FALSE", "False", "false"})

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


def _parse_yyyymmdd(value: Any, *, field: str) -> date:
    try:
        return mapper.parse_trade_date(value)
    except mapper.RowMapError as exc:
        raise ResearchRowError(f"invalid {field}: {value!r}") from exc


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
    if kind == "date_yyyymmdd":
        return _parse_yyyymmdd(raw, field=column.source).isoformat()
    if kind == "quarter":
        return mapper.parse_report_period(_parse_yyyymmdd(raw, field=column.source))
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
    _apply_derived(dataset, result)
    return result


def _optional_decimal(value: Any, *, field: str) -> Decimal | None:
    """canonical 字符串 → Decimal；缺失返回 None，非法抛 ResearchRowError。"""
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ResearchRowError(f"invalid number for {field!r}: {value!r}") from exc


def _apply_derived(dataset: str, result: dict[str, Any]) -> None:
    """按 H4 口径补派生字段（不覆盖任何源值）。"""
    if dataset == "stk_limit":
        _derive_limit_pct(result)
    if dataset in SNAPSHOT_DATASETS:
        # 实际值由适配层在抓取时点注入；这里先占位，保证列顺序/键集稳定。
        result.setdefault(SNAPSHOT_DATE_FIELD, None)


def _round_limit_price(price: Decimal, pct: Decimal, sign: Decimal) -> Decimal:
    """按交易所 0.01 元最小变动单位四舍五入（H4 m03085 候选档重算）。"""
    raw = price * (Decimal(1) + sign * pct / Decimal(100))
    return raw.quantize(LIMIT_PCT_PRICE_STEP, rounding=ROUND_HALF_UP)


def _derive_limit_pct(result: dict[str, Any]) -> None:
    """限价档位判定：候选档重算比对（H4 m03085，取代 m02718 的比值容差法）。

    比值法对低价股必然踩 0.01 元最小变动单位的舍入边界（1.35→1.49 是 10% 档，
    但比值 10.37%），放宽容差只会把错档放进来。改为：
    对 {5,10,20,30} 每档分别重算涨停价与跌停价（四舍五入到 2 位），与交易所给的
    ``up_limit``/``down_limit`` 分别精确比对（仅 ±0.005 吸收浮点误差）；
    **唯一命中**才落 ``limit_pct``；零命中/多命中 → null（首日无涨跌幅、退市整理等
    自然落 null，是正确语义，不猜）。
    """
    up_limit = _optional_decimal(result.get("up_limit"), field="up_limit")
    down_limit = _optional_decimal(result.get("down_limit"), field="down_limit")
    previous_close = _optional_decimal(result.get("previous_close"), field="previous_close")
    if (
        up_limit is None
        or down_limit is None
        or previous_close is None
        or previous_close <= 0
    ):
        result["limit_pct"] = None
        result["limit_pct_source"] = None
        return
    matched: list[Decimal] = []
    for pct in LIMIT_PCT_BUCKETS:
        candidate_up = _round_limit_price(previous_close, pct, Decimal(1))
        candidate_down = _round_limit_price(previous_close, pct, Decimal(-1))
        if (
            abs(up_limit - candidate_up) <= LIMIT_PCT_FLOAT_TOLERANCE
            and abs(down_limit - candidate_down) <= LIMIT_PCT_FLOAT_TOLERANCE
        ):
            matched.append(pct)
    unique = matched[0] if len(matched) == 1 else None
    result["limit_pct"] = None if unique is None else format(unique, "f")
    result["limit_pct_source"] = LIMIT_PCT_SOURCE if unique is not None else None


def has_historical_members(rows: Sequence[Mapping[str, Any]]) -> bool:
    """``index_member_all`` 是否拿到历史退出成分（``is_new=N``）。

    为 False 时，该批只是当前快照（幸存者偏差），sync 会标记
    ``current_snapshot_only`` 并让下游把该数据集排除出历史回测（H4 m02718）。
    """
    for row in rows:
        value = str(row.get("is_new") or "").strip()
        if value in _HISTORICAL_IS_NEW or value.upper() in {"N", "0", "FALSE"}:
            return True
    return False


def dedupe_rows(dataset: str, rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """``index_member_all`` 的 Y/N 两次调用可能重叠；按成分主键去重（保序）。

    H4 m02923：去重键必须是 ``index_code + con_code + in_date``（本域对应
    ``l3_code + instrument_id + in_date``）。**不能**只按代码去重——同一只股票
    「退出后又重新进入」对应多个 ``in_date`` 区间，压成一条会把历史区间丢掉。
    """
    if dataset != "index_member_all":
        return list(rows)
    seen: set[tuple[str, ...]] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        key = (
            str(row.get("instrument_id") or ""),
            str(row.get("l3_code") or ""),
            str(row.get("in_date") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def sort_key(dataset: str, row: Mapping[str, Any]) -> tuple[str, ...]:
    """同一批次内的稳定顺序（按数据集主键，缺省回退全字段）。"""
    spec = RESEARCH_DATASETS.get(dataset)
    if spec is not None:
        if spec.mode == "per_instrument":
            return (str(row.get("instrument_id") or ""), str(row.get("report_end_date") or ""))
        if dataset == "index_classify":
            return (
                str(row.get(SNAPSHOT_DATE_FIELD) or ""),
                str(row.get("index_code") or ""),
            )
        if dataset == "index_member_all":
            return (
                str(row.get("instrument_id") or ""),
                str(row.get("l3_code") or ""),
                str(row.get("in_date") or ""),
            )
    return (
        str(row.get("trade_date") or ""),
        str(row.get("instrument_id") or row.get("exchange") or ""),
    )


def partition_date(dataset: str, rows: Sequence[Mapping[str, Any]], fallback: date) -> date:
    """ODS 分区日：财务按报告期（最新一期）；快照按拉取日；其它按调用日/交易日。"""
    if dataset == "fina_indicator":
        values = [str(row.get("report_end_date")) for row in rows if row.get("report_end_date")]
        if values:
            return max(date.fromisoformat(value) for value in values)
    if dataset in SNAPSHOT_DATASETS:
        snapshot_dates = [
            str(row.get(SNAPSHOT_DATE_FIELD))
            for row in rows
            if row.get(SNAPSHOT_DATE_FIELD)
        ]
        if snapshot_dates:
            return max(date.fromisoformat(value) for value in snapshot_dates)
    return fallback


def canonical_fields(dataset: str) -> tuple[str, ...]:
    """该数据集的 canonical 列顺序（供文档/测试断言）。"""
    fields = [column.canonical for column in RESEARCH_DATASETS[dataset].columns]
    if dataset == "stk_limit":
        fields.extend(LIMIT_PCT_FIELDS)
    if dataset in SNAPSHOT_DATASETS:
        fields.append(SNAPSHOT_DATE_FIELD)
    return tuple(fields)


def research_datasets() -> tuple[str, ...]:
    return tuple(RESEARCH_DATASETS)


__all__ = [
    "ColumnSpec",
    "DEFAULT_RESEARCH_DATASETS",
    "LIMIT_PCT_BUCKETS",
    "LIMIT_PCT_FIELDS",
    "LIMIT_PCT_SOURCE",
    "LIMIT_PCT_TOLERANCE",
    "RESEARCH_DATASETS",
    "ResearchDataset",
    "ResearchRowError",
    "SNAPSHOT_DATASETS",
    "SNAPSHOT_DATE_FIELD",
    "canonical_fields",
    "dedupe_rows",
    "has_historical_members",
    "hk_source_code",
    "partition_date",
    "instrument_id_for",
    "map_row",
    "research_datasets",
    "row_date",
    "row_instrument",
]
