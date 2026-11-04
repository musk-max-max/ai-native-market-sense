#!/usr/bin/env python3
"""11-12 放行验收 · 第 6 条：审计事件可回指、链完整、幂等、append-only（只读 PG 校验）。

唯一真源：`services/compliance/migrations/001_audit_entitlement_events.sql`（A5 维护）。
本脚本**不硬编码表结构**：启动时解析 DDL 的 `event_type` / `reason` CHECK 集合，
再按 DDL 的类型约束逐条校验，避免"脚本口径 vs 实现口径"各说各话。

列名与字段归属（A5 m01307）：
- `authorization_doc_sha256`（不是 doc_sha256）、`authorization_valid_until`；
- **没有 cause 列**：cause / internal_code 属 API/响应层（lead L47），审计表只有 reason；
- `cause`/`doc_sha256`/`clause_locator` **不是每行必填**，按事件类型校验
  （授权类 deploy/tier_switch/hold_set/hold_clear 才要求条款回指字段）。
- lead L47 与 H4 m01334 对 reason 取值口径不一致（4 值 vs 6 值），DDL 当前放行 11 值并集；
  本脚本按 DDL（数据库真实约束）校验，遇未知值才 FAIL，并把口径冲突显式打印，不误报。

抽样（H4 m01334）：expired / flip(env_change) / tier_switch / hold_set / hold_clear / deploy /
clause_review 七类。若 DDL 尚不支持某类（如 clause_review）、或缺少 snapshot_sha256 列，
脚本报 [BLOCKED]（基础设施缺口，不 skips、不造假事件），并列出 owner。

只读：`A11_AUDIT_DSN`（或 `DATABASE_URL`），psql 以 UTC 会话渲染时间。
退出码：0 通过 / 1 失败或阻塞 / 2 缺配置。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DDL_PATHS = [
    REPO_ROOT / "services" / "compliance" / "migrations" / "001_audit_entitlement_events.sql",
    REPO_ROOT / "services" / "compliance" / "migrations" / "002_audit_gap.sql",
]
PSQL_BINARY = shutil.which("psql") or "/opt/homebrew/bin/psql"
TABLE = os.environ.get("A11_EVENTS_TABLE", "audit.entitlement_events")
ZERO_HASH = "0" * 64

# ---------------------------------------------------------------------------
# 双源校验：DDL 是「实现」，这里的清单是「已批准口径」（lead L49 + H4 m01334/m01474）。
# 只解析 DDL 会让门禁永远与 DDL 自洽——DDL 写错，门禁就跟着错；两源必须一致。
# 批准口径：
#   event_type 10 类（9 类 + audit_gap，A5 002/H4 m01945；L70 键名 window_start/window_end）
#   reason 单列 6 值，无 cause / internal_code 列（lead L49；L47/L48 作废）
# ---------------------------------------------------------------------------
GAP_REQUIRED_KEYS = ("window_start", "window_end", "lost_count", "reason", "owner")
APPROVED_EVENT_TYPES = frozenset({
    "entitlement_expired",
    "entitlement_flip",
    "tier_state_observed",
    "unauthorized_config",
    "deploy",
    "tier_switch",
    "hold_set",
    "hold_clear",
    "clause_review",
    "audit_gap",
})
APPROVED_REASONS = frozenset({
    "env_change",
    "expires_at_passed",
    "expected_fingerprint_mismatch",
    "manual_signoff",
    "hold_active",
    "clause_change",
})
# H4 m01334 最终抽样集（7 类；clause_review 是否可写入取决于 DDL，脚本会检测）。
REQUIRED_EVENT_TYPES = (
    "entitlement_expired",
    "entitlement_flip",
    "tier_switch",
    "hold_set",
    "hold_clear",
    "deploy",
    "clause_review",
    "audit_gap",
)

AUTHORIZATION_EVENT_TYPES = {"deploy", "tier_switch", "hold_set", "hold_clear", "clause_review"}

ISO_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$")


def psql_text(dsn: str, sql: str) -> tuple[str, str]:
    if not os.path.exists(PSQL_BINARY):
        return "", f"找不到 psql（{PSQL_BINARY}）"
    env = dict(os.environ, PGOPTIONS="-c timezone=UTC")
    completed = subprocess.run(
        [PSQL_BINARY, dsn, "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    if completed.returncode != 0:
        return "", f"查询失败（DDL/权限未就绪？）：{completed.stderr.strip()[-800:]}"
    return completed.stdout.strip(), ""


def parse_ddl_sets() -> tuple[set[str], set[str], str]:
    """从 DDL 文本解析 event_type / reason 的 CHECK 集合（唯一真源）。"""
    missing = [str(path) for path in DDL_PATHS if not path.exists()]
    if missing:
        return set(), set(), f"DDL 不存在：{missing}"
    # 001 建表、002 放宽/扩展约束；后者覆盖前者，取最后一次出现的 CHECK。
    ddl = "\n".join(path.read_text(encoding="utf-8") for path in DDL_PATHS)

    base_ddl = DDL_PATHS[0].read_text(encoding="utf-8")

    def values_in(pattern: str, source: str = "all") -> set[str]:
        # 同一字段可能在列级 CHECK 与事件类型分支 CHECK 中各出现一次；
        # 列级集合是分支集合的超集，因此取并集（而不是最后一次匹配，避免被小集合覆盖）。
        haystack = ddl if source == "all" else base_ddl
        values: set[str] = set()
        for match in re.finditer(pattern, haystack, re.DOTALL):
            values |= set(re.findall(r"'([^']+)'", match.group(1)))
        return values

    event_types = values_in(r"event_type\s+IN\s*\((.*?)\)")
    # 列级 reason 枚举只在 001 定义；002 里的 reason IN (...) 属于 audit_gap.new_value，不是列枚举。
    reasons = values_in(r"reason\s+IN\s*\((.*?)\)", source="base")
    if not event_types:
        return set(), set(), "无法从 DDL 解析 event_type 集合：" + " + ".join(str(p) for p in DDL_PATHS)
    if not reasons:
        return event_types, set(), "无法从 DDL 解析 reason 集合：" + " + ".join(str(p) for p in DDL_PATHS)
    return event_types, reasons, ""


def table_columns(dsn: str) -> tuple[set[str], str]:
    raw, error = psql_text(
        dsn,
        "select coalesce(json_agg(column_name), '[]'::json)::text "
        "from information_schema.columns "
        f"where table_schema = split_part('{TABLE}', '.', 1) "
        f"and table_name = split_part('{TABLE}', '.', 2)",
    )
    if error:
        return set(), error
    try:
        return set(json.loads(raw or "[]")), ""
    except json.JSONDecodeError:
        return set(), "information_schema 查询结果不可解析"


def load_events(dsn: str) -> tuple[list[dict], str]:
    # 显式选列（不 select *）；canonical 文本用于独立重算 hash，不只信 DB 自证。
    query = f"""
        select coalesce(json_agg(t order by t.occurred_at, t.event_id), '[]'::json)::text
          from (
            select e.event_id::text                                        as event_id,
                   e.event_key,
                   e.schema_version,
                   e.event_type,
                   to_char(e.occurred_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')                as occurred_at,
                   e.boot_id::text                                          as boot_id,
                   e.deployment_uid,
                   e.state_version,
                   e.reason,
                   e.effective_tier,
                   e.configured_tier,
                   to_char(e.expires_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')                as expires_at,
                   btrim(e.config_fingerprint)                              as config_fingerprint,
                   e.authorization_doc_id,
                   btrim(e.authorization_doc_sha256)                        as authorization_doc_sha256,
                   e.clause_locator,
                   to_char(e.authorization_valid_until at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')                as authorization_valid_until,
                   e.approval_ref,
                   e.executor,
                   e.approver,
                   e.operator,
                   e.trace_id,
                   e.rule_version,
                   e.release_id,
                   btrim(e.manifest_hash)                                   as manifest_hash,
                   e.hold_id::text                                          as hold_id,
                   e.hold_ticket,
                   e.hold_signer,
                   e.old_value::text                                        as old_value,
                   e.new_value::text                                        as new_value,
                   btrim(e.prev_hash)                                       as prev_hash,
                   btrim(e.hash)                                            as hash,
                   audit.entitlement_event_canonical(e)                     as canonical
              from {TABLE} e
          ) t
    """
    raw, error = psql_text(dsn, query)
    if error:
        return [], error
    if not raw:
        return [], ""
    try:
        return json.loads(raw), ""
    except json.JSONDecodeError as exc:
        return [], f"事件结果不是合法 JSON：{exc}: {raw[:300]!r}"


def check_chain_rows(rows: list[dict]) -> list[str]:
    problems: list[str] = []
    previous_hash = ZERO_HASH
    for index, row in enumerate(rows, start=1):
        if row.get("prev_hash") != previous_hash:
            problems.append(
                f"链断裂：第 {index} 条 prev_hash={row.get('prev_hash')!r}，期望 {previous_hash!r}"
            )
        canonical = row.get("canonical")
        if not isinstance(canonical, str):
            problems.append(f"第 {index} 条缺少 canonical 文本，无法独立重算 hash")
        else:
            recomputed = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
            if recomputed != row.get("hash"):
                problems.append(
                    f"hash 不匹配：第 {index} 条记录 {row.get('hash')!r}，独立重算 {recomputed!r}"
                )
        previous_hash = row.get("hash") or ""
    return problems


def check_verify_function(dsn: str) -> tuple[list[str], str]:
    raw, error = psql_text(
        dsn,
        "select coalesce(json_agg(v), '[]'::json)::text from audit.verify_entitlement_chain() v",
    )
    if error:
        return [], error
    try:
        items = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:
        return [], f"verify_entitlement_chain 输出不可解析：{exc}"
    return [
        f"verify_entitlement_chain：event_id={item.get('event_id')} "
        f"occurred_at={item.get('occurred_at')} problem={item.get('problem')}"
        for item in items
    ], ""


def check_append_only_triggers(dsn: str) -> list[str]:
    raw, error = psql_text(
        dsn,
        "select coalesce(json_agg(tgname), '[]'::json)::text from pg_trigger "
        f"where tgrelid = '{TABLE}'::regclass and not tgisinternal",
    )
    if error:
        return [error]
    try:
        triggers = set(json.loads(raw or "[]"))
    except json.JSONDecodeError:
        triggers = set()
    expected = {
        "entitlement_events_chain_bi",
        "entitlement_events_no_update_bu",
        "entitlement_events_no_delete_bd",
    }
    return [f"缺少触发器 {name}（append-only/链完整性未生效）" for name in sorted(expected - triggers)]


def check_event(row: dict, index: int, event_types: set[str], reasons: set[str]) -> list[str]:
    problems: list[str] = []
    event_type = row.get("event_type")
    if not row.get("event_id"):
        problems.append(f"第 {index} 条缺少 event_id")
    if not row.get("event_key"):
        problems.append(f"第 {index} 条缺少 event_key")
    occurred_at = row.get("occurred_at") or ""
    if not ISO_UTC_RE.match(occurred_at):
        problems.append(f"第 {index} 条 occurred_at 不是 UTC ISO-8601：{occurred_at!r}")
    if event_type not in event_types:
        problems.append(f"第 {index} 条 event_type={event_type!r} 不在 DDL 允许集合")
    reason = row.get("reason")
    if reason is not None and reason not in reasons:
        problems.append(f"第 {index} 条 reason={reason!r} 不在 DDL 允许并集（未知值 fail-closed）")

    # 回指口径（H4 m01638 裁定，非放宽）：
    # - clause_locator 只对 clause_review 必填（hold_clear 的 doc_sha 是解 hold 的工单/审批文件哈希，
    #   不是授权条款定位，两者不是一回事；运行期 clear_hold(ticket,signer,doc_sha) 没有 locator 参数）；
    # - hold_clear 必填 hold_ticket + hold_signer + authorization_doc_sha256；
    # - 反向：任何事件带 clause_locator 就必须同时有 authorization_doc_sha256。
    # 注意：authorization_doc_id 不在 H4 m00245 必填集（A5 m01507 确认），不得当必填。
    if event_type in {"hold_clear", "clause_review"} and not row.get("authorization_doc_sha256"):
        problems.append(f"第 {index} 条 {event_type} 缺少 authorization_doc_sha256（无法回指依据文件）")
    if row.get("clause_locator") and not row.get("authorization_doc_sha256"):
        problems.append(f"第 {index} 条 {event_type} 有 clause_locator 却缺 authorization_doc_sha256（定位无所指）")
    sha = row.get("authorization_doc_sha256")
    if sha and not re.fullmatch(r"[0-9a-f]{64}", sha):
        problems.append(f"第 {index} 条 authorization_doc_sha256 不是 64 位小写 hex：{sha!r}")

    # 与 DDL 的 CHECK 约束逐条对应（字段按类型必填，不要求每行都有）。
    if event_type == "deploy":
        for field in ("deployment_uid", "approval_ref", "executor", "approver"):
            if not row.get(field):
                problems.append(f"第 {index} 条 deploy 缺少 {field}")
    elif event_type == "tier_switch":
        for field in ("deployment_uid", "approval_ref"):
            if not row.get(field):
                problems.append(f"第 {index} 条 tier_switch 缺少 {field}")
    elif event_type == "tier_state_observed":
        for field in ("boot_id", "effective_tier"):
            if not row.get(field):
                problems.append(f"第 {index} 条 tier_state_observed 缺少 {field}")
        if row.get("state_version") is None:
            problems.append(f"第 {index} 条 tier_state_observed 缺少 state_version")
    elif event_type == "entitlement_flip":
        for field in ("boot_id",):
            if not row.get(field):
                problems.append(f"第 {index} 条 entitlement_flip 缺少 {field}")
        if row.get("state_version") is None:
            problems.append(f"第 {index} 条 entitlement_flip 缺少 state_version")
    elif event_type == "unauthorized_config":
        for field in ("boot_id", "config_fingerprint"):
            if not row.get(field):
                problems.append(f"第 {index} 条 unauthorized_config 缺少 {field}")
    elif event_type == "entitlement_expired":
        if not (row.get("configured_tier") or row.get("effective_tier")):
            problems.append(f"第 {index} 条 entitlement_expired 缺少 configured_tier/effective_tier")
        for field in ("expires_at", "reason"):
            if not row.get(field):
                problems.append(f"第 {index} 条 entitlement_expired 缺少 {field}")
    elif event_type == "hold_set":
        if not row.get("hold_id"):
            problems.append(f"第 {index} 条 hold_set 缺少 hold_id")
    elif event_type == "hold_clear":
        if not row.get("hold_id"):
            problems.append(f"第 {index} 条 hold_clear 缺少 hold_id")
        if not (row.get("hold_ticket") or "").strip():
            problems.append(f"第 {index} 条 hold_clear 缺少 hold_ticket（工单号）")
        if not (row.get("hold_signer") or "").strip():
            problems.append(f"第 {index} 条 hold_clear 缺少 hold_signer（签字人）")
        if not row.get("authorization_doc_sha256"):
            problems.append(f"第 {index} 条 hold_clear 缺少依据文件哈希")
    elif event_type == "audit_gap":
        # A5 002 + L70：payload 键 window_start/window_end；gap_from/gap_to 已作废。
        for field in ("deployment_uid", "operator"):
            if not (row.get(field) or "").strip():
                problems.append(f"第 {index} 条 audit_gap 缺少 {field}")
        if row.get("reason") is not None:
            problems.append(f"第 {index} 条 audit_gap 的 reason 列必须为 NULL，实为 {row.get('reason')!r}")
        new_value = row.get("new_value") or {}
        if isinstance(new_value, str):
            try:
                new_value = json.loads(new_value)
            except json.JSONDecodeError:
                problems.append(f"第 {index} 条 audit_gap 的 new_value 不是合法 JSON")
                new_value = {}
        # H4 m02212：audit_gap payload 键恰好 5 个（exact-key；DDL 不拒额外键，由本层兜住）。
        if isinstance(new_value, dict):
            extra = sorted(set(new_value) - set(GAP_REQUIRED_KEYS))
            if extra:
                problems.append(
                    f"第 {index} 条 audit_gap 的 new_value 多写了键 {extra}（H4 m02212 exact-key：只允许 "
                    f"{list(GAP_REQUIRED_KEYS)}；A3 侧应删除 deployment_uid/operator 等冗余键）"
                )
        for key in GAP_REQUIRED_KEYS:
            if key not in new_value:
                problems.append(f"第 {index} 条 audit_gap 缺少 new_value.{key}")
        if "gap_from" in new_value or "gap_to" in new_value:
            problems.append(f"第 {index} 条 audit_gap 使用了作废键 gap_from/gap_to（L70）")
        window_start = str(new_value.get("window_start", ""))
        event_key = str(row.get("event_key") or "")
        if window_start and not event_key.startswith(f"gap|{row.get('deployment_uid')}|{window_start}"):
            problems.append(
                f"第 {index} 条 audit_gap event_key 未绑定 gap|<deployment_uid>|<window_start>：{event_key!r}"
            )
    elif event_type == "clause_review":
        # H4 m01334：reason ∈ {clause_change, manual_signoff}，带 operator + new_value.verdict。
        if reason not in {"clause_change", "manual_signoff"}:
            problems.append(f"第 {index} 条 clause_review 的 reason 必须为 clause_change/manual_signoff，实为 {reason!r}")
        if not row.get("operator"):
            problems.append(f"第 {index} 条 clause_review 缺少 operator")
        new_value = row.get("new_value")
        verdict = None
        if isinstance(new_value, str):
            try:
                verdict = json.loads(new_value).get("verdict")
            except (json.JSONDecodeError, AttributeError):
                verdict = None
        if verdict not in {"allow", "deny", "pending"}:
            problems.append(f"第 {index} 条 clause_review 的 new_value.verdict 不在 {{allow,deny,pending}}")

    # event_key 幂等键格式（DB 触发器权威生成，这里防应用绕过）。
    expected_prefix = {
        "tier_state_observed": ("obs|", None),
        "entitlement_flip": ("flip|", "|"),
        "unauthorized_config": ("unauth|", "|"),
        "entitlement_expired": ("exp|", "|"),
        "deploy": ("deploy|", None),
        "tier_switch": ("switch|", None),
        "hold_set": ("hold|", None),
        "hold_clear": ("hold|", None),
        # A5 m01507：clause|<doc_sha256>|<clause_locator>|<occurred_at UTC 日期>
        "clause_review": ("clause|", "|"),
    }.get(event_type or "")
    if expected_prefix:
        prefix, separator = expected_prefix
        key = str(row.get("event_key", ""))
        if not key.startswith(prefix) or (separator is not None and key.count(separator) < 2):
            problems.append(
                f"第 {index} 条 event_key={key!r} 与类型 {event_type} 的幂等键格式不符"
            )
    return problems


def main() -> int:
    dsn = os.environ.get("A11_AUDIT_DSN") or os.environ.get("DATABASE_URL", "")
    if not dsn:
        sys.stderr.write("[FAIL] 缺少 A11_AUDIT_DSN / DATABASE_URL（验收脚本不 skip）\n")
        return 2

    event_types, reasons, ddl_error = parse_ddl_sets()
    blocked: list[str] = []
    if ddl_error:
        blocked.append(ddl_error)
    # 双源一致性：DDL 的 CHECK 集合必须等于已批准清单，多一个/少一个都红（不自洽就是错）。
    if not ddl_error:
        if event_types != APPROVED_EVENT_TYPES:
            blocked.append(
                "DDL event_type 与已批准清单不一致（lead L49 / H4 m01334）："
                f"缺 {sorted(APPROVED_EVENT_TYPES - event_types)}，多 {sorted(event_types - APPROVED_EVENT_TYPES)}"
            )
        if reasons != APPROVED_REASONS:
            blocked.append(
                "DDL reason 与已批准 6 值不一致（lead L49）："
                f"缺 {sorted(APPROVED_REASONS - reasons)}，多 {sorted(reasons - APPROVED_REASONS)}；"
                "reason 为单列枚举，无 cause/internal_code 列"
            )

    columns, columns_error = table_columns(dsn)
    if columns_error:
        print(f"[BLOCKED] 11-12/第6条 审计事件\n  - {columns_error}")
        return 1
    if not columns:
        print(f"[BLOCKED] 11-12/第6条 审计事件\n  - 表 {TABLE} 不存在（A13 迁移未执行）")
        return 1

    rows, error = load_events(dsn)
    if error:
        print(f"[BLOCKED] 11-12/第6条 审计事件\n  - {error}")
        return 1

    # clause_review 是否可写入取决于 DDL（H4 m01474：snapshot_sha256 不进审计表，属 manifest 侧）。
    if "clause_review" not in event_types:
        blocked.append(
            "DDL 的 event_type CHECK 不含 clause_review（H4 m01334/m01474 要求第 9 类；owner A5）"
        )

    problems: list[str] = []
    if not rows:
        blocked.append(f"{TABLE} 为空：需要 A13 seed + A3 写入（禁止造假事件）")

    actual_types = {row.get("event_type") for row in rows}
    for event_type in REQUIRED_EVENT_TYPES:
        if event_type not in actual_types and event_type in event_types:
            problems.append(f"#6 抽样缺少事件类型：{event_type}")

    event_keys: dict[str, int] = {}
    event_ids: dict[str, int] = {}
    for index, row in enumerate(rows, start=1):
        problems.extend(check_event(row, index, APPROVED_EVENT_TYPES, APPROVED_REASONS))
        key = str(row.get("event_key") or "")
        if key:
            event_keys[key] = event_keys.get(key, 0) + 1
        event_id = str(row.get("event_id") or "")
        if event_id:
            event_ids[event_id] = event_ids.get(event_id, 0) + 1

    duplicates = [key for key, count in event_keys.items() if count > 1]
    if duplicates:
        problems.append(f"event_key 不唯一（多副本重复写入）：{duplicates[:5]}")
    duplicate_ids = [key for key, count in event_ids.items() if count > 1]
    if duplicate_ids:
        problems.append(f"event_id 重复：{duplicate_ids[:5]}")

    problems.extend(check_chain_rows(rows))
    verify_problems, verify_error = check_verify_function(dsn)
    if verify_error:
        blocked.append(verify_error)
    problems.extend(verify_problems)
    problems.extend(check_append_only_triggers(dsn))

    # 双源校验结果显式打印（DDL 是实现，L49 是批准口径；不一致时上面的 blocked 会红）。
    print(
        f"[INFO] 双源校验：DDL event_type={sorted(event_types)}；DDL reason={sorted(reasons)}；"
        f"批准 event_type={sorted(APPROVED_EVENT_TYPES)}；批准 reason={sorted(APPROVED_REASONS)}"
    )
    if blocked and not problems:
        print(f"[BLOCKED] 11-12/第6条 审计事件（{len(rows)} 条）")
        for item in blocked:
            print(f"  - {item}")
        return 1
    verdict = "PASS" if not problems and not blocked else "FAIL"
    print(
        f"[{verdict}] 11-12/第6条 审计事件（{len(rows)} 条，类型 {sorted(t for t in actual_types if t)}）"
    )
    for item in problems + blocked:
        print(f"  - {item}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
