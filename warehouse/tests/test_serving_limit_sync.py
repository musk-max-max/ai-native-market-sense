"""serving_quote_latest limit_status 与 M04 口径同步门禁（F1，H4 2026-11-05 签发）。

背景：serving_quote_latest 内联 limit_pct 曾漂移到作废口径（主板 ST 恒 5%、缺 S 股 /
新股豁免 / 历史时点档，未知板块静默落 'none'），且无任何测试对照 M04（复核 F1 门禁盲区）。
本模块补两层覆盖：

1. 静态逐字（无 PG 依赖）：serving_quote_latest 内 limit_pct / limit_up_price /
   limit_down_price 三段 CASE 与 warehouse/metrics/m04_limit_status.sql 逐字（归一空白）相等；
   limit_status 内层 CASE 为 M04 同名块的子串（serving 外层多停牌/缺价 fail-closed 壳）。
   board NULL/'unknown' 等 DDL 不可插的用例由本层文本断言覆盖（fail-closed 不得回退）。

2. PG 行为矩阵（PG_TEST_DSN 指向一次性 scratch 库时执行，约定同 test_load 的
   test_real_pg_roundtrip_idempotent）：对 serving.serving_quote_latest 与 M04 SQL
   （:start_date/:end_date 以宽日期字面量替换）双对齐断言，钉住 L135.6 语义：
   limit_status NULL = 「规则不适用/未知」（新股前 5 交易日、开板前、listed_at 缺失、
   停牌/缺价），展示层不得渲染为「非涨停」。
"""

from __future__ import annotations

import importlib.util
import os
import re
from decimal import Decimal
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SERVING_SQL = REPO / "warehouse" / "serving" / "schema.sql"
DWD_SQL = REPO / "warehouse" / "dwd" / "schema.sql"
M04_SQL = REPO / "warehouse" / "metrics" / "m04_limit_status.sql"

_VIEW_START = "CREATE OR REPLACE VIEW serving.serving_quote_latest AS"
_VIEW_END = "CREATE OR REPLACE VIEW serving.serving_bar_daily"

PG_DSN = os.environ.get("PG_TEST_DSN", "")
HAS_PSYCOPG = importlib.util.find_spec("psycopg") is not None
needs_pg = pytest.mark.skipif(
    not PG_DSN or not HAS_PSYCOPG,
    reason="PG_TEST_DSN 未指向一次性 scratch 库（本地不接真实写库）",
)


# --------------------------------------------------------------------------
# 静态逐字：CASE/END 平衡扫描 + 归一比较
# --------------------------------------------------------------------------

def _strip_comments(text: str) -> str:
    return re.sub(r"--[^\n]*", "", text)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def _case_blocks(text: str) -> dict[str, str]:
    """提取「外层 CASE ... END AS <alias>」块，返回 {alias: 归一化文本}。

    深度计数以 \\bCASE\\b / \\bEND\\b 词界为准（先剥 -- 注释；本仓库 DDL/SQL 的
    字符串字面量不含独立 END/CASE 词）。内层嵌套 CASE 归属外层块，不单独出条目。
    """
    text = _strip_comments(text)
    blocks: dict[str, str] = {}
    pos = 0
    while True:
        m = re.search(r"\bCASE\b", text[pos:])
        if not m:
            break
        start = pos + m.start()
        depth = 0
        end = None
        for tok in re.finditer(r"\bCASE\b|\bEND\b", text[start:]):
            depth += 1 if tok.group() == "CASE" else -1
            if depth == 0:
                end = start + tok.end()
                break
        if end is None:  # 不平衡：视为扫描终止
            break
        am = re.match(r"\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)", text[end:])
        if am:
            blocks.setdefault(am.group(1), _normalize(text[start:end]))
        pos = end
    return blocks


def _serving_quote_sql() -> str:
    text = SERVING_SQL.read_text(encoding="utf-8")
    start = text.index(_VIEW_START)
    end = text.index(_VIEW_END)
    return text[start:end]


