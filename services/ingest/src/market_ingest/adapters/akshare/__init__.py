"""AKshare 数据源适配器：东方财富实时行情（A 股全市场快照）。

只允许上层通过 ``market_ingest.adapters.load_adapter`` 使用本包。
合规边界：AKshare 爬取东方财富公开数据，仅限内部研究/展示，C 端商用需另行授权。
"""

from .adapter import SOURCE_NAME, AkshareAdapter, create_adapter

__all__ = ["SOURCE_NAME", "AkshareAdapter", "create_adapter"]
