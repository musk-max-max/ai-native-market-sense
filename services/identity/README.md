# services/identity（A4 · 用户 / 权限 / 审批）

A 股 market-sense H5 的**身份域**：用户注册/登录、C 端与内部用户分层、内部审批（人审）、
用户侧档位（`c_end_display | internal_eval | research_only`）、JWT 签发/校验、身份审计。

依据：`docs/adr/ADR-008-user-tiers-and-entitlement.md`（D1/D2/D9-S1）+ decisions.md L51（审批 id）。

## 边界（重要）

| 做                                                               | 不做（归谁）                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `services/identity/` 内全部身份逻辑、DB 迁移、审计                | `services/market/` 的 gate / 服务级 tier / 路由受众（A3）           |
| Principal 形状（`userId/userType/tier/sessionVersion`）的真源      | `services/api/` 的 principal 注入薄壳、全局错误处理（A0）           |
| 审批语义（状态机、人类审批人校验、`approval_ref`）                | 审批 UI / 管理后台（A8）、审批平台 BPM 引擎适配（P1，A4）           |
| JWT claims 判别式校验（c_end / internal_active 轴一致）            | 契约文件 `contracts/`（A0）、文案 `copy.ts`（A0/H3）                |
| 身份审计（独立 `identity.audit_events`）                           | `audit.entitlement_events` 的 DDL 变更（A5，见 `docs/integration.md`） |

**不写** `services/market/`、`services/api/`、`contracts/`、`tests/contract/`、`infra/`——ownership.yaml
与 path-guard 以 owner 判定越界。接线 patch 见 [`docs/integration.md`](docs/integration.md)。

## 目录

```
src/
  config.ts                env → 强类型配置（启动即校验，fail-closed）
  domain/                  纯领域：类型、状态机、principal、审批 id、错误
  auth/                    scrypt 密码、HS256 JWT、Bearer authenticator
  ports/                   Clock / IdGenerator / 仓储 / 审计接口
  adapters/                Memory（单测）与 PG（生产）实现
  service/identity-service.ts  注册 / 登录 / token 校验 / 审批 / 停用 / 改档
  plugin.ts                Fastify 域插件（外壳挂 /v1）
  index.ts                 公共出口
migrations/001_identity.sql  幂等 DDL（identity schema）
test/                         node --test 单测（43 项）
docs/integration.md           给 A0/A3/A5/A8/A13 的接线说明
```

## 状态机（ADR-008 D1）

```
公开注册 ──────────────► c_end（可登录；tier 恒为 c_end_display）
内部注册 ──────────────► internal_pending（不签 token；登录 403）
                            │ 人工通过（H3/user 人类）→ internal_active（+approval_ref，session_version+1）
                            │ 人工拒绝 → 申请 rejected，用户仍 pending（P1 可重申请）
任意用户 ──停用──────────► account_locked=true（user_type 不变，session_version+1）
internal_active ──改档──► internal_eval ⇄ research_only（session_version+1）
```

硬约束：

- `internal_pending` **永远不签 token**；登录 403 通用 FORBIDDEN，不暴露审核状态/原因（原因只进审计）。
- 审批人只能是**人类席位** `H3` / `user`；agent（含 A15）一律 403，即使带模型版本。
- `internal_active` 必须同时有 `approved_by/approved_at/approval_ref`（用户表 CHECK + 代码 fail-closed）。
- `research_only` 必须审批人显式选择**并给理由**；不允许 `c_end_display` 出现在内部档。
- 审批/改档/停用一律递增 `session_version`，旧 JWT 立即失效。

## JWT claims（H2 会签 L125）

```json
{ "sub": "usr_…", "aud": "market-sense", "user_type": "c_end", "tier": "c_end_display",
  "session_version": 0, "iat": 1793923200, "exp": 1793952000 }
```

- `aud` 单值 `market-sense`（不再做双 aud）。
- 判别式轴：`c_end → tier=c_end_display`；`internal_active → tier∈{internal_eval, research_only}` 且必须带
  `session_version`。
- 轴不一致 / 未知值 → **403 `claim_inconsistent`**，不得降级成 c_end。
- 旧 C 端 token（**完全没有** `user_type`）在 `IDENTITY_ACCEPT_LEGACY_TOKENS=true` 时按 `c_end` 处理（D9-S4，
  全量换发后关闭）。

## 环境变量

