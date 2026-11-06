#!/usr/bin/env python3
"""KD-E2E-AUTH-ALIGN：为 E2E 造一个真实 identity 主体并签出 JWT。

背景：ADR-008 S1 后 api 外壳的认证是 identity JWT（无 dev-token 旁路）。
  * normal 矩阵：c_end 用户走 /v1/auth/register + /v1/auth/login（公开路由，即时可用），tier=c_end_display。
  * restricted 矩阵：必须有 internal_active/internal_eval 主体；identity 的内部注册是 202 pending，
    审批链只允许人类 H3/user，没有 HTTP 审批入口。因此本脚本在**隔离 E2E 库**里直接写入一个
    「已由 H3 批准的 internal_eval 夹具用户」（approval_ref 为合法 uuidv7 形态），再走真实
    /v1/auth/login 拿 JWT —— 签名字段仍由 api 的 identity 服务生成，测试不伪造 token。

边界：
  * 只写 identity.users 一行（固定 user_id/email），不写业务表；不修改 services/** 代码。
  * 仅用于 E2E/隔离库；生产库不得执行（脚本要求显式 --allow-write 或 E2E_AUTH_AUTOSEED=1）。
  * psql 来源优先级：--dsn > E2E_PG_DSN > PG_DSN > DATABASE_URL > docker compose exec postgres。

用法：
  python3 tests/e2e/scripts/seed_e2e_identity.py --matrix restricted --api-base http://127.0.0.1:8081
  成功时 stdout 只输出 token（可 E2E_AUTH_TOKEN=$(...) 直接给 Playwright）；同时写
  tests/e2e/.state/e2e-auth-token（0600）供 worker 读取。
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

E2E_DIR = pathlib.Path(__file__).resolve().parent.parent
TOKEN_FILE = E2E_DIR / ".state" / "e2e-auth-token"

INTERNAL_ID = "usr_e2e_internal"
INTERNAL_EMAIL = "e2e-internal@example.invalid"
INTERNAL_PASSWORD = "e2e-internal-password"
# scrypt$16384$8$1$<saltB64>$<hashB64>，固定 salt，仅用于隔离 E2E 夹具密码。
INTERNAL_PASSWORD_HASH = (
    "scrypt$16384$8$1$YTEyZTJlaW50ZXJuYWxzYWx0MDAwMQ=="
    "$BmzVzdKpUYubWsxPXjiFDEeKxdf25DAstX99a448qq05wsegi+4diRg56PMbtUQ5LCAFWCH9Z6uYXjz4wyaI2Q=="
)
# 合法 uuidv7 形态（version=7，variant=8）；approved_by 只允许 H3/user。
APPROVAL_REF = "apr_0192f0c0-1a2b-7c3d-8e4f-56789abcdef0"

C_END_EMAIL = "e2e-c-end@example.invalid"
C_END_PASSWORD = "e2e-c-end-password"


def post_json(url: str, payload: dict, timeout: float = 5.0) -> tuple[int, dict]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode("utf-8")
            return res.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return err.code, parsed


def login(api_base: str, email: str, password: str) -> str:
    status, body = post_json(f"{api_base.rstrip('/')}/v1/auth/login", {"email": email, "password": password})
    if status != 200 or not isinstance(body.get("token"), str) or not body["token"]:
        raise SystemExit(f"[seed-e2e-identity] login 失败：{email} -> HTTP {status} {body}")
    return body["token"]


def ensure_c_end(api_base: str) -> str:
    """c_end 用户：先 register（201；已存在 409 可忽略），再 login。"""
    status, body = post_json(
        f"{api_base.rstrip('/')}/v1/auth/register", {"email": C_END_EMAIL, "password": C_END_PASSWORD}
    )
    if status not in (201, 409):
        raise SystemExit(f"[seed-e2e-identity] c_end register 失败：HTTP {status} {body}")
    return login(api_base, C_END_EMAIL, C_END_PASSWORD)


def psql_command(dsn: str | None) -> list[str]:
    psql = os.environ.get("E2E_PSQL", "psql")
    if dsn:
        return [psql, "-v", "ON_ERROR_STOP=1", "-d", dsn]
    compose = E2E_DIR / "docker-compose.yml"
    project = os.environ.get("E2E_COMPOSE_PROJECT", "e2e")
    return [
        "docker", "compose", "-p", project, "-f", str(compose),
        "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1",
        "-U", "market", "-d", "market",
    ]


def resolve_dsn(explicit: str | None) -> str | None:
    return explicit or os.environ.get("E2E_PG_DSN") or os.environ.get("PG_DSN") or os.environ.get("DATABASE_URL")


def seed_internal_user(dsn: str | None) -> None:
    sql = f"""
BEGIN;
INSERT INTO identity.users (
  user_id, email, password_hash, user_type, internal_tier,
  approved_by, approved_at, approval_ref, session_version, account_locked
) VALUES (
  '{INTERNAL_ID}', '{INTERNAL_EMAIL}', '{INTERNAL_PASSWORD_HASH}',
  'internal_active', 'internal_eval', 'H3', now(), '{APPROVAL_REF}', 0, false
)
ON CONFLICT (user_id) DO UPDATE SET
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  user_type = EXCLUDED.user_type,
  internal_tier = EXCLUDED.internal_tier,
  approved_by = EXCLUDED.approved_by,
  approved_at = EXCLUDED.approved_at,
  approval_ref = EXCLUDED.approval_ref,
  session_version = 0,
  account_locked = false,
  updated_at = now();
COMMIT;
"""
    proc = subprocess.run(psql_command(dsn), input=sql, text=True, capture_output=True)
    if proc.returncode != 0:
        raise SystemExit(
            "[seed-e2e-identity] 写 identity.users 失败（identity 迁移是否已跑？db-migrate 覆盖 services/*/migrations）：\n"
            f"{proc.stderr.strip()}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--matrix", choices=("normal", "restricted"), default=os.environ.get("E2E_ENTITLEMENT_MATRIX", "normal"))
    parser.add_argument("--api-base", default=os.environ.get("E2E_API_BASE", "http://127.0.0.1:8081"))
    parser.add_argument("--dsn", default=None)
    parser.add_argument("--token-out", default=str(TOKEN_FILE))
    parser.add_argument("--allow-write", action="store_true", help="确认允许写隔离 E2E 库")
    args = parser.parse_args()

    allowed = args.allow_write or os.environ.get("E2E_AUTH_AUTOSEED") == "1"
    if not allowed:
        print(
            "[seed-e2e-identity] 拒绝写库：需要 --allow-write 或 E2E_AUTH_AUTOSEED=1（隔离 E2E 库专用）",
            file=sys.stderr,
        )
        return 2

    if args.matrix == "restricted":
        seed_internal_user(resolve_dsn(args.dsn))
        token = login(args.api_base, INTERNAL_EMAIL, INTERNAL_PASSWORD)
    else:
        token = ensure_c_end(args.api_base)

    out = pathlib.Path(args.token_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(token, encoding="utf-8")
    out.chmod(0o600)
    print(token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
