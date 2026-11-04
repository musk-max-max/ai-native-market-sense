#!/usr/bin/env python3
"""tushare-replay · 录播代理（A12 owns，tests/e2e/tushare-replay/）

为什么在 HTTP 层做录播，而不是 mock adapter / mock API 响应：
  - 被验证的是「浏览器 → web → api → adapter → 数据源」这条真链路。
    在 adapter 输出处 mock 掉，等于把 adapter 映射（tushare 字段 → canonical）这一跳跳过，
    而这一跳恰恰是最容易出错、最需要 e2e 兜底的一跳（ADR-002 C01–C20）。
  - 因此在数据源边界（tushare HTTP）录一次真实响应，之后原样回放：
    adapter / 映射 / 落库 / API / 页面全部真实运行，只有远端 tushare 是回放。

两种模式（FIXTURE_MODE）：
  replay（默认，CI 唯一允许）：只读 fixtures；命中即返回录制响应；
     未命中返回 HTTP 503 + code=FIXTURE_MISSING（附 key / api_name / 可用 api 列表），
     **绝不返回空 data 或任何伪造数值**。
  record（仅本地人工）：把请求转发到真实 tushare 并落盘；启动时若检测到 CI=1 直接拒绝。
       token 只从本进程环境读取并注入上游请求，不写入 fixtures；响应里若出现 token 则拒绝落盘。

约定：
  - 键 = sha256(规范化 {api_name, params(去 token), fields(排序去空)} )，见 canonical_key()。
  - recordings/<key>.json 为录制单元；manifest.json 为索引。
  - 端点：POST /            tushare 请求（唯一业务端点）
          GET  /__livez      存活探针（compose healthcheck 用；fixtures 缺失不影响存活）
          GET  /__health     完整性报告（preflight 用；fixtures 缺失 -> 503 + ok=false）
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCHEMA_VERSION = 1
TOKEN_KEYS = {"token", "access_token", "api_token"}


# ---------------------------------------------------------------- 规范化与索引

def strip_token(value):
    """递归移除请求中的凭证；凭证永不进入 fixtures。"""
    if isinstance(value, dict):
        return {k: strip_token(v) for k, v in value.items() if k.lower() not in TOKEN_KEYS}
    if isinstance(value, list):
        return [strip_token(v) for v in value]
    return value


def normalize_fields(fields) -> str:
    """tushare fields 是逗号分隔字符串；顺序不影响语义 -> 排序去空后参与键计算。"""
    if fields is None:
        return ""
    if isinstance(fields, (list, tuple)):
        parts = [str(f) for f in fields]
    else:
        parts = str(fields).split(",")
    return ",".join(sorted(p.strip() for p in parts if p and p.strip()))


def canonical_key(payload: dict) -> str:
    doc = {
        "api_name": str(payload.get("api_name", "")),
        "params": strip_token(payload.get("params") or {}),
        "fields": normalize_fields(payload.get("fields", "")),
    }
    encoded = json.dumps(doc, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_doc(payload: dict) -> dict:
    return {
        "api_name": str(payload.get("api_name", "")),
        "params": strip_token(payload.get("params") or {}),
        "fields": normalize_fields(payload.get("fields", "")),
    }


# ---------------------------------------------------------------- 配置

@dataclass
class Config:
    mode: str
    fixtures_dir: Path
    port: int = 18080
    strict_fixtures: bool = True
    ci: bool = False
    real_api: str = "https://api.tushare.pro"
    token: str = ""
    overwrite: bool = False
    expected_apis: list = field(default_factory=list)

    @classmethod
    def from_env(cls, **overrides) -> "Config":
        env = os.environ
        cfg = cls(
            mode=(env.get("FIXTURE_MODE") or "replay").strip().lower(),
            fixtures_dir=Path(env.get("FIXTURES_DIR") or "tests/fixtures/tushare"),
            port=int(env.get("PORT") or 18080),
            strict_fixtures=(env.get("STRICT_FIXTURES", "1") not in ("0", "false", "no")),
            ci=(env.get("CI", "0") not in ("0", "false", "", "no")),
            real_api=env.get("TUSHARE_REAL_API") or "https://api.tushare.pro",
            token=env.get("TUSHARE_TOKEN") or "",
            overwrite=(env.get("RECORD_OVERWRITE", "0") not in ("0", "false", "", "no")),
            expected_apis=[a.strip() for a in (env.get("EXPECTED_APIS") or "").split(",") if a.strip()],
        )
        for k, v in overrides.items():
            setattr(cfg, k, v)
        return cfg


# ---------------------------------------------------------------- 存储

class FixtureStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.recordings = self.root / "recordings"
        self.manifest = self.root / "manifest.json"
        self.recordings.mkdir(parents=True, exist_ok=True)

    def load(self, key: str):
        path = self.recordings / f"{key}.json"
        if not path.is_file():
            return None
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)

    def keys(self):
        return sorted(p.stem for p in self.recordings.glob("*.json"))

    def api_names(self) -> set:
        names = set()
        for key in self.keys():
            try:
                entry = self.load(key)
                names.add((entry.get("request") or {}).get("api_name", ""))
            except (json.JSONDecodeError, OSError):
                continue
        return {n for n in names if n}

    def store(self, key: str, request_doc: dict, http_status: int, response_obj, upstream: str) -> Path:
        payload_text = json.dumps(response_obj, ensure_ascii=False)
        tmp = self.recordings / f".{key}.tmp"
        target = self.recordings / f"{key}.json"
        if target.exists() and not getattr(self, "_overwrite", False):
            return target
        entry = {
            "schema_version": SCHEMA_VERSION,
            "key": key,
            "kind": "tushare-http-raw",
            "scope": "raw-source",  # 原始源级工件（等价 ODS raw），不是 canonical 夹具
            "request": request_doc,
            "http_status": http_status,
            "response": response_obj,
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "upstream": upstream,
        }
        tmp.write_text(json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, target)
        self.rebuild_manifest()
        return target

    def rebuild_manifest(self):
        items = []
        for key in self.keys():
            try:
                entry = self.load(key)
            except (json.JSONDecodeError, OSError):
                continue
            items.append({
                "key": key,
                "api_name": (entry.get("request") or {}).get("api_name", ""),
                "file": f"recordings/{key}.json",
                "recorded_at": entry.get("recorded_at"),
            })
        doc = {
            "schema_version": SCHEMA_VERSION,
            "generated_by": "tests/e2e/tushare-replay/server.py",
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "recordings": items,
        }
        self.manifest.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- 上游转发（仅 record）

class UpstreamError(Exception):
    pass


def forward_to_upstream(cfg: Config, payload: dict):
    body = dict(payload)
    if cfg.token:
        body["token"] = cfg.token
    req = urllib.request.Request(
        cfg.real_api,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise UpstreamError(f"upstream HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise UpstreamError(f"upstream unreachable/invalid: {exc}") from exc


# ---------------------------------------------------------------- HTTP 处理

class ReplayHandler(BaseHTTPRequestHandler):
    server_version = "tushare-replay/1"
    protocol_version = "HTTP/1.1"

    cfg: Config
    store: FixtureStore
    lock = threading.Lock()

    # -- 工具
    def _send_json(self, status: int, obj, extra_headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _problem(self, status: int, code: str, detail: str, extra=None):
        doc = {"code": code, "msg": detail, "status": status}
        if extra:
            doc.update(extra)
        self._send_json(status, doc)

    def log_message(self, fmt, *args):  # 精简日志：单行，带模式前缀，便于 CI 定位
        sys.stderr.write("[tushare-replay:%s] %s\n" % (self.cfg.mode, fmt % args))

    def do_GET(self):
        if self.path == "/__livez":
            self._send_json(200, {"ok": True, "mode": self.cfg.mode})
            return
        if self.path == "/__health":
            self._send_json(*self.health())
            return
        self._problem(404, "NOT_FOUND", f"unknown path {self.path}")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._problem(400, "BAD_REQUEST", f"invalid JSON body: {exc}")
            return
        if not isinstance(payload, dict) or not payload.get("api_name"):
            self._problem(400, "BAD_REQUEST", "missing api_name")
            return

        key = canonical_key(payload)
        if self.cfg.mode == "record":
            self._handle_record(key, payload)
        else:
            self._handle_replay(key, payload)

    # -- replay
    def _handle_replay(self, key: str, payload: dict):
        try:
            entry = self.store.load(key)
        except (json.JSONDecodeError, OSError) as exc:
            self._problem(500, "FIXTURE_CORRUPT", f"recording unreadable: {key}: {exc}")
            return
        if entry is None:
            available = sorted(self.store.api_names())
            self.log_message(
                "FIXTURE_MISSING api_name=%s key=%s available_api_names=%s",
                payload.get("api_name"), key, ",".join(available) or "<none>",
            )
            self._problem(
                503,
                "FIXTURE_MISSING",
                "no recorded response for this request; CI 禁止真实外呼，录制见 tests/fixtures/tushare/README.md",
                {"key": key, "api_name": payload.get("api_name"), "available_api_names": available},
            )
            return
        status = int(entry.get("http_status") or 200)
        self.log_message("REPLAY_HIT api_name=%s key=%s", payload.get("api_name"), key)
        self._send_json(status, entry.get("response"), {"X-E2E-Replay-Key": key})

    # -- record
    def _handle_record(self, key: str, payload: dict):
        if self.cfg.ci:
            self._problem(500, "RECORD_FORBIDDEN_IN_CI", "CI 环境禁止录制，只允许回放")
            return
        existing = self.store.load(key)
        if existing is not None and not self.cfg.overwrite:
            self.log_message("REPLAY_EXISTING key=%s (RECORD_OVERWRITE=0)", key)
            self._send_json(int(existing.get("http_status") or 200), existing.get("response"),
                            {"X-E2E-Replay-Key": key, "X-E2E-Recorded": "existing"})
            return
        try:
            status, response_obj = forward_to_upstream(self.cfg, payload)
        except UpstreamError as exc:
            self._problem(502, "UPSTREAM_ERROR", str(exc), {"api_name": payload.get("api_name")})
            return
        if self.cfg.token and self.cfg.token in json.dumps(response_obj, ensure_ascii=False):
            self._problem(500, "TOKEN_LEAK_ABORT", "响应中出现 token，拒绝落盘（防止凭证进仓库）")
            return
        with self.lock:
            self.store._overwrite = self.cfg.overwrite
            try:
                path = self.store.store(key, canonical_doc(payload), status, response_obj, self.cfg.real_api)
            finally:
                self.store._overwrite = False
        self.log_message("RECORDED api_name=%s key=%s -> %s", payload.get("api_name"), key, path.name)
        self._send_json(status, response_obj, {"X-E2E-Replay-Key": key, "X-E2E-Recorded": "new"})

    # -- health
    def health(self):
        keys = self.store.keys()
        present_apis = self.store.api_names()
        expected = set(self.cfg.expected_apis)
        missing = sorted(expected - present_apis) if expected else []
        ok = len(keys) > 0 and not missing
        detail = "ok"
        if not keys:
            detail = "FIXTURE_MISSING: recordings/ 为空（先按 tests/fixtures/tushare/README.md 录一次）"
        elif missing:
            detail = "FIXTURE_INCOMPLETE: 缺少 api: " + ",".join(missing)
        status = 200 if (ok or not self.cfg.strict_fixtures) else 503
        return status, {
            "ok": ok,
            "mode": self.cfg.mode,
            "fixtures_dir": str(self.store.root),
            "recordings": len(keys),
            "records": sorted(keys),
            "present_api_names": sorted(present_apis),
            "missing_api_names": missing,
            "detail": detail,
            "strict": self.cfg.strict_fixtures,
        }


def make_server(cfg: Config) -> ThreadingHTTPServer:
    store = FixtureStore(cfg.fixtures_dir)
    handler = type("BoundReplayHandler", (ReplayHandler,), {"cfg": cfg, "store": store})
    httpd = ThreadingHTTPServer(("0.0.0.0", cfg.port), handler)
    httpd.daemon_threads = True
    return httpd


def validate_startup(cfg: Config) -> None:
    if cfg.mode not in ("replay", "record"):
        raise SystemExit(f"FIXTURE_MODE 必须是 replay|record，收到 {cfg.mode!r}")
    if cfg.mode == "record":
        if cfg.ci:
            raise SystemExit("[record] 拒绝启动：CI 环境只允许 replay（禁止真实接口进 CI）")
        if not cfg.token:
            raise SystemExit("[record] 拒绝启动：缺少 TUSHARE_TOKEN")
        if not os.access(cfg.fixtures_dir, os.W_OK):
            raise SystemExit(f"[record] 拒绝启动：fixtures 目录不可写 {cfg.fixtures_dir}")
    if cfg.mode == "replay" and not cfg.fixtures_dir.is_dir():
        raise SystemExit(f"[replay] fixtures 目录不存在：{cfg.fixtures_dir}")


def main() -> int:
    cfg = Config.from_env()
    validate_startup(cfg)
    store = FixtureStore(cfg.fixtures_dir)
    print(f"[tushare-replay] mode={cfg.mode} fixtures={cfg.fixtures_dir} recordings={len(store.keys())}")
    if cfg.mode == "replay" and not store.keys():
        print("[tushare-replay] WARNING: recordings/ 为空 -> 所有请求将返回 503 FIXTURE_MISSING（显式失败）",
              file=sys.stderr)
    httpd = make_server(cfg)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
