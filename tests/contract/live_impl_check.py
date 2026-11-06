"""对**真实实现**跑契约校验（local service under test，禁止连真实 tushare）。

用途：A3/A7 的服务起来后，第一次跑就要抓住「实现与契约不一致」，而不是靠手写录播样本自证。
调用方式（CI 的 G-IMPL 门禁，非默认 pytest）：

    python3 -m tests.contract.live_impl_check --base-url http://127.0.0.1:8080

或用环境变量 A11_IMPL_BASE_URL / A11_IMPL_TOKEN。
退出码：0 = 全部通过；1 = 有失败；2 = 配置/样本问题（同样是红灯）。

检查项（LIVE-*）：
  LIVE-00 传输失败（连不上/超时）
  LIVE-01 返回了契约未声明的状态码
  LIVE-02 Content-Type 与契约不符（成功 application/json、错误 application/problem+json）
  LIVE-03 响应体不满足响应 schema（含必填、类型、additionalProperties）
  LIVE-04 Problem 语义（type/title/status/code/trace_id、code 属于 P0 七码、status 与 HTTP 一致）
  LIVE-05 时间必须 Asia/Shanghai（+08:00），不得泄漏 UTC
  LIVE-06 内部字段/密钥泄漏（fetched_at、token、secret 等）
  LIVE-07 entitlement 未授权时不得返回可被判读的行情数值
  LIVE-08 K 线 meta.adjustment 必须与 data.adjustment 回显一致
  LIVE-09 consumer 依赖字段在真实响应里缺失
  LIVE-10 实际状态码与 consumer 期望不一致
  LIVE-11 响应体不是合法 JSON
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from openapi_lib import (  # noqa: E402
    CONTRACTS_DIR,
    P0_ERROR_CODES,
    ContractRepo,
    Operation,
    payload_at,
    walk_string_leaves,
)

CONSUMERS_DIR = Path(__file__).resolve().parent / "specimens" / "consumer"
DATE_ONLY_KEYS = {"listed_at", "trade_date", "report_end_date", "report_period"}
SECRET_KEYS = {
    "fetched_at",
    "api_token",
    "access_token",
    "secret",
    "ts_token",
    "tushare_token",
    "authorization",
}
PRICE_FIELDS = (
    "last_price",
    "prev_close",
    "change",
    "change_pct",
    "open",
    "high",
    "low",
    "close",
    "revenue",
    "net_profit",
)


@dataclass(frozen=True)
class LiveFailure:
    rule: str
    operation_id: str
    call: str
    detail: str

    def __str__(self) -> str:
        return f"[{self.rule}] {self.operation_id}/{self.call}: {self.detail}"


@dataclass(frozen=True)
class LiveResponse:
    status: int
    content_type: str
    body: bytes


def load_consumers(consumers_dir: Path = CONSUMERS_DIR) -> list[dict]:
    if not consumers_dir.is_dir():
        raise SystemExit(f"consumer 样本目录不存在: {consumers_dir}")
    docs = []
    for path in sorted(consumers_dir.glob("*.json")):
        with path.open(encoding="utf-8") as handle:
            docs.append(json.load(handle))
    return docs


def http_call(
    base_url: str,
    request: dict,
    token: str | None = None,
    timeout: float = 5.0,
) -> LiveResponse:
    url = base_url.rstrip("/") + request["path"]
    query = request.get("query")
    if query:
        from urllib.parse import urlencode

        url += ("&" if "?" in url else "?") + urlencode(query)
    headers = {str(k): str(v) for k, v in (request.get("headers") or {}).items()}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if request.get("body") is not None:
        data = json.dumps(request["body"]).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=headers, method=request["method"])
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return LiveResponse(response.status, response.headers.get("Content-Type", ""), response.read())
    except urllib.error.HTTPError as error:  # 4xx/5xx 也是有效响应，必须校验而不是吞掉
        return LiveResponse(error.code, error.headers.get("Content-Type", ""), error.read())


def _walk_keys(node: Any, path: str = "") -> Iterable[tuple[str, str]]:
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}" if path else str(key)
            yield child, str(key)
            yield from _walk_keys(value, child)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_keys(item, path)


def _json_body(response: LiveResponse) -> tuple[Any, LiveFailure | None]:
    if response.status == 204 or not response.body:
        return None, None
    try:
        return json.loads(response.body.decode("utf-8")), None
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        return None, LiveFailure("LIVE-11", "?", "?", f"响应体不是合法 JSON: {error}")


def validate_response(
    repo: ContractRepo,
    op: Operation,
    call: dict,
    response: LiveResponse,
) -> list[LiveFailure]:
    operation_id = op.operation_id
    name = call.get("name", "?")
    failures: list[LiveFailure] = []

    def fail(rule: str, detail: str) -> None:
        failures.append(LiveFailure(rule, operation_id, name, detail))

    declared = {str(status) for status in (op.spec.get("responses") or {})}
    has_default = "default" in declared
    if str(response.status) not in declared and not has_default:
        fail("LIVE-01", f"契约未声明状态码 {response.status}；已声明 {sorted(declared)}")

    expected_status = (call.get("expect") or {}).get("status")
    if expected_status is not None and response.status != int(expected_status):
        fail("LIVE-10", f"consumer 期望 {expected_status}，实际 {response.status}")

    contract_type = repo.response_content_type(op, response.status) or repo.response_content_type(
        op, "default"
    )
    actual_type = response.content_type.split(";")[0].strip()

    # SSE：契约声明 text/event-stream 时响应体是帧文本，不是 JSON；只校验媒体类型与帧文本非空。
    if contract_type == "text/event-stream" and response.status < 400:
        if actual_type != contract_type:
            fail("LIVE-02", f"Content-Type 期望 {contract_type}，实际 {actual_type!r}")
        try:
            text = response.body.decode("utf-8")
        except UnicodeDecodeError as error:
            fail("LIVE-11", f"SSE 帧文本不是合法 UTF-8: {error}")
            return failures
        if not text.strip():
            fail("LIVE-03", "SSE 响应体为空（至少应有一帧）")
        schema = repo.response_schema(op, response.status)
        if schema is not None:
            for error in repo.validate(schema, text):
                fail("LIVE-03", f"SSE 帧文本 schema 校验失败: {error}")
        for dotted in (call.get("expect") or {}).get("required_fields") or []:
            fail("LIVE-09", f"SSE 响应不应声明 JSON 依赖字段（{dotted}）；帧字段由 description 定义")
        return failures

    body, json_failure = _json_body(response)
    if json_failure:
        fail(json_failure.rule, json_failure.detail)
        return failures

    if response.status == 204:
        if body is not None:
            fail("LIVE-03", "204 不得有响应体")
        return failures

    schema = repo.response_schema(op, response.status)
    if schema is None and has_default:
        schema = repo.response_schema(op, "default")
    if str(response.status) not in declared and not has_default:
        schema = None

    contract_type = repo.response_content_type(op, response.status) or repo.response_content_type(op, "default")
    actual_type = response.content_type.split(";")[0].strip()
    if contract_type:
        if actual_type != contract_type:
            fail("LIVE-02", f"Content-Type 期望 {contract_type}，实际 {actual_type!r}")
    elif response.status >= 400:
        fail("LIVE-02", "错误响应必须是 application/problem+json")

    if schema is not None and body is not None:
        for error in repo.validate(schema, body):
            fail("LIVE-03", f"schema 校验失败: {error}")

    if response.status >= 400:
        if not isinstance(body, dict):
            fail("LIVE-04", "错误响应体必须是 Problem 对象")
            return failures
        for key in ("type", "title", "status", "code"):
            if key not in body:
                fail("LIVE-04", f"Problem 缺必填字段 {key}")
        code = body.get("code")
        if code not in P0_ERROR_CODES:
            fail("LIVE-04", f"Problem.code={code!r} 不在 P0 冻结七码 {sorted(P0_ERROR_CODES)}")
        if body.get("status") != response.status:
            fail("LIVE-04", f"Problem.status={body.get('status')!r} 与 HTTP {response.status} 不一致")
        if "trace_id" not in body:
            fail("LIVE-04", "Problem 缺 trace_id（没有它线上无法定位）")
        return failures

    if not isinstance(body, dict):
        fail("LIVE-03", "成功响应必须是 JSON 对象")
        return failures

    for field_path, text in walk_string_leaves(body):
        key = field_path.rsplit(".", 1)[-1]
        if key in DATE_ONLY_KEYS:
            continue
        if key == "as_of" or key.endswith("_at"):
            if not text.endswith("+08:00"):
                fail("LIVE-05", f"{field_path}={text!r} 不是 +08:00 时间（禁止 UTC 泄漏）")

    for key_path, key in _walk_keys(body):
        if key.lower() in SECRET_KEYS:
            fail("LIVE-06", f"响应泄漏内部/密钥字段 {key_path}")

    entitlement = ((body.get("meta") or {}).get("entitlement") or {})
    if entitlement.get("is_entitled") is False:
        data = body.get("data") or {}
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            for field in PRICE_FIELDS:
                if node.get(field) is not None:
                    fail("LIVE-07", f"未授权（is_entitled=false）仍返回 {field}")
                    break

    if operation_id == "listInstrumentBars":
        data = body.get("data") or {}
        meta = body.get("meta") or {}
        if data.get("adjustment") != meta.get("adjustment"):
            fail(
                "LIVE-08",
                f"meta.adjustment={meta.get('adjustment')!r} 与 data.adjustment={data.get('adjustment')!r} 不一致",
            )

    for dotted in (call.get("expect") or {}).get("required_fields") or []:
        if not payload_at(body, dotted):
            fail("LIVE-09", f"consumer 依赖字段 {dotted} 在响应中不存在")

    return failures


def check_implementation(
    base_url: str,
    token: str | None = None,
    timeout: float = 5.0,
    repo: ContractRepo | None = None,
    consumers: list[dict] | None = None,
) -> list[LiveFailure]:
    repo = repo or ContractRepo(contracts_dir=CONTRACTS_DIR)
    consumers = consumers if consumers is not None else load_consumers()
    failures: list[LiveFailure] = []
    for consumer in consumers:
        operation_id = consumer.get("operation_id")
        op = repo.operation(operation_id)
        for call in consumer.get("calls") or []:
            try:
                response = http_call(base_url, call["request"], token=token, timeout=timeout)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
                failures.append(
                    LiveFailure("LIVE-00", operation_id, call.get("name", "?"), f"请求失败: {error}")
                )
                continue
            failures.extend(validate_response(repo, op, call, response))
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="对真实实现执行契约校验（A11 G-IMPL 门禁）")
    parser.add_argument("--base-url", default=os.environ.get("A11_IMPL_BASE_URL"))
    parser.add_argument("--token", default=os.environ.get("A11_IMPL_TOKEN"))
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args(argv)
    if not args.base_url:
        print("必须提供 --base-url 或 A11_IMPL_BASE_URL（CI 由 task-2 的 job 注入）", file=sys.stderr)
        return 2
    failures = check_implementation(args.base_url, token=args.token, timeout=args.timeout)
    if failures:
        print(f"G-IMPL 红灯：{len(failures)} 项实现与契约不一致", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print(f"G-IMPL 通过：{args.base_url} 上所有 consumer 调用符合契约")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
