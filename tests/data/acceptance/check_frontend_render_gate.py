#!/usr/bin/env python3
"""11-12 放行验收 · 第 7 条：前端不得存在"数值渲染放开"开关（静态部分）。

lead L36 / H4 m01055：不得有前端放行 flag/env；A19 的"前端绕过 403"攻击用例必须失败。
本脚本做静态门禁（生产源码里不允许出现可切换 mock/放行渲染的 env 分支未受 DEV 保护）：

1. `web/h5/src/**` 中不得出现名称含 ALLOW/BYPASS/FORCE/UNLOCK/UNSAFE 且与行情/授权相关的 env；
2. `VITE_DATA_MODE=mock` 这类 fixture 分支必须被 `import.meta.env.DEV` 保护（生产构建不得打到 mock 数据）；
3. 前端不得从 env 读取 `ENTITLEMENT_*`（授权判定只能在服务端）。

动态"攻击必须失败"由 A19 在 e2e 侧跑；本脚本只保证没有现成开关。

用法：python3 tests/data/acceptance/check_frontend_render_gate.py
退出码：0 通过 / 1 失败（文件缺失也失败）。
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
H5_SRC = os.path.join(REPO_ROOT, "web", "h5", "src")

BYPASS_ENV = re.compile(r"(?i)(ALLOW|BYPASS|FORCE|UNLOCK|UNSAFE|SKIP)[A-Z0-9_]*(PRICE|QUOTE|RENDER|ENTITLE|MARKET|NUMERIC)")
ENTITLEMENT_ENV = re.compile(r"ENTITLEMENT_[A-Z_]+")
IMPORT_META_ENV = re.compile(r"import\.meta\.env\.([A-Z0-9_]+)")
SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx")


def source_files() -> list[str]:
    found: list[str] = []
    for root, _dirs, files in os.walk(H5_SRC):
        for name in files:
            if name.endswith(SOURCE_SUFFIXES):
                found.append(os.path.join(root, name))
    return sorted(found)


def main() -> int:
    if not os.path.isdir(H5_SRC):
        sys.stderr.write(f"[FAIL] 找不到前端源码目录：{H5_SRC}\n")
        return 1
    problems: list[str] = []
    for path in source_files():
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        relative = os.path.relpath(path, REPO_ROOT)
        for match in IMPORT_META_ENV.finditer(text):
            name = match.group(1)
            if BYPASS_ENV.search(name):
                problems.append(f"{relative}: 出现放行类 env {name}（第 7 条禁止数值渲染放开开关）")
            if ENTITLEMENT_ENV.search(name):
                problems.append(f"{relative}: 前端读取 {name}（授权判定只能在服务端）")
        if "DATA_MODE" in text and "mock" in text:
            if "import.meta.env.DEV" not in text:
                problems.append(
                    f"{relative}: mock 数据分支未用 import.meta.env.DEV 保护"
                    "（生产构建可能被打到 fixture 数据，等于前端放行渲染）"
                )
    verdict = "PASS" if not problems else "FAIL"
    print(f"[{verdict}] 11-12/第7条 前端无可绕开关（静态扫描 {len(source_files())} 个文件）")
    for problem in problems:
        print(f"  - {problem}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
