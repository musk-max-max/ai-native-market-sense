"""market-sense-h5 数仓（A2 所有）。

分层：ODS（A1 落地的 canonical 批次文件） → DWD（本包清洗/去重/口径归一）
      → DWS/serving（P1，尚未启用）。

入口：
  python3 -m warehouse.pipeline --golden data/golden/p0_bars20.yaml
规范：warehouse/README.md（ODS 交换格式 v1）、docs/metrics/P0-metrics.md（口径立法）。
"""

__version__ = "0.1.0"
