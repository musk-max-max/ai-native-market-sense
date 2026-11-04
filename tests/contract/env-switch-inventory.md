# 授权判定相关环境开关清单（L73）

扫描：A11，2026-11-04 09:22（Asia/Shanghai），`grep -rn "ENTITLEMENT_[A-Z_]*\|*_CHECK\|*_DISABLE\|*_BYPASS\|E2E_MODE\|DEV_AUTH" services/ web/h5/src/ tests/ infra/ warehouse/`
结论：**能关掉授权判定的开关只有 `ENTITLEMENT_HOLD_CHECK`，且仅在 dev/test/e2e profile 下允许 `=0`；prod（含 APP_PROFILE 缺省/拼错）设 0 启动即失败**（A3 已实现 L73 守卫）。其余为审计/表名/限流/测试入口类，不能把 403 变 200。

## 0. A3 提供的白名单（m02506，2026-11-04 09:22；A11 已逐条核对代码位置）

- **prod 拒启（安全判定不可关）**：`ENTITLEMENT_HOLD_CHECK=0`（`config.ts:173`，L73）、`MARKET_NOW`（`config.ts:180`，冻结时钟可绕过 `expires_at`，L73 自查）、`E2E_MODE=1`、`E2E_AUTH_TOKEN`、`WATCHLIST_DEV_AUTH=1`（`config.ts:163-165`）。
- **配置权威、不可“关”**：`ENTITLEMENT_TIER`（缺省 internal_eval）、`ENTITLEMENT_EXPIRES_AT`（非 internal 必填）、`ENTITLEMENT_CONFIG_EXPECTED_SHA256`（prod 非 internal 必填）。
- **白名单（存在但不影响授权判定）**：`DATABASE_URL`、`DEPLOYMENT_UID`、`RELEASE_ID`、`WATCHLIST_LIMIT`、`WATCHLIST_TABLE`、`E2E_WATCHLIST_TABLE`、`WATCHLIST_AUTO_MIGRATE`、`DISCLAIMER_TEXT`、`DISCLAIMER_VERSION`、`INGEST_REPORT_PATH`、`LOG_LEVEL`。
- **residual（待 H5/Lead 裁）**：`ENTITLEMENT_AUDIT=0`（吞审计证据，不改 allow/deny）、`EVENT_PAYLOADS_PATH`（可指向宽松契约，A3 指出）。

## 1. 授权判定直接相关

| env | 读取位置 | 语义 | prod 行为 | 判定 |
|---|---|---|---|---|
| `ENTITLEMENT_HOLD_CHECK` | `services/market/src/config.ts:225`；铁门在 `:173` | `=0` 关闭 control 行 hold/陈旧检查（含 hold/stale/不可达三路） | **`=0` 抛 `MarketConfigError` 拒绝启动**（L73，注释在 `:171-177`）；缺省/`=1` 均开启（E2E profile 除外） | 不是旁路：prod 无法关闭；dev 可关属测试便利 |
| `ENTITLEMENT_TIER` | `services/market/src/config.ts:214` | 授权档位（`internal_eval` / `c_end_display` …）；`c_end_display` 需 `ENTITLEMENT_EXPIRES_AT` + `ENTITLEMENT_CONFIG_EXPECTED_SHA256` | 非 internal_eval 且缺到期时间 → 拒绝启动；档位只决定“是否放行”，改小是 fail-closed 方向 | 配置输入，不是开关 |
| `ENTITLEMENT_EXPIRES_AT` | `services/market/src/config.ts` | 本地时间盒；未设=视为已过期 | 过期即 effective=internal_eval → 403 | 输入，不可放大权限 |
| `ENTITLEMENT_CONFIG_EXPECTED_SHA256` | 同上 | 与 `sha256(tier|expiresAt)` 比对，防两条 env 被单独改 | 不一致 → `config_mismatch` 阻断（启动/请求） | 防篡改，不是旁路 |
| `ENTITLEMENT_AUDIT` | `services/market/src/config.ts:226` | `=0` 关闭审计事件写入（gate 仍判定） | **允许 `=0`**（仅少了审计证据；不改变 403/200） | 非授权开关，但会削弱可审计性；是否也应在 prod 锁死待 H4/A3 定 |
| `ENTITLEMENT_HOLD_TABLE` / `ENTITLEMENT_EVENTS_TABLE` | `services/market/src/adapters/pg-entitlement-*-repo.ts` | 改读/写表名 | 指错表 → control 读失败 → **fail-closed 403**（不是放行） | 不能放大权限 |
| `MARKET_NOW` | `services/market/src/config.ts:180` | 固定时钟；可把 now 停在 expires_at 之前，等价于绕过时间盒 | **prod 下设置即拒绝启动**（L73/A3 自查） | 曾被低估的第二类“时间旁路”，已封 |
| `EVENT_PAYLOADS_PATH` | A3 m02506 指出 | 指向事件 payload 契约 JSON，可被换成宽松契约绕过写入校验 | 运行期可设，prod 未限制 | **residual**：建议 prod 只读镜像内路径（owner A3/H4） |
| `ENTITLEMENT_AUDIT=0` | `services/market/src/config.ts:226` | 关闭审计事件写入（gate 仍判定） | **允许**（少证据、不改 403/200） | **residual**：A11 建议同 HOLD_CHECK 锁死（owner H4 拍板） |
| `DEPLOYMENT_UID` | `services/market/src/config.ts:184` | 审计归属/gap 去重键 | prod 缺失 → 拒绝启动 | 无授权语义 |

