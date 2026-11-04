#!/usr/bin/env python3
"""调度入口：cron / K8s CronJob 调本文件（等价 ``python -m market_ingest sync-bars ...``）。

约定：
- 生产只跑增量（每日 T 日 19:00 后），回补必须显式带 ``--start/--end/--budget-calls``；
- 退出码 3 = 可续跑中断，调度器用同一命令重试即可（checkpoint 已落盘）；
- 令牌只从环境变量读（适配层内解析），禁止写进命令行/配置文件/日志。
"""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "services" / "ingest" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from market_ingest.cli import main  # noqa: E402  (路径注入后导入)

if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
