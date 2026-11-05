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
