"""契约 diff 门禁驱动层（A11 owns: tests/contract/）。

职责：把 oasdiff 的 breaking 判定接进 pytest，并把「破坏性变更必须声明 + H2 签字」落成可执行规则。

门禁语义（对应 ADR-001 D5/D6）：
- baseline 是 tests/contract/baselines/v1/ 的冻结快照；当前 contracts/ 相对它的 breaking 变更必须为空；
- 破坏性变更有两种合法出路：回退；或在 waivers.yaml 里登记（含 ADR 编号、理由、H2 签字、到期日）；
- waiver 过期 / 失效 / 未签字 = 红灯，防止「先登记后遗忘」变成永久豁免。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable

import yaml

HERE = Path(__file__).resolve().parent
BASELINES_DIR = HERE / "baselines"
WAIVERS_PATH = HERE / "waivers.yaml"
PINNED_OASDIFF_VERSION = "1.35.0"
# H2 L45：oasdiff 1.35.0 自带 `response-optional-property-removed` 等检查，但默认 severity=info，
# 所以 `--fail-on ERR` 看不见。severity 配置由 A0 写、H2 审（行式文本，YAML 会被 oasdiff 拒）。
SEVERITY_PATH = HERE.parents[1] / "contracts" / "oasdiff-severity.txt"
BINARY_CANDIDATES = ("oasdiff", "/opt/homebrew/bin/oasdiff", "/usr/local/bin/oasdiff")


class GateError(Exception):
    """门禁自身不可用（二进制缺失/版本漂移/waiver 文件不合法）：红灯，不是跳过。"""


@dataclass(frozen=True)
class Finding:
    id: str
    level: int
    operation: str
    operation_id: str
    path: str
    text: str
    fingerprint: str

    @property
    def severity(self) -> str:
        return {3: "ERR", 2: "WARN", 1: "INFO"}.get(self.level, f"L{self.level}")

    @property
    def key(self) -> str:
        return f"{self.id} @ {self.operation} {self.path} ({self.operation_id})"


@dataclass(frozen=True)
class Waiver:
    id: str
    finding: str
    operation_id: str | None
    fingerprint: str | None
    reason: str
    adr: str
    approved_by: str
    expires_at: date

    def covers(self, finding: Finding) -> bool:
        if self.fingerprint and self.fingerprint != finding.fingerprint:
            return False
        if self.finding != finding.id:
            return False
        return self.operation_id is None or self.operation_id == finding.operation_id


def oasdiff_binary() -> str:
    for candidate in BINARY_CANDIDATES:
        resolved = shutil.which(candidate) if "/" not in candidate else (candidate if Path(candidate).exists() else None)
        if resolved:
            return resolved
    raise GateError(
        "找不到 oasdiff（契约 diff 门禁必需）。CI 镜像按 A13 的 workflow 安装 oasdiff "
        f"{PINNED_OASDIFF_VERSION}；本地可用 brew install oasdiff。门禁不允许跳过。"
    )


def oasdiff_version(binary: str | None = None) -> str:
    binary = binary or oasdiff_binary()
    completed = subprocess.run([binary, "--version"], capture_output=True, text=True)
    if completed.returncode != 0:
        raise GateError(f"oasdiff --version 失败: {completed.stderr.strip()}")
    return completed.stdout.strip()


def assert_pinned_toolchain(binary: str | None = None) -> None:
    version = oasdiff_version(binary)
    if PINNED_OASDIFF_VERSION not in version:
        raise GateError(
            f"oasdiff 版本漂移: 期望 {PINNED_OASDIFF_VERSION}，实际 {version!r}。"
            "工具链版本属 H2 冻结清单（ADR-001 D8），升级须走变更声明。"
        )


def baseline_path(domain: str) -> Path:
    return BASELINES_DIR / "v1" / domain / "openapi.yaml"


def current_path(domain: str, contracts_dir: Path) -> Path:
    return Path(contracts_dir) / domain / "openapi.yaml"


def severity_levels_file() -> Path:
    """severity 配置缺失 = 门禁不可用（红灯），不是「没有破坏性变更」。"""
    if not SEVERITY_PATH.exists():
        raise GateError(
            f"缺少 oasdiff severity 配置: {SEVERITY_PATH}。"
            "H2 L45 要求把 response-optional-property-removed / "
            "response-optional-write-only-property-removed 提升为 err；文件由 A0 写、H2 审（行式文本）。"
        )
    return SEVERITY_PATH


def run_breaking(
    base: Path,
    current: Path,
    binary: str | None = None,
    severity_path: Path | None = None,
) -> tuple[int, str, str]:
    """返回 (退出码, stdout, stderr)。退出码 1 表示检出 breaking，属门禁要拦的情况。"""
    binary = binary or oasdiff_binary()
    severity = Path(severity_path) if severity_path is not None else severity_levels_file()
    cmd = [
        binary,
        "breaking",
        str(base),
        str(current),
        "--fail-on",
        "ERR",
        "--severity-levels",
        str(severity),
        "-f",
        "json",
    ]
    completed = subprocess.run(cmd, capture_output=True, text=True)
    return completed.returncode, completed.stdout, completed.stderr


def parse_findings(stdout: str) -> list[Finding]:
    """oasdiff -f json：数组；无变更时为 []；个别版本无变更时输出文本，这里统一按空处理。"""
    text = stdout.strip()
    if not text or text.lower().startswith("no changes"):
        return []
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GateError(f"无法解析 oasdiff JSON 输出: {text[:500]!r}") from exc
    if not isinstance(payload, list):
        raise GateError(f"oasdiff JSON 顶层应为数组，实际 {type(payload).__name__}")
    findings = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        findings.append(
            Finding(
                id=str(item.get("id", "")),
                level=int(item.get("level", 0)),
                operation=str(item.get("operation", "")),
                operation_id=str(item.get("operationId", "")),
                path=str(item.get("path", "")),
                text=str(item.get("text", "")),
                fingerprint=str(item.get("fingerprint", "")),
            )
        )
    return findings


def load_manifest(baselines_dir: Path = BASELINES_DIR) -> dict[str, Any]:
    path = Path(baselines_dir) / "v1" / "baseline_manifest.json"
    if not path.exists():
        raise GateError(f"baseline manifest 缺失: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise GateError(f"baseline manifest 解析失败: {exc}") from exc


def load_waivers(path: Path = WAIVERS_PATH) -> list[Waiver]:
    if not path.exists():
        return []
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise GateError(f"waivers 解析失败: {path}: {exc}") from exc
    entries = doc.get("waivers") or []
    if not isinstance(entries, list):
        raise GateError(f"{path}: waivers 必须是列表")
    waivers: list[Waiver] = []
    required = ("id", "finding", "reason", "adr", "approved_by", "expires_at")
    for raw in entries:
        if not isinstance(raw, dict):
            raise GateError(f"{path}: waiver 条目必须是 object: {raw!r}")
        missing = [key for key in required if not raw.get(key)]
        if missing:
            raise GateError(f"{path}: waiver 缺字段 {missing}: {raw!r}")
        if not str(raw["approved_by"]).startswith("H2"):
            raise GateError(
                f"{raw['id']}: 破坏性变更豁免必须由 H2 签字（ADR-001 D5），实际 approved_by={raw['approved_by']!r}"
            )
        try:
            expires_at = date.fromisoformat(str(raw["expires_at"]))
        except ValueError as exc:
            raise GateError(f"{raw['id']}: expires_at 不是合法日期") from exc
        if expires_at < date.today():
            raise GateError(f"{raw['id']}: waiver 已过期（{expires_at}），请回退变更或重新走审批")
        waivers.append(
            Waiver(
                id=str(raw["id"]),
                finding=str(raw["finding"]),
                operation_id=raw.get("operation_id"),
                fingerprint=raw.get("fingerprint"),
                reason=str(raw["reason"]),
                adr=str(raw["adr"]),
                approved_by=str(raw["approved_by"]),
                expires_at=expires_at,
            )
        )
    ids = [waiver.id for waiver in waivers]
    if len(ids) != len(set(ids)):
        raise GateError(f"{path}: waiver id 重复: {ids}")
    return waivers


def classify(
    findings: Iterable[Finding], waivers: Iterable[Waiver]
) -> tuple[list[Finding], list[Finding], list[Finding], list[Waiver]]:
    """返回 (breaking 已声明, breaking 未声明, 非破坏性观察项, 失效 waiver)。"""
    waivers = list(waivers)
    breaking = [f for f in findings if f.severity == "ERR"]
    advisory = [f for f in findings if f.severity != "ERR"]
    waived: list[Finding] = []
    unwaived: list[Finding] = []
    for finding in breaking:
        if any(waiver.covers(finding) for waiver in waivers):
            waived.append(finding)
        else:
            unwaived.append(finding)
    stale = [w for w in waivers if not any(w.covers(f) for f in breaking)]
    return waived, unwaived, advisory, stale
