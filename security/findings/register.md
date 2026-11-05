# 高危漏洞与安全缺口登记（A9，只读结论）

> 状态：**结论稿 v1，2026-11-05**。依据 A19 L91 复核 artifact（commit `370c6bb` + errata `0657fc1`）与仓库侧交叉验证；
> A9 未做任何主动探测、未改任何配置、未碰真实主机。定级口径按 H5 2026-11-05 裁定：**P1 = release-blocking**。
> 本登记只回答「是什么、证据在哪、影响什么、谁闭环」；修法在 `../gate/`、`../baselines/` 与 `../../auth/proposal-*`，
> 执行归 A13 / 用户云控制台，A9 不落地。

## 1. 汇总

| ID | 标题 | 级别 | 对应 A19 residual | 闭环 owner | 状态 |
|---|---|---|---|---|---|
| SEC-001 | 公网 22 开放 + root 密码认证 + fail2ban 停用（1130 次爆破） | **P1 release-blocking** | R2 | H5 裁定 / A13 执行 / 云控制台归用户 | **OPEN（部分处置，见 §9）** |
| SEC-002 | SG+ufw 对 Internet 放行 80/8888；`ms-nginx` 保留 `0.0.0.0:80` 绑定 + htpasswd，可被 `docker start` 复活 | P2 High | R1 | A13 / 用户 SG | **OPEN（主机侧已清，SG 未验；§9）** |
| SEC-003 | 运行时审计/hold 未生效：容器 `ENTITLEMENT_AUDIT=0`/`HOLD_CHECK=0` 与 compose `1`/`1` 漂移，`audit.entitlement_events` 0 行 | P2 High | R3 | A13（重建）/ A3、A12（task-8） | **OPEN（主机侧已验；待门禁 4/6；§9）** |
| SEC-004 | 数据面授权只在 API 层：root/docker 可直接 `psql` 读行情，绕过 403/tier | P2 High | R4 | H5（边界裁定）/ H3（权利基础） | **OPEN（已知边界）** |
| SEC-005 | 限流桶按「源 IP=web 容器」共享且放宽到 600/120（默认 60/10），单用户可 DoS 同侪 | P3 Medium | R5 | A13 / A0（容量口径） | **OPEN** |
| SEC-006 | 无用户身份、无访问审计、隧道可二次转发 → 技术上无法证明 tushare「仅个人查看」 | 合规事实（不定级） | R6 | H3 定性 / H5 技术边界 | **OPEN（H5 已选 A 档，待实现；§9）** |
| R7 | ECS 主机态（sshd/ufw/SG/非 compose 容器）零 IaC 表达 → 基线 #11 违反 | 基线违反（单列） | A9 新发现 | A13 修法 / H5 认措辞 | **B 档就绪、A 档未做；§9**，见 `../baselines/BL-11-R7-host-state-not-in-iac.md` |

> 不在本登记内、且**不因本次复核重开**的两项：L98「④ PASS（L91 内网口径）」（口径本身成立，但须补注：PASS 是
> 「当时无业务监听」，**网络层未拒绝**，见 SEC-002）；L99 已关闭的 P2 nginx 事件（不写「全清」，口径按 L99 台账）。

## 2. SEC-001（P1，release-blocking）公网 SSH 密码认证开放

**事实**（artifact L26–L28、E1–E3b 原始 transcript）

- 外网 vantage 实测 `port 22 [tcp/ssh] succeeded!`（唯一当前公网可直连入口）。
- `sshd -T`：`PermitRootLogin=yes`、`PasswordAuthentication=yes`、`MaxAuthTries=6`、`authorized_keys=1` 行、
  `fail2ban=inactive`；`auth.log` 累计 **1130 次** `Failed password`。
- 无凭据尝试返回 `Permission denied (publickey,password).` —— 证明**密码通道开放**（非仅 key）。

