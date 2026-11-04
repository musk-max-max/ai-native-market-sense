# RB-SEC-001 公网暴露面收口验证（/healthz、/metrics、/\_debug、/internal）

**状态（2026-11-04）**：静态门禁已落（`infra/ci/check-network-policy.mjs`）；**集群外 404 实测 = UNVERIFIED**（缺 staging 公网入口 `PUBLIC_BASE_URL`，owner A13/H5）。本 runbook 是拿到环境后的执行步骤与取证口径。

## 症状

- 外部可直接 `GET /healthz`、`/metrics`、`/_debug`、`/internal*`；
- `/healthz` 泄露内部状态机（`entitlement_degraded_reason`、`data_ready_reason`、hold 状态）；
- Ingress 出现 `path: /`、`/healthz`、`/metrics`、`/docs`、`/openapi.json`、`/readyz`、`/internal` 任一路径。

## 影响

攻击者无需登录即可读取"当前是否 hold / 授权是否过期 / 数据链路断在哪一步"，据此选择下手时机；运维接口暴露面扩大。属 11-12 门禁 #7 的硬缺口。

## 判断（≤2 分钟）

1. `helm template ... | grep -nE 'path: *[/]|/healthz|/metrics|/docs|/openapi.json|/readyz|/internal'` 有任何命中即红；
2. 外部 `curl -sS -o /dev/null -w '%{http_code}' https://$BASE/healthz` 必须 `404`（不是 200、不是 401/403）；
3. Pod 内 `curl -sS http://127.0.0.1:8081/healthz` 必须 `200`（探针直连 Pod，不经 ingress）；
4. 响应头/响应体不得出现 `entitlement_degraded_reason`、`hold_reason`、DSN/主机名/端口。

## 止血

1. 立刻回滚 ingress 变更（`infra/scripts/rollback.sh production <release>`，须 H5 `APPROVAL_REF`，A13 只执行）；
2. 或把 ingress path 收敛为 `/v1` 并 `helm upgrade --atomic`（同发布流程，禁 `kubectl edit`）；
3. 若已泄露内部状态：按 H5 工单保留证据（时间、响应体、来源 IP），评估是否需 H5 对外沟通。

## 升级

- P1：外部连续 5 分钟可访问内部端点 → H5 + lead；
- 涉及生产发布 → H5 批准后 A13 执行；本 runbook 不授予任何人手工改生产 ingress 的权限。

## 复盘

- 证据入包：`infra/evidence/` 新文件（UTC 时间戳命名），`manifest.json` 记 `authority`/`phase`/`sha256`/`case_ids=["L77","H5-R19"]`；
- 外部 404 / Pod 200 / helm 静态守卫三份原始输出 + 复算命令/人/时间；
- 若用 `allow-monitoring` 放行整个 `http` 端口：补 `/metrics` 时须独立端口或 A11 断言命名空间隔离（H4 提醒），否则视为未收口。

## 当前阻塞

`PUBLIC_BASE_URL`（staging 域名 + 可达性）未提供 → 外部 404 与 Pod 200 无法实测；在 `docs/release` 与释放说明中必须写 `UNVERIFIED`，不得计入 PASS。

## 当前状态（2026-11-04T06:15Z，A13）

- **静态守卫：已过**（证据 `infra/evidence/exposure-static-guard-20261104T0615Z.txt`，入 evidence-manifest）：`helm template` 渲染后 Ingress 路径只有 `/v1`；`/`、`/healthz`、`/metrics`、`/docs`、`/openapi.json`、`/readyz`、`/internal` 均不在 ingress；NetworkPolicy 5 条（default-deny ingress/egress、allow ingress-controller、allow monitoring 限定命名空间且只 http 端口、DNS）；Service 未暴露 metrics 端口。
- **集群外 `/healthz`、`/metrics` 实测：UNVERIFIED**。阻塞：缺真实 ingress host / `PUBLIC_BASE_URL` 与公网可达（安全组/入口）——需 Lead/用户确认开入口或提供 staging 集群；不在 A13 代码侧。拿到入口后 30–60 分钟内出「外部 404（含响应头/时间戳/执行人）+ Pod 内 200」两条证据。
- **`/metrics` 口径**：当前未实现。实现时必须二选一：①独立端口（不复用 8080）；②A11 断言仅 monitoring 命名空间可达 8080。在此之前，`allow-monitoring` 的 8080 放行是命名空间受限的临时口径，不得视为永久豁免；`check-network-policy.mjs` 会在出现 metrics 端口/路径时要求 `METRICS_ISOLATION_APPROVED=1` 并应走上述二选一评审。

## 入口到位后的执行模板（脚本，勿现写）

前置：拿到真实 ingress host（`EXPOSURE_HOST`）、运行中的 api pod（`POD`）、命名空间（`NS`，默认 `market-sense-dev`）、执行人（`EXECUTOR`）。

```sh
# 预演（不联网）：
infra/evidence/tools/capture-exposure.sh --dry-run

# 正式取证：
EXPOSURE_HOST=<ingress-host> NS=<namespace> POD=<api-pod> EXECUTOR="A13 (a13-sre)" \
  infra/evidence/tools/capture-exposure.sh
```

脚本一次产出 `infra/evidence/exposure-live-<UTC>.txt`，内含：命令原文、commit、时间戳、执行人、runtime、四条请求的响应头/状态码/body，以及断言结果（external `/healthz`、`/metrics` 必须非 200 且 body 不含 `entitlement_degraded|hold_reason|data_ready_reason`；internal `/healthz` 必须 200 且含 `data_ready`+`entitlement_degraded`）。退出码：0 PASS / 3 外部失败 / 4 内部失败。跑完把文件 path/bytes/sha256/authority/phase/case_ids 加进 `infra/evidence/evidence-manifest.json`（新文件名，不覆盖旧证据）。
