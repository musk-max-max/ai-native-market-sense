# services/api —— API 应用外壳（A0 owns）

> **边界**：这里只有「应用外壳」：Fastify 实例工厂、配置加载、域插件注册表、全局 Problem 错误映射、进程入口与 `/healthz`。
> **没有业务路由、不查数据库、不 import 任何域内部实现。** 业务域由 A3 等域 owner 在各自目录实现，以 Fastify plugin 形式接入。
> 归属：`ownership.yaml` → `services/api/` owner `A0`；域插件仍归各域 owner（如 `services/market/` → A3）。

## 目录

```text
services/api/
├── package.json          # @market-sense/api，deps 仅 fastify
├── tsconfig.json         # NodeNext + strict
├── src/
│   ├── app.ts            # buildApp()：创建 Fastify、装错误映射/认证、注册域插件与 health
│   ├── auth.ts           # 默认拒绝 preHandler：公开白名单 + 路径定 audience + Principal 注入
│   ├── config.ts         # loadConfig()：环境变量 → 强类型配置，非法即快速失败
│   ├── errors.ts         # HttpProblem + installErrorHandling()：统一契约 Problem
│   ├── plugin.ts         # DomainPlugin 接口 + registerDomainPlugins()（本文件是域接入契约）
│   ├── domains.ts        # 唯一装配点：domainPlugins 数组（A0 接线）
│   ├── routes/health.ts  # GET /healthz（外壳层，不属于业务契约）
│   └── server.ts         # 进程入口：loadConfig/identity → buildApp → listen + 优雅关闭
└── test/*.test.ts        # 壳体自测（node:test + app.inject，不监听端口）
```

## 域插件接入契约（A3 必读）

域 owner 在自己的域包导出一个 **Fastify plugin + 两个只读元数据字段**：

```ts
// services/market/src/plugin.ts（示例，A3 实现）
import type { DomainPlugin } from '../../api/src/plugin.js';

export const marketPlugin: DomainPlugin = Object.assign(
  async (app) => {
    // 路由写相对路径，外壳统一挂 /v1
    app.get('/instruments/:instrument_id', async (req, reply) => { /* ... */ });
  },
  { domain: 'market', contractVersion: '0.2.0' } as const,
);
```

约定：

1. `domain` 必须与 `contracts/<domain>/`、`ownership.yaml` 一致，且全局唯一；重复注册**启动即失败**。
2. `contractVersion` 用于启动日志与 `/healthz` 排障；可选但建议填。
3. 路由写**相对路径**（如 `/instruments/:id`），外壳统一加 `/v1` 前缀；不要重复写 `/v1`。
4. 插件**不得**自己 `listen`、不得注册全局 `setErrorHandler`/`setNotFoundHandler`（外壳已统一）、不得 `reply.send(problem)` 手写错误体；业务错误统一 `throw new HttpProblem(status, code, title, detail?)`。
5. 插件之间不互相依赖；跨域数据只能经契约/内部服务，不得 import 对方实现。

