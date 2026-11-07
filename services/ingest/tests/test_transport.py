"""HTTP 边界单测：请求/响应形状、错误分类（A12 录播代理按同一形状匹配）。"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from market_ingest.adapters.tushare.transport import HttpTransport
from market_ingest.ports import QuotaExhaustedError, SchemaDriftError, SourceAuthError, SourceUnavailableError



@pytest.fixture(autouse=True)
def _allow_local_insecure(monkeypatch: pytest.MonkeyPatch) -> None:
    """本模块测试服务器均为本地 loopback；H4 SEC-008 显式放行（不影响生产默认 https 强制）。"""
    monkeypatch.setenv("ALLOW_INSECURE_ENDPOINT", "1")

CAPTURED: list[dict[str, Any]] = []


class _Handler(BaseHTTPRequestHandler):
    response_bytes: bytes = b""

    def do_POST(self) -> None:  # noqa: N802 - http.server 约定
        length = int(self.headers.get("Content-Length", "0"))
        CAPTURED.append(json.loads(self.rfile.read(length)))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.response_bytes)))
        self.end_headers()
        self.wfile.write(self.response_bytes)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


@contextmanager
def _server(payload: bytes) -> Iterator[str]:
    CAPTURED.clear()
    handler = type("_FixtureHandler", (_Handler,), {"response_bytes": payload})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address[:2]
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _ok(fields: list[str], items: list[list[str]]) -> bytes:
    return json.dumps({"code": 0, "msg": "", "data": {"fields": fields, "items": items}}).encode()


def test_success_payload_round_trip_and_request_shape() -> None:
    payload = _ok(["ts_code", "trade_date", "close"], [["600519.SH", "20240102", "1680.0"]])
    with _server(payload) as endpoint:
        transport = HttpTransport("secret-token", endpoint=endpoint)
        rows = transport.call("daily", {"ts_code": "600519.SH", "start_date": "20240101"}, ("ts_code", "trade_date", "close"))

    assert rows == [{"ts_code": "600519.SH", "trade_date": "20240102", "close": "1680.0"}]
    sent = CAPTURED[0]
    assert sent == {
        "api_name": "daily",
        "token": "secret-token",
        "params": {"ts_code": "600519.SH", "start_date": "20240101"},
        "fields": ["ts_code", "trade_date", "close"],
    }


def test_quota_message_maps_to_quota_exhausted() -> None:
    payload = json.dumps({"code": 40203, "msg": "抱歉，您每分钟最多访问该接口500次，当前积分不足"}).encode()
    with _server(payload) as endpoint:
        transport = HttpTransport("t", endpoint=endpoint)
        with pytest.raises(QuotaExhaustedError):
            transport.call("daily", {"ts_code": "600519.SH"}, ("ts_code",))


def test_auth_message_maps_to_auth_error() -> None:
    payload = json.dumps({"code": 40203, "msg": "抱歉，您没有访问该接口的权限"}).encode()
    with _server(payload) as endpoint:
        transport = HttpTransport("t", endpoint=endpoint)
        with pytest.raises(SourceAuthError):
            transport.call("daily", {"ts_code": "600519.SH"}, ("ts_code",))


def test_non_json_body_maps_to_schema_drift() -> None:
    with _server(b"<html>oops</html>") as endpoint:
        transport = HttpTransport("t", endpoint=endpoint)
        with pytest.raises(SchemaDriftError):
            transport.call("daily", {"ts_code": "600519.SH"}, ("ts_code",))


def test_connection_error_maps_to_source_unavailable() -> None:
    transport = HttpTransport("t", endpoint="http://127.0.0.1:9", timeout_s=0.2)
    with pytest.raises(SourceUnavailableError):
        transport.call("daily", {"ts_code": "600519.SH"}, ("ts_code",))

# ---- H4 SEC-007/008/009 修复测试（L0 2026-11-07）----


class TestEndpointSecurity:
    """G2/SEC-008：非 https 端点 fail-closed，显式 ALLOW_INSECURE_ENDPOINT=1 仅本地回环放行。"""

    def test_https_official_endpoint_passes(self) -> None:
        from market_ingest.adapters.tushare.transport import HttpTransport

        t = HttpTransport("tok", endpoint="https://api.tushare.pro")
        assert t.endpoint == "https://api.tushare.pro"

    def test_http_non_local_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from market_ingest.adapters.tushare.transport import HttpTransport

        monkeypatch.delenv("ALLOW_INSECURE_ENDPOINT", raising=False)
        with pytest.raises(ValueError, match="endpoint must be https"):
            HttpTransport("tok", endpoint="http://tuaremax.top")

    def test_http_local_without_allow_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from market_ingest.adapters.tushare.transport import HttpTransport

        monkeypatch.delenv("ALLOW_INSECURE_ENDPOINT", raising=False)
        with pytest.raises(ValueError, match="endpoint must be https"):
            HttpTransport("tok", endpoint="http://127.0.0.1:18081")

    def test_http_local_with_allow_passes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from market_ingest.adapters.tushare.transport import HttpTransport

        monkeypatch.setenv("ALLOW_INSECURE_ENDPOINT", "1")
        t = HttpTransport("tok", endpoint="http://127.0.0.1:18081")
        assert t.endpoint == "http://127.0.0.1:18081"


class TestRateLimit:
    """G3/SEC-009：TUSHARE_RATE_LIMIT_PER_MIN 接线到 HttpTransport 调用间隔。"""

    def test_rate_limit_read(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from market_ingest.adapters.tushare.transport import HttpTransport

        monkeypatch.setenv("ALLOW_INSECURE_ENDPOINT", "1")
        monkeypatch.setenv("TUSHARE_RATE_LIMIT_PER_MIN", "200")
        t = HttpTransport("tok", endpoint="http://127.0.0.1:18081")
        assert t._rate_limit_per_min == 200.0

    def test_rate_limit_unread_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from market_ingest.adapters.tushare.transport import HttpTransport

        monkeypatch.setenv("ALLOW_INSECURE_ENDPOINT", "1")
        monkeypatch.delenv("TUSHARE_RATE_LIMIT_PER_MIN", raising=False)
        t = HttpTransport("tok", endpoint="http://127.0.0.1:18081")
        assert t._rate_limit_per_min is None


class TestAdapterEndpointFailClosed:
    """G1/SEC-007：live 模式缺端点 = 配置错误，拒绝静默回落默认端点。"""

    def test_live_mode_no_endpoint_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from market_ingest.adapters.tushare.adapter import create_adapter as create
        from market_ingest.ports import InvalidRequestError

        monkeypatch.delenv("TUSHARE_API_URL", raising=False)
        monkeypatch.delenv("DATA_SOURCE_MODE", raising=False)
        with pytest.raises(InvalidRequestError, match="endpoint not configured"):
            create({"token": "tok", "mode": "live"})

    def test_replay_mode_no_endpoint_ok(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from market_ingest.adapters.tushare.adapter import create_adapter as create

        monkeypatch.delenv("TUSHARE_API_URL", raising=False)
        monkeypatch.delenv("DATA_SOURCE_MODE", raising=False)
        # replay 模式缺端点用占位 token，不构造 HttpTransport
        ds = create({"token": "replay-no-auth", "mode": "replay"})
        assert ds is not None
