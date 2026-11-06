"""preflight 决策表自测（A12）：准入判定错了，整个 E2E 的「skip vs fail」语义就错了。

这组测试不依赖 docker/网络，只测 decide() 的优先级：
  - 资产/配置硬缺陷始终 FAIL（不能被环境 SKIP 掩盖）
  - 无栈/无实现 -> SKIP，但 fixture 缺口必须出现在 reasons 里
  - 栈+实现就绪而 fixture 缺失 -> FAIL（核心验收：不许静默放行）
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import preflight  # noqa: E402


def checks(*items):
    c = preflight.Checks()
    for item in items:
        c.add(*item)
    return c


def test_hard_failure_wins_over_environment():
    c = checks((preflight.FAIL, "COMPOSE_STATIC", "坏"), (preflight.SKIP, "STACK", "没栈"))
    decision, code, reasons = preflight.decide(c, stack_up=False, impl_ready=False, offline=False)
    assert decision == "FAIL" and code == 1
    assert "FAIL:COMPOSE_STATIC" in reasons


def test_offline_is_skip_even_with_fixtures_pending():
    c = checks((preflight.SKIP, "FIXTURES", "0 条录制"))
    decision, code, _ = preflight.decide(c, stack_up=False, impl_ready=False, offline=True)
    assert decision == "SKIP" and code == 78


def test_no_stack_is_skip():
    c = checks((preflight.SKIP, "FIXTURES", "0 条录制"))
    decision, code, reasons = preflight.decide(c, stack_up=False, impl_ready=False, offline=False)
    assert decision == "SKIP" and code == 78
    assert reasons[0].startswith("ENV_STACK_DOWN")


def test_impl_absent_skips_but_reports_fixture_gap():
    c = checks((preflight.SKIP, "IMPL_STOCK_PAGE", "404"), (preflight.SKIP, "FIXTURES", "0 条录制"))
    decision, code, reasons = preflight.decide(c, stack_up=True, impl_ready=False, offline=False)
    assert decision == "SKIP" and code == 78
    assert any(r.startswith("IMPL_ABSENT") for r in reasons)
    assert any(r.startswith("FIXTURES_PENDING") for r in reasons), "fixture 缺口不得被 skip 掩盖"


def test_ready_stack_with_missing_fixtures_is_ready_but_p0_10_skips():
    # Lead 2026-11-04：录播（FIXTURES/REPLAY）只影响 P0-10，不再把 11 条用例整体 FAIL/SKIP。
    c = checks((preflight.OK, "STACK", "ok"), (preflight.SKIP, "FIXTURES", "0 条录制"),
               (preflight.SKIP, "REPLAY", "replay 不可达：P0-10 将 skip"))
    decision, code, reasons = preflight.decide(c, stack_up=True, impl_ready=True, offline=False,
                                               data_ready=True, replay_ready=False)
    assert decision == "READY" and code == 0
    assert any(r.startswith("P0-10_SKIP") for r in reasons), reasons


def test_data_ready_false_skips_with_explicit_reason():
    c = checks((preflight.OK, "STACK", "ok"),
               (preflight.SKIP, "DATA_READY", "/healthz data_ready=false（reason=INGEST_FAILED:load）"))
    decision, code, reasons = preflight.decide(c, stack_up=True, impl_ready=True, offline=False,
                                               data_ready=False)
    assert decision == "SKIP" and code == 78
    assert reasons[0].startswith("DATA_NOT_READY")


def test_native_stack_without_compose_or_replay_is_testable():
    # 本机原生 PG+api+web（无 compose、无 replay）：只要 healthz 可达 + data_ready=true 就可测。
    c = checks((preflight.OK, "STACK_API", "api /healthz 200"), (preflight.OK, "STACK_WEB", "web 200"),
               (preflight.OK, "IMPL_STOCK_PAGE", "200"), (preflight.OK, "DATA_READY", "true"),
               (preflight.SKIP, "REPLAY", "replay 不可达：P0-10 将 skip"),
               (preflight.SKIP, "FIXTURES", "0 条录制"))
    decision, code, reasons = preflight.decide(c, stack_up=True, impl_ready=True, offline=False,
                                               data_ready=True, replay_ready=False)
    assert decision == "READY" and code == 0


def test_ready_stack_without_auth_skips_only_auth_cases():
    c = checks((preflight.OK, "STACK", "ok"), (preflight.SKIP, "AUTH", "无 token"))
    decision, code, reasons = preflight.decide(c, stack_up=True, impl_ready=True, offline=False)
    assert decision == "SKIP" and code == 78
    assert reasons[0].startswith("AUTH_MISSING")


def test_all_ready():
    c = checks((preflight.OK, "STACK", "ok"), (preflight.OK, "FIXTURES", "4 条"))
    decision, code, _ = preflight.decide(c, stack_up=True, impl_ready=True, offline=False)
    assert decision == "READY" and code == 0


def test_entitlement_normal_matrix_wants_entitled():
    level, _ = preflight.entitlement_verdict(
        "normal", 200, {"meta": {"entitlement": {"tier": "c_end_display", "is_entitled": True}}})
    assert level == preflight.OK


def test_entitlement_normal_matrix_rejects_restricted_stack():
    level, detail = preflight.entitlement_verdict(
        "normal", 200, {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}}}, "quote")
    assert level == preflight.FAIL and "entitlement-positive.yml" in detail


def test_entitlement_normal_fail_closed_default_is_attributed():
    # A13/H5：默认 compose 固定 internal_eval（fail-closed，KD-ENT-01）。
    # normal 矩阵裸跑应给出配置归因（指向 positive override），不赖实现。
    level, detail = preflight.entitlement_verdict(
        "normal", 200, {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}}}, "quote")
    assert level == preflight.FAIL
    assert "CONFIG_TIER_FAIL_CLOSED" in detail
    assert "docker-compose.entitlement-positive.yml" in detail and "E2E_COMPOSE_PROJECT" in detail


def test_entitlement_restricted_accepts_403_problem():
    level, _ = preflight.entitlement_verdict(
        "restricted", 403, {"code": "ENTITLEMENT_RESTRICTED", "type": "about:blank", "title": "x", "status": 403})
    assert level == preflight.OK


def test_entitlement_restricted_rejects_200_false_for_quote():
    # Lead 2026-11-04 裁定：quote 家族必须 403，200+is_entitled=false 不接受（F1 否决线 fail-closed）
    level, detail = preflight.entitlement_verdict(
        "restricted", 200, {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}}}, "quote")
    assert level == preflight.FAIL and "403" in detail


def test_entitlement_restricted_accepts_200_false_for_instrument_base():
    # A3：基础信息 403 会让页面连证券名都显示不出来，故 authorized=false + 200，但不含行情数值
    level, _ = preflight.entitlement_verdict(
        "restricted", 200, {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}}}, "instrument")
    assert level == preflight.OK


def test_entitlement_restricted_rejects_403_for_instrument_base():
    level, _ = preflight.entitlement_verdict(
        "restricted", 403, {"code": "ENTITLEMENT_RESTRICTED"}, "instrument")
    assert level == preflight.FAIL


def test_contract_declares_403_scans_path_block():
    text = """paths:
  /v1/instruments/{instrument_id}/quote:
    get:
      responses:
        '200': {}
        '403':
          $ref: '#/x'
  /v1/instruments/{instrument_id}/bars:
    get:
      responses:
        '200': {}
