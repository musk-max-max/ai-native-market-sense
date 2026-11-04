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
│   ├── app.ts            # buildApp()：创建 Fastify、装错误映射、注册域插件与 health
│   ├── config.ts         # loadConfig()：环境变量 → 强类型配置，非法即快速失败
│   ├── errors.ts         # HttpProblem + installErrorHandling()：统一契约 Problem
│   ├── plugin.ts         # DomainPlugin 接口 + registerDomainPlugins()（本文件是域接入契约）
│   ├── domains.ts        # 唯一装配点：domainPlugins 数组（A0 接线）
│   ├── routes/health.ts  # GET /healthz（外壳层，不属于业务契约）
│   └── server.ts         # 进程入口：listen + SIGINT/SIGTERM 优雅关闭
└── test/app.test.ts      # 壳体自测（node:test + app.inject，不监听端口）
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

密钥、数据库连接、tushare token **不在此读取**：P0 外壳不连数据库，数据链路归 A1/A2；认证归 A4/A9。

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

- 不做鉴权/限流/审计（A4/A9/A13/A14；接 `preHandler` 时不改本壳体的错误契约）。
- 不做数据库连接/ORM/迁移（A1/A2；迁移脚本禁止 A0 触碰）。
- 不做业务路由、不写契约（契约在 `contracts/`，由 A0 维护）。
- 不做 CORS/静态资源（H5 由 web 反代同源，见 A7；部署层归 A13）。

## 待定（需 Lead/H2 拍板）

1. `NOT_FOUND` 目前只用于「路由不存在」，尚未写入 `contracts/shared/openapi.yaml` 的 P0 错误码清单；若 A11 要求所有错误码可追溯，由 A0 以 additive 方式补登记。
2. 认证插件的挂载位置（`preHandler` 全局 vs 域插件内）待 A4/A9 方案确定后由 A0 定，原则是「一个判定点」。
3. 请求日志脱敏（H5 审计要求）由 A13 统一日志方案覆盖，本壳体只保证不打印 body/headers 敏感字段。