**影响 / 攻击路径**：弱口令或口令复用 → 主机 root →（`docker.sock` root:docker 660）`docker exec postgres psql` 直读
`serving.serving_quote_latest` / `dwd_stock_bar_daily` → **API 层 403/tier 门禁整体失效**（SEC-004 同一路径），并可恢复
已停的临时公网层（SEC-002）。即「一条 SSH 弱口令 = 数据面 + 授权面 + 暴露面同时失守」。

**基线映射**：#3 默认拒绝、#4 身份不可转让（共享 root 口令无独立身份/可吊销性）、#7 审计、L91「不暴露公网」。
**闭环判据**（H5 门禁 ⑤ 第 1 组）：`PermitRootLogin no` + `PasswordAuthentication no` + fail2ban active + 22 仅白名单来源
+ 轮换/清理 `authorized_keys` 至最小集；证据须来自主机 `sshd -T` 与 `ufw status` 实测（只读），云 SG 由用户出 JSON/截图。

## 3. SEC-002（P2）80/8888 网络层未拒绝 + 幽灵公网入口

**事实**（artifact L17–L25、I 系列）

- 外网 80/8888 = `reachable-RST`（connection refused，**非 filtered**）→ 网络层是「没监听」而不是「被拒」。
- A19 在 ECS 临时绑 `0.0.0.0:80` / `0.0.0.0:8888` 各约 2s，外网 curl **均 200**（≈0.075s/0.083s）→ SG + ufw 仍对
  Internet 放行这两个端口。
- `ms-nginx` 虽 `exited`/`restart=no`，但保留 `PortBindings={"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"80"}]}`、
  `auth_basic` + `htpasswd`（51B/1 行）；root/docker 一条 `docker start ms-nginx` 即恢复「公网 80 + Basic Auth」。
- ufw 另放行 8888/20/21/888/25730/39000–40000（遗留面板端口），当前被 SG 挡住 = 「armed」状态。

**影响**：任何一次「为了调试临时绑 0.0.0.0」都会立即可公网访问；与 L91 直接冲突。
**闭环判据**（门禁 ⑤ 第 2 组）：SG/ufw 无 Internet 放行 80/8888（ufw 允许清单仅 22 且限来源）；无未批准的
`0.0.0.0` 绑定（含 stopped 容器的残留 PortBindings 必须清除或容器删除）；`ms-nginx` 永久不恢复按 L99 执行。

## 4. SEC-003（P2）审计与 hold 的运行时漂移

**事实**（artifact L43–L46；仓库侧 `tests/e2e/docker-compose.yml:110-111`）

- 运行容器 `ENTITLEMENT_AUDIT=0`、`ENTITLEMENT_HOLD_CHECK=0`；compose 渲染为 `"1"`/`"1"` → **容器早于配置创建、未重建**。
- `audit.entitlement_events` **0 行**；`audit.entitlement_hold` 仅 1 行（hold=f，`last_reconciled_at`=启动时刻）；
  api 日志无 audit 行；`/healthz entitlement_degraded=false`（黑洞在健康面上不可见）。

**影响**：基线 #7「审计不可篡改」与 11-12 门禁第 4（hold/stale）、第 6（事件可回指且幂等）条**当前无事实证据**；
若把 tier 切到 `c_end_display` 而容器未重建，门禁只剩 tier 配置，到期/hold/事件链全部缺失 —— 属「静默降档」，比故障更危险。
**闭环判据**：容器重建后 `ENTITLEMENT_AUDIT=1`/`HOLD_CHECK=1`；hold 场景 403→清 hold→200 全程有事件；事件 hash 链连续、
`event_key` 幂等；A11 把门禁 4/6 从 BLOCKED 改 PASS 并贴命令与真实输出（task-8）。

## 5. SEC-004（P2，已知边界）数据面只受 API 层保护

