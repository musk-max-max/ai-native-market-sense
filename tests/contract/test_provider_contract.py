"""Provider 侧契约测试：回放录播样本，验证「实现产出的报文符合契约」。

样本来源：tests/contract/specimens/provider/<operationId>.json
- origin=synthetic：A11 按契约构造的合成样本（当前 P0 阶段；服务尚未落地）；
- origin=replay：A1/A3 真实实现录制的脱敏报文（服务落地后替换/补充，CI 只读文件，不打真实接口）。

红灯含义：实现（或样本）与契约不符 —— 字段缺失/类型错/多字段/错误码漂移/权益语义被违反。
归属判定：契约合法 -> 实现问题（A1/A3 修）；契约本身不合法 -> A0 修；样本无法判定 -> A11 重新录。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from openapi_lib import (
    CONTRACTS_DIR,
    DOT_CODE_RE,
    P0_ERROR_CODES,
    ContractRepo,
    payload_at,
    walk_string_leaves,
)

SPECIMENS_DIR = Path(__file__).resolve().parent / "specimens" / "provider"
ALLOWED_ORIGINS = {"synthetic", "replay"}
TZ_SUFFIX = "+08:00"
# 契约里定义为 date 的 *_at 字段：只到日粒度，带时区反而是类型错误（C18 只约束时点）
DATE_ONLY_AT_FIELDS = {"listed_at"}
# 500/429 的错误体由 shared Problem 模板统一保证（见 test_contract_lint），业务语义无差异，
# 因此不要求每个接口单独录播；其余 4xx 必须有录播样本，否则「实现没实现该分支」无法被证明。
COVERAGE_EXEMPT_STATUSES = {"429", "500"}
SECRET_KEY_RE = re.compile(r"(?i)\b(api_?key|secret|password|access_?token|app_?token)\b")


def load_specimen(repo: ContractRepo, operation_id: str) -> dict:
    path = SPECIMENS_DIR / f"{operation_id}.json"
    assert path.exists(), (
        f"{operation_id}: 缺 provider 录播样本 {path.name}。"
        "新增 P0 接口必须同时提供样本，否则 provider 侧契约测试无法生效。"
    )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AssertionError(f"{path.name}: JSON 解析失败: {exc}") from exc


def media_type_for(status: str) -> str:
    return "application/json" if status.startswith("2") else "application/problem+json"


@pytest.fixture(scope="module")
def specimens(repo: ContractRepo) -> dict[str, dict]:
    return {op.operation_id: load_specimen(repo, op.operation_id) for op in repo.operations()}


def test_every_operation_has_provider_specimen(repo: ContractRepo, specimens):
    missing = [
        op.operation_id
        for op in repo.operations()
        if op.operation_id not in specimens or not specimens[op.operation_id].get("cases")
    ]
    assert not missing, "以下接口没有 provider 侧录播样本（契约覆盖率缺口）: " + ", ".join(missing)


def test_specimen_format_is_safe_and_offline(repo: ContractRepo, specimens):
    """样本必须是离线回放数据：无真实接口调用痕迹、无密钥、无点号代码。"""
    problems = []
    for operation_id, spec in specimens.items():
        origin = spec.get("origin")
        if origin not in ALLOWED_ORIGINS:
            problems.append(f"{operation_id}: origin 必须属于 {sorted(ALLOWED_ORIGINS)}，实际 {origin!r}")
        if not str(spec.get("recorded_at", "")).endswith(TZ_SUFFIX) and spec.get("recorded_at"):
            problems.append(f"{operation_id}: recorded_at 必须带 +08:00")
        blob = json.dumps(spec, ensure_ascii=False)
        for match in DOT_CODE_RE.finditer(blob):
            problems.append(f"{operation_id}: 样本中出现点号代码 {match.group(0)!r}（C01）")
        if SECRET_KEY_RE.search(blob):
            problems.append(f"{operation_id}: 样本中出现疑似密钥字段（C19）")
        if re.search(r"(?i)https?://(?:api\.)?tushare\.", blob):
            problems.append(f"{operation_id}: 样本含真实数据源地址，CI 禁止真实接口（只允许录播）")
    assert not problems, "\n".join(problems)


def test_provider_bodies_match_contract(repo: ContractRepo, specimens):
    """核心断言：每个样本 case 的报文按契约 schema 校验（含 additionalProperties=false 的闭合性）。"""
    problems = []
    for op in repo.operations():
        spec = specimens[op.operation_id]
        declared = set((op.spec.get("responses") or {}).keys())
        cases = spec.get("cases") or []
        for case in cases:
            name = case.get("name", "<unnamed>")
            status = str(case.get("status"))
            where = f"{op.operation_id}/{name}"
            if status not in declared:
                problems.append(f"{where}: status={status} 未在契约声明（契约漂移或样本过期）")
                continue
            schema = repo.response_schema(op, status)
            content_type = repo.response_content_type(op, status)
            body = case.get("body")
            if body is None:
                if schema is not None:
                    problems.append(f"{where}: 契约声明了响应体，但样本没有 body")
                continue
            if schema is None:
                problems.append(f"{where}: 契约未声明响应体，样本却给了 body（ADR-001 D4）")
                continue
            if content_type != media_type_for(status):
                problems.append(f"{where}: 媒体类型应为 {media_type_for(status)}，契约实际 {content_type}")
                continue
            errors = repo.validate(schema, body)
            if errors:
                problems.append(f"{where}: 报文不符合契约:\n    " + "\n    ".join(errors))
                continue
            if status.startswith(("4", "5")):
                code = (body or {}).get("code")
                if code not in P0_ERROR_CODES:
                    problems.append(f"{where}: 错误码 {code!r} 不在 P0 冻结集合内（消费方无法兜底）")
                if body.get("status") != int(status):
                    problems.append(f"{where}: Problem.status={body.get('status')} 与 HTTP {status} 不一致")
    assert not problems, "provider 侧报文与契约不符:\n" + "\n".join(problems)


def test_provider_covers_declared_business_errors(repo: ContractRepo, specimens):
    problems = []
    for op in repo.operations():
        covered = {str(case.get("status")) for case in specimens[op.operation_id].get("cases") or []}
        for status in (op.spec.get("responses") or {}):
            if not status.startswith(("4", "5")) or status in COVERAGE_EXEMPT_STATUSES:
                continue
            if status not in covered:
                problems.append(f"{op.operation_id}: 契约声明 {status} 但没有对应录播样本")
        success = [s for s in (op.spec.get("responses") or {}) if s.startswith("2")]
        if success and not any(str(case.get("status")) in success for case in specimens[op.operation_id].get("cases") or []):
            problems.append(f"{op.operation_id}: 没有成功态样本")
    assert not problems, "\n".join(problems)


def test_provider_semantics_beyond_schema(repo: ContractRepo, specimens):
    """schema 表达不了的语义：时区、复权口径回显、权益语义、缺失不补 0。"""
    problems = []
    for operation_id, spec in specimens.items():
        for case in spec.get("cases") or []:
            body = case.get("body")
            if not isinstance(body, dict):
                continue
            where = f"{operation_id}/{case.get('name')}"
            for path, value in walk_string_leaves(body):
                if path == "meta.source.as_of" or (path.endswith("_at") and path.rsplit(".", 1)[-1] not in DATE_ONLY_AT_FIELDS):
                    if not value.endswith(TZ_SUFFIX):
                        problems.append(f"{where}: {path}={value!r} 必须带 +08:00（C18）")
            meta = body.get("meta") or {}
            data = body.get("data") or {}
            if operation_id == "listInstrumentBars" and meta.get("adjustment") != data.get("adjustment"):
                problems.append(f"{where}: meta.adjustment 必须与 data.adjustment 一致（C06）")
            entitlement = meta.get("entitlement") or {}
            if entitlement.get("is_entitled") is False:
                price_fields = ("last_price", "prev_close", "change", "change_pct", "close", "open", "high", "low", "revenue", "net_profit")
                leaked = [key for key in price_fields if data.get(key) is not None]
                if leaked:
                    problems.append(
                        f"{where}: is_entitled=false 却返回可判读数值 {leaked}（ADR-001 D4 / H3 发布否决线）"
                    )
    assert not problems, "\n".join(problems)


def test_consumer_dependency_contract_holds_for_specimens(repo: ContractRepo, specimens):
    """consumer 依赖的字段必须有对应 provider 样本真的给出（防「契约有、实现没有」）。"""
    consumer_dir = Path(__file__).resolve().parent / "specimens" / "consumer"
    problems = []
    for path in sorted(consumer_dir.glob("*.json")):
        spec = json.loads(path.read_text(encoding="utf-8"))
        operation_id = spec.get("operation_id")
        if operation_id not in specimens:
            continue
        successful = [
            case for case in specimens[operation_id].get("cases") or [] if str(case.get("status", "")).startswith("2")
        ]
        for call in spec.get("calls") or []:
            expected_status = str((call.get("expect") or {}).get("status"))
            if not expected_status.startswith("2"):
                continue
            for dotted in (call.get("expect") or {}).get("required_fields") or []:
                if not any(payload_at(case.get("body") or {}, dotted) for case in successful):
                    problems.append(
                        f"{operation_id}/{call.get('name')}: consumer 依赖 {dotted}，但 provider 成功态样本未提供该字段"
                    )
    assert not problems, "\n".join(problems)


RESOURCE_MISSING_OPS = {"getInstrumentQuote", "listInstrumentBars", "getFundamentalSummary"}
INSTRUMENT_ONLY_404_OPS = {"getInstrument"}


def test_not_found_semantics_are_distinguished(specimens):
    """ADR-001 D4：INSTRUMENT_NOT_FOUND=标识不存在/未收录；NOT_FOUND=标识存在但资源无数据。

    价格/财务类接口两种 404 都必须有样本：只留一种会让实现把「无数据」误报成「未收录」，
    H5 会把「这只票今天没行情」渲染成「标的不存在」。
    """
    problems = []
    for operation_id in RESOURCE_MISSING_OPS:
        codes = {
            (case.get("body") or {}).get("code")
            for case in specimens[operation_id].get("cases") or []
            if case.get("status") == 404
        }
        if codes != {"INSTRUMENT_NOT_FOUND", "NOT_FOUND"}:
            problems.append(f"{operation_id}: 404 样本 code 应为 INSTRUMENT_NOT_FOUND+NOT_FOUND，实际 {sorted(codes)}")
    for operation_id in INSTRUMENT_ONLY_404_OPS:
        codes = {
            (case.get("body") or {}).get("code")
            for case in specimens[operation_id].get("cases") or []
            if case.get("status") == 404
        }
        if codes != {"INSTRUMENT_NOT_FOUND"}:
            problems.append(
                f"{operation_id}: 基础信息接口只有「未收录」语义，404 不应出现 NOT_FOUND（资源无数据不适用），实际 {sorted(codes)}"
            )
    assert not problems, "\n".join(problems)
