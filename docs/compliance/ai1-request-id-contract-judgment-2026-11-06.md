# AI-1 签发判定材料（交 H2 判，H3 签）— 2026-11-06

## 背景与红线
- AI-1（AI 生成元数据 + 留痕）签发门禁 AI-CARD-SIGNOFF-2026-11-06.md:32 要求五字段全非空落审计。L139/L144 已补 HTTP 层与运行时证据（16/16 + 32/32 PASS）。
- L0 为打通跨服务审计链，改了 services/ai/src/routes/analyses.ts：request_id 优先取客户端 request-id 头，回退 Fastify req.id。此改动引入**契约语义新增**，须 H2 判是否符合 contracts/ai，再由 H3 签发。

## 契约事实（L0 核验 contracts/ai/openapi.yaml + internal-generation-context.schema.json）
1. **request-id 请求头未在 OpenAPI 定义**——openapi.yaml /v1/ai/analyses createAiAnalysis 无 headers/parameters 引用 request-id（仅 AnalysisIdPath 74/107 行）。
2. **body 内 request_id 仅存在于 internal 上下文**——internal-generation-context.schema.json:10-14 required=[request_id,...]，明确「只由 services/api 在服务端构造并随内部调用传入；不得从 C 端请求读取」。它写 event_key=ai|generation|<request_id>。
3. **客户端 request-id 头**（新增，L139）与 body request_id 是两套来源，服务端 analyses.ts 现优先用头、回退 Fastify req.id（非 body request_id）。

## 待 H2 判三点
1. **是否纳入 OpenAPI**：客户端 request-id 头应否显式声明为 parameter（header, optional），还是仅作为服务端审计优化不进契约？影响 oasdiff 基线与 G-CONTRACT。
2. **优先级语义**：头值 vs body request_id vs Fastify req.id，三者冲突/缺失时的优先级口径（当前实现：头 > req.id，不读 body request_id）。这决定 audit.event_key 的稳定性口径。
3. **伪造/碰撞风险**：客户端可控头值直接作审计锚点 event_key 的一部分——伪造、碰撞（同 request_id 重放被幂等吞行，见 L144 坑）是否可接受？是否需约束字符集/长度/来源信任边界？

## 前置状态
- L135 #2（仓库级门禁）已绿（L140，typecheck 10/10 + pnpm -r test 全绿）。
- L139/L144 证据补足后，AI-1 元数据+留痕样本已齐。**放行=H3 定**（reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md:15 原因「无运行时真实响应」已消解）。

## 影响面
- H2 判契约性（可判「不纳入契约，仅实现细节」→ 无 OpenAPI 改动；或判「纳入」→ 需契约变更走 ADR-001 D5）。
- H3 签发（可独立于上面结论，只要五字段落审计 + 门禁绿）。
