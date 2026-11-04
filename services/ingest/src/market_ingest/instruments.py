"""主数据（instrument）的领域规则：板块推导与最小交易单位。

这些是交易所规则，不是数据源概念，所以放在领域层由各 adapter 共用
（tushare 适配器与交易所基础信息 CSV 导入适配器都走这里，避免两套板块规则分叉）。
"""

from __future__ import annotations

from .models import Board, ExchangeCode

#: 代码前缀 → 法定板块。仅用于「源未明确给出板块」时的推导与冲突校验；
#: 交易所基础信息导入以文件里的法定板块为准（见 instruments_csv.detect_conflicts）。
BOARD_BY_PREFIX: tuple[tuple[tuple[str, ...], Board], ...] = (
    (("688", "689"), Board.STAR),
    (("300", "301"), Board.GEM),
    (("8", "4"), Board.BSE),
)

#: 最小交易单位（股）：科创板 200，其余（主板/创业板/北交所）100。
LOT_SIZE_BY_BOARD: dict[str, int] = {"star": 200, "main": 100, "gem": 100, "bse": 100}


def board_for_code(exchange: ExchangeCode, code: str) -> Board:
    """源代码 → canonical 板块（仅按前缀；不读源 ``market`` 字段）。"""
    if exchange is ExchangeCode.BSE:
        return Board.BSE
    for prefixes, board in BOARD_BY_PREFIX:
        if code.startswith(prefixes):
            return board
    return Board.MAIN


def lot_size_for_board(board: Board) -> int:
    return LOT_SIZE_BY_BOARD[board.value]


def lot_size_for_code(exchange: ExchangeCode, code: str) -> int:
    return lot_size_for_board(board_for_code(exchange, code))


__all__ = [
    "BOARD_BY_PREFIX",
    "LOT_SIZE_BY_BOARD",
    "board_for_code",
    "lot_size_for_board",
    "lot_size_for_code",
]
