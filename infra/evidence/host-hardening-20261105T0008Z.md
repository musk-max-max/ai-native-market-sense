# 主机管理面加固 + R3 运行时审计漂移验证（⑤ / H5 m03440 / A9 R7）

- **时间**：2026-11-05T00:00–00:08Z（北京时间 08:00–08:08）
- **执行人**：A13（a13-sre），通过 `ssh root@47.120.16.239` 只读审计 + H5 m03440 授权的无锁定风险动作
- **范围**：ECS `47.120.16.239`（hostname `heyuan`）；**不涉及**服务代码、契约、SG（云控制面，用户负责）
- **基线脚本**：`infra/drift/host-baseline-audit.sh` + `infra/drift/host-baseline.expected.env`

## 1. fail2ban（H5 m03440 第 1 项）— PASS

- 安装并启用 `fail2ban 0.11.2-6`（apt），jail `/etc/fail2ban/jail.d/sshd-a13.local`：
  `[sshd] enabled=true filter=sshd backend=systemd maxretry=5 findtime=10m bantime=1h`，
  `ignoreip = 127.0.0.1/8 ::1 223.166.54.234`（A13 出口 IP；H5/Lead/用户 CIDR 待补，**未给前不锁所有人**）。
- 实测：`systemctl is-active fail2ban` → `active`；`fail2ban-client status` → `Jail list: sshd`；`fail2ban-client status sshd` → `Currently failed: 0 / Total failed: 0 / Currently banned: 0`。
- Residual：白名单目前只有 A13；需用户给 H5/Lead/用户出口 CIDR 后补 `ignoreip`。

## 2. ms-nginx（H5 m03440 第 2 项）— PASS（并发处置）

- 审计时（23:58:16Z）容器 `ms-nginx` 为 `exited/restart=no`，但 `PortBindings={"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"80"}]}`（A19 R1）。
- 23:58:17Z 另一执行者已 `docker rm ms-nginx` 并将 `/opt/ms-nginx/htpasswd` 归档为 `htpasswd.archived-20261104T235817Z`（0600）；A13 复核时容器已不存在，`/opt/ms-nginx` 权限 700/文件 600。
- A13 归档补充：`/root/a13-archive/ms-nginx-20261105T0002Z/`（inspect.json、nginx.conf、docker.log；`SHA256SUMS`：inspect `d213eadc…`、nginx.conf `caa0ac56…`、docker.log `0115fa2c…`）。未重启、未 `docker start`。
- 复核：`docker ps -a` 无 `ms-nginx`；`ss -ltnp` 无 80 监听。

## 3. ufw（H5 m03440 第 3 项）— PASS（白名单待用户）

- 加固前：8888/20/21/22/80/443/888/25730/39000:40000 全部 ALLOW Anywhere（v4+v6）。
- 逐条 `ufw --force delete` 非 22 规则；加固后仅 `[1] 22/tcp ALLOW IN Anywhere`、`[2] 22/tcp (v6)`。
- 无业务监听受影响（ss 仅有 22、loopback 的 8081/3000/18081/53/45231）。
- **22 仍未限制来源**（Anywhere）：需用户提供白名单 CIDR 后改为 `ufw allow from <CIDR> to any port 22`；当前状态在漂移审计中如实 FAIL，不伪装 PASS。

## 4. R3 运行时审计/hold 漂移（H5 m03440 第 4 项）— PASS（单次隔离验证）

- 重建默认 e2e api（`docker compose -f docker-compose.yml -f docker-compose.override.lead.yml up -d --force-recreate api`）：
  `ENTITLEMENT_AUDIT=1`、`ENTITLEMENT_HOLD_CHECK=1`、`ENTITLEMENT_TIER=internal_eval`、`APP_PROFILE=e2e`、`E2E_MODE=1`、`DEPLOYMENT_UID=e2e-default`；`/healthz` 200。
- 正向档隔离验证（同镜像 `market-sense-e2e-api:latest` 一次性容器 `a13-r3-audit`，`c_end_display` + expires `2030-12-31T00:00:00Z` + expected sha `b0d185b9…` + AUDIT/HOLD=1，仅 127.0.0.1:8092）：
  * 控制行 fresh 后 quote `200`（合成数据 9999.99，非 DA 证据）；
  * `audit.raise_hold('a13-r3-hold-check-2','H5 m03440 R3 audit slow-refresh')` → hold_id `7a55405d…`；
  * **控制读缓存 TTL 约 30s**：2s 内仍 200；35s 后 quote `403` + `cache-control: no-store`，`/healthz entitlement_degraded=true / reason=hold_active`；
  * `audit.clear_hold('A13-TICKET-2','H5','1111…1111')` 后 35s quote `200`；hold=f；
  * `audit.entitlement_events` 行数 2→5→6，`hold_set` 事件 `event_key=hold|7a55405d-…`、hash 链前后相接；`verify_entitlement_chain()` 返回 0 行（无问题）。
- 清理：`a13-r3-audit` 已 `docker rm -f`；hold 已 clear、`last_reconciled_at` fresh；默认 api 保持 running/healthy。

## 5. 漂移检测自证（A9 R7：变异注入）

- `sh infra/drift/host-baseline-audit.sh --self-test` → `SELFTEST PASS`：夹具注入 0.0.0.0 通配监听、0.0.0.0 绑定容器、非 compose 容器、多放行 ufw、22 Anywhere、fail2ban inactive、弱 sshd、AUDIT/HOLD=0 → 全部输出 FAIL，exit 0（自测通过即检出能力成立）。
- 真实变异：`docker create --name a13-drift-selftest -p 0.0.0.0:8899:80 nginx:1.27-alpine`（created 不运行、无监听）→ 审计 FAIL「0.0.0.0 端口绑定（status=created）」「非 compose/k8s 管理容器」→ 立即 `docker rm -f`。
- 加固前后对照：`host-baseline-before-20261105T0000Z.txt`（ms-nginx 绑定/非 IaC 容器/ufw 多放行/弱 sshd/AUDIT=0 FAIL）→ `host-baseline-after-20261105T0004Z.txt`（监听/ufw/fail2ban/AUDIT=1 PASS；22 白名单与 sshd 仍 FAIL）。

## 6. 未完成 / residual（不阻断，但 ⑤ 未 PASS）

1. **22 来源白名单**：等用户给 CIDR；之后 `ufw delete allow 22/tcp` + `ufw allow from <CIDR> to any port 22`，漂移脚本应转 PASS。
2. **sshd 加固**：需用户确认「密钥可登录 + 控制台兜底 + 22 白名单 CIDR」后执行 `PermitRootLogin no` / `PasswordAuthentication no` / `KbdInteractiveAuthentication no` / `MaxAuthTries 3`，`sshd -t` + 保留会话二次验证；当前仍 `yes/yes/6`（drift FAIL）。
3. **云安全组**：A19 E1–E4 证明 SG 仍放行 80/8888（临时 0.0.0.0 绑定外网 200）；ECS 侧无法验证/修改，需用户导出 SG JSON/截图或书面「用户负责」。
4. **主机态纳入 IaC**：A9 独立项 HOST-BASELINE-01，见 `infra/ops/host-baseline-gaps.md`；漂移脚本是临时替代，不是 IaC。
