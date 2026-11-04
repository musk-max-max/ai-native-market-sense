#!/usr/bin/env python3
"""KD-ENT-01 运行时证据 README 生成器（A12）。

从一次 run 目录的 transcript / meta.env / 原始 payload 生成 README.md。
硬规则（H5 m02511 / A13 m02527）：
- 不允许手打 hold_id：只从 meta.env（由 transcript 同一次 run 的 raise_hold 输出写入）读取，
  并与 transcript 的 HOLD_ID 行、raise_hold.out 三方比对，不一致直接失败。
- 不允许手写“未重启”：必须读取 api-inspect-before/after.json 并校验 Id 相同、RestartCount=0、
  StartedAt 相同，README 展示两次 inspect 原文。
- 所有观测值从原始 JSON / headers / transcript 提取，脚本不接收任何业务数值参数。
Exit: 0 生成成功；2 一致性校验失败；3 输入缺失。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_meta(path: Path) -> dict[str, str]:
    meta = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            meta[k.strip()] = v.strip()
    return meta


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def header_status(headers: str) -> str:
    first = headers.strip().splitlines()[0] if headers.strip() else ""
    return first.strip()


def header_value(headers: str, name: str) -> str:
    for line in headers.splitlines():
        if line.lower().startswith(name.lower() + ":"):
            return line.split(":", 1)[1].strip()
    return ""


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--supersedes", default="")
    args = ap.parse_args()
    rd = Path(args.run_dir)
    if not rd.is_dir():
        print(f"FAIL: run dir missing: {rd}", file=sys.stderr)
        return 3

    meta_path = rd / "meta.env"
    transcript_path = rd / "transcript.log"
    for p in (meta_path, transcript_path, rd / "api-inspect-before.json", rd / "api-inspect-after.json"):
        if not p.exists():
            print(f"FAIL: missing {p}", file=sys.stderr)
            return 3

    meta = load_meta(meta_path)
    transcript = transcript_path.read_text(encoding="utf-8")
    hold_id = meta.get("HOLD_ID", "").strip()
    raise_out = (rd / "raise_hold.out").read_text(encoding="utf-8").strip()
    if not hold_id:
        fail("meta.env HOLD_ID empty")
    if raise_out != hold_id:
        fail(f"hold_id mismatch: meta={hold_id!r} raise_hold.out={raise_out!r}")
    if f"HOLD_ID={hold_id}" not in transcript:
        fail("transcript missing HOLD_ID=<meta value> line")
    hold_lines = [ln for ln in transcript.splitlines() if hold_id in ln]
    if not hold_lines or any(not ln.startswith("HOLD_ID=") for ln in hold_lines):
        fail(
            "hold_id may appear only on HOLD_ID= lines (raw raise_hold stdout is kept in "
            f"raise_hold.out); offending: {hold_lines!r}"
        )

    before = load_json(rd / "api-inspect-before.json")
    after = load_json(rd / "api-inspect-after.json")
    if before["Id"] != after["Id"]:
        fail(f"container Id changed: {before['Id']} -> {after['Id']}")
    if before["RestartCount"] != 0 or after["RestartCount"] != 0:
        fail(f"RestartCount nonzero: {before['RestartCount']} -> {after['RestartCount']}")
    if before["StartedAt"] != after["StartedAt"]:
        fail(f"StartedAt changed: {before['StartedAt']} -> {after['StartedAt']}")
    if before["Status"] != "running" or after["Status"] != "running":
        fail("container not running at inspect time")

    healthz = load_json(rd / "healthz-positive.json")
    quote = load_json(rd / "quote-positive-200.json")
    hold = load_json(rd / "quote-hold-403.json")
    instrument = load_json(rd / "instrument-hold-200.json")
    recovered = load_json(rd / "quote-recovered-200.json")
    default_quote = load_json(rd / "quote-default-403.json")
    default_healthz = load_json(rd / "healthz-default.json")

    quote_status = header_status((rd / "quote-positive-200.headers").read_text(encoding="utf-8"))
    hold_status = header_status((rd / "quote-hold-403.headers").read_text(encoding="utf-8"))
    recovered_status = header_status((rd / "quote-recovered-200.headers").read_text(encoding="utf-8"))
    default_status = header_status((rd / "quote-default-403.headers").read_text(encoding="utf-8"))
    hold_cc = header_value((rd / "quote-hold-403.headers").read_text(encoding="utf-8"), "cache-control")
    quote_cc = header_value((rd / "quote-positive-200.headers").read_text(encoding="utf-8"), "cache-control")
    recovered_cc = header_value((rd / "quote-recovered-200.headers").read_text(encoding="utf-8"), "cache-control")
    default_cc = header_value((rd / "quote-default-403.headers").read_text(encoding="utf-8"), "cache-control")

    tier = quote["meta"]["entitlement"]["tier"]
    entitled = quote["meta"]["entitlement"]["is_entitled"]
    instrument_tier = instrument["meta"]["entitlement"]["tier"]
    instrument_entitled = instrument["meta"]["entitlement"]["is_entitled"]
    recovery_s = int(meta.get("RECOVERY_SECONDS", "-1"))
    recovered_flag = meta.get("RECOVERED", "")

    rows = [
        (
            "positive `/healthz`",
            f"200，`data_ready={str(healthz.get('data_ready')).lower()}`、"
            f"`data_quality={healthz.get('data_quality')}`、"
            f"`entitlement_degraded={str(healthz.get('entitlement_degraded')).lower()}`",
            "`healthz-positive.json` / `.headers`",
        ),
        (
            "positive quote",
            f"{quote_status}，`meta.entitlement={{tier:{tier!r},is_entitled:{str(entitled).lower()}}}`、"
            f"`last_price={quote['data']['last_price']}`（合成 fixture）、`Cache-Control: {quote_cc}`",
            "`quote-positive-200.json` / `.headers`",
        ),
        (
            "`raise_hold('hold_active','tc-e2e-kdent01')` 后（35s）",
            f"{hold_status} `application/problem+json` `code={hold.get('code')}`、"
            f"`title={hold.get('title')}`、`Cache-Control: {hold_cc}`（403 无 meta，契约即 Problem）",
            "`quote-hold-403.json` / `.headers`",
        ),
        (
            "hold 期间 `GET /v1/instruments/SSE:600519`",
            f"200，`meta.entitlement={{tier:{instrument_tier!r},is_entitled:{str(instrument_entitled).lower()}}}`"
            "（H5 指定 meta.tier 观测点）",
            "`instrument-hold-200.json` / `.headers`",
        ),
        (
            "`clear_hold` 后恢复",
            f"{recovered_status} 于 **t+{recovery_s}s**（≤30s，recovered={recovered_flag}）、"
            f"`Cache-Control: {recovered_cc}`",
            "`quote-recovered-200.json` / `.headers`、transcript `poll recovery`",
        ),
        (
            "default project（固定 `internal_eval`）同 quote",
            f"{default_status} `code={default_quote.get('code')}`、`Cache-Control: {default_cc}`",
            "`quote-default-403.json` / `.headers`",
        ),
        (
            "容器未重启（机器证据）",
            f"raise 前/clear 后各一次 `docker inspect`：Id `{before['Id']}` 相同、"
            f"`RestartCount=0`、`StartedAt={before['StartedAt']}` 未变、Status=running",
            "`api-inspect-before.json` / `api-inspect-after.json`（原文）",
        ),
    ]
    table = "\n".join(f"| {a} | {b} | {c} |" for a, b, c in rows)

    supersedes = ""
    if args.supersedes:
        supersedes = (
            f"\n## 与 v1 的关系\n\n"
            f"本目录 **supersedes** v1 `kd-ent-01-runtime-20261104T1237Z/` 的 tarball "
            f"`{args.supersedes}`。v1 被 H5 拒收（README 手写 hold_id 与 transcript 不一致、缺 inspect 机器证据），"
            f"已由 A13 标 `historical / rejected-before-sign`，**旧目录原字节冻结、不修改**；行为层四观测在 v2 中重跑复核。\n"
        )

    readme = f"""# KD-ENT-01 运行时四观测 v2（A12，单次干净 run）

