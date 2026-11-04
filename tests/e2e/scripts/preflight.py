#!/usr/bin/env python3
"""E2E 准入检查（A12 owns）—— 决定「跑 / 跳过 / 失败」，并把原因写进机器可读状态文件。

设计要点（对应 task-7 验收）：
  * 空实现时必须 SKIP 而非 FAIL；缺 fixture 不能静默——报告中显式列出（且按 Lead 2026-11-04 裁定：
    录播只是 P0-10 的前置，不把其余用例整体 FAIL/SKIP）。
  * 「可测」= api /healthz 可达且 data_ready=true，不是「compose 起来了」；原生栈同样算可测。
  * 栈未起 / 无 docker → SKIP(78)，不把环境问题算成产品 bug。
  * 栈与实现都就绪、但 fixture 缺失或损坏 → FAIL(1)（这是 E2E 资产的真实缺陷）。
  * 退出码约定：0=READY，78=SKIP（沿用 automake 的 77/78 传统），1=FAIL。

用法：
  python3 tests/e2e/scripts/preflight.py            # 完整检查（含网络探针）
  python3 tests/e2e/scripts/preflight.py --offline  # 只做离线静态检查（无 docker 环境自检用）
  python3 tests/e2e/scripts/preflight.py --json /tmp/status.json

环境变量：
  E2E_WEB_URL     默认 http://127.0.0.1:3000
  E2E_API_URL     默认 http://127.0.0.1:8081
  E2E_REPLAY_URL  默认 http://127.0.0.1:18081
  E2E_STOCK_PATH  个股页路由模板，默认 /stocks/{instrument_id}
  E2E_AUTH_TOKEN  自选用例所需登录态；缺失时相关用例 skip 并在此报告
  E2E_ENTITLEMENT_MATRIX  授权矩阵 normal|restricted，默认 normal（normal 要求 is_entitled=true）
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import quote
from datetime import datetime, timezone
from pathlib import Path

E2E_DIR = Path(__file__).resolve().parents[1]
ROOT = E2E_DIR.parents[1]
FIXTURES = Path(os.environ.get("E2E_FIXTURES_DIR", ROOT / "tests" / "fixtures" / "tushare"))
RECORDINGS = FIXTURES / "recordings"
SCENARIOS = FIXTURES / "scenarios"
REQUIRED_SCENARIO = SCENARIOS / "p0-stock-page.json"
TESTIDS = E2E_DIR / "testids.json"
SPECS = E2E_DIR / "specs"
QUARANTINE = E2E_DIR / "quarantine.json"
INGEST_REPORT = Path(os.environ.get("E2E_INGEST_REPORT", str(E2E_DIR / ".state" / "ingest-report.json")))
# 数据类 SKIP：data_ready=true 时这些理由与「数据已就绪」互斥（Lead 2026-11-04 要求 FAIL:CONTRADICTION）
# 只有「数据本身」的 SKIP 与 data_ready=true 互斥；录播（FIXTURES/REPLAY）只是 P0-10 的前置。
DATA_RELATED_SKIP_PREFIXES = ("DATA_NOT_READY", "INGEST_REPORT")

WEB = os.environ.get("E2E_WEB_URL", "http://127.0.0.1:3000").rstrip("/")
API = os.environ.get("E2E_API_URL", "http://127.0.0.1:8081").rstrip("/")
REPLAY = os.environ.get("E2E_REPLAY_URL", "http://127.0.0.1:18081").rstrip("/")
STOCK_PATH = os.environ.get("E2E_STOCK_PATH", "/stocks/{instrument_id}")

OK, WARN, FAIL, SKIP = "ok", "warn", "fail", "skip"


class Checks:
    def __init__(self):
        self.items = []

    def add(self, level: str, check_id: str, detail: str):
        self.items.append({"id": check_id, "level": level, "detail": detail})
        return level

    def by_level(self, level):
        return [i for i in self.items if i["level"] == level]

    def ids(self, level):
        return {i["id"] for i in self.by_level(level)}


def http_json(url: str, timeout: float = 3.0, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode() or "{}")
        except Exception:
            body = {}
        return exc.code, body
    except Exception as exc:  # 连接失败/超时/非 JSON
        return None, {"error": f"{type(exc).__name__}: {exc}"}


def http_response(url: str, timeout: float = 3.0, headers=None):
    """同 http_json，但把响应头一起返回（出口扫描用）。返回 (status, body, headers)。"""
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}"), dict(resp.headers.items())
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode() or "{}")
        except Exception:
            body = {}
        return exc.code, body, dict(exc.headers.items()) if exc.headers else {}
    except Exception as exc:  # 连接失败/超时/非 JSON
        return None, {"error": f"{type(exc).__name__}: {exc}"}, {}


def http_status(url: str, timeout: float = 3.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers)
    except Exception as exc:
        return None, {"error": f"{type(exc).__name__}: {exc}"}


def load_server_module():
    """复用录播代理的 canonical_key，避免 preflight 与 server 的键算法漂移。"""
    spec = importlib.util.spec_from_file_location(
        "e2e_tushare_replay_server", E2E_DIR / "tushare-replay" / "server.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def check_compose(checks: Checks):
    script = E2E_DIR / "scripts" / "validate_compose.py"
    try:
        proc = subprocess.run([sys.executable, str(script), "--quiet"], capture_output=True, text=True, timeout=60)
    except Exception as exc:
        checks.add(FAIL, "COMPOSE_STATIC", f"无法执行 validate_compose.py：{exc}")
        return
    if proc.returncode == 0:
        checks.add(OK, "COMPOSE_STATIC", "compose 结构断言全部通过（真栈/录播/无外呼）")
    else:
        tail = (proc.stdout or proc.stderr or "").strip().splitlines()[-6:]
        checks.add(FAIL, "COMPOSE_STATIC", "compose 断言失败：" + " | ".join(tail))


def check_scenario(checks: Checks):
    if not REQUIRED_SCENARIO.is_file():
        checks.add(FAIL, "SCENARIO", f"缺少场景文件 {REQUIRED_SCENARIO.relative_to(ROOT)}")
        return None
    try:
        scenario = json.loads(REQUIRED_SCENARIO.read_text(encoding="utf-8"))
    except Exception as exc:
        checks.add(FAIL, "SCENARIO", f"场景文件无法解析：{exc}")
        return None
    missing = [k for k in ("scenario", "instrument_id", "expected_tushare_apis", "calls") if k not in scenario]
    if missing:
        checks.add(FAIL, "SCENARIO", f"场景文件缺字段：{missing}")
        return None
    checks.add(OK, "SCENARIO", f"{scenario['scenario']} · {scenario['instrument_id']} · "
                               f"{len(scenario['calls'])} 次调用 · {len(scenario['expected_tushare_apis'])} 个 tushare 接口")
    return scenario


def check_recordings(checks: Checks, scenario):
    """fixture 完整性 + 键一致性 + 无 token 落盘。缺失返回 missing 列表供决策用。"""
    expected = list(scenario.get("expected_tushare_apis", [])) if scenario else []
    if not RECORDINGS.is_dir():
        checks.add(WARN, "FIXTURES", f"recordings 目录尚不存在（{RECORDINGS.relative_to(ROOT)}），按 0 条处理")
        files = []
    else:
        files = sorted(RECORDINGS.glob("*.json"))
    recordings = []
    corrupt = []
    try:
        server = load_server_module()
    except Exception as exc:
        checks.add(FAIL, "FIXTURES", f"无法加载录播代理以校验键：{exc}")
        return [], expected, []

    for path in files:
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            corrupt.append(f"{path.name}: 无法解析 ({exc})")
            continue
        problems = []
        if doc.get("schema_version") != 1:
            problems.append("schema_version!=1")
        if doc.get("kind") != "tushare-http-raw":
            problems.append("kind!=tushare-http-raw")
        if not isinstance(doc.get("request"), dict):
            problems.append("缺 request")
        elif "token" in doc["request"]:
            problems.append("request 含 token（凭证泄漏）")
        if not isinstance(doc.get("upstream_response"), dict) and not isinstance(doc.get("response"), dict):
            problems.append("缺 response")
        if doc.get("key") != path.stem:
            problems.append("key 与文件名不一致")
        try:
            if server.canonical_key(doc["request"]) != doc.get("key"):
                problems.append("key 与规范化请求不一致（内容被手改？）")
        except Exception as exc:
            problems.append(f"key 计算失败：{exc}")
        if problems:
            corrupt.append(f"{path.name}: " + "，".join(problems))
            continue
        recordings.append(doc)

    if corrupt:
        checks.add(FAIL, "FIXTURES_CORRUPT", "; ".join(corrupt[:5]) + (" …" if len(corrupt) > 5 else ""))
    else:
        checks.add(OK, "FIXTURES_CORRUPT", f"{len(recordings)} 条录制结构合法、键一致、无 token")

    # manifest 与文件一致（防「删了文件没更新 manifest」）
    manifest_path = FIXTURES / "manifest.json"
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            listed = set(manifest.get("keys") or [])
            if not listed and isinstance(manifest.get("recordings"), list):
                listed = {item.get("key") for item in manifest["recordings"] if isinstance(item, dict) and item.get("key")}
            actual = {r["key"] for r in recordings}
            if listed != actual:
                checks.add(FAIL, "FIXTURES_MANIFEST",
                           f"manifest 与 recordings 不一致：多 {sorted(listed - actual)[:3]} 少 {sorted(actual - listed)[:3]}")
            else:
                checks.add(OK, "FIXTURES_MANIFEST", f"manifest 一致（{len(actual)} 条）")
        except Exception as exc:
            checks.add(FAIL, "FIXTURES_MANIFEST", f"manifest 无法解析：{exc}")
    elif files:
        checks.add(WARN, "FIXTURES_MANIFEST", "有录制但缺 manifest.json（录制脚本会生成；需确认是否手工放入）")

    have_apis = sorted({(r.get("request") or {}).get("api_name") for r in recordings if r.get("request")})
    missing_apis = [a for a in expected if a not in have_apis]
    if not recordings:
        checks.add(SKIP, "FIXTURES", f"0 条录制；场景期望接口 {expected}（S0 阶段预期为空，需 A1 adapter + token 录制）")
    elif missing_apis:
        checks.add(FAIL, "FIXTURES", f"缺场景声明的 tushare 接口录制：{missing_apis}（已有 {have_apis}）")
    else:
        checks.add(OK, "FIXTURES", f"录制覆盖场景接口 {expected}（共 {len(recordings)} 条）")
    return recordings, expected, have_apis


def check_quarantine(checks: Checks):
    if not QUARANTINE.is_file():
        checks.add(WARN, "QUARANTINE", "quarantine.json 不存在（按空 quarantine 处理）")
        return
    try:
        data = json.loads(QUARANTINE.read_text(encoding="utf-8"))
        entries = data.get("entries") or []
    except Exception as exc:
        checks.add(FAIL, "QUARANTINE", f"quarantine.json 无法解析：{exc}")
        return
    now = datetime.now(timezone.utc)
    expired, active, bad = [], [], []
    for entry in entries:
        try:
            expires = datetime.fromisoformat(str(entry["expires_at"]).replace("Z", "+00:00"))
        except Exception:
            bad.append(str(entry.get("case")))
            continue
        (expired if expires <= now else active).append(str(entry.get("case")))
    if bad:
        checks.add(FAIL, "QUARANTINE", f"条目缺合法 expires_at：{bad}")
    elif expired:
        checks.add(FAIL, "QUARANTINE", f"quarantine 已过期（>24h 未处理，违反 A12 硬约束）：{expired}")
    else:
        checks.add(OK, "QUARANTINE", f"{len(active)} 条生效中，无过期项" if active else "空 quarantine")


def check_testids(checks: Checks):
    if not TESTIDS.is_file():
        checks.add(FAIL, "TESTIDS", "缺少 tests/e2e/testids.json（test-id 是 web/api 的交接契约）")
        return
    try:
        data = json.loads(TESTIDS.read_text(encoding="utf-8"))
    except Exception as exc:
        checks.add(FAIL, "TESTIDS", f"testids.json 无法解析：{exc}")
        return
    ids = data.get("ids") or {}
    if not isinstance(ids, dict) or not ids:
        checks.add(FAIL, "TESTIDS", "testids.json 缺 ids 映射")
        return
    bad_values = [f"{k}={v!r}" for k, v in ids.items()
                  if not isinstance(v, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", v)]
    duplicated = sorted({v for v in ids.values() if isinstance(v, str) and list(ids.values()).count(v) > 1})
    if bad_values or duplicated:
        checks.add(FAIL, "TESTIDS", f"test-id 值必须 kebab-case 且唯一：非 kebab={bad_values[:5]} 重复={duplicated[:5]}")
        return
    used = set()
    for spec in sorted(SPECS.glob("*.spec.js")) if SPECS.is_dir() else []:
        used.update(re.findall(r"""tid\(\s*['"]([A-Za-z0-9-]+)['"]\s*\)""", spec.read_text(encoding="utf-8")))
    undefined = sorted(used - set(ids))
    if undefined:
        checks.add(FAIL, "TESTIDS", f"spec 引用了 testids.json 未定义的 id：{undefined}")
    elif not used:
        checks.add(WARN, "TESTIDS", "spec 中未发现 tid('...') 引用（骨架阶段可接受）")
    else:
        checks.add(OK, "TESTIDS", f"{len(used)} 个语义化 test-id 被引用且全部有定义")


