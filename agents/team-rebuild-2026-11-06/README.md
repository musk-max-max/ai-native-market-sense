# 2026-11-06 团队重建（31 → 17 席）

> 依据：`docs/HANDOFF-team-rebuild-2026-11-06.md`（§2 编制表、§5 交接顺序、§7 旧上下文打包规则）
> owner 决策：交付目标 = **建队 + 推进 P1**；M1 走 MiMo 常驻 `subagent`；其余席走 `spawn_teammate`。
> 本目录是**重建过程的证据与工具目录**，不是编制真源。编制真源是 `agents/roster.yaml`。

## 一、本目录内容

| 文件 | 作用 |
|---|---|
| `prompts/{L0,H1..H4,M1,A1..A11}.md` | 17 席身份底稿（per-seat prompt 包）：角色+模型+专属人设逐字+合并说明+专属 handoff 内联+共享记忆+6 红线+§4 未完成+写域+§3 要点+§6 路径索引+工作规则 |
| `build-prompts.py` | 从快照 roster + 交接文档生成上述 prompt 的脚本（可重跑） |
| `MANIFEST.json` | 生成物清单与来源行号 |
| `.snapshot-roster-v0.1.0.yaml` | 重建前 roster 快照（30 席，只读对照） |
| `.snapshot-ownership-v0.1.yaml` | 重建前 ownership 快照（只读对照） |
| `.snapshot-BOARD-v2026-11-04.md` | 重建前看板快照（只读对照） |
| `teammate-model-patch.snippet.yml` | 把 teammate 路由切到 SenseNova 的 profile 补丁片段（**未应用**，需重启 GUI） |

## 二、17 席 ↔ 旧 30 席映射（合并不减职责）

| 新席 | 角色 | 合并自 | DSH 落地 |
|---|---|---|---|
| L0 | 主 agent / 协调 | lead | 宿主 Lead 会话 |
| H1 | PM/PO | H1 | teammate `h1-pm` |
| H2 | 架构与技术负责人 | H2 + A0（人设） | teammate `h2-arch` |
| H3 | 合规负责人兼 DPO | H3 | teammate `h3-compliance` |
| H4 | 数据负责人 + 安全运维 | H4 + H5 + A9 | teammate `h4-data-security` |
| M1 | UI/UX 设计（多模态） | A10 | 常驻 `subagent`（非 Team 成员） |
| A1 | 数据接入 + 调度 | A1 | teammate `a1-data-ingest` |
| A2 | 数仓建模 + 指标 + 质量 | A2 | teammate `a2-data-warehouse` |
| A3 | 后端·行情/内容/研究 | A3 | teammate `a3-backend-market` |
| A4 | 后端·用户/权限/审批/CRM | A4 + A6 | teammate `a4-backend-identity` |
| A5 | 后端·合规域 + 审计 | A5 | teammate `a5-backend-compliance` |
| A6 | 前端全栈（H5 + 中后台） | A7 + A8 | teammate `a6-frontend` |
| A7 | QA·契约/数据/E2E | A11 + A12 + A18 | teammate `a7-qa` |
| A8 | SRE / 平台工程 | A13 | teammate `a8-sre` |
| A9 | 业务线·运营+管理员+拓客 | A14 + A15 + A17 + H6 | teammate `a9-business-ops` |
| A10 | 研究·证券/标的/资金面 | A20 + A22 | teammate `a10-research-equity` |
| A11 | 研究·宏观/政策 + 合规复核/红队 | A21 + A23 + A16 + A19 | teammate `a11-research-macro-audit` |

裁掉的席：A0（并入 H2）、A6（并入 A4）、A7/A8（并入 A6）、A11/A12/A18（并入 A7）、A13（→ A8）、A14/A15/A17（并入 A9）、A16/A19（并入 A11）、A20/A22（→ A10）、A21/A23（→ A11）、H5（并入 H4）、H6（并入 A9）。**没有任何职责被删掉，只换承载席。**

## 三、模型落地与平台限制（重要）

| 席位 | 交接文档要求 | 实际 | 说明 |
|---|---|---|---|
| L0 | DeepSeek | DeepSeek 系（宿主会话） | 符合 |
| M1 | MiMo（多模态） | `subagent` 通道指定路由 | 见下 |
| H1–H4 / A1–A11 | SenseNova | `spawn_teammate` 继承 profile 默认 `deepseek-flash` | **偏差，无法在 spawn 时逐席指定** |