## 2. 固定身份/测试后门（prod 已被铁门拦截）

| env | 读取位置 | prod 行为 | 判定 |
|---|---|---|---|
| `E2E_MODE=1` | `services/market/src/config.ts:163`（`assertNoE2EBackdoorInProduction`） | 非 dev/test/e2e profile → 拒绝启动 | 启用 dev 身份+自动迁移，prod 不可用 |
| `WATCHLIST_DEV_AUTH=1` | 同上 `:164`，`allowDevAuth` 在 `:222` | 非 dev profile → 拒绝启动 | 固定身份入口，prod 不可用 |
| `E2E_AUTH_TOKEN` | 同上 `:165` | 非 dev profile → 拒绝启动 | 静态 token，prod 不可用 |
| `E2E_AUTH_USER_ID` / `E2E_WATCHLIST_TABLE` / `WATCHLIST_AUTO_MIGRATE` | `services/market/src/config.ts` | 只在 dev/e2e 有意义；autoMigrate 仅 e2e 或显式 `=1` | 无授权放行语义 |

## 3. 限流/路径类（可能影响 429 与桶，不改变授权判定）

| env | 读取位置 | 说明 |
|---|---|---|
| `TRUST_PROXY` | `services/api/src/config.ts:83-149` | 只接受单个窄 ingress 网段；`true`、`0.0.0.0/0`、`::/0`、回环、过宽 CIDR 均拒绝启动（A0 修复、A19 复验 4/4）。影响 XFF→IP 桶，不影响 403 判定 |
| `RATE_LIMIT_IP_PER_MIN` / `RATE_LIMIT_IP_BURST` / `RATE_LIMIT_CLUSTER_*` / `RATE_LIMIT_REDIS_FALLBACK_PER_MIN` | `services/api/src/config.ts:185-199` | 只影响 429 阈值；放大会降低限流强度（属 L36 限流桶验收，不是授权开关） |

## 4. 前端

`web/h5/src` 无 `ENTITLEMENT_*` 读取、无 ALLOW/BYPASS/FORCE 类放行 env；mock 分支受 `import.meta.env.DEV` 保护（`check_frontend_render_gate.py` 静态扫描 23 文件 PASS）。

## 5. 结论（L73）

- **唯一可关授权检查的开关：`ENTITLEMENT_HOLD_CHECK`**；prod 已由 A3 铁门拦截（`services/market/src/config.ts:173`），本次扫描未发现第二种。
- 需要 H4 拍板的两项 residual：①`ENTITLEMENT_AUDIT=0` 在 prod 是否也要拒绝（关审计证据但不关 403）；②`EVENT_PAYLOADS_PATH` 是否限定只读镜像内路径。A11 建议两者按 fail-closed 处理，理由：“审计缺失=不可举证”“契约可替换=校验可绕过”。
- `MARKET_NOW` 是 A3 在 L73 自查中补的第二类旁路（冻结时钟绕过 `expires_at`），已被 prod 铁门拦截；A3 单测 86/86 覆盖。
- 扫描方式为静态 grep + 逐处读 config 解析与 prod 守卫；未做运行时枚举（没有把所有 env 全组合起服务）。