def check_stack(checks: Checks):
    """返回 (栈是否可达, 页面是否已实现, 个股页 url, data_ready)。

    Lead 2026-11-04：可测 = api /healthz 可达且 data_ready=true，而不是「compose 起来了」。
    tushare-replay 单独用 check_replay 判定，只影响 P0-10，不把 11 条用例整体 skip。
    """
    api_status, health_body = http_json(f"{API}/healthz")
    if api_status != 200:
        checks.add(SKIP, "STACK_API", f"api /healthz 不可用（status={api_status}）")
        return False, False, None, None
    checks.add(OK, "STACK_API", "api /healthz 200")
    data_ready = check_data_ready(checks, health_body)

    web_status, _ = http_status(f"{WEB}/")
    if web_status != 200:
        checks.add(SKIP, "STACK_WEB", f"web 首页不可用（status={web_status}）")
        return False, False, None, None
    checks.add(OK, "STACK_WEB", "web 首页 200")

    scenario_url = {}
    if REQUIRED_SCENARIO.is_file():
        try:
            scenario_url = json.loads(REQUIRED_SCENARIO.read_text(encoding="utf-8"))
        except Exception:
            scenario_url = {}
    instrument = scenario_url.get("instrument_id", "SSE:600519")
    path = scenario_url.get("stock_page_path") or STOCK_PATH.format(instrument_id=instrument)
    url = WEB + path
    page_status, headers = http_status(url)
    if page_status == 200:
        checks.add(OK, "IMPL_STOCK_PAGE", f"{path} 200（content-type={headers.get('Content-Type') or headers.get('content-type')}）")
        return True, True, url, data_ready
    if page_status in (404, 501):
        checks.add(SKIP, "IMPL_STOCK_PAGE", f"{path} 返回 {page_status}：页面未实现，E2E 用例应 skip")
    else:
        checks.add(SKIP, "IMPL_STOCK_PAGE", f"{path} 返回 {page_status}（栈不稳或路由未完）")
    return True, False, url, data_ready