**事实**（artifact L47–L51）：root/docker 权限者 `docker exec postgres psql` 直读
`public.dwd_stock_bar_daily`(10)、`serving.serving_quote_latest`(5；`SSE:600519 close=9999.99`、`as_of=2026-11-03T07:00:00Z`、
`staleness_ms=147,306,754`≈**40.9h**)、`serving_bar_daily`(30)、`serving_instrument`(5)，**完全绕过 403/tier**。
`docker.sock=root:docker 660`、docker 组无成员、无 uid≥1000 可登录用户 → 现状只有 root，但只要给任何熟人 shell/docker 组，
C 端门禁对数据面整体失效；且可直读 40.9h 陈旧快照。

**定性**：这不是「待修 bug」，而是**架构边界**（授权在 API 层）。若接受该边界，必须在威胁模型里显式写明
「root/docker = 数据面实际控制者」；若不接受，需要行级/列级 GRANT + 数据面访问审计（属 H5/A4 权限模型决策，
不是 A9 单方可改）。**A9 立场**：在只有单人 root 的前提下可接受为**已知边界**，但不得写成「数据面有授权控制」。
**闭环判据**：威胁模型文档写明边界 + EXC-HOST-01 用例有基线证据（见 `../test-cases/overreach-cases.md`）。

## 6. SEC-005（P3）限流共享桶导致同侪 DoS

**事实**（artifact L39–L42）：`RATE_LIMIT_IP_PER_MIN=600`/`BURST=120`（决策默认 60/10）；`trustProxy=false` 使 XFF 不换桶
（PASS）；但 web 反代把所有浏览器用户汇聚为同一源 IP，桶按 web 容器共享 → 单个内网用户可耗尽 120 burst/600 每分钟，
让同侪全部 429。**闭环判据**：按用户身份限流（依赖 SEC-006 的身份缺口）或至少恢复默认阈值并记录容量口径（A13/A0）。

## 7. SEC-006（合规事实，定性归 H3）无法技术证明「仅个人查看」

**事实**：无用户身份（web 匿名 200；`E2E_AUTH_TOKEN` 为空，dev-token 仍 401；Basic Auth 只活在已停的 `ms-nginx` 上）、
无访问审计（audit=0）、无按用户限流；任一隧道持有者可二次转发（端口转发），服务端无可观测阻断证据。
**A9 只提交技术事实，不定性**：按 L100，内网≠免授权；「熟人小范围、不收费」= 再分发，权利基础归 H3/tushare 书面确认。
**闭环判据**：H3 出书面口径；技术侧由 `../test-cases/` 的 EXC-TUNNEL-01 提供「服务端能否区分第三人」的事实证据。

## 8. 证据索引

| 用途 | 路径 | 备注 |
|---|---|---|
| 主证据 | `infra/evidence/internal-exposure-redteam-20261104T2356Z.txt` | commit `370c6bb`；302 行；authoritative |
| errata | commit `0657fc1` | 公网 PASS=当时无监听，非网络层拒绝 |
| manifest | `infra/evidence/evidence-manifest.json` | sha256/bytes 外置登记 |
| compose 期望 | `tests/e2e/docker-compose.yml:110-111` | `ENTITLEMENT_HOLD_CHECK: "1"` / `ENTITLEMENT_AUDIT: "1"` |
| 口径 | `agents/decisions.md` L91 / L98 / L99 / L100；§5 14 条基线 | 内网裁定 / ④ PASS / P2 关闭 / 合规定性 |

## 9. 处置进展（2026-11-05T00:08Z，A9 只读复核 A13 证据；追加，不改上文原判定）

**证据**：`infra/evidence/host-hardening-20261105T0008Z.md`（A13，H5 授权在 ECS 47.120.16.239 `heyuan` 执行）、
`infra/evidence/host-baseline-after-20261105T0004Z.txt`、`infra/evidence/host-mutation-selftest-20261105T0010Z.txt`、
commit `5ea7e97`（脚本修复）/`9bc29fb`（自证）。