@pytest.fixture(scope="module")
def m04_blocks() -> dict[str, str]:
    return _case_blocks(M04_SQL.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def serving_blocks() -> dict[str, str]:
    return _case_blocks(_serving_quote_sql())


@pytest.mark.parametrize("alias", ["limit_pct", "limit_up_price", "limit_down_price"])
def test_m04_case_block_verbatim_in_serving(
    alias: str, m04_blocks: dict[str, str], serving_blocks: dict[str, str]
) -> None:
    """三段口径 CASE 必须与 M04 逐字同步（口径变更先改 docs/metrics 拿 H4 签字再改 SQL）。"""
    assert alias in m04_blocks, f"M04 缺 {alias} CASE（检查 warehouse/metrics/m04_limit_status.sql）"
    assert alias in serving_blocks, f"serving_quote_latest 缺 {alias} CASE"
    assert serving_blocks[alias] == m04_blocks[alias], (
        f"{alias} 与 M04 漂移：\nM04:     {m04_blocks[alias]}\nserving: {serving_blocks[alias]}"
    )


def test_limit_status_case_embeds_m04_with_fail_closed_shell(
    m04_blocks: dict[str, str], serving_blocks: dict[str, str]
) -> None:
    """limit_status：内层=M04 逐字；外层 fail-closed 壳（停牌/缺价→NULL，L135.6 不表态）。"""
    assert "limit_status" in m04_blocks and "limit_status" in serving_blocks
    assert m04_blocks["limit_status"] in serving_blocks["limit_status"], (
        "limit_status 内层 CASE 与 M04 漂移：\n"
        f"M04:     {m04_blocks['limit_status']}\nserving: {serving_blocks['limit_status']}"
    )
    shell = serving_blocks["limit_status"]
    assert shell.startswith("CASE WHEN p.suspended OR p.close IS NULL OR p.prev_close IS NULL THEN NULL")
    assert shell.count("CASE") == shell.count("END"), "limit_status CASE/END 不平衡"


def test_l1356_null_semantics_documented() -> None:
    """L135.6：limit_status NULL=规则不适用/未知；ports.yaml 须 nullable + 禁渲染「非涨停」。"""
    ports = (REPO / "warehouse" / "serving" / "ports.yaml").read_text(encoding="utf-8")
    assert "nullable: true" in ports
    assert "L135.6" in ports
    assert "非涨停" in ports


# --------------------------------------------------------------------------
# PG 行为矩阵：serving_quote_latest ↔ M04 双对齐
# --------------------------------------------------------------------------

TS = "2026-11-06T15:00:00+08:00"
BATCH = "a2_f1_test"

# (instrument_id, exchange, code, name, board, listed_at)
INSTRUMENTS = [
    ("SSE:600001", "SSE", "600001", "测试股份", "main", "2010-01-04"),
    ("SSE:600002", "SSE", "600002", "ST测试", "main", "2010-01-04"),
    ("SSE:600003", "SSE", "600003", "ST测试2", "main", "2010-01-04"),
    ("SSE:600004", "SSE", "600004", "S佳通", "main", "2010-01-04"),
    ("SSE:600005", "SSE", "600005", "S*ST佳通", "main", "2010-01-04"),
    ("SZSE:300001", "SZSE", "300001", "创业测试", "gem", "2010-01-04"),
    ("SZSE:300002", "SZSE", "300002", "创业测试2", "gem", "2010-01-04"),
    ("SSE:688001", "SSE", "688001", "科创测试", "star", "2010-01-04"),
    ("SSE:688002", "SSE", "688002", "科创测试2", "star", "2010-01-04"),
    ("BSE:430001", "BSE", "430001", "北交测试", "bse", "2010-01-04"),
    ("BSE:430002", "BSE", "430002", "北交测试2", "bse", "2010-01-04"),
    ("BSE:830001", "BSE", "830001", "北交测试3", "bse", "2010-01-04"),
    ("SSE:900901", "SSE", "900901", "B股测试", "main", "2010-01-04"),
    ("SZSE:301001", "SZSE", "301001", "新股测试", "gem", "2026-11-02"),
    ("SZSE:301002", "SZSE", "301002", "新股测试2", "gem", "2026-11-02"),
    ("SZSE:301003", "SZSE", "301003", "新股测试3", "gem", "2026-11-02"),
    ("SSE:600006", "SSE", "600006", "无上市日", "main", None),
    ("SSE:600009", "SSE", "600009", "停牌测试", "main", "2010-01-04"),
    ("SSE:600010", "SSE", "600010", "缺价测试", "main", "2010-01-04"),
    ("SSE:600011", "SSE", "600011", "ST边界", "main", "2010-01-04"),
]

# (instrument_id, trade_date, prev_close, close)；open=high=low=close
BARS = [
    ("SSE:600001", "2026-11-02", "10.00", "10.00"),
    ("SSE:600001", "2026-11-03", "10.00", "11.00"),
    ("SSE:600002", "2026-11-02", "10.00", "10.00"),
    ("SSE:600002", "2026-11-03", "10.00", "10.60"),   # 回归核心：10% 档应 none（旧 5% 误判 limit_up）
    ("SSE:600003", "2026-07-02", "10.00", "10.00"),
    ("SSE:600003", "2026-07-03", "10.00", "10.50"),   # <2026-07-06 ST 5% 档
    ("SSE:600004", "2026-11-02", "10.00", "10.00"),
    ("SSE:600004", "2026-11-03", "10.00", "10.40"),   # S 股 5% 档
    ("SSE:600005", "2026-11-02", "10.00", "10.00"),
    ("SSE:600005", "2026-11-03", "10.00", "10.50"),   # S*ST：S 股规则优先于 ST
    ("SZSE:300001", "2020-08-20", "10.00", "10.00"),
    ("SZSE:300001", "2020-08-21", "10.00", "10.90"),  # gem 10% 旧档
    ("SZSE:300002", "2020-08-21", "10.00", "10.00"),
    ("SZSE:300002", "2020-08-24", "10.00", "11.90"),  # gem 20% 新档
    ("SSE:688001", "2019-07-18", "10.00", "10.00"),
    ("SSE:688001", "2019-07-19", "10.00", "10.50"),   # star 开板前
    ("SSE:688002", "2019-07-22", "10.00", "12.00"),   # star 开板首日=20% 档
    ("BSE:430001", "2021-11-11", "10.00", "10.00"),
    ("BSE:430001", "2021-11-12", "10.00", "10.50"),   # bse 2021-11-15 前不猜精选层
    ("BSE:430002", "2021-11-12", "9.23", "9.23"),
    ("BSE:430002", "2021-11-15", "9.23", "11.99"),    # FLOOR(11.999)=11.99 / CEIL(6.461)=6.47
    ("BSE:830001", "2021-11-12", "2.86", "2.86"),
    ("BSE:830001", "2021-11-15", "2.86", "2.01"),     # CEIL(2.002)=2.01 / FLOOR(3.718)=3.71
    ("SSE:900901", "2026-11-02", "0.12", "0.12"),
    ("SSE:900901", "2026-11-03", "0.12", "0.13"),     # 沪 B 3dp：up=0.132>0.13 → none
    ("SZSE:301001", "2026-11-02", "10.00", "20.00"),  # 首日 trade_date=listed_at
    ("SZSE:301002", "2026-11-02", "20.00", "20.00"),
    ("SZSE:301002", "2026-11-03", "20.00", "25.00"),
    ("SZSE:301002", "2026-11-04", "25.00", "30.00"),  # trade_seq=3 ≤5 豁免
    ("SZSE:301003", "2026-11-02", "20.00", "20.00"),
    ("SZSE:301003", "2026-11-03", "20.00", "21.00"),
    ("SZSE:301003", "2026-11-04", "21.00", "22.00"),
    ("SZSE:301003", "2026-11-05", "22.00", "23.00"),
    ("SZSE:301003", "2026-11-06", "23.00", "24.00"),
    ("SZSE:301003", "2026-11-09", "24.00", "28.80"),  # seq=6 豁免结束，28.80=up
    ("SSE:600006", "2026-11-02", "10.00", "10.00"),
    ("SSE:600006", "2026-11-03", "10.00", "10.50"),   # listed_at NULL → fail-closed
    ("SSE:600009", "2026-11-02", "10.00", "10.00"),
    ("SSE:600010", "2026-11-03", None, "10.00"),      # prev_close NULL → M04 过滤
    ("SSE:600011", "2026-07-03", "10.00", "10.00"),
    ("SSE:600011", "2026-07-06", "10.00", "10.60"),   # ST 生效日当天=10% 档
]

# (instrument_id, trade_date) 停牌证据行
SUSPENSIONS = [("SSE:600009", "2026-11-03")]

D = Decimal
# instrument_id: (view_date, view_limit_status, m04_or_None)
#   m04 = (limit_pct, limit_up_price, limit_down_price, limit_status)
#   m04=None 表示该行不比对 M04（停牌日无 bar 行 / prev_close NULL 被 M04 过滤）
EXPECTED = {
    "SSE:600001": ("2026-11-03", "limit_up", (D("10"), D("11.00"), D("9.00"), "limit_up")),
    "SSE:600002": ("2026-11-03", "none", (D("10"), D("11.00"), D("9.00"), "none")),
    "SSE:600003": ("2026-07-03", "limit_up", (D("5"), D("10.50"), D("9.50"), "limit_up")),
    "SSE:600004": ("2026-11-03", "none", (D("5"), D("10.50"), D("9.50"), "none")),
    "SSE:600005": ("2026-11-03", "limit_up", (D("5"), D("10.50"), D("9.50"), "limit_up")),
    "SZSE:300001": ("2020-08-21", "none", (D("10"), D("11.00"), D("9.00"), "none")),
    "SZSE:300002": ("2020-08-24", "none", (D("20"), D("12.00"), D("8.00"), "none")),
    "SSE:688001": ("2019-07-19", None, (None, None, None, None)),
    "SSE:688002": ("2019-07-22", "limit_up", (D("20"), D("12.00"), D("8.00"), "limit_up")),
    "BSE:430001": ("2021-11-12", None, (None, None, None, None)),
    "BSE:430002": ("2021-11-15", "limit_up", (D("30"), D("11.99"), D("6.47"), "limit_up")),
    "BSE:830001": ("2021-11-15", "limit_down", (D("30"), D("3.71"), D("2.01"), "limit_down")),
    "SSE:900901": ("2026-11-03", "none", (D("10"), D("0.132"), D("0.108"), "none")),
    "SZSE:301001": ("2026-11-02", None, (None, None, None, None)),
    "SZSE:301002": ("2026-11-04", None, (None, None, None, None)),
    "SZSE:301003": ("2026-11-09", "limit_up", (D("20"), D("28.80"), D("19.20"), "limit_up")),
    "SSE:600006": ("2026-11-03", None, (None, None, None, None)),
    "SSE:600009": ("2026-11-03", None, None),
    "SSE:600010": ("2026-11-03", None, None),
    "SSE:600011": ("2026-07-06", "none", (D("10"), D("11.00"), D("9.00"), "none")),
}


@needs_pg
def test_serving_quote_latest_matches_m04_on_pg() -> None:
    """PG 行为矩阵：serving_quote_latest 与 M04 SQL 在 20 个用例上双对齐。

    约定：PG_TEST_DSN 指向一次性 scratch 库（createdb 专用，不指向真实库）。
    dwd schema 全 IF NOT EXISTS 幂等；serving 视图整 schema 重建（只含 views）。
    """
    import psycopg

    with psycopg.connect(PG_DSN, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(DWD_SQL.read_text(encoding="utf-8"))
            cur.execute("DROP SCHEMA IF EXISTS serving CASCADE")
            cur.execute(SERVING_SQL.read_text(encoding="utf-8"))

            ids = [row[0] for row in INSTRUMENTS]
            cur.execute("DELETE FROM dwd_stock_bar_daily WHERE instrument_id = ANY(%s)", (ids,))
            cur.execute("DELETE FROM dwd_suspended_daily WHERE instrument_id = ANY(%s)", (ids,))
            cur.execute("DELETE FROM dim_instrument WHERE instrument_id = ANY(%s)", (ids,))

            cur.executemany(
                "INSERT INTO dim_instrument (instrument_id, exchange, code, name, board,"
                " security_type, list_status, lot_size, listed_at, display_safe, source,"
                " as_of, fetched_at, ingested_at)"
                " VALUES (%s,%s,%s,%s,%s,'stock','listed',100,%s,false,'a2_f1_test',%s,%s,%s)",
                [(iid, ex, code, name, board, listed, TS, TS, TS)
                 for iid, ex, code, name, board, listed in INSTRUMENTS],
            )
            cur.executemany(
                "INSERT INTO dwd_stock_bar_daily (instrument_id, trade_date, open, high, low,"
                " close, volume, amount, prev_close, source, as_of, fetched_at, batch_id,"
                " ingested_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,100000,1000000,%s,'a2_f1_test',%s,%s,%s,%s)",
                [(iid, d, c, c, c, c, prev, TS, TS, BATCH, TS)
                 for iid, d, prev, c in BARS],
            )
            cur.executemany(
                "INSERT INTO dwd_suspended_daily (instrument_id, trade_date, source,"
                " as_of, fetched_at, batch_id, ingested_at)"
                " VALUES (%s,%s,'a2_f1_test',%s,%s,%s,%s)",
                [(iid, d, TS, TS, BATCH, TS) for iid, d in SUSPENSIONS],
            )

            m04_text = M04_SQL.read_text(encoding="utf-8")
            m04_text = m04_text.replace(":start_date", "DATE '1900-01-01'")
            m04_text = m04_text.replace(":end_date", "DATE '2100-01-01'")
            cur.execute(m04_text)
            m04_rows = {
                (iid, d.isoformat()): (pct, up, down, status)
                for iid, d, pct, up, down, status in cur.fetchall()
            }

            cur.execute(
                "SELECT instrument_id, trade_date, suspended, limit_status"
                " FROM serving.serving_quote_latest"
            )
            view_rows = {
                (iid, d.isoformat()): (suspended, status)
                for iid, d, suspended, status in cur.fetchall()
            }

    for iid, (view_date, view_status, m04_expected) in EXPECTED.items():
        key = (iid, view_date)
        assert key in view_rows, f"{iid} 期望最新 bar {view_date} 不在 serving_quote_latest"
        suspended, status = view_rows[key]
        assert suspended is (iid == "SSE:600009"), f"{iid} suspended 判定错误"
        assert status == view_status, (
            f"{iid}@{view_date} limit_status={status!r} 期望 {view_status!r}"
            "（NULL=规则不适用/未知，L135.6 不得渲染为「非涨停」）"
        )
        if m04_expected is None:
            continue
        assert key in m04_rows, f"{iid}@{view_date} M04 无输出行（prev_close 缺失？）"
        pct, up, down, m04_status = m04_rows[key]
        exp_pct, exp_up, exp_down, exp_status = m04_expected
        assert _num(pct) == exp_pct, f"{iid}@{view_date} M04 limit_pct={pct} 期望 {exp_pct}"
        assert _num(up) == exp_up, f"{iid}@{view_date} M04 limit_up={up} 期望 {exp_up}"
        assert _num(down) == exp_down, f"{iid}@{view_date} M04 limit_down={down} 期望 {exp_down}"
        assert m04_status == exp_status, f"{iid}@{view_date} M04 limit_status={m04_status!r} 期望 {exp_status!r}"
        assert status == m04_status, f"{iid}@{view_date} serving({status!r}) 与 M04({m04_status!r}) 不一致"


def _num(value: object) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))