def check_replay(checks: Checks):
    """录播代理是 P0-10 的前置，不是全栈可测的前提。返回 (ready, detail)。"""
    livez, _ = http_json(f"{REPLAY}/__livez")
    if livez is None:
        detail = f"录播代理不可达（{REPLAY}）：P0-10 将 skip，其余用例不受影响"
        checks.add(SKIP, "REPLAY", detail)
        return False, detail
    health_status, health = http_json(f"{REPLAY}/__health")
    if health_status == 200:
        checks.add(OK, "REPLAY", f"录播代理就绪（{health.get('recordings')} 条录制）")
        return True, "ok"
    detail = (f"录播不完整（/__health={health_status}）："
              f"{health.get('detail') or health.get('error') or ''}；P0-10 将 skip")
    checks.add(SKIP, "REPLAY", detail)
    return False, detail


def check_data_ready(checks: Checks, health_body):
    """/healthz 的 data_ready 契约（见 docs/INGEST-ONCE-CONTRACT.md §4）；返回 True/False/None。"""
    if not isinstance(health_body, dict):
        checks.add(FAIL, "DATA_READY",
                   "IMPL_MISSING_DATA_READY: /healthz 响应不是 JSON 对象（契约 §4，归 A3）")
        return None
    if "data_ready" not in health_body:
        checks.add(FAIL, "DATA_READY",
                   "IMPL_MISSING_DATA_READY: /healthz 缺 data_ready 字段（契约 §4，归 A3）")
        return None
    value = health_body.get("data_ready")
    if not isinstance(value, bool):
        checks.add(FAIL, "DATA_READY",
                   f"IMPL_MISSING_DATA_READY: data_ready 必须是布尔，实际 {value!r}（契约 §4）")
        return None
    reason = health_body.get("data_ready_reason")
    if value and reason:
        checks.add(FAIL, "CONTRADICTION",
                   f"data_ready=true 却带 data_ready_reason={reason!r}（报告自相矛盾，比单用例失败严重）")
    if value:
        checks.add(OK, "DATA_READY", "/healthz data_ready=true")
    else:
        checks.add(SKIP, "DATA_READY",
                   f"/healthz data_ready=false（reason={reason or 'UNKNOWN'}）："
                   "执行 ingest-once，见 docs/INGEST-ONCE-CONTRACT.md")
    return value


