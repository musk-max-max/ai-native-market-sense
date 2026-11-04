#!/usr/bin/env python3
"""H4 11-12 #5 证据采集器（A12 写域）：fail-closed DOM 数值泄漏 + 页面文案 vs API copy。

一次运行产出一个场景目录（expired / unauthorized_config ...），包含：
  - api.json              403 Problem（title/detail/headers）+ instrument 200 观测
  - dom-<label>.json      页面 testid/数字扫描/文案快照（由 capture-f1-dom.mjs 采集）
  - page-<label>.png      全页截图
  - page-<label>.html     DOM 快照
  - playwright-<label>.json  P0-06/P0-12 的结构化结果（含 exit code）
  - transcript.log        A11 v2 格式的单条 transcript（host/工具链/命令/exit code/时间戳）
  - verdict.json          判定明细（PASS/FAIL + 每条规则的证据）

判定口径：
  1. DOM：价格/涨跌 testid 带文本即失败；数字类节点/伪元素/骨架屏一律失败（hidden 不算没有）。
  2. 文案：页面 entitlement-notice 必须**逐字节包含** API Problem 的 title 与 detail，
     且去掉这两段后不剩任何文案（页面不得自造第三句）；四条原因另有 hold_active/hold_stale
     场景需 control 表，未迁移时本脚本明确记 BLOCKED，不冒领 PASS。
  3. 免责与不可用提示必须可见（DOM 快照里有 disclaimer + entitlement-notice）。

退出码：0 全 PASS / 1 任一 FAIL / 2 环境不可达（FAIL，不 skip）。
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
E2E_ROOT = os.path.dirname(HERE)
EVIDENCE_ROOT = os.path.join(E2E_ROOT, "evidence", "11-12-f1-dom-20261104")
REPO_ROOT = os.path.dirname(os.path.dirname(E2E_ROOT))
INSTRUMENT = os.environ.get("EVIDENCE_INSTRUMENT", "SSE:600519")
AUTH_TOKEN = os.environ.get("E2E_AUTH_TOKEN", "dev-token")


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def http_json(url: str, token: str) -> tuple[int, dict, dict]:
    request = urllib.request.Request(
        url, headers={"Accept": "application/json", "Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8")), dict(response.headers)
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"raw": raw}
        return error.code, body, dict(error.headers)
    except (urllib.error.URLError, TimeoutError) as error:
        raise SystemExit(f"[FAIL] API 不可达：{error}")


def run(cmd: list[str], env: dict, cwd: str) -> tuple[int, str]:
    completed = subprocess.run(cmd, env=env, cwd=cwd, capture_output=True, text=True)
    return completed.returncode, (completed.stdout or "") + (completed.stderr or "")


def main() -> int:
    web_url = os.environ.get("EVIDENCE_WEB_URL", "http://127.0.0.1:3001")
    api_url = os.environ.get("EVIDENCE_API_URL", "http://127.0.0.1:8082")
    label = os.environ.get("EVIDENCE_LABEL", "restricted")
    out_dir = os.environ.get("EVIDENCE_OUT_DIR")
    if not out_dir:
        print("缺少 EVIDENCE_OUT_DIR", file=sys.stderr)
        return 2
    os.makedirs(out_dir, exist_ok=True)

    started_at = now()
    transcript: list[str] = []
    steps: list[dict] = []
    transcript.append("# A12 11-12 #5 fail-closed DOM 证据 transcript")
    transcript.append(f"# label: {label}")
    transcript.append(f"# started_at: {started_at}  (Asia/Shanghai)")
    transcript.append(f"# host: {socket.gethostname()}  uname: {platform.platform()}")
    node = shutil.which("node")
    node_version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip() if node else "missing"
    transcript.append(f"# node: {node_version}  python: {platform.python_version()}")
    transcript.append(f"# cwd: {REPO_ROOT}")
    transcript.append(f"# web: {web_url}  api: {api_url}  instrument: {INSTRUMENT}")

    def record(step: str, command: str, code: int, output: str, extra: str = "") -> None:
        steps.append({"step": step, "command": command, "exit_code": code})
        transcript.append("")
        transcript.append(f"## {step}")
        transcript.append(f"# started_at: {now()}")
        transcript.append(f"# command: {command}")
        if extra:
            transcript.append(f"# env: {extra}")
        transcript.append("# --- stdout/stderr begin ---")
        transcript.extend((output.rstrip() or "<empty>").splitlines())
        transcript.append("# --- stdout/stderr end ---")
        transcript.append(f"# exit code: {code}")
        transcript.append(f"# finished_at: {now()}")

    # 1) API 观测：403 Problem + instrument 200
    quote_status, quote_body, quote_headers = http_json(
        f"{api_url}/v1/instruments/{INSTRUMENT}/quote", AUTH_TOKEN
    )
    base_status, base_body, base_headers = http_json(
        f"{api_url}/v1/instruments/{INSTRUMENT}", AUTH_TOKEN
    )
    api_observation = {
        "quote_status": quote_status,
        "quote_body": quote_body,
        "quote_headers": {k.lower(): v for k, v in quote_headers.items()},
        "instrument_status": base_status,
        "instrument_body": base_body,
    }
    with open(os.path.join(out_dir, "api.json"), "w", encoding="utf-8") as handle:
        json.dump(api_observation, handle, ensure_ascii=False, indent=2)
    record(
        "api",
        f"GET {api_url}/v1/instruments/{INSTRUMENT} (+ /quote)",
        quote_status,
        json.dumps({"quote": quote_body, "instrument_status": base_status}, ensure_ascii=False),
    )

    # 2) 页面 DOM 采集（Playwright）
    capture_env = dict(os.environ)
    capture_env.update({
        "EVIDENCE_WEB_URL": web_url,
        "EVIDENCE_OUT_DIR": out_dir,
        "EVIDENCE_LABEL": label,
        "EVIDENCE_INSTRUMENT": INSTRUMENT,
    })
    capture_code, capture_out = run(
        [node, os.path.join(HERE, "capture-f1-dom.mjs")], capture_env, REPO_ROOT
    )
    record("dom-capture", "node tests/e2e/scripts/capture-f1-dom.mjs", capture_code, capture_out)
    dom_path = os.path.join(out_dir, f"dom-{label}.json")
    dom = json.load(open(dom_path, encoding="utf-8")) if os.path.exists(dom_path) else {}

    # 3) Playwright P0-06/P0-12（断言真源在 spec，evidence 只复核）
    report_path = os.path.join(out_dir, f"playwright-{label}.json")
    pw_env = dict(os.environ)
    pw_env.update({
        "E2E_BASE_URL": web_url,
        "E2E_AUTH_TOKEN": AUTH_TOKEN,
        "E2E_SKIP_PREFLIGHT": "1",
        "E2E_ENTITLEMENT_MATRIX": os.environ.get("E2E_ENTITLEMENT_MATRIX", "restricted"),
        "E2E_FAILCLOSED_SCENARIO": "1",
        "PLAYWRIGHT_JSON_OUTPUT_NAME": report_path,
    })
    pw_code, pw_out = run(
        ["npx", "playwright", "test", "-g", "E2E-P0-06|E2E-P0-12",
         "--reporter=json", "--workers=1"],
        pw_env,
        E2E_ROOT,
    )
    record(
        "playwright-P0-06-P0-12",
        "EVIDENCE_BASE_URL=<web> E2E_FAILCLOSED_SCENARIO=1 npx playwright test -g 'E2E-P0-06|E2E-P0-12'",
        pw_code,
        pw_out[-4000:],
        f"E2E_BASE_URL={web_url} E2E_ENTITLEMENT_MATRIX={pw_env['E2E_ENTITLEMENT_MATRIX']}",
    )

    # 4) 判定
    api_title = str(quote_body.get("title", ""))
    api_detail = str(quote_body.get("detail", ""))
    notice = (dom.get("entitlementNotice") or {}).get("text") or ""
    notice_text = " ".join(notice.split())
    title_ok = bool(api_title) and api_title in notice_text
    detail_ok = bool(api_detail) and api_detail in notice_text
    leftover = notice_text.replace(api_title, "", 1).replace(api_detail, "", 1).strip()
    copy_ok = title_ok and detail_ok and leftover == ""
    dom_ok = bool(dom) and not dom.get("leaks") and dom.get("disclaimer") is not None \
        and dom.get("entitlementNotice") is not None
    playwright_ok = pw_code == 0
    verdict = {
        "label": label,
        "generated_at": now(),
        "rules": {
            "quote_403": {
                "ok": quote_status == 403,
                "observed": quote_status,
                "expected": "403（restricted 档）",
            },
            "problem_copy_present": {
                "ok": bool(api_title and api_detail),
                "title": api_title,
                "detail": api_detail,
            },
            "page_copy_matches_api": {
                "ok": copy_ok,
                "page_notice": notice_text,
                "missing_title": not title_ok,
                "missing_detail": not detail_ok,
                "extra_text": leftover,
            },
            "dom_no_numeric_leak": {
                "ok": bool(dom_ok),
                "leaks": dom.get("leaks", []),
                "numericTestids": dom.get("numericTestids", []),
                "skeleton_present": dom.get("skeletonPresent"),
            },
            "disclaimer_and_notice_visible": {
                "ok": dom.get("disclaimer") is not None and dom.get("entitlementNotice") is not None,
                "disclaimer": dom.get("disclaimer"),
                "entitlement_notice": dom.get("entitlementNotice"),
            },
            "playwright_P0_06_P0_12": {
                "ok": playwright_ok,
                "exit_code": pw_code,
                "report": os.path.basename(report_path),
            },
        },
    }
    verdict["overall"] = "PASS" if all(rule.get("ok") for rule in verdict["rules"].values()) else "FAIL"
    # 覆盖度以证据根目录下已存在的 verdict.json 为准，不靠单次运行的自我声明（H4：不冒领 PASS）。
    expected = ["expired", "hold_active", "hold_stale", "unauthorized_config"]
    covered = {label: verdict["overall"]}
    if os.path.isdir(EVIDENCE_ROOT):
        for entry in sorted(os.listdir(EVIDENCE_ROOT)):
            path = os.path.join(EVIDENCE_ROOT, entry, "verdict.json")
            if os.path.isfile(path) and entry != label:
                try:
                    with open(path, encoding="utf-8") as handle:
                        covered[entry] = json.load(handle).get("overall")
                except (OSError, json.JSONDecodeError):
                    covered[entry] = "INVALID"
    verdict["scenario"] = label
    verdict["coverage"] = {
        "expected": expected,
        "covered": covered,
        "blocked": {
            name: "BLOCKED：该场景未采集（无 verdict.json）"
            for name in expected
            if name not in covered
        },
    }
    with open(os.path.join(out_dir, "verdict.json"), "w", encoding="utf-8") as handle:
        json.dump(verdict, handle, ensure_ascii=False, indent=2)

    transcript.append("")
    transcript.append("## verdict")
    for name, rule in verdict["rules"].items():
        transcript.append(f"- {name}: {'PASS' if rule.get('ok') else 'FAIL'}  {json.dumps(rule, ensure_ascii=False)}")
    transcript.append(f"- overall: {verdict['overall']}")
    transcript.append(f"- coverage: {json.dumps(verdict['coverage'], ensure_ascii=False)}")
    transcript.append(f"# finished_at: {now()}")
    with open(os.path.join(out_dir, "transcript.log"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(transcript) + "\n")

    print(f"[{verdict['overall']}] {label} → {out_dir}")
    for name, rule in verdict["rules"].items():
        print(f"  {'PASS' if rule.get('ok') else 'FAIL'}  {name}")
    return 0 if verdict["overall"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
