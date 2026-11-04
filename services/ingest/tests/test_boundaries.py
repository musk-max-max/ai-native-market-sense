"""边界闸：适配层之外不得出现数据源字样/字段名（task-3 验收项）。

范围说明：``src/`` 下除 ``adapters/`` 之外的所有文件（即业务/编排/存储层）。
测试与录制夹具本身必然包含源字段（录播的就是源原始响应），不在本闸范围内；
夹具豁免需 A0/A11 在 CI grep 规则中显式登记（已在 handoff 中提出）。
"""

from __future__ import annotations

from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "market_ingest"
#: 数据源专属字样（源名、原始字段名/接口名、代码后缀、端点）。
#: 注意：``adj_factor.v1`` 是 canonical ODS schema 名（A2 交换格式），不是源字段泄漏，
#: 因此这里不把裸 "adj_factor" 当违规；同时禁源特有接口名（suspend_d/trade_cal）。
FORBIDDEN_MARKERS = (
    # 注意：源名 "tushare" 作为**合规渠道标识**必须出现在 manifest 事件里
    # （H4 m00801：tushare 渠道也要纳入 manifest，靠 channel 区分），
    # 因此该字面量在 manifest 域模块里白名单放行；耦合型泄露（字段名/端点/
    # SDK import）仍由下面的源字段标记与 import 检查拦截。
    "ts_code",
    "pre_close",
    "suspend_d",
    "trade_cal",
    ".SH/",
    "api.tushare.pro",
)


#: 允许出现渠道标识 "tushare" 的 manifest 域模块（仅作为 channel 值，不是源耦合）。
CHANNEL_LITERAL_FILES = {"manifest.py", "instruments.py", "instruments_csv.py", "instruments_import.py"}


def _scanned_files() -> list[Path]:
    return [
        path
        for path in SRC.rglob("*.py")
        if "adapters" not in path.relative_to(SRC).parts
    ]


def test_no_source_literals_outside_adapters() -> None:
    offenders: list[str] = []
    for path in _scanned_files():
        text = path.read_text(encoding="utf-8")
        for marker in FORBIDDEN_MARKERS:
            if marker in text:
                offenders.append(f"{path.relative_to(SRC)}: {marker!r}")
        if "tushare" in text and path.name not in CHANNEL_LITERAL_FILES:
            offenders.append(f"{path.relative_to(SRC)}: 'tushare'")
    assert offenders == [], f"source literals escaped the adapter layer: {offenders}"


def test_adapters_are_only_loaded_through_registry() -> None:
    """业务层禁止 import adapters 子模块（只允许 ``load_adapter``）。"""
    offenders: list[str] = []
    for path in _scanned_files():
        text = path.read_text(encoding="utf-8")
        if "from .adapters." in text or "import market_ingest.adapters." in text:
            offenders.append(str(path.relative_to(SRC)))
    # cli.py 只从 adapters 包导入 load_adapter，合法。
    assert offenders == []