def check_ingest_report(checks: Checks, data_ready):
    """校验 A12 的 ingest-report.json，并与 /healthz.data_ready 交叉核对（矛盾即 FAIL）。"""
    if not INGEST_REPORT.is_file():
        if data_ready is True:
            checks.add(FAIL, "CONTRADICTION",
                       f"data_ready=true 但缺少 {INGEST_REPORT.name}：报告文件不可信/挂载错")
        else:
            checks.add(SKIP, "INGEST_REPORT",
                       f"缺少 {INGEST_REPORT.name}（未跑 ingest-once / data_ready=false）")
        return
    try:
        report = json.loads(INGEST_REPORT.read_text(encoding="utf-8"))
    except Exception as exc:
        checks.add(FAIL, "INGEST_REPORT_INVALID", f"ingest-report.json 无法解析：{exc}")
        return
    if not isinstance(report, dict):
        checks.add(FAIL, "INGEST_REPORT_INVALID", "ingest-report.json 必须是 JSON 对象")
        return
    problems = []
    if report.get("schema_version") != 1:
        problems.append(f"schema_version={report.get('schema_version')!r}（应为 1）")
    ready = report.get("ready")
    if not isinstance(ready, bool):
        problems.append(f"ready={ready!r}（应为布尔）")
    failed_step = report.get("failed_step")
    if failed_step not in (None, "ingest", "load", "quality"):
        problems.append(f"failed_step={failed_step!r}")
    if ready is True and failed_step:
        problems.append(f"ready=true 却 failed_step={failed_step!r}")
    if ready is True and report.get("quality_level") == "red":
        problems.append("ready=true 却 quality_level=red")
    if problems:
        checks.add(FAIL, "INGEST_REPORT_INVALID", "；".join(problems))
        return
    if data_ready is not None and ready != data_ready:
        checks.add(FAIL, "CONTRADICTION",
                   f"ingest-report.ready={ready} 与 /healthz.data_ready={data_ready} 不一致（报告不可信）")
        return
    checks.add(OK, "INGEST_REPORT", f"ready={ready}，failed_step={failed_step}，report 与 healthz 一致")


