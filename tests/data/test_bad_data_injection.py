"""门禁自证：故意注入坏数据，CI 必须红灯。

验收口径（lead 的 task-4）：
- 注入坏数据 → 数据门禁红灯，且报错能定位到具体 case；
- 未注入时同一套命令必须绿灯（证明不是「永远红」的假门禁）。

注入只发生在 pytest tmp_path 的数据包副本里，绝不改 data/golden/（A2 写域）。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from quality_lib import evaluate_case, load_pack, load_policy, pack_path_from_env

REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_TEST = "tests/data/test_golden_dataset.py"
ORIGINAL_PACK = pack_path_from_env()


def _mutated_pack(tmp_path: Path, mutate) -> Path:
    doc = yaml.safe_load(ORIGINAL_PACK.read_text(encoding="utf-8"))
    mutate(doc)
    target = tmp_path / "p0_mutated.yaml"
    target.write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return target


def _run_golden(pack_path: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["A11_GOLDEN_PACK"] = str(pack_path)
    return subprocess.run(
        [sys.executable, "-m", "pytest", GOLDEN_TEST, "-q", "-p", "no:cacheprovider"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


def _case(doc: dict, case_id: str) -> dict:
    return next(case for case in doc["cases"] if case["id"] == case_id)


def test_baseline_pack_is_green():
    """对照组：未注入时门禁必须绿，否则红灯没有证明力。"""
    result = _run_golden(ORIGINAL_PACK)
    assert result.returncode == 0, (
        f"原始 golden 包应绿而红：\nSTDOUT:\n{result.stdout[-3000:]}\nSTDERR:\n{result.stderr[-3000:]}"
    )


def test_injected_structure_defect_turns_gate_red_in_process(tmp_path):
    """结构坏数据（high < low）必须被参考实现立刻判死，且能定位到 G01。"""
    def mutate(doc):
        _case(doc, "G01")["bars"][0]["high"] = "10.20"  # low=10.25，OHLC 关系被破坏

    pack = load_pack(_mutated_pack(tmp_path, mutate))
    case = next(case for case in pack.cases if case.case_id == "G01")
    report = evaluate_case(pack, case, load_policy())
    assert "STRUCT-03" in report.rule_ids
    assert report.grade == "black" and report.blocked is True
    assert report.grade != case.expect["grade"], "注入后仍与期望一致，说明校验没生效"


def test_injected_structure_defect_turns_ci_red(tmp_path):
    def mutate(doc):
        _case(doc, "G01")["bars"][0]["high"] = "10.20"

    result = _run_golden(_mutated_pack(tmp_path, mutate))
    assert result.returncode != 0, f"注入结构坏数据后 CI 仍绿：\n{result.stdout[-2000:]}"
    assert "G01" in result.stdout, f"红灯未定位到 G01：\n{result.stdout[-3000:]}"
    assert "STRUCT-03" in result.stdout


def test_injected_business_defect_turns_ci_red(tmp_path):
    """业务坏数据（北交所 +40%，超过 30% 幅度）必须红灯。"""
    def mutate(doc):
        case = _case(doc, "G04")
        case["bars"][0]["close"] = "14.00"  # 10.00 → 14.00 = +40%
        case["bars"][0]["high"] = "14.00"

    result = _run_golden(_mutated_pack(tmp_path, mutate))
    assert result.returncode != 0, f"注入业务坏数据后 CI 仍绿：\n{result.stdout[-2000:]}"
    assert "G04" in result.stdout
    assert "BIZ-01" in result.stdout, f"未报 BIZ-01：\n{result.stdout[-3000:]}"


def test_injected_completeness_defect_turns_ci_red(tmp_path):
    """完整性坏数据（删掉一根 bar 且无停牌证据）必须红灯，不允许静默补 0（C08）。"""
    def mutate(doc):
        case = _case(doc, "G01")
        del case["bars"][1]  # 缺 2026-09-29，无 suspended 证据

    result = _run_golden(_mutated_pack(tmp_path, mutate))
    assert result.returncode != 0, f"缺 bar 未触发红灯：\n{result.stdout[-2000:]}"
    assert "COMP-03" in result.stdout, f"未报 COMP-03：\n{result.stdout[-3000:]}"


def test_golden_loader_rejects_injected_pack_without_expected_verdict(tmp_path):
    """坏数据包若把 expect 一起删掉，加载器必须直接拒绝（不允许「无期望即放过」）。"""
    def mutate(doc):
        _case(doc, "G01")["expect"] = {}

    result = _run_golden(_mutated_pack(tmp_path, mutate))
    assert result.returncode != 0
    assert "expect" in result.stdout.lower()