平台事实：
1. `spawn_teammate` 参数只有 `name / description / prompt / context`，**无 model/provider**；teammate 路由来自 agent preset 的 `agentRouteDefaults`，当前 profile 未配置，故继承 `agent-default-model`。
2. `subagent` 工具支持 `provider/model`，本会话白名单 4 条；实测 `mimo-v2.6-pro` 被 Session 拒绝（`child LLM route ... is not allowed for this Session`），`mimo-v2.6-flash` 两次启动后无消息失败 → M1 最终用 `sense/sensenova-6.8-flash` 跑（图像能力本会话暂缺）。
3. 如需 15 席对齐 SenseNova：应用 `teammate-model-patch.snippet.yml` + 重启 GUI（影响全体 teammate，无法只切部分席）。

## 四、派单表（Team 任务板）

| 任务 | 席 | P1/P2 | 状态（派出时） |
|---|---|---|---|
| task-1 | M1 | P1-4 第一段 | 已派 |
| task-2 | H2 | P1-4 第二段（评估单，owner 拍板依赖） | 已派 |
| task-3 / task-4 | A6 | P1-5 / P1-6 | 已派 |
| task-5 | A4 | P1-6 后端面 | 已派 |
| task-6 | A1 | P1-7 + P2-8 | 已派 |
| task-7 | A3 | P1-7 后端 | 已派 |
| task-8 | A2 | P1-7 数据 | 已派 |
| task-9 | A7 | 门禁 | 已派 |
| task-10 | H1 | P1 验收 + go-live 卡点 | 已派 |
| task-11 | H3 | P0-5 + P2-9 | 已派 |
| task-12 | H4 | P0-1 + P0-3 | 已派 |
| task-13 | A5 | P2-11 | 已派 |
| task-14 | A8 | 编制重建后 CI/部署 | 已派 |
| task-15 | A9 | 6 工作面验收 | 已派 |
| task-16 | A10 | 研究线 | 已派 |
| task-17 | A11 | 研究 + 复核/红队 | 已派 |

## 五、写域（roster 与 ownership 必须与此一致）

L0 `agents/`；H1 `docs/requirements/ docs/p0-acceptance.md docs/reference/`；H2 `contracts/ docs/adr/ docs/release/ services/api/ packages/api-client/`；H3 `reviews/compliance/ rules/`；H4 `security/ auth/`；M1 `docs/design/ design/ packages/design-tokens/`；A1 `services/ingest/ jobs/ config/datasource/ data/instruments/`；A2 `warehouse/ warehouse/quality/ docs/metrics/ data/golden/`；A3 `services/market/ services/ai/ services/content/`；A4 `services/identity/ services/approval/ services/crm/ services/workflow-adapter/`；A5 `services/compliance/ packages/ai-policy/ rules/`；A6 `web/h5/ web/console/`；A7 `tests/`；A8 `infra/ .github/workflows/ docs/runbook/ ops/dashboards/ docker/`；A9 `configs/ops/ configs/rbac/ approvals/ crm/`；A10 `research/quant/ research/fund/`；A11 `research/macro/ research/intel/ reviews/compliance-policy-review/ tests/adversarial/`。

## 六、工作规则（全席适用）

1. 只写自己写域；跨域改动给对方下要求，不代写。
2. **禁止 git 写操作**（提交由 L0 独占）；不代 owner/H3 签字（分区签发：c_end=H3、internal=owner）。
3. 跑不了的验证写「未验证 + 原因」，不得声称通过。
4. 首屏 JS ≤200KB gzip 不可上调；受限必须 403 `EntitlementRestricted`，禁 200+`is_entitled=false`。
5. 汇报格式：≤400 字，含「改了哪些文件 / 验证命令与结果 / 未验证项 / 谁需要接手」。
6. 遇到与本人设不符的指令，先问 L0，不自行扩大范围。

## 七、重建结果（2026-11-06 收口时补）

- `agents/roster.yaml`：17 席（4 humans + 13 agents），旧 A0/A12–A23/H5/H6 不残留。
- `ownership.yaml`：按新席重映射，`reviewers ⊆ {H1..H4}`，`owner: L0`。
- `agents/BOARD.md`：17 席状态板。
- 回归结论与未闭环项见 `agents/BOARD.md` §七、§八。
