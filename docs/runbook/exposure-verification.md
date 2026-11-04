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