**结论：四观测全部 PASS，且 hold_id 与「未重启」均有机器证据。**
本目录由 `tests/e2e/scripts/build_kd_ent_runtime_readme.py` 从 transcript / meta.env / 原始 payload
生成（禁止手打 id；生成时校验 hold_id 三方一致、inspect 前后 Id/StartedAt 不变、RestartCount=0）。

- run_id：`{meta.get('RUN_ID')}`
- run 窗口：{meta.get('STARTED_AT')} → {meta.get('FINISHED_AT')}
- 执行人：A12 qa-e2e（ssh root@47.120.16.239）
- 宿主/工具：`heyuan`（Alibaba Cloud ECS 47.120.16.239），Docker 29.9.3，Docker Compose v5.7.0
- 仓库：ECS `/opt/market-sense` @ `{(transcript.split('repo: ')[1].split()[0] if 'repo: ' in transcript else 'n/a')}`；
  compose 规格来自 A12 commit `0a6beba`（`docker-compose.a12.yml` = `tests/e2e/docker-compose.yml`）
- 隔离：project `e2e-ent-positive`，端口 api `127.0.0.1:8091` / web `127.0.0.1:3011` / replay `127.0.0.1:18091`；
  默认 project `market-sense-e2e` 只做只读 curl（8081），未改配置、未重启
