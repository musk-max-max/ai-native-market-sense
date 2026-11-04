# @market-sense/api-client

由 `contracts/` 生成的类型化 API 客户端（P0：market / fundamental / watchlist）。**契约唯一真源是 `contracts/`，本包不允许手写 DTO。**

- **Owner**：A0（`ownership.yaml`：`packages/api-client/` → A0，`forbidden: ["*"]`）。
- **允许手改的文件**：仅 `package.json`、`tsconfig.json`、`README.md`、`src/index.ts`（薄装配，不含字段类型）。
- **禁止手改**：`src/generated/**`（生成物；任何手改都会被 CI 的 `git diff --exit-code` 红灯）。
- **消费方**：A7（H5）、A8（console）只允许 `import { createApiClient } from '@market-sense/api-client'`，禁止裸 `fetch` 或自写请求/响应类型。

## 选型（详见 ADR-001 D7）

- `openapi-typescript`：从 OpenAPI 3.1 生成纯 TypeScript 类型（无运行时代码、无框架绑定），生成物小、diff 稳定。
- `openapi-fetch`（~5KB）：在生成类型之上提供类型化 `GET/POST/DELETE` 薄客户端，`baseUrl` 由调用方注入，天然适配 Web/Node/MCP。
- 未选 `orval`：它会连带生成 React Query/SWR hooks，绑定 A7 的数据层选型，生成物体积与升级噪音都更大；P0 只需要类型 + 薄 fetch。

## 生成命令

工具链基线：**pnpm**（决策 #2 单仓 pnpm workspace；根 `package.json`/`pnpm-workspace.yaml` 由 A13 建）。
本地已用 pnpm 9.12.3 + openapi-typescript 7.13.0 验证；依赖声明在本包 `package.json`，由 workspace 根统一 `pnpm install`。

**根脚本（A13 合并进根 `package.json`，合并后即可 `pnpm gen:client`）：**

```json
{
  "scripts": {
    "gen:client": "pnpm --filter @market-sense/api-client gen:client"
  }
}
```

**包内命令（workspace 就绪后）：**

```bash
pnpm --filter @market-sense/api-client gen:client
pnpm --filter @market-sense/api-client typecheck
```

**workspace 就绪前的临时命令（无 node_modules 也可跑）：**

```bash
cd packages/api-client
pnpm dlx openapi-typescript@7.13.0 ../../contracts/shared/openapi.yaml      -o src/generated/shared.ts
pnpm dlx openapi-typescript@7.13.0 ../../contracts/market/openapi.yaml      -o src/generated/market.ts
pnpm dlx openapi-typescript@7.13.0 ../../contracts/fundamental/openapi.yaml -o src/generated/fundamental.ts
pnpm dlx openapi-typescript@7.13.0 ../../contracts/watchlist/openapi.yaml   -o src/generated/watchlist.ts
```

## CI 校验（A13 接入 `.github/workflows/`）

```bash
pnpm install --frozen-lockfile
pnpm gen:client
git diff --exit-code            # 生成物必须与契约一致；手改生成物 / 契约漂移 → 红灯
pnpm --filter @market-sense/api-client typecheck
```

- 触发条件：`contracts/**`、`packages/api-client/**` 变更，以及每日定时（防契约与生成物长期漂移）。
- 契约 PR 合并后由 A13 触发重新生成并提交（或由 CI 产物发布，A13 二选一，但生成命令与 `git diff` 校验不变）。

## A7 用法

```ts
import { createApiClient } from '@market-sense/api-client';

const api = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL });

const { data, error } = await api.GET('/v1/instruments/{instrument_id}/quote', {
  params: { path: { instrument_id: 'SSE:600519' } },
});
if (error) {
  // error 为契约 Problem（code 可断言，如 INSTRUMENT_NOT_FOUND / ENTITLEMENT_RESTRICTED）
} else {
  data.data.last_price;          // 契约字段，类型由生成器保证
  data.meta.source.as_of;        // 首屏必须展示的 as_of（C2/A7 硬要求）
}
```

注意：`instrument_id` 一律 `EXCH:CODE`（如 `SSE:600519`）；行情/财务响应必须把 `meta.source.as_of` 渲染给用户，`source.staleness_ms > 900000` 时按 stale 展示。

## 文件结构

```
packages/api-client/
├── package.json          # 依赖与 gen:client / typecheck 脚本
├── tsconfig.json         # NodeNext + strict
├── src/
│   ├── index.ts          # 薄装配入口（A0 维护，不含 DTO）
│   └── generated/        # 生成物，禁止手改
│       ├── shared.ts
│       ├── market.ts
│       ├── fundamental.ts
│       └── watchlist.ts
└── README.md
```