def check_auth(checks: Checks):
    token = os.environ.get("E2E_AUTH_TOKEN", "").strip()
    if token:
        checks.add(OK, "AUTH", "E2E_AUTH_TOKEN 已提供（自选用例可跑）")
    else:
        checks.add(SKIP, "AUTH", "E2E_AUTH_TOKEN 未设置：E2E-P0-08/09（加自选、刷新仍在）将 skip")


# Lead 2026-11-04 裁定（AC-5）：受限矩阵只认 403 + Problem ENTITLEMENT_RESTRICTED，
# 200+is_entitled=false 不得替代。A3 2026-11-04 确认的逐接口形态：
# - quote / bars / fundamental-summary：normal 200+true；restricted 403 ENTITLEMENT_RESTRICTED
# - instruments/{id}（基础信息，无行情数值）：normal 200+true；restricted 200+internal_eval+false
# - watchlist：平台自有数据，两个矩阵恒 200+platform_user_data+true，不受 F1 矩阵影响
CONTRACTS = ROOT / "contracts"
# 受限矩阵要求 403 的接口 → (契约文件, 路径)。用于区分「契约还没声明 403」与「实现返回错」。
CONTRACT_403_SOURCES = {
    "quote": (CONTRACTS / "market" / "openapi.yaml", "/v1/instruments/{instrument_id}/quote"),
    "bars": (CONTRACTS / "market" / "openapi.yaml", "/v1/instruments/{instrument_id}/bars"),
    "fundamental-summary": (CONTRACTS / "fundamental" / "openapi.yaml",
                            "/v1/instruments/{instrument_id}/fundamental-summary"),
}
# F1 否决线：受限矩阵下基础信息响应体里不得出现的行情数值字段（名字可显示、数字不可显示）
F1_FORBIDDEN_KEYS = {"price", "volume", "amount", "vol", "close", "open", "high", "low",
                     "pct_chg", "change", "turnover", "quote"}
# Lead m01002 / A0 m01022 / decisions.md L56：出口扫描不能只扫 body。
# 403 把「为什么被拒」放进 header（如 X-Entitlement-Cause）等于 body 中性化白做；指纹头同理。
F1_FORBIDDEN_HEADER_NAMES = {"x-entitlement-cause"}
F1_FORBIDDEN_HEADER_VALUE_RE = re.compile(r"expired|hold|stale|unauthorized", re.I)
FINGERPRINT_HEADER_NAMES = {"server", "x-powered-by"}


def find_forbidden_headers(headers):
    """返回 [(kind, "name: value")]；kind ∈ F1_HEADER / FINGERPRINT。纯函数，便于单测。"""
    hits = []
    for name, value in (headers or {}).items():
        lower = str(name).lower()
        text = "" if value is None else str(value)
        if lower in F1_FORBIDDEN_HEADER_NAMES:
            hits.append(("F1_HEADER", f"{name}: {text}（拒绝原因头，不得出现在 403/任何 /v1 响应）"))
        elif F1_FORBIDDEN_HEADER_VALUE_RE.search(text):
            hits.append(("F1_HEADER", f"{name}: {text}（拒绝原因词，不得出现在响应头）"))
        if lower in FINGERPRINT_HEADER_NAMES:
            hits.append(("FINGERPRINT", f"{name}: {text}（指纹头，客户端拿不到才算收口）"))
    return hits
ENTITLEMENT_ENDPOINTS = {
    "quote": "/v1/instruments/{instrument_id}/quote",
    "bars": "/v1/instruments/{instrument_id}/bars",
    "fundamental-summary": "/v1/instruments/{instrument_id}/fundamental-summary",
    "instrument": "/v1/instruments/{instrument_id}",
    "watchlist": "/v1/watchlist",
}
RESTRICTED_403_ENDPOINTS = {"quote", "bars", "fundamental-summary"}


