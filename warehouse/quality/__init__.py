"""数据质量：四类规则 + 质量分（配置：warehouse/quality/quality_config.json）。

规则编号与 docs/metrics/P0-metrics.md §数据质量 一一对应；改规则/阈值属于 must_escalate
（质量阈值调整），必须获 H4 签字后同步改 config 与 docs。
"""

from warehouse.quality.checks import QualityReport, RuleResult, Violation, run_quality_checks  # noqa: F401
