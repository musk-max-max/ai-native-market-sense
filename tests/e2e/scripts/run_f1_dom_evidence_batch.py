#!/usr/bin/env python3
"""H4/H5 #5：一次 run 内全量采集 5 个 fail-closed 场景，禁止跨代际拼包。

一个证据包 = 一次 run：
  - 启动时生成 run_id + run_started_at，传给每个场景的 collect_f1_dom_evidence.py；
  - 每个 verdict 只陈述本场景，不写跨场景 coverage（包级 manifest 才算 coverage）；
  - 结束在 package 阶段计算 run_finished_at（写进 evidence-manifest.json）。

前置（本机原生栈，A13 迁移后的 E2E 库）：
  api 8082 internal_eval / 8083 expired / 8084 hold(c_end_display+2030)，web 3001/3003/3004，
  控制表 audit.entitlement_hold_state 可写（admin DSN）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
E2E_ROOT = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(os.path.dirname(E2E_ROOT))
DSN = os.environ.get("E2E_PG_DSN", "postgresql://ms@localhost:55432/market_sense")
TOKEN = os.environ.get("E2E_AUTH_TOKEN", "dev-token")
PSQL = os.environ.get("E2E_PSQL", "psql")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone().isoformat(timespec="seconds")


def psql(sql: str) -> str:
    out = subprocess.run([PSQL, DSN, "-Atc", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"[FAIL] psql 失败：{sql}\n{out.stderr}")
    return out.stdout.strip()


def get(url: str) -> int:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, TimeoutError):
        return 0


def wait_quote_status(api: str, want: int, timeout: float = 45.0) -> int:
    deadline = time.time() + timeout
    status = -1
    while time.time() < deadline:
        status = get(f"{api}/v1/instruments/SSE:600519/quote")
        if status == want:
            return status
        time.sleep(2)
    return status


def clear_hold_and_reconcile() -> None:
    if psql("SELECT hold FROM audit.entitlement_hold_state WHERE id=1") == "t":
        psql(
            "SELECT audit.clear_hold(("
            "SELECT hold_ticket FROM audit.entitlement_events WHERE event_type='hold_set' "
            "ORDER BY occurred_at DESC LIMIT 1), 'e2e-signer', repeat('a',64))"
        )
    psql("UPDATE audit.entitlement_hold SET last_reconciled_at = now() WHERE id = 1")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-root", default=os.path.join(E2E_ROOT, "evidence"))
    ap.add_argument("--run-id", default="")
    ap.add_argument("--skip-precheck", action="store_true")
    args = ap.parse_args()

    started = utc_now()
    run_id = args.run_id or f"11-12-f1-dom-{started.strftime('%Y%m%dT%H%MZ')}-v2"
    root = os.path.join(args.out_root, run_id)
    if os.path.exists(root):
        sys.exit(f"[FAIL] run 目录已存在，拒绝覆盖：{root}")
    os.makedirs(root)

    if not args.skip_precheck:
        for api in ("http://127.0.0.1:8082", "http://127.0.0.1:8083", "http://127.0.0.1:8084"):
            if get(f"{api}/healthz") != 200:
                sys.exit(f"[FAIL] api 不可达：{api}/healthz（先按 RUNBOOK §6 起原生栈）")
        for web in ("http://127.0.0.1:3001", "http://127.0.0.1:3003", "http://127.0.0.1:3004"):
            if get(web + "/") != 200:
                sys.exit(f"[FAIL] web 不可达：{web}（先起 web/h5 静态服务）")

    env_base = {
        **os.environ,
        "EVIDENCE_RUN_ID": run_id,
        "EVIDENCE_BATCH_STARTED_AT": iso(started),
        "E2E_AUTH_TOKEN": TOKEN,
    }

    def collect(label: str, web: str, api: str, matrix: str, extra: dict | None = None) -> None:
        env = {
            **env_base,
            "EVIDENCE_WEB_URL": web,
            "EVIDENCE_API_URL": api,
            "EVIDENCE_BASE_URL": web,
            "EVIDENCE_LABEL": label,
            "EVIDENCE_SCENARIO": label,
            "E2E_ENTITLEMENT_MATRIX": matrix,
            "EVIDENCE_OUT_DIR": os.path.join(root, label),
            **(extra or {}),
        }
        print(f"[collect] {label} web={web} api={api} matrix={matrix}", flush=True)
        rc = subprocess.run([sys.executable, os.path.join(HERE, "collect_f1_dom_evidence.py")],
                            env=env, cwd=E2E_ROOT).returncode
        if rc != 0:
            raise SystemExit(f"[FAIL] 场景 {label} 采集/判定失败 rc={rc}；本次 run 不打包")

    # 1) 受限档静态配置：expired / unauthorized_config / malformed
    collect("unauthorized_config", "http://127.0.0.1:3001", "http://127.0.0.1:8082", "restricted")
    collect("expired", "http://127.0.0.1:3003", "http://127.0.0.1:8083", "restricted")
    collect("restricted_malformed_403", "http://127.0.0.1:3001", "http://127.0.0.1:8082",
            "restricted", {"EVIDENCE_MALFORMED_403": "1"})

    # 2) hold_active：干净态 → raise → 等 gate 生效（30s 缓存）
    clear_hold_and_reconcile()
    ticket = f"E2E-HOLD-{int(time.time() * 1000)}"
    hold_id = psql(f"SELECT audit.raise_hold('e2e-hold', '{ticket}')")
    print(f"[hold] raise ticket={ticket} hold_id={hold_id}", flush=True)
    status = wait_quote_status("http://127.0.0.1:8084", 403)
    if status != 403:
        raise SystemExit(f"[FAIL] hold_active：raise 后 45s 仍未 403（quote={status}）")
    collect("hold_active", "http://127.0.0.1:3004", "http://127.0.0.1:8084", "normal",
            {"E2E_HOLD_ENABLED": "1"})

    # 3) hold_stale：hold 保持，把 control 行打旧
    psql("UPDATE audit.entitlement_hold SET last_reconciled_at = now() - interval '16 minutes' WHERE id = 1")
    status = wait_quote_status("http://127.0.0.1:8084", 403)
    if status != 403:
        raise SystemExit(f"[FAIL] hold_stale：stale 后 45s 仍未 403（quote={status}）")
    collect("hold_stale", "http://127.0.0.1:3004", "http://127.0.0.1:8084", "normal",
            {"E2E_HOLD_ENABLED": "1"})
    clear_hold_and_reconcile()
    print("[hold] control row restored: hold=false, last_reconciled_at=now()", flush=True)

    finished = utc_now()
    # 包级 manifest 由 build_f1_evidence_package.py 从逐场景 verdict 计算 coverage
    rc = subprocess.run(
        [sys.executable, os.path.join(HERE, "build_f1_evidence_package.py"), "--run-dir", root,
         "--run-started-at", iso(started), "--run-finished-at", iso(finished)],
        cwd=REPO_ROOT).returncode
    if rc != 0:
        raise SystemExit(f"[FAIL] 打包失败 rc={rc}")
    print(f"[OK] run_id={run_id} → {os.path.relpath(root, REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
