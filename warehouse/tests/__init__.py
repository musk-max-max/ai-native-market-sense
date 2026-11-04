"""A2 数仓单测（属于 warehouse/ 写域；A11 的 tests/ 归 A11，本目录只测数仓内部）。

运行：python3 -m pytest warehouse/tests -q
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
