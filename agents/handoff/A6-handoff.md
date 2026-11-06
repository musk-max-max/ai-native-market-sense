# A6 backend-crm 席位 handoff（重建快照 2026-11-06）

> 权威真源：`agents/roster.yaml`（行 275–302）+ `agents/decisions.md`。本文件只加速入场，冲突以真源为准。

## 你是谁

- id `A6`，codename `backend-crm`，角色「后端 - CRM 域」，任务型，phase **P3**
- 写域：**只有** `services/crm/`；forbidden：绕过话术白名单、绕过触达频次限制、`contracts/`
- 依赖 A0（契约）、A4（认证）、A5（合规）；交接 A17（拓客）、A11（测试）
- model：**sensenova-6.8-flash**

## 当前域状态

`services/crm/` 只有 `.gitkeep`，**零代码，从零开始**。ownership.yaml 已登记 `services/crm/ → A6`。

## 项目硬背景（必须知道）

1. **合规红线是最高优先级**。证监会〔2012〕40 号文：对具体证券提供投资建议=证券投资咨询业务，无牌照不得从事。CRM 触达话术里任何「建议买入/卖出/目标价/收益承诺」都踩红线。
2. **tushare 个人许可**「不可转让、非商业、仅个人查看」⇒ C 端商用违约。当前 C 端仍 `internal_eval` 恒 403。CRM 涉及客户触达时不得引用非授权行情/研报内容。
3. **项目已落地的合规基线**：`rules/ai-content-policy.json`（12 类禁用）+ `rules/redline-basis.json`（H3-C01..C12 红线）+ `packages/ai-policy/`（P2-P6 纯过滤引擎）。CRM 话术可复用这套引擎的判定，不要另写一套。
4. **两类用户**（ADR-008，已签）：`user_type ∈ {c_end, internal_pending, internal_active}`。拓客销售的客户 = c_end。内部员工走 `/v1/internal/*`。
5. **agent 不批 agent**：A15 没有终审权。CRM 触发的人工动作（导出客户数据、新增触达渠道）走真实审批链，审批人是人类。

## 你入场后的首批任务（我来派单时会给细节）

- CRM 域契约（线索/客户/跟进/会话/触达限频）—— **先出契约设计稿给 A0 评审**，契约不在你写域
- IM 通道接入（和 A17 拓客 agent 做 IM 沟通）—— 对应原始需求「拓客人员 agent=1，和 c 端模拟客户能进行 im 沟通」
- 会话全量留痕（append-only，业务侧不可删，参考 identity.audit_events 的 append-only 模式）
- 触达限频 + 话术白名单（硬失败，非警告）

## 已发生的相关裁定（节选自 decisions.md）

- **C1**：A15 = 审批调度员 + 低风险自动放行，**终审归人类**。CRM 导出客户数据这类走审批，不能机器过。
- **L51**：审批 id = `apr_<uuidv7>`，由 A4 审批 API 建单事务内生成。你引用 approval_ref 时只读不造。
- **L70**：`docs/reference/` 不在任何 agent 写域。你若需要词表类标准，用 `docs/reference/entitlement-reasons.json` 只读。
- **L77/L73/L76**：生产环境缺 ENTITLEMENT_AUDIT/HOLD_CHECK/Pool 超时 → 拒启动。你新增任何 DB 连接都要带超时。
- **L83**：`services/*/test/**`（单数）进测试宿主排除项，测试夹具可含厂商标识。

## 首会话动作

读 `agents/roster.yaml` 的 A6 段落确认 system_prompt，然后读 `docs/adr/` 下相关 ADR（尤其 ADR-001/002 契约、ADR-007 AI 层、ADR-008 用户分层），回执我一句话确认你已就位并说明你打算先动哪块。**契约不在你写域，先设计后评审，不要直接写 openapi.yaml。**