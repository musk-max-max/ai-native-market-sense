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