| ID | 主机侧新事实 | 结论 |
|---|---|---|
| SEC-001 | fail2ban 0.11.2-6 active + sshd jail（maxretry=5/findtime=10m/bantime=1h）→ ⑤-3 达成；但 `PermitRootLogin=yes`、`PasswordAuthentication=yes`、`MaxAuthTries=6`、`22/tcp ALLOW Anywhere` **均未变** | **仍 OPEN（P1 不降级）**；须按 H5 P0：具名非 root 账号 + sudo + 仅密钥 + 22 白名单后，才可复核闭环 |
| SEC-002 | `ms-nginx` 已 `docker rm`（htpasswd 归档 `/opt/ms-nginx/htpasswd.archived-20261104T235817Z` 0600；A13 另归档 `/root/a13-archive/ms-nginx-20261105T0002Z/`）；ufw 删至仅 `22/tcp`（v4+v6）；after 审计 `PASS 通配监听仅限 22`、无 `0.0.0.0` 残留绑定 | **主机侧事实消除**；**云 SG 仍未验证**（A19 E1–E4 证 SG 仍放行 80/8888）→ 按 H5 三档证据：无 JSON/截图则 ⑤-5 PARTIAL，不写 PASS |
| SEC-003 | e2e api 已重建：`ENTITLEMENT_AUDIT=1`/`HOLD_CHECK=1`/`TIER=internal_eval`/`APP_PROFILE=e2e`，/healthz 200；一次性容器 `a13-r3-audit`（`c_end_display`，127.0.0.1:8092）复现 hold 生命周期：quote 200 → raise_hold → 2s 内仍 200、35s 后 403+`no-store`、`/healthz entitlement_degraded=true reason=hold_active` → clear_hold 后 35s 回 200；`audit.entitlement_events` 2→5→6 行、hash 链相接、`verify_entitlement_chain()` 0 行 | **主机侧单次隔离验证 PASS**；**不自行改门禁 4/6**：须 A11/task-8 按门禁口径签（隔离栈 vs 生产栈边界须注明） |
| SEC-004 | 路径未变（root/docker 仍是数据面控制者）；H5 已要求主机管理面 P0 具名账号 + sudo，并在威胁模型写明「该账号=数据面控制者」 | **已知边界不变**；不得写「API 门禁=数据面已保护」 |
| SEC-005 | 未变（限流阈值/桶行为无改动） | **仍 OPEN** |
| SEC-006 | H5 2026-11-05 已拍板：内网用户面**必须认证**，选 A 档（单用户凭据 + 反代唯一判定点 + 每请求主体 + 401 默认拒绝 + 会话≤12h 可吊销）；多人须 F1 书面授权 + H3 口径 + OIDC，之前只允许单用户 | 技术缺口**待实现**（A4/A3 实现、A11 测、A13 部署，H5 估 1–1.5 人日，11-12 前） |
| R7 | 脚本 5 类缺陷全修（6 处 `${VAR}`、`export LC_ALL=C`、ufw From 列、env 缺失 FAIL、fail2ban、IPv6）；自证 9 类注入全 FAIL + `SELFTEST PASS` exit 0、合成干净态 exit 0、真实变异 `docker create -p 0.0.0.0:8899:80` 被检出；`infra/ops/host-baseline-gaps.md` 登记 HOST-BASELINE-01 | **B 档就绪**（AC-3/AC-5 达成，AC-5 残留 R-⑤7-1：无 marker env 的容器 env 检查静默跳过）；**A 档 IaC 未做 → 基线 #11 违反仍在**，gate「只走 IaC」保持 BLOCKED |

**未变**：SEC-001 仍为 P1 release-blocking，release gate 仍 BLOCKED（⑤-1/2/4 + ⑤-5 SG + A 档 IaC）。
**A9 未做**：未在真实主机执行任何变更/探测；以上均为对 A13 证据的完整性核对，非 A9 复测。
