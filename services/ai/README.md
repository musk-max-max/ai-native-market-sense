# services/ai · AI 功能层骨架（INF-02）

独立内部服务，不面客。P0 骨架只提供：

- Fastify 实例 + `/healthz`；
- `AiProvider` 接口 + 确定性 `FakeProvider`（CI 默认，无网络/无密钥）；
- `ToolRegistry` 接口（内存实现，空 registry）；
- `runPostprocess` 空管线 + P0–P8 阶段名；
- `src/server.ts` 启动入口。

不包含：真实 provider 适配器（INF-03）、业务路由（analyses/chat）、postprocess 合规逻辑（INF-04）、数据库/队列。

## 边界

- 对客契约是 `contracts/ai/openapi.yaml`，由 `services/api` 的 AI 域代理暴露；本服务不直接对接 H5。
- 授权由 market gate 在数据侧判定；本服务不跑 gate、不把 `tier` 当授权凭据。
- provider/模型标识只用于内部日志与 `ai.model_family`，不得写进对外契约或响应文案；厂商名禁止出现在契约/生成产物。
- `/v1/ai/*` 的 no-store/限流/鉴权在 `services/api` 外壳；本服务假定上游已认证。

## 命令

```bash
pnpm --filter @market-sense/ai typecheck
pnpm --filter @market-sense/ai test
pnpm --filter @market-sense/ai start   # 默认 0.0.0.0:8081
```

环境变量：`AI_HOST`、`AI_PORT`、`AI_LOG_LEVEL`、`AI_SERVICE_VERSION`（均已默认，非法值启动失败）。

## 归属

- owner：A3（H2 裁定不扩编 A24；A0 仅在 INF-01/INF-02 验收期持有临时写权）。
- reviewers：H2、H3。
- 后续 `services/ai` 的写域由 A3 接管；A0 不再直接改本目录。
