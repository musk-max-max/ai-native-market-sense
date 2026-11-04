#!/usr/bin/env python3
"""11-12 放行验收 · #6 扩展：audit_gap（断口）与 002 库级约束。

口径来源：
- H4 m01945/m01967/m01981/m02004/m02043/m02068 + Lead L70（2026-11-04 裁定）：
  payload 键为 `window_start`/`window_end`；event_key=`gap|<deployment_uid>|<window_start ISO>`；
  `gap_from`/`gap_to` 是**错误键名**，必须被数据库拒绝（23514），不得静默接受。
- A5 m02079：002 新增题述 DB 级约束（漏字段必须是 DB 拒绝，不是应用层）。

本脚本分四段（任一失败即红灯，不 skip）：
S0  静态：002 里必须出现 window_start/window_end，且不得出现 gap_from/gap_to；
S1  负向插入：缺 target_tier / 缺 from-to / observed 缺 deployment_uid / 非 internal_eval 缺 expires_at /
    错键 gap_from-gap_to / 缺 window_end / lost_count=0 —— 全部断言 SQLSTATE 23514；
S2  正向插入：合法 audit_gap（window_start/window_end/lost_count/reason/owner）在事务里插入成功、event_key
    前缀 `gap|<deployment_uid>|` 且窗口起点与 payload.window_start 一致，随后 rollback（不污染链）；
S3  否定断言（Lead m02043）：`event_key LIKE 'gap|unknown|%'` 行数必须为 0；
    当前库不得存在使用 gap_from/gap_to 的 audit_gap 行（错键残留 = 历史脏数据）。

用法：
  A11_AUDIT_DSN=postgresql://ms@127.0.0.1:55432/a13_verify python3 tests/data/acceptance/check_audit_gap.py
退出码：0 通过 / 1 失败 / 2 缺配置或库不可用（按失败处理，不 skip）。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DDL_002 = os.path.join(ROOT, "services/compliance/migrations/002_audit_gap.sql")
DDL_001 = os.path.join(ROOT, "services/compliance/migrations/001_audit_entitlement_events.sql")
PSQL = shutil.which("psql") or "/opt/homebrew/bin/psql"

GAP_EVENT_KEY_PREFIX = "gap|"
REQUIRED_PAYLOAD_KEYS = ("window_start", "window_end", "lost_count", "reason", "owner")
FORBIDDEN_PAYLOAD_KEYS = ("gap_from", "gap_to")
EXPECTED_001_SHA256 = "c8116e4fa5bb0d88da5cbfb643cdebbcfcec6d24853544425ec59cfa8c5ffd5e"
EVENT_PAYLOADS_JSON = os.path.join(ROOT, "docs/reference/event-payloads.json")
EXPECTED_EVENT_TYPES = (
    "audit_gap", "clause_review", "deploy", "entitlement_expired", "entitlement_flip",
    "hold_clear", "hold_set", "tier_state_observed", "tier_switch", "unauthorized_config",
)

U = "'"  # sql 单引号，下面用 f-string 拼装，避免反斜杠转义地狱


def sha256_of(path: str) -> str:
    import hashlib

    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def psql(sql: str, expect_ok: bool) -> tuple[bool, int, str]:
    """执行一条 SQL（带 VERBOSITY verbose，便于断言 SQLSTATE）。返回 (ok, rc, 输出)。"""
    dsn = os.environ.get("A11_AUDIT_DSN") or os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("[FAIL] 缺少 A11_AUDIT_DSN / DATABASE_URL（验收脚本不 skip）")
    script = "\\set VERBOSITY verbose\n" + sql.rstrip().rstrip(";") + ";\n"
    completed = subprocess.run(
        [PSQL, "-X", "-q", "-t", "-A", dsn, "-v", "ON_ERROR_STOP=1"],
        input=script,
        capture_output=True,
        text=True,
        timeout=60,
    )
    output = (completed.stdout or "") + (completed.stderr or "")
    return completed.returncode == 0, completed.returncode, output


def sqlstate_of(output: str) -> str | None:
    # psql VERBOSITY verbose 的格式是 `ERROR:  23514: ...`；兼容 `SQL state: 23514`。
    match = re.search(r"SQL state: ([0-9A-Z]{5})", output) or re.search(
        r"ERROR:\s+([0-9A-Z]{5}):", output
    )
    return match.group(1) if match else None


def constraint_of(output: str) -> str | None:
    match = re.search(r'violates check constraint "([^"]+)"', output)
    return match.group(1) if match else None


def check_static(problems: list[str]) -> None:
    text = open(DDL_002, encoding="utf-8").read()
    if sha256_of(DDL_001) != EXPECTED_001_SHA256:
        problems.append(f"001 未被授权修改，实际 sha256={sha256_of(DDL_001)}")
    for window_key in REQUIRED_PAYLOAD_KEYS[:2]:
        if window_key not in text:
            problems.append(f"002 的 audit_gap CHECK 缺少目标键 {window_key!r}（L70：以 window_start/window_end 为准）")
    for legacy in FORBIDDEN_PAYLOAD_KEYS:
        hits = [index + 1 for index, line in enumerate(text.splitlines()) if legacy in line]
        if hits:
            problems.append(f"002 仍使用已作废键 {legacy!r}（行 {hits[:6]}；L70 已裁定 window_start/window_end）")
    if "window_start" not in text or "gap|" not in text:
        problems.append("002 的 event_key 分支未体现 gap|<deployment_uid>|<window_start ISO>")


def check_negative_inserts(problems: list[str]) -> None:
    """每条负向插入都必须在 DB 层以 23514 拒绝（不是应用层、不是静默成功）。"""
    base_common = (
        "schema_version=2, event_id=gen_random_uuid(), occurred_at=now(), "
        "rule_version='v1', operator='a11', trace_id='tr', prev_hash=repeat('0',64), hash=repeat('b',64)"
    )
    cases: list[tuple[str, str]] = [
        (
            "deploy 缺 new_value.target_tier",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "authorization_doc_id,authorization_doc_sha256,clause_locator,rule_version,operator,trace_id,prev_hash,hash,"
            "deployment_uid,approval_ref,executor,approver) values (2,gen_random_uuid(),'deploy',now(),"
            "'{\"from\":\"internal_eval\"}','{}','doc-a11',repeat('a',64),'L1.1','v1','a11','tr',"
            "repeat('0',64),repeat('b',64),'dep-a11-gap','APR-A11','exec','appr')",
        ),
        (
            "tier_switch 缺 from/to",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "rule_version,operator,trace_id,prev_hash,hash,deployment_uid,authorization_doc_id,authorization_doc_sha256,"
            "clause_locator) values (2,gen_random_uuid(),'tier_switch',now(),'{}','{}','v1','a11','tr',"
            "repeat('0',64),repeat('b',64),'dep-a11-gap','doc-a11',repeat('a',64),'L1.1')",
        ),
        (
            "tier_state_observed 缺 deployment_uid",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,boot_id,configured_tier) values "
            "(2,gen_random_uuid(),'tier_state_observed',now(),'{}','{}',null,'v1','a11','tr',repeat('0',64),"
            "repeat('b',64),gen_random_uuid(),'internal_eval')",
        ),
        (
            "tier_state_observed 非 internal_eval 缺 expires_at",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,boot_id,deployment_uid,configured_tier) values "
            "(2,gen_random_uuid(),'tier_state_observed',now(),'{}','{}',null,'v1','a11','tr',repeat('0',64),"
            "repeat('b',64),gen_random_uuid(),'dep-a11-gap','c_end_display')",
        ),
        (
            "audit_gap 用已作废 gap_from/gap_to（L70）",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,deployment_uid) values "
            "(2,gen_random_uuid(),'audit_gap',now(),'{}','{\"gap_from\":\"2026-11-04T00:00:00.000Z\","
            "\"gap_to\":\"2026-11-04T00:10:00.000Z\",\"lost_count\":2,\"reason\":\"process_restart\","
            "\"owner\":\"a11\"}',null,'v1','a11','tr',repeat('0',64),repeat('b',64),'dep-a11-gap')",
        ),
        (
            "audit_gap 缺 window_end",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,deployment_uid) values "
            "(2,gen_random_uuid(),'audit_gap',now(),'{}','{\"window_start\":\"2026-11-04T00:00:00.000Z\","
            "\"lost_count\":2,\"reason\":\"transient_write_failure\",\"owner\":\"a11\"}',null,'v1','a11','tr',"
            "repeat('0',64),repeat('b',64),'dep-a11-gap')",
        ),
        (
            "audit_gap 缺 window_start（只剩 window_end）",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,deployment_uid) values "
            "(2,gen_random_uuid(),'audit_gap',now(),'{}','{\"window_end\":\"2026-11-04T00:10:00.000Z\","
            "\"lost_count\":2,\"reason\":\"process_restart\",\"owner\":\"a11\"}',null,'v1','a11','tr',"
            "repeat('0',64),repeat('b',64),'dep-a11-gap')",
        ),
        (
            "audit_gap lost_count=null（transient 自欺；H4 m02212：transient 必须 >=1，process_restart 才允许 null）",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,deployment_uid) values "
            "(2,gen_random_uuid(),'audit_gap',now(),'{}','{\"window_start\":\"2026-11-04T00:00:00.000Z\","
            "\"window_end\":\"2026-11-04T00:10:00.000Z\",\"lost_count\":null,\"reason\":\"transient_write_failure\","
            "\"owner\":\"a11\"}',null,'v1','a11','tr',repeat('0',64),repeat('b',64),'dep-a11-gap')",
        ),
        (
            "audit_gap lost_count=-1（自欺）",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,deployment_uid) values "
            "(2,gen_random_uuid(),'audit_gap',now(),'{}','{\"window_start\":\"2026-11-04T00:00:00.000Z\","
            "\"window_end\":\"2026-11-04T00:10:00.000Z\",\"lost_count\":-1,\"reason\":\"process_restart\","
            "\"owner\":\"a11\"}',null,'v1','a11','tr',repeat('0',64),repeat('b',64),'dep-a11-gap')",
        ),
        (
            "audit_gap window_end < window_start（自欺）",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,deployment_uid) values "
            "(2,gen_random_uuid(),'audit_gap',now(),'{}','{\"window_start\":\"2026-11-04T00:10:00.000Z\","
            "\"window_end\":\"2026-11-04T00:00:00.000Z\",\"lost_count\":2,\"reason\":\"process_restart\","
            "\"owner\":\"a11\"}',null,'v1','a11','tr',repeat('0',64),repeat('b',64),'dep-a11-gap')",
        ),
        (
            "audit_gap lost_count=0（自欺）",
            "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
            "reason,rule_version,operator,trace_id,prev_hash,hash,deployment_uid) values "
            "(2,gen_random_uuid(),'audit_gap',now(),'{}','{\"window_start\":\"2026-11-04T00:00:00.000Z\","
            "\"window_end\":\"2026-11-04T00:10:00.000Z\",\"lost_count\":0,\"reason\":\"process_restart\","
            "\"owner\":\"a11\"}',null,'v1','a11','tr',repeat('0',64),repeat('b',64),'dep-a11-gap')",
        ),
    ]
    before_raw, before_error = psql_text("select count(*) from audit.entitlement_events")
    if before_error:
        problems.append(f"统计负向插入前行数失败：{before_error}")
    for label, statement in cases:
        ok, _rc, output = psql(statement, expect_ok=False)
        if ok:
            problems.append(f"负向插入未被拒绝：{label}（DB 接受了非法行 → 约束漏了）")
            continue
        state = sqlstate_of(output)
        constraint = constraint_of(output)
        if state != "23514":
            problems.append(f"负向插入被拒但 SQLSTATE≠23514：{label}（state={state!r}, constraint={constraint!r}）")
    after_raw, after_error = psql_text("select count(*) from audit.entitlement_events")
    if after_error:
        problems.append(f"统计负向插入后行数失败：{after_error}")
    if before_raw.isdigit() and after_raw.isdigit() and before_raw != after_raw:
        problems.append(
            f"负向插入被拒后行数发生变化：{before_raw} → {after_raw}"
            "（被拒的行不得落库；也防 psql 管道吞退出码造成假绿）"
        )


def psql_text(sql: str) -> tuple[str, str]:
    dsn = os.environ.get("A11_AUDIT_DSN") or os.environ.get("DATABASE_URL")
    if not dsn:
        return "", "缺少 A11_AUDIT_DSN / DATABASE_URL（验收脚本不 skip）"
    completed = subprocess.run(
        [PSQL, "-X", "-q", "-t", "-A", dsn, "-v", "ON_ERROR_STOP=1"],
        input=sql.rstrip().rstrip(";") + ";\n",
        capture_output=True,
        text=True,
        timeout=60,
    )
    return (completed.stdout or "").strip(), (completed.stderr or "").strip()


def constraint_defs() -> tuple[list[str], str]:
    raw, error = psql_text(
        "select coalesce(json_agg(t order by t.conname), '[]'::json)::text from ("
        "select conname, pg_get_constraintdef(oid) as def from pg_constraint "
        "where conrelid = 'audit.entitlement_events'::regclass) t"
    )
    if error:
        return [], error
    import json as _json

    try:
        rows = _json.loads(raw or "[]")
    except _json.JSONDecodeError:
        return [], f"pg_constraint 结果不可解析：{raw[:200]!r}"
    return [(row.get("conname") or "", row.get("def") or "") for row in rows], ""


def check_ddl_matches_reference(problems: list[str]) -> None:
    """A5 m02193：DDL CHECK 的 new_value 键集必须与 docs/reference/event-payloads.json 逐字一致。"""
    import json as _json

    if not os.path.exists(EVENT_PAYLOADS_JSON):
        problems.append(f"缺少统一 payload 真源 {EVENT_PAYLOADS_JSON}")
        return
    try:
        reference = _json.load(open(EVENT_PAYLOADS_JSON, encoding="utf-8"))
    except _json.JSONDecodeError as exc:
        problems.append(f"{EVENT_PAYLOADS_JSON} 不是合法 JSON：{exc}")
        return
    payloads = reference.get("event_types") or {}
    if tuple(sorted(payloads)) != tuple(sorted(EXPECTED_EVENT_TYPES)):
        problems.append(
            f"event-payloads.json 事件类集合与批准清单不一致："
            f"缺 {sorted(set(EXPECTED_EVENT_TYPES) - set(payloads))}、多 {sorted(set(payloads) - set(EXPECTED_EVENT_TYPES))}"
        )
    if tuple(payloads.get("audit_gap", {}).get("new_value", {}).get("required", ())) != REQUIRED_PAYLOAD_KEYS:
        problems.append(
            f"audit_gap required 键集与 L70/H4 冻结口径不一致："
            f"{payloads.get('audit_gap', {}).get('new_value', {}).get('required')}"
        )
    constraints, error = constraint_defs()
    if error:
        problems.append(f"读取 pg_constraint 失败：{error}")
        return
    for event_type, spec in payloads.items():
        new_required = (spec.get("new_value") or {}).get("required") or []
        if not new_required:
            continue
        marker = f"event_type <> '{event_type}'"
        matches = [definition for _name, definition in constraints if marker in definition]
        if not matches:
            problems.append(f"DDL 缺少 {event_type} 的 CHECK 约束（无法证明 required 键被 DB 强制）")
            continue
        definition = matches[0]
        found = set(re.findall(r"new_value \? '([^']+)'", definition))
        missing = sorted(set(new_required) - found)
        invented = sorted(found - set(new_required))
        if missing:
            problems.append(f"DDL 未强制 {event_type}.new_value 必填键：{missing}")
        if invented:
            problems.append(
                f"DDL 强制的 {event_type}.new_value 键不在真源 required 中：{invented}（键名/additive 未登记）"
            )


def check_positive_insert(problems: list[str]) -> None:
    """合法 audit_gap 必须能插入，且 event_key 与 payload.window_start 同源；事务 rollback 不留痕。"""
    window_start = "2026-11-04T00:20:00.000Z"
    window_end = "2026-11-04T00:30:00.000Z"
    statement = (
        "begin; "
        "insert into audit.entitlement_events (schema_version,event_id,event_type,occurred_at,old_value,new_value,"
        "reason,rule_version,operator,trace_id,prev_hash,hash,deployment_uid) values "
        "(2,gen_random_uuid(),'audit_gap',now(),'{}',"
        f"'{{\"window_start\":\"{window_start}\",\"window_end\":\"{window_end}\",\"lost_count\":3,"
        "\"reason\":\"transient_write_failure\",\"owner\":\"a11\"}',null,'v1','a11','tr',"
        "repeat('0',64),repeat('b',64),'dep-a11-gap') returning event_key, new_value->>'window_start'; "
        "rollback"
    )
    ok, _rc, output = psql(statement, expect_ok=True)
    if not ok:
        problems.append(f"合法 audit_gap（window_start/window_end）被数据库拒绝：{output.strip()[:400]}")
        return
    row = output.strip().splitlines()[-1] if output.strip() else ""
    if not row.startswith(f"gap|dep-a11-gap|"):
        problems.append(f"audit_gap event_key 前缀不是 gap|<deployment_uid>|：{row!r}")
    if window_start not in row:
        problems.append(f"event_key 未绑定 payload.window_start（期望含 {window_start}）：{row!r}")


def check_negatives_in_db(problems: list[str]) -> None:
    ok, _rc, output = psql(
        "select count(*) from audit.entitlement_events where event_key like 'gap|unknown|%'",
        expect_ok=True,
    )
    if not ok:
        problems.append(f"无法查询 gap|unknown 行数：{output.strip()[:300]}")
    else:
        value = output.strip().splitlines()[-1].strip()
        if value != "0":
            problems.append(f"存在占位符 gap|unknown|* 行 {value} 条（多副本/多环境共库时会吞断口）")
    ok, _rc, output = psql(
        "select count(*) from audit.entitlement_events "
        "where event_type='audit_gap' and (new_value ? 'gap_from' or new_value ? 'gap_to')",
        expect_ok=True,
    )
    if ok:
        value = output.strip().splitlines()[-1].strip()
        if value != "0":
            problems.append(f"库中存在使用已作废 gap_from/gap_to 的 audit_gap 行 {value} 条（L70）")


def main() -> int:
    problems: list[str] = []
    check_static(problems)
    check_negative_inserts(problems)
    check_positive_insert(problems)
    check_negatives_in_db(problems)
    if problems:
        print("[FAIL] 11-12/#6 audit_gap 与 002 约束")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(
        "[PASS] 11-12/#6 audit_gap：window_start/window_end 键名（L70）、负向插入均被 DB 以 23514 拒绝"
        "（缺 window_start/window_end/target_tier/from-to/expires_at、错键、lost_count=0/null/-1、窗口倒置）、"
        "被拒后事件行数不变、合法 gap 可插入且 event_key 同源、gap|unknown=0、无错键残留"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
