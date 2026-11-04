"""L76 开关三分门禁：拒启 / 权威但不可关 / 与判定无关，不允许第四类。

为什么需要机械校验：开关分类只写在文档里会漂移。新增一个 env 读取点却没人分类，
或者把「拒启」偷偷降成「与判定无关」，都等于门禁被悄悄放宽。这个测试扫实现里
真实读取的 env 名，要求每一个都在 ledger 里且只属于一类；拒启项必须在代码里
找到 prod 守卫证据。
"""
from __future__ import annotations

import pathlib
import re

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
LEDGER = pathlib.Path(__file__).resolve().parent / "env_switches.yaml"

READ_PATTERNS = (
    re.compile(r"\bprocess\.env\.([A-Z][A-Z0-9_]*)"),
    re.compile(r"\benv\.([A-Z][A-Z0-9_]*)"),
    re.compile(r"\bprocess\.env\[['\"]([A-Z][A-Z0-9_]+)['\"]\]"),
    re.compile(r"\breadEnv\(['\"]([A-Z][A-Z0-9_]+)['\"]"),
    re.compile(r"\benv\(['\"]([A-Z][A-Z0-9_]+)['\"]"),
)
CLASSES = ("hard_deny_prevent_startup", "authoritative_not_disable", "unrelated_to_decision")


def load_ledger() -> dict:
    with LEDGER.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise AssertionError("env_switches.yaml 解析为空/非映射")
    return data


def _names(entries: list) -> list[str]:
    out = []
    for entry in entries or []:
        if isinstance(entry, str):
            out.append(entry)
        else:
            out.append(entry["name"])
    return out


def env_names_read_in_sources(ledger: dict) -> set[str]:
    names: set[str] = set()
    for rel in ledger["scan_targets"]:
        path = ROOT / rel
        assert path.is_file(), f"扫描目标不存在: {rel}"
        text = path.read_text(encoding="utf-8")
        for pattern in READ_PATTERNS:
            names.update(pattern.findall(text))
    return names


def test_every_read_env_is_classified_exactly_once() -> None:
    ledger = load_ledger()
    classified: dict[str, str] = {}
    for cls in CLASSES:
        for name in _names(ledger[cls]):
            assert name not in classified, f"{name} 同时被归入 {classified[name]} 与 {cls}（不允许双重分类）"
            classified[name] = cls
    scanned = env_names_read_in_sources(ledger)
    assert scanned, "扫描目标里没解析到任何 env，L76 门禁空转"
    unclassified = sorted(scanned - set(classified))
    assert not unclassified, (
        "实现读取了未分类的环境变量（L76 不允许第四类）: " + ", ".join(unclassified)
    )


def test_hard_deny_switches_have_prod_guard_evidence() -> None:
    ledger = load_ledger()
    config = (ROOT / ledger["sources"]["market_config"]).read_text(encoding="utf-8")
    for name in _names(ledger["hard_deny_prevent_startup"]):
        assert name in config, f"拒启项 {name} 在 {ledger['sources']['market_config']} 中无守卫证据"


def test_authoritative_switches_are_not_documented_as_disable() -> None:
    """权威项可以改值，但不能被写成「关闭门禁」；描述里出现关闭语义即红。"""
    ledger = load_ledger()
    banned = ("关闭门禁", "关掉门禁", "放行", "跳过判定", "bypass gate")
    for entry in ledger["authoritative_not_disable"]:
        name = entry["name"] if isinstance(entry, dict) else entry
        reason = entry.get("reason", "") if isinstance(entry, dict) else ""
        assert not any(word in reason for word in banned), f"权威项 {name} 被描述成可关闭判定: {reason}"


def test_ledger_has_no_fourth_class() -> None:
    ledger = load_ledger()
    assert set(ledger) >= set(CLASSES)
    # 只允许三类 + 元数据键；出现别的列表键即视为第四类
    meta_keys = {"scan_targets", "sources"}
    unknown = {
        key
        for key, value in ledger.items()
        if isinstance(value, list) and key not in CLASSES and key not in meta_keys
    }
    assert not unknown, f"出现第四类分类: {sorted(unknown)}"
    assert set(ledger["scan_targets"]) and set(ledger["sources"]), "扫描面/来源声明不能为空"
