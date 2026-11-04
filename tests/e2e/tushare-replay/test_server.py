"""录播代理自测（pytest，无网络、无 docker 依赖）。

验证的是「录播机制」本身，不是产品功能：
  - 命中回放；未命中显式 503 FIXTURE_MISSING（不静默、不伪造）
  - 键规范化稳定（params 顺序 / fields 顺序 / token 有无不影响键）
  - /__livez 与 /__health 语义分离（fixtures 缺失不能把栈搞挂）
  - record 模式在 CI / 无 token 时拒绝启动
  - 落盘请求中不含 token
"""

import importlib.util
import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("tushare_replay_server", HERE / "server.py")
srv = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = srv  # dataclass 需要模块已注册
SPEC.loader.exec_module(srv)


def make_cfg(tmp_path, **overrides):
    cfg = srv.Config(mode="replay", fixtures_dir=tmp_path / "tushare", port=0)
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


def start(cfg):
    store = srv.FixtureStore(cfg.fixtures_dir)
    handler = type("H", (srv.ReplayHandler,), {"cfg": cfg, "store": store})
    httpd = srv.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    return httpd, store, f"http://127.0.0.1:{port}"


def post(url, body):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode()), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode()), dict(exc.headers)


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode())


PAYLOAD = {"api_name": "daily", "token": "secret-token", "params": {"ts_code": "600519.SH", "trade_date": "20261103"},
           "fields": "ts_code,trade_date,close"}
RESPONSE = {"code": 0, "msg": "", "data": {"fields": ["ts_code", "trade_date", "close"],
                                           "items": [["600519.SH", "20261103", 1688.0]]}}


@pytest.fixture()
def live(tmp_path):
    import os
    token = os.environ.get("TUSHARE_TOKEN")
    try:
        os.environ.pop("TUSHARE_TOKEN", None)
        cfg = make_cfg(tmp_path)
        httpd, store, base = start(cfg)
        yield cfg, store, base
    finally:
        httpd.shutdown()
        if token is not None:
            os.environ["TUSHARE_TOKEN"] = token


def test_replay_hit_returns_recorded_response(live):
    cfg, store, base = live
    key = srv.canonical_key(PAYLOAD)
    store.store(key, srv.canonical_doc(PAYLOAD), 200, RESPONSE, "https://api.tushare.pro")

    status, body, headers = post(base, PAYLOAD)
    assert status == 200
    assert body == RESPONSE
    assert headers.get("X-E2E-Replay-Key") == key


def test_replay_miss_fails_loudly(live):
    cfg, store, base = live
    status, body, _ = post(base, PAYLOAD)
    assert status == 503
    assert body["code"] == "FIXTURE_MISSING"
    assert body["key"] == srv.canonical_key(PAYLOAD)
    assert body["available_api_names"] == []
    assert "data" not in body  # 绝不返回伪造/空数据冒充成功


def test_key_is_stable_across_ordering_and_token(live):
    base_key = srv.canonical_key(PAYLOAD)
    reordered = {
        "api_name": "daily",
        "params": {"trade_date": "20261103", "ts_code": "600519.SH"},
        "fields": " close , trade_date ,ts_code ",
        "token": "another-token",
    }
    assert srv.canonical_key(reordered) == base_key
    stripped = dict(PAYLOAD)
    stripped.pop("token")
    assert srv.canonical_key(stripped) == base_key


def test_token_never_persisted(live, tmp_path):
    cfg, store, base = live
    key = srv.canonical_key(PAYLOAD)
    store.store(key, srv.canonical_doc(PAYLOAD), 200, RESPONSE, "https://api.tushare.pro")
    disk = (tmp_path / "tushare" / "recordings" / f"{key}.json").read_text()
    assert "secret-token" not in disk
    assert "token" not in json.loads(disk)["request"]


def test_livez_ok_but_health_reports_missing_fixtures(tmp_path):
    cfg = make_cfg(tmp_path, strict_fixtures=True)
    httpd, store, base = start(cfg)
    try:
        assert get(base + "/__livez")[0] == 200
        status, body = get(base + "/__health")
        assert status == 503
        assert body["ok"] is False
        assert "FIXTURE_MISSING" in body["detail"]
    finally:
        httpd.shutdown()


def test_health_reports_missing_expected_api(tmp_path):
    cfg = make_cfg(tmp_path, expected_apis=["daily", "income"])
    httpd, store, base = start(cfg)
    try:
        status, body = get(base + "/__health")
        assert status == 503
        assert body["missing_api_names"] == ["daily", "income"]
    finally:
        httpd.shutdown()


def test_record_mode_refuses_ci_and_missing_token(tmp_path):
    with pytest.raises(SystemExit):
        srv.validate_startup(make_cfg(tmp_path, mode="record", ci=True, token="x"))
    with pytest.raises(SystemExit):
        srv.validate_startup(make_cfg(tmp_path, mode="record", ci=False, token=""))


def test_bad_request_not_silently_faked(live):
    cfg, store, base = live
    status, body, _ = post(base, {"params": {}})
    assert status == 400
    assert body["code"] == "BAD_REQUEST"
