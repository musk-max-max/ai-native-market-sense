#!/usr/bin/env python3
"""生成合成录制（A12，L32 裁定：不录真实 tushare 报文）。

为什么不用真实录制：F1 条款是「个人、非商业、仅个人查看」，把真实报文落进
公司仓库等于把上游数据再分发。因此本脚本生成的每一个值都是伪造的、一眼可辨：
标的名 `SYNTHETIC-*`、价格为 9999.99 一类明显不合理的数、成交量/营收全为整数常量。

覆盖范围：只覆盖 P0 seed（ingest-once）实际会发出的 tushare 调用——
`sync-bars`（daily / adj_factor / trade_cal / suspend_d）与
`fetch_fundamentals`（fina_indicator / income）。多录不报错，少录会在 replay 时
返回 503 FIXTURE_MISSING（显式失败，绝不伪造数据）。

用法（在仓库根）：
    python3 tests/fixtures/tushare/synthetic/build_recordings.py
    python3 tests/fixtures/tushare/synthetic/build_recordings.py --check   # 只校验现状

产出：tests/fixtures/tushare/recordings/<key>.json + manifest.json（稳定排序，可 diff）。
键的计算复用 tests/e2e/tushare-replay/server.py:canonical_key，保证与回放代理一致。
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import tempfile
import types
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURES_ROOT = REPO_ROOT / "tests/fixtures/tushare"
RECORDINGS = FIXTURES_ROOT / "recordings"
REPLAY_SERVER = REPO_ROOT / "tests/e2e/tushare-replay/server.py"
INGEST_SRC = REPO_ROOT / "services/ingest/src"

#: 合成录制的固定时间戳（进 git，必须稳定；不是真实录制时间）。
SYNTHETIC_RECORDED_AT = "synthetic:2026-11-03"
SYNTHETIC_NAMES = {"SSE:600519": "SYNTHETIC-甲", "SZSE:000001": "SYNTHETIC-乙", "SSE:601398": "SYNTHETIC-丙"}
INSTRUMENTS = tuple(SYNTHETIC_NAMES)
START = date(2026, 10, 28)
END = date(2026, 11, 3)
PRICE = 9999.99


def load_replay_server_module() -> types.ModuleType:
    """按文件路径加载 server.py（不能 import：目录名 tushare-replay 含连字符）。"""
    spec = importlib.util.spec_from_file_location("tushare_replay_server", REPLAY_SERVER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # dataclass 需要模块先注册进 sys.modules，否则 @dataclass 抛 AttributeError
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def trading_days(start: date, end: date):
    day = start
    while day <= end:
        if day.weekday() < 5:
            yield day
        day += timedelta(days=1)


def source_code(instrument_id: str) -> str:
    exchange, code = instrument_id.split(":", 1)
    suffix = {"SSE": "SH", "SZSE": "SZ", "BSE": "BJ"}[exchange]
    return f"{code}.{suffix}"


def rows_for(api_name: str, params: dict):
    """按请求参数造 rows；值全部是伪造的常量。"""
    if api_name in ("daily", "adj_factor"):
        start = _param_date(params.get("start_date")) or START
        end = _param_date(params.get("end_date")) or END
        ts_code = params.get("ts_code") or source_code(INSTRUMENTS[0])
        rows = []
        prev = PRICE - 1.0
        for day in trading_days(start, end):
            if api_name == "daily":
                rows.append({
                    "ts_code": ts_code,
                    "trade_date": day.strftime("%Y%m%d"),
                    "open": PRICE - 0.99, "high": PRICE + 0.01, "low": PRICE - 1.99,
                    "close": PRICE, "pre_close": prev, "change": round(PRICE - prev, 2),
                    "pct_chg": 0.01, "vol": 123456.0, "amount": 123456789.0,
                })
                prev = PRICE
            else:
                rows.append({"ts_code": ts_code, "trade_date": day.strftime("%Y%m%d"), "adj_factor": 1.0})
        return rows
    if api_name == "trade_cal":
        start = _param_date(params.get("start_date")) or START
        end = _param_date(params.get("end_date")) or END
        return [{"cal_date": d.strftime("%Y%m%d"), "is_open": "1"} for d in trading_days(start, end)]
    if api_name == "suspend_d":
        return []
    if api_name == "stock_basic":
        return [
            {"ts_code": source_code(iid), "symbol": iid.split(":")[1], "name": SYNTHETIC_NAMES[iid],
             "market": "主板", "list_date": "20200101", "delist_date": None, "list_status": "L",
             "exchange": iid.split(":")[0]}
            for iid in INSTRUMENTS
        ]
    if api_name == "fina_indicator":
        return [{"ts_code": params.get("ts_code"), "ann_date": "20261028", "end_date": "20260930",
                 "eps": 9.99, "roe": 99.9, "grossprofit_margin": 99.0, "or_yoy": 99.0, "netprofit_yoy": 99.0}]
    if api_name == "income":
        return [{"ts_code": params.get("ts_code"), "ann_date": "20261028", "end_date": "20260930",
                 "total_revenue": 999999999.0, "n_income_attr_p": 99999999.0}]
    raise SystemExit(f"未预期的 tushare 接口 {api_name!r}：请先补合成行生成规则，勿伪造空 data")


def _param_date(value) -> date | None:
    if not value or len(str(value)) != 8:
        return None
    text = str(value)
    return date(int(text[:4]), int(text[4:6]), int(text[6:8]))


class CapturingSyntheticTransport:
    """注入 adapter 的传输：记录请求 + 按请求造行，绝不发网络。"""

    def __init__(self):
        self.calls: list[dict] = []

    def call(self, api_name, params, fields):
        params = dict(params)
        rows = rows_for(api_name, params)
        offset = int(params.get("offset", 0) or 0)
        limit = int(params.get("limit", 6000) or 6000)
        page = rows[offset:offset + limit]
        self.calls.append({
            "api_name": api_name,
            "params": params,
            "fields": [str(f) for f in fields],
            "rows": page,
        })
        return page


def capture_calls() -> list[dict]:
    """跑 P0 seed 的真实代码路径（sync-bars / fetch_fundamentals），截获全部 tushare 请求。"""
    sys.path.insert(0, str(INGEST_SRC))
    from market_ingest.adapters.tushare.adapter import create_adapter  # noqa: PLC0415
    import market_ingest.cli as cli  # noqa: PLC0415

    transport = CapturingSyntheticTransport()
    adapter = create_adapter({}, transport=transport)
    original = cli.load_adapter
    cli.load_adapter = lambda name="auto", **kwargs: adapter  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory(prefix="synthetic-recordings-") as tmp:
            rc = cli.main([
                "sync-bars", "--instruments", ",".join(INSTRUMENTS),
                "--start", START.isoformat(), "--end", END.isoformat(),
                "--db", str(Path(tmp) / "ingest.db"), "--ods-root", str(Path(tmp) / "ods"),
            ])
            if rc != 0:
                raise SystemExit(f"sync-bars 失败（rc={rc}），无法生成录制")
    finally:
        cli.load_adapter = original
    adapter.fetch_fundamentals(list(INSTRUMENTS))
    return transport.calls


def build_entries(server, calls: list[dict]) -> list[dict]:
    entries = []
    for call in calls:
        fields = call["fields"]
        request = {
            "api_name": call["api_name"],
            "params": call["params"],
            "fields": server.normalize_fields(fields),
        }
        key = server.canonical_key({"api_name": call["api_name"], "params": call["params"], "fields": fields})
        response = {
            "code": 0,
            "msg": "synthetic fixture (L32: 非真实 tushare 报文)",
            "data": {
                "fields": fields,
                "items": [[row.get(f) for f in fields] for row in call["rows"]],
            },
        }
        entries.append({
            "schema_version": 1,
            "key": key,
            "kind": "tushare-http-raw",
            "scope": "raw-source",
            "request": request,
            "http_status": 200,
            "response": response,
            "recorded_at": SYNTHETIC_RECORDED_AT,
            "upstream": "synthetic://l32 (not real tushare; do not replace with real payloads)",
        })
    return entries


def write_fixtures(entries: list[dict]) -> None:
    RECORDINGS.mkdir(parents=True, exist_ok=True)
    for stale in RECORDINGS.glob("*.json"):
        stale.unlink()
    for entry in sorted(entries, key=lambda item: item["key"]):
        path = RECORDINGS / f"{entry['key']}.json"
        path.write_text(json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "generated_by": "tests/fixtures/tushare/synthetic/build_recordings.py (L32 synthetic only)",
        "updated_at": SYNTHETIC_RECORDED_AT,
        "recordings": [
            {
                "key": entry["key"],
                "api_name": entry["request"]["api_name"],
                "file": f"recordings/{entry['key']}.json",
                "recorded_at": entry["recorded_at"],
            }
            for entry in sorted(entries, key=lambda item: item["key"])
        ],
    }
    (FIXTURES_ROOT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def check_fixtures(entries: list[dict]) -> int:
    expected = {entry["key"]: entry for entry in entries}
    actual = {path.stem for path in RECORDINGS.glob("*.json")}
    problems = []
    if actual != set(expected):
        problems.append(f"recordings 与生成结果不一致：缺 {sorted(set(expected) - actual)}，多 {sorted(actual - set(expected))}")
    for key, entry in expected.items():
        path = RECORDINGS / f"{key}.json"
        if not path.is_file():
            continue
        current = json.loads(path.read_text(encoding="utf-8"))
        if current.get("request") != entry["request"] or current.get("response") != entry["response"]:
            problems.append(f"{key}: 内容漂移（请重跑生成脚本，不要手改 recordings）")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"OK: {len(expected)} 条合成录制与生成规则一致")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成/校验 L32 合成 tushare 录制")
    parser.add_argument("--check", action="store_true", help="只校验现有 recordings 是否与生成规则一致")
    args = parser.parse_args(argv)
    server = load_replay_server_module()
    calls = capture_calls()
    entries = build_entries(server, calls)
    if args.check:
        return check_fixtures(entries)
    write_fixtures(entries)
    print(f"写出 {len(entries)} 条合成录制 -> {RECORDINGS}")
    by_api: dict[str, int] = {}
    for entry in entries:
        by_api[entry["request"]["api_name"]] = by_api.get(entry["request"]["api_name"], 0) + 1
    print("按接口统计：" + ", ".join(f"{name}×{count}" for name, count in sorted(by_api.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