def contract_declares_403(text: str, endpoint_path: str):
    """轻量扫描 OpenAPI 文本：该 path 块内是否声明了 '403' 响应。不依赖 PyYAML。"""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.startswith("  /") and line.strip() == endpoint_path + ":":
            start = i
            break
    if start is None:
        return None
    indent = len(lines[start]) - len(lines[start].lstrip())
    for line in lines[start + 1:]:
        stripped = line.strip()
        if not stripped:
            continue
        cur = len(line) - len(line.lstrip())
        if cur <= indent:
            break
        if re.match(r"^'?403'?\s*:", stripped):
            return True
    return False


def contract_has_403(endpoint: str):
    """返回 True=契约已声明 403，False=未声明，None=无法判断（文件/路径缺失）。"""
    source = CONTRACT_403_SOURCES.get(endpoint)
    if not source:
        return None
    path, endpoint_path = source
    if not path.exists():
        return None
    return contract_declares_403(path.read_text(encoding="utf-8"), endpoint_path)


def find_forbidden_f1_keys(node, prefix: str = ""):
    """递归找出响应体里的行情数值字段名（price/volume/amount…），用于「数字不可显示」断言。"""
    hits = []
    if isinstance(node, dict):
        for key, value in node.items():
            name = str(key).lower()
            here = f"{prefix}.{key}" if prefix else str(key)
            if name in F1_FORBIDDEN_KEYS:
                hits.append(here)
                continue
            hits.extend(find_forbidden_f1_keys(value, here))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            hits.extend(find_forbidden_f1_keys(value, f"{prefix}[{index}]"))
    return hits


def entitlement_verdict(matrix: str, status, body: dict, endpoint: str = "quote", contract_403=None,
                        response_headers=None):
    """纯函数：逐接口授权矩阵自检。返回 (level, detail)。栈 tier 配错会让 normal 假红、F1 否决线空跑。"""
    body = body or {}
    meta = body.get("meta") or {}
    entitlement = meta.get("entitlement") or {}
    entitled, tier, code = entitlement.get("is_entitled"), entitlement.get("tier"), body.get("code")
    if matrix not in ("normal", "restricted"):
        return FAIL, f"E2E_ENTITLEMENT_MATRIX 非法：{matrix!r}（normal|restricted）"
    if endpoint not in ENTITLEMENT_ENDPOINTS:
        return FAIL, f"未知 ENTITLEMENT 端点：{endpoint!r}"
    header_hits = find_forbidden_headers(response_headers)
    if header_hits:
        fingerprint = [detail for kind, detail in header_hits if kind == "FINGERPRINT"]
        if fingerprint:
            return FAIL, f"IMPL_LEAKS_FINGERPRINT_HEADER: {endpoint} 响应头暴露指纹 {fingerprint[:3]}"
        return FAIL, (f"IMPL_LEAKS_F1_HEADERS: {endpoint} 响应头泄漏拒绝原因 "
                      f"{[detail for _, detail in header_hits][:3]}（L56：body 中性化、header 还回去=白做）")
    if matrix == "restricted" and endpoint in RESTRICTED_403_ENDPOINTS:
        if status == 403 and code == "ENTITLEMENT_RESTRICTED":
            return OK, f"restricted/{endpoint}: 403 ENTITLEMENT_RESTRICTED（fail-closed，AC-5）"
        if contract_403 is False:
            return FAIL, (f"CONTRACT_MISSING_403: restricted/{endpoint} 期望 403 + ENTITLEMENT_RESTRICTED，但契约"
                          f"未声明 403（等待 A0 契约 bump，非实现缺陷）；实际 status={status} tier={tier} "
                          f"is_entitled={entitled} code={code}")
        return FAIL, (f"IMPL_WRONG_STATUS: restricted/{endpoint} 必须 403 + code=ENTITLEMENT_RESTRICTED"
                      f"（契约已声明 403，Lead AC-5 裁定；200+is_entitled=false 不接受），实际 status={status} "
                      f"tier={tier} is_entitled={entitled} code={code}；栈应为 E2E_ENTITLEMENT_TIER=internal_eval")
    expected_tier = ("platform_user_data" if endpoint == "watchlist"
                     else ("c_end_display" if matrix == "normal" else "internal_eval"))
    expected_entitled = endpoint == "watchlist" or matrix == "normal"
    if status == 200 and entitled is expected_entitled and tier == expected_tier:
        if endpoint == "instrument" and matrix == "restricted":
            # 名字能显示、数字不能显示：仅检查 tier 不够，F1 否决线要求响应体无行情数值字段
            leaks = find_forbidden_f1_keys(body.get("data") or {})
            if leaks:
                return FAIL, (f"IMPL_LEAKS_F1_NUMBERS: restricted/instrument 200 但响应含行情数值字段 "
                              f"{leaks[:5]}（F1 否决线：名字可显示、数字不可显示）")
        return OK, f"{matrix}/{endpoint}: 200 tier={tier} is_entitled={entitled}"
    if (matrix == "normal" and status == 200 and tier == "internal_eval" and entitled is False):
        # A13/H5 2026-11-04：compose 默认 internal_eval 是 fail-closed 的故意行为，
        # 配错矩阵不等于实现缺陷；给独立 reason code，避免下次排障去翻 A3 的代码。
        return FAIL, (f"CONFIG_TIER_FAIL_CLOSED: normal/{endpoint} 看到 internal_eval（compose 的 fail-closed "
                      f"默认档）；normal 矩阵请显式 E2E_ENTITLEMENT_TIER=c_end_display + "
                      f"E2E_ENTITLEMENT_EXPIRES_AT 重启栈（配置问题，非实现缺陷）；实际 tier={tier} "
                      f"is_entitled={entitled} code={code}")
    return FAIL, (f"{matrix}/{endpoint} 要求 200 + tier={expected_tier} + is_entitled={expected_entitled}"
                  f"（实际 status={status} tier={tier} is_entitled={entitled} code={code}）；"
                  f"检查栈 E2E_ENTITLEMENT_TIER")


