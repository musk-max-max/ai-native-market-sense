# 基线 #11 违反登记（R7）：ECS 主机态零 IaC 表达

> 状态：**finding 措辞 + 验收标准 v1（2026-11-05）**，待 H5 认措辞、A13 认修法。归 A9 提案域，不改实现。
> 关联：#11「生产只走 IaC」（`agents/decisions.md` §5 14 条安全基线）；症状证据 A19 residual R1/R3；lead 已认作独立项 R7。

## 1. Finding（可直接引用的措辞）

> **R7 —「生产只走 IaC」基线违反（结构性问题，非单点配置错误）**
> 生产 ECS 的主机管理面 —— **sshd 配置、ufw 规则、云安全组（SG）、非 compose 管理的容器（如 `ms-nginx`）** ——
> 在仓库与流水线中**没有任何 IaC 表达**，仅以「某次人工操作后留下的运行态」存在。因此这些状态**不可从仓库重建、
> 不可评审、不可回滚、不被 CI 检测**；A19 发现的公网 22 密码认证、80/8888 网络层放行、`ms-nginx` 幽灵绑定、
> 运行时审计漂移，都是这一类「不可见状态」的症状，**修复单点后仍会复发**。

**为什么判基线违反而非普通配置错误**：基线 #11 的判定对象不是「有没有配置文件」，而是「生产状态是否可由仓库
声明、评审、重建」。当前主机态满足不了其中任一项（`infra/terraform/` 只有 kubernetes provider：`modules/k8s-environment`、
`envs/dev`、`envs/preview`；`tests/e2e/docker-compose.yml` 不含 `ms-nginx`；`permitrootlogin`/`passwordauthentication`/
`ufw`/`fail2ban` 在非 evidence 代码中零命中，唯一例外是 A13 2026-11-05 新建的 `infra/drift/` 期望态文件，尚未修好、未接发布流程）。

## 2. 事实（可复核，A9 只读核对）

| # | 事实 | 证据 |
|---|---|---|
| 1 | Terraform 仅有 k8s provider / k8s 环境模块，无 EC2、SG、ufw、sshd 资源 | `infra/terraform/{modules/k8s-environment,envs/dev,envs/preview}` |
| 2 | 仓库唯一 compose（`tests/e2e/docker-compose.yml`）无 `ms-nginx`；该容器是主机上 `docker run` 出来的 | `tests/e2e/docker-compose.yml`；artifact L21–L23 |
| 3 | 非 evidence 代码中 grep `permitrootlogin|passwordauthentication|ufw|fail2ban` 零命中（除 `infra/drift/`） | 2026-11-05 A9 检索 |
| 4 | 运行态与仓库声明漂移：容器 `ENTITLEMENT_AUDIT=0`/`HOLD_CHECK=0` vs compose `"1"`/`"1"` | artifact L43–L44；`tests/e2e/docker-compose.yml:110-111` |
| 5 | 主机态残留导致公网 80/8888 网络层放行、22 密码认证开放（症状） | SEC-001 / SEC-002，artifact L17–L28 |

## 3. 风险（为什么这不是文档洁癖）

1. **不可重建**：主机重装/迁移后，只有人工记忆能恢复 sshd/ufw/容器状态；恢复过程不可评审、易漏项。
2. **不可评审**：任何 SSH/firewall 变更没有 PR、没有 diff、没有第二人看到，违反「认证/鉴权代码双签」与 #11。
3. **不可回滚**：手工改动无版本，无法回滚到已知良好态，只能凭记忆反操作。
4. **不可检测**：CI/契约测试/质量分全部覆盖不到主机层 —— A19 必须用红队人工巡检才发现（本次即靠人肉）。
5. **复发**：即使本轮修完 SEC-001/002，下一次「临时调一下」仍会留下同类残留（`ms-nginx` 就是先例：停而不删、绑定残留）。

## 4. 合规路径（两档，H5 已给口径：IaC 或「清单 + 漂移检测」）

**A 档（基线 #11 完整达标）**：主机态声明化 —— cloud-init/user_data + Ansible/Terraform 管理 sshd/ufw/docker 端口映射；
仓库可重建一台等价主机；变更走 PR + 评审；有回滚路径（镜像/快照 + 声明回退）。

**B 档（过渡合规，最低可接受）**：不可声明化的部分（如云 SG）至少做到 —— ①**版本化目标态清单**（在仓库，含每个字段的期望值与
理由）；②**只读漂移审计**可定期/发布前运行，输出可归档为证据；③**变异自证**（注入漂移必须 FAIL，证明检测真的生效）；
④SG 由用户出 JSON/截图或书面「用户负责、H5 不验」，作为 explicit residual 记录，**不得写「已闭环」**。

