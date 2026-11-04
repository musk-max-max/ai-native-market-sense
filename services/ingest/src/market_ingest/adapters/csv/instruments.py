"""交易所基础信息 CSV 适配器（C 端白名单主数据来源，与 tushare 解耦）。

lead m00796 / H4 m00801：C 端白名单内的基础信息不得经 tushare 取得；本适配器只读
仓库内维护的 ``data/instruments/base_info.csv``，落与 tushare 路径**完全相同**的
``instrument.v1`` ODS 形状（A2 无感切换）。

边界：
- 本目录不出现 tushare 字段名/接口名；CSV 字段即 canonical 字段；
- 渠道（授权下载/人工导入/官方接口）与条款证据由 manifest 记录，本适配器不判定；
- 不绕过站点条款抓取：本适配器只读本地文件，不发起任何网络请求。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterator

from ...instruments_csv import read_base_info, rows_to_instrument_records
from ...manifest import CHANNEL_AUTHORIZED_DOWNLOAD, CHANNEL_MANUAL_IMPORT, CHANNEL_OFFICIAL_API
from ...models import InstrumentRecord, SourceRef, market_now
from ...ports import RawPage, RawSink, RejectedRow, RejectSink

#: ODS ``meta.source.source`` 取值（展示渠道细分在 manifest.channel，不在这里）。
SOURCE_NAME = "exchange_master"

#: 允许的渠道类型（tushare 不能走本适配器）。
IMPORT_CHANNELS: tuple[str, ...] = (CHANNEL_AUTHORIZED_DOWNLOAD, CHANNEL_MANUAL_IMPORT, CHANNEL_OFFICIAL_API)


class CsvInstrumentSource:
    """最小主数据源：读本地 CSV → ``InstrumentRecord``（只实现 instrument 主数据方法）。"""

    def __init__(
        self,
        path: str | Path,
        *,
        channel: str = CHANNEL_MANUAL_IMPORT,
        source_url: str | None = None,
        clock: Callable[[], datetime] = market_now,
    ) -> None:
        if channel not in IMPORT_CHANNELS:
            raise ValueError(f"unsupported import channel {channel!r}; expected one of {', '.join(IMPORT_CHANNELS)}")
        self._path = Path(path)
        self._channel = channel
        self._source_url = source_url
        self._clock = clock
        self._capture_stack: list[tuple[RawSink | None, RejectSink | None]] = []

    @property
    def source_name(self) -> str:
        return SOURCE_NAME

    @property
    def channel(self) -> str:
        return self._channel

    @property
    def source_url(self) -> str | None:
        return self._source_url

    @property
    def path(self) -> Path:
        return self._path

    @contextmanager
    def capture(self, raw_sink: RawSink | None, reject_sink: RejectSink | None = None) -> Iterator[None]:
        self._capture_stack.append((raw_sink, reject_sink))
        try:
            yield
        finally:
            self._capture_stack.pop()

    # ---------- 主数据方法（与 tushare 路径同名同形） ----------

    def fetch_instruments(self) -> list[InstrumentRecord]:
        """读全量 CSV 并映射；原始 CSV 行先落 raw（不可变），坏行落 DLQ。"""
        batch = read_base_info(self._path)
        now = self._clock()
        source = SourceRef(source=SOURCE_NAME, as_of=now, fetched_at=now)
        raw_sink, reject_sink = self._capture_stack[-1] if self._capture_stack else (None, None)
        if raw_sink is not None:
            raw_sink(
                RawPage(
                    dataset="instrument",
                    endpoint="exchange_csv",
                    request_params={
                        "file": batch.path.name,
                        "checksum_sha256": batch.checksum,
                        "channel": self._channel,
                        "source_url": self._source_url,
                    },
                    rows=tuple(
                        {
                            "instrument_id": row.instrument_id,
                            "name": row.name,
                            "board": row.board.value,
                            "list_status": row.list_status.value,
                            "list_date": row.list_date.isoformat() if row.list_date else None,
                        }
                        for row in batch.rows
                    ),
                    source=SOURCE_NAME,
                    as_of=now,
                    fetched_at=now,
                )
            )
        return rows_to_instrument_records(batch, source=source)


def create_adapter(options: dict[str, object] | None = None, **_: object) -> CsvInstrumentSource:
    """按配置/CLI 选项构造 CSV 主数据源（``--source csv`` 路径）。"""
    options = dict(options or {})
    path = options.get("csv_path") or options.get("path")
    if not path:
        raise ValueError("csv adapter requires csv_path (e.g. data/instruments/base_info.csv)")
    clock = options.get("clock")
    channel = str(options.get("channel") or "manual_import")
    source_url = options.get("source_url")
    return CsvInstrumentSource(
        Path(str(path)),
        channel=channel,
        source_url=str(source_url) if source_url else None,
        clock=clock if callable(clock) else market_now,  # type: ignore[arg-type]
    )


__all__ = ["IMPORT_CHANNELS", "SOURCE_NAME", "CsvInstrumentSource", "create_adapter"]
