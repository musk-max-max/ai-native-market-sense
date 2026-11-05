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

## 4. 待 H5 确认（两个选择题）

- **A. 自动隔离默认值**：a) 默认关闭，timer 部署时开启（本方案，先观察一周）；b) 默认开启，任何命中即停（更安全但可能停掉正在排障的容器）。
- **B. 部署钩子失败语义**：a) 只告警不阻塞（本方案）；b) 公网暴露命中即阻塞部署并回滚。

## 5. 已实现（本方案提交时）

- `host-baseline-audit.sh` 新增 §2b：公网端口通配监听、容器通配绑定（含 created）、公网未认证 healthz/metrics（未配置=UNVERIFIED）、`ALERT`/`SUGGEST`/`ISOLATED` 行、webhook/textfile 接入点、`--self-test` 夹具扩展。
- `host-baseline.expected.env`：`EXPECTED_PUBLIC_PORTS="80 8888"`、`EXPECTED_PUBLIC_HOST=""`、webhook/textfile 说明。
- 未做（等确认后）：systemd 单元、HostExposureDrift 告警规则、部署钩子接线、ECS 注入验收。