A3 交付后，由 A0 在 `src/domains.ts` 的 `domainPlugins` 数组接线（该文件 A0 owns，其他 agent 不改）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 1–65535；非法值启动失败 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LOG_LEVEL` | `info` | fatal/error/warn/info/debug/trace/silent |
| `NODE_ENV` | `development` | 环境标识（日志/排障） |
| `npm_package_version` | `0.1.0` | 由包管理器注入，作为 `/healthz` 的 version |
| `TRUST_PROXY` | `false` | 只接受**单个** ingress 窄网段（IPv4 `/24`–`/32`；IPv6 `/64`–`/128`），或 `false`/留空。`true`、`0.0.0.0/0`、`::/0`、回环、链路本地、`10.0.0.0/8` 及更宽私有段、逗号列表一律在 `loadConfig()` 抛 `ConfigError`，进程在 `buildApp()`/`listen()` 前退出（错误信息点名 `TRUST_PROXY`）。

密钥与认证配置归 A4 identity：`server.ts` 启动时用 `loadIdentityConfig(process.env)` 校验 `IDENTITY_JWT_SECRET`，用 `PgIdentityStore` 建连接池（`DATABASE_URL`），失败在 listen 前退出。`buildApp()` 本身只接收可选的 `authenticator`，不读环境变量。tushare token 归 A1，数据链路归 A1/A2。

## 认证接线（A4 identity，ADR-008）

`buildApp({ authenticator })` 在限流后安装全局 `preHandler`（`src/auth.ts`）：

- 公开白名单：`/healthz`、`/v1/auth/register`、`/v1/auth/login`、`/v1/internal/auth/register`。
- 其余路径默认拒绝：无有效 Bearer → `401 UNAUTHENTICATED`（problem+json）。
- 通过后写 `request.user`（`Principal`）与 `request.audience`。
- audience 只由路径决定：`/v1/internal/` → `internal`，其余 → `c_end`；**不读客户端 header**。
- 未注入 authenticator 时 `async () => null`，即默认拒绝，不匿名放行；测试通过 `allowAll` 注入。
- 外壳**只注入身份**，不解析 tier 当授权凭据；数据授权仍由各域 gate 判定。

`server.ts` 的 `bootstrapIdentityOrExit()` 创建 `PgIdentityStore` + `createIdentityService` + `createIdentityAuthenticator`；配置非法或连接失败时 `[identity] 拒绝启动：...` 并在 listen 前退出。

## 错误映射（契约 `contracts/shared/openapi.yaml#/components/schemas/Problem`）

| 来源 | HTTP | code |
| --- | --- | --- |
| `HttpProblem(status, code, ...)` | 原样 | 原样（域插件用） |
| Fastify schema 校验失败 | 400 | `VALIDATION_ERROR` |
| 带 4xx `statusCode` 的 Fastify 错误 | 4xx | 401 `UNAUTHENTICATED` / 403 `FORBIDDEN` / 404 `NOT_FOUND` / 429 `RATE_LIMITED` / 其它 400 `VALIDATION_ERROR` |
| 未捕获异常 | 500 | `INTERNAL_ERROR`（detail 不回传，堆栈只进日志） |
| 路由不存在 | 404 | `NOT_FOUND`（外壳层扩展，见「待定」） |

响应头固定 `content-type: application/problem+json`；所有错误体含 `trace_id`（= Fastify request id）。

## 健康检查

`GET /healthz`（**不挂 /v1**，不属于业务契约，运维探针用）：

```json
{ "status": "ok", "service": "market-sense-api", "version": "0.1.0", "uptime_s": 12, "domains": [] }
```

只证明进程存活；**不探测数据库/数据源**——P0 seed 未跑时不应误判 API 不健康。readiness 探针归 A13 部署配置。

## 本地运行 / 测试

根 `pnpm-workspace.yaml` 归 A13；workspace 建好前不要在本目录留 `node_modules`/lockfile（依赖声明留在 `package.json`，由根统一安装）。

```bash
# 根 workspace 就绪后
pnpm --filter @market-sense/api dev        # tsx watch src/server.ts
pnpm --filter @market-sense/api typecheck
pnpm --filter @market-sense/api test       # node --import tsx --test
pnpm --filter @market-sense/api start      # node --import tsx src/server.ts（P0 直接跑 TS；生产打包归 A13）
```

## 非目标（P0）

- 不实现认证/授权逻辑（A4 identity、A9）；本壳体只做 preHandler 接线与 401 映射。
- 不做数据库连接/ORM/迁移（A1/A2；迁移脚本禁止 A0 触碰）。
- 不做业务路由、不写契约（契约在 `contracts/`，由 A0 维护）。
- 不做 CORS/静态资源（H5 由 web 反代同源，见 A7；部署层归 A13）。

## 待定（需 Lead/H2 拍板）

1. 请求日志脱敏（H5 审计要求）由 A13 统一日志方案覆盖，本壳体只保证不打印 body/headers 敏感字段。
2. `/v1/internal/*` 的内部 AI 路由由 A3 在 `services/ai` 落地后决定是否挂到本外壳（P0 不对外暴露）。
