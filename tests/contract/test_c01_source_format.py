"""C01 源格式边界（ADR-002 D2a G1，A11 落成；A13 接 CI）。

规则：canonical 数据面不得出现源格式 `ts_code` / `600519.SH` 这类「代码.交易所后缀」。
豁免仅限 D2a 表里的原始层与测试宿主路径（L14 正向清单；L81 已把
`services/ingest/tests/**` 纳入正向清单，`channel="tushare"` 不算源格式泄漏）。

这不是「黑名单放过」：只有下列路径允许承载源格式，其余命中即红灯。
新增豁免必须 A0 提案 + H2 签字（ADR-002 D2a / L14）。
"""
from __future__ import annotations

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]

PATTERN = re.compile(r"\bts_" r"code\b|\b\d{6}\.(?:SH|SZ|BJ)\b")
IGNORE_DIRS = {
    "node_modules", ".git", "dist", "build", ".venv", "__pycache__",
    ".mypy_cache", ".pytest_cache", ".ruff_cache",
}

# D2a 原始层（只允许「接收源数据的最外沿」）
RAW_LAYER = (
    "services/ingest/src/market_ingest/adapters/tushare/",
    "warehouse/ods/",
)
# 正向清单：文档/测试宿主/原始夹具（L14 + L81）
EXEMPT_TREES = (
    "docs/",
    "agents/",
    "tests/contract/",   # 本文件与契约 lint 允许以正则文字描述规则
    "tests/e2e/",
    "tests/fixtures/",
    "services/ingest/tests/",
    "warehouse/tests/",
)
SCOPES = (
    "contracts/**/*.yaml",
    "packages/api-client/src/generated/**/*.ts",
    "packages/design-tokens/**/*",
    "tests/data/**/*",
    "warehouse/**/*.py",
    "warehouse/**/*.sql",
    "warehouse/**/*.json",
    "warehouse/**/*.yaml",
    "web/**/*.ts",
    "web/**/*.tsx",
    "web/**/*.js",
    "web/**/*.json",
    "services/**/*.py",
    "services/**/*.ts",
    "services/**/*.yaml",
    "services/**/*.json",
)


def excluded(rel: str) -> bool:
    if any(rel.startswith(prefix) for prefix in RAW_LAYER + EXEMPT_TREES):
        return True
    # L83 裁定（Lead）；H2 未签：测试宿主既可能是 `/tests/`（复数）也可能是服务侧 `/test/`（单数），
    # 两者语义相同（fixture 合法承载源格式），排除范围必须同时覆盖；单数目录属
    # 「测试宿主排除项」，不加入 EXEMPT_TREES 正向清单（L81 边界保持不变）。
    return "/tests/" in rel or "/test/" in rel or rel.endswith(".md")


def collect_files(root: pathlib.Path = ROOT) -> list[pathlib.Path]:
    files: set[pathlib.Path] = set()
    for pattern in SCOPES:
        files.update(path for path in root.glob(pattern) if path.is_file())
    return sorted(files)


def scan(root: pathlib.Path = ROOT) -> tuple[list[str], int]:
    violations: list[str] = []
    scanned = 0
    for path in collect_files(root):
        rel = path.relative_to(root).as_posix()
        if excluded(rel) or any(part in IGNORE_DIRS for part in path.parts):
            continue
        scanned += 1
        text = path.read_text(encoding="utf-8", errors="ignore")
        for match in PATTERN.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            violations.append(f"{rel}:{line}: {match.group(0)}")
    return violations, scanned


def test_canonical_layer_has_no_source_format() -> None:
    """canonical 数据面出现 `ts_code` / `600519.SH` 即红灯；豁免按 D2a 正向清单。"""
    violations, scanned = scan()
    assert not violations, (
        "C01 violation: tushare raw identifier leaked into canonical layer\n" + "\n".join(violations)
    )
    # 防空转：扫描面必须真的扫到了文件（低于本阈值说明 glob/目录被改坏）
    assert scanned >= 150, f"扫描面异常小（{scanned} 个文件），C01 门禁可能空转"


def test_positive_list_matches_approved_boundary() -> None:
    """L14/L81：正向清单是「数据承载面」，不得把业务/契约面加进来稀释门禁。"""
    expected_raw = {
        "services/ingest/src/market_ingest/adapters/tushare/",
        "warehouse/ods/",
    }
    expected_exempt = {
        "docs/",
        "agents/",
        "tests/contract/",
        "tests/e2e/",
        "tests/fixtures/",
        "services/ingest/tests/",
        "warehouse/tests/",
    }
    assert set(RAW_LAYER) == expected_raw, "原始层正向清单被改动（须 A0 提案 + H2 签字）"
    assert set(EXEMPT_TREES) == expected_exempt, "测试宿主正向清单被改动（L81 只允许 services/ingest/tests/**）"


def test_scanner_would_catch_a_leak() -> None:
    """自证门禁不是空转：临时文件里放一行点号代码必须被同一正则命中。"""
    tmp = ROOT / "warehouse" / "_c01_selfcheck.py"
    try:
        tmp.write_text("bad = '600519.SH'\n", encoding="utf-8")
        text = tmp.read_text(encoding="utf-8")
        assert PATTERN.search(text) is not None
    finally:
        tmp.unlink(missing_ok=True)


def test_singular_test_dir_is_excluded_but_src_leak_is_still_caught(tmp_path: pathlib.Path) -> None:
    """L83 回归：`services/*/test/**` 排除，但 `services/*/src/**` 的同类泄漏仍必须抓。

    用临时仓库树验证，不往真实 `services/` 写文件（避免与 A0/A3 并发改动冲突）。
    """
    svc = tmp_path / "services" / "svc"
    (svc / "test").mkdir(parents=True)
    (svc / "src").mkdir(parents=True)
    leak = "const meta = { source: 'tushare' }; const code = '600519.SH';\n"
    (svc / "test" / "fixture.ts").write_text(leak, encoding="utf-8")
    (svc / "src" / "leak.ts").write_text(leak, encoding="utf-8")

    violations, scanned = scan(tmp_path)

    assert scanned == 1, f"只有 src 下的文件应进扫描面，实际 {scanned}"
    assert violations, "服务 src/ 下的真实泄漏未被抓到（排除范围扩过头）"
    assert all("services/svc/src/leak.ts" in item for item in violations), violations
    assert not any("/test/" in item for item in violations), "services/*/test/** 未被排除"


def test_real_service_singular_test_hosts_are_excluded() -> None:
    """真实仓库：A3/A0 的 `services/*/test/**` fixture 合法使用源格式，不应漏判为泄漏。"""
    real = [
        "services/market/test/market-plugin.test.ts",
        "services/api/test/routes.test.ts",
    ]
    for rel in real:
        assert excluded(rel), f"{rel} 属于测试宿主，应被排除（否则 fixture 会被误报）"
    # 不是「文件不存在所以没报」：其中一个文件确实存在且含 tushare 字面量
    sample = ROOT / "services/market/test/market-plugin.test.ts"
    assert sample.is_file() and "tushare" in sample.read_text(encoding="utf-8")
    # 同服务的 src/ 仍属扫描面
    assert not excluded("services/market/src/domain/build.ts")
