# A8 frontend-console 席位 handoff（重建快照 2026-11-06）

> 权威真源：`agents/roster.yaml`（行 331–359）+ `agents/decisions.md`。本文件只加速入场，冲突以真源为准。

## 你是谁

- id `A8`，codename `frontend-console`，角色「前端 - 中后台（运营/合规/管理/CRM 四合一）」，任务型，phase **P2**
- 写域：**只有** `web/console/`；forbidden：`web/h5/`、`contracts/`、跳过 diff 确认直接提交
- 依赖 A0（契约）、A4（认证）、A10（设计）；交接 A12、A14、A15、A16
- model：**sensenova-6.8-flash**

## 当前域状态

`web/console/` 只有 `.gitkeep`，**零代码，从零开始**。这是本项目当前最大的缺口——管理后台（运营中台+合规中台+管理后台+CRM 前端）全靠你。

## 项目硬背景

1. **技术栈**：项目用 pnpm monorepo，现有两个前端：`web/h5/`（C 端，A7 owns，React + Vite，已有 6 页）、`web/console/`（中后台，你 owns，空白）。后端在 `services/`（market/content/watchlist/identity/ai/compliance），契约在 `contracts/`（OpenAPI 3.1，redocly lint + oasdiff 破坏性门禁）。数据库 PG16，API@8081，Web@3000。
2. **两类用户**（ADR-008 已签）：内部员工走 `/v1/internal/*`，认证走 `services/identity/`（A4 已完成 JWT HS256、session_version、pending 登录 403）。你的中后台所有页面都要接这套认证。
3. **AI 内容管控**：`rules/ai-content-policy.json`（12 类禁用）+ `packages/ai-policy/`（P2-P6 过滤引擎）。中后台如展示 AI 生成内容，必须带「AI 生成·仅供参考」标识（已定稿文案）。
4. **审批流**（C1 裁定）：A15 = 审批调度员 + 低风险自动放行，终审归人类。你的审批界面要支持：规则引擎绿→机器过、黄/红→路由给人。审批入口 `/v1/internal/approvals/*` P0 不暴露（A4 故意锁的，你上线时开）。
5. **agent vs 人类操作**：中后台所有操作必须可区分来源（谁改的、哪次模型运行）。identity.AuditSink 的 `actor{kind,id,modelVersion}` 是唯一真源。

## 四个中台要做的页面

| 中台 | 用户 | 核心功能 |
|------|------|---------|
| 运营中台 | A14 | 栏目/内容/策略配置，看板，草稿→校验→审批→发布状态机 |
| 合规中台 | A16/H3 | 复核包查看、留痕抽查、红线清单维护（只读，H3 签字在服务端） |
| 管理后台 | A15 | 审批流、权限管理、审计日志 |
| CRM 前端 | A17/A6 | 客户列表、跟进记录、IM 会话、触达日志 |

## 已发生的相关裁定

- **H2 对 A8 的三点补充**（decisions.md:1464）：①审批人「人类身份」校验在服务端 identity 层不在 A8 UI；②单条审批是 API 约束（UI 不做批量按钮不够，换客户端就能批量）；③`internal_active` 缺 `approval_ref` 加用户表 CHECK。默认 `internal_eval` 是最原始数据档非「最低权限」，审批人不能当安全默认值点通过。
- **L83**：`services/*/test/**` 单数进测试排除项。
- **L72**：`internal_active` 缺 approval_ref 不只是 gate 拒绝，DB CHECK 也拒（L72 负样本口径）。
- **ADR-007**：AI 网关独立 `services/ai/`，`/v1/ai/*` additive，kind 封闭 8 值枚举。中后台如接 AI 能力走这个契约。

## 首会话动作

读 `agents/roster.yaml` A8 段确认 system_prompt，然后读 `docs/adr/ADR-008-user-tiers-and-entitlement.md` + `docs/adr/ADR-007-ai-functional-layer.md`。回执我一句话确认就位 + 你打算先建脚手架/设计系统/还是先做一个中台的 CRUD 原型。