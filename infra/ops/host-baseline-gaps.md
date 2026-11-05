# HOST-BASELINE-01：主机管理面未纳入 IaC（独立项）

- **登记来源**：A19 L91 红队复核（`370c6bb`，`infra/evidence/internal-exposure-redteam-20261104T2356Z.txt`）+ A9 R7 复核；**不并入** A19 R1/R3。
- **事实**：`infra/terraform/` 只有 kubernetes provider（dev/preview），无 EC2 安全组/ufw/sshd 声明；`ms-nginx` 曾是主机 `docker run` 残留（0.0.0.0:80 + htpasswd），compose 无此服务；运行容器 entitlement env 曾与 compose 渲染漂移（AUDIT/HOLD=0 vs 1/1）。
- **安全含义**：违反基线 #11「生产只走 IaC」、#3「默认拒绝」、#7「审计不可篡改」；此类残留 CI/契约测试发现不了，只能人工/定期漂移检测。
- **当前临时替代**（A13，已落）：`infra/drift/host-baseline-audit.sh`（只读，`--self-test` 变异自证）+ `infra/drift/host-baseline.expected.env`（fail-closed 目标态）；baseline before/after 证据已登记 manifest；H5 m03440 的 ⑤ 门禁骨架。
- **待办（owner/日期）**：
  1. 云 SG + ufw + sshd 的声明化（Terraform/cloud-init 或配置管理），A13 提案 → H5 评审 → S1 前落地；**11-12 前出提案**。
  2. 主机定期漂移巡检纳入值班（每班一次，输出进 manifest）；A13 负责。
  3. 非 compose/手工容器禁止：CI 静态检查无法覆盖主机，需发布 runbook 明确「生产主机只允许 compose/k8s 拉起」。
- 上述 1–3 完成前，⑤ 主机管理面保持 **PARTIAL/DRIFT**，不得签字。

## HOST-AUDIT-01（P2）：非交互 SSH 命令无审计留存

- **事实**：Lead 于 23:58:17Z 以非交互 SSH 执行 `docker rm ms-nginx` 等命令，命令不进 `bash_history`，ECS 侧无 auditd/journal 持久记录，导致归因一度只能 UNATTRIBUTED；同类操作（停机、删容器、改 ufw）无法事后追责。
- **验收**：注入一条非交互 SSH 命令，必须能查到「命令原文 / 来源 IP / 时间 / 执行人」四元组；实现候选：`auditd`（execve 审计）、docker events 持久采集、journald 持久化/转发。owner：A9 方案 + A13 落地；**11-12 前挂账**，不阻塞 ⑤ 当前四项。

## HOST-EXPOSURE-01（P2）：公网暴露巡检

- 现象：SG 永久放行 80/8888（用户 L103），ms-nginx 类「临时容器 + 0.0.0.0 绑定」可直达公网；现有 CI 只查渲染与端口，主机态无持续巡检。
- 方案：`infra/drift/HOST-EXPOSURE-01.md`；检测公网端口通配监听、容器通配绑定、非 IaC 容器、公网未认证 `/healthz`/`/metrics`；命中告警，可选自动 `docker stop`（默认关闭）。
- 验收：A19 注入 `docker create -p 0.0.0.0:8888`，一周期内检出+告警+处置，证据入 manifest。
- owner：A13（检测/证据）+ A19（注入用例）；**任何公网测试窗口开启前必须先跑起来**。
- 状态：检测核心已实现，systemd/告警/部署钩子与 ECS 注入验收待 H5 对方案两个选择题确认。

## ⑤-3 residual：root 直登 + 无具名 sudo 账号（待用户确认）

- 现状（2026-11-05 09:36Z 只读审计）：`sshd -T` 为 `permitrootlogin without-password`（root 密钥仍可直登）、`passwordauthentication no`、`maxauthtries 3`；`sudo` 组成员仅 `sudo:x:27:`（空组）；非 root 登录用户只有 `www`（uid=1000，`/sbin/nologin`）。
- 目标（L102/⑤-3）：`PermitRootLogin no` + 具名账号 + sudo 提权；当前缺「具名账号」前置，A13 不自行建账号/改 sshd。
- 需用户/Lead 确认：①是否同意建具名运维账号（A13 提案用户名、密钥、sudoers 范围）；②控制台兜底可用性；③改 sshd 的窗口与保留会话验证。改前保持现状，⑤ 继续 PARTIAL。
