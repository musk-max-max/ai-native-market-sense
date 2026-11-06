"""契约测试公共库（A11 owns: tests/contract/）。

职责：
- 加载 contracts/<domain>/openapi.yaml（A0 owns，本库只读）；
- 解析跨文件相对 $ref（域契约 -> ../shared/openapi.yaml#/...），供断言与 payload 校验复用；
- 用 JSON Schema 2020-12 / OpenAPI 3.1 语义校验响应与请求 payload；
- 提供 operation / schema 枚举，供 provider 侧、consumer 侧与 C01–C20 conformance 共用。

硬规则（ADR-001）：契约是单一真源，本库不得内置任何契约字段副本；
所有断言都从 contracts/ 现场读取，契约一改，测试自动跟随（否则门禁会漏）。
"""

from __future__ import annotations

import copy
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import yaml
from jsonschema import Draft202012Validator, FormatChecker

REPO_ROOT = Path(__file__).resolve().parents[2]
# 默认读仓库 contracts/；门禁自检与 CI 变异测试通过环境变量指向临时目录，
# 以证明「改坏契约 -> 红灯」且不触碰 A0 的真源。
CONTRACTS_DIR = Path(os.environ.get("A11_CONTRACTS_DIR") or (REPO_ROOT / "contracts"))
DATA_DIR = REPO_ROOT / "tests" / "data"
DOMAINS = ("shared", "market", "fundamental", "watchlist", "ai", "config", "approval")
# 契约版本 v1 冻结之后新增的域：v1 baseline 里没有它们，diff 门禁对其按「全域 additive」处理
# （新增域不存在破坏性变更；一旦这些域写入 baseline，必须从本元组移除并重冻 manifest）。
ADDED_AFTER_V1 = ("ai", "config", "approval")  # 各自在 baselines/v1/<domain> 首冻；此常量仅作文档标记，不参与跳过。
HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")

# P0 错误码集合（ADR-001 D4 / shared Problem description）。初始 7 个；2026-11-04 按 A3 实现需要
# 新增 NOT_FOUND（标识存在但资源无数据/路由不存在），属 D5「非破坏：新增错误码」，
# 必须同时更新 ADR-001 D4 与本清单，否则 consumer 侧会漏处理未知码。
# 404 语义：INSTRUMENT_NOT_FOUND=标识不存在/未收录；NOT_FOUND=资源无数据；
# 判定顺序：存在性 404 INSTRUMENT_NOT_FOUND → entitlement 403 → 取数 404 NOT_FOUND（Lead m00443 / shared 0.2.1+）。
# 2026-11-06 按 A0 config/approval 契约新增 CONFLICT（409：版本/审批冲突）与
# PRECONDITION_FAILED（412：If-Match 不匹配）；H2 2026-11-06 追认，ADR-001 D4 已同步（shared 0.2.3）。
# 内部接口专用；consumer 侧新增分支仍需走契约变更声明。
P0_ERROR_CODES = (
    "VALIDATION_ERROR",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "INSTRUMENT_NOT_FOUND",
    "NOT_FOUND",
    "ENTITLEMENT_RESTRICTED",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
    "CONFLICT",
    "PRECONDITION_FAILED",
)


class ContractError(Exception):
    """契约本身不可解析/不可解析 $ref：属于门禁红灯（A0 修复），不是测试缺陷。"""


