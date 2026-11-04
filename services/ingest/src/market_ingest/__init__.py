"""A1 数据接入 + 调度服务（market-sense-h5）。

分层（ADR-002 六边形）：
- ``models`` / ``ports``：canonical 模型与数据源端口，业务层唯一可见边界；
- ``adapters/``：唯一允许出现数据源字段名/端点/错误码的位置；
- ``quota`` / ``sync`` / ``storage``：限流配额、分块续跑、raw 不可变台账（源无关）；
- ``cli``：``python -m market_ingest`` 入口（调度器调用 ``jobs/sync_bars.py``）。
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