> B 档只能作为过渡：它降低「不可检测」风险，不解决「不可重建/不可评审/不可回滚」。采纳 B 档须同时登记
> 「转 A 档的触发条件」（例：开公网入口 / 多用户 / 首个人类运维接手时）。

## 5. 验收标准（可机器判定，缺一不算闭环）

| # | 验收项 | 判定方式 |
|---|---|---|
| AC-1 | 目标态清单入库且带 owner/原因/最后评审日期 | `infra/drift/host-baseline.expected.env` 等文件在 git 内、有 PR 记录 |
| AC-2 | 只读审计脚本覆盖 sshd / ufw / 通配监听 / 容器 PortBindings / restart 策略 / 运行时授权 env | 脚本存在且 `set -eu`，不写任何状态 |
| AC-3 | **变异自证**：注入「0.0.0.0 绑定」「非 compose 容器」「多放行 ufw 规则」「sshd PermitRootLogin=yes」各一次，审计必须 exit 1 且输出对应 FAIL | 两次输出（正常 exit 0 / 注入 exit 1）归档为证据 |
| AC-4 | 审计接入发布前检查（或至少值班定期 + 证据归档到 `infra/evidence/` + manifest） | release-gate 记录含最近一次审计结果 |
| AC-5 | 审计的 fail 语义正确：无法检查（非 root / 无 docker）与漂移（配置不符）**分开**，不得静默 PASS | 注入「无法检查」场景应 exit 2 或显式 `WARN/FAIL`，不得 exit 0 |
| AC-6 | 容器残留清理：所有 stopped 容器无 `0.0.0.0` PortBindings；非 compose 容器要么删除、要么登记例外与 owner | 审计输出 + 例外清单 |
| AC-7 | SG 证据：用户出 JSON/截图，或书面「用户负责、H5 不验」；两者都无 → 验收不通过（不得以「ECS 侧不可验」默认通过） | 归档到证据链 |
| AC-8 | B 档须写「转 A 档触发条件」；A 档须能从仓库重建等价主机（演练一次） | 文档 + 演练记录 |

## 6. 当前进度（2026-11-05）

- A13 已建 `infra/drift/host-baseline.expected.env`（fail-closed 目标态：`EXPECTED_WILDCARD_LISTEN_PORTS="22"`、
  `EXPECTED_UFW_ALLOW="22/tcp"`、`EXPECTED_SSHD_PERMITROOTLOGIN="no"`、`EXPECTED_SSHD_PASSWORD_AUTHENTICATION="no"`、
  `EXPECTED_SSHD_MAXAUTHtRIES="3"`（变量名大小写混写，A9 已报 A13）、`EXPECTED_ENTITLEMENT_AUDIT="1"`、
  `EXPECTED_ENTITLEMENT_HOLD_CHECK="1"`）与
  `infra/drift/host-baseline-audit.sh`（只读，`set -eu`）→ **AC-1/AC-2 方向正确**。
- **进展（2026-11-05 晚，A13 更新后 A9 复核）**：原 `|` 分隔解析 bug **已修**（改 `;` 分隔）。A9 用 `/tmp` 假态 harness
  （伪造 `ss`/`ufw`/`sshd`/`docker inspect` 输出，未碰真实主机）验证：注入 `ms-nginx`（stopped、`0.0.0.0:80`、
  无 compose label）→ 输出「容器存在 0.0.0.0 端口绑定」+「非 compose 管理容器」两条 FAIL、**exit 1**；干净态 **exit 0**。
  → **AC-3 部分达成（0.0.0.0 / 非 compose 两类注入可失败）**。
- **AC-3/AC-5 仍未达标**：
  a) `#!/bin/sh` 在 macOS = bash 3.2，`set -u` 下 `$VAR` 紧跟全角字符（line 77/94/100/114/115 共 6 处，如 `$BAD_UFW（期望`）
     被解析成含 UTF-8 字节的变量名 → `unbound variable`：**干净主机也会 exit 1**（ufw 段起后续检查不执行），
     与 ⑤-7「正常态 exit 0」冲突；修复=全部 `$VAR` 改 `${VAR}`。
  b) `ufw status` 只取 `To` 列、不比 `From`：`22/tcp ALLOW Anywhere` 判 PASS，来源白名单要求（⑤-4）不可见；
     AC-3 的「ufw 注入」也只覆盖端口、不覆盖来源。
  c) env 检查以「容器是否含 `ENTITLEMENT_TIER`」为开关：容器**完全缺**该 env（或被改名）时静默跳过 → 输出
     `RESULT PASS`（A9 实测），这是 SEC-003 漂移的最危险形态 → AC-5 fail 语义不达标。
  d) 脚本无 fail2ban 检查（⑤-3 只能人工取证）；`sshd -T` 非 root 时三行全 FAIL 但无 exit-code 区分。
  A9 已于 2026-11-05 将 a–d 报 A13；**修复并给出变异自证（含「缺 env」「ufw 来源 Anywhere」注入）前，本项按未闭环计**。
