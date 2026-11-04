"""tests/data 自举：让 quality_lib 可直接 import（CI 与本地都一致）。"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
