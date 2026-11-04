"""Consumer 侧契约测试：验证「调用方对接口的使用方式符合契约」。

样本来源：tests/contract/specimens/consumer/<operationId>.json —— 由 A12/H5 视角声明
「H5 页面会用哪些接口、传什么、依赖响应里的哪些字段」。A11 统一把它翻译成契约断言。

红灯含义（归属判定）：
- 调用路径/参数/依赖字段不在契约里 -> consumer 越界（H5/A12 改调用，或 A0 补契约后走声明流程）；
- 期望状态码未声明 -> 契约缺口（A0）；
- 契约本身无法表达该调用 -> A11 升级 H2。
禁止为了绿灯删除 required_fields —— 那会把「前端依赖未契约化字段」的隐患藏起来。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from openapi_lib import ContractRepo, Operation

SPECIMENS_DIR = Path(__file__).resolve().parent / "specimens" / "consumer"
PATH_PARAM_RE = re.compile(r"\{([^}]+)\}")


def load_consumers() -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(SPECIMENS_DIR.glob("*.json"))]


def match_path(template: str, concrete: str) -> dict[str, str] | None:
    """把 /v1/instruments/{instrument_id}/quote 与具体路径对齐，返回路径参数值。"""
    template_parts = [part for part in template.split("/") if part != ""]
    concrete_parts = [part for part in concrete.split("/") if part != ""]
    if len(template_parts) != len(concrete_parts):
        return None
    captured: dict[str, str] = {}
    for expected, actual in zip(template_parts, concrete_parts):
        if expected.startswith("{") and expected.endswith("}"):
            captured[expected[1:-1]] = actual
        elif expected != actual:
            return None
    return captured


def find_operation(repo: ContractRepo, method: str, path: str) -> tuple[Operation, dict[str, str]] | None:
    for op in repo.operations():
        if op.method != method.lower():
            continue
        captured = match_path(op.path, path)
        if captured is not None:
            return op, captured
    return None


def doc_security(repo: ContractRepo, domain: str) -> list:
    return repo.raw[domain].get("security") or []


def test_every_operation_has_consumer_expectation(repo: ContractRepo):
    consumers = load_consumers()
    covered = {spec.get("operation_id") for spec in consumers}
    missing = [op.operation_id for op in repo.operations() if op.operation_id not in covered]
    assert not missing, "以下接口没有 consumer 侧期望样本（消费契约覆盖率缺口）: " + ", ".join(missing)


def test_consumer_requests_are_legal(repo: ContractRepo):
    """请求侧：方法/路径/路径参数/查询参数/请求体/凭据都必须由契约声明。"""
    problems = []
    seen_ops = set()
    for spec in load_consumers():
        operation_id = spec.get("operation_id")
        if not spec.get("client"):
            problems.append(f"{operation_id}: 必须写明 client（哪个页面/场景在用）")
        for call in spec.get("calls") or []:
            name = call.get("name", "<unnamed>")
            where = f"{operation_id}/{name}"
            request = call.get("request") or {}
            method, path = request.get("method"), request.get("path")
            if not method or not path:
                problems.append(f"{where}: request.method/path 缺失")
                continue
            found = find_operation(repo, method, path)
            if found is None:
                problems.append(
                    f"{where}: {method} {path} 不在契约中（consumer 调用了未声明的接口，或路径写错）"
                )
                continue
            op, captured = found
            seen_ops.add(op.operation_id)
            if op.operation_id != operation_id:
                problems.append(f"{where}: 调用的 operationId={op.operation_id} 与文件名 {operation_id} 不一致")
            # 路径参数
            params = {param.get("name"): param for param in repo.parameters(op)}
            for param_name, value in captured.items():
                param = params.get(param_name)
                if param is None:
                    problems.append(f"{where}: 路径参数 {param_name} 未在契约声明")
                    continue
                errors = repo.validate(param.get("schema") or {}, value)
                if errors:
                    problems.append(f"{where}: 路径参数 {param_name}={value!r} 不符合契约: {errors}")
            # 查询参数
            query = request.get("query") or {}
            declared_query = {
                param.get("name"): param for param in repo.parameters(op) if param.get("in") == "query"
            }
            for key, value in query.items():
                if key not in declared_query:
                    problems.append(f"{where}: 查询参数 {key} 未在契约声明")
                    continue
                errors = repo.validate(declared_query[key].get("schema") or {}, value)
                if errors:
                    problems.append(f"{where}: 查询参数 {key}={value!r} 不符合契约: {errors}")
            for key, param in declared_query.items():
                if param.get("required") and key not in query:
                    problems.append(f"{where}: 契约要求必填查询参数 {key}")
            # 请求体
            body = request.get("body")
            request_schema = repo.request_schema(op)
            if request_schema is not None:
                declared = (repo.deref(op.spec.get("requestBody") or {}, op.domain) or {}).get("required")
                if body is None and declared:
                    problems.append(f"{where}: 契约要求请求体，但调用未提供")
                elif body is not None:
                    errors = repo.validate(request_schema, body)
                    if errors:
                        problems.append(f"{where}: 请求体不符合契约: {errors}")
            elif body is not None:
                problems.append(f"{where}: 契约未声明请求体，调用却发送了 body")
            # 凭据
            security = op.spec.get("security") or doc_security(repo, op.domain)
            auth = (request.get("headers") or {}).get("authorization")
            if security:
                if not auth:
                    problems.append(f"{where}: 接口声明了 security，调用必须携带 Authorization")
                elif not auth.startswith("Bearer "):
                    problems.append(f"{where}: Authorization 必须为 Bearer 方案（决策 #5）")
    assert not problems, "\n".join(problems)
    assert seen_ops, "consumer 样本里没有任何实际调用"


def test_consumer_expectations_are_contract_backed(repo: ContractRepo):
    """响应侧：期望状态码必须声明；依赖字段必须在响应 schema 里（不许依赖未契约化字段）。"""
    problems = []
    for spec in load_consumers():
        operation_id = spec.get("operation_id")
        op = repo.operation(operation_id)
        for call in spec.get("calls") or []:
            name = call.get("name", "<unnamed>")
            where = f"{operation_id}/{name}"
            expect = call.get("expect") or {}
            status = str(expect.get("status"))
            if status not in (op.spec.get("responses") or {}):
                problems.append(f"{where}: 期望状态码 {status} 未在契约声明")
                continue
            fields = expect.get("required_fields") or []
            schema = repo.response_schema(op, status)
            if status == "204":
                if fields:
                    problems.append(f"{where}: 204 无响应体，不得声明 required_fields")
                if schema is not None:
                    problems.append(f"{where}: 契约 204 不应有 schema")
                continue
            if schema is None:
                problems.append(f"{where}: 契约未声明该状态码响应体")
                continue
            for dotted in fields:
                if repo.schema_at(schema, dotted) is None:
                    problems.append(
                        f"{where}: consumer 依赖字段 {dotted} 不在契约响应 schema 中"
                        "（要么 A0 补契约并走声明流程，要么前端停止依赖该字段）"
                    )
    assert not problems, "\n".join(problems)


def test_consumer_does_not_depend_on_internal_or_secret_fields(repo: ContractRepo):
    """consumer 不得依赖 fetched_at / token / entitlement tier 内部值等非公开字段。"""
    problems = []
    forbidden = ("fetched_at", "api_token", "secret", "internal_note")
    for spec in load_consumers():
        blob = json.dumps(spec, ensure_ascii=False)
        for token in forbidden:
            if token in blob:
                problems.append(f"{spec.get('operation_id')}: consumer 样本出现非公开字段 {token}")
        for call in spec.get("calls") or []:
            for dotted in (call.get("expect") or {}).get("required_fields") or []:
                if "fetched_at" in dotted:
                    problems.append(f"{spec.get('operation_id')}/{call.get('name')}: 不得依赖 fetched_at（内部审计字段）")
    assert not problems, "\n".join(problems)
