# Release Gate 阻断结论（A9，只读）

> 结论时间：2026-11-05。依据：A19 L91 复核 artifact（commit `370c6bb` + errata `0657fc1`）、仓库侧交叉验证、
> H5 2026-11-05 裁定（R2=P1 release-blocking，修复时限用户确认后 24h、11-05 24:00 前；R1/R3=P2；新增门禁 ⑤ 主机管理面）。
> **本结论不改任何配置、不碰真实主机**；执行与云控制台操作不在 A9。

## 1. 判定

| Gate | 判定 | 理由 |
|---|---|---|
| **`高危漏洞=0`** | **BLOCKED（不成立）** | SEC-001（P1，公网 22 + root 密码认证 + fail2ban inactive + 1130 次爆破）未闭环；SEC-002（P2）网络层仍对 Internet 放行 80/8888 |
| **`越权测试全绿`** | **BLOCKED（不成立）** | 现有用例集只覆盖 API 层；SEC-004 证明「授权只在 API 层」，主机层→DB 直读与隧道二次转发两类用例尚未落地（EXC-HOST-01 / EXC-TUNNEL-01） |
| **`审计不可篡改`（基线 #7）** | **BLOCKED（无事实证据）** | SEC-003：运行态 `ENTITLEMENT_AUDIT=0`/`HOLD_CHECK=0`，`audit.entitlement_events` 0 行，门禁 4/6 条无证据 |
| **`只走 IaC`（基线 #11）** | **BLOCKED（基线违反）** | R7：sshd/ufw/SG/非 compose 容器零 IaC 表达，见 `../baselines/BL-11-R7-host-state-not-in-iac.md` |

**门禁处置**：在 SEC-001 闭环并取得 ⑤ 主机管理面全部 7 项证据前，**11-12 发布不签**（H5 口径：未闭环则发布卡点不签）。
该阻断状态须写入发布证据链（与 `docs/release/` 现有 release-gate 记录并列），不得以「内网访问」为由豁免 —— L100：
内网改暴露面、不改权利基础。

## 2. 解除条件（all-of，缺一不解除）

1. **SEC-001 闭环**：`PermitRootLogin no`、`PasswordAuthentication no`、fail2ban active、22 仅白名单来源、
   `authorized_keys` 清理至最小集；`auth.log` 爆破无新增成功登录（无 `Accepted` 来自非白名单来源）。
2. **SEC-002 闭环**：SG/ufw 无 Internet 放行 80/8888；无未批准的 `0.0.0.0` 绑定（含 stopped 容器残留）；
   `ms-nginx` 按 L99 永久不恢复。
3. **SEC-003 闭环**：容器重建后 `ENTITLEMENT_AUDIT=1`/`HOLD_CHECK=1`，hold 拦截与四类事件有真实证据，hash 链连续、`event_key` 幂等；
   A11 把门禁 4/6 从 BLOCKED 改 PASS（task-8 交付）。
4. **越权用例**：EXC-HOST-01、EXC-TUNNEL-01 与既有 API 越权用例全部有可复现证据，且**通过 ⑤ 之后**才可写「越权测试全绿」。
5. **R7 基线**：漂移检测具备变异自证（注入漂移必须 exit 1），且纳入发布前检查；SG 由用户出 JSON/截图或书面「用户负责」（explicit residual）。

## 3. 门禁 ⑤「主机管理面」可验证项（H5 已钉，A9 将其落成命令与判据）

> 执行方：A13（ECS 只读取数 / 加固执行，按 H5 给的安全顺序）；云 SG 由用户。A9 只认证据，不执行。
> 全部命令**只读取证**；加固与重启类动作属变更，须 H5 批准后由 A13 执行。

