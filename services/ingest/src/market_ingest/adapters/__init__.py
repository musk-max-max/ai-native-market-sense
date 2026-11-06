"""数据源适配器包（S0 首个竖切片只含一个数据源实现）。

上层通过 ``market_ingest.adapters.load_adapter`` 按逻辑名/自动发现拿端口实例，
不得直接 import 本包内的任何模块（否则泄露源字段与 SDK 概念）。
"""

from __future__ import annotations

from importlib import import_module
from typing import Any, Mapping

from ..ports import MarketDataSource

#: 逻辑名 → 工厂模块路径（模块内 ``create_adapter``）。
_ADAPTER_FACTORIES: dict[str, str] = {
    "tushare": "market_ingest.adapters.tushare.adapter",
    # AKshare 东方财富实时行情（A 股全市场快照）
    "akshare": "market_ingest.adapters.akshare.adapter",
    # 交易所基础信息 CSV 导入（C 端白名单主数据；不是行情源）
    "csv": "market_ingest.adapters.csv.instruments",
}


def registered() -> tuple[str, ...]:
    return tuple(_ADAPTER_FACTORIES)


def load_adapter(
    name: str = "auto",
    *,
    options: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> MarketDataSource:
    """按名字构建适配器；``auto`` 取第一个注册项（当前唯一项）。

    配置不完整（如缺 token）时工厂抛 ``ValueError``，本层不吞异常。
    """
    if name != "auto" and name not in _ADAPTER_FACTORIES:
        raise ValueError(f"unknown adapter {name!r}; registered={sorted(_ADAPTER_FACTORIES)}")
    chosen = name if name != "auto" else next(iter(_ADAPTER_FACTORIES))
    module = import_module(_ADAPTER_FACTORIES[chosen])
    factory = getattr(module, "create_adapter")
    return factory(dict(options or {}), **kwargs)
