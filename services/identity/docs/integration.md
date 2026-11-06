# identity 接线说明（给 A0 / A3 / A5 / A8 / A13）

本文件只描述**最小接线 patch**，不含实现改动。`services/identity/` 是身份域真源；接线方按下表各自落文件
（本域不写 market/、api/，见 ownership.yaml 与 path-guard）。

ADR-008 对应小节：D2（JWT claims）、D6.3/D6.4（受众由路径决定、统一判定点）、D9（S0–S5 迁移）。

---

## 1. A0 · `services/api` 认证薄壳（D6.4）

外壳只做「解析 Bearer → 注入受信 principal → 全局错误映射」，**不做角色判定**（H2 L125：权限逻辑不得落进 BFF）。

### 1.1 注册域插件

```ts
// services/api/src/domains.ts
import { identityPlugin } from '@market-sense/identity/plugin';

export const domainPlugins = [identityPlugin, marketPlugin];
```

`identityPlugin` 内路由是相对路径，外壳按 `/v1` 前缀挂载后即 `/v1/auth/*`、`/v1/internal/auth/register`。

### 1.2 认证 preHandler（默认拒绝）

```ts
import { Pool } from 'pg';
import { ERROR_TITLES } from './copy.js';
import { HttpProblem } from './errors.js';
import { createIdentityService, createIdentityAuthenticator, loadIdentityConfig, PgIdentityStore } from '@market-sense/identity';

const store = new PgIdentityStore({ pool });
const service = createIdentityService({ store, config: loadIdentityConfig(process.env) });
const authenticate = createIdentityAuthenticator(service);

app.decorateRequest('user', null);
app.addHook('preHandler', async (request) => {
  // 公开路由白名单（健康检查 + 三个注册/登录入口）；其余一律要求有效身份。
  if (isPublicRoute(request.url)) return;
  const principal = await authenticate(request);
  if (principal === null) {
    throw new HttpProblem(401, 'UNAUTHENTICATED', ERROR_TITLES[401]);
  }
  request.user = principal;
});
```

公开白名单：`/healthz`、`/v1/auth/register`、`/v1/auth/login`、`/v1/internal/auth/register`。
`createIdentityAuthenticator` 对无 token / 无效 token 返回 `null`（不抛错），因此「默认拒绝」是外壳的职责。

### 1.3 audience 由路径决定（不读客户端 header）

- 请求路径以 `/v1/internal/` 开头 → `audience = 'internal'`；否则 `audience = 'c_end'`。
- 该值随 principal 一起交给 A3 的 gate（`AudienceGateDecision`），**不从 header/query 读取**。
- 内部响应 `Cache-Control: no-store`，不进 CDN（插件已对自身路由强制，外壳对所有 `/v1/internal/*` 同样处理）。
- 内部路由只允许 `userType === 'internal_active'` 的 principal；`internal_pending` 永远没有 principal。

### 1.4 审批 HTTP 入口（P0 不接）

`services/identity` 的插件**故意不暴露**审批路由：审批人是人类 `H3`/`user`，需要 A8 管理后台的人类认证
（H5+A9 签字前，任何 HTTP 审批入口都可能被 agent 机器身份冒用）。接线时由 A0 在管理后台认证之后提供
单条审批端点（**不做批量**），服务端仍调用：

```ts
await service.approve({
  applicationId,
  approver: { kind: 'human', id: adminSeatId }, // 必须来自人类登录态，不可由请求体自报
  internalTier,                                 // 缺省 internal_eval；research_only 必带 reason
  reason,
});
```

---

## 2. A3 · `services/market/src/auth.ts` Principal 扩展

ADR-008 §附：`auth.ts:16-18` 的 `Principal` 从 `{ userId }` 扩为四字段；A4/A3 边界。

```ts
// services/market/src/auth.ts
export interface Principal {
  readonly userId: string;
  readonly userType: 'c_end' | 'internal_active';
  readonly tier: 'c_end_display' | 'internal_eval' | 'research_only';
  readonly sessionVersion: number;
}

/** 外壳注入的 request.user → Principal；缺字段 fail-closed（不猜档位）。 */
export function principalFromShell(request: { user?: unknown }): Principal | null {
  // 生产：外壳注入完整四字段；E2E 静态 token 兼容：userType 缺省 c_end / tier 缺省 c_end_display / sessionVersion 缺省 0
}
```

