# RB-ENT-002 测试 profile 隔离与授权 env 审计

- **Runbook ID**：RB-ENT-002
- **Owner**：A13（sre）；审批/签字 H5；相关：A3（代码）、A12（e2e compose）、Lead（临时层）
- **适用范围**：`APP_PROFILE=e2e|dev` 或 `E2E_MODE=1` 的行情实例（尤其 e2e compose 栈、Lead 临时 nginx 层、本机真栈）
- **关联缺陷**：KD-ENT-01（`services/market/src/config.ts` 在 `E2E_MODE=1` 时默认关 hold/audit、跳过 sha 自检）

## 症状

出现以下任一即进入本 runbook：

1. 公网或非隔离网络可达的实例上出现 `APP_PROFILE=e2e`、`E2E_MODE=1`；
2. `ENTITLEMENT_TIER != internal_eval`，但 `ENTITLEMENT_HOLD_CHECK != 1` 或 `ENTITLEMENT_AUDIT != 1` 或 `ENTITLEMENT_CONFIG_EXPECTED_SHA256` 为空（数据面旁路嫌疑）；
3. 审计发现测试 profile 容器发布了 `0.0.0.0` 端口，或经 ingress/nginx 对外可达；
4. KD-ENT-01 修复前，e2e 栈的 hold/audit 行为与生产口径不一致，却有人拿它当发布验收证据。

## 影响

- 测试 profile 下 hold/audit 默认关闭、sha 自检被跳过：授权过期/hold/配置漂移**不会** fail-closed，可能静默展示受限行情；
- 若同时公网可达，等于把「无 hold、无审计留痕」的数据面暴露给匿名/共享口令用户；
- 证据层面：测试 profile 的 200/403 不能代表生产 profile 行为，用它签字会造成「假通过」。

## 判断

1. 枚举实例与端口（只读）：
   ```sh
   docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
   for c in $(docker ps --format '{{.Names}}'); do
     echo "--- $c"; docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' \
       | grep -E '^(APP_PROFILE|E2E_MODE|ENTITLEMENT_TIER|ENTITLEMENT_HOLD_CHECK|ENTITLEMENT_AUDIT|ENTITLEMENT_CONFIG_EXPECTED_SHA256)='
   done
   ```
2. 判定矩阵：
   - `ENTITLEMENT_TIER=internal_eval`：允许测试 profile 存在，但**必须**网络隔离（仅 loopback/内网，禁止公网）；
   - `ENTITLEMENT_TIER != internal_eval`：必须 `HOLD_CHECK=1` + `AUDIT=1` + `EXPECTED_SHA` 非空，缺一即按数据面旁路处理；
   - 公网入口暴露 `APP_PROFILE=e2e` / `E2E_MODE=1`：无论 tier 为何，**立即停**。
3. 记录实例名、时间、env 快照（不含密钥明文；sha 只记 empty/set+len）、端口发布。

## 止血

1. **停公网暴露优先**：`docker stop <public-layer-container>`（如 `ms-nginx`）；容器停掉即释放 80，不需要改配置；安全组由用户侧收紧。
2. 公网可达 + `E2E_MODE=1`：立即停该实例/层，报 H5 与 Lead；恢复前四条必须齐：
   - ① `APP_PROFILE=prod`（或独立干净栈），无 `E2E_MODE`/`E2E_AUTH_TOKEN`；
   - ② ingress/nginx `server_tokens off`；
   - ③ 安全组只放行指定 IP（或保持关闭）；
   - ④ Basic Auth 口令轮换且不复用。
3. `ENTITLEMENT_TIER != internal_eval` 缺 hold/audit/sha：停实例并报 H5，按 KD-ENT-01 处置；不得用「补 env 后重启」掩盖，先查为何 bypass 被默认打开。
4. 恢复后复核：`docker inspect` env、公网 404/401 行为、`/healthz` body 不含内部状态、access log 无第三方持证 2xx；证据落 `infra/evidence/`（authority=drill 或与场景匹配，不冒充 prod 证据）。

## 升级

- 公网可达 + 测试 profile：**立即** H5 + Lead（P1/P2 由 H5 定级）；A13 只做核查与 containment，恢复动作归 Lead。
- `ENTITLEMENT_TIER != internal_eval` 的旁路：H5 + A3（代码修复），11-08 前给出修复与回归；期间保持关闭。
- 涉及发布签字：H5 终签；测试 profile 结果只能标 drill/residual，不得进 authoritative。
- 面向用户：Lead 负责对外说明与用户决策（入口/安全组/域名）。

## 复盘

- 根因分类：部署时用了测试 profile 而非干净 prod profile；或 compose 默认值让 `E2E_MODE=1` 打开 hold/audit 旁路；或 ingress 层 `path: /` 暴露内部端点。
- 必须落动作（带 owner/日期）：
  - A12：e2e compose 的行情服务 `ENTITLEMENT_TIER: internal_eval` 固定；`c_end_display` 正向用例走独立 compose/override，显式 `HOLD_CHECK=1`+`AUDIT=1`+`EXPECTED_SHA`；
  - A13：本 runbook + 审计证据 + 临时层 containment；恢复后验证四条前置；
  - A3：KD-ENT-01 代码修复（E2E_MODE 不再隐式关 hold/audit、不再跳过 sha 自检）、回归测试；
  - Lead/H5：事件台账、用户沟通、安全组与入口决策。
- 防复发门禁：CI/部署前静态检查 `APP_PROFILE`/`E2E_MODE`/ entitlement env 组合；`E2E_MODE=1` 只允许 loopback/内网；测试 profile 结果不得用于 release 签字。