- 因此 R7 状态：**B 档就绪、A 档未做**。SEC-001/002 的修复若只改运行态、不落清单/审计，不构成 R7 闭环。

### 6.1 更新（2026-11-05T00:08Z，A13 `5ea7e97` + `9bc29fb` 后，A9 只读复核）

上述 a–d **已全部修复**并给出变异自证，A9 用 `/tmp` 假态 harness 复核通过：

| 缺陷 | 修复 | A9 复核结果 |
|---|---|---|
| a) bash 3.2 `$VAR` + 全角字符崩 | 6 处改 `${VAR}`；另加 `export LC_ALL=C`（line 91） | 干净态 sh/dash **exit 0**；无 `unbound variable` |
| b) ufw 只比 `To` 列 | 解析 `ufw status numbered` 的 `From`；新增 `EXPECTED_SSH_ALLOWED_FROM`（当前空=fail-closed） | 注入 `22/tcp ALLOW Anywhere` → **FAIL**；注入 8888 多放行 → **FAIL** |
| c) 缺 env 静默 PASS | 带 `APP_PROFILE|E2E_MODE|ENTITLEMENT_TIER` 的容器强制 AUDIT/HOLD=1，缺记 `unset` FAIL | 注入 `AUDIT=0`/`HOLD=0`/`unset` → 全部 **FAIL** |
| d) 无 fail2ban / IPv6 | 新增 fail2ban `active`+sshd jail；IPv6 `::`/`[::]` 检出 | 注入 inactive/无 jail/**`"HostIp":"::"`** → 均 **FAIL** |

证据：`infra/evidence/host-mutation-selftest-20261105T0010Z.txt`（`a0859bfa…`，`SELFTEST PASS` 9 类注入全被检出、exit 0）、
合成干净态 exit 0、真实变异 `docker create -p 0.0.0.0:8899:80`（不运行）被检出后删除；before `a636fa82…`、after `fadadc31…`。
→ **AC-3 达成**（0.0.0.0/:: 绑定、非 compose、ufw 多放行、ufw 来源、缺 env、fail2ban、弱 sshd 均有失败证据）；**AC-5 基本达成**
（未知/不清与漂移分开；仍残留 R-⑤7-1：三个 marker env 全缺的应用容器被跳过，建议 compose service/镜像白名单强制）。

| AC | 状态 |
|---|---|
| AC-1（清单入库） | ✅ 方向达成（`host-baseline.expected.env` 在 git；`EXPECTED_SSHD_MAXAUTHtRIES` 命名仍待 A13 统一） |
| AC-2（只读全覆盖） | ✅ 达成（sshd/ufw/通配监听/PortBindings/restart/env/fail2ban） |
| AC-3（变异自证） | ✅ 达成（见上，含真实变异） |
| AC-4（接发布前检查） | ❌ 未达成（尚未接 release-gate 脚本/值班流程） |
| AC-5（fail 语义） | ✅ 基本达成（残留 R-⑤7-1） |
| AC-6（容器残留清理） | ✅ 主机侧达成（ms-nginx 删除、无 `0.0.0.0` 残留）；审计已能持续检出 |
| AC-7（SG 证据） | ❌ 未达成（用户未出 JSON/截图/书面；⑤-5 记 PARTIAL） |
| AC-8（B 档触发条件 / A 档演练） | ❌ 未达成（**R7 文档须补「转 A 档触发条件」**：开公网入口 / 多用户 / 首个人类运维接手 / S1 上线前） |

**结论**：R7 由「OPEN（部分进展）」转为「**B 档就绪**」——主机态漂移从「不可检测」变为「可检测且自证有效」；
但基线 #11「生产只走 IaC」在 A 档完成前**仍是违反**，gate「只走 IaC」保持 BLOCKED，不得因 B 档就绪写「R7 闭环」。
SEC-001/002 的修复仍须落清单/审计才构成 R7 闭环（A13 已把 HOST-BASELINE-01 单列为 `infra/ops/host-baseline-gaps.md`）。

## 7. 边界

- A9 不选实现方案（Ansible vs cloud-init vs Terraform provider），那是 A13/H2 的写域；A9 只定「可验证的验收口径」。
- 不在真实主机执行审计/加固；证据由 A13 采集、A9 核对完整性。
- 云 SG 属用户控制面：缺证据就只能记 residual，不能记 PASS（与 H5 门禁 ⑤-5 一致）。