| 变量                                   | 必需     | 默认           | 说明                                                       |
| -------------------------------------- | -------- | -------------- | ---------------------------------------------------------- |
| `IDENTITY_JWT_SECRET`                  | 是       | —              | HS256 密钥，≥32 字符；缺失启动失败                          |
| `IDENTITY_JWT_AUDIENCE`                | 否       | `market-sense` | H2 裁定写死，非测试环境不要改                              |
| `IDENTITY_JWT_TTL_SECONDS`             | 否       | `28800`        | token 有效期（8h）                                          |
| `IDENTITY_ACCEPT_LEGACY_TOKENS`        | 否       | `true`         | S4 兼容开关；关闭后旧 token 一律 401                        |
| `IDENTITY_PASSWORD_MIN_LENGTH`         | 否       | `12`           | 不得小于 8                                                  |
| `IDENTITY_INTERNAL_REGISTRATION_ENABLED` | 否     | `false`        | P0 默认关闭内部注册                                         |
| `IDENTITY_INTERNAL_INVITE_SHA256`      | 条件     | —              | 邀请码 sha256（逗号分隔、小写 hex）；开启内部注册时与下一项至少一项 |
| `IDENTITY_COMPANY_EMAIL_DOMAINS`       | 条件     | —              | 企业邮箱域白名单（逗号分隔，小写）                          |
| `IDENTITY_SOURCE_IP_HASH_SALT`         | 条件     | —              | 开启内部注册时必填，≥16 字符（只存 IP 哈希）                |
| `IDENTITY_APPROVAL_ENV`                | 否       | 无前缀         | `prod` / `staging`；审批 id 前缀                            |
| `DATABASE_URL`                         | 运行时是 | —              | PG 连接串（插件自建 pool 时）                               |

## 路由（外壳挂 `/v1`）

| 方法 | 路径                        | 说明                                                     |
| ---- | --------------------------- | -------------------------------------------------------- |
| POST | `/v1/auth/register`         | C 端注册 → 201 `{user_id}`                               |
| POST | `/v1/internal/auth/register`| 内部注册 → 202 `{application_id, status:"pending"}`      |
| POST | `/v1/auth/login`            | 登录 → 200 `{token, expires_at}`；pending/locked 403     |
| GET  | `/v1/auth/me`               | Bearer → `{user_id,user_type,tier}`                      |

- 所有响应强制 `Cache-Control: no-store`（token/个人信息）。
- **P0 不暴露审批 HTTP 入口**：审批人人类身份需要 A0/A8 管理后台认证（H5+A9 签字前，HTTP 入口可能被
  agent 身份冒用）。审批逻辑在 `IdentityService`，A0 接线时注入真实人类 admin principal 即可。
- 错误统一为 `application/problem+json`：`title` 来自 `services/api/src/copy.ts`，`reason` 只进审计不回传。

## 审计

- 表：`identity.audit_events`（append-only，独立于 compliance 的 `audit.entitlement_events`）。
- 事件：`identity_registration` / `internal_registration` / `identity_login` / `identity_login_denied` /
  `internal_approval` / `internal_rejection` / `internal_tier_change` / `account_disabled` / `approval_denied`。
- 每条含：`actor{kind,id,model_version}`（agent 必填模型版本）、`subject_user_id`、`before/after` 快照、
  `reason`、`approval_ref`、`occurred_at`；**不含** `password_hash`。
- `internal_access` 事件由 A3 的 gate 在 **S3 起**写（S2 shadow 期不得写，避免双计）；本域不写。

## 邀请码运维（内部注册）

1. 生成随机码（≥32 字节熵），交付给受邀人（不要入库）。
2. 只把 `sha256(code)` 写入 `IDENTITY_INTERNAL_INVITE_SHA256`（多枚逗号分隔）。
3. DB 只存 `sha256(code)` 前 16 位作为 `invite_code_ref`（审计可追溯、不可逆）。
4. 轮换：加新哈希 → 关闭旧码 → 观察审计中 `invite_code_ref` 使用情况后移除旧哈希。

## 本地验证

```bash
cd services/identity
pnpm typecheck            # tsc --noEmit
pnpm test                 # node --import tsx --test test/*.test.ts（43 tests）
pnpm exec prettier --check src test migrations
```

PG 迁移由 `infra/scripts/db-migrate.sh` 自动发现 `services/identity/migrations/*.sql`（幂等、单文件单事务）。

## 与 P0/P1 的关系

- P0 竖切片不依赖本域；S1（本域）先于 S2/S3/S4（A3 的 gate 双维度）落地。
- P1：审批平台适配（Flowable/Camunda/云 BPM，**不自研引擎**）落 `services/workflow-adapter/`（A4 owns，
  当前未建）；`approvals/` 建单 API 归 A15，审批 id 仍由本域/审批 API 建单事务生成。