"""
    assert preflight.contract_declares_403(text, "/v1/instruments/{instrument_id}/quote") is True
    assert preflight.contract_declares_403(text, "/v1/instruments/{instrument_id}/bars") is False
    assert preflight.contract_declares_403(text, "/nope") is None


def test_restricted_quote_distinguishes_contract_missing_from_impl_wrong():
    body = {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}}}
    level, detail = preflight.entitlement_verdict("restricted", 200, body, "quote", contract_403=False)
    assert level == preflight.FAIL and detail.startswith("CONTRACT_MISSING_403") and "A0" in detail
    level, detail = preflight.entitlement_verdict("restricted", 200, body, "quote", contract_403=True)
    assert level == preflight.FAIL and detail.startswith("IMPL_WRONG_STATUS")


def test_restricted_instrument_rejects_market_numbers():
    body = {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}},
            "data": {"instrument_id": "SSE:600519", "name": "贵州茅台", "price": 1700.0}}
    level, detail = preflight.entitlement_verdict("restricted", 200, body, "instrument")
    assert level == preflight.FAIL and detail.startswith("IMPL_LEAKS_F1_NUMBERS")


def test_restricted_instrument_exact_match_does_not_flag_exchange():
    # 防误伤回归：Instrument.exchange 是契约 required 字段，绝不能被当作 change（精确 key 匹配）
    body = {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}},
            "data": {"instrument_id": "SSE:600519", "exchange": "SSE", "name": "贵州茅台",
                     "board": "main", "security_type": "stock", "list_status": "listed",
                     "list_date": "2001-08-27"}}
    level, detail = preflight.entitlement_verdict("restricted", 200, body, "instrument")
    assert level == preflight.OK, detail
    assert preflight.find_forbidden_f1_keys(body["data"]) == []


def test_restricted_instrument_allows_name_only():
    body = {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}},
            "data": {"instrument_id": "SSE:600519", "name": "贵州茅台", "list_date": "2001-08-27"}}
    level, _ = preflight.entitlement_verdict("restricted", 200, body, "instrument")
    assert level == preflight.OK


def test_decide_surfaces_entitlement_reason_code():
    checks = preflight.Checks()
    checks.add(preflight.FAIL, "ENTITLEMENT", "CONTRACT_MISSING_403: 契约未声明 403")
    decision, code, reasons = preflight.decide(checks, stack_up=False, impl_ready=False, offline=False)
    assert decision == "FAIL" and code == 1 and "FAIL:ENTITLEMENT:CONTRACT_MISSING_403" in reasons


def test_entitlement_restricted_403_for_fundamental():
    level, _ = preflight.entitlement_verdict(
        "restricted", 403, {"code": "ENTITLEMENT_RESTRICTED"}, "fundamental-summary")
    assert level == preflight.OK


def test_entitlement_watchlist_platform_data_both_matrices():
    body = {"meta": {"entitlement": {"tier": "platform_user_data", "is_entitled": True}}}
    for matrix in ("normal", "restricted"):
        level, _ = preflight.entitlement_verdict(matrix, 200, body, "watchlist")
        assert level == preflight.OK, matrix


def test_entitlement_watchlist_not_checked_as_market_tier():
    # watchlist 不受 F1 矩阵影响：internal_eval 栈下也必须是 platform_user_data + true
    body = {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}}}
    level, _ = preflight.entitlement_verdict("restricted", 200, body, "watchlist")
    assert level == preflight.FAIL


def test_entitlement_normal_rejects_restricted_stack_any_endpoint():
    level, detail = preflight.entitlement_verdict(
        "normal", 200, {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}}}, "bars")
    assert level == preflight.FAIL and "entitlement-positive.yml" in detail


def test_entitlement_matrix_typo_is_fail():
    level, detail = preflight.entitlement_verdict("noraml", 200, {})
    assert level == preflight.FAIL and "非法" in detail


# ---- Lead 2026-11-04 补充：data_ready 契约与「报告可信度」矛盾检查 ----

def test_data_ready_missing_field_is_impl_fail():
    c = preflight.Checks()
    value = preflight.check_data_ready(c, {"status": "ok"})
    assert value is None
    assert "DATA_READY" in c.ids(preflight.FAIL)
    assert any("IMPL_MISSING_DATA_READY" in i["detail"] for i in c.by_level(preflight.FAIL))


def test_data_ready_true_with_reason_is_contradiction():
    c = preflight.Checks()
    value = preflight.check_data_ready(c, {"data_ready": True, "data_ready_reason": "QUALITY_RED"})
    assert value is True
    assert "CONTRADICTION" in c.ids(preflight.FAIL)


def test_data_ready_true_but_data_skip_is_contradiction():
    c = checks((preflight.OK, "STACK", "ok"),
               (preflight.SKIP, "DATA_READY", "/healthz data_ready=false"))
    decision, code, reasons = preflight.decide(c, stack_up=True, impl_ready=True, offline=False, data_ready=True)
    assert decision == "FAIL" and code == 1
    assert reasons[0].startswith("FAIL:CONTRADICTION")


def test_data_ready_true_with_impl_absent_is_not_contradiction():
    # 数据已就绪但页面未实现：SKIP IMPL_ABSENT 是合法组合，不算矛盾
    c = checks((preflight.SKIP, "IMPL_STOCK_PAGE", "404"))
    decision, code, reasons = preflight.decide(c, stack_up=True, impl_ready=False, offline=False, data_ready=True)
    assert decision == "SKIP" and code == 78
    assert reasons[0].startswith("IMPL_ABSENT")


def test_data_ready_false_but_ready_is_contradiction():
    # 正常路径下 data_ready=false 会先 SKIP；这条守住「判定层若给出 READY」的可信度兜底。
    msg = preflight.data_ready_contradiction(False, "READY", ["栈可测"])
    assert msg.startswith("FAIL:CONTRADICTION")


def test_ingest_report_ready_mismatch_with_healthz_is_contradiction(tmp_path, monkeypatch):
    report = tmp_path / "ingest-report.json"
    report.write_text(json.dumps({"schema_version": 1, "ready": True, "failed_step": None,
                                  "quality_level": "green"}), encoding="utf-8")
    monkeypatch.setattr(preflight, "INGEST_REPORT", report)
    c = preflight.Checks()
    preflight.check_ingest_report(c, data_ready=False)
    assert "CONTRADICTION" in c.ids(preflight.FAIL)


def test_ingest_report_ready_with_failed_step_is_invalid(tmp_path, monkeypatch):
    report = tmp_path / "ingest-report.json"
    report.write_text(json.dumps({"schema_version": 1, "ready": True, "failed_step": "load",
                                  "quality_level": "green"}), encoding="utf-8")
    monkeypatch.setattr(preflight, "INGEST_REPORT", report)
    c = preflight.Checks()
    preflight.check_ingest_report(c, data_ready=True)
    assert "INGEST_REPORT_INVALID" in c.ids(preflight.FAIL)


# ---- Lead m01002 / A0 m01022 / decisions.md L56：出口扫描必须覆盖响应头 ----

def test_response_header_cause_is_f1_leak():
    level, detail = preflight.entitlement_verdict(
        "restricted", 403, {"code": "ENTITLEMENT_RESTRICTED"}, "quote", None,
        {"x-entitlement-cause": "hold_active"})
    assert level == preflight.FAIL and "IMPL_LEAKS_F1_HEADERS" in detail


def test_response_header_reason_word_is_f1_leak():
    # 不叫 x-entitlement-cause、只要值把「为什么被拒」还回去，同样是漏
    level, detail = preflight.entitlement_verdict(
        "restricted", 403, {"code": "ENTITLEMENT_RESTRICTED"}, "bars", None, {"X-Reason": "expired"})
    assert level == preflight.FAIL and "IMPL_LEAKS_F1_HEADERS" in detail


def test_response_header_fingerprint_is_leak():
    level, detail = preflight.entitlement_verdict(
        "normal", 200, {"meta": {"entitlement": {"tier": "c_end_display", "is_entitled": True}}},
        "quote", None, {"Server": "uvicorn", "X-Powered-By": "Express"})
    assert level == preflight.FAIL and "IMPL_LEAKS_FINGERPRINT_HEADER" in detail


def test_clean_headers_pass():
    level, _ = preflight.entitlement_verdict(
        "restricted", 403, {"code": "ENTITLEMENT_RESTRICTED"}, "quote", None,
        {"content-type": "application/problem+json", "cache-control": "no-store"})
    assert level == preflight.OK


def test_header_scan_covers_instrument_base_200():
    level, detail = preflight.entitlement_verdict(
        "restricted", 200,
        {"meta": {"entitlement": {"tier": "internal_eval", "is_entitled": False}}},
        "instrument", None, {"X-Entitlement-Cause": "unauthorized_config"})
    assert level == preflight.FAIL and "IMPL_LEAKS_F1_HEADERS" in detail


# ---- KD-E2E-AUTH-ALIGN（ADR-008 S1）：匿名 401 默认拒绝；401/403 语义不得混 ----

def test_anon_401_unauthenticated_problem_is_ok():
    level, detail = preflight.anon_auth_verdict(401, {"code": "UNAUTHENTICATED"})
    assert level == preflight.OK and "401" in detail


def test_anon_401_wrong_code_fails():
    level, detail = preflight.anon_auth_verdict(401, {"code": "ENTITLEMENT_RESTRICTED"})
    assert level == preflight.FAIL and "IMPL_WRONG_BODY" in detail


def test_anon_403_is_wrong_status_not_entitlement():
    # 403 = 已认证但未授权；匿名看到 403 说明 preHandler 没拦住，不能算「授权正常」
    level, detail = preflight.anon_auth_verdict(403, {"code": "ENTITLEMENT_RESTRICTED"})
    assert level == preflight.FAIL and "IMPL_WRONG_STATUS" in detail
    assert "401/403" in detail


def test_anon_200_means_endpoint_mis_public():
    level, detail = preflight.anon_auth_verdict(200, {})
    assert level == preflight.FAIL and "IMPL_WRONG_STATUS" in detail
    assert "误公开" in detail


def test_anon_unreachable_is_skip():
    level, _ = preflight.anon_auth_verdict(None, {})
    assert level == preflight.SKIP
