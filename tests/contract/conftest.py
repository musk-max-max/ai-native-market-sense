"""pytest 公共配置（A11 owns: tests/contract/）。"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import pytest  # noqa: E402

from openapi_lib import ContractRepo  # noqa: E402


@pytest.fixture(scope="session")
def repo() -> ContractRepo:
    return ContractRepo()


@pytest.fixture(scope="session")
def operations(repo: ContractRepo):
    return repo.operations()
