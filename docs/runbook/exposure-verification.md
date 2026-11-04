# 暴露面验证 / 内网可达与公网不可达（RB-SEC-001）

> **状态（2026-11-05）**：按 Lead m03310 / 用户 m05225、m05235 与 `agents/decisions.md` L91，入口裁定为**内网访问、不暴露公网**。④ 的口径从「公网 ingress 四件套」降级为 **A. 内网可达 + B. 公网不可达** 双向取证。`ms-nginx` 临时层**永久不恢复**（随内网裁定，原 P2 暴露事件消解，加固留档）。
>
> 已交证据（authoritative，待 H5 核）：
>
> - `infra/evidence/exposure-internal-20261104T234904Z.txt`（ECS 侧：业务端口仅 loopback、容器 PortBindings 全 127.0.0.1、ms-nginx exited/restart=no、内网 API /healthz 200、quote 403、web 200）
> - `infra/evidence/exposure-public-20261104T234826Z.txt`（公网侧：`47.120.16.239` 的 80/8081/3000/18081 全部无 HTTP 响应）
> - 静态：`infra/evidence/exposure-static-guard-20261104T0615Z.txt`（helm 渲染只 `/v1`、5 条 NetworkPolicy）
>
> 安全组 80 由用户在云控制台处置；ECS 侧无法验证安全组，只能验证「无 0.0.0.0 监听 + 端口不可达」。任何一方把 `ms-nginx` 或端口重新发布到 0.0.0.0，都按 P1 处理。

## 1. 症状（触发）

- 监控/巡检发现 ECS 出现非 loopback 的业务端口监听（`ss -ltnp` 中 `0.0.0.0:<业务端口>` 或 `[::]:`）。
- 公网 `http://<public-ip>:<业务端口>/` 返回可观测 HTTP（200/403/401 等），而非连接拒绝/超时。
- `ms-nginx` 或其它临时层容器处于 running，或 `restart` 策略为 `always`/`unless-stopped`。
- ingress 渲染出现 `/`、`/healthz`、`/metrics`、`/docs`、`/openapi.json`、`/readyz`、`/internal` 等非 `/v1` 路径。

## 2. 影响

- 内网可达是预期能力；**公网可达**会把 `/healthz` 内部状态（`entitlement_degraded`、`data_ready_reason`）和 `/v1/**` 业务接口暴露给未授权方，等于免费情报（hold 状态/授权是否过期/数据链路断点）。
- `ms-nginx` 手工 Basic Auth 层不是 Helm ingress，验证的是手写配置而非发布物；其暴露会把 e2e 栈（含测试后门风险）带上公网。
- 按 L91，本项目**不需要**公网 ingress；任何公网可达都视为配置漂移/事故，不是"功能特性"。

## 3. 判断（≤5 分钟）

1. `ss -ltnp | grep -E ':(80|8080|8081|3000|18080|18081|5432|6379)\b'`：除 `sshd:22` 外出现 `0.0.0.0`/`[::]` → 立即按公网暴露处理。
2. `docker ps -a --format '{{.Names}}\t{{.State}}'`：确认 `ms-nginx` 必须 `exited`，`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ms-nginx` 必须 `no`。
3. `docker inspect -f '{{json .HostConfig.PortBindings}}' <container>`：只允许 `HostIp=127.0.0.1`（或空）；出现 `0.0.0.0` → 暴露。
4. 公网退证：`curl -m 10 http://<public-ip>:<port>/` 必须 connection refused / timeout / `http=000`；任何 HTTP 状态码都算暴露。
5. 内网正向：本机/内网段 `curl 127.0.0.1:8081/healthz` = 200 且含 `data_ready`/`entitlement_degraded`；`/v1/instruments/SSE:600519/quote` = 200/403 均算可达；web `127.0.0.1:3000/` = 200。

## 4. 止血（确认公网暴露后立即执行）

1. **先停公网入口**：`docker stop <入口容器>`（如 `ms-nginx`）；不要 `docker restart`。若入口由云 LB/安全组提供，立即收紧安全组并报 H5。
2. 将容器 restart 策略改 `no`：`docker update --restart=no <container>`（仅元数据，不启动容器）；保留容器与日志用于复盘。
3. 只回退暴露面，不动业务容器：API/web 等仍保持在 loopback；若端口发布被改，恢复 compose override 为 `127.0.0.1:<host>:<container>`，走正常发布流程（需 H5 批准、A13 执行）。
4. 记录：容器名/端口/binding/restart 策略、发现时间、处置命令与时间、处置人；证据落 `infra/evidence/` 并登记 manifest（authority=authoritative，除非是演练）。
5. 若暴露窗口内有人带凭证访问 `/v1/**`，立刻轮换口令并交 access log 复盘（参考 P2 事件 `infra/evidence/drill/nginx-access-review-*.txt`）。

## 5. 升级

- P1（公网可访问内部端点/业务接口）：5 分钟内通知 H5 + Lead；15 分钟未止血按 `internal_eval` 降级并阻断发布。
- 安全组/云控制台侧配置：A13 不可改，报 Lead/用户处置；A13 只做 ECS 侧止损与取证。
- 发布门禁相关：`check-network-policy.mjs` 由 CI 自动拦截；本地复跑 `node infra/ci/check-network-policy.mjs`。

## 6. 复盘

- 证据包：`exposure-internal-*.txt` + `exposure-public-*.txt` + `exposure-static-guard-*.txt`，各带命令原文、时间戳、执行人、commit、原始输出与断言结果。
- 复盘问题：为什么会产生 0.0.0.0 监听/公网入口？变更是否经过发布流程？容器 restart 策略为何不是 no？如何用 CI 前向检查（静态渲染断言 + 端口发布 lint）防复发？
- 结论写入 `infra/ops/release-evidence-status.md` 与 decisions（由 Lead/H5 落）；`ms-nginx` 永久不恢复（L91）。

## 7. 取证命令（脚本）

```sh
# ECS 侧（内网可达 + 端口/绑定/restart 检查）；需 ssh 到 ECS
ssh root@<ecs> 'env COMMIT=<sha> sh -s -- --mode internal' \
  < infra/evidence/tools/capture-exposure.sh > infra/evidence/exposure-internal-<UTC>.txt

# 公网侧（不可达退证）；在能访问公网 IP 的机器上跑
COMMIT=<sha> sh infra/evidence/tools/capture-exposure.sh --mode public \
  > infra/evidence/exposure-public-<UTC>.txt
```

退出码：0 全部断言通过 / 2 用法错误 / 3 公网暴露 / 4 内网不可达 / 5 其他断言失败。证据文件不覆盖旧文件（H4 m02216：内容变则换新文件名）。
