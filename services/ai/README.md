# services/ai · AI 功能层骨架（INF-02）

独立内部服务，不面客。P0 骨架只提供：

- Fastify 实例 + `/healthz`；
- `AiProvider` 接口 + 确定性 `FakeProvider`（CI 默认，无网络/无密钥）；
- `ToolRegistry` 接口（内存实现，空 registry）；
- `runPostprocess` 空管线 + P0–P8 阶段名；
- `runPostprocessHost`：请求内 fail-closed 执行宿主（P0 授权短路、P2–P6 调 A5 `@market-sense/ai-policy`、P8 审计失败即失败）；
- `createAiPolicyEvaluator`：从 compliance 唯一 loader 装配策略，不复制过滤规则；
- `createAiGenerationAuditWriter`：`audit.ai_generation_events` 列级 INSERT（18 列，含 `blocked_draft`；事件键/哈希链由 DB 触发器算）；
- `src/server.ts` 启动入口。

不包含：真实 provider 适配器（INF-03）、业务路由（analyses/chat）、数据库连接/队列（writer 由调用方注入 pg 执行器）。

## 边界

- 对客契约是 `contracts/ai/openapi.yaml`，由 `services/api` 的 AI 域代理暴露；本服务不直接对接 H5。
- 授权由 market gate 在数据侧判定；本服务不跑 gate、不把 `tier` 当授权凭据。
- provider/模型标识只用于内部日志与 `ai.model_family`，不得写进对外契约或响应文案；厂商名禁止出现在契约/生成产物。
- `/v1/ai/*` 的 no-store/限流/鉴权在 `services/api` 外壳；本服务假定上游已认证。
- P8 审计元数据（`request_id`/`user_id`/`content_version`/`as_of`/证据 hash 等）由 API 请求路径注入；缺失时 host 在写库前以 P8 失败拒绝请求。
- 策略版本 pin 的生产门禁归 A5/compliance loader；生产环境未签策略启动即拒，CI 只用 FakeProvider。
- P5/P6 命中 block：host 只返回 D3 降级卡（`blocked:true`），不返回未过滤文本；P8 `blocked_draft` 写完整原模型 draft，`output_hash=computeBlockedDraftHash(blocked_draft)`，passed 时该列为 NULL。

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
