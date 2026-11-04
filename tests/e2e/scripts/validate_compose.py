#!/usr/bin/env python3
"""compose 静态校验（A12 owns）—— 不需要 docker，CI/本地都可跑。

作用：把「真栈 + 录播 + 禁止真实外呼」这几条硬约束变成可执行断言。
      真栈能否 up 需要 docker（由 preflight 判定），本脚本保证 compose 文件本身
      不会悄悄退化（比如有人把 internal network 关掉、把 fixture 挂载改成可写、
      或把 TUSHARE_API_URL 指回真实接口）。

用法：python3 tests/e2e/scripts/validate_compose.py [--quiet]
退出码：0 全部通过；1 有失败项。
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import yaml

E2E_DIR = Path(__file__).resolve().parents[1]
BASE = E2E_DIR / "docker-compose.yml"
RECORD = E2E_DIR / "docker-compose.record.yml"
POSITIVE = E2E_DIR / "docker-compose.entitlement-positive.yml"

REQUIRED_SERVICES = ["postgres", "redis", "tushare-replay", "api", "web",
                    "db-migrate", "ingress", "warehouse-load", "ingest-report"]
LONG_RUNNING = ["postgres", "redis", "tushare-replay", "api", "web"]
FIXTURES_DIR = "/fixtures/tushare"


class Report:
    def __init__(self, quiet=False):
        self.quiet = quiet
        self.failures = []
        self.checks = 0

    def check(self, ok: bool, name: str, detail: str = ""):
        self.checks += 1
        if ok:
            if not self.quiet:
                print(f"PASS  {name}")
        else:
            self.failures.append((name, detail))
            print(f"FAIL  {name}: {detail}")

    def summary(self) -> int:
        print(f"\n{self.checks - len(self.failures)}/{self.checks} 项通过")
        if self.failures:
            print("失败项：")
            for name, detail in self.failures:
                print(f"  - {name}: {detail}")
            return 1
        return 0


def load(path: Path):
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def env_of(service: dict, key: str):
    return (service.get("environment") or {}).get(key)


def mounts_of(service: dict):
    out = []
    for item in service.get("volumes") or []:
        if isinstance(item, str):
            parts = item.split(":")
            out.append({"source": parts[0], "target": parts[1] if len(parts) > 1 else "",
                        "mode": parts[2] if len(parts) > 2 else "rw"})
        else:
            out.append(item)
    return out


def main(argv) -> int:
    quiet = "--quiet" in argv
    rep = Report(quiet=quiet)

    for path in (BASE, RECORD):
        rep.check(path.is_file(), f"compose 文件存在：{path.name}", f"缺少 {path}")

    base_text = BASE.read_text(encoding="utf-8")
    base = load(BASE)
    record = load(RECORD)
    services = base.get("services") or {}

    # 1. 服务齐全
    for name in REQUIRED_SERVICES:
        rep.check(name in services, f"服务存在：{name}", "docker-compose.yml 缺少该服务")

    # 2. 默认栈不能出网 + 不能出现真实 tushare 痕迹
    app_net = ((base.get("networks") or {}).get("app-net") or {})
    rep.check(app_net.get("internal") is True, "app-net internal=true（CI 无外网出口）",
              f"app-net.internal={app_net.get('internal')!r}，CI 可能打到真实接口")
    rep.check("api.tushare.pro" not in base_text, "默认栈无真实 tushare 域名",
              "默认 compose 出现 api.tushare.pro（只允许在 record override）")
    rep.check("TUSHARE_TOKEN" not in base_text, "默认栈不携带 tushare token",
              "默认 compose 出现 TUSHARE_TOKEN，存在凭证泄漏/误用真实接口风险")
    rep.check("FIXTURE_MODE: record" not in base_text, "默认栈为 replay 模式",
              "默认 compose 出现 record 模式")

    # 3. healthcheck：长驻服务必须有（真栈可判定「起没起来」）
    for name in LONG_RUNNING:
        svc = services.get(name) or {}
        hc = svc.get("healthcheck") or {}
        rep.check(bool(hc.get("test")), f"healthcheck：{name}", "缺少 healthcheck，preflight 无法判定就绪")

    # 4. 录播代理：只读挂载 + replay + fixtures 路径一致
    replay = services.get("tushare-replay") or {}
    rep.check(env_of(replay, "FIXTURE_MODE") == "replay", "tushare-replay FIXTURE_MODE=replay",
              f"实际 {env_of(replay, 'FIXTURE_MODE')!r}")
    rep.check(env_of(replay, "FIXTURES_DIR") == FIXTURES_DIR, "tushare-replay FIXTURES_DIR 正确",
              f"实际 {env_of(replay, 'FIXTURES_DIR')!r}")
    replay_mounts = [m for m in mounts_of(replay) if m.get("target") == FIXTURES_DIR]
    rep.check(len(replay_mounts) == 1, "tushare-replay 挂载 fixtures",
              "未把 ../fixtures/tushare 挂到 /fixtures/tushare")
    if replay_mounts:
        m = replay_mounts[0]
        rep.check(m.get("source") == "../fixtures/tushare", "fixtures 挂载源为仓库 tests/fixtures/tushare",
                  f"实际 {m.get('source')!r}")
        rep.check(m.get("mode") == "ro", "默认栈 fixtures 只读挂载", f"实际 mode={m.get('mode')!r}")

    # 5. api 的 adapter 注入点
    api = services.get("api") or {}
    source_url = str(env_of(api, "TUSHARE_API_URL") or "")
    rep.check(urlparse(source_url).hostname == "tushare-replay", "api TUSHARE_API_URL 指向录播代理",
              f"实际 {source_url!r}（禁止指向真实 tushare）")
    rep.check(env_of(api, "DATA_SOURCE_MODE") == "replay", "api DATA_SOURCE_MODE=replay",
              f"实际 {env_of(api, 'DATA_SOURCE_MODE')!r}")
    rep.check(env_of(api, "ENTITLEMENT_TIER") not in (None, ""), "api 暴露 ENTITLEMENT_TIER（F1 未落地时降级）",
              "缺少 ENTITLEMENT_TIER，E2E-P0-06 无法验证「未授权不渲染价格」")
    # H5 KD-ENT-01 / A13 m02124：默认栈固定 internal_eval，不允许任何 env override，
    # 防止有人用 E2E_ENTITLEMENT_TIER 把默认栈拉成 c_end_display（fail-open）。
    tier_literal = str(env_of(api, "ENTITLEMENT_TIER"))
    rep.check(tier_literal == "internal_eval",
              "默认栈 api ENTITLEMENT_TIER 固定 internal_eval（fail-closed，无 override 入口）",
              f"实际 {tier_literal!r}；默认栈必须是字面量 internal_eval，"
              f"已授权档走 docker-compose.entitlement-positive.yml（KD-ENT-01）")
    rep.check("${" not in tier_literal,
              "默认栈 ENTITLEMENT_TIER 不是变量插值（环境变量无法把默认栈拉成特权档）",
              f"实际 {tier_literal!r}；插值形式会让 `E2E_ENTITLEMENT_TIER=c_end_display` 悄悄改默认栈")
    # 默认 compose 的任何 service env 都不得出现 c_end_display（注释不算）。
    privileged_default = [
        f"{name}.{key}"
        for name, svc in services.items()
        for key, value in ((svc or {}).get("environment") or {}).items()
        if "c_end_display" in str(value)
    ]
    rep.check(not privileged_default,
              "默认栈任何 service env 都不含 c_end_display（特权档只在 positive override）",
              f"出现于 {privileged_default}；已授权/展示用例必须用独立 positive 栈")
    hold_expr = str(env_of(api, "ENTITLEMENT_HOLD_CHECK"))
    audit_expr = str(env_of(api, "ENTITLEMENT_AUDIT"))
    rep.check(hold_expr == "1", "默认栈 ENTITLEMENT_HOLD_CHECK=1（db-migrate 已跑 compliance 迁移，不靠默认关旁路）",
              f"实际 {hold_expr!r}；H5 KD-ENT-01：e2e 不再依赖默认关 hold/audit")
    rep.check(audit_expr == "1", "默认栈 ENTITLEMENT_AUDIT=1（同上，与发布语义一致）",
              f"实际 {audit_expr!r}")
    # 5aa. positive override（独立 project + loopback，禁止公网可达）
    positive = load(POSITIVE)
    pos_api = ((positive.get("services") or {}).get("api") or {})
    pos_env = pos_api.get("environment") or {}
    rep.check(str(pos_env.get("ENTITLEMENT_TIER")) == "c_end_display",
              "positive override 显式 ENTITLEMENT_TIER=c_end_display",
              f"实际 {pos_env.get('ENTITLEMENT_TIER')!r}")
    rep.check(str(pos_env.get("ENTITLEMENT_HOLD_CHECK")) == "1"
              and str(pos_env.get("ENTITLEMENT_AUDIT")) == "1",
              "positive override 同时开 HOLD_CHECK=1 / AUDIT=1",
              "缺一：正向 hold/audit 用例与发布语义不一致")
    sha = str(pos_env.get("ENTITLEMENT_CONFIG_EXPECTED_SHA256") or "")
    expires = str(pos_env.get("ENTITLEMENT_EXPIRES_AT") or "")
    rep.check(bool(re.fullmatch(r"[0-9a-f]{64}", sha)),
              "positive override ENTITLEMENT_CONFIG_EXPECTED_SHA256 为 64 位小写 hex",
              f"实际 {sha!r}")
    rep.check(bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", expires)),
              "positive override ENTITLEMENT_EXPIRES_AT 为 ISO UTC（秒级）",
              f"实际 {expires!r}")
    expected_sha = hashlib.sha256(("c_end_display|" + expires.replace("Z", ".000Z")).encode()).hexdigest()         if expires else ""
    rep.check(bool(expires) and sha == expected_sha,
              "positive override sha 与 expiresAt 成对（sha256('c_end_display|<ISO 毫秒>')）",
              f"sha={sha!r} 与 expires={expires!r} 不匹配（A3 规范：sha256(utf8(tier|expiresAtNormalized))）")
    rep.check(str(pos_env.get("APP_PROFILE")) == "e2e",
              "positive override 保持 APP_PROFILE=e2e（仅隔离栈）",
              f"实际 {pos_env.get('APP_PROFILE')!r}")
    # 默认 compose 的所有发布端口必须绑 127.0.0.1（H5：E2E_MODE 只许隔离栈、禁公网可达；
    # positive override 继承这些端口，因此默认端口 loopback 即覆盖 positive 栈）。
    default_ports = [(name, str(item)) for name, svc in services.items()
                     for item in (svc or {}).get("ports") or []]
    rep.check(bool(default_ports), "compose 显式发布宿主端口（preflight/浏览器可达）",
              "无 ports，宿主无法访问")
    bad_default = [(n, p) for n, p in default_ports if not p.startswith("127.0.0.1:")]
    rep.check(not bad_default,
              "默认 compose 全部发布端口绑 127.0.0.1（E2E_MODE 禁公网可达，H5 m02905/m02964）",
              f"未绑 loopback：{bad_default}；positive 栈继承这些端口，必须同样 loopback-only")
    # positive override 若自己再加端口，也必须 loopback（防止未来有人加 0.0.0.0 端口）。
    extra_ports = [(name, str(item)) for name, svc in (positive.get("services") or {}).items()
                   for item in (svc or {}).get("ports") or []]
    bad_extra = [(n, p) for n, p in extra_ports if not p.startswith("127.0.0.1:")]
    rep.check(not bad_extra, "positive override 新增端口（若有）同样绑 127.0.0.1",
              f"未绑 loopback：{bad_extra}；H5 m02905/m02964 硬规则")
    rep.check(env_of(api, "INGEST_REPORT_PATH") == "/state/ingest-report.json",
              "api INGEST_REPORT_PATH 指向 /state/ingest-report.json（ingest-once 契约 §4）",
              f"实际 {env_of(api, 'INGEST_REPORT_PATH')!r}，/healthz 无法给出 data_ready")
    state_mounts = [m for m in mounts_of(api) if m.get("target") == "/state"]
    rep.check(len(state_mounts) == 1, "api 挂载 /state（ingest-report.json 来源）",
              "未把 tests/e2e/.state 挂到容器 /state，data_ready 恒为 INGEST_REPORT_MISSING")
    if state_mounts:
        rep.check(state_mounts[0].get("mode") == "ro", "api /state 只读挂载（报告由 ingest-once 写）",
                  "api 不应能写 /state（报告唯一写者是 ingest-once）")
    rep.check((api.get("environment") or {}).get("APP_PROFILE") == "e2e",
              "api 显式 APP_PROFILE=e2e（decisions.md L46）",
              "APP_PROFILE 缺省=prod：E2E 后门 fail-closed，api 会拒绝启动（E2E_MODE=1 与 prod 互斥）")
    # 5b. seed 流水线（契约 §1；Lead m01015：单职责镜像 + A13 同一迁移路径）
    ingress = services.get("ingress") or {}
    ingress_volumes = ingress.get("volumes") or []
    rep.check(any(v.endswith("ingress_once.sh:/e2e/ingress_once.sh:ro") for v in ingress_volumes),
              "ingress 只读挂载 ingress_once.sh 到 /e2e/ingress_once.sh",
              "契约 §1：第 1 步由该脚本执行；缺挂载时容器直接退出")
    rep.check("/e2e/ingress_once.sh" in str(ingress.get("entrypoint") or ""),
              "ingress entrypoint 跑 ingress_once.sh（覆盖镜像 ENTRYPOINT）",
              "A1 镜像 ENTRYPOINT=python -m market_ingest，不覆盖会把 shell 脚本当子命令参数")
    ingress_env = ingress.get("environment") or {}
    rep.check(str(ingress_env.get("MARKET_NOW", "")).startswith("${E2E_MARKET_NOW:-") and
              "T" in str(ingress_env.get("MARKET_NOW", "")),
              "ingress 固定 MARKET_NOW（带时区，缺省 2026-11-04T15:00:00+08:00）",
              "未 pin 时钟 → adj_factor 锚点漂移，合成录制跨天失效（A1: MARKET_NOW 必须带时区）")
    rep.check(env_of(ingress, "DATA_SOURCE_MODE") == "replay", "ingress DATA_SOURCE_MODE=replay",
              f"实际 {env_of(ingress, 'DATA_SOURCE_MODE')!r}")
    rep.check(urlparse(str(env_of(ingress, "TUSHARE_API_URL") or "")).hostname == "tushare-replay",
              "ingress TUSHARE_API_URL 指向录播代理（禁止真实 tushare）",
              f"实际 {env_of(ingress, 'TUSHARE_API_URL')!r}")

    wl = services.get("warehouse-load") or {}
    load_dockerfile = str((wl.get("build") or {}).get("dockerfile") or "")
    rep.check("warehouse/Dockerfile" in load_dockerfile,
              "warehouse-load 用 A2 的独立镜像 warehouse/Dockerfile（不塞进 ingest 镜像）",
              f"实际 {load_dockerfile!r}；Lead m01015：镜像职责单一，抓数与写库不共享攻击面")
    rep.check("/e2e/warehouse_load_once.sh" in str(wl.get("entrypoint") or ""),
              "warehouse-load entrypoint 跑 warehouse_load_once.sh",
              "A2 镜像 ENTRYPOINT=python -m warehouse.load；需覆盖以捕获退出码写 step-load.json")
    rep.check(env_of(wl, "QUALITY_REPORT_PATH") == "/state/quality.json",
              "warehouse-load QUALITY_REPORT_PATH=/state/quality.json（契约 §2）",
              f"实际 {env_of(wl, 'QUALITY_REPORT_PATH')!r}")
    report = services.get("ingest-report") or {}
    rep.check(any(v.endswith("ingest_report.py:/e2e/ingest_report.py:ro") for v in (report.get("volumes") or [])),
              "ingest-report 只读挂载 ingest_report.py",
              "第 4 步聚合脚本缺失，/state/ingest-report.json 不会生成")
    rep.check("/e2e/ingest_report.py" in str(report.get("command") or ""),
              "ingest-report 默认 command 跑 ingest_report.py",
              "契约 §1：报告由该步骤原子写")
    migrate = services.get("db-migrate") or {}
    migrate_cmd = str(migrate.get("command") or "")
    rep.check("infra/db/bootstrap.sh" in migrate_cmd and "infra/scripts/db-migrate.sh" in migrate_cmd,
              "db-migrate 走 A13 的同一迁移路径（bootstrap + db-migrate.sh）",
              "Lead m01015：禁止 compose 内手写 SQL；E2E 必须跑被发布的迁移路径")
    rep.check("bash infra/" not in migrate_cmd and "sh infra/db/bootstrap.sh" in migrate_cmd
              and "sh infra/scripts/db-migrate.sh" in migrate_cmd,
              "db-migrate 用 `sh` 调迁移脚本（postgres:16 镜像无 bash/node，A13 commit f269240）",
              "用 bash 调 db-migrate.sh 会在 postgres:16 里 `bash: not found` 直接挂；"
              "POSIX 化后必须继续用 sh（A13 infra/ci/check-posix-scripts.mjs 防回退）")
    rep.check("CREATE TABLE" not in base_text.upper().replace("CREATE TABLE IF", "CREATE TABLE IF"),
              "compose 不内联手写建表 SQL",
              "手写 DDL 会与 services/compliance 迁移分叉（今天已付过一次学费）")
    for name in ("db-migrate", "ingress", "warehouse-load", "ingest-report"):
        svc = services.get(name) or {}
        rep.check("seed" in (svc.get("profiles") or []), f"{name} 走 seed profile（不随默认栈常驻）",
                  f"{name} 未加 profile，会随默认栈常驻")
        rep.check(svc.get("restart") == "no", f"{name} restart=no（一次性任务）",
                  f"{name} restart={svc.get('restart')!r}，失败会被反复拉起")

    rep.check("RATE_LIMIT_IP_BURST" in (api.get("environment") or {}),
              "api E2E 栈放宽 burst 限流（防 12 条用例第 3 条撞 429 而非产品缺陷）",
              "未设置 RATE_LIMIT_IP_BURST：A0 默认 burst=10，serial 套件会 429 假红")
    rep.check("E2E_AUTH_TOKEN" in (api.get("environment") or {}),
              "api 透传 E2E_AUTH_TOKEN（A3 dev bearer；缺省空串 → 自选用例 SKIP，不假 FAIL）",
              "未把 E2E_AUTH_TOKEN 传进 api，A3 的 E2E_MODE dev bearer 无法生效，P0-08/09 会假 SKIP")
    rep.check("ENTITLEMENT_HOLD_CHECK" in (api.get("environment") or {}),
              "api 暴露 ENTITLEMENT_HOLD_CHECK 开关（hold 场景联调，默认 0）",
              "未迁移库上硬开 hold 会 500；必须由 E2E 显式置 1")

    # 6. 端口发布（preflight/浏览器从宿主机访问）
    for name in ("api", "web"):
        rep.check(bool((services.get(name) or {}).get("ports")), f"{name} 端口发布到宿主机",
                  "无 ports，宿主 preflight/浏览器访问不到")
    rep.check(bool(replay.get("ports")), "tushare-replay 端口发布（preflight 读 /__health）",
              "无 ports，preflight 无法读取 fixtures 完整性")

    # 7. 一次性 seed 服务「有显式 command」由 5b 已覆盖（ingress/warehouse-load/ingest-report）

    # 8. 交接依赖：Dockerfile 路径可注入但默认值指向真实实现
    expectations = {
        "api": "-services/api/Dockerfile",
        "web": "-web/h5/Dockerfile",
        "ingress": "-services/ingest/Dockerfile",
    }
    for name, needle in expectations.items():
        dockerfile = str(((services.get(name) or {}).get("build") or {}).get("dockerfile") or "")
        rep.check(needle in dockerfile, f"{name} 默认 Dockerfile 指向真实实现",
                  f"实际 {dockerfile!r}，应含 {needle}")

    # 9. record override 不得被 CI 误用，且必须显式要求 token
    rec_svc = (record.get("services") or {}).get("tushare-replay") or {}
    rep.check(env_of(rec_svc, "FIXTURE_MODE") == "record", "record override 切 record 模式",
              f"实际 {env_of(rec_svc, 'FIXTURE_MODE')!r}")
    rec_token = str(env_of(rec_svc, "TUSHARE_TOKEN") or "")
    rep.check(":?" in rec_token, "record override 强制要求 TUSHARE_TOKEN",
              "未使用 ${TUSHARE_TOKEN:?...}，缺 token 时会静默录制失败")
    rec_net = ((record.get("networks") or {}).get("app-net") or {})
    rep.check(rec_net.get("internal") is False, "record override 才允许出网",
              "record override 未显式 internal=false，录制会连不上真实接口")
    rec_mounts = [m for m in mounts_of(rec_svc) if m.get("target") == FIXTURES_DIR]
    rep.check(bool(rec_mounts) and rec_mounts[0].get("mode") == "rw", "record override fixtures 可写",
              "录制需要 rw 挂载")

    return rep.summary()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
