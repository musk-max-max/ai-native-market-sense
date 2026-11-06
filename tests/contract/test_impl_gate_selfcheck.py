"""G-IMPL 门禁的自证：用本地 stub 服务证明「实现一违规，第一次跑就红」。

stub 服务返回的是录播样本（synthetic），不是真实 tushare；真实现由 task-2 的 CI job
注入 A11_IMPL_BASE_URL 后跑同一个 live_impl_check.check_implementation。
"""

from __future__ import annotations

import copy
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pytest

import live_impl_check as live

SPECIMENS = Path(__file__).resolve().parent / "specimens" / "provider"
CONSUMERS = Path(__file__).resolve().parent / "specimens" / "consumer"


def _load_provider_cases() -> dict[str, list[dict]]:
    cases: dict[str, list[dict]] = {}
    for path in sorted(SPECIMENS.glob("*.json")):
        doc = json.load(open(path, encoding="utf-8"))
        cases[doc["operation_id"]] = doc["cases"]
    return cases


def _instrument_id(path: str) -> str | None:
    marker = path.split("/v1/instruments/")[-1] if "/v1/instruments/" in path else ""
    for candidate in ("SSE:", "SZSE:", "BSE:"):
        if marker.startswith(candidate):
            return marker[: len(candidate) + 6]
    return None


def _pick_case(provider: dict[str, list[dict]], operation_id: str, call: dict) -> dict:
    wanted_status = int(call["expect"]["status"])
    candidates = [case for case in provider[operation_id] if int(case["status"]) == wanted_status]
    assert candidates, f"{operation_id} 没有状态码 {wanted_status} 的样本"
    iid = _instrument_id(call["request"]["path"])
    if iid:
        for case in candidates:
            if iid in json.dumps(case.get("body") or {}, ensure_ascii=False):
                return case
    return candidates[0]


def _content_type(status: int) -> str:
    return "application/problem+json" if status >= 400 else "application/json"


class _Handler(BaseHTTPRequestHandler):
    scenario = "clean"
    provider: dict[str, list[dict]] = {}
    consumers: dict[str, list[dict]] = {}

    def log_message(self, *_args):  # 静默，避免污染测试输出
        pass

    def _respond(self) -> None:
        parsed = urlparse(self.path)
        method = self.command
        raw = b""
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            raw = self.rfile.read(length)
        actual_body = None
        if raw:
            try:
                actual_body = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                actual_body = None
        exact, loose = [], []
        for operation_id, calls in self.consumers.items():
            for call in calls:
                request = call["request"]
                if request["method"] != method or request["path"] != parsed.path:
                    continue
                loose.append((operation_id, call))
                expected = request.get("body")
                if expected == actual_body:
                    exact.append((operation_id, call))
        chosen = (exact or loose)
        if chosen:
            operation_id, call = chosen[0]
            self._serve(operation_id, call)
            return
        self._send(404, "application/problem+json", {"type": "about:blank", "title": "not found", "status": 404, "code": "INSTRUMENT_NOT_FOUND"})

    def _serve(self, operation_id: str, call: dict) -> None:
        case = _pick_case(self.provider, operation_id, call)
        status = int(case["status"])
        body = copy.deepcopy(case.get("body"))
        status, body = self._mutate(operation_id, call, status, body)
        ctype = str(case.get("media_type") or _content_type(status))
        self._send(status, ctype, body)

    def _mutate(self, operation_id: str, call: dict, status: int, body):
        scenario = self.scenario
        if scenario == "volume_string" and operation_id == "getInstrumentQuote":
            body["data"]["volume"] = str(body["data"]["volume"])
        elif scenario == "missing_meta_source" and operation_id == "getInstrumentQuote":
            body["meta"].pop("source", None)
        elif scenario == "fetched_at_leak" and operation_id == "getInstrumentQuote":
            body["meta"]["source"]["fetched_at"] = "2026-11-03T15:00:00+08:00"
        elif scenario == "adjustment_echo" and operation_id == "listInstrumentBars":
            body["meta"]["adjustment"] = "qfq"
        elif scenario == "undeclared_status" and operation_id == "getInstrumentQuote":
            status = 418
        elif scenario == "wrong_content_type" and operation_id == "getInstrumentQuote":
            self._send(status, "text/plain", body)
            return status, body
        elif scenario == "entitlement_leak" and operation_id == "getInstrumentQuote":
            body["meta"]["entitlement"]["is_entitled"] = False
        elif scenario == "missing_consumer_field" and operation_id == "getInstrumentQuote":
            body["data"].pop("limit_status", None)
        elif scenario == "bad_problem_code" and operation_id == "removeWatchlistItem":
            status = 403
            body = {
                "type": "about:blank",
                "title": "授权不足",
                "status": 403,
                "code": "BOGUS_CODE",
                "detail": "x",
                "trace_id": "t-1",
            }
        return status, body

    def _send(self, status: int, content_type: str, body) -> None:
        if body is None:
            payload = b""
        elif isinstance(body, str):
            payload = body.encode("utf-8")
        else:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _respond
    do_POST = _respond
    do_DELETE = _respond


class StubServer:
    def __init__(self, scenario: str = "clean") -> None:
        provider = _load_provider_cases()
        consumers: dict[str, list[dict]] = {}
        for path in sorted(CONSUMERS.glob("*.json")):
            doc = json.load(open(path, encoding="utf-8"))
            consumers[doc["operation_id"]] = doc["calls"]
        handler = type(
            "ScenarioHandler",
            (_Handler,),
            {"scenario": scenario, "provider": provider, "consumers": consumers},
        )
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}"

    def __enter__(self) -> "StubServer":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


