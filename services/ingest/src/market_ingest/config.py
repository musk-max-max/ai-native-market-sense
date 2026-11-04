"""接入层配置加载（``services/ingest/config/ingest.yaml``）。

所有权说明：``config/datasource/`` 目前只在 ``agents/ownership.yaml`` 的
``reserved_paths`` 而未被登记为 created path，为避免 path guard 默认拒绝，
S0 竖切片把配置放在 ``services/ingest/config/``（A1 自有目录）；A0 登记后迁移。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "ingest.yaml"


@dataclass(frozen=True, slots=True)
class StorageConfig:
    sqlite_path: str = "var/ingest.db"


@dataclass(frozen=True, slots=True)
class QuotaConfig:
    reserve_ratio: float = 0.2
    calls_per_minute: int = 500
    period_cap_calls: int | None = None
    default_run_budget_calls: int | None = 1000


@dataclass(frozen=True, slots=True)
class SyncConfig:
    #: 单块自然日跨度。默认 8766 天（≈24 年）：20 年回补 = 1 块 = 1 页（单页上限 6000 行），
    #: 预算 ≈2 次调用/标的；改成 366 会让 20 年回补 ×21 块/标的，直接击穿决策 #11 的 2.6 万次预算。
    chunk_days: int = 8766
    page_limit: int = 6000
    dataset: str = "bars"


@dataclass(frozen=True, slots=True)
class OdsConfig:
    """ODS 批次导出根；按渠道物理隔离在 ``<root>/display`` 与 ``<root>/internal``（lead L34）。

    - ``<root>/display``：只接收 ``csv`` / ``official_api`` 渠道的批次（展示用主数据），
      serving 侧展示态校验只信这个 root；
    - ``<root>/internal``：适配层交叉校验批次与行情/财务批次（不得进展示结果集）。

    ``root`` 为 None 表示不导出（只留 SQLite raw 台账）。单 root + 固定子目录是
    lead 定的部署口径（少一个漏配路径）；渠道是批次级属性，物理隔离比行级字段
    标记更难绕过（L34 明确不改 ODS v1 格式）。
    """

    root: str | None = "var/ods"
    #: 两个渠道子目录名（固定，写死；A2/A13 按此读取）。
    DISPLAY_SUBDIR = "display"
    INTERNAL_SUBDIR = "internal"


@dataclass(frozen=True, slots=True)
class AdaptersConfig:
    active: str = "auto"
    options: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ImportConfig:
    """主数据导入的 manifest/快照根目录与默认 CSV 路径（H4 m00801）。"""

    manifest_root: str = "var/audit"
    base_info_path: str | None = "data/instruments/base_info.csv"
    #: 生产 profile fail-closed：manifest root 不得落在容器根文件系统（H4 m01335）。
    require_durable_manifest: bool = False


@dataclass(frozen=True, slots=True)
class IngestConfig:
    root: Path
    storage: StorageConfig
    quota: QuotaConfig
    sync: SyncConfig
    ods: OdsConfig
    adapters: AdaptersConfig
    imports: ImportConfig = ImportConfig()

    def resolve_path(self, relative: str) -> Path:
        path = Path(relative)
        return path if path.is_absolute() else self.root / path


def _section(data: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    value = data.get(key) or {}
    if not isinstance(value, Mapping):
        raise ValueError(f"config section {key!r} must be a mapping")
    return value


def load_config(path: str | Path | None = None) -> IngestConfig:
    """加载 YAML 配置；相对路径以 ``paths.root`` 为基准（默认配置文件上一级）。"""
    config_path = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, Mapping):
        raise ValueError(f"config root must be a mapping: {config_path}")

    paths = _section(raw, "paths")
    root_value = str(paths.get("root", ".."))
    root = (config_path.parent / root_value).resolve()

    storage_raw = _section(raw, "storage")
    quota_raw = _section(raw, "quota")
    sync_raw = _section(raw, "sync")
    ods_raw = _section(raw, "ods")
    adapters_raw = _section(raw, "adapters")
    imports_raw = _section(raw, "imports")

    options = adapters_raw.get("options") or {}
    if not isinstance(options, Mapping):
        raise ValueError("adapters.options must be a mapping")

    return IngestConfig(
        root=root,
        storage=StorageConfig(sqlite_path=str(storage_raw.get("sqlite_path", "var/ingest.db"))),
        quota=QuotaConfig(
            reserve_ratio=float(quota_raw.get("reserve_ratio", 0.2)),
            calls_per_minute=int(quota_raw.get("calls_per_minute", 500)),
            period_cap_calls=_optional_int(quota_raw.get("period_cap_calls")),
            default_run_budget_calls=_optional_int(quota_raw.get("default_run_budget_calls", 1000)),
        ),
        sync=SyncConfig(
            chunk_days=int(sync_raw.get("chunk_days", 8766)),
            page_limit=int(sync_raw.get("page_limit", 6000)),
            dataset=str(sync_raw.get("dataset", "bars")),
        ),
        ods=OdsConfig(root=_optional_str(ods_raw.get("root", "var/ods"))),
        adapters=AdaptersConfig(
            active=str(adapters_raw.get("active", "auto")),
            options={str(k): dict(v or {}) for k, v in options.items()},
        ),
        imports=ImportConfig(
            manifest_root=str(imports_raw.get("manifest_root", "var/audit")),
            base_info_path=_optional_str(imports_raw.get("base_info_path", "data/instruments/base_info.csv")),
            require_durable_manifest=bool(imports_raw.get("require_durable_manifest", False)),
        ),
    )


def _optional_int(value: Any) -> int | None:
    return None if value is None else int(value)


def _optional_str(value: Any) -> str | None:
    return None if value is None else str(value)
