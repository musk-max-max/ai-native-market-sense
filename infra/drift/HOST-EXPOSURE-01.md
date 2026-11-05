# HOST-EXPOSURE-01（P2）：公网暴露巡检 — 方案（待 H5 过目）

- 立项：H5 认定（L104）、Lead m03644；与 HOST-BASELINE-01（主机态 IaC 缺口）、HOST-AUDIT-01（非交互命令审计）并列。
- 背景：用户裁定 SG 保留 80/8888（L103）→ 云侧永久放行；ms-nginx P2 就是「临时容器 + 0.0.0.0:80」路径。任何公网测试窗口开启前必须先跑本巡检。
- 约束：只读检测 + 告警/隔离；**不开公网、不动 SG/ufw/sshd**；隔离动作只 `docker stop` + `docker update --restart=no`（不删容器/卷）。

## 1. 检测面（每次部署后 + 每日）

| #   | 检查                                                                   | 判定                                                                                                              | 证据                                |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | 公网放行端口（`EXPECTED_PUBLIC_PORTS="80 8888"`，另含 22）上的通配监听 | `ss -ltnp` 出现 `0.0.0.0:<port>` 或 `[::]:<port>` → FAIL                                                          | 原始 ss 行 + 端口                   |
| 2   | 容器端口绑定                                                           | `docker inspect` 的 `PortBindings` 中 `HostIp` 为 `0.0.0.0`/`::`/空 → FAIL（含 stopped/created）                  | 容器名 + binds JSON                 |
| 3   | 非 IaC 容器                                                            | 缺 `com.docker.compose.project` 标签 → FAIL（对齐 HOST-BASELINE-01）                                              | 容器名 + labels                     |
| 4   | 未认证 `/healthz`、`/metrics`                                          | 仅当 `EXPECTED_PUBLIC_HOST` 已配置（公网窗口开启）时探测；HTTP 2xx/3xx → FAIL；未配置 = **UNVERIFIED**，不当 PASS | 状态码 + body 长度（不落敏感 body） |
| 5   | 非 loopback 监听（通用兜底）                                           | 除允许端口（22）外任何通配监听 → FAIL（沿用 ⑤-7 现有规则）                                                        | ss 行                               |

## 2. 节奏与接线

- **部署钩子**：`deploy-dev.yml` / `preview-up.sh` 部署后跑一次，作为 release 记录的一部分；失败不阻塞重启但必须进 summary 与告警（待 H5 确认是否要 fail-closed 阻塞部署）。
- **每日**：`infra/drift/market-sense-host-baseline.service` + `.timer`（每日 09:13 Asia/Shanghai，`Persistent=true`）；输出写 node_exporter textfile `host_baseline_exposure_hits`。
- **告警**：`HostExposureDrift`（critical，`host_baseline_exposure_hits > 0`，for 10m）→ 复用现有 alertmanager critical 路由；runbook `docs/runbook/exposure-verification.md` §9。
- **自动隔离**：脚本 `--auto-isolate`（环境 `HOST_EXPOSURE_AUTO_ISOLATE=1`，默认关闭=只报）。命中且满足以下之一才停：①容器无 compose 标签；②在公网端口发布通配绑定。动作：`docker stop <c>` + `docker update --restart=no <c>`，记录 JSON；**不删除**，不碰卷/网络/SG。白名单端口 22 的 sshd 永不隔离。
- **去重**：同一容器+端口 10 分钟内只告警一次（由 Alertmanager `for` 与 textfile 指标承担，不在脚本内做状态存储）。

## 3. 验收（H5 定）

1. A19 在 ECS 注入 `docker create --name ... -p 0.0.0.0:8888:80 <image>`（不启动，避免真暴露）；
2. 一个检查周期内脚本检出（证据：#1/#2 FAIL + `ALERT HOST-EXPOSURE-01 ...` + `SUGGEST`/`ISOLATED` 行）；
3. 处置：`docker stop`（若容器 running）或 `docker rm`（测试容器，由 A19/A13 清理）；`docker ps -a` 无残留；
4. 证据落 `infra/evidence/host-exposure-01-detection-<UTC>.txt`，登记 `evidence-manifest.json`（authoritative/post-fix，case_id=HOST-EXPOSURE-01），checker 绿；
5. A19 出注入用例与复核结论，A13 出检测与证据，双方签字后 H5 核。

## 4. H5 拍板（m03665 / L105，已生效）

- **A = b：自动隔离默认开启（窄口径）**。只停：①公网放行端口 80/8888 上 running 容器的通配绑定；②`PortBindings` 通配且容器在跑。动作 `docker stop` + `docker update --restart=no`；不删容器/卷，不碰 SG/ufw/sshd，22 永不隔离。其它命中只 `ALERT`，观察一周用 textfile 统计误报；告警 15min 未 ack 升级 Lead。
- **B = b：部署钩子 fail-closed，范围收窄**。`FAIL` 或 `UNVERIFIED` 且本次发布改动了暴露面（端口绑定/ingress/SG）→ 阻塞并按需回滚；纯代码发布只告警。break-glass 只能 H5 书面批，agent 不自批。

## 5. 已实现（本方案提交时）

- `host-baseline-audit.sh` 新增 §2b：公网端口通配监听、容器通配绑定（含 created）、公网未认证 healthz/metrics（未配置=UNVERIFIED）、`ALERT`/`SUGGEST`/`ISOLATED` 行、webhook/textfile 接入点、`--self-test` 夹具扩展。
- `host-baseline.expected.env`：`EXPECTED_PUBLIC_PORTS="80 8888"`、`EXPECTED_PUBLIC_HOST=""`、webhook/textfile 说明。
- 已做：systemd service/timer（`infra/drift/systemd/`，每日 09:13 Asia/Shanghai + 部署后）、`HostExposureDrift` 告警规则、`deploy.sh` 部署钩子（B=b：EXPOSURE_AFFECTING + HOST_AUDIT_SSH，失败回滚 exit 7）、runbook §9。
- 已做：ECS 安装 timer（首次 2026-11-06 09:13 CST）、A19 指定注入验收（`host-exposure-01-detection-20261105T014106Z`）、自动隔离路径验收（`host-exposure-01-isolation-20261105T014128Z`），均入 manifest。
- 部署绑定：`host-baseline-audit.sh` sha256 `119277ab56306208a9f8a00e991e7106d8f33467cb6b0c7a1a3deca558984ccb`、`host-baseline.expected.env` `5da1bc8c213ff9331630582073ac508c149d04d48f43051a20a41d15a12023ba`（仓库与 ECS 一致）。过程消息里出现过的 `44608e4c…` 是打补丁前旧版，不是登记 artifact，不作签字绑定。
- A19 独立注入复核已入 manifest：`host-exposure-01-a19-verify-20261105T014333Z.txt` sha256 `9ece8b1b…`（created/running 两路径均检出并处置，清理无残留）。
- **H5 m03818 终签 PASS**（2026-11-05，A13 实现 + A19 独立复核；绑定 script `119277ab…` / expected `5da1bc8c…` / 检测 `f8060272…` / 隔离 `266eb67f…` / A19 `9ece8b1b…` / commit `740131e`）。residual 不变：`HOST_AUDIT_SSH` 未配（fail-closed exit 8，L106 绑 11-12）、22 Anywhere/`EXPECTED_PUBLIC_HOST` UNVERIFIED（既有 ⑤）、一周误报观察期照跑。`HOST_AUDIT_SSH` 仓库变量待 Lead 配置（未配时暴露面变更发布会按 B=b 阻塞）。
