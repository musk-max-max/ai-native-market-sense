"""consumer 侧门禁（真实消费方源码）：H5 的每个 /v1 调用都必须落在已声明 operation 上。

JSON 样本证明「约定调用合法」，本文件进一步证明**已经写下的页面代码**没有偷偷新增未声明
路径/方法。新增接口必须先改 contracts/（A0），否则 H5 一侧红灯——防止前端先斩后奏绕过契约。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from openapi_lib import REPO_ROOT

H5_SRC = REPO_ROOT / "web" / "h5" / "src"
CLIENT_CALL = re.compile(r"client\.(?P<method>GET|POST|PUT|PATCH|DELETE)\(\s*'(?P<path>/v1/[^']+)'")
PARAM = re.compile(r"\{[^}]+\}")


def _normalise(path: str) -> str:
    return PARAM.sub("{}", path)


def _h5_calls() -> list[tuple[str, str, Path]]:
    calls: list[tuple[str, str, Path]] = []
    for path in sorted(H5_SRC.rglob("*")):
        if path.suffix not in {".ts", ".tsx"} or path.name.endswith(".test.ts"):
            continue
        text = path.read_text(encoding="utf-8")
        for match in CLIENT_CALL.finditer(text):
            calls.append((match.group("method").lower(), match.group("path"), path))
    return calls


@pytest.fixture(scope="module")
def h5_calls():
    if not H5_SRC.is_dir():
        pytest.skip("web/h5/src 不存在：A7 尚未落地消费方源码")
    return _h5_calls()


def test_h5_actually_calls_the_api(h5_calls):
    """扫描不到调用多半说明 A7 改了写法/目录：门禁不能悄悄变成空转。"""
    assert len(h5_calls) >= 6, f"只扫到 {len(h5_calls)} 处 H5 调用，检查 CLIENT_CALL 正则与目录"


def test_every_h5_call_targets_a_declared_operation(h5_calls, repo, operations):
    by_key = {(op.method, _normalise(op.path)): op for op in operations}
    problems = []
    for method, path, source in h5_calls:
        key = (method, _normalise(path))
        if key not in by_key:
            problems.append(
                f"{source.relative_to(REPO_ROOT)}: {method.upper()} {path} 不在契约里"
                "（新增接口必须先改 contracts/，不能前端先用后补）"
            )
    assert not problems, "\n".join(problems)
