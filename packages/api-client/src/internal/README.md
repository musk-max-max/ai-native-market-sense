# 内部域生成客户端（禁止面客代码引用）

本目录只包含 **internal-only** 契约的生成类型：

- `contracts/config/openapi.yaml` → `config.ts`
- `contracts/approval/openapi.yaml` → `approval.ts`

## 边界（ADR-001 D4/D7，H2 2026-11-06 会签）

- 内部域的判定是规则式的：域在 A11 `INTERNAL_DOMAINS` 注册 **且** 该域全部 operation 路径以 `/v1/internal/` 开头，二者同时成立才免 `{data,meta}` 包络。
- 生成类型必须从独立入口引用，例如：
  - `import type { paths as ConfigPaths } from '@market-sense/api-client/internal/config'`
  - `import type { paths as ApprovalPaths } from '@market-sense/api-client/internal/approval'`
- **`web/h5` 与任何 agent 面代码不得 import 本目录**；A13 在构建期/CI 断言此边界。
- 本目录内容全部由 `pnpm gen:client` 生成，禁止手改。
