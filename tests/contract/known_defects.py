"""已知契约缺陷台账（A11 owns: tests/contract/known_defects.yaml）。

这不是「豁免开关」，而是带责任人 + 到期日的缺陷登记：契约里发现的问题若不能由 A11 修
（contracts/ 归 A0），就登记在此并从当天起计 14 天内必须修复；到期自动红灯。
条目一旦不再命中任何问题（已修好但 A0 无权删本文件里的条目）降为告警，由 A11 在下一个 PR
清理；但到期日仍是硬线（过期即红灯），防止台账长期驻留变成永久豁免。

判定规则的三态：
- 未登记问题 -> 红灯（门禁正常工作）；
- 已登记且未过期 -> 绿灯 + 债务告警（pytest warning，进质量报告）；
- 已过期 / 台账格式不合法 -> 红灯；
- 条目失效（缺陷已修复）-> 告警 + 待 A11 清理；到期后仍驻留则红灯。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Iterable

import yaml

LEDGER_PATH = Path(__file__).resolve().parent / "known_defects.yaml"
MAX_TTL_DAYS = 14


class LedgerError(Exception):
    """台账本身不合法（等同于门禁故障，必须红灯）。"""


@dataclass(frozen=True)
class KnownDefect:
    id: str
    rule: str
    matches: tuple[str, ...]
    owner: str
    reported: date
    expires_at: date
    reason: str
    fix: str

    def covers(self, problem: str) -> bool:
        return any(marker in problem for marker in self.matches)

    @property
    def days_left(self) -> int:
        return (self.expires_at - date.today()).days


def _as_date(value, field: str, entry_id: str) -> date:
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        raise LedgerError(f"{entry_id}: {field} 必须是 YYYY-MM-DD 字符串")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise LedgerError(f"{entry_id}: {field} 不是合法日期: {value!r}") from exc


def load_ledger(path: Path = LEDGER_PATH) -> list[KnownDefect]:
    """加载并做完整性校验；任何格式问题都抛 LedgerError（= 红灯）。"""
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as fh:
        doc = yaml.safe_load(fh) or {}
    if not isinstance(doc, dict) or not isinstance(doc.get("entries", []), list):
        raise LedgerError(f"{path}: 顶层必须是 {{entries: [...]}}")
    entries: list[KnownDefect] = []
    seen_ids: set[str] = set()
    required = ("id", "rule", "matches", "owner", "reported", "expires_at", "reason", "fix")
    for raw in doc.get("entries") or []:
        if not isinstance(raw, dict):
            raise LedgerError(f"{path}: 条目必须是 object: {raw!r}")
        missing = [key for key in required if not raw.get(key)]
        if missing:
            raise LedgerError(f"{path}: 条目缺字段 {missing}: {raw!r}")
        entry_id = str(raw["id"])
        if entry_id in seen_ids:
            raise LedgerError(f"{path}: 缺陷编号重复: {entry_id}")
        seen_ids.add(entry_id)
        matches = raw["matches"]
        if not isinstance(matches, list) or not all(isinstance(m, str) and m for m in matches):
            raise LedgerError(f"{entry_id}: matches 必须是字符串列表")
        reported = _as_date(raw["reported"], "reported", entry_id)
        expires_at = _as_date(raw["expires_at"], "expires_at", entry_id)
        if expires_at <= reported:
            raise LedgerError(f"{entry_id}: expires_at 必须晚于 reported")
        if (expires_at - reported).days > MAX_TTL_DAYS:
            raise LedgerError(
                f"{entry_id}: 修复窗口 {expires_at - reported} 天超过上限 {MAX_TTL_DAYS} 天；"
                "缺陷不能无限期登记"
            )
        if expires_at < date.today():
            raise LedgerError(
                f"{entry_id}: 已过期（expires_at={expires_at}），门禁自动红灯：请修复契约后删除条目"
            )
        entries.append(
            KnownDefect(
                id=entry_id,
                rule=str(raw["rule"]),
                matches=tuple(matches),
                owner=str(raw["owner"]),
                reported=reported,
                expires_at=expires_at,
                reason=str(raw["reason"]),
                fix=str(raw["fix"]),
            )
        )
    return entries


def split_known(
    rule: str,
    problems: Iterable[str],
    ledger: Iterable[KnownDefect] | None = None,
) -> tuple[list[str], list[str], list[KnownDefect]]:
    """把问题分成 (已登记债务, 未登记红灯)；同时报告失效条目。"""
    entries = [e for e in (ledger if ledger is not None else load_ledger()) if e.rule == rule]
    problems = list(problems)
    known: list[str] = []
    unknown: list[str] = []
    for problem in problems:
        hit = next((e for e in entries if e.covers(problem)), None)
        if hit is None:
            unknown.append(problem)
        else:
            known.append(f"[{hit.id} 到期 {hit.expires_at}] {problem}")
    stale = [e for e in entries if not any(e.covers(p) for p in problems)]
    return known, unknown, stale