def check_entitlement(checks: Checks, scenario):
    matrix = os.environ.get("E2E_ENTITLEMENT_MATRIX", "normal").strip().lower()
    if matrix not in ("normal", "restricted"):
        checks.add(FAIL, "ENTITLEMENT", f"E2E_ENTITLEMENT_MATRIX 非法：{matrix!r}（normal|restricted）")
        return
    instrument = (scenario or {}).get("instrument_id", "SSE:600519")
    token = os.environ.get("E2E_AUTH_TOKEN", "").strip()
    results = []
    for endpoint, path_tpl in ENTITLEMENT_ENDPOINTS.items():
        if endpoint == "watchlist" and not token:
            results.append((SKIP, "watchlist: 缺 E2E_AUTH_TOKEN，跳过矩阵检查（AUTH 已 SKIP）"))
            continue
        url = API + path_tpl.format(instrument_id=quote(instrument, safe=""))
        headers = {"Authorization": f"Bearer {token}"} if endpoint == "watchlist" else None
        status, body, resp_headers = http_response(url, headers=headers)
        if status is None:
            results.append((SKIP, f"{endpoint}: 无法探测 {url}：{body.get('error')}"))
            continue
        results.append(entitlement_verdict(matrix, status, body, endpoint,
                                           contract_has_403(endpoint), resp_headers))
    worst = FAIL if any(l == FAIL for l, _ in results) else (SKIP if any(l == SKIP for l, _ in results) else OK)
    detail = " | ".join(d for _, d in results)
    checks.add(worst, "ENTITLEMENT", detail if worst != OK else f"{matrix} 矩阵 {len(results)} 个接口形态正确")


def decide(checks: Checks, stack_up: bool, impl_ready: bool, offline: bool,
           data_ready=None, replay_ready=None):
    """决策优先级从高到低；返回 (decision, exit_code, reasons)。"""
    skip_conflict = data_ready_skip_conflict(checks, data_ready)
    if skip_conflict:
        return "FAIL", 1, [skip_conflict]
    decision, code, reasons = _decide_base(checks, stack_up, impl_ready, offline, data_ready)
    conflict = data_ready_contradiction(data_ready, decision, reasons)
    if conflict:
        return "FAIL", 1, [conflict]
    if replay_ready is False and decision == "READY":
        detail = next((i["detail"] for i in checks.by_level(SKIP) if i["id"] == "REPLAY"),
                      "录播代理未就绪")
        reasons.append("P0-10_SKIP: " + detail)
    return decision, code, reasons


def data_ready_skip_conflict(checks: Checks, data_ready):
    """data_ready=true 时任何数据类 SKIP 检查都与「数据已就绪」互斥（Lead 2026-11-04）。"""
    if data_ready is not True:
        return None
    conflicting = sorted(set(checks.ids(SKIP)) & {"DATA_READY", "INGEST_REPORT"})
    if not conflicting:
        return None
    return ("FAIL:CONTRADICTION: /healthz data_ready=true 但数据类检查仍 SKIP"
            f"（{', '.join(conflicting)}）— 报告或判定逻辑有 bug（比单用例失败严重）")


