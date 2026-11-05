"""契约结构门禁（ADR-001 D8 解析层 + 结构层 + 语义强制项）。

红灯含义：契约本身不可解析 / 结构违规 / 强制 meta 要素缺失 / 错误码漂移。
修复方：A0（contracts/ 唯一写者）。A11 不改契约，只报红灯。
"""

from __future__ import annotations

import re
from typing import Any, Iterator

import pytest

from known_defects import load_ledger, split_known
from openapi_lib import (
    DOMAINS,
    DOT_CODE_RE,
    INSTRUMENT_ID_RE,
    P0_ERROR_CODES,
    ContractError,
    iter_refs,
    split_ref,
)

OPENAPI_METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
OPERATION_ID_RE = re.compile(r"^[a-z][a-zA-Z0-9]*$")
PATH_SEGMENT_RE = re.compile(r"^[a-z0-9][a-z0-9_.{}-]*$")
SNAKE_CASE_RE = re.compile(r"^[a-z][a-z0-9_]*$")
ENUM_VALUE_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# ADR-001 D4：按响应类别强制的 meta 要素（契约策略表，不是契约字段副本；
# 契约字段本身仍从 contracts/ 现场读取）。
REQUIRED_META = {
    "market:getInstrument": {"source", "entitlement"},
    "market:getInstrumentQuote": {"source", "entitlement", "adjustment", "disclaimer"},
    "market:listInstrumentBars": {"source", "entitlement", "adjustment", "disclaimer"},
    "fundamental:getFundamentalSummary": {"source", "entitlement", "disclaimer"},
    "watchlist:getWatchlist": {"source", "entitlement"},
    "watchlist:addWatchlistItem": {"source", "entitlement"},
    "watchlist:removeWatchlistItem": set(),  # 204 无响应体
    # B1 新增（A0 market 0.4.0 / watchlist 0.3.0）
    "market:getLimitLadder": {"adjustment", "disclaimer"},
    "market:getInstrumentPageSummary": {"disclaimer"},
    "watchlist:getWatchlistReview": {"adjustment", "disclaimer"},
}

# 响应对象必须闭合（additionalProperties: false）的基础定义白名单：
# ResponseMeta 只作为 allOf 基座被组合，扩展方在其外层追加 required，故不能闭合。
CLOSED_OBJECT_WHITELIST = {("shared", "ResponseMeta")}


