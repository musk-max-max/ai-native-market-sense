"""适配层传输与录制/重放（CI 一律录播，禁止真实调用，见 agents/README.md）。

本文件是唯一知道数据源 HTTP 协议、端点、字段清单、错误码语义的地方；
业务层与 sync 层只见到 ``ports.RawPage`` / canonical 记录。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from ...ports import QuotaExhaustedError, SchemaDriftError, SourceAuthError, SourceUnavailableError

#: 数据源端点（仅适配层可见；可用配置覆盖，禁止在其他层出现）。
DEFAULT_ENDPOINT = "http://api.tushare.pro"

#: 日线接口请求字段（保持顺序稳定，便于审计比对）。
DAILY_FIELDS: tuple[str, ...] = (
    "ts_code",
    "trade_date",
    "open",
    "high",
    "low",
    "close",
    "pre_close",
    "change",
    "pct_chg",
    "vol",
    "amount",
)

#: 复权因子接口请求字段。
ADJ_FACTOR_FIELDS: tuple[str, ...] = ("ts_code", "trade_date", "adj_factor")

_DAILY_API = "daily"
_ADJ_FACTOR_API = "adj_factor"

#: 鉴权/权限类消息 → 升级（must_escalate），不重试。
_AUTH_MARKERS = ("没有权限", "无权限", "权限不足", "没有访问", "该接口的权限", "token", "TOKEN", "Token", "认证")
#: 每日配额/积分类消息 → 配额耗尽（不重试，留待续跑并升级）。
_QUOTA_MARKERS = ("积分", "每天", "每日", "当天", "当天最多", "总额度")
#: 每分钟频次类消息 → 可重试限流（等待 retry_after 后再试，且每次重试都记配额）。
_RATE_MARKERS = ("每分钟", "分钟最多", "频率", "频次")


class SourceTransport(Protocol):
    """一次接口调用的最小传输面：返回原始行（源字段名原样）。"""

    def call(self, api_name: str, params: Mapping[str, Any], fields: Sequence[str]) -> list[dict[str, Any]]: ...


class FixtureMissError(RuntimeError):
    """录播夹具未命中：属测试/配置错误，不得当成源不可用降级。"""


def _classify_error(code: int, msg: str) -> Exception:
    text = f"{msg}"
    for marker in _AUTH_MARKERS:
        if marker in text:
            return SourceAuthError(f"source auth/permission error: code={code} msg={msg}", retry_after_s=None)
    for marker in _QUOTA_MARKERS:
        if marker in text:
            return QuotaExhaustedError(f"source quota exhausted: code={code} msg={msg}")
    for marker in _RATE_MARKERS:
        if marker in text:
            return SourceUnavailableError(f"source rate limited: code={code} msg={msg}", retry_after_s=60.0)
    return SourceUnavailableError(f"source api error: code={code} msg={msg}")


class HttpTransport:
    """真实 HTTP 传输（生产/本地联调用；CI 严禁使用）。"""

    def __init__(self, token: str, *, endpoint: str = DEFAULT_ENDPOINT, timeout_s: float = 30.0) -> None:
        if not token:
            raise ValueError("source token is empty; 拒绝无凭证调用")
        self._token = token
        self._endpoint = endpoint
        self._timeout_s = timeout_s

    def call(self, api_name: str, params: Mapping[str, Any], fields: Sequence[str]) -> list[dict[str, Any]]:
        body = json.dumps(
            {"api_name": api_name, "token": self._token, "params": dict(params), "fields": list(fields)},
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_s) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise SourceUnavailableError(f"source unreachable: {exc!r}") from exc
        except json.JSONDecodeError as exc:
            raise SchemaDriftError(f"source returned non-JSON body: {exc}") from exc

        if not isinstance(payload, Mapping):
            raise SchemaDriftError("source response is not a JSON object")
        code = payload.get("code")
        if code != 0:
            raise _classify_error(int(code) if isinstance(code, int) else -1, str(payload.get("msg", "")))
        data = payload.get("data")
        if not isinstance(data, Mapping):
            raise SchemaDriftError(f"source response missing 'data' object: keys={sorted(payload)}")
        out_fields = data.get("fields")
        items = data.get("items")
        if not isinstance(out_fields, list) or not isinstance(items, list):
            raise SchemaDriftError("source response 'data.fields'/'data.items' malformed")
        return [dict(zip((str(f) for f in out_fields), item)) for item in items]


class ReplayTransport:
    """录播重放：按 (api_name, params) 精确匹配夹具，CI 全链路走它。

    夹具 JSONL 每行: ``{"api_name": "...", "params": {...}, "rows": [{...}]}``
    （A12 的 task-7 生成机制直接产出该格式；adapter 只依赖此注入点）。
    ``strict=True`` 时同一条目只能用一次，且 ``assert_consumed()`` 保证夹具无冗余。
    """

    def __init__(self, entries: Sequence[Mapping[str, Any]], *, strict: bool = True) -> None:
        self._entries: list[dict[str, Any]] = []
        for entry in entries:
            api_name = str(entry["api_name"])
            params = {str(k): _norm(v) for k, v in dict(entry.get("params") or {}).items()}
            rows = [dict(row) for row in entry.get("rows") or []]
            self._entries.append({"api_name": api_name, "params": params, "rows": rows, "used": False})
        self._strict = strict

    @classmethod
    def from_file(cls, path: str | Path, *, strict: bool = True) -> ReplayTransport:
        entries = [
            json.loads(line)
            for line in Path(path).read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("//")
        ]
        return cls(entries, strict=strict)

    def call(self, api_name: str, params: Mapping[str, Any], fields: Sequence[str]) -> list[dict[str, Any]]:
        wanted = {str(k): _norm(v) for k, v in dict(params).items()}
        for entry in self._entries:
            if entry["api_name"] != api_name or entry["params"] != wanted:
                continue
            if self._strict and entry["used"]:
                continue
            entry["used"] = True
            return [dict(row) for row in entry["rows"]]
        available = [f"{e['api_name']}{e['params']}" for e in self._entries if not e["used"]]
        raise FixtureMissError(f"no replay fixture for {api_name} {wanted}; unconsumed={available}")

    def assert_consumed(self) -> None:
        unused = [f"{e['api_name']}{e['params']}" for e in self._entries if not e["used"]]
        if unused:
            raise FixtureMissError(f"unused replay fixtures: {unused}")


class RecordingTransport:
    """录制包装：把真实响应按夹具格式追加到 JSONL，供 A12 收录后重放。

    A12 的 task-7 注入机制以此为落点；录制只发生在显式开启时（默认关闭）。
    """

    def __init__(self, inner: SourceTransport, path: str | Path, *, append: bool = True) -> None:
        self._inner = inner
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if not append:
            self._path.write_text("", encoding="utf-8")

    def call(self, api_name: str, params: Mapping[str, Any], fields: Sequence[str]) -> list[dict[str, Any]]:
        rows = self._inner.call(api_name, params, fields)
        entry = {"api_name": api_name, "params": {str(k): v for k, v in dict(params).items()}, "rows": rows}
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
        return rows


def _norm(value: Any) -> Any:
    """夹具参数归一化：全部转成字符串，避免 int/str 差异导致误判未命中。"""
    return None if value is None else str(value)


def sleep_backoff(seconds: float) -> None:  # 便于测试替换
    time.sleep(seconds)