def data_ready_contradiction(data_ready, decision: str, reasons):
    """/healthz.data_ready 与最终判定互斥时返回 FAIL 原因（Lead 2026-11-04 要求）。"""
    if data_ready is None:
        return None
    if data_ready is True and decision == "SKIP" and any(
            r.startswith(DATA_RELATED_SKIP_PREFIXES) for r in reasons):
        return ("FAIL:CONTRADICTION: /healthz data_ready=true 但数据类检查仍 SKIP — "
                "报告或判定逻辑有 bug（比单用例失败严重）")
    if data_ready is False and decision == "READY":
        return "FAIL:CONTRADICTION: /healthz data_ready=false 但 preflight 判定 READY — 报告不可信"
    return None


def _decide_base(checks: Checks, stack_up: bool, impl_ready: bool, offline: bool, data_ready=None):
    """决策优先级从高到低；返回 (decision, exit_code, reasons)。"""
    hard = checks.ids(FAIL)
    if hard:
        reasons = []
        for cid in sorted(hard):
            reason = f"FAIL:{cid}"
            if cid in ("CONTRADICTION", "INGEST_REPORT_INVALID", "DATA_READY"):
                reason = f"FAIL:{cid}"
            elif cid == "ENTITLEMENT":
                detail = next((i["detail"] for i in checks.by_level(FAIL) if i["id"] == "ENTITLEMENT"), "")
                code = detail.split(":", 1)[0]
                if code in ("CONTRACT_MISSING_403", "IMPL_WRONG_STATUS", "IMPL_LEAKS_F1_NUMBERS"):
                    reason += ":" + code
            reasons.append(reason)
        return "FAIL", 1, reasons
    if offline:
        return "SKIP", 78, ["OFFLINE: 跳过了网络/栈检查（--offline）"]
    if not stack_up:
        return "SKIP", 78, ["ENV_STACK_DOWN: 真栈未就绪（需 docker compose up）"]
    if not impl_ready:
        # 关键：空实现 skip，但把 fixture 状态原样带进原因，不掩盖 FIXTURE_MISSING
        reasons = ["IMPL_ABSENT: 个股页未实现，用例将 skip"]
        fixture_skips = [i["detail"] for i in checks.by_level(SKIP) if i["id"] == "FIXTURES"]
        if fixture_skips:
            reasons.append("FIXTURES_PENDING: " + fixture_skips[0])
        return "SKIP", 78, reasons
    if data_ready is False:
        detail = next((i["detail"] for i in checks.by_level(SKIP) if i["id"] == "DATA_READY"),
                      "/healthz data_ready=false")
        return "SKIP", 78, ["DATA_NOT_READY: " + detail]
    if "AUTH" in checks.ids(SKIP):
        return "SKIP", 78, ["AUTH_MISSING: 缺 E2E_AUTH_TOKEN，自选旅程用例 skip（其余可跑）"]
    return "READY", 0, ["栈可测（/healthz 可达） + 个股页实现 + data_ready=true"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="market-sense-h5 E2E preflight")
    parser.add_argument("--offline", action="store_true", help="跳过网络探针（无 docker 环境自检）")
    parser.add_argument("--json", default=str(E2E_DIR / ".e2e-status.json"), help="状态文件输出路径")
    parser.add_argument("--no-write", action="store_true", help="不写状态文件")
    args = parser.parse_args(argv)

    checks = Checks()
    # 结构性/离线检查始终执行：这些是 E2E 资产自身的缺陷，与栈无关。
    check_compose(checks)
    scenario = check_scenario(checks)
    check_testids(checks)
    check_quarantine(checks)
    recordings, expected, have_apis = check_recordings(checks, scenario)

    data_ready = None
    replay_ready, replay_detail = None, "OFFLINE"
    if args.offline:
        stack_up = impl_ready = False
    else:
        stack_up, impl_ready, _, data_ready = check_stack(checks)
        replay_ready, replay_detail = check_replay(checks)
        check_auth(checks)
        check_entitlement(checks, scenario)
        check_ingest_report(checks, data_ready)

    decision, code, reasons = decide(checks, stack_up, impl_ready, args.offline, data_ready, replay_ready)

    status = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "decision": decision,
        "exit_code": code,
        "reasons": reasons,
        "urls": {"web": WEB, "api": API, "replay": REPLAY},
        "fixtures": {"dir": str(FIXTURES.relative_to(ROOT)), "recordings": len(recordings),
                     "expected_apis": expected, "available_apis": have_apis},
        "replay": {"ready": replay_ready, "detail": replay_detail},
        "checks": checks.items,
    }
    if not args.no_write:
        out = Path(args.json)
        out.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    icons = {OK: "PASS", WARN: "WARN", FAIL: "FAIL", SKIP: "SKIP"}
    for item in checks.items:
        print(f"{icons[item['level']]:4}  {item['id']:18} {item['detail']}")
    print(f"\nDECISION: {decision} (exit {code})")
    for reason in reasons:
        print(f"  - {reason}")
    print(f"状态文件：{args.json}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
