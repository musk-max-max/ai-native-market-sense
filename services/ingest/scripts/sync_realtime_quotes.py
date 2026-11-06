#!/usr/bin/env python3
"""AKshare 实时行情同步脚本（替换 fixture 价格）。

用途：从 AKshare（东方财富源）拉取 A 股全市场实时快照，写入 dwd_realtime_quote。
替代 real-stack-audit.ts 中硬编码的 fixture 价格（SSE:600519 假价 1510 元）。

合规标注：AKshare 为爬虫封装东方财富，F1 residual——仅限内部研究/展示域，
C 端商用需另行授权（见 agents/decisions.md 红线①）。

用法：
    python scripts/sync_realtime_quotes.py [--dsn postgresql://...] [--dry-run]

环境变量：
    MARKET_TEST_DATABASE_URL  PostgreSQL 连接串（默认 postgresql://ms@127.0.0.1:55432/market_a3_test）
"""

from __future__ import annotations

import argparse
import os
import sys
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 把 src 加入 path 以便 import market_ingest
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from market_ingest.adapters.akshare.adapter import AkshareAdapter  # noqa: E402
from market_ingest.models import LimitStatus  # noqa: E402

MARKET_TZ = timezone(timedelta(hours=8))

DEFAULT_DSN = os.environ.get(
    "MARKET_TEST_DATABASE_URL",
    "postgresql://ms@127.0.0.1:55432/market_a3_test",
)

UPSERT_SQL = """
INSERT INTO dwd_realtime_quote (
    instrument_id, as_of, last, prev_close, open, high, low,
    volume, amount, pct_change, change, turnover_rate, volume_ratio,
    limit_status, source, fetched_at, batch_id, ingested_at
) VALUES (
    %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s
)
ON CONFLICT (instrument_id, as_of) DO UPDATE SET
    last = EXCLUDED.last,
    prev_close = EXCLUDED.prev_close,
    open = EXCLUDED.open,
    high = EXCLUDED.high,
    low = EXCLUDED.low,
    volume = EXCLUDED.volume,
    amount = EXCLUDED.amount,
    pct_change = EXCLUDED.pct_change,
    change = EXCLUDED.change,
    turnover_rate = EXCLUDED.turnover_rate,
    volume_ratio = EXCLUDED.volume_ratio,
    limit_status = EXCLUDED.limit_status,
    fetched_at = EXCLUDED.fetched_at,
    batch_id = EXCLUDED.batch_id,
    ingested_at = EXCLUDED.ingested_at
"""


def limit_status_str(ls: LimitStatus) -> str:
    return {
        LimitStatus.LIMIT_UP: "limit_up",
        LimitStatus.LIMIT_DOWN: "limit_down",
        LimitStatus.NONE: "none",
    }[ls]


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync AKshare realtime quotes to dwd_realtime_quote")
    parser.add_argument("--dsn", default=DEFAULT_DSN, help="PostgreSQL connection string")
    parser.add_argument("--dry-run", action="store_true", help="Fetch only, don't write to DB")
    args = parser.parse_args()

    # 1. 拉取实时快照
    print("[sync] fetching AKshare realtime snapshot ...")
    adapter = AkshareAdapter()
    quotes = adapter.list_realtime_quotes()
    print(f"[sync] fetched {len(quotes)} instruments")

    if not quotes:
        print("[sync] no data fetched, aborting")
        return 1

    if args.dry_run:
        # 只展示前 5 条
        for q in quotes[:5]:
            print(f"  {q.instrument_id} last={q.last_price} pct={q.change_pct}% vol={q.volume}")
        print(f"[sync] dry-run: would upsert {len(quotes)} rows")
        return 0

    # 2. 写入 PostgreSQL
    try:
        import psycopg2
    except ImportError:
        print("[sync] ERROR: psycopg2 not installed (pip install psycopg2-binary)")
        return 1

    batch_id = f"akshare-rt-{uuid.uuid4().hex[:12]}"
    now_utc = datetime.now(timezone.utc)
    now_market = datetime.now(MARKET_TZ)

    conn = psycopg2.connect(args.dsn)
    conn.autocommit = False
    cur = conn.cursor()

    inserted = 0
    for q in quotes:
        try:
            cur.execute(
                UPSERT_SQL,
                (
                    q.instrument_id,
                    q.source.as_of,
                    q.last_price,
                    q.prev_close,
                    q.open,
                    q.high,
                    q.low,
                    q.volume,
                    q.amount,
                    q.change_pct,
                    q.change,
                    None,  # turnover_rate 不在 QuoteRecord 中
                    None,  # volume_ratio 不在 QuoteRecord 中
                    limit_status_str(q.limit_status),
                    q.source.source,
                    q.source.fetched_at,
                    batch_id,
                    now_market,
                ),
            )
            inserted += 1
        except Exception as exc:
            print(f"[sync] WARN: failed to upsert {q.instrument_id}: {exc}")

    conn.commit()
    cur.close()
    conn.close()

    print(f"[sync] done: {inserted}/{len(quotes)} rows upserted, batch_id={batch_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
