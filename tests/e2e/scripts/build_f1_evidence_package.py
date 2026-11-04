#!/usr/bin/env python3
"""H4/H5 #5 证据包打包器：从一次 run 的逐场景 verdict.json 生成包级产物。

原则（H5/H4 定版要求）：
- 一个证据包 = 一次 run：所有 verdict 的 run_id / batch_started_at 必须一致，否则拒绝打包。
- 单场景 verdict 不写跨场景 coverage；coverage 只由本脚本从逐场景结果算出，写进 evidence-manifest.json。
- README 是报告；TRANSCRIPTS.md 是五份 transcript.log 的索引（两者不允许字节相同）。
- 包内每个文件 repo-relative path + sha256 + size（不含 manifest 自身）；tar 解包集合与 files 一一对应；
  包外 PACKAGE.sha256 给 tar.gz 与 manifest 自己的 sha256。
- 任一场景非 PASS / 场景缺失 / run_id 不一致 → exit 1，不生成「看起来 PASS」的包。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import socket
import sys
import tarfile
from datetime import datetime, timezone, timedelta

SCENARIOS = [
    "expired",
    "hold_active",
    "hold_stale",
    "restricted_malformed_403",
    "unauthorized_config",
]
CST = timezone(timedelta(hours=8))


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_scenarios(run_dir: str) -> list[dict]:
    out = []
    run_ids, batch_starts = set(), set()
    for name in SCENARIOS:
        vpath = os.path.join(run_dir, name, "verdict.json")
        dpath = os.path.join(run_dir, name, f"dom-{name}.json")
        tpath = os.path.join(run_dir, name, "transcript.log")
        for p in (vpath, dpath, tpath):
            if not os.path.isfile(p):
                sys.exit(f"缺少 {p}（场景 {name} 不可打包）")
        verdict = json.load(open(vpath, encoding="utf-8"))
        dom = json.load(open(dpath, encoding="utf-8"))
        if verdict.get("overall") != "PASS":
            sys.exit(f"场景 {name} verdict={verdict.get('overall')!r}，拒绝打包；先修证据，不要写 PASS")
        if "coverage" in verdict:
            sys.exit(f"场景 {name} verdict 仍带跨场景 coverage 字段；per-scenario 只许陈述本场景")
        run_ids.add(verdict.get("run_id"))
        batch_starts.add(verdict.get("batch_started_at"))
        out.append({"name": name, "verdict": verdict, "dom": dom, "transcript": tpath})
    if len(run_ids) != 1 or None in run_ids or "unset-run" in run_ids:
        sys.exit(f"run_id 不一致/缺失：{sorted(map(str, run_ids))}；证据包必须单次 run 生成，禁止拼代际")
    if len(batch_starts) != 1 or None in batch_starts or "" in batch_starts:
        sys.exit(f"batch_started_at 不一致/缺失：{sorted(map(str, batch_starts))}")
    return out


def quote_example(scenarios: list[dict]) -> dict:
    for s in scenarios:
        rule = (s["verdict"].get("rules") or {}).get("page_copy_matches_api")
        if rule:
            return {
                "scenario": s["name"],
                "title": (s["verdict"]["rules"]["problem_copy_present"].get("title")),
                "detail": (s["verdict"]["rules"]["problem_copy_present"].get("detail")),
                "page_notice_textContent": rule.get("page_notice_textContent"),
                "page_notice_innerText": rule.get("page_notice_innerText"),
                "expected": rule.get("expected_textContent"),
            }
    return {}


def render_readme(scenarios: list[dict], run_id: str, started: str, finished: str, rel_run: str) -> str:
    now = datetime.now(CST).isoformat(timespec="seconds")
    coverage = ", ".join(f"{s['name']}={s['verdict']['overall']}" for s in scenarios)
    q = quote_example(scenarios)
    lines = [
        "# A12 · H4/H5 11-12 #5 证据包（fail-closed DOM + 页面文案）",
        "",
        f"- run_id：`{run_id}`（单次 run 全量采集，非拼包）",
        f"- run_started_at：{started}；run_finished_at：{finished}",
        f"- 打包时间：{now}；主机：{socket.gethostname()} / {platform.platform()}",
        f"- 证据根目录：`{rel_run}/`",
        f"- 场景覆盖（包级计算）：{coverage}",
        "- 本包为 A12 独立跑出的 transcript + api.json + page-*.png；A7 自测不作为验收证据。",
        "- 真实 tushare 报文未进入仓库（L32）：replay 数据由 "
        "`tests/fixtures/tushare/synthetic/build_recordings.py` 合成生成；"
        "`restricted_malformed_403` 在浏览器网络层注入 403，真实 API 不变。",
        "",
        "## 场景结论",
        "",
        "| 场景 | verdict | quote-price | stale-badge | notice | page_copy_matches_api |",
        "|---|---|---|---|---|---|",
    ]
    for s in scenarios:
        d, v = s["dom"], s["verdict"]
        counts = d.get("counts") or {}
        copy_rule = (v.get("rules") or {}).get("page_copy_matches_api")
        copy_cell = "N/A（整页错误态）" if copy_rule is None else ("PASS" if copy_rule.get("ok") else "FAIL")
        lines.append(f"| {s['name']} | {v['overall']} | {counts.get('quotePrice')} | "
                     f"{counts.get('quoteStaleBadge')} | {counts.get('entitlementNotice')} | {copy_cell} |")
    lines += ["", "## 文案判定口径（与实现同一函数）", ""]
    if q:
        lines += [
            f"以 `{q['scenario']}` 实测为例：",
            "",
            f"- API Problem：`title` = `{q['title']}`，`detail` = `{q['detail']}`",
            f"- 页面 `entitlement-notice.textContent` = `{q['page_notice_textContent']}`"
            "（title/detail 直接拼接，**无分隔符**）",
            f"- 页面 `entitlement-notice.innerText` = {json.dumps(q['page_notice_innerText'], ensure_ascii=False)}"
            "（title/detail 两段换行，仅人工核对）",
            "",
            "判定（`tests/e2e/scripts/collect_f1_dom_evidence.py` 的 `page_copy_matches_api`）：",
            "",
            "```python",
            "expected = Problem.title + Problem.detail      # 无分隔符",
            "actual   = notice.textContent.strip()           # 不用 innerText",
            "ok = actual == expected and (actual.replace(title, '', 1).replace(detail, '', 1).strip() == '')",
            "```",
            "",
            "即：`textContent` 去首尾空白后严格等于 `title+detail`，且去掉两段后不剩任何文本；"
            "页面不得自造第三句、不得改写标点。`innerText` 的换行不是契约。",
        ]
    else:
        lines.append("本次 run 无普通受限场景的文案规则可引用。")
    lines += [
        "",
        "## 判定口径（其余）",
        "",
        "- 受限页 `quote-price` 与 `quote-stale-badge` 计数必须为 0；正文不得出现金额形状的「元」、`%`、`小时`。",
        "- fail-closed DOM 扫描：价格/涨跌 testid 带任何文本即失败；数字类节点、伪元素、骨架屏一律失败；"
        "hidden/opacity:0 **不算**「没有」。",
        "- `restricted_malformed_403`：403 无合法 `title`/`detail` → 整页中性错误态（`error-banner` 可见、"
        "notice 0、价格 0）；`injected_403_malformed` 校验注入确实发生。",
        "- 任一场景非 PASS 则本包不生成；场景缺失/run_id 不一致同样拒绝打包。",
        "",
        "## 完整性",
        "",
        "- `evidence-manifest.json`：run_id / run_started_at / run_finished_at / coverage（包级计算）+ "
        "包内每个文件的 repo-relative path + sha256 + size（不含 manifest 自身）。",
        "- `README.tar.gz`：解包后文件集合与 `manifest.files` 一一对应；包外 `PACKAGE.sha256` 给 "
        "tar.gz 与 manifest 自己的 sha256。",
        "- `TRANSCRIPTS.md` 是五份 `transcript.log` 的索引，不与 README 同文。",
        "",
        "## Residual（未验证项，不隐去）",
        "",
        "1. **不是 docker 真栈证据**：本轮全部为本机原生进程（api 8082/8083/8084 + web 3001/3003/3004），"
        "镜像构建未验证（Dlv-4；见 `tests/e2e/ci/BUILD-SMOKE.md` 与 RUNBOOK §0）。",
        "2. **replay 是 L32 合成录制**：`tests/fixtures/tushare/recordings/` 由 "
        "`synthetic/build_recordings.py` 生成，无真实 tushare 报文；不得作为数据准确性/DA 证据，"
        "不进入 release note/对外材料。",
        "3. **hold 控制行由 admin DSN 造**：`audit.raise_hold` / `clear_hold`（doc_sha 64 位小写 hex）在 "
        "A13 已迁移的 E2E 库执行，采集后已恢复 `hold=false`、`last_reconciled_at` 新鲜；"
        "生产侧 hold 操作路径未验证。",
        "",
        "`#5` 的 PASS 由 H5 记录；A12 不签，只提供可复核的 evidence。",
        "",
    ]
    return "\n".join(lines)


def render_index(scenarios: list[dict], run_id: str, rel_run: str) -> str:
    lines = [
        "# TRANSCRIPTS 索引（A12 · #5 证据 run）",
        "",
        f"- run_id：`{run_id}`（索引由包级打包器从逐场景 verdict 生成，不是 transcript 正文）",
        f"- 根目录：`{rel_run}/`",
        "",
        "| 场景 | verdict | generated_at | transcript | playwright exit code |",
        "|---|---|---|---|---|",
    ]
    for s in scenarios:
        v = s["verdict"]
        rel = os.path.relpath(s["transcript"], os.getcwd())
        pw = (v["rules"].get("playwright_P0_06_P0_12") or {}).get("exit_code")
        exit_cell = "n/a（malformed：网络层注入，不跑 P0-06/P0-12）" if pw is None else f"`{pw}`"
        lines.append(f"| {s['name']} | {v['overall']} | {v.get('generated_at')} | `{rel}` | {exit_cell} |")
    lines += [
        "",
        "每份 transcript 头部字段：`run_id` / `batch_started_at` / `started_at` / `host` / `uname` / "
        "`node` / `python` / `cwd` / `command` / `env（脱敏）` / `finished_at` / `exit code`。",
        "",
    ]
    return "\n".join(lines)


def collect_files(run_dir: str) -> list[dict]:
    files = []
    for dirpath, dirnames, filenames in os.walk(run_dir):
        dirnames.sort()
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, run_dir)
            if rel in ("evidence-manifest.json", "README.tar.gz", "PACKAGE.sha256"):
                continue
            files.append({"path": os.path.relpath(path, os.getcwd()),
                          "sha256": sha256_file(path), "size": os.path.getsize(path)})
    files.sort(key=lambda x: x["path"])
    return files


def build(run_dir: str, run_started_at: str, run_finished_at: str) -> None:
    run_dir = os.path.abspath(run_dir)
    repo_root = os.getcwd()
    rel_run = os.path.relpath(run_dir, repo_root)
    if not rel_run.startswith("tests/e2e/evidence/"):
        sys.exit(f"run-dir 必须在 <repo>/tests/e2e/evidence/ 下（cwd={repo_root}）")
    scenarios = load_scenarios(run_dir)
    run_id = scenarios[0]["verdict"]["run_id"]

    readme = render_readme(scenarios, run_id, run_started_at, run_finished_at, rel_run)
    index = render_index(scenarios, run_id, rel_run)
    open(os.path.join(run_dir, "README.md"), "w", encoding="utf-8").write(readme)
    open(os.path.join(run_dir, "TRANSCRIPTS.md"), "w", encoding="utf-8").write(index)

    files = collect_files(run_dir)
    manifest = {
        "schema_version": 2,
        "run_id": run_id,
        "run_started_at": run_started_at,
        "run_finished_at": run_finished_at,
        "assembled": False,
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "run_root": rel_run,
        "coverage": {s["name"]: s["verdict"]["overall"] for s in scenarios},
        "scenarios": [{"scenario": s["name"], "verdict": s["verdict"]["overall"],
                       "generated_at": s["verdict"].get("generated_at"),
                       "run_id": s["verdict"].get("run_id")} for s in scenarios],
        "file_count": len(files),
        "files": files,
    }
    manifest_path = os.path.join(run_dir, "evidence-manifest.json")
    open(manifest_path, "w", encoding="utf-8").write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    tar_path = os.path.join(run_dir, "README.tar.gz")
    with tarfile.open(tar_path, "w:gz") as tar:
        for s in scenarios:
            tar.add(os.path.join(run_dir, s["name"]), arcname=s["name"])
        for name in ("TRANSCRIPTS.md", "README.md", "evidence-manifest.json"):
            tar.add(os.path.join(run_dir, name), arcname=name)

    with tarfile.open(tar_path, "r:gz") as tar:
        members = {m.name for m in tar.getmembers() if m.isfile()}
    expected = {os.path.relpath(f["path"], rel_run) for f in files} | {"evidence-manifest.json"}
    if members != expected:
        sys.exit(f"tar 内容与 manifest 不一致：仅 tar={sorted(members - expected)}，"
                 f"仅 manifest={sorted(expected - members)}")
    if sha256_file(os.path.join(run_dir, "README.md")) == sha256_file(os.path.join(run_dir, "TRANSCRIPTS.md")):
        sys.exit("README.md 与 TRANSCRIPTS.md 字节相同；TRANSCRIPTS 必须是索引")

    tar_sha = sha256_file(tar_path)
    manifest_sha = sha256_file(manifest_path)
    receipt = (
        f"# PACKAGE.sha256（包外 receipt）\n"
        f"# run_id={run_id}\n"
        f"# run_started_at={run_started_at}\n"
        f"# run_finished_at={run_finished_at}\n"
        f"# 验包：tar -xzf README.tar.gz && 逐条对照 evidence-manifest.json\n"
        f"{tar_sha}  README.tar.gz\n"
        f"{manifest_sha}  evidence-manifest.json\n"
    )
    open(os.path.join(run_dir, "PACKAGE.sha256"), "w", encoding="utf-8").write(receipt)
    print(f"OK: {rel_run} · run_id={run_id} · files={len(files)} · tar={os.path.getsize(tar_path)}B\n"
          f"  README.tar.gz={tar_sha}\n  evidence-manifest.json={manifest_sha}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--run-started-at", required=True)
    ap.add_argument("--run-finished-at", required=True)
    args = ap.parse_args()
    build(args.run_dir, args.run_started_at, args.run_finished_at)