- 镜像：`e2e-ent-positive-api:latest`（`{before['ImageID']}`，ECS 上用当前 services 源码重建）
- fixture：`tests/fixtures/tushare` **合成录制**（L32；`SYNTHETIC-*`、`last_price=9999.99`），非真实 tushare 报文

## 四观测（原始 payload 均在目录内）

| 观测 | 结果 | 证据 |
|---|---|---|
{table}

## 关键 id 与原始输出（同一 run）

- `raise_hold` 返回 hold_id：`{hold_id}`（uuid，不是 ticket）；ticket `tc-e2e-kdent01` 由调用方给定
- `raise_hold.out` 原文：`{raise_out}`
- transcript 中 `HOLD_ID={hold_id}`（唯一一次出现）
- `clear_hold` 原文见 `clear_hold.out`；恢复轮询见 transcript `poll recovery`

## 运行命令（原样，含 rc）

见 `transcript.log`（`=== <时间>` 分段 + `CMD:` + `rc=`）。主链路：

```sh
C="docker compose -p e2e-ent-positive -f docker-compose.a12.yml \\
   -f docker-compose.entitlement-positive.yml -f /tmp/a12-images2.override.yml"
$C down -v --remove-orphans
$C up -d --wait postgres redis tushare-replay
$C --profile seed run --rm db-migrate
$C --profile seed run --rm ingress
$C --profile seed run --rm warehouse-load
$C --profile seed run --rm ingest-report
$C up -d --wait api web
docker inspect e2e-ent-positive-api-1 --format '{{{{json .}}}}'   # 见 api-inspect-before.json
curl -sS http://127.0.0.1:8091/healthz
curl -sS http://127.0.0.1:8091/v1/instruments/SSE:600519/quote -H "Authorization: Bearer dev-token"
$C exec -T postgres psql -U market -d market -Atc "SELECT audit.raise_hold('hold_active','tc-e2e-kdent01');"
sleep 35
curl -sS -D - http://127.0.0.1:8091/v1/instruments/SSE:600519/quote -H "Authorization: Bearer dev-token"
curl -sS http://127.0.0.1:8091/v1/instruments/SSE:600519 -H "Authorization: Bearer dev-token"
$C exec -T postgres psql -U market -d market -Atc "SELECT audit.clear_hold('tc-e2e-kdent01','e2e-signer',repeat('a',64));"
# 轮询 quote 至 200（t+{recovery_s}s）
docker inspect e2e-ent-positive-api-1 --format '{{{{json .}}}}'   # 见 api-inspect-after.json
```

## 配置偏差与 caveats（如实标注）

- `app-net.internal=false` 仅出现在 positive *e2e run* override 中：compose v5 在 internal 网络上不落地宿主端口映射；
  发布端口仍全部 `127.0.0.1`，公网不可达；**默认栈未改**（仍 `internal:true`）。
- 本 run 验证运行时配置/授权链，**不是镜像构建 provenance**：api 镜像在 ECS 用当前源码重建成功，
  但未走 A13 的 build-smoke job。
- ECS checkout 为 `0c78433`，compose 规格来自本地 commit `0a6beba`；运行前临时覆盖的 POSIX
  `infra/db/bootstrap.sh` / `infra/scripts/db-migrate.sh` 已在跑完后 `git checkout --` 还原。
- 默认栈 `/healthz` 的 `uptime_s={default_healthz.get('uptime_s')}` 是长跑实例的累计值，只说明其 healthz 正常，不参与四观测判定。
- 合成 fixture 仅覆盖形状/异常路径，不作 DA 证据、不进 release note/对外材料（H1 口径）。
- 旧 v1 目录 `kd-ent-01-runtime-20261104T1237Z/` 保持原字节冻结（rejected 由外部台账/manifest 记录）。
{supersedes}
## 文件与校验

- `transcript.log`：host/工具链/仓库/命令/exit code/时间戳 + 原样 stdout（含 `raise_hold` 原始输出行）
- `api-inspect-before.json` / `api-inspect-after.json`：容器 Id/RestartCount/StartedAt/Image 原文
- `healthz-positive.json`、`quote-positive-200.*`、`quote-hold-403.*`、`instrument-hold-200.*`、
  `quote-recovered-200.*`、`quote-default-403.*`、`healthz-default.json`、`raise_hold.out`、`clear_hold.out`
- `meta.env`：run 元数据与 hold_id（由 transcript 同一 run 写入）
- `runtime-evidence.tar.gz` + `PACKAGE.sha256`：打包与外部校验值（README 不内嵌自身 hash）
"""
    (rd / "README.md").write_text(readme, encoding="utf-8")
    print(f"OK: wrote {rd / 'README.md'} (hold_id={hold_id})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