def load_yaml(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
    except FileNotFoundError as exc:  # pragma: no cover - 显式失败信息
        raise ContractError(f"契约文件缺失: {path}") from exc
    except yaml.YAMLError as exc:
        raise ContractError(f"契约 YAML 解析失败: {path}: {exc}") from exc
    if not isinstance(doc, dict):
        raise ContractError(f"契约文件顶层必须是 object: {path}")
    return doc


def iter_refs(node: Any) -> Iterator[str]:
    """递归产出节点中所有 $ref 字符串（含 allOf/items/properties 等任意位置）。"""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                yield value
            else:
                yield from iter_refs(value)
    elif isinstance(node, list):
        for item in node:
            yield from iter_refs(item)


def split_ref(ref: str) -> tuple[str | None, str]:
    """'#/components/...' -> (None, '/components/...')；'../shared/openapi.yaml#/x' -> ('../shared/openapi.yaml', '/x')。"""
    file_part, _, pointer = ref.partition("#")
    return (file_part or None), pointer


@dataclass(frozen=True)
class Operation:
    domain: str
    path: str
    method: str
    operation_id: str
    spec: dict

    @property
    def key(self) -> str:
        return f"{self.method.upper()} {self.path}"


class ContractRepo:
    """只读契约仓库视图；deref 结果不缓存，避免跨测试互相污染。"""

    def __init__(self, contracts_dir: Path = CONTRACTS_DIR, domains: tuple[str, ...] = DOMAINS):
        self.contracts_dir = Path(contracts_dir)
        self.domains = tuple(domains)
        self.files: dict[str, Path] = {}
        self.raw: dict[str, dict] = {}
        for domain in self.domains:
            path = self.contracts_dir / domain / "openapi.yaml"
            self.files[domain] = path
            self.raw[domain] = load_yaml(path)
        self._file_to_domain = {p.resolve(): d for d, p in self.files.items()}

    # ---------- 文件与 $ref ----------

    def domain_for_file(self, path: Path) -> str:
        resolved = path.resolve()
        if resolved not in self._file_to_domain:
            raise ContractError(f"$ref 指向未纳入契约仓库的文件: {path}")
        return self._file_to_domain[resolved]

    def resolve_ref(self, from_domain: str, ref: str) -> tuple[str, str, Any]:
        """返回 (目标 domain, 目标 pointer, 目标值)。"""
        file_part, pointer = split_ref(ref)
        if file_part is None:
            target_domain = from_domain
        else:
            target_path = (self.files[from_domain].parent / file_part).resolve()
            target_domain = self.domain_for_file(target_path)
        node: Any = self.raw[target_domain]
        if pointer:
            for token in pointer.lstrip("/").split("/"):
                token = token.replace("~1", "/").replace("~0", "~")
                if not isinstance(node, dict) or token not in node:
                    raise ContractError(f"$ref 不可解析: {from_domain}: {ref}")
                node = node[token]
        return target_domain, pointer, node

    def deref(self, node: Any, domain: str, _stack: tuple[str, ...] = ()) -> Any:
        """把 $ref 递归展开为内联 JSON Schema（不修改原文档）。"""
        if isinstance(node, list):
            return [self.deref(item, domain, _stack) for item in node]
        if not isinstance(node, dict):
            return copy.deepcopy(node)
        if "$ref" in node:
            ref = node["$ref"]
            target_domain, pointer, target = self.resolve_ref(domain, ref)
            marker = f"{target_domain}:{pointer}"
            if marker in _stack:
                raise ContractError(f"检测到循环 $ref: {' -> '.join(_stack + (marker,))}")
            resolved = self.deref(target, target_domain, _stack + (marker,))
            siblings = {k: v for k, v in node.items() if k != "$ref"}
            if not siblings:
                return resolved
            merged = dict(resolved) if isinstance(resolved, dict) else {"__resolved__": resolved}
            merged.update(self.deref(siblings, domain, _stack))
            return merged
        return {k: self.deref(v, domain, _stack) for k, v in node.items()}

    # ---------- operation / schema 枚举 ----------

    def operations(self, domains: tuple[str, ...] | None = None) -> list[Operation]:
        ops: list[Operation] = []
        for domain in domains or self.domains:
            paths = self.raw[domain].get("paths") or {}
            for path, item in paths.items():
                if not isinstance(item, dict):
                    raise ContractError(f"{domain}:{path} 不是 object（OpenAPI paths 项必须为 object）")
                for method, spec in item.items():
                    if method.lower() not in HTTP_METHODS:
                        continue
                    if not isinstance(spec, dict):
                        raise ContractError(f"{domain}:{path}:{method} 不是 object")
                    op_id = spec.get("operationId")
                    if not op_id:
                        raise ContractError(f"{domain}:{path}:{method} 缺 operationId")
                    ops.append(Operation(domain, path, method.lower(), op_id, spec))
        return ops

    def operation(self, operation_id: str) -> Operation:
        for op in self.operations():
            if op.operation_id == operation_id:
                return op
        available = ", ".join(sorted(op.operation_id for op in self.operations()))
        raise KeyError(f"契约中不存在 operationId={operation_id!r}；现有: {available}")

    def response_schema(self, op: Operation, status: int | str) -> Any | None:
        responses = op.spec.get("responses") or {}
        entry = responses.get(str(status))
        if entry is None:
            return None
        entry = self.deref(entry, op.domain)
        content = entry.get("content") or {}
        for media, body in content.items():
            if "schema" in body:
                return body["schema"]
        return None

    def response_content_type(self, op: Operation, status: int | str) -> str | None:
        responses = op.spec.get("responses") or {}
        entry = responses.get(str(status))
        if entry is None:
            return None
        entry = self.deref(entry, op.domain)
        content = entry.get("content") or {}
        return next(iter(content), None)

    def request_schema(self, op: Operation) -> Any | None:
        body = op.spec.get("requestBody")
        if not body:
            return None
        body = self.deref(body, op.domain)
        content = body.get("content") or {}
        for media, spec in content.items():
            if "schema" in spec:
                return spec["schema"]
        return None

    def parameters(self, op: Operation) -> list[dict]:
        """operation 生效参数 = path-item 级 + operation 级（同名同位置后者覆盖，OpenAPI 语义）。"""
        merged: dict[tuple[str, str], dict] = {}
        item = (self.raw[op.domain].get("paths") or {}).get(op.path) or {}
        for raw in list(item.get("parameters") or []) + list(op.spec.get("parameters") or []):
            param = self.deref(raw, op.domain)
            merged[(param.get("name"), param.get("in"))] = param
        return list(merged.values())

    def component(self, domain: str, section: str, name: str) -> Any:
        components = self.raw[domain].get("components") or {}
        try:
            return self.deref(components[section][name], domain)
        except KeyError as exc:
            raise ContractError(f"{domain}: 缺 components.{section}.{name}") from exc

    # ---------- payload 校验 ----------

    def validate(self, schema: Any, payload: Any) -> list[str]:
        """校验 payload，返回人类可读错误列表（空 = 通过）。"""
        validator = Draft202012Validator(schema, format_checker=FORMAT_CHECKER)
        errors = []
        for error in sorted(validator.iter_errors(payload), key=lambda e: list(e.absolute_path)):
            location = "/".join(str(p) for p in error.absolute_path) or "<root>"
            errors.append(f"{location}: {error.message}")
        return errors

    def schema_at(self, schema: Any, dotted: str) -> Any | None:
        """按 'data.bars[].close' 风格在已 deref 的 schema 中定位；不存在返回 None。"""
        node = schema
        for token in [t for t in dotted.split(".") if t]:
            is_array = token.endswith("[]")
            name = token[:-2] if is_array else token
            if not isinstance(node, dict):
                return None
            if "allOf" in node:  # 兼容 allOf 组合（如 meta）
                merged: dict[str, Any] = {}
                for part in node["allOf"]:
                    if isinstance(part, dict):
                        merged.update(part)
                node = {**merged, **{k: v for k, v in node.items() if k != "allOf"}}
            properties = node.get("properties") or {}
            if name not in properties:
                return None
            node = properties[name]
            if is_array:
                node = node.get("items") if isinstance(node, dict) else None
                if node is None:
                    return None
        return node


# date-time 用 rfc3339 校验（环境已装 rfc3339-validator）；+08:00 的强制要求由契约/数据规则单测断言，
# 因为 JSON Schema 的 format: date-time 本身允许 Z，而 A 股口径（ADR-001 D3）禁止 UTC。
FORMAT_CHECKER = FormatChecker()

INSTRUMENT_ID_RE = re.compile(r"^(SSE|SZSE|BSE):[0-9]{6}$")
# 禁止的点号代码格式（C01）：600519.SH / 000001.SZ 等。允许出现在描述性文案（如共享契约示例说明）中，
# 但不得出现在取值位置；结构测试对 examples 与数据夹具做严格断言。
DOT_CODE_RE = re.compile(r"(?<![A-Za-z0-9:])(?:[0-9]{6}\.(?:SH|SZ|BJ|SS|HK))(?![A-Za-z0-9])")
TZ_CN_SUFFIX = "+08:00"


def is_trading_day(date_str: str, calendar: set[str] | None) -> bool:
    """有交易日历时以日历为准；无日历时仅排除周末（不猜测节假日）。"""
    from datetime import date as _date

    day = _date.fromisoformat(date_str)
    if calendar is not None:
        return date_str in calendar
    return day.weekday() < 5


def quarter_end(report_period: str) -> str:
    """'2026Q3' -> '2026-09-30'（C13）。"""
    year, quarter = report_period[:4], int(report_period[-1])
    ends = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}
    return f"{year}-{ends[quarter]}"


def payload_at(payload: Any, dotted: str) -> list[Any]:
    """按 'data.items[].instrument_id' 风格取值，返回所有命中值（数组展开）；缺失返回空列表。

    用于 consumer 侧断言「我依赖的字段确实在响应里」，与 schema_at 的声明侧断言互补。
    """
    values: list[Any] = [payload]
    for token in [t for t in dotted.split(".") if t]:
        is_array = token.endswith("[]")
        name = token[:-2] if is_array else token
        next_values: list[Any] = []
        for value in values:
            if not isinstance(value, dict) or name not in value:
                continue
            item = value[name]
            if is_array:
                if isinstance(item, list):
                    next_values.extend(item)
            else:
                next_values.append(item)
        values = next_values
        if not values:
            return []
    return values


def walk_string_leaves(node: Any, path: str = "") -> Iterator[tuple[str, str]]:
    """产出 (字段路径, 字符串值)，用于时区/格式类断言。"""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from walk_string_leaves(value, f"{path}.{key}" if path else str(key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk_string_leaves(value, f"{path}[{index}]")
    elif isinstance(node, str):
        yield path, node