- 类型可以 `import type { Principal } from '@market-sense/identity'`，也可以镜像（A3 选择；不要复制其运行时代码）。
- `domain/entitlement-gate.ts` 的 `evaluate` 增加 principal 参数（ADR-008 D3），**不要**在 gate 里重新解析 token。
- gate 判定只用 `principal.userType/tier`；`internal_access` 审计事件 **S3 起**才写（S2 shadow 期写会导致双计）。
- C 端契约与 `/v1/*` 路径不变；内部路由 `/v1/internal/*` 的 audience 由 A0 路由层决定（D6.3）。

---

## 3. A5 · 审计表（不阻塞）

本域 P0 使用独立表 `identity.audit_events`（迁移 `services/identity/migrations/001_identity.sql`），
避免越界改 `audit.entitlement_events` 的 `event_type` CHECK。若 A5 评估后并入统一审计：

- 需要新增事件类型：`internal_approval`、`internal_rejection`、`internal_tier_change`、`internal_registration`、
  `identity_registration`、`identity_login`、`identity_login_denied`、`account_disabled`、`approval_denied`；
- 或保留独立表（推荐：身份审计与 entitlement 审计的生命周期/访问路径不同）；
- **`internal_access` 归 A3 的 gate 写、S3 起**，不在本域事件白名单内（本域不写）。

---

## 4. A8 · 管理后台审批 UI

UI 只展示申请与调用 A0 提供的单条审批端点；**审批人人类身份校验在服务端 identity 层**
（`approve()` 内 `assertHumanApprover`），UI 隐藏按钮不构成安全边界。不提供批量审批。

---

## 5. A13 · 工程/部署

- workspace：`services/identity` 已在 `pnpm-workspace.yaml` 的 `services/*` 内，`pnpm install` 会更新 lockfile。
- 迁移：`infra/scripts/db-migrate.sh` 自动发现 `services/identity/migrations/*.sql`；幂等由
  `infra/ci/check-db-bootstrap.mjs` 校验（已满足：`IF NOT EXISTS`、无 `DROP TABLE`）。
- 部署 env：至少注入 `IDENTITY_JWT_SECRET`（≥32）+ `DATABASE_URL`；内部注册按需注入
  `IDENTITY_INTERNAL_REGISTRATION_ENABLED` / `IDENTITY_INTERNAL_INVITE_SHA256` /
  `IDENTITY_COMPANY_EMAIL_DOMAINS` / `IDENTITY_SOURCE_IP_HASH_SALT`（清单见 README）。
- `IDENTITY_ACCEPT_LEGACY_TOKENS`：S0–S3 保持 `true`；S4 全量换发完成后关闭。

---

## 6. 迁移阶段对照（ADR-008 D9）

| 阶段 | 动作                                                                 | 状态            |
| ---- | -------------------------------------------------------------------- | --------------- |
| S0   | 现状：E2E 静态 token，无 user_type                                     | 已完成          |
| S1   | 本域：user_type/internal_tier/审批表、注册/登录/审批、JWT claims、pending 禁登 | **本次交付**    |
| S2   | A3：shadow gate（只记录不执行），**不写 `internal_access`**            | 待 A3           |
| S3   | A3：enforce 内部受众 + `/v1/internal/*`，开始写 `internal_access`      | 待 A3           |
| S4   | A3/A13：enforce C 端 claims；旧 token 无 user_type 按 c_end，全量换发后关兼容 | 待 A3/A13 |
| S5   | 第 2 批服务接入                                                        | 待排期          |

## 7. 失败语义速查（接线方按此映射）

| 场景                                    | 状态码 | code            | 备注                                  |
| --------------------------------------- | ------ | --------------- | ------------------------------------- |
| 无 token / 验签失败 / 过期 / aud 错     | 401    | UNAUTHENTICATED | 不暴露内部原因                        |
| claim 轴不一致 / 未知档位 / 缺 approval | 403    | FORBIDDEN       | fail-closed，不降级成 c_end           |
| pending 登录                            | 403    | FORBIDDEN       | 通用文案，无 token                    |
| 账号停用                                | 403    | FORBIDDEN       | `account_locked` 只进审计             |
| 重复邮箱 / 弱密码 / 邮箱格式            | 400    | VALIDATION_ERROR| title 统一来自 copy.ts                |
| 并发审批/改档冲突                       | 400    | VALIDATION_ERROR| ProblemCode 无 CONFLICT（A0 契约限制） |
