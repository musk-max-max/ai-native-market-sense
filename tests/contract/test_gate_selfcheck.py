"""门禁自检：证明「改坏契约 -> 自动红灯」而不是靠人看。

task-4 验收要求：故意改契约字段必须让 diff 门禁红灯。本文件把这句验收变成可重复执行的测试：
1) 干净契约 + lint：绿（证明确实是变异导致红灯，而不是门禁恒红）；
2) 注入 lint 违规（camelCase 字段）：lint 子进程退出码 != 0；
3) 注入破坏性变更（字段类型收窄）：oasdiff breaking 出现 ERR；
4) 注入非破坏性变更（新增可选字段）：oasdiff 不报 ERR（防误报，门禁误报率 KPI）。

所有变异都在 pytest tmp 目录进行，绝不改写 contracts/ 真源（A0 唯一写者）。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

from contract_diff_lib import (
    BASELINES_DIR,
    assert_pinned_toolchain,
    baseline_path,
    oasdiff_binary,
    parse_findings,
    run_breaking,
)
from openapi_lib import REPO_ROOT

CLEAN_LINT_TIMEOUT = 180


def copy_contracts(tmp_path: Path) -> Path:
    target = tmp_path / "contracts"
    shutil.copytree(REPO_ROOT / "contracts", target)
    return target


def read_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def write_yaml(path: Path, doc: dict) -> None:
    path.write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True), encoding="utf-8")


def run_lint_subprocess(contracts_dir: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, A11_CONTRACTS_DIR=str(contracts_dir))
    return subprocess.run(
        [sys.executable, "-m", "pytest", "tests/contract/test_contract_lint.py", "-q", "-p", "no:cacheprovider"],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=CLEAN_LINT_TIMEOUT,
    )


def failed_test_ids(output: str) -> list[str]:
    ids = []
    for line in output.splitlines():
        if line.startswith("FAILED "):
            ids.append(line.split()[1])
    return ids


def mutate_quote(contracts_dir: Path, mutator) -> Path:
    path = contracts_dir / "market" / "openapi.yaml"
    doc = read_yaml(path)
    mutator(doc["components"]["schemas"]["Quote"])
    write_yaml(path, doc)
    return contracts_dir / "market" / "openapi.yaml"


def test_clean_contracts_pass_lint(tmp_path):
    """对照组：未变异时 lint 必须绿。若这里红，说明门禁本身坏了，后续红灯不可信。"""
    result = run_lint_subprocess(copy_contracts(tmp_path))
    assert result.returncode == 0, (
        "干净契约的 lint 竟然红灯 —— 门禁自身不可信:\n" + result.stdout[-4000:] + result.stderr[-2000:]
    )


def test_injected_lint_violation_turns_red(tmp_path):
    """注入 camelCase 字段名（违反 ADR-001 D3 snake_case）-> schema 命名门禁红灯。"""
    contracts_dir = copy_contracts(tmp_path)
    mutate_quote(contracts_dir, lambda quote: quote["properties"].__setitem__("badFieldName", {"type": "string"}))
    result = run_lint_subprocess(contracts_dir)
    assert result.returncode != 0, (
        "注入 camelCase 字段后 lint 仍然绿 —— 契约结构门禁没有生效（ADR-001 D3）:\n" + result.stdout[-4000:]
    )
    assert any("test_schema_field_naming" in test_id for test_id in failed_test_ids(result.stdout)), (
        "红灯了但不是 snake_case 规则触发的，门禁归因错误:\n" + result.stdout[-4000:]
    )


def test_inlined_conflict_problem_field_turns_red(tmp_path):
    """负样本（H2 P2）：把 ConfigConflictProblem.type 从 shared $ref 改成内联复制 -> 单一真源门禁红灯。"""
    contracts_dir = copy_contracts(tmp_path)
    path = contracts_dir / "config" / "openapi.yaml"
    doc = read_yaml(path)
    doc["components"]["schemas"]["ConfigConflictProblem"]["properties"]["type"] = {"type": "string", "minLength": 1}
    write_yaml(path, doc)
    result = run_lint_subprocess(contracts_dir)
    assert result.returncode != 0, (
        "内联复制 Problem.type 后 lint 仍然绿 —— 冲突体单一真源门禁没有生效（H2 P2）:\n" + result.stdout[-4000:]
    )
    assert any(
        "test_conflict_problem_fields_reference_shared_problem" in test_id for test_id in failed_test_ids(result.stdout)
    ), "红灯了但不是冲突体单一真源规则触发的，门禁归因错误:\n" + result.stdout[-4000:]


def test_injected_breaking_change_turns_red(tmp_path):
    """把 Quote.volume 从 integer 改成 string（破坏性：消费方按整数解析）-> oasdiff ERR。"""
    contracts_dir = copy_contracts(tmp_path)
    current = mutate_quote(contracts_dir, lambda quote: quote["properties"]["volume"].__setitem__("type", "string"))
    binary = oasdiff_binary()
    assert_pinned_toolchain(binary)
    code, stdout, stderr = run_breaking(baseline_path("market"), current, binary)
    findings = parse_findings(stdout)
    errors = [finding for finding in findings if finding.level == 3]
    assert code == 1, f"破坏性变更未触发非零退出（exit={code}）:\n{stdout[-3000:]}\n{stderr[-1000:]}"
    assert errors, "oasdiff 退出码非零但没有 ERR 级发现项，无法归因:\n" + stdout[-3000:]
    assert any("volume" in (finding.text or finding.id) for finding in errors) or any(
        finding.operation_id for finding in errors
    ), "ERR 未指向被改字段:\n" + json.dumps([f.__dict__ for f in errors], ensure_ascii=False)


def test_injected_optional_field_is_not_breaking(tmp_path):
    """新增可选字段是非破坏性变更（ADR-001 D5 允许）-> 不得 ERROR，否则门禁误报。

    基线用「当前契约的干净副本」而不是冻结 baseline：冻结基线里还有已声明的
    lot_size 删除（waiver 覆盖），混进来会让本测试测不到「新增可选字段」这件事。
    """
    contracts_dir = copy_contracts(tmp_path)
    current = mutate_quote(
        contracts_dir,
        lambda quote: quote["properties"].__setitem__("analyst_note", {"type": ["string", "null"]}),
    )
    clean_base = copy_contracts(tmp_path / "base")
    binary = oasdiff_binary()
    assert_pinned_toolchain(binary)
    code, stdout, stderr = run_breaking(clean_base / "market" / "openapi.yaml", current, binary)
    errors = [finding for finding in parse_findings(stdout) if finding.level == 3]
    assert not errors, (
        "新增可选字段被误判为破坏性变更（门禁误报，KPI 门禁误报率不合格）:\n"
        + json.dumps([f.__dict__ for f in errors], ensure_ascii=False)
    )
    assert code in (0, 1), f"oasdiff 异常退出 exit={code}:\n{stderr[-1000:]}"


def test_optional_request_property_removal_is_not_escalated(tmp_path):
    """负样本（lead L45 ②）：删 optional **request** property 必须不红。

    没有这条，severity 配置哪天被人写宽（例如加一行 `.* err`）也没人发现。
    """
    base_dir = copy_contracts(tmp_path / "base")
    mutant_dir = copy_contracts(tmp_path / "mutant")
    for directory in (base_dir, mutant_dir):
        path = directory / "watchlist" / "openapi.yaml"
        doc = read_yaml(path)
        request = doc["components"]["schemas"]["AddWatchlistItemRequest"]
        assert "note" not in request["properties"]
        request["properties"]["note"] = {"type": "string", "maxLength": 200}
        write_yaml(path, doc)
    mutant_path = mutant_dir / "watchlist" / "openapi.yaml"
    doc = read_yaml(mutant_path)
    del doc["components"]["schemas"]["AddWatchlistItemRequest"]["properties"]["note"]
    write_yaml(mutant_path, doc)

    binary = oasdiff_binary()
    assert_pinned_toolchain(binary)
    code, stdout, stderr = run_breaking(
        base_dir / "watchlist" / "openapi.yaml", mutant_path, binary
    )
    errors = [finding for finding in parse_findings(stdout) if finding.level == 3]
    assert not errors, (
        "删 optional request property 被 severity 配置抬成 ERR（配置写宽了）:\n"
        + json.dumps([f.__dict__ for f in errors], ensure_ascii=False)
    )
    assert code == 0, f"删 optional request property 不应导致门禁红灯（exit={code}）:\n{stderr[-1000:]}"
