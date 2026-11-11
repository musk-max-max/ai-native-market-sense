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
from decimal import ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

from ...ports import SchemaDriftError
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
        _c("instrument_id", "ts_code", "instrument_exchange"),
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
    # ---- 第 3 批（KD-INGEST-CONCEPT，L117 修正）----
    # dc_index：东方财富概念/行业/地域板块行情（doc_id=362，6000 分，实测 15000 积分可用）
    "dc_index": (
        _c("board_code", "ts_code", "text"),
        _c("trade_date", "trade_date", "date_yyyymmdd"),
        _c("board_name", "name", "text"),
        _c("leading_name", "leading", "text", required=False),
        _c("leading_code", "leading_code", "text", required=False),
        _c("pct_change", "pct_change", "pct", required=False),
        _c("leading_pct", "leading_pct", "pct", required=False),
        _c("total_mv", "total_mv", "amount_yuan", required=False),
        _c("turnover_rate", "turnover_rate", "pct", required=False),
        _c("up_num", "up_num", "int", required=False),
        _c("down_num", "down_num", "int", required=False),
        _c("idx_type", "idx_type", "text", required=False),
        _c("level", "level", "text", required=False),
    ),
    # dc_member：东方财富概念板块成分股（doc_id=363，6000 分，实测 15000 积分可用）
    # ts_code 需带 .DC 后缀（如 BK1184.DC）；trade_date 过滤返回当日成分
    "dc_member": (
        _c("trade_date", "trade_date", "date_yyyymmdd"),
        _c("board_code", "ts_code", "text"),
        _c("instrument_id", "con_code", "instrument"),
        _c("name", "name", "text", required=False),
    ),
    # ---- L172 第一批（15000 档全量接入，20 数据集）----
    "daily": (
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
    "weekly": (
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
    "monthly": (
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
    "new_share": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("name", "name", "text"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("subscription_date", "subscribe_date", "date_yyyymmdd", required=False),
        _c("listing_date", "list_date", "date_yyyymmdd", required=False),
        _c("issue_price", "issue_price", "price", required=False),
        _c("issue_volume", "issue_amount", "shares_wan", required=False),
        _c("lottery_date", "lot_date", "date_yyyymmdd", required=False),
        _c("raise_funds", "raise_amount", "amount_yuan", required=False),
    ),
    "income": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("report_end_date", "end_date", "date_yyyymmdd"),
        _c("report_period", "end_date", "quarter"),
        _c("total_revenue", "total_revenue", "amount_yuan", required=False),
        _c("revenue", "revenue", "amount_yuan", required=False),
        _c("operating_cost", "oper_cost", "amount_yuan", required=False),
        _c("total_operating_cost", "total_cost", "amount_yuan", required=False),
        _c("operating_profit", "operate_profit", "amount_yuan", required=False),
        _c("total_profit", "total_profit", "amount_yuan", required=False),
        _c("net_profit", "n_income", "amount_yuan", required=False),
        _c("net_profit_parent", "n_income_attr_p", "amount_yuan", required=False),
        _c("basic_eps", "basic_eps", "decimal", required=False),
        _c("diluted_eps", "diluted_eps", "decimal", required=False),
    ),
    "balancesheet": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("report_end_date", "end_date", "date_yyyymmdd"),
        _c("report_period", "end_date", "quarter"),
        _c("total_assets", "total_assets", "amount_yuan", required=False),
        _c("total_liabilities", "total_liab", "amount_yuan", required=False),
        _c("total_equity", "total_hldr_eqy_exc_min_int", "amount_yuan", required=False),
        _c("current_assets", "total_cur_assets", "amount_yuan", required=False),
        _c("noncurrent_assets", "total_nca", "amount_yuan", required=False),
        _c("current_liabilities", "total_cur_liab", "amount_yuan", required=False),
        _c("noncurrent_liabilities", "total_ncl", "amount_yuan", required=False),
        _c("receivables", "accounts_receiv", "amount_yuan", required=False),
        _c("inventory", "inventories", "amount_yuan", required=False),
        _c("goodwill", "good_will", "amount_yuan", required=False),
    ),
    "cashflow": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("report_end_date", "end_date", "date_yyyymmdd"),
        _c("report_period", "end_date", "quarter"),
        _c("operating_cashflow", "n_cashflow_act", "amount_yuan", required=False),
        _c("investing_cashflow", "n_cashflow_inv_act", "amount_yuan", required=False),
        _c("financing_cashflow", "n_cash_flows_fnc_act", "amount_yuan", required=False),
        _c("net_cashflow", "n_cashflow", "amount_yuan", required=False),
        _c("capex", "c_pay_acq_const_fiolta", "amount_yuan", required=False),
    ),
    "forecast": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("report_end_date", "end_date", "date_yyyymmdd"),
        _c("report_period", "end_date", "quarter"),
        _c("forecast_type", "type", "text", required=False),
        _c("net_profit_min", "p_change_min", "pct", required=False),
        _c("net_profit_max", "p_change_max", "pct", required=False),
        _c("net_profit", "net_profit", "amount_yuan", required=False),
        _c("reason", "summary", "text", required=False),
    ),
    "express": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("report_end_date", "end_date", "date_yyyymmdd"),
        _c("report_period", "end_date", "quarter"),
        _c("revenue", "revenue", "amount_yuan", required=False),
        _c("net_profit", "n_income", "amount_yuan", required=False),
        _c("yoy_netprofit_pct", "yoy_net_profit", "pct", required=False),
        _c("qoq_netprofit_pct", "qoq_net_profit", "pct", required=False),
        _c("yoy_revenue_pct", "yoy_sales", "pct", required=False),
        _c("qoq_revenue_pct", "qoq_sales", "pct", required=False),
    ),
    "dividend": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("report_end_date", "end_date", "date_yyyymmdd"),
        _c("dividend_per_share", "cash_div", "decimal", required=False),
        _c("stock_dividend_ratio", "stk_div", "decimal", required=False),
        _c("record_date", "reg_date", "date_yyyymmdd", required=False),
        _c("ex_date", "ex_date", "date_yyyymmdd", required=False),
        _c("payment_date", "pay_date", "date_yyyymmdd", required=False),
    ),
    "pledge_detail": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("name", "name", "text", required=False),
        _c("pledge_count", "pledge_count", "int", required=False),
        _c("pledge_ratio_pct", "pledge_ratio", "pct", required=False),
        _c("total_shares_pledged", "total_share", "shares_wan", required=False),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("pledge_value", "total_value", "amount_yuan", required=False),
    ),
    "pledge_stat": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("name", "name", "text", required=False),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("pledge_count", "pledge_count", "int", required=False),
        _c("unpledge_count", "unpledge_count", "int", required=False),
        _c("pledge_ratio_pct", "pledge_ratio", "pct", required=False),
        _c("total_shares_pledged", "total_share", "shares_wan", required=False),
        _c("total_pledge_ratio_pct", "total_pledge_ratio", "pct", required=False),
    ),
    "margin_detail": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("trade_date", "trade_date", "date"),
        _c("financing_balance", "rzye", "amount_yuan", required=False),
        _c("securities_balance", "rqye", "amount_yuan", required=False),
        _c("securities_sell_volume", "rqmcl", "int", required=False),
        _c("margin_balance", "rzrqye", "amount_yuan", required=False),
    ),
    "repurchase": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("report_end_date", "end_date", "date_yyyymmdd", required=False),
        _c("repurchase_volume", "vol", "shares_wan", required=False),
        _c("repurchase_amount", "amount", "amount_yuan", required=False),
        _c("repurchase_high", "high", "price", required=False),
        _c("repurchase_low", "low", "price", required=False),
    ),
    "share_float": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("name", "name", "text", required=False),
        _c("float_date", "float_date", "date_yyyymmdd", required=False),
        _c("float_share", "float_share", "shares_wan", required=False),
        _c("float_ratio_pct", "float_ratio", "pct", required=False),
        _c("holder_name", "holder_name", "text", required=False),
        _c("share_type", "share_type", "text", required=False),
    ),
    "block_trade": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("trade_date", "trade_date", "date"),
        _c("price", "price", "price", required=False),
        _c("volume", "vol", "shares_wan", required=False),
        _c("amount", "amount", "amount_yuan", required=False),
        _c("buyer", "buyer", "text", required=False),
        _c("seller", "seller", "text", required=False),
    ),
    "stk_holdernumber": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("report_end_date", "end_date", "date_yyyymmdd", required=False),
        _c("holder_number", "holder_num", "int", required=False),
        _c("holder_number_change", "holder_num_delta", "int", required=False),
        _c("avg_market_value", "avg_mv", "amount_yuan", required=False),
        _c("avg_hold_volume", "avg_vol", "shares_wan", required=False),
    ),
    "stk_holdertrade": (
        _c("instrument_id", "ts_code", "instrument"),
        _c("holder_name", "holder_name", "text", required=False),
        _c("holder_type", "holder_type", "text", required=False),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("change_date", "change_date", "date_yyyymmdd", required=False),
        _c("change_volume", "change_vol", "shares_wan", required=False),
        _c("change_ratio_pct", "change_ratio", "pct", required=False),
        _c("avg_price", "average_price", "price", required=False),
        _c("total_shares", "total_share", "shares_wan", required=False),
        _c("direction", "in_de", "text", required=False),
    ),
    "index_basic": (
        _c("index_code", "ts_code", "text"),
        _c("name", "name", "text"),
        _c("market", "market", "text", required=False),
        _c("publisher", "publisher", "text", required=False),
        _c("category", "category", "text", required=False),
        _c("base_date", "base_date", "date_yyyymmdd", required=False),
        _c("base_point", "base_point", "decimal", required=False),
        _c("listing_date", "list_date", "date_yyyymmdd", required=False),
    ),
    "index_weekly": (
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
    "index_monthly": (
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
    "fund_basic": (
        _c("fund_code", "ts_code", "text"),
        _c("name", "name", "text"),
        _c("management_company", "management", "text", required=False),
        _c("custodian", "custodian", "text", required=False),
        _c("fund_type", "fund_type", "text", required=False),
        _c("established_date", "found_date", "date_yyyymmdd", required=False),
        _c("listing_date", "list_date", "date_yyyymmdd", required=False),
        _c("issue_date", "issue_date", "date_yyyymmdd", required=False),
        _c("delisting_date", "delist_date", "date_yyyymmdd", required=False),
        _c("issue_amount", "issue_amount", "shares_wan", required=False),
    ),
    "fund_company": (
        _c("company_code", "ts_code", "text"),
        _c("name", "name", "text"),
        _c("short_name", "shortname", "text", required=False),
        _c("established_date", "found_date", "date_yyyymmdd", required=False),
        _c("registered_capital", "reg_capital", "amount_yuan", required=False),
        _c("city", "city", "text", required=False),
    ),
    "fund_nav": (
        _c("fund_code", "ts_code", "text"),
        _c("announced_at", "nav_date", "date_yyyymmdd"),
        _c("unit_nav", "unit_nav", "decimal", required=False),
        _c("accumulated_nav", "accum_nav", "decimal", required=False),
        _c("unit_nav_return_pct", "unit_nav_return", "pct", required=False),
        _c("accum_nav_return_pct", "accum_nav_return", "pct", required=False),
    ),
    "fund_daily": (
        _c("fund_code", "ts_code", "text"),
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
    "fund_div": (
        _c("fund_code", "ts_code", "text"),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("imp_announced_at", "imp_ann_date", "date_yyyymmdd", required=False),
        _c("dividend_per_unit", "net_ex_date", "decimal", required=False),
        _c("record_date", "base_date", "date_yyyymmdd", required=False),
        _c("ex_date", "ex_date", "date_yyyymmdd", required=False),
        _c("payment_date", "pay_date", "date_yyyymmdd", required=False),
    ),
    "fut_basic": (
        _c("futures_code", "ts_code", "text"),
        _c("name", "name", "text"),
        _c("exchange", "exchange", "text", required=False),
        _c("contract_unit", "contract_unit", "text", required=False),
        _c("listing_date", "list_date", "date_yyyymmdd", required=False),
        _c("delisting_date", "delist_date", "date_yyyymmdd", required=False),
        _c("delivery_month", "delivery_month", "text", required=False),
    ),
    "trade_cal": (
        _c("exchange", "exchange", "text"),
        _c("calendar_date", "cal_date", "date_yyyymmdd"),
        _c("is_open", "is_open", "text", required=False),
        _c("prev_trade_date", "pretrade_date", "date_yyyymmdd", required=False),
    ),
    "fut_daily": (
        _c("futures_code", "ts_code", "text"),
        _c("trade_date", "trade_date", "date"),
        _c("open", "open", "price"),
        _c("high", "high", "price"),
        _c("low", "low", "price"),
        _c("close", "close", "price"),
        _c("settlement", "settle", "price", required=False),
        _c("prev_settlement", "pre_settle", "price", required=False),
        _c("volume", "vol", "volume_lots"),
        _c("amount", "amount", "amount_yuan"),
        _c("open_interest", "oi", "volume_lots", required=False),
    ),
    "fut_holding": (
        _c("futures_code", "ts_code", "text"),
        _c("trade_date", "trade_date", "date"),
        _c("broker", "broker", "text", required=False),
        _c("long_volume", "vol_long", "volume_lots", required=False),
        _c("long_change", "vol_long_chg", "volume_lots", required=False),
        _c("short_volume", "vol_short", "volume_lots", required=False),
        _c("short_change", "vol_short_chg", "volume_lots", required=False),
    ),
    "fut_wsr": (
        _c("futures_code", "ts_code", "text"),
        _c("trade_date", "trade_date", "date"),
        _c("warehouse_receipt", "wh_abi_vol", "volume_lots", required=False),
        _c("change", "vol_chg", "volume_lots", required=False),
    ),
    "fut_settle": (
        _c("futures_code", "ts_code", "text"),
        _c("trade_date", "trade_date", "date"),
        _c("settlement_price", "settle_price", "price", required=False),
        _c("settlement_margin", "settle_margin", "pct", required=False),
        _c("settlement_fee", "settle_fee", "decimal", required=False),
        _c("delivery_price", "delivery_price", "price", required=False),
    ),
    "opt_basic": (
        _c("option_code", "ts_code", "text"),
        _c("name", "name", "text"),
        _c("exchange", "exchange", "text", required=False),
        _c("underlying_code", "underlying_code", "text", required=False),
        _c("option_type", "opt_type", "text", required=False),
        _c("exercise_price", "exercise_price", "price", required=False),
        _c("listing_date", "list_date", "date_yyyymmdd", required=False),
        _c("expiry_date", "delist_date", "date_yyyymmdd", required=False),
    ),
    "opt_daily": (
        _c("option_code", "ts_code", "text"),
        _c("trade_date", "trade_date", "date"),
        _c("open", "open", "price"),
        _c("high", "high", "price"),
        _c("low", "low", "price"),
        _c("close", "close", "price"),
        _c("settlement", "settle", "price", required=False),
        _c("prev_settlement", "pre_settle", "price", required=False),
        _c("volume", "vol", "volume_lots"),
        _c("amount", "amount", "amount_yuan"),
        _c("open_interest", "oi", "volume_lots", required=False),
    ),
    "cb_basic": (
        _c("bond_code", "ts_code", "text"),
        _c("name", "name", "text"),
        _c("underlying_code", "stk_code", "text", required=False),
        _c("underlying_name", "stk_name", "text", required=False),
        _c("issue_price", "issue_price", "price", required=False),
        _c("issue_volume", "issue_amount", "shares_wan", required=False),
        _c("listing_date", "list_date", "date_yyyymmdd", required=False),
        _c("maturity_date", "maturity_date", "date_yyyymmdd", required=False),
    ),
    "cb_issue": (
        _c("bond_code", "ts_code", "text"),
        _c("name", "name", "text"),
        _c("underlying_code", "stk_code", "text", required=False),
        _c("announced_at", "ann_date", "date_yyyymmdd", required=False),
        _c("listing_date", "list_date", "date_yyyymmdd", required=False),
        _c("issue_price", "issue_price", "price", required=False),
        _c("issue_volume", "issue_amount", "shares_wan", required=False),
        _c("coupon_rate", "coupon", "pct", required=False),
        _c("maturity_years", "maturity", "decimal", required=False),
    ),
    "cb_daily": (
        _c("bond_code", "ts_code", "text"),
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
    "fx_obasic": (
        _c("fx_code", "ts_code", "text"),
        _c("name", "name", "text"),
        _c("exchange", "exchange", "text", required=False),
        _c("base_currency", "base_ccy", "text", required=False),
        _c("quote_currency", "quote_ccy", "text", required=False),
        _c("listing_date", "list_date", "date_yyyymmdd", required=False),
    ),
    "fx_daily": (
        _c("fx_code", "ts_code", "text"),
        _c("trade_date", "trade_date", "date"),
        _c("open", "open", "price"),
        _c("high", "high", "price"),
        _c("low", "low", "price"),
        _c("close", "close", "price"),
        _c("volume", "vol", "volume_lots"),
        _c("amount", "amount", "amount_yuan"),
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
    # ---- 第 3 批（KD-INGEST-CONCEPT，L117 修正：15000 积分实测可用）----
    "dc_index": ("dc_index", 362, 6000, False, "东方财富概念/行业/地域板块行情（1058 板块，实测 15000 积分可用）"),
    "dc_member": ("dc_member", 363, 6000, False, "东方财富概念板块成分股（需 .DC 后缀 + trade_date 过滤）"),
    # ---- L172 第一批 ----
    "daily": ("daily", 27, 120, False, "日线 OHLCV（全部历史，交易日 15-17 点更新）"),
    "weekly": ("weekly", 28, 2000, False, "周线 OHLCV（每周五盘后更新）"),
    "monthly": ("monthly", 29, 2000, False, "月线 OHLCV（每月盘后更新）"),
    "new_share": ("new_share", 18, 120, False, "IPO 新股列表（每日 19 点更新）"),
    "income": ("income", 33, 2000, False, "利润表（全部历史，实时更新）"),
    "balancesheet": ("balancesheet", 34, 2000, False, "资产负债表（全部历史，实时更新）"),
    "cashflow": ("cashflow", 35, 2000, False, "现金流量表（全部历史，实时更新）"),
    "forecast": ("forecast", 36, 2000, False, "业绩预告（全部历史，实时更新）"),
    "express": ("express", 37, 2000, False, "业绩快报（全部历史，实时更新）"),
    "dividend": ("dividend", 38, 2000, False, "分红送股（全部历史，实时更新）"),
    "pledge_detail": ("pledge_detail", 55, 2000, False, "股权质押明细（2004 起，每日晚 9 点更新）"),
    "pledge_stat": ("pledge_stat", 56, 2000, False, "股权质押统计（2014 起，每日晚 9 点更新）"),
    "margin_detail": ("margin_detail", 57, 2000, False, "融资融券交易明细（2010 起，每日 9 点更新）"),
    "repurchase": ("repurchase", 43, 2000, False, "股票回购（2011 起，每日定时更新）"),
    "share_float": ("share_float", 44, 3000, False, "限售股解禁（定期更新，3000 分）"),
    "block_trade": ("block_trade", 45, 2000, False, "大宗交易（每日晚 9 点更新）"),
    "stk_holdernumber": ("stk_holdernumber", 46, 2000, False, "股东人数（不定期更新）"),
    "stk_holdertrade": ("stk_holdertrade", 47, 2000, False, "股东增减持（交易日 19 点更新）"),
    # ---- L172 第二批（指数/基金/期货/期权/债券/外汇，15000 档）----
    "index_basic": ("index_basic", 93, 2000, False, "指数基本信息（每日更新）"),
    "index_weekly": ("index_weekly", 96, 2000, True, "指数周线（每周盘后更新）"),
    "index_monthly": ("index_monthly", 97, 2000, True, "指数月线（每月盘后更新）"),
    "fund_basic": ("fund_basic", 25, 2000, False, "公募基金列表（定时更新）"),
    "fund_company": ("fund_company", 26, 2000, False, "公募基金公司（定时更新）"),
    "fund_nav": ("fund_nav", 24, 2000, False, "公募基金净值（每日定期更新）"),
    "fund_daily": ("fund_daily", 30, 2000, False, "场内基金日线行情（每日盘后更新）"),
    "fund_div": ("fund_div", 31, 2000, False, "公募基金分红（定期更新）"),
    "fut_basic": ("fut_basic", 111, 2000, False, "期货合约列表（全部历史）"),
    "trade_cal": ("trade_cal", 109, 2000, False, "期货交易日历（1996 起，定期更新）"),
    "fut_daily": ("fut_daily", 112, 2000, False, "期货日线行情（1996 起，每日盘后更新）"),
    "fut_holding": ("fut_holding", 113, 2000, False, "每日成交持仓排名（2002 起，每日盘后更新）"),
    "fut_wsr": ("fut_wsr", 114, 2000, False, "仓单日报（2006 起，每日盘后更新）"),
    "fut_settle": ("fut_settle", 115, 2000, False, "结算参数（2012 起，每日盘后更新）"),
    "opt_basic": ("opt_basic", 119, 2000, False, "期权合约列表（每日晚 8 点更新）"),
    "opt_daily": ("opt_daily", 120, 5000, False, "期权日线行情（每日 17 点更新，5000 分）"),
    "cb_basic": ("cb_basic", 121, 2000, False, "可转债基础信息（每日更新）"),
    "cb_issue": ("cb_issue", 122, 2000, False, "可转债发行数据（每日更新）"),
    "cb_daily": ("cb_daily", 123, 2000, False, "可转债日线数据（每日 17 点更新）"),
    "fx_obasic": ("fx_obasic", 134, 2000, False, "外汇基础信息（海外，每日更新）"),
    "fx_daily": ("fx_daily", 135, 2000, False, "外汇日线行情（每日更新）"),
}

#: 数据集接入模式（研究接口形态决定，非业务策略）。
_DATASET_MODES: dict[str, str] = {
    "fina_indicator": "per_instrument",
    "index_classify": "snapshot",
    "index_member_all": "snapshot",
    "dc_index": "daily",
    "dc_member": "per_board",
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
    "dc_index",
    "dc_member",
    # ---- L172 第一批 ----
    "daily",
    "weekly",
    "monthly",
    "new_share",
    "income",
    "balancesheet",
    "cashflow",
    "forecast",
    "express",
    "dividend",
    "pledge_detail",
    "pledge_stat",
    "margin_detail",
    "repurchase",
    "share_float",
    "block_trade",
    "stk_holdernumber",
    "stk_holdertrade",
    # ---- L172 第二批 ----
    "index_basic",
    "index_weekly",
    "index_monthly",
    "fund_basic",
    "fund_company",
    "fund_nav",
    "fund_daily",
    "fund_div",
    "fut_basic",
    "trade_cal",
    "fut_daily",
    "fut_holding",
    "fut_wsr",
    "fut_settle",
    "opt_basic",
    "opt_daily",
    "cb_basic",
    "cb_issue",
    "cb_daily",
    "fx_obasic",
    "fx_daily",
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
LIMIT_PCT_B_SHARE_STEP = Decimal("0.001")
LIMIT_PCT_B_SHARE_TOLERANCE = Decimal("0.0005")
LIMIT_PCT_SOURCE = "exchange_price_candidate"
LIMIT_PCT_FIELDS: tuple[str, ...] = ("limit_pct", "limit_pct_source")
LIMIT_PCT_RULE_VERSION = "exchange_quote_unit_2026-11-05"
#: 证据窗口（H4 m03419 要求写成三日样本，不是普适保证）：
LIMIT_PCT_EVIDENCE_WINDOW = "2026-11-03..2026-11-05"
#: B 股取整规则待 H4 签字前只作研究域派生，不宣称已验收。
LIMIT_PCT_B_SHARE_RULE_STATUS = "signed_h4_2026-11-05"
#: 北交所 A 股代码前缀（H4 m03419：全前缀 43/83/87/88/92；43/83/87/88 在样本内无数据）。
BSE_LIMIT_PREFIXES: tuple[str, ...] = ("43", "83", "87", "88", "92")
#: 沪市 B 股代码前缀（900xxx，报价单位 0.001 美元）；深市 B 股 200xxx（0.01 港元）。
SH_B_SHARE_PREFIX = "900"
SZ_B_SHARE_PREFIX = "200"

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


def _instrument_with_exchange(
    row: Mapping[str, Any], raw: Any, *, dataset: str
) -> str:
    """``stk_limit`` 的 instrument：优先 ``exchange`` + ``ts_code`` 的 code。

    真实样本里 ``900901.BJ`` 的 ``exchange`` 是 ``SSE``（镜面源后缀标注错位）；
    市场以 exchange 为准，避免把沪市 B 股错映射成北交所代码。
    """
    exchange = str(row.get("exchange") or "").strip().upper()
    text = str(raw).strip()
    code = text.split(".", 1)[0].strip()
    if exchange in {"SSE", "SZSE", "BSE"} and code.isdigit() and len(code) == 6:
        return f"{exchange}:{code}"
    return instrument_id_for(raw, dataset=dataset)


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
        elif column.kind == "instrument_exchange":
            # stk_limit：exchange 列权威（源里存在 900901.BJ + exchange=SSE 的镜面标注），
            # ts_code 后缀只用来取 code。
            result[column.canonical] = _instrument_with_exchange(row, raw, dataset=dataset)
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


def _round_limit_price(
    price: Decimal,
    pct: Decimal,
    sign: Decimal,
    *,
    step: Decimal = LIMIT_PCT_PRICE_STEP,
    rounding: str = ROUND_HALF_UP,
) -> Decimal:
    """候选涨/跌停价按交易所最小变动单位取整（H4 m03085）。

    SSE/SZSE 与北交所 B 股：0.01 / 0.001 元四舍五入；
    北交所 A 股：涨停向下截断、跌停向上截断（真实样本 354/354×3 日全中）。
    """
    raw = price * (Decimal(1) + sign * pct / Decimal(100))
    mode = {"half": ROUND_HALF_UP, "down": ROUND_DOWN, "up": ROUND_UP}[rounding]
    return raw.quantize(step, rounding=mode)


@dataclass(frozen=True, slots=True)
class LimitRoundingRule:
    """交易所 + 报价单位决定的限价取整规则（H4 m03419）。

    取值来自真实样本核对，但只在证据窗口内逐日对账；任何一行候选值对不上交易所
    原值就落 null 并计数，绝不「多命中挑一个」。
    """

    step: Decimal
    tolerance: Decimal
    up_rounding: str
    down_rounding: str


_RULE_HALF_001 = LimitRoundingRule(
    step=LIMIT_PCT_B_SHARE_STEP,
    tolerance=LIMIT_PCT_B_SHARE_TOLERANCE,
    up_rounding="half",
    down_rounding="half",
)
_RULE_HALF_001_SSE = _RULE_HALF_001
_RULE_HALF_001_SZSE = LimitRoundingRule(
    step=LIMIT_PCT_PRICE_STEP,
    tolerance=LIMIT_PCT_FLOAT_TOLERANCE,
    up_rounding="half",
    down_rounding="half",
)
_RULE_BSE_A = LimitRoundingRule(
    step=LIMIT_PCT_PRICE_STEP,
    tolerance=LIMIT_PCT_FLOAT_TOLERANCE,
    up_rounding="down",
    down_rounding="up",
)


def limit_rounding_rule(instrument_id: str) -> LimitRoundingRule | None:
    """按「交易所 + 报价单位」返回取整规则；未知市场返回 None（该行 limit_pct=null）。

    - 沪市 B 股 ``SSE:900xxx``：0.001 美元、四舍五入；
    - 深市 B 股 ``SZSE:200xxx``：0.01 港元、四舍五入；
    - 北交所 A 股 ``BSE:{43,83,87,88,92}xxxxx``：涨停向下截断、跌停向上截断；
    - SSE/SZSE 其它：0.01 元四舍五入。

    **不得用 ``900`` 前缀单独判市场**：源里出现过 ``900901.BJ`` 但 ``exchange=SSE``
    的镜面标注；判定看 exchange+code，不看 ``ts_code`` 后缀。
    """
    text = str(instrument_id or "")
    if ":" not in text:
        return None
    exchange, code = text.split(":", 1)
    if exchange == "SSE":
        return _RULE_HALF_001_SSE if code.startswith(SH_B_SHARE_PREFIX) else _RULE_HALF_001_SZSE
    if exchange == "SZSE":
        return _RULE_HALF_001_SZSE
    if exchange == "BSE":
        if code[:2] in BSE_LIMIT_PREFIXES:
            return _RULE_BSE_A
        return None
    return None


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
    rule = limit_rounding_rule(str(result.get("instrument_id") or ""))
    if rule is None:
        result["limit_pct"] = None
        result["limit_pct_source"] = None
        return
    for pct in LIMIT_PCT_BUCKETS:
        candidate_up = _round_limit_price(
            previous_close, pct, Decimal(1), step=rule.step, rounding=rule.up_rounding
        )
        candidate_down = _round_limit_price(
            previous_close, pct, Decimal(-1), step=rule.step, rounding=rule.down_rounding
        )
        if (
            abs(up_limit - candidate_up) <= rule.tolerance
            and abs(down_limit - candidate_down) <= rule.tolerance
        ):
            matched.append(pct)
    unique = matched[0] if len(matched) == 1 else None
    result["limit_pct"] = None if unique is None else format(unique, "f")
    result["limit_pct_source"] = LIMIT_PCT_SOURCE if unique is not None else None


_EXCHANGE_CODE_BY_MARKET = {
    "SSE": "SSE",
    "SZSE": "SZSE",
    "BSE": "BSE",
    "HKEX": "HKEX",
}


def _sample_instrument_id(sample: Mapping[str, Any]) -> str | None:
    """把源格式样本归一到 canonical ``EXCH:CODE``（C01：审计摘要也不得带源字段）。"""
    ts_code = str(sample.get("ts_code") or "")
    if "." in ts_code:
        code, suffix = ts_code.split(".", 1)
        market = _suffix_market(suffix)
        exchange = _EXCHANGE_TO_MARKET.get(str(sample.get("exchange") or "").upper(), market)
        if exchange and code:
            return f"{exchange}:{code.zfill(5) if exchange == 'HKEX' else code}"
    exchange = _EXCHANGE_TO_MARKET.get(str(sample.get("exchange") or "").upper())
    return None


def sanitize_consistency(report: Mapping[str, Any]) -> dict[str, Any]:
    """返回可离开适配层的审计报告：样本用 canonical 字段，不带源格式 ts_code。"""
    clean = dict(report)
    for key in ("samples", "unknown_samples"):
        cleaned: list[dict[str, Any]] = []
        for sample in report.get(key) or ():
            item = dict(sample)
            instrument_id = _sample_instrument_id(item)
            cleaned.append(
                {
                    "instrument_id": instrument_id,
                    "exchange": item.get("exchange"),
                    "flags": list(item.get("flags") or ()),
                    "known": bool(item.get("known")),
                }
            )
        clean[key] = cleaned
    return clean


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



# ---------- 源保真一致性（H4 m03540：mirror 的 ts_code 后缀不可作市场判据） ----------

_SUFFIX_MARKET = {"SH": "SSE", "SZ": "SZSE", "BJ": "BSE", "HK": "HKEX"}
#: 唯一已知且可带病运行的源保真缺陷：沪市 B 股 900xxx 被 mirror 标成 ``.BJ`` 后缀。
KNOWN_SUFFIX_DEFECT_PREFIX = "900"
_EXCHANGE_TO_MARKET = {
    "SSE": "SSE",
    "SZSE": "SZSE",
    "BSE": "BSE",
    "SH": "SSE",
    "SZ": "SZSE",
    "HK": "HKEX",
}


def _suffix_market(ts_code: str) -> str | None:
    return _SUFFIX_MARKET.get(str(ts_code).rsplit(".", 1)[-1].upper())


def _code_market(code: str) -> str | None:
    """按代码段推市场；只对 A/B 股与港股返回，其它（转债/基金/指数）返回 None。

    规则（H4 m03540）：900xxx=沪 B、200xxx=深 B、43/83/87/88/92=BSE A、
    6 开头（含 60/68）=SSE、0/2/3 开头=SZSE；5 位港股=HKEX。
    """
    if not code:
        return None
    if len(code) == 5 and code.isdigit():
        return "HKEX"
    if len(code) != 6 or not code.isdigit():
        return None
    if code.startswith(BSE_LIMIT_PREFIXES):
        return "BSE"
    if code[0] in ("6", "9"):
        return "SSE"
    if code[0] in ("0", "2", "3"):
        return "SZSE"
    return None


def source_consistency(dataset: str, rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """统计一批原始行里 ts_code 后缀 / 代码段 / exchange 的市场归属一致性。

    不阻断入库：不一致行记 warn（由 sync 写入 ``_meta/research_source_quality.json``）；
    仅当映射会因此改变 instrument_id 时计 ``mapping_affected_rows``（当前 ``stk_limit``
    以 exchange 为准，故 900901.BJ + exchange=SSE 计 41 行）。
    """
    report: dict[str, Any] = {
        "dataset": dataset,
        "rows": 0,
        "stock_rows": 0,
        "non_stock_rows": 0,
        "suffix_vs_exchange_mismatch": 0,
        "suffix_vs_code_mismatch": 0,
        "code_vs_exchange_mismatch": 0,
        "mapping_affected_rows": 0,
        "known_mismatch_rows": 0,
        "unknown_conflict_rows": 0,
        "samples": [],
        "unknown_samples": [],
    }
    suffix_exchange_mismatch = exchange_authoritative = False
    for row in rows:
        report["rows"] += 1
        raw_ts = str(row.get("ts_code") or "")
        suffix = _suffix_market(raw_ts)
        code = raw_ts.rsplit(".", 1)[0] if raw_ts else ""
        # 指数代码不是证券主键（000300.SH 的 000 段不代表深市），不参与 code 段判定。
        code_market = None if dataset == "index_daily" else _code_market(code)
        if code_market is None:
            report["non_stock_rows"] += 1
            continue
        report["stock_rows"] += 1
        raw_exchange = row.get("exchange")
        exchange_market = (
            _EXCHANGE_TO_MARKET.get(str(raw_exchange).upper()) if raw_exchange else None
        )
        bad: list[str] = []
        if exchange_market is not None:
            if suffix is not None and suffix != exchange_market:
                report["suffix_vs_exchange_mismatch"] += 1
                bad.append("suffix_vs_exchange")
                suffix_exchange_mismatch = True
                exchange_authoritative = True
            if code_market != exchange_market:
                report["code_vs_exchange_mismatch"] += 1
                bad.append("code_vs_exchange")
                exchange_authoritative = True
        if suffix is not None and suffix != code_market:
            report["suffix_vs_code_mismatch"] += 1
            bad.append("suffix_vs_code")
        if exchange_market is None and suffix is not None and suffix != code_market:
            # 无 exchange 列时，后缀/代码段冲突无法裁决，按后缀入库并记 warn。
            pass
        if bad:
            # H4 m03664：只有「900xxx + exchange=SSE + 后缀 .BJ」是已知可带病模式；
            # 其它任何冲突都视为未知缺陷 → 由适配层阻断该批（raise），不再只累计 warn。
            known = (
                code.startswith(KNOWN_SUFFIX_DEFECT_PREFIX)
                and suffix == "BSE"
                and exchange_market == "SSE"
            )
            report["mapping_affected_rows"] += 1
            if known:
                report["known_mismatch_rows"] += 1
            else:
                report["unknown_conflict_rows"] += 1
                if len(report["unknown_samples"]) < 10:
                    report["unknown_samples"].append(
                        {
                            "ts_code": raw_ts,
                            "exchange": raw_exchange,
                            "suffix_market": suffix,
                            "code_market": code_market,
                            "flags": bad,
                        }
                    )
            if len(report["samples"]) < 10:
                report["samples"].append(
                    {
                        "ts_code": raw_ts,
                        "exchange": raw_exchange,
                        "suffix_market": suffix,
                        "code_market": code_market,
                        "flags": bad,
                        "known": known,
                    }
                )
    if suffix_exchange_mismatch or exchange_authoritative:
        report["authoritative_field"] = "exchange"
    return report


class SourceConsistencyError(SchemaDriftError):
    """未知的源保真冲突（H4 m03664：按批阻断，不是 warn）。

    继承 ``SchemaDriftError`` 以复用 ADR-002 的「告警 + 拒绝入库」四类语义；
    ``report`` 携带样本便于 H4 定位（错误消息也带前 3 条）。
    """

    def __init__(self, dataset: str, report: Mapping[str, Any]) -> None:
        self.dataset = dataset
        self.report = dict(report)
        samples = report.get("unknown_samples") or []
        detail = "; ".join(
            f"{item.get('ts_code')} exchange={item.get('exchange')} flags={item.get('flags')}"
            for item in samples[:3]
        )
        super().__init__(
            f"unknown source consistency conflict in {dataset} "
            f"({report.get('unknown_conflict_rows')} rows): {detail}"
        )


__all__ = [
    "ColumnSpec",
    "DEFAULT_RESEARCH_DATASETS",
    "LIMIT_PCT_BUCKETS",
    "BSE_LIMIT_PREFIXES",
    "LIMIT_PCT_B_SHARE_RULE_STATUS",
    "LIMIT_PCT_EVIDENCE_WINDOW",
    "LIMIT_PCT_FIELDS",
    "LIMIT_PCT_RULE_VERSION",
    "LIMIT_PCT_SOURCE",
    "LIMIT_PCT_TOLERANCE",
    "RESEARCH_DATASETS",
    "ResearchDataset",
    "ResearchRowError",
    "SNAPSHOT_DATASETS",
    "SNAPSHOT_DATE_FIELD",
    "canonical_fields",
    "sanitize_consistency",
    "dedupe_rows",
    "LimitRoundingRule",
    "has_historical_members",
    "limit_rounding_rule",
    "hk_source_code",
    "partition_date",
    "instrument_id_for",
    "map_row",
    "source_consistency",
    "research_datasets",
    "row_date",
    "row_instrument",
]
