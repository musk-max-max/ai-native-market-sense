"""AKshare 适配器单测：板块涨跌停判定（纯函数，无需网络）。

覆盖 _board_limit_pct/_limit_status_for：主板 ±10%、科创/创业 ±20%、北交所 ±30%，
且 fail-closed（数据缺失归 NONE，不臆断）。
"""

from __future__ import annotations

from decimal import Decimal

from market_ingest.adapters.akshare.adapter import (
    _board_limit_pct,
    _limit_status_for,
)
from market_ingest.models import LimitStatus


def test_board_limit_pct_by_board() -> None:
    assert _board_limit_pct("SSE:600519") == Decimal("10")  # 沪主板
    assert _board_limit_pct("SZSE:000001") == Decimal("10")  # 深主板
    assert _board_limit_pct("SSE:688001") == Decimal("20")  # 科创板
    assert _board_limit_pct("SSE:689009") == Decimal("20")  # 科创板 CDR
    assert _board_limit_pct("SZSE:300750") == Decimal("20")  # 创业板
    assert _board_limit_pct("SZSE:301236") == Decimal("20")  # 创业板注册制
    assert _board_limit_pct("BSE:830799") == Decimal("30")  # 北交所


def test_limit_status_main_board_threshold() -> None:
    # 主板 ±10%，9.97% 触板（容差 0.1 内），10.5% 仍判 LIMIT_UP（越界即涨停态）
    assert _limit_status_for("SSE:600519", Decimal("9.97")) == LimitStatus.LIMIT_UP
    assert _limit_status_for("SSE:600519", Decimal("-9.97")) == LimitStatus.LIMIT_DOWN
    assert _limit_status_for("SSE:600519", Decimal("5.0")) == LimitStatus.NONE


def test_limit_status_star_chinext_not_mislabeled_at_10() -> None:
    # 科创/创业 ±20%：涨 10% 不是涨停（旧 ±9.9% 硬编码会误标）
    assert _limit_status_for("SSE:688001", Decimal("10.0")) == LimitStatus.NONE
    assert _limit_status_for("SZSE:300750", Decimal("10.0")) == LimitStatus.NONE
    assert _limit_status_for("SSE:688001", Decimal("19.95")) == LimitStatus.LIMIT_UP
    assert _limit_status_for("SZSE:301236", Decimal("-19.95")) == LimitStatus.LIMIT_DOWN


def test_limit_status_bse_threshold_30() -> None:
    # 北交所 ±30%：涨 10% 不是涨停，涨 29.95% 才触板
    assert _limit_status_for("BSE:830799", Decimal("10.0")) == LimitStatus.NONE
    assert _limit_status_for("BSE:830799", Decimal("29.95")) == LimitStatus.LIMIT_UP
    assert _limit_status_for("BSE:830799", Decimal("-29.95")) == LimitStatus.LIMIT_DOWN


def test_limit_status_missing_data_fail_closed() -> None:
    # 数据缺失归 NONE，不臆断
    assert _limit_status_for("SSE:600519", None) == LimitStatus.NONE
