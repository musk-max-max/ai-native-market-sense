# A16 compliance-reviewer 席位 handoff（重建快照 2026-11-06）

> 权威真源：`agents/roster.yaml`（行 557–584）+ `agents/decisions.md`。本文件只加速入场，冲突以真源为准。

## 你是谁

- id `A16`，codename `compliance-reviewer`，角色「合规复核」，**常驻**，phase **P2**
- 写域：**只有** `reviews/compliance/`；forbidden：代替 H3 做终审签字、删除或修改留痕
- 依赖 A5（合规域）；交接 H3
- model：**sensenova-6.8-flash**

## 当前域状态（你已有一批入库产出，不要重建）

`reviews/compliance/KD-AIPOLICY-OFFLINE/` 已入库（commit `6ddeedc`），含：
- `fixtures.json`（36 条样本：正 7/负 12/边 17 含 BND）
- `run-samples.ts`（只调 `@market-sense/ai-policy`，不另写判定脚本）
- `review-package-H3-1.1.1-r2.md`（sha `beacdf5d…` 冻结）
- `evidence-register.md`（append-only，E-0001/E-0002，sha `90ee05a3…`）
- `mapping-draft-R1-R19.md`（叙事版，机读以 redline-basis.json 为准）

**这些是你的历史成果，不是让你重做，是让你接续**。

## 你最重要的裁定：无终审权 + 不得自写自证

1. **你没有终审权**。你的输出是「H3 可签署的复核包」，不是「已批准」。终审签字是 H3（C 端）或 owner/用户（内部）。
2. **A16 不得自写自证**（已落地的治理规则）：每次 append 后由 H5 或 H3 抽核，你不得自行证明自己复核过。
3. **A16 不可写 `audit.ai_generation_events`**（只有 `audit_reader` SELECT+verify，roster 禁写留痕）。负向样本（如 23514 CHECK 拒绝）须由 A5/A13 写角色 harness 执行，你只复核证据。

## 已签认的复核结论（你入场的基础）

- **H3 对 policy 1.1.1 结论 = 「附条件通过（仅规则层）」+ 5 条件**（decisions.md）：
  - ① decisions.md:141 R 编号更正（H1）
  - ② ADR-007 P5/P6 文本修订后 A5 下一版同批更新 definition_refs（已完成，1cb103a）
  - ③ C 端展示仍卡 AI-1/2/3（整体 go-live H3 不签）
  - ④ audit.ai_generation_events 留痕抽查待 003 落地由我（Lead）指派 A16，**口径先报 H3**
  - ⑤ fixtures 字段改名留下一版
- **红线映射**：`rules/redline-basis.json` 定义 H3-C01..C12 → category，三档依据（CSRC_40_DEF/L3_FIVE_NO/ADR007_P5_P6），C12 未公开信息标 PENDING_LEGAL。R 编号体系已作废（R1/R3/R4 被 H5 红队占用）。

## 待办（pending 任务，等 H3 签 1.1.2 后启动）

- **V2 任务单两项新范围**（未开工、保持只读）：
  - ① `redline-basis.json` 一致性断言（红线↔policy 双向集合/版本/双 sha）
  - ② `blocked_draft` 哈希 + 23514 负向样本（DB 负向由 A5/A13 写角色执行，你只复核证据）
- **r3 复核包 + 登记簿 E-0003**：等 H3 签 1.1.2 后出（policy basis 改指 redline 后，你要验证 36 样本逐字节一致）
- **audit.ai_generation_events 留痕抽查**：003 已落地（sha `86aaef0d…`，24 列含 blocked_draft），等你正式指派，**抽查口径先报 H3**

## F1–F9 边界裁定（已发生，你该知道）

- **F4**：P4 把 ISO 日期拆数字 token 致 `timestamps` 白名单不可用（A16 发现的真 bug，已修）
- **F7**：ADR-008 D8 保持 OWNER-DECISION-PENDING 时，policy 引「q3=A」依据不成立（A5 已删，等升 1.1.2）
- **F8**：decisions.md:141「禁止 7 条」却列 10 个编号（内部矛盾，已用 H3-C01..C12 替代）

## 首会话动作

读 `agents/roster.yaml` A16 段确认 system_prompt，然后读 `reviews/compliance/KD-AIPOLICY-OFFLINE/evidence-register.md`（你的历史登记簿）+ `rules/redline-basis.json`。回执我一句话确认就位 + 确认你是否理解「你有 3 项 pending 任务（V2 两项+r3）都在等 H3 签 1.1.2，当前保持只读不擅自开工」。