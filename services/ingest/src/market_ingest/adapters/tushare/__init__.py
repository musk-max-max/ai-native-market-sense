"""数据源适配器：配置驱动工厂 + 端口实现。

只允许上层通过 ``market_ingest.adapters.load_adapter`` 使用本包。
"""

from .adapter import SOURCE_NAME, TushareAdapter, create_adapter

__all__ = ["SOURCE_NAME", "TushareAdapter", "create_adapter"]
