"""调度 CLI：``python -m market_ingest sync-bars ...``（等价 ``jobs/sync_bars.py``）。

退出码（供 cron / K8s Job 判定）：
- 0 成功；
- 1 失败（源不可用/字段漂移/权限不足，需升级）；
- 2 配置或参数错误；
- 3 可续跑中断（信号或配额耗尽）→ 调度器直接用同一命令重试即可续跑。
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
from datetime import date
from pathlib import Path

from .adapters import load_adapter, registered
from .config import IngestConfig, OdsConfig, load_config
from . import manifest as mf
from .models import market_now, parse_instrument_id
from .quota import QuotaGuard, QuotaPolicy
from .storage import SqliteStorage
from .instruments_import import (
    import_instruments_csv,
    preview_instruments_csv,
    record_internal_instrument_import,
)
from .sync import (
    BarsSyncService,
    SyncRequest,
    SyncResult,
    estimate_market_plan,
    estimate_plan,
    estimate_research_plan,
    sync_fundamentals,
    sync_instrument_master,
    sync_research,
)


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid date {value!r}, expected YYYY-MM-DD") from exc


def _parse_instruments(value: str) -> tuple[str, ...]:
    items = tuple(part.strip() for part in value.split(",") if part.strip())
    if not items:
        raise argparse.ArgumentTypeError("--instruments must not be empty")
    for item in items:
        try:
            parse_instrument_id(item)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(f"invalid instrument {item!r}: {exc}") from exc
    return items


def _parse_datasets(value: str) -> tuple[str, ...]:
    items = tuple(part.strip() for part in value.split(",") if part.strip())
    if not items:
        raise argparse.ArgumentTypeError("--datasets must not be empty")
    return items


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", type=Path, default=None, help="配置文件路径")
    parser.add_argument("--db", type=Path, default=None, help="SQLite 台账路径，缺省读配置")
    parser.add_argument("--adapter", default=None, help="适配器逻辑名，缺省读配置/auto")
    parser.add_argument("--replay-fixture", type=Path, default=None, help="录播夹具 JSONL（CI/本地重放）")
    parser.add_argument("--ods-root", type=Path, default=None,
                        help="ODS 导出根；实际写 <root>/display（csv/官方渠道）与 <root>/internal（内部交叉校验/行情批次），L34")
    parser.add_argument("--no-ods", action="store_true", help="不导出 ODS 批次（只留 SQLite raw 台账）")
    parser.add_argument("--dry-run", action="store_true", help="只打印预算估算，不调用数据源")
    parser.add_argument("--manifest-root", type=Path, default=None,
                        help="主数据导入 manifest/快照根目录，缺省读配置")
    parser.add_argument("--operator", default=None,
                        help="导入操作人（CI actor 或人工参数），缺省读 DATA_IMPORT_OPERATOR")
    parser.add_argument("--now", default=None,
                        help="确定性时钟（ISO 8601 带时区，等价 MARKET_NOW），供 e2e/回放使用")


def _add_sync_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--instruments", type=_parse_instruments, default=None,
                        help="逗号分隔的 EXCH:CODE；省略=market-wide 模式（P0 默认，按交易日全市场）")
    parser.add_argument("--market-wide", action="store_true",
                        help="强制 market-wide 模式（按交易日一次拉全市场；与 --instruments 互斥）")
    parser.add_argument("--start", required=True, type=_parse_date, help="起始交易日（含），YYYY-MM-DD")
    parser.add_argument("--end", type=_parse_date, default=None, help="结束交易日（含），缺省=今天（市场时区）")
    parser.add_argument("--chunk-days", type=int, default=None, help="分块天数，缺省读配置")
    parser.add_argument("--budget-calls", type=int, default=None, help="本次运行调用预算，缺省读配置")
    parser.add_argument("--calls-per-minute", type=int, default=None, help="套餐每分钟上限，缺省读配置")
    _add_common_arguments(parser)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="market_ingest", description="A1 数据接入调度入口")
    sub = parser.add_subparsers(dest="command", required=True)
    sync = sub.add_parser("sync-bars", help="日线增量/回补同步（可中断可续跑）")
    _add_sync_arguments(sync)
    instruments = sub.add_parser(
        "sync-instruments",
        help="主数据：内部交叉校验来源（stock_basic，L17）或交易所 CSV 基础信息导入（C 端白名单）",
    )
    instruments.add_argument("--source", choices=("auto", *registered()), default="auto",
                             help="主数据来源：csv=交易所公开渠道 CSV 导入（展示用）；其它=内部交叉校验来源（L17）")
    instruments.add_argument("--csv-file", type=Path, default=None,
                             help="基础信息 CSV 路径，缺省读配置 imports.base_info_path")
    instruments.add_argument("--channel", choices=("authorized_download", "manual_import", "official_api"),
                             default="manual_import",
                             help="导入渠道（manifest 记录；官方接口/授权下载/人工导入）")
    instruments.add_argument("--source-url", default=None, help="来源 URL（manifest 证据）")
    instruments.add_argument("--terms-version", default=None, help="条款版本（manifest 证据）")
    instruments.add_argument("--terms-file", type=Path, default=None, help="条款全文文件（落 sha256 内容寻址快照）")
    instruments.add_argument("--credential-ref", default=None,
                             help="来源凭证路径或 sha256（不得写明文）")
    instruments.add_argument("--synthetic", action="store_true",
                             help="本批是合成样例（事件写 synthetic:true；真实批禁止使用）")
    _add_common_arguments(instruments)
    verify = sub.add_parser("verify-manifest", help="校验 manifest 哈希链与链头（H4 m01376）")
    verify.add_argument("--manifest-root", type=Path, required=True, help="manifest 根目录")
    verify.add_argument("--allow-missing-head", action="store_true",
                        help="允许缺少 manifest.head（仅用于迁移期/本地检查）")
    verify.add_argument("--allow-demo", action="store_true",
                        help="允许 DEMO 标记的审计根（仅机制冒烟；release 证据脚本禁止）")
    fundamentals = sub.add_parser("sync-fundamentals", help="最小财务摘要批次（L16，切片标的）")
    fundamentals.add_argument("--instruments", required=True, type=_parse_instruments,
                              help="切片标的，逗号分隔的 EXCH:CODE（3–5 个）")
    _add_common_arguments(fundamentals)
    research = sub.add_parser(
        "sync-research",
        help="研究数据集接入（KD-AIP0-INF-05）：按交易日抓取 → canonical ODS（DWD 归 A2）",
    )
    research.add_argument("--datasets", type=_parse_datasets, default=None,
                          help="逗号分隔数据集，缺省读配置 research.datasets")
    research.add_argument("--start", required=True, type=_parse_date, help="起始交易日（含），YYYY-MM-DD")
    research.add_argument("--end", type=_parse_date, default=None, help="结束交易日（含），缺省=今天（市场时区）")
    research.add_argument("--index-codes", type=_parse_instruments, default=None,
                          help="指数日线代码（canonical EXCH:CODE），缺省读配置 research.index_codes")
    research.add_argument("--budget-calls", type=int, default=None, help="本次运行调用预算，缺省读配置")
    research.add_argument("--calls-per-minute", type=int, default=None, help="套餐每分钟上限，缺省读配置")
    _add_common_arguments(research)
    return parser


def _build_config(args: argparse.Namespace) -> IngestConfig:
    return load_config(args.config)


def _adapter_options(config: IngestConfig, adapter_name: str, args: argparse.Namespace) -> dict[str, object]:
    options = dict(config.adapters.options.get(adapter_name) or {})
    if args.replay_fixture is not None:
        options["replay_fixture"] = str(args.replay_fixture)
    return options


def run_sync(args: argparse.Namespace) -> int:
    config = _build_config(args)
    adapter_name = args.adapter or config.adapters.active
    end = args.end or market_now().date()
    chunk_days = args.chunk_days if args.chunk_days is not None else config.sync.chunk_days
    budget = args.budget_calls if args.budget_calls is not None else config.quota.default_run_budget_calls
    cpm = args.calls_per_minute if args.calls_per_minute is not None else config.quota.calls_per_minute

    if args.market_wide and args.instruments:
        raise ValueError("--market-wide 与 --instruments 互斥（二选一）")
    market_wide = bool(args.market_wide) or args.instruments is None

    request = SyncRequest(
        instruments=() if market_wide else args.instruments,
        start=args.start,
        end=end,
        chunk_days=chunk_days,
        dataset=config.sync.dataset,
        market_wide=market_wide,
    )

    if market_wide:
        plan = estimate_market_plan(
            request.start, request.end,
            calls_per_minute=cpm, reserve_ratio=config.quota.reserve_ratio,
            include_factors=True, anchors_first_run=0,
        )
    else:
        plan = estimate_plan(
            len(request.instruments), request.start, request.end,
            chunk_days=chunk_days, page_limit=config.sync.page_limit,
            calls_per_minute=cpm, reserve_ratio=config.quota.reserve_ratio,
            first_run=args.dry_run,
        )

    if args.dry_run:
        if market_wide:
            budget_table = [
                ["calls_per_trading_day", plan["calls_per_trading_day"]],
                ["x trading_days", plan["trading_days"]],
                ["+ anchor_calls", plan["anchor_calls"]],
                ["= total_calls", plan["total_calls"]],
                ["/ effective_calls_per_minute", plan["effective_calls_per_minute"]],
                ["= eta_minutes", plan["eta_minutes"]],
            ]
        else:
            budget_table = [
                ["calls_per_instrument", plan["calls_per_instrument"]],
                ["x instruments", plan["instruments"]],
                ["= total_calls", plan["total_calls"]],
                ["/ effective_calls_per_minute", plan["effective_calls_per_minute"]],
                ["= eta_minutes", plan["eta_minutes"]],
            ]
        print(json.dumps({
            "dry_run": True,
            "mode": "market_wide" if market_wide else "per_instrument",
            "instruments": list(request.instruments),
            "start": request.start.isoformat(),
            "end": request.end.isoformat(),
            "chunk_days": chunk_days,
            "budget": plan,
            "budget_calls": budget,
            "within_budget": budget is None or plan["total_calls"] <= budget,
            "budget_table": budget_table,
        }, ensure_ascii=False, indent=2))
        return 0

    if budget is not None and plan["total_calls"] > budget:
        print("warning: estimated calls exceed --budget-calls; run may stop early", file=sys.stderr)

    db_path = args.db if args.db is not None else config.resolve_path(config.storage.sqlite_path)
    storage = SqliteStorage(db_path)
    policy = QuotaPolicy(
        calls_per_minute=cpm,
        reserve_ratio=config.quota.reserve_ratio,
        period_cap_calls=config.quota.period_cap_calls,
        run_budget_calls=budget,
    )
    guard = QuotaGuard(policy, storage)
    source = load_adapter(
        adapter_name,
        options=_adapter_options(config, adapter_name, args),
        guard=guard,
        ledger=storage,
    )
    # 行情/财务批次来自内部源通道，一律进内部 ODS 根（L34：展示 root 只接 csv/official_api）。
    _, internal_root = _resolve_ods_roots(config, args)
    service = BarsSyncService(source, storage, guard=guard, ods_root=internal_root)

    stop = {"requested": False}

    def _request_stop(signum: int, frame: object) -> None:  # pragma: no cover - 信号路径
        stop["requested"] = True
        print("interrupt received: finishing current chunk then stopping", file=sys.stderr)

    previous = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, _request_stop)
    try:
        result = service.sync(request, interrupt=lambda: stop["requested"])
    finally:
        signal.signal(signal.SIGINT, previous)
        storage.close()

    print(json.dumps(result.summary(), ensure_ascii=False, indent=2))
    if result.status == "succeeded":
        return 0
    if result.status == "interrupted":
        print(f"interrupted ({result.halted_reason}); rerun the same command to resume", file=sys.stderr)
        return 3
    print(f"failed ({result.halted_reason}); escalate per roster must_escalate", file=sys.stderr)
    return 1


def _resolve_ods_roots(config: IngestConfig, args: argparse.Namespace) -> tuple[Path | None, Path | None]:
    """按 L34 解析两个渠道 ODS 根：单 root + 固定子目录（lead 定，README 写死）。

    ``<root>/display`` 只接 csv/official_api 渠道批次；``<root>/internal`` 接
    适配层交叉校验与行情/财务批次。``--no-ods`` 关闭导出；``--ods-root`` 覆盖配置 root。
    """
    if args.no_ods:
        return None, None
    if args.ods_root is not None:
        base = args.ods_root
    elif config.ods.root is not None:
        base = config.resolve_path(config.ods.root)
    else:
        return None, None
    return (
        base / OdsConfig.DISPLAY_SUBDIR,
        base / OdsConfig.INTERNAL_SUBDIR,
    )


def _open_storage_guard_source(
    config: IngestConfig, args: argparse.Namespace
) -> tuple[SqliteStorage, QuotaGuard, object]:
    adapter_name = args.adapter or config.adapters.active
    db_path = args.db if args.db is not None else config.resolve_path(config.storage.sqlite_path)
    storage = SqliteStorage(db_path)
    guard = QuotaGuard(
        QuotaPolicy(
            calls_per_minute=config.quota.calls_per_minute,
            reserve_ratio=config.quota.reserve_ratio,
            period_cap_calls=config.quota.period_cap_calls,
        ),
        storage,
    )
    source = load_adapter(
        adapter_name,
        options=_adapter_options(config, adapter_name, args),
        guard=guard,
        ledger=storage,
    )
    return storage, guard, source


def _operator(args: argparse.Namespace) -> str:
    """H4 m00801：操作人必须有（CI actor 或显式参数），缺即失败。"""
    value = (args.operator or os.environ.get("DATA_IMPORT_OPERATOR", "")).strip()
    if not value:
        raise ValueError("missing operator: pass --operator or set DATA_IMPORT_OPERATOR (H4 requires an operator)")
    return value


def _manifest_root(config: IngestConfig, args: argparse.Namespace) -> Path:
    if args.manifest_root is not None:
        return args.manifest_root
    return config.resolve_path(config.imports.manifest_root)


def _terms_text(args: argparse.Namespace) -> str | None:
    # sync-fundamentals 没有 --terms-* 参数（财务批次不入 manifest）。
    terms_file = getattr(args, "terms_file", None)
    if terms_file is None:
        return None
    return Path(terms_file).read_text(encoding="utf-8")


def _csv_path(config: IngestConfig, args: argparse.Namespace) -> Path:
    if args.csv_file is not None:
        return args.csv_file
    if config.imports.base_info_path is None:
        raise ValueError("missing --csv-file and imports.base_info_path is null")
    return config.resolve_path(config.imports.base_info_path)


def _open_storage(config: IngestConfig, args: argparse.Namespace) -> SqliteStorage:
    db_path = args.db if args.db is not None else config.resolve_path(config.storage.sqlite_path)
    return SqliteStorage(db_path)


def _require_import_evidence(args: argparse.Namespace) -> None:
    """H4 m00801：正式导入（非内部交叉校验渠道）必须带齐取证字段，缺即失败。"""
    missing = []
    if not (args.source_url or "").strip():
        missing.append("--source-url")
    if not (args.terms_version or "").strip():
        missing.append("--terms-version")
    if args.terms_file is None:
        missing.append("--terms-file（条款全文快照）")
    if not (args.credential_ref or "").strip():
        missing.append("--credential-ref")
    if missing:
        raise ValueError(
            "csv import is missing required evidence (H4 manifest): " + ", ".join(missing)
        )


def _require_durable_manifest(config: IngestConfig) -> bool:
    """生产 profile：审计目录不得落在容器 rootfs（H4 m01335）；本地/CI 默认关闭。"""
    if config.imports.require_durable_manifest:
        return True
    return os.environ.get("INGEST_STRICT_AUDIT_ROOT", "").strip() in {"1", "true", "TRUE"}


def _run_import_instruments(args: argparse.Namespace, config: IngestConfig) -> int:
    """``sync-instruments --source csv``：交易所基础信息 CSV 导入（C 端白名单主数据）。"""
    csv_path = _csv_path(config, args)
    manifest_root = _manifest_root(config, args)
    # CSV 基础信息是展示用主数据：只写展示 root（L34）。
    display_root, _ = _resolve_ods_roots(config, args)
    ods_root = display_root
    if args.dry_run:
        preview = preview_instruments_csv(csv_path=csv_path, manifest_root=manifest_root)
        print(json.dumps({"dry_run": True, "mode": "sync-instruments.csv", "csv_path": str(csv_path)}, ensure_ascii=False, indent=2))
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        return 0
    _require_import_evidence(args)
    operator = _operator(args)
    storage = _open_storage(config, args)
    try:
        result = import_instruments_csv(
            csv_path=csv_path,
            storage=storage,
            ods_root=ods_root,
            manifest_root=manifest_root,
            channel=args.channel,
            operator=operator,
            source_url=args.source_url,
            terms_version=args.terms_version,
            terms_text=_terms_text(args),
            credential_ref=args.credential_ref,
            synthetic=args.synthetic,
            require_durable_manifest=_require_durable_manifest(config),
        )
    finally:
        storage.close()
    print(json.dumps(result.summary(), ensure_ascii=False, indent=2))
    if result.status == "blocked":
        print("blocked: conflicts require human adjudication (exit 4); no ODS batch was written", file=sys.stderr)
    elif result.status != "succeeded":
        print("failed: inspect manifest event for evidence", file=sys.stderr)
    return result.exit_code


def run_verify_manifest(args: argparse.Namespace) -> int:
    """``verify-manifest``：读取方校验链完整性（H4 m01376）。"""
    try:
        summary = mf.verify_manifest_chain(
            args.manifest_root,
            require_head=not args.allow_missing_head,
            allow_demo=args.allow_demo,
        )
    except (ValueError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"ok": True, **summary}, ensure_ascii=False, indent=2, default=str))
    return 0


def run_sync_master(args: argparse.Namespace) -> int:
    """``sync-instruments`` / ``sync-fundamentals``：一次性最小批次（无 checkpoint）。"""
    config = _build_config(args)
    commands = {"sync-instruments": 1, "sync-fundamentals": 2}
    calls_per_instrument = commands[args.command]
    instruments = tuple(getattr(args, "instruments", ()) or ())

    source_mode = getattr(args, "source", "auto") if args.command == "sync-instruments" else "auto"
    use_csv = args.command == "sync-instruments" and (source_mode == "csv" or (source_mode == "auto" and args.csv_file is not None))

    if args.dry_run:
        if use_csv:
            return _run_import_instruments(args, config)
        if args.command == "sync-instruments":
            total_calls = 1
            budget_table = [["calls", 1], ["x instruments", "n/a（一次全量）"], ["= total_calls", 1]]
        else:
            total_calls = calls_per_instrument * len(instruments)
            budget_table = [
                ["calls_per_instrument", calls_per_instrument],
                ["x instruments", len(instruments)],
                ["= total_calls", total_calls],
            ]
        print(json.dumps({
            "dry_run": True,
            "mode": args.command,
            "instruments": list(instruments),
            "budget": {"total_calls": total_calls},
            "budget_calls": config.quota.default_run_budget_calls,
            "within_budget": (
                config.quota.default_run_budget_calls is None
                or total_calls <= config.quota.default_run_budget_calls
            ),
            "budget_table": budget_table,
        }, ensure_ascii=False, indent=2))
        return 0

    if use_csv:
        return _run_import_instruments(args, config)

    manifest_root = _manifest_root(config, args)
    terms_text = _terms_text(args)
    # stock_basic 交叉校验与财务批次来自内部源通道：只写内部 root（L34）。
    _, internal_root = _resolve_ods_roots(config, args)
    ods_root = internal_root
    storage, guard, source = _open_storage_guard_source(config, args)
    try:
        if args.command == "sync-instruments":
            operator = _operator(args)
            mf.assert_durable_audit_root(manifest_root, require=_require_durable_manifest(config))
            result = sync_instrument_master(source, storage, ods_root=ods_root, guard=guard)
            if result.status == "succeeded":
                record_internal_instrument_import(
                    manifest_root=manifest_root,
                    result=result,
                    operator=operator,
                    terms_version=args.terms_version,
                    terms_text=terms_text,
                    credential_ref=args.credential_ref,
                    clock=market_now,
                    synthetic=args.synthetic,
                )
        else:
            result = sync_fundamentals(source, storage, instrument_ids=instruments, ods_root=ods_root, guard=guard)
    finally:
        storage.close()
    print(json.dumps(result.summary(), ensure_ascii=False, indent=2))
    if result.status == "succeeded":
        return 0
    print(f"failed ({result.dataset}); escalate per roster must_escalate", file=sys.stderr)
    return 1


def run_sync_research(args: argparse.Namespace) -> int:
    """``sync-research``：研究数据集按交易日抓取 → 内部 ODS（KD-AIP0-INF-05）。

    退出码与 sync-bars 一致：0 成功 / 1 失败 / 3 可续跑中断；
    已有 checkpoint 的交易日跳过，同一命令重试即可续跑。
    """
    config = _build_config(args)
    adapter_name = args.adapter or config.adapters.active
    end = args.end or market_now().date()
    budget = args.budget_calls if args.budget_calls is not None else config.quota.default_run_budget_calls
    cpm = args.calls_per_minute if args.calls_per_minute is not None else config.quota.calls_per_minute
    datasets = tuple(args.datasets or config.research.datasets)
    index_codes = tuple(args.index_codes or config.research.index_codes)

    plan = estimate_research_plan(
        datasets,
        args.start,
        end,
        index_codes=index_codes,
        calls_per_minute=cpm,
        reserve_ratio=config.quota.reserve_ratio,
    )

    if args.dry_run:
        budget_table = [
            ["calls_per_trading_day", plan["calls_per_trading_day"]],
            ["calls_by_dataset", plan["calls_by_dataset"]],
            ["x trading_days", plan["trading_days"]],
            ["+ calendar_calls", plan["calendar_calls"]],
            ["= total_calls", plan["total_calls"]],
            ["/ effective_calls_per_minute", plan["effective_calls_per_minute"]],
            ["= eta_minutes", plan["eta_minutes"]],
        ]
        print(json.dumps({
            "dry_run": True,
            "mode": "research",
            "datasets": list(datasets),
            "index_codes": list(index_codes),
            "start": args.start.isoformat(),
            "end": end.isoformat(),
            "budget": plan,
            "budget_calls": budget,
            "within_budget": budget is None or plan["total_calls"] <= budget,
            "budget_table": budget_table,
        }, ensure_ascii=False, indent=2))
        return 0

    if budget is not None and plan["total_calls"] > budget:
        print("warning: estimated calls exceed --budget-calls; run may stop early", file=sys.stderr)

    db_path = args.db if args.db is not None else config.resolve_path(config.storage.sqlite_path)
    storage = SqliteStorage(db_path)
    guard = QuotaGuard(
        QuotaPolicy(
            calls_per_minute=cpm,
            reserve_ratio=config.quota.reserve_ratio,
            period_cap_calls=config.quota.period_cap_calls,
            run_budget_calls=budget,
        ),
        storage,
    )
    source = load_adapter(
        adapter_name,
        options=_adapter_options(config, adapter_name, args),
        guard=guard,
        ledger=storage,
    )
    # 研究数据集来自内部源通道：只写内部 root（L34）。
    _, internal_root = _resolve_ods_roots(config, args)

    stop = {"requested": False}

    def _request_stop(signum: int, frame: object) -> None:  # pragma: no cover - 信号路径
        stop["requested"] = True
        print("interrupt received: finishing current day then stopping", file=sys.stderr)

    previous = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, _request_stop)
    try:
        result = sync_research(
            source,
            storage,
            datasets=datasets,
            start=args.start,
            end=end,
            ods_root=internal_root,
            index_codes=index_codes,
            guard=guard,
            interrupt=lambda: stop["requested"],
        )
    finally:
        signal.signal(signal.SIGINT, previous)
        storage.close()

    print(json.dumps(result.summary(), ensure_ascii=False, indent=2))
    if result.status == "succeeded":
        return 0
    if result.status == "interrupted":
        print(f"interrupted ({result.halted_reason}); rerun the same command to resume", file=sys.stderr)
        return 3
    print(f"failed ({result.halted_reason}); escalate per roster must_escalate", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "now", None):
        os.environ["MARKET_NOW"] = str(args.now)
    try:
        if args.command == "verify-manifest":
            return run_verify_manifest(args)
        if args.command in ("sync-instruments", "sync-fundamentals"):
            return run_sync_master(args)
        if args.command == "sync-research":
            return run_sync_research(args)
        if args.command != "sync-bars":  # pragma: no cover - argparse 已限制
            parser.error(f"unknown command {args.command!r}")
        return run_sync(args)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