| # | 可验证项 | 只读取证命令（主机上） | 通过判据 | 证据归属 |
|---|---|---|---|---|
| ⑤-1 | root 禁登 | `sshd -T \| grep -i '^permitrootlogin'` | `permitrootlogin no` | A13 贴原始输出 |
| ⑤-2 | 密码认证关 | `sshd -T \| grep -i '^passwordauthentication'` | `passwordauthentication no`（`kbdinteractiveauthentication no` 一并确认） | A13 |
| ⑤-3 | fail2ban active | `systemctl is-active fail2ban`；`fail2ban-client status sshd` | `active` 且 sshd jail 存在、有 `Currently banned` 计数 | A13 |
| ⑤-4 | 22 白名单 | `ufw status verbose`；`iptables -S \| grep -E 'dpt:22'`（若用 iptables） | 22 仅允许指定 CIDR；`Anywhere` 全放行 = FAIL | A13 |
| ⑤-5 | 无 Internet 放行 80/8888 | `ufw status verbose`；SG 规则 JSON/截图 | ufw 无 `80`/`8888` Internet 放行；SG 入站无 80/8888（或仅白名单） | A13 + **用户** |
| ⑤-6 | 无未批准 0.0.0.0 绑定 | `ss -ltnp`；`docker ps -a --format '{{.Names}}'` + `docker inspect -f '{{json .HostConfig.PortBindings}}' <c>` | 通配监听仅 22；业务容器全 `127.0.0.1`；stopped 容器无 `0.0.0.0` 残留 | A13 |
| ⑤-7 | 主机态漂移检查可失败 | `infra/drift/host-baseline-audit.sh` + **变异自证**（注入 0.0.0.0 绑定/非 compose 容器/多放行 ufw 规则） | 正常态 exit 0；注入后 exit 1 且输出对应 `FAIL` | A13 贴两次输出 |

**A13 脚本复核（A9 2026-11-05，只读，用 `/tmp` 假态 harness 模拟主机命令，未碰真实主机/仓库外无落盘）**：
- ✅ 原 `|` 分隔解析 bug 已修（现用 `;` 分隔 + `cut -d';'`）：注入 `ms-nginx`（`0.0.0.0:80` + 非 compose）实测输出两条 `FAIL` 且 **exit 1**；干净态 **exit 0** → ⑤-6 的两项检查不再永久 PASS。
- ❌ **AC-3 仍不完整**：① 脚本 `#!/bin/sh` 在 macOS 上是 bash 3.2，`set -u` 下 `$VAR` 紧跟全角字符（line 77/94/100/114/115 共 6 处，如 `$BAD_UFW（期望`）解析为含 UTF-8 字节的变量名 → **干净主机也会在 ufw 段崩溃 exit 1**，违反 ⑤-7「正常态 exit 0」；修复=全部改 `${VAR}`。② `ufw` 只取 `To` 列：`22/tcp ALLOW Anywhere` 判 PASS（⑤-4 要求白名单来源）。
- ❌ **AC-5 未达标**：env 检查以「容器是否含 `ENTITLEMENT_TIER`」为开关，容器**完全缺**该 env 时静默跳过 → 输出 `RESULT PASS`（实测），正是 SEC-003 漂移的极端形态。
- ❌ 脚本**不含 fail2ban 检查**（⑤-3 只能人工取证）。
**在 AC-3/AC-5 修复并完成变异自证（含「缺 env」「ufw 来源 Anywhere」两类注入）前，⑤-7 按 FAIL 计**，不得用该脚本输出作为 ⑤-6 的通过证据。

## 4. 为何不写「越权测试全绿」

现有越权用例建立在「权限只在 Config Service 服务端强制」（决策 #5）之上，但 A19 证明数据面还有一条**不经 API 的路**：
root/docker → psql。只测 API 的越权用例集，绿了也只证明「API 层无越权」，不能推出「数据不可越权获取」。
两条新用例见 `../test-cases/overreach-cases.md`：EXC-HOST-01（主机层→DB 直读）、EXC-TUNNEL-01（隧道二次转发）。

## 5. 记录与追溯

| 项 | 值 |
|---|---|
| 阻断发起 | A9（2026-11-05），同步 lead / H5 / A13 / A19 |
| 依据证据 | `infra/evidence/internal-exposure-redteam-20261104T2356Z.txt`（`370c6bb`）、errata `0657fc1` |
| 定级口径 | H5 2026-11-05：P1=release-blocking；R2 时限 11-05 24:00 前（用户确认后 24h） |
| 解除签字 | H5（安全）+ 人类架构（认证类改动双签）；A9 只核对证据完整性，不签字放行 |
| 本文件的修订 | 只在证据变化时改，且保留旧判定（追加，不覆盖） |