def _check(scenario: str) -> list[live.LiveFailure]:
    with StubServer(scenario) as server:
        return live.check_implementation(server.base_url, timeout=3)


def _rules(failures) -> set[str]:
    return {failure.rule for failure in failures}


def test_clean_stub_passes():
    assert _check("clean") == [], "干净 stub 被误判——门禁误报会让团队开始忽略红灯"


@pytest.mark.parametrize(
    "scenario,expected_rule,detail_hint",
    [
        ("volume_string", "LIVE-03", "volume"),
        ("missing_meta_source", "LIVE-03", "source"),
        ("fetched_at_leak", "LIVE-06", "fetched_at"),
        ("adjustment_echo", "LIVE-08", "adjustment"),
        ("wrong_content_type", "LIVE-02", "Content-Type"),
        ("bad_problem_code", "LIVE-04", "BOGUS_CODE"),
        ("entitlement_leak", "LIVE-07", "未授权"),
    ],
)
def test_mutant_is_detected_with_specific_rule(scenario, expected_rule, detail_hint):
    failures = _check(scenario)
    assert failures, f"{scenario} 注入的缺陷没有被抓住——门禁失效"
    assert expected_rule in _rules(failures), f"{scenario} 未报 {expected_rule}: {failures}"
    assert any(detail_hint in failure.detail for failure in failures), (
        f"{scenario} 的失败信息不可定位: {[str(f) for f in failures]}"
    )


def test_undeclared_status_is_detected_when_no_default():
    """A0 给所有 operation 加了 default 后，418 已被 default 覆盖；但缺 default 的契约必须被 LIVE-01 抓住。"""
    from dataclasses import replace

    repo = live.ContractRepo()
    op = repo.operation("getInstrumentQuote")
    spec = dict(op.spec)
    spec["responses"] = {key: value for key, value in (op.spec.get("responses") or {}).items() if key != "default"}
    problem = live.LiveResponse(
        418,
        "application/problem+json",
        json.dumps(
            {"type": "about:blank", "title": "teapot", "status": 418, "code": "INTERNAL_ERROR", "trace_id": "t-1"}
        ).encode("utf-8"),
    )
    call = {"name": "未声明状态", "expect": {"status": 418}}
    failures = live.validate_response(repo, replace(op, spec=spec), call, problem)
    assert "LIVE-01" in _rules(failures), failures


def test_default_response_is_validated_not_ignored():
    """default: ProblemResponse 声明后，418 也应被 Problem 语义校验（不能变成法外之地）。"""
    repo = live.ContractRepo()
    op = repo.operation("getInstrumentQuote")
    bad = live.LiveResponse(
        418, "application/problem+json", json.dumps({"type": "about:blank", "title": "teapot"}).encode()
    )
    failures = live.validate_response(repo, op, {"name": "default", "expect": {"status": 418}}, bad)
    assert "LIVE-04" in _rules(failures), failures


def test_missing_consumer_dependency_is_detected():
    """schema 允许可选字段，但 consumer 依赖它 → 必须报 LIVE-09（双向契约的另一半）。"""
    consumer_path = CONSUMERS / "getInstrumentQuote.json"
    doc = json.load(open(consumer_path, encoding="utf-8"))
    doc["calls"][0]["expect"]["required_fields"].append("data.limit_status")
    with StubServer("missing_consumer_field") as server:
        failures = live.check_implementation(server.base_url, timeout=3, consumers=[doc])
    assert "LIVE-09" in _rules(failures), failures
    assert any("data.limit_status" in failure.detail for failure in failures)


def test_unreachable_service_is_red_not_skipped():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    failures = live.check_implementation(f"http://127.0.0.1:{port}", timeout=0.5)
    assert failures and _rules(failures) == {"LIVE-00"}, "连不上实现必须红灯，不得 skip"


def _run_cli(args, env_extra=None):
    """子进程必须在仓库根启动：`python -m tests.contract.live_impl_check` 依赖 cwd 可导入 tests 包。

    A1/lead 复现：pytest 的 cwd 在 services/ingest 等子目录时，这里缺 cwd 会让子进程
    ModuleNotFoundError，把「门禁用错」误报成「实现侧红」。门禁不能依赖调用者当前目录
    （lead m01175：验收要求第二个人能复现）。
    """
    import os
    import subprocess
    import sys
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[2]

    env = dict(os.environ)
    env.pop("A11_IMPL_BASE_URL", None)
    env.pop("A11_IMPL_TOKEN", None)
    env.update(env_extra or {})
    return subprocess.run(
        [sys.executable, "-m", "tests.contract.live_impl_check", *args],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
        cwd=repo_root,
    )


def test_cli_command_is_wired_like_ci():
    """CI_MOUNT 里写的命令必须真的可用：绿 exit 0、红 exit 1、没接环境 exit 2。"""
    with StubServer("clean") as server:
        passed = _run_cli(["--base-url", server.base_url])
    assert passed.returncode == 0, passed.stderr
    assert "通过" in passed.stdout

    with StubServer("volume_string") as server:
        failed = _run_cli(["--base-url", server.base_url])
    assert failed.returncode == 1
    assert "LIVE-03" in failed.stderr

    unset = _run_cli([])
    assert unset.returncode == 2, unset.stderr
    assert "A11_IMPL_BASE_URL" in unset.stderr


def test_cli_honours_env_fallback_like_ci():
    with StubServer("clean") as server:
        result = _run_cli([], {"A11_IMPL_BASE_URL": server.base_url})
    assert result.returncode == 0, result.stderr