def walk_schema_nodes(node: Any, path: str = "<root>") -> Iterator[tuple[str, dict]]:
    """产出 (路径, object schema 节点)。"""
    if isinstance(node, dict):
        if "properties" in node or node.get("type") == "object":
            yield path, node
        for key, value in node.items():
            yield from walk_schema_nodes(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk_schema_nodes(value, f"{path}[{index}]")


def iter_examples(node: Any) -> Iterator[tuple[str, Any]]:
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "example":
                yield (key, value)
            elif key == "examples":
                if isinstance(value, list):
                    for item in value:
                        yield ("examples", item)
                elif isinstance(value, dict) and "$ref" not in value:
                    for item in value.values():
                        yield ("examples", item)
            else:
                yield from iter_examples(value)
    elif isinstance(node, list):
        for item in node:
            yield from iter_examples(item)


# ---------------------------------------------------------------- 解析层


def test_all_contracts_parse_and_are_openapi_31(repo):
    for domain in DOMAINS:
        doc = repo.raw[domain]
        assert doc.get("openapi") == "3.1.0", f"{domain}: 必须为 OpenAPI 3.1.0（ADR-001 D1）"
        version = (doc.get("info") or {}).get("version")
        assert version and SEMVER_RE.match(version), f"{domain}: info.version 必须是 SemVer，实际 {version!r}"
        assert (doc.get("info") or {}).get("title"), f"{domain}: info.title 缺失"
        if domain != "shared":
            assert doc.get("paths"), f"{domain}: paths 不得为空"
        assert doc.get("servers"), f"{domain}: servers 缺失"


def test_every_ref_resolves(repo):
    for domain in DOMAINS:
        try:
            repo.deref(repo.raw[domain], domain)
        except ContractError as exc:
            pytest.fail(f"{domain}: $ref 不可解析 -> {exc}", pytrace=False)


def test_refs_are_relative_and_no_30_nullable(repo):
    problems = []
    for domain in DOMAINS:
        for ref in iter_refs(repo.raw[domain]):
            if ref.startswith(("http://", "https://", "file://")):
                problems.append(f"{domain}: 禁止绝对/本地 $ref: {ref}")
    for domain in DOMAINS:
        flat = list(iter_schema_keywords(repo.raw[domain]))
        if "nullable" in flat:
            problems.append(f"{domain}: 使用了 OpenAPI 3.0 的 nullable（ADR-001 D1 禁止）")
    assert not problems, "\n".join(problems)


def iter_schema_keywords(node: Any) -> Iterator[str]:
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from iter_schema_keywords(value)
    elif isinstance(node, list):
        for item in node:
            yield from iter_schema_keywords(item)


def test_dependency_direction_shared_is_leaf(repo):
    """shared 不得引用任何域；域之间不得互相引用（ADR-001 D2）。"""
    problems = []
    for domain in DOMAINS:
        for ref in iter_refs(repo.raw[domain]):
            file_part, _ = split_ref(ref)
            if file_part is None:
                continue
            target = (repo.files[domain].parent / file_part).resolve()
            target_domain = repo.domain_for_file(target)
            if domain == "shared":
                problems.append(f"shared 反向引用域契约: {ref}")
            elif target_domain != "shared":
                problems.append(f"{domain} 跨域引用 {target_domain}: {ref}")
    assert not problems, "\n".join(problems)


def test_no_unused_components(repo):
    """入口可达性分析：paths / shared 被引用组件之外，组件不得孤立（ADR-001 D8）。

    命中已知缺陷台账 = 绿灯 + 债务告警；未登记/已过期/条目失效 = 红灯。
    """
    used: set[tuple[str, str, str]] = set()
    queue = [(domain, op.spec) for domain, op in ((d, o) for d in DOMAINS for o in repo.operations((d,)))]
    seen_docs: set[str] = set()
    while queue:
        domain, node = queue.pop()
        for ref in iter_refs(node):
            target_domain, pointer, target = repo.resolve_ref(domain, ref)
            if not pointer.startswith("/components/"):
                continue
            _, section, name = pointer.strip("/").split("/", 2)
            if (target_domain, section, name) in used:
                continue
            used.add((target_domain, section, name))
            if target_domain not in seen_docs:
                seen_docs.add(target_domain)
            queue.append((target_domain, target))
    unused = []
    for domain in DOMAINS:
        for section, entries in (repo.raw[domain].get("components") or {}).items():
            if section == "securitySchemes":
                continue
            for name in entries:
                if (domain, section, name) not in used:
                    unused.append(f"{domain}: components.{section}.{name}")

    known, unknown, stale = split_known("test_no_unused_components", unused, load_ledger())
    assert not unknown, "存在未被引用的契约组件（会随契约老化漂移）:\n" + "\n".join(unknown)
    if known or stale:
        import warnings

        messages = []
        if known:
            messages.append("已知契约缺陷（未过期，A11 已将债务登记给 owner）:\n" + "\n".join(known))
        if stale:
            messages.append(
                "台账条目已失效（缺陷已修复）——请 A11 在下一个 PR 删除，到期未清理将红灯:\n"
                + "\n".join(f"{entry.id}: {entry.matches}" for entry in stale)
            )
        warnings.warn("\n".join(messages), stacklevel=2)


# ---------------------------------------------------------------- 命名与格式


def test_operation_ids_and_paths(repo):
    problems, seen = [], {}
    for op in repo.operations():
        if not OPERATION_ID_RE.match(op.operation_id):
            problems.append(f"{op.domain}: operationId 必须 camelCase: {op.operation_id}")
        if op.operation_id in seen:
            problems.append(f"operationId 重复: {op.operation_id} ({seen[op.operation_id]} & {op.domain})")
        seen[op.operation_id] = op.domain
        if not op.path.startswith("/v1/"):
            problems.append(f"{op.operation_id}: 路径必须以 /v1/ 开头: {op.path}")
        for segment in [s for s in op.path.split("/") if s]:
            if segment.startswith("{") and segment.endswith("}"):
                continue
            if not PATH_SEGMENT_RE.match(segment):
                problems.append(f"{op.operation_id}: 路径段须为 kebab-case: {segment}")
        if re.search(r"/(get|list|create|update|delete|add|remove)[A-Z]", op.path):
            problems.append(f"{op.operation_id}: 动作应由 HTTP 方法表达，禁止 /getXxx 式路径")
    assert not problems, "\n".join(problems)


def test_schema_field_naming(repo):
    problems = []
    for domain in DOMAINS:
        for name, schema in ((repo.raw[domain].get("components") or {}).get("schemas") or {}).items():
            for path, node in walk_schema_nodes(schema, name):
                for prop in (node.get("properties") or {}):
                    if not SNAKE_CASE_RE.match(prop):
                        problems.append(f"{domain}:{path}: 字段名必须 snake_case: {prop}")
                enum = node.get("enum")
                if isinstance(enum, list):
                    for value in enum:
                        if isinstance(value, str) and not ENUM_VALUE_RE.match(value):
                            problems.append(f"{domain}:{path}: 枚举值必须小写下划线: {value!r}")
    assert not problems, "\n".join(problems)


def test_instrument_id_schema_and_examples(repo):
    schema = repo.component("shared", "schemas", "InstrumentId")
    assert schema.get("pattern") == INSTRUMENT_ID_RE.pattern, (
        "InstrumentId.pattern 与 ADR-001 D3 的 EXCH:CODE 规则不一致"
    )
    problems = []
    for domain in DOMAINS:
        for location, example in iter_examples(repo.raw[domain]):
            if isinstance(example, str):
                match = DOT_CODE_RE.search(example)
                if match:
                    problems.append(f"{domain}:{location}: examples 出现点号代码格式 {match.group(0)!r}（C01）")
                if re.fullmatch(r"\d{6}", example):
                    problems.append(f"{domain}:{location}: 裸 6 位代码不可作为标识示例（C01）")
    assert not problems, "\n".join(problems)


def test_response_objects_are_closed(repo):
    problems = []
    for domain in DOMAINS:
        for name, schema in ((repo.raw[domain].get("components") or {}).get("schemas") or {}).items():
            if (domain, name) in CLOSED_OBJECT_WHITELIST:
                continue
            for path, node in walk_schema_nodes(schema, name):
                if "properties" not in node:
                    continue
                if node.get("additionalProperties") is not False:
                    problems.append(f"{domain}:{path}: 响应对象必须 additionalProperties: false（ADR-001 D5）")
    assert not problems, "\n".join(problems)


# ---------------------------------------------------------------- 包络与 meta（语义层）


def test_success_envelope(repo):
    problems = []
    for op in repo.operations():
        statuses = [s for s in (op.spec.get("responses") or {}) if s.startswith("2")]
        assert statuses, f"{op.operation_id}: 未声明 2xx 响应"
        for status in statuses:
            content_type = repo.response_content_type(op, status)
            schema = repo.response_schema(op, status)
            if status == "204":
                assert schema is None, f"{op.operation_id}: 204 不得携带 schema"
                continue
            if content_type != "application/json":
                problems.append(f"{op.operation_id}: 2xx 响应必须是 application/json，实际 {content_type}")
                continue
            if not isinstance(schema, dict):
                problems.append(f"{op.operation_id}: 2xx 响应缺 schema")
                continue
            required = set(schema.get("required") or [])
            if not {"data", "meta"} <= required:
                problems.append(f"{op.operation_id}: 响应包络必须 required [data, meta]（ADR-001 D4）")
            meta_schema = (schema.get("properties") or {}).get("meta")
            if not isinstance(meta_schema, dict):
                problems.append(f"{op.operation_id}: 缺 meta schema")
                continue
            meta_required = set(meta_schema.get("required") or [])
            for part in repo.deref(meta_schema, op.domain).get("allOf", []):
                meta_required |= set(part.get("required") or [])
            expected = REQUIRED_META.get(f"{op.domain}:{op.operation_id}")
            if expected is None:
                problems.append(
                    f"{op.operation_id}: 未登记 meta 强制要素策略（新增 P0 接口必须同步 A11 策略表）"
                )
                continue
            missing = expected - meta_required
            if missing:
                problems.append(f"{op.operation_id}: meta 缺强制要素 {sorted(missing)}")
    assert not problems, "\n".join(problems)


def test_meta_semantics_from_shared(repo):
    """meta 四要素必须从 shared 引用，禁止域内复制定义（单一真源）。"""
    problems = []
    for op in repo.operations():
        schema = repo.response_schema(op, "200")
        if not isinstance(schema, dict):
            continue
        meta = (schema.get("properties") or {}).get("meta")
        if not isinstance(meta, dict):
            continue
        refs = list(iter_refs(meta_schema_source(repo, op)))
        if not any(r.endswith("#/components/schemas/ResponseMeta") for r in refs):
            problems.append(f"{op.operation_id}: meta 必须 allOf 引用 shared ResponseMeta")
        for element in ("source", "entitlement", "adjustment", "disclaimer"):
            if element in (meta.get("properties") or {}):
                problems.append(f"{op.operation_id}: meta.{element} 禁止在域内重定义（shared 单一真源）")
    assert not problems, "\n".join(problems)


def meta_schema_source(repo, op) -> dict:
    """取原始（未 deref 内部 $ref）的 meta 定义，用于检查它是否通过 $ref 引用 shared。

    响应 schema 通常是整块 $ref（如 '#/components/schemas/QuoteResponse'），
    所以只解析最外层一跳，保留 meta 内部的 $ref 供单一真源断言。
    """
    raw = (repo.raw[op.domain].get("paths") or {}).get(op.path, {}).get(op.method, {})
    schema = (
        raw.get("responses", {})
        .get("200", {})
        .get("content", {})
        .get("application/json", {})
        .get("schema", {})
    )
    if "$ref" in schema:
        _, _, schema = repo.resolve_ref(op.domain, schema["$ref"])
    return (schema.get("properties") or {}).get("meta") or {}


def test_error_responses_use_problem(repo):
    problems = []
    for op in repo.operations():
        for status, entry in (op.spec.get("responses") or {}).items():
            if not status.startswith(("4", "5")):
                continue
            resolved = repo.deref(entry, op.domain)
            content = resolved.get("content") or {}
            if set(content) != {"application/problem+json"}:
                problems.append(f"{op.operation_id} {status}: 错误响应用 application/problem+json（RFC 9457）")
                continue
            schema = content["application/problem+json"].get("schema") or {}
            resolved_schema = repo.deref(schema, op.domain)
            if not {"code", "title", "status", "type"} <= set(resolved_schema.get("required") or []):
                problems.append(f"{op.operation_id} {status}: Problem 必须 required type/title/status/code")
    assert not problems, "\n".join(problems)


def test_error_code_set_is_frozen(repo):
    """code 是契约测试唯一依据；集合必须与 ADR-001 D4 完全一致。

    新增错误码是 D5 允许的非破坏变更，但必须「改 ADR + 同步本断言」一起走；
    只改契约不改 ADR（或反之）都会红——这是防 consumer 漏处理未知码的唯一保险。
    """
    problem = repo.component("shared", "schemas", "Problem")
    description = (problem.get("properties") or {}).get("code", {}).get("description", "")
    documented = set(re.findall(r"\b[A-Z][A-Z0-9_]{4,}\b", description))
    assert documented == set(P0_ERROR_CODES), (
        "shared Problem.description 的错误码清单与 P0 冻结集合不一致："
        f"新增 {sorted(documented - set(P0_ERROR_CODES))}，缺失 {sorted(set(P0_ERROR_CODES) - documented)}"
    )


def test_auth_contract(repo):
    """自选是私有数据：必须 bearerAuth，且响应声明 401；其他域 P0 公开只读。"""
    problems = []
    watchlist_ops = [op for op in repo.operations(("watchlist",))]
    doc_security = repo.raw["watchlist"].get("security") or []
    for op in watchlist_ops:
        if not (op.spec.get("security") or doc_security):
            problems.append(f"{op.operation_id}: 私有数据必须声明 security（operation 或文档级）")
        if "401" not in (op.spec.get("responses") or {}):
            problems.append(f"{op.operation_id}: 未声明 401")
    if not watchlist_ops:
        problems.append("watchlist 域没有任何 operation")
    schemes = (repo.raw["watchlist"].get("components") or {}).get("securitySchemes") or {}
    if "bearerAuth" not in schemes:
        problems.append("watchlist: 缺 securitySchemes.bearerAuth")
    for op in repo.operations():
        if op.domain == "market" and "401" in (op.spec.get("responses") or {}):
            problems.append(f"{op.operation_id}: market 为公开只读，不应声明 401（授权按 entitlement 处理）")
    assert not problems, "\n".join(problems)


def test_declared_statuses_cover_p0_errors(repo):
    """错误码契约必须可被消费方兜底：全部接口 429/500，带入参的接口 400，按 id 取单资源的接口 404。"""
    problems = []
    for op in repo.operations():
        declared = set(op.spec.get("responses") or {})
        for required in ("429", "500"):
            if required not in declared:
                problems.append(f"{op.operation_id}: 缺 {required} 声明")
        has_input = bool(repo.parameters(op)) or bool(op.spec.get("requestBody"))
        if has_input and "400" not in declared:
            problems.append(f"{op.operation_id}: 有入参必须声明 400（VALIDATION_ERROR）")
        is_item_get = op.method == "get" and "{" in op.path
        if is_item_get and "404" not in declared:
            problems.append(f"{op.operation_id}: 按 id 取单资源必须声明 404（INSTRUMENT_NOT_FOUND）")
    assert not problems, "\n".join(problems)


PLATFORM_SOURCE_PATTERN = re.compile(r"^platform_[a-z_]+$")
VENDOR_TOKENS = ("tushare", "wind", "choice", "ifind", "akshare", "eastmoney")


def test_shared_source_vocabulary_is_closed_platform_enum(repo):
    """SourceRef.source 是 C 端展示文案的唯一依据：封闭枚举、平台词表、不得泄漏厂商名。

    对应 ADR-004（来源词表化）：内部溯源放可选 source_id，source 只描述平台对数据的承诺。
    新增成员属契约变更，必须走 ADR-001 D6；把枚举改回自由字符串 = 放宽门禁，红灯。
    """
    source_ref = repo.component("shared", "schemas", "SourceRef")
    source_prop = (source_ref.get("properties") or {}).get("source") or {}
    enum = source_prop.get("enum")
    assert isinstance(enum, list) and enum, "SourceRef.source 必须是封闭 enum（自由字符串会让 C 端文案失控）"
    assert all(isinstance(value, str) and PLATFORM_SOURCE_PATTERN.match(value) for value in enum), (
        f"SourceRef.source 成员必须是 ^platform_[a-z_]+$，实际 {enum}"
    )
    assert len(enum) == len(set(enum)), "SourceRef.source 枚举成员不得重复"
    assert "platform_eod" in enum, "P0 主口径 platform_eod 必须在词表里"


def test_contracts_do_not_leak_vendor_names(repo):
    """契约（含 description/examples）里不得出现供数方厂商名：换源不改变本契约。"""
    problems = []
    for domain in DOMAINS:
        text = repo.files[domain].read_text(encoding="utf-8").lower()
        for token in VENDOR_TOKENS:
            if re.search(rf"(?<![a-z0-9_]){token}(?![a-z0-9_])", text):
                problems.append(f"{domain}: 契约文本出现厂商名 {token!r}")
    assert not problems, "\n".join(problems)
