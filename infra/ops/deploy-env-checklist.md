# 部署 env 清单（A13 维护，发布 gate 用）

规则：**生产只认显式值；缺省必须是 fail-closed（拒绝启动/拒绝渲染/拒绝部署），不允许「没配就走默认」**。
对齐 decisions：L46（`APP_PROFILE` 缺省 prod）、L73/L76（HOLD/AUDIT prod 必须显式）、L91（暴露面只内网）。
本清单由 `infra/ci/check-db-bootstrap.mjs` §9b 静态检查：新增/改名 env 必须同步本文件，否则 CI 红。

## 1. 全局 / helm 渲染期（prod 缺省即失败）

| 变量                     | prod 要求                                                | 缺省行为                                          | 来源                                               |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `APP_PROFILE`            | 显式 `prod`                                              | Helm 渲染断言缺失即 fail（values.yaml 默认 prod） | `infra/helm/market-sense/templates/configmap.yaml` |
| `DEPLOYMENT_UID`         | 发布流水线注入，非空                                     | prod 为空拒绝渲染                                 | 同上                                               |
| `TRUST_PROXY`            | 单个窄网段（IPv4 ≥/24、IPv6 ≥/64）                       | 空/宽网段/回环拒绝渲染                            | 同上                                               |
| `ENTITLEMENT_TIER`       | 显式；非 `internal_eval` 必须配 `ENTITLEMENT_EXPIRES_AT` | 空拒绝渲染；非 internal_eval 缺 expires 拒绝渲染  | `configmap.yaml`                                   |
| `ENTITLEMENT_HOLD_CHECK` | prod 显式 `1`（HOLD 控制面检查）                         | 未配不启用检查 = 放行；CI 静态断言要求显式        | `services/market/src/config.ts`                    |
| `ENTITLEMENT_AUDIT`      | prod 显式 `1`（授权审计写）                              | 未配不写审计（静默合规缺口）                      | 同上                                               |

发布前 preflight（人工，H5 见证书）：`helm template ... --set config.DEPLOYMENT_UID=$GIT_SHA` 必须成功；对渲染结果 `grep -E 'APP_PROFILE: "prod"|ENTITLEMENT_(HOLD_CHECK|AUDIT): "1"'` 全部命中。

## 2. identity 服务（A4；prod 缺省 fail-closed）

`services/identity/src/config.ts` 在启动时校验；下面「prod 缺省」列是发布 gate 必须满足的条件，不是建议。

| 变量                                     | 默认                           | prod 缺省/取值规则                                                                                                                                |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDENTITY_JWT_SECRET`                    | **无默认值**（必填，长度 ≥32） | 缺失即失败（进程拒绝启动）；必须由 secret manager 注入，禁止写进 values/仓库。轮换用双密钥窗口由 A4 提供。                                        |
| `IDENTITY_JWT_AUDIENCE`                  | `market-sense`                 | prod 必须为 `market-sense`（不接受通配 audience）。                                                                                               |
| `IDENTITY_JWT_TTL_SECONDS`               | `28800`                        | 显式值；不允许无限期 token。                                                                                                                      |
| `IDENTITY_ACCEPT_LEGACY_TOKENS`          | `true`                         | **prod 必须显式**（不依赖默认）：S0–S3 过渡期为 `true` 且 H5 签豁免；S4 全量重签后必须 `false`，未切换视同发布阻断（legacy 令牌可绕过新身份链）。 |
| `IDENTITY_PASSWORD_MIN_LENGTH`           | `12`                           | prod 不得低于 12。                                                                                                                                |
| `IDENTITY_INTERNAL_REGISTRATION_ENABLED` | `false`                        | prod 默认关闭；开启时必须同时提供 `IDENTITY_INTERNAL_INVITE_SHA256` 与 `IDENTITY_SOURCE_IP_HASH_SALT`（≥16），否则启动失败。                      |
| `IDENTITY_INTERNAL_INVITE_SHA256`        | 空                             | 开启内部注册时必填（sha256 hex）。                                                                                                                |
| `IDENTITY_COMPANY_EMAIL_DOMAINS`         | 空                             | 开启内部注册时必填（逗号分隔白名单）。                                                                                                            |
| `IDENTITY_SOURCE_IP_HASH_SALT`           | 空                             | 开启内部注册时必填，≥16；不得与任何环境共用。                                                                                                     |
| `IDENTITY_APPROVAL_ENV`                  | 空                             | **prod 必须显式 `prod`**（空只允许 dev/test；缺失时审批流无环境前缀，会混线）。                                                                   |
| `DATABASE_URL`                           | 无                             | 必填；identity 角色最小权限（见 10_roles.sql）。prod 必须是池化连接串，禁止超级用户。                                                             |

preflight（发布前人工跑）：

```bash
# 只打印键名，不打印值
env | grep '^IDENTITY_' | cut -d= -f1 | sort
# 必须命中：IDENTITY_APPROVAL_ENV / IDENTITY_JWT_AUDIENCE / IDENTITY_JWT_SECRET /
#           IDENTITY_ACCEPT_LEGACY_TOKENS（过渡期）等上表 prod 必须显式的项
```

失败处置：缺 `JWT_SECRET`/`APPROVAL_ENV`（prod）或内部注册条件不全 → 不启动/不发布，按 `docs/runbook/release-rollback.md` 回滚；属发布阻断，不允许「先上再补」。

## 3. identity 迁移

`services/identity/migrations/*.sql` 由 `infra/scripts/db-migrate.sh` 按 `services/*/migrations/*.sql` 自动发现（不维护服务清单；新增服务无需改脚本）。先 `db-migrate --env <env> --dry-run` 确认列表含 identity 迁移，再执行；生产仍需 `APPROVAL_REF`。
