# KD-APPROVAL-001 · 审批规则引擎：分类与机器判定阈值（设计稿 v0.1.2）

> **状态：设计稿，未生效。** 本文是「已有裁定的映射表 + 判定模型 + 缺口清单」，不是新立法，也不是可加载的规则配置。
> 本文**不被任何规则引擎加载**：无 `policy_version`、无 JSON schema、不在 `rules/` 下，不构成放行依据。规则引擎实现前，任何审批单一律按人审处理。
>
> - Owner：A15 admin-approver｜写域：`configs/rbac/`
> - 日期：2026-11-06｜前置裁定：C1 = A（`agents/decisions.md:28,83-96`）
> - 权威真源优先级：`agents/decisions.md` / ADR > `rules/` 已签文件 > runbook > 本文。冲突时本文作废并升级，不得反向改判真源。
> - 术语：**绿** = 规则引擎自动放行（A15 不参与决策）；**黄** = 路由给人类审批人；**红** = 拒绝/阻断并升级。
> - 标签：[已签] = 有已拍板来源，可实现；[缺口] = 无来源或来源不足，**不得实现，必须升级**；[提案] = A15 候选建议，未经裁定不得生效。

---

## 0. 结论摘要（TL;DR）

1. **当前「可绿」集合 = ∅（空集）。** H6 七类审批流只有名称级裁定（`decisions.md:147`），没有每类的判定阈值；16 项配置边界只有「5 级分类 C0–C4 + 6 类不可配」的摘要（`:146`），没有级别表；「七道闸防误配」只有名字（`:181`）。缺判据的类一律不猜、不可绿。
2. **P0 运行态只能全黄**：规则引擎未实现；通用审批契约已落（`contracts/approval/openapi.yaml` 0.1.0，commit b73c293，6 operations），但 **A4 建单/账本实现未落**（identity 的 `approve` 只覆盖内部员工申请，`services/identity/src/plugin.ts` 未暴露审批路由）。因此**在引擎落地前所有审批单都路由给人类**，A15 只做预审/填单/路由/催办。
3. **两类永不绿（硬门，先于任何规则判定）**：T5 权限类（含 agent 身份/角色/数据授权）与 ADR-008 内部员工转正 + internal tier 改档。前者依据 README 硬约束（`agents/README.md:65,67`）与 H5-1（`decisions.md:90`），后者依据 ADR-008 D1/D2 与用户裁定（`decisions.md:1269-1320`）。即使未来规则引擎判定「绿」，这两个硬门也必须把结果覆盖为黄/红。
4. **T6 三处冲突已由 H5 于 2026-11-06 裁定**（C-01=b 预授权单 / C-02=i 先写 deploy 事件 + break-glass N=15 / C-13=否），细则见 §2.6 与 `H5-T6-conflict-brief.md` §7；但 **A4 审批建单能力未落地 → 无 `approval_ref` → T6 绿档仍不可用**（C-09）。
5. **本次交付边界**：只写本设计文档；不建 `approvals/` 账本、不实现规则引擎、不写代码、不产生任何生效规则。每类审批的「绿」在对应来源补齐并经审阅前一律标记 **不可用**。

---

## 1. 判定模型

### 1.1 三档定义

| 档 | 名字 | 谁做决定 | 产出 | 允许的动作 |
|---|---|---|---|---|
| 绿 | `green_auto_pass` | 规则引擎（确定性函数） | 自动放行决定 + 审计事件 | 仅当**整条**规则已签、可复算、输入完整；执行仍走 A4 审批 API，不绕过 |
| 黄 | `yellow_route` | 人类审批人 | 路由单 + 待办 | 只路由/催办，不提前执行；人类批准后落 `approved_by` 人类身份 |
| 红 | `red_block` | 阻断 | 拒绝 + 升级 | 不执行；写审计；上报 A9/H5；涉及越权/批量/异常时段立即升级 |

补充：
- **绿不是 A15 的批准。** 绿 = 规则引擎按已签判据自动放行；A15 只负责把引擎输出填单、路由、留痕。A15 在任何 `decided_by` / `approved_by` 字段中**不得出现**。
- **黄不是 A15 的「建议批准」。** A15 只能补全要素、指出缺哪条判据、按路由表送人；不得对结论表态。
- **红是默认方向。** 任何字段缺失、判据未签、策略版本不一致、输入无法复算 → 不得降级为黄「让人看一眼」，按红处理（`red_block` + 升级）。理由：H5 安全基线「默认拒绝」（`:144`）。

### 1.2 判定输入（审批单最小字段）

A4 的审批 API 尚未提供通用建单：本表是**对 A4 建单契约的输入要求**，不是已存在接口。字段来源：L51 审批 id 契约（`:640-650`）、ADR-008 D2、`services/identity/src/domain/approval-ref.ts` 的形态校验。

| 字段 | 必需 | 说明 | 来源/状态 |
|---|---|---|---|
| `application_id` | 是 | 建单事务生成，全局唯一 | [已签] L51 |
| `approval_ref` | 是 | `apr_<uuidv7>`，可带 `prod:` / `staging:` 前缀；**只在 A4 建单事务内生成**，申请人和 A15 都不得预填/代填 | [已签] L51；实现见 `approval-ref.ts` |
| `flow` | 是 | 枚举 `T1..T7` | [已签] `:147`（仅名称级） |
| `applicant` | 是 | `{kind: human\|agent, id}`；agent 必须带 `model_version` | [已签] H5 基线「模型版本绑定」`:144` |
| `beneficiary` | 是 | 变更受益方（权限类必填；用于自批/利益关联检查） | [提案] |
| `executor` | 是 | 实际执行者（如 A13 部署、A14 配置发布） | [提案]；L20 要求部署事件分「执行者/审批者」两字段 `:236` |
| `subject` | 是 | `{env, domain, object_id, path/diff_hash}` | [提案] |
| `change` | 是 | `{keys[], before, after, diff_hash}`；禁止空 diff | [提案]；配置一致性要求 version/If-Match（`decisions.md §4 #6`） |
| `evidence` | 按类 | 窗口、kill switch、回滚步骤、触达计数、policy sha 等（见 T1–T7） | [按类] |
| `at` | 是 | ISO 时间戳（Asia/Shanghai） | [提案] |
| `idempotency_key` | 是 | 防重复建单 | [提案] |

### 1.3 判定输出（供第二步 `approvals/` 账本投影）

| 字段 | 说明 |
|---|---|
| `decision` | `green_auto_pass` / `yellow_route` / `red_block` |
| `rule_id` + `rule_version` | 命中的规则条目与版本；**必须**能回指 `source_refs` |
| `source_refs[]` | 每条判据的来源（decisions 行号 / L 编号 / ADR 章节 / rules 文件 + sha） |
| `policy_snapshot` | 判定时加载的策略版本 + sha；不一致即红 |
| `input_hash` | 规范化 JSON 的 sha256；必须可复算 |
| `reason_codes[]` | 机器可读的原因码（例：`MISSING_EVIDENCE_KILL_SWITCH`） |
| `route_to` | 人类席位（黄档必填；红档填升级对象） |
| `required_reviews[]` | 如 `H5_REVIEW`、`H3_C_END_REDLINE`、`OWNER_SIGNOFF` |
| `approval_ref` | 原样透传；**不得**由引擎重新生成 |
| `decided_by` | 绿=`rule_engine:<rule_id>`；黄=人类席位；A15 永不出现在此 |

### 1.4 判定总则（先于分类规则，任何分类不得违反）

| # | 总则 | 来源 |
|---|---|---|
| R0 | **默认拒绝**：无已签规则命中 → 黄（路由），不得绿；字段缺失/不可复算 → 红 | H5 基线「默认拒绝」`:144` |
| R1 | **每条判据必须可回指来源**；无来源的判据不得生效（标 `[缺口]` 升级） | 本任务验收口径 + A15 system_prompt「判据必须来自规则引擎」 |
| R2 | **单条审批**：一单只审一个对象；批量/一键通过 → 红 | H5-1 `:90`、H2 分签 `:1464`、用户裁定（`decisions.md:131`） |
| R3 | **禁止自批**：`applicant == approver` 或申请受益人是 A15 自身/其代理 → 红 | roster forbidden、A15 system_prompt、H5-1 |
| R4 | **权限类硬门**：T5 及任何 agent 身份/权限扩缩，规则引擎不得给出绿 | `agents/README.md:65,67`、H5-1 |
| R5 | **内部员工转正/tier 改档硬门**：只能人类 `approved_by ∈ {H3,user}`，无自动/agent 审批 | ADR-008 D1/D2、`:1269-1320` 系列用户裁定（L111/L112） |
| R6 | **agent 不批 agent**：绿的决定者只能是确定性规则引擎（脚本/门禁），不能是 LLM agent；A15 不充当审批主体 | `agents/README.md:67`、C1-A `:83-96` |
| R7 | **`approval_ref` 唯一来源**：A4 建单事务；缺失即红（tier 变更还须 DB CHECK 拒绝） | L51 `:640-650`、L72 `:959` |
| R8 | **策略 fail-closed**：policy/规则加载失败、版本不一致、为空 → 红，不得降级 | `rules/README.md`、H3-C 红线规则 |
| R9 | **不可复用**：撤回/驳回后不得复用 id 与决定；重提须新建单 | L51 |
| R10 | **异常即上报**：批量授权、越权尝试、异常时段 → 同时上报 A9 与 H5，写审计 | A15 system_prompt、roster must_escalate |
| R11 | **利益关联回避**：申请人与审批人存在利益关联（同一人/同一 agent 主体/同一批次）→ 换人，不换判据 | A15 system_prompt |

---

## 2. 七类审批流 T1–T7

> 每类固定六段：机器可判定条件 / 风险等级 / 绿·黄·红三档 / 路由目标 / 必须升级情形 / 来源。
> **所有类的「绿」在本文 v0.1 均为不可用**，原因写在各类的「绿」段；例外候选也明确标 [提案] 且不得启用。

### 2.1 T1 常规（配置/运营常规变更）

**机器可判定条件**
- [已签] `flow = T1`；`subject` 属于运营配置域（目标路径 `configs/ops/`）。
- [已签] 变更键**不属于** 6 类不可配项：免责 / AI 标识 / as_of / 退订 / 风险提示 / 话术白名单（`:146`）。命中任一项 → 直接红（「不可配，界面不渲染入口」）。
- [已签] 配置发布须满足 version + If-Match 乐观锁、draft/published 双态、publish 生成不可变 release（`decisions.md §4 #6`；A14 走 API 落地）。
- [缺口] **C0–C4 五级分类的级别定义与「级别 → 是否可自动过」映射不存在**（`:146` 只给「5 级分类」）。没有这张表，T1 的绿阈值无法计算。
- [缺口] **「七道闸防误配」内容不存在**（`:181` 只有名字）。
- [缺口] 配置变更的人类审批人是谁（H6？H5？A14 上级？）无来源。

**风险等级**：[提案] 低（常规运营配置），但「低风险」分级本身无签字来源，仅为讨论标签。

**三档**
- **绿**：**不可用**。缺 C0–C4 表与七道闸判据（C-03、C-11）。
- **黄**：所有 T1 单路由给人类审批人（具体席位待裁 C-10）；A15 只做要素完整性预审。
- **红**：① 命中 6 类不可配；② 跨写域/跨 owner 的配置变更；③ 空 diff、版本冲突（409）、缺 If-Match；④ 一次提交多对象（批量）；⑤ 提交流程绕过配置 API 直写。

**路由目标**：候选 H6（配置边界 owner），[缺口] 待裁。

**必须升级**：C0–C4 表、七道闸、审批人归属、任何「不可配」项的修改尝试（升级 H6 + H5 + Lead）。

**来源**：`:146,147,181`；`decisions.md §4 #6`；A15 只映射不立法。

---

### 2.2 T2 高风险（公网测试窗口 / 清 hold / 高危暴露面）

**机器可判定条件（L104 已签，要素齐全才可提交）**
- [已签] 申请要素 = 窗口起止（**单次 ≤24h**）/ 暴露 host+路径 / 认证方式 / profile+env 快照 / SG 规则 ID / kill switch / 具名 owner / 回滚步骤（`:1230`）。
- [已签] 开窗前置（缺一不批）：prod profile；无 `E2E_MODE` / `E2E_AUTH_TOKEN` / dev-token；`tier=internal_eval` + `EXPIRES_AT`；HOLD/AUDIT/EXPECTED_SHA 配齐；仅 `/v1/**`（`/healthz` `/metrics` `/readyz` `/docs` `/internal` 不可达）；边缘认证 + TLS（明文 HTTP 上 Basic Auth 不接受）；无容器 `0.0.0.0` 绑定；`trustProxy` 只信边缘 CIDR；访问日志留存 + 窗口后 24h 复盘；开窗/关窗各一次外部探针取证。
- [已签] **每窗口重新批、无长期通行证**；H5 书面批准后才准开。
- [已签] 公网窗口只测连通性与契约，**不供真实行情**；要公网出数据 = F1 + 单独批。
- [已签] `HOST-EXPOSURE-01` 必须先跑起来（`:1232`）。
- [已签] 清 hold = 扩大授权边界 = **T2 + H5 工单签字**，A13 执行；reconciler/agent 不得自动清（L24 `:254`）。

**风险等级**：[已签] 高风险（H6 类名即「高风险」；H5 基线「双人高危」）。

**三档**
- **绿**：**不可用**。高风险类不自动放行；每窗口必须人类 H5 书面批准。
- **黄**：仅 H5。A15 只核对要素完整性并路由，不得代替 H5 判断。
- **红**：① 任一必需要素缺失；② 窗口 >24h；③ 复用历史批准或「长期通行证」；④ 无 kill switch / 无回滚步骤；⑤ 公网窗口供真实行情；⑥ 清 hold 未经 H5 工单；⑦ 偏离任一前置条件（按「未审批暴露」处置并立即关窗）。

**路由目标**：[已签] H5。

**必须升级**：① 窗口次数上限无裁定；② 「要素完整性预审」是否算 A15 预审、H5 是否复核全部要素，无来源；③ T2 的审批单如何取得 `approval_ref`（通用审批流未建，C-09）。

**来源**：L104 `:1229-1234`；L24 `:254`；L110 摘录 `:1265`；H5 基线 `:144`。

---

### 2.3 T3 文案（C 端对外文案 / 内部 AI 内容 / 话术白名单）

**机器可判定条件**
- [已签] 合规判定只认 `rules/ai-content-policy.json`（12 类禁用）+ `rules/redline-basis.json`（H3-C01..C12 映射）；`policy_version` 必须已签、部署 sha 一致，否则 fail-closed（`rules/README.md`；1.1.1 签字 sha `eee14c62…` / 部署 pin `3e03535e…`）。
- [已签] 允许结论前缀仅「数据显示」（需 numeric 证据）/「历史统计上」（需 historical_statistical 证据）；白名单按 audience（internal 7 类含 `data_gaps`；C 端 6 类）。
- [已签] AI 生成内容必须带「AI 生成·仅供参考」标识；AI 首字角标、红线意图 100% 拦截（H3 §2.3 `:142`）。
- [已签] 6 类不可配含「AI 标识 / 免责 / 风险提示 / 话术白名单」，文案侧不产生「修改这些」的审批单，出现即红（`:146`）。
- [已签] C 端红线归 H3（q3=C 端=A：不放开 AI 荐股，`decisions.md:1322-1330`）；内部员工功能签发权归 owner（L127，`agents/decisions.md:1479-1487`，commit 76a7e03）；ADR-008 D8 由 `OWNER-DECISION-PENDING` 翻为 `ACTIVE-INTERNAL-ONLY`，内部 AI 荐股由 owner 直签放开、仍带「AI 生成·仅供参考」标识；H3 的 q3=A 对内部不再适用。
- [缺口] `policy 1.1.2` 尚未签：internal 12 条 basis 将从 H3-Cxx 改为 owner decision；签之前内部白名单依据仍是 1.1.1。
- [缺口] C 端 go-live 的 H3 三条件（AI-1/2/3）仍未签；F1 对外授权已落地（L127 `:1484`），但取数链走第三方 mirror，「官方授权是否覆盖 mirror 端点」a/b 仍未答 → C 端文案/展示的合规前提不确定。

**风险等级**：[提案] 中（内部）、高（C 端对外），待 H3/H5 确认。

**三档**
- **绿**：**不可用**。内部：等 A5 签 1.1.2（basis 改指 owner decision，L127 `:1483`）+ owner 确认白名单适用；C 端：等 H3 的 AI-1/2/3 与 mirror a/b 闭环。
- **黄**：C 端 → H3；内部 AI/内部功能 → owner（L127 已裁）；规则/词表/类别变更：C 端 → H3 立法 + 法务会签（H3 §2.4 `:143`），内部 basis → owner decision（L127），A5 实现，A15 无权改规则。
- **红**：① policy 未签/版本不符/加载失败；② 命中 12 类任一 redline category；③ C 端展示 AI 方向性内容（q3=C 端=A 不动）；④ 缺 AI 标识；⑤ 试图改话术白名单/免责/AI 标识/as_of/风险提示/退订（不可配）；⑥ 内部样本复用到 C 端或被外部看到（L115 外溢边界）。

**路由目标**：C 端 [已签] H3；内部 [已签] owner（L127）；规则变更：C 端 H3（A5 实现）、内部 basis 归 owner decision。

**必须升级**：1.1.2 签字、C 端 go-live 条件、mirror a/b、内部白名单依据、1.1.2 与 `redline-basis.json` 双 sha 一致性。

**来源**：`:142,143,146`；`rules/ai-content-policy.json`；`rules/redline-basis.json`；`decisions.md:1317-1338`；L127 `:1479-1487`；ADR-008 D8。

---

### 2.4 T4 触达（推送 / IM / 消息触达）

**机器可判定条件**
- [已签] 频次（**取更严**）：单日 ≤1、单周 ≤2、单月 ≤6（H6）；H3 为 1/日·3/周·10/月，取更严 = **1 / 2 / 6**（`:148`）。「取更严」明确写在 `:148`，不是本文发明。
- [已签] 时段 9:00–20:00；同素材 7 天不重复（`:148`）。
- [已签] 不做个性化推送（L12：榜单中性化、不做个性化推送；A14 无法上线个性化推送）——`decisions.md §4 #12`。
- [缺口] 日/周/月是**滚动窗口还是自然窗口**、时区是否 Asia/Shanghai，未定义。
- [缺口] 「同素材」按正文 hash、模板 ID 还是素材库 ID 判重，未定义。
- [缺口] 触达记录 / 发送计数器 / 退订状态的证据源服务未建（无生成数据的地方）。
- [缺口] 触达审批人是谁（H6？H3？）无来源。

**风险等级**：[提案] 中；`[缺口]` 无签字分级。

**三档**
- **绿**：**不可用**。证据源（计数器/素材登记/退订）未建 + 窗口与素材定义缺失（C-05）。
- **黄**：全部路由人类（席位待裁 C-10）；A15 只核对数值与素材重复。
- **红**：① 超频次；② 时段外；③ 同素材 7 天内重复；④ 个性化推送（L12 禁止）；⑤ 批量触达；⑥ C 端触达未经合规审查。

**路由目标**：[缺口] 待裁（候选 H6 + C 端 H3）。

**必须升级**：窗口口径、时区、素材定义、触达审批人、发送证据源归属。

**来源**：`:148`；H3 §2.3 `:142`；`decisions.md §4 #12`。

---

### 2.5 T5 权限（RBAC / agent 身份 / 角色 / 数据授权）

**机器可判定条件**
- [已签] 权限授予（含 agent 身份）= **CI + 双人确认 + H5**，敏感权限额外复核（`agents/README.md:65`）。
- [已签] A15 只走审批 API，**不直写 rbac**；不得自批、不得改自己权限（H5-1 `:90`）。
- [已签] 服务端审批人只能是人类 `H3` 或 `user`（`HUMAN_APPROVERS = ['H3','user']`；agent 一律 403，`services/identity/src/domain/types.ts` + `identity-service.ts:147-162`）。
- [已签] 单条审批是 API 约束，不是 UI 不做按钮（H2 分签 `:1464`）。
- [已签] 机器身份唯一、凭证 ≤15min、默认拒绝、防互借、认证双签（H5 基线 `:144`）。
- [缺口] 「双人确认」= **两名人类**还是 **1 人 + 1 agent 确认**，存在三处口径（`agents/README.md:65`、H5-1 `:90`、A15 system_prompt「人+agent」），必须 H5 裁定（C-06）。在裁定前按最严理解：两名人类，agent 只能做自动化核对。
- [缺口] 「敏感权限」清单未定义。

**风险等级**：[已签] 高（H5「双人高危」、README 权限授予章）。

**三档**
- **绿**：**禁止（硬门 R4）**。即使规则引擎未来命中某条，T5 也必须强制黄/红，不得自动放行。
- **黄**：人类审批人 H3 或 user + H5 复核 + CI 证据；双人确认按最严口径。
- **红**：① 给自己或任何 agent 扩权；② A15 作为审批人；③ agent 作为审批人（403）；④ 批量授权；⑤ 绕过审批 API 直写 rbac；⑥ 缺 CI 证据；⑦ 缺 `approval_ref`；⑧ agent 身份申请未经 H5 复核。

**路由目标**：[已签] H3 / user（服务端强制），H5 复核。

**必须升级**：双人语义（C-06）、敏感权限清单、agent 身份签发流程、rbac 配置变更的评审人（A15 写 `configs/rbac/` 是否也要 H5 复核）。

**来源**：`agents/README.md:65,67`；`:88-96,144,1464`；ADR-008 D1/D2；`services/identity/src/domain/types.ts`。

---

### 2.6 T6 紧急回滚（唯一免审批）

**机器可判定条件**
- [已签] T6 是七类中「**唯一免审批**」（`:147`）；**H5 2026-11-06 裁定**：「免审批」= 免**事前逐单**审批，**不免审批人、不免 `approval_ref`**（C-01 选 b）。
- [已签] **预授权单**：由 A4 审批 API 建单、H5 批准，`approval_ref` 建单即生成（`prod:apr_<uuidv7>`）；范围必须写死：env、服务、from→to revision（仅限回滚到**已部署过的 known-good**）、三类已签触发条件、执行者 A13、kill switch、有效期 ≤7 天或本次发布被取代即失效。
- [已签] 触发即执行，**不再建单**；deploy 事件引用该预授权 ref。执行后 H5 在事故单**事后签收**（`confirm_at` 单列，**不倒填** `approved_at`）：交易时段 2h、非交易 4h；24h 未签收 → A15 升级 user + **阻塞下一次生产发布**，但本次回滚不追溯为未授权（在预授权范围内）。
- [已签] 无有效预授权：prod 回滚按 (c) 逐次 H5 书面 ref；**H5 ≥10min 不可达 → A13 不执行**，Lead→user 升级，先 `READ_ONLY_MODE` 降级；宁可延长故障不越权。
- [已签] **事件先写**（C-02 选 i；break-glass N=15）：`deployment_uid`（回滚目标用新 uid、不复用旧）、`approval_ref`、`executor=A13`、`approver=H5`（真人主体）、`incident_id`、`target_revision`、`target_tier`；回滚改 tier 另写 `tier_switch`（同 `approval_ref`）；**写完再 helm rollback**。执行失败不自动重试；observed 与 deploy 对不上 → L20 落 `internal_eval`，由 H5 决定前滚/再回滚（不振荡）。
- [已签] break-glass：仅 `ServiceDown`/P1 **且审计库不可用**、且预授权单明确允许；执行后 **15min 内**回写 deploy 事件，超时 L20 生效 + P1 升级。审批者字段必须填预授权单上的 H5，**禁止 `SYSTEM_ROLLBACK`/空值**；没有人类审批人就不执行需要 deploy 事件的变更（dev 一样，除非有 A4 出的 dev 预授权单）。
- [已签] 不可逆迁移：仍禁 `helm rollback`；顺序 = 先权限面 fail-closed（`internal_eval`），再前滚修复并写 deploy（H5 紧急发布批准），**不得走 T6**。
- [已签] C-13：T6 只覆盖「回滚到上一已知可用版本」，**不覆盖紧急前滚发布**；冻结窗口内紧急前滚须 H5 书面批准并记录原因，`approval_ref` 由 A4 建单生成，T6 预授权不得用于前滚。
- [已签] 禁止：A13 自批、A15 代填/造 ref、事后补发预授权覆盖已发生回滚、预授权用于不可逆迁移/前滚/扩权/改 `c_end_display`、跨环境复用。
- [已签] runbook 一般约束：A13 唯一执行者、H5 唯一批准人、`rollback.sh` 缺失拒绝；触发立即回滚 = `RollbackExceededFiveMinutes` / `ServiceDown` / 发布后 30min 错误预算燃烧率 >14.4×；冻结窗口交易日 9:15–15:00；灰度 1/10/50/100% 每档 ≥30min；5min 未恢复 → 升级 H5+lead + `READ_ONLY_MODE=1`。
- [前置缺口] **A4 建单实现未落地（契约 `contracts/approval/openapi.yaml` 0.1.0 已落，b73c293；实现待 A4）→ 生成不了 `approval_ref` → T6 自动化/绿档继续不可用**（C-09）；prod 回滚仍按 RB-REL-001 人审 + 只读降级兜底，**不得用「临时 ref」绕 DB CHECK**。

**风险等级**：[已签] 高（紧急 + 生产回滚）。

**三档**
- **绿**：**暂不可用（前置缺口 C-09，不是冲突）**。H5 裁定已出，但 `approval_ref` 生成点（A4 建单事务）未落地；预授权单建单能力就绪前 T6 只能黄。
- **黄**：H5 预授权单（b）或逐次书面 ref（c）；A13 执行；A15 只校验预授权 ref/范围/有效期/执行者/`incident_id`，**不合格即红**；不审批、不代填、不造单。
- **红**：① A13 自批；② A15 代填/造 ref；③ 无有效预授权且 H5 不可达仍执行；④ 事后补发预授权覆盖已发生回滚；⑤ 预授权用于不可逆迁移/前滚/扩权/改 `c_end_display`；⑥ 跨环境复用；⑦ 24h 未签收未升级/未阻塞下一次生产发布；⑧ break-glass 超 15min 未回写；⑨ observed 与 deploy 对不上却掩盖；⑩ 审批者字段为 `SYSTEM_ROLLBACK`/空；⑪ 回滚失败自动重试或反复振荡；⑫ 冻结窗口内用 T6 预授权做前滚。

**路由目标**：H5（批准/事后签收）；执行 A13；A15 校验 + 催签收 + 超时升级 user/Lead。

**必须升级**：C-09（A4 建单能力，T6 绿档前置）；预授权单 schema 归 A4 + ADR；`confirm_at`/break-glass 字段与 15min 回写归 A13/A4；H5 ≥10min 不可达 → Lead→user；24h 未签收 → user + 阻塞下一次生产发布。

**来源**：H5 2026-11-06 回执（C-01=b / C-02=i+N=15 / C-13=否，摘要见 `configs/rbac/H5-T6-conflict-brief.md` §7）；`:147,236,254`；RB-REL-001；L51。

---

### 2.7 T7 数据导出

**机器可判定条件**
- [已签] 内部 AI/数据风险项要求：内部工具页水印、访问日志、**导出审计**、防截图（可选）（`:1288`）。
- [已签] H5 会签项包含「内部访问日志 / 导出 / 水印 / 网络要求」（`:1318`；截至本文 H5 会签 PENDING）。
- [已签] L115 评测台 A 形态（fail-closed 八条件）中与导出相关：产出是「评测样本·不对外」非成品；**导出水印 + 样本编号**；样本库与 C 端文案库物理分离；带 AI 标识（内部也不豁免）；留痕 ≥3 年；单人查看。
- [已签] 非公开信息 = `nonpublic_information`（H3-C12，PENDING_LEGAL 依据档，禁止引用条号）。
- [已签] 内部样本/导出物一旦被同事/朋友/客户看到 → **立即按「向第三方提供」处理：停**（L115 外溢边界）。
- [缺口] 导出的**行数/字段/敏感度分级阈值**不存在；「批量导出」定义不存在。
- [缺口] 导出审计事件 schema、水印实现归属未定（ADR-008 会签 PENDING）。
- [缺口] 导出审批人是谁（H5？H3？）无来源。

**风险等级**：[提案] 中高；[缺口] 无签字分级。

**三档**
- **绿**：**不可用**。缺阈值（C-08）与证据源（导出服务/审计/水印）；`H5 会签 PENDING`。
- **黄**：H5（水印/导出审计/网络）+ C 端或外溢场景 H3；具体席位待裁 C-10。
- **红**：① 导出 C 端/第三方可见的成品；② 含非公开信息；③ 无导出审计/无水印/无样本编号；④ 批量导出（阈值未定前一律升级）；⑤ 外部人员可见（L115 立即停）；⑥ 导出后复用到 C 端。

**路由目标**：[已签] H5（会签未完成）；C 端/外溢 [已签] H3。

**必须升级**：导出阈值与字段分级（C-08）、水印/审计归属（ADR-008 H5 会签）、mirror 数据合规（L127 `:1484` a/b）、T7 审批人。

**来源**：`:1288,1317-1338`；L114/L115；ADR-008；H3-C12。

---

## 3. ADR-008 两类（身份相关，`services/identity/` 已实现部分）

> 这两类不归 H6 七类编号，但属于 A15 必须处理的「审批类型」，且都要显式覆盖。实现现状：`approve/reject` 领域逻辑已落，HTTP 审批入口 P0 未暴露（`plugin.ts`），审批只能由 H3/user 人类调用。

### 3.1 内部员工转正：`internal_pending → internal_active`

**机器可判定条件**
- [已签] 只有人类可批：`approved_by ∈ {H3, user}`；服务端 `assertHumanApprover` 拒绝 agent（403 `approver_not_human`）。
- [已签] `approval_ref` 必须由 A4 建单事务生成、`apr_<uuidv7>` 形态、DB CHECK 校验；缺 `approval_ref` 的 `internal_active` 视为数据错误，gate fail-closed 且 DB CHECK 拒绝（L72 `:959`、`:1464`）。
- [已签] `internal_tier` 一次性写入；默认 `internal_eval`；选 `research_only` 必须审批人显式选择 + 写理由；不得绑 `c_end_display`。
- [已签] 审批通过/拒绝都写 `internal_approval` 审计事件；拒绝不删申请；`session_version + 1`。
- [已签] 禁止批量一键通过（P0）；`internal_pending` 登录即使凭证正确也不签 token，返回通用 403。

**三档**
- **绿**：**禁止（硬门 R5）**。ADR-008 D1：不允许自审批/自动审批。
- **黄**：H3 或 user，逐条人工。
- **红**：① agent 作为审批人；② A15 作为审批人；③ 自动/批量；④ 缺 `approval_ref`；⑤ `research_only` 无显式选择/无理由；⑥ 绑 `c_end_display`；⑦ 对非 `internal_active` 用户写 tier。

**来源**：ADR-008 D1/D2；`:1464`；L72 `:959`；`services/identity/src/domain/types.ts`、`transitions.ts`、`migrations/001_identity.sql:42-58,81-91`。

### 3.2 internal tier 改档（`internal_eval ↔ research_only`）

**机器可判定条件**
- [已签] 仅 `internal_active` 用户可改档；改档须 `approval_ref`、人类审批人、写审计；`session_version + 1`（`applyInternalTierChange`）。
- [已签] 「未留痕的 tier 变更按未授权处理 → 立即 fail-closed 回 `internal_eval`」；机制 = `tier_state_observed` 与 `deploy` 事件对不上即回退；原始 JSONL 不得删除（L20 `:236`）。
- [已签] 部署事件分执行者/审批者两字段（L20）。
- [缺口] 「改档」是否需要 H5 会签、与 T6 回滚的先后（C-02）。

**三档**
- **绿**：**禁止（硬门 R5）**。
- **黄**：H3 或 user 人工 + 审计 + 留痕对齐。
- **红**：① 未留痕改档（按 L20 fail-closed）；② 事后追认/补批一个已发生的改档；③ 无 `approval_ref`；④ 试图把 tier 写成 `c_end_display`；⑤ 在 T6 回滚窗口内改档却不写 deploy 事件。

**来源**：L20 `:236`；L111/L112 `:1269` 起；ADR-008 D1/D2。

---

## 4. 冲突与必须升级项（C 清单）

> 除 C-01/C-02/C-13 已由 H5 裁定（2026-11-06，细则见 §2.6）外，其余均为 `must_escalate`：本文不裁定、不猜。编号将带入 `approvals/` 第二步与规则引擎常量。

| ID | 冲突/缺口 | 双方来源（事实） | 影响 | 裁决人 | 当前临时处置（fail-closed） |
|---|---|---|---|---|---|
| **C-01** | T6「唯一免审批」vs 生产回滚必须 H5 书面 `APPROVAL_REF` | `decisions.md:147` vs RB-REL-001 | **已裁（H5 2026-11-06，选 b）**：免事前逐单、不免审批人/`approval_ref`；预授权单范围写死、事后签收 | **H5（已裁）** | 按 §2.6；A4 建单未落地前 T6 仍全黄 |
| **C-02** | T6 回滚 vs L20 未留痕 tier 变更 fail-closed 的时序 | `decisions.md:147,236`；RB-REL-001 | **已裁（H5 2026-11-06，选 i）**：先写 deploy 事件再回滚；break-glass N=15；不一致由 H5 决定前滚/再回滚 | **H5（已裁）** | 按 §2.6；无人类审批人不执行需 deploy 事件的变更 |
| **C-03** | T1 缺 C0–C4 五级分类定义与「级别 → 绿/黄」映射 | `decisions.md:146`（只有摘要） | T1 绿阈值无法计算 | **H6** | T1 全黄 |
| **C-04** | T3 C 端 go-live：AI-1/2/3 未签 + F1 对外授权已落地但 mirror a/b 未答 | ADR-008 状态；L127 `:1484`；`rules/` 1.1.1 | C 端文案/展示不能判绿；内部 1.1.2 basis 待 A5 改指 owner decision | **H3（C 端）+ owner（F1/内部）** | C 端全黄；内部全黄 |
| **C-05** | T4 日/周/月窗口口径、时区、同素材定义缺失 | `:148` 只给数值 | 频次判据不可机器判定 | **H6** | 触达全黄 |
| **C-06** | 「双人确认」= 两名人类 or 人+agent？ | `agents/README.md:65`、H5-1 `:90`、A15 system_prompt | 权限类审批路径分叉；可能设计出 agent 审批 | **H5** | 按两名人类 + agent 仅自动化核对 |
| **C-07** | 「批量授权/批量审批」的数量定义 | `:90,1464` 只禁批量，无阈值 | 无法机器识别批量 | **H5** | 任何多对象提交 → 红 |
| **C-08** | T7 导出阈值：行数/字段/敏感度/批量定义缺失 | `:1288,1317-1338` 只有原则 | T7 无绿阈值 | **H5 + H3** | 导出全黄；批量一律升级 |
| **C-09** | 通用审批契约已落、建单/账本实现未落：A4 `approve` 只覆盖 identity 申请，T2–T7 无建单实现 | `contracts/approval/openapi.yaml` 0.1.0（b73c293，6 ops：create/list/get/evaluate/decide/events）；`services/identity/src/plugin.ts`；L51 | T2–T7 仍无 `approval_ref` 可发，L51 无法满足 | **A4 + Lead** | 按契约 mock/评审；不产生 T2–T7 自动单；人工工单 + 补录待裁 |
| **C-10** | 每类的人类审批人/路由目标表缺失（T1/T4/T7 尤其） | 无来源 | 黄档无法确定送谁 | **H6 + H5** | 送 H5 兜底，同时升级 Lead |
| **C-11** | H6 七类的具体判据、16 项边界的级别表、七道闸内容均未落仓库 | `:146,147,181` 只有摘要 | 除已单列的 L104/触达数值外，七类判据整体不足 | **H6** | 七类全黄 |
| **C-12** | 规则引擎运行时未实现，且实现归属未定（A4/A8/A11？） | 仓库无 engine；A15 写域只有配置/账本 | 「绿」无法产生 | **Lead** | 全黄 |
| **C-13** | 紧急发布（冻结窗口）vs T6 免审批边界 | RB-REL-001；`decisions.md:147` | **已裁（H5 2026-11-06：否）**：T6 只覆盖回滚，紧急前滚仍需 H5 书面批准 + `approval_ref`，T6 预授权不得用于前滚 | **H5（已裁）** | 紧急前滚按 runbook，不按 T6 放行 |
| **C-15** | A15 写 `configs/rbac/`（权限相关配置）由谁复核？A15 不能自批 | roster 写域 vs R3/README:65 | 规则配置可能成为自我授权通道 | **H5** | 本文件仅为设计稿；任何生效型 rbac 配置须 H5 复核 + 非 A15 审阅 |

> **C-14 已裁（2026-11-06）**：L127（`agents/decisions.md:1479-1487`，commit 76a7e03）明确 owner 持最高授权签发权、内部员工功能签发权从 H3 收归 owner、ADR-008 D8 翻 `ACTIVE-INTERNAL-ONLY`，C 端 q3=A 不变，故从 must_escalate 划出。实现跟进（非冲突）：`services/identity` 的 `HUMAN_APPROVERS` 目前只有 `H3`/`user`；若 owner 以独立身份签发，需 A4 在 ADR 更新时扩展枚举，本轮不改代码。

---

## 5. 待裁清单（按裁决人分）

**H5（阻断项最多）**
0. **[已裁 2026-11-06]** C-01 / C-02 / C-13：T6 三角，H5 回执（b / i+N=15 / 否），细则见 §2.6 与 `H5-T6-conflict-brief.md` §7；剩余前置缺口 C-09（A4 建单 API）。
2. C-06：双人确认语义。
3. C-07：批量阈值。
4. C-08：导出阈值（与 H3 共裁）。
5. C-15：A15 自身权限配置的复核人。
6. H5 会签：内部访问日志 / 导出 / 水印 / 网络（T7 前置，`:1318` 仍 PENDING）。

**H6**
1. C-03：C0–C4 五级分类表 + 七道闸。
2. C-05：触达窗口/时区/素材定义。
3. C-11：七类具体判据全文（本文件只能覆盖已单列部分）。
4. C-10：各类人类审批人（与 H5 共裁）。

**H3**
1. C-04：C 端 go-live 条件 + mirror a/b 对合规的影响（F1 已授权，但 mirror 未答）。
2. T3 规则/词表变更的立法与签署（1.1.2）。
3. T7 外溢边界援引（L115）。

**A4 / Lead**
1. C-09：通用审批单建单**实现** + `approval_ref` 生成点（契约 0.1.0 已落，实现未落；必须由 A4 建单事务，不能 A15 代填）。
2. C-12：规则引擎实现归属。

**Lead（跨域）**
1. 本设计稿的审阅/转签（H5 + H6 + H3 会签后才可进入「规则生效」阶段）；C-14 已由 L127 裁定（D8 = `ACTIVE-INTERNAL-ONLY`），无需再裁。

---

## 6. 覆盖矩阵

| 类 | 机器可判定条件 | 风险等级 | 绿 | 黄 | 红 | 路由 | 主要缺口 |
|---|---|---|---|---|---|---|---|
| T1 常规 | 部分（不可配 6 类、If-Match） | 提案低 | 不可用 | 全黄 | 可判 | 待裁 | C-03/C-11/C-10 |
| T2 高风险 | 是（L104 要素表） | 已签高 | 不可用 | H5 | 可判 | H5 | C-09（建单） |
| T3 文案 | 是（rules 已签 1.1.1） | 提案中/高 | 不可用 | C 端 H3 / 内部 owner+H5 | 可判 | 已签 | C-04、1.1.2 |
| T4 触达 | 数值已签、口径缺失 | 提案中 | 不可用 | 待裁 | 部分可判 | 待裁 | C-05/C-10 |
| T5 权限 | 硬规则已签 | 已签高 | **禁止** | H3/user+H5 | 可判 | 已签 | C-06 |
| T6 回滚 | 部分（runbook + H5 裁定） | 已签高 | **不可用（C-09）** | H5（预授权或逐次） | 可判 | H5 | C-09 |
| T7 导出 | 原则已签、阈值缺失 | 提案中高 | 不可用 | H5(+H3) | 部分可判 | 部分 | C-08 |
| 员工转正 | 是（identity 实现+D2） | 已签高 | **禁止** | H3/user | 可判 | 已签 | — |
| tier 改档 | 是（L20+ADR） | 已签高 | **禁止** | H3/user | 可判 | 已签 | C-02 |

> 「可判」指红/黄条件可机器判断；「不可用」指绿阈值没有已签来源，不得自动放行。

---

## 7. 实施状态与顺序（本文件不越界）

1. **现在（本文）**：规则映射 + 判定模型 + 缺口清单。**不产生生效配置**。
2. **裁定推进**：H5 已对 C-01/C-02/C-13 出裁定（2026-11-06，§2.6）；其余 C 清单待 H5/H6/H3/Lead 裁定 → 把裁定写成本文件 v0.2（逐条标注签字 ref）。
3. **第二步（A15 另一任务，未开工）**：`approvals/` 账本 append-only 结构，字段按 §1.3 投影；仍不写引擎。
4. **依赖他人**：A4 通用审批建单实现（契约 0.1.0 已落，C-09）；规则引擎实现归属（C-12）；A8 审批界面（P0 入口未开）。
5. **在此之前**：任何审批单只能人工处理；A15 只做预审/填单/路由/催办；「绿」不存在。

---

## 附录 A · 来源索引（可回指）

| 来源 | 位置 | 本文用途 |
|---|---|---|
| C1 裁定 = A | `agents/decisions.md:28,83-96`（H6-1 `:88`、H5-1 `:90`） | A15 无终审权、低风险机器过 |
| A15 写域/硬规则 | `agents/roster.yaml:532-559`；`agents/README.md:65,67` | 边界、双人、agent 不批 agent |
| H3 §2.3 执行参数 | `agents/decisions.md:142` | AI 标识、100% 拦截、IM 1/3/10、留痕 3 年 |
| H3 §2.4 立法权 | `agents/decisions.md:143` | 规则变更只能 H3 立法 |
| H5 安全基线 14 条 | `agents/decisions.md:144` | 默认拒绝、双人高危、审计不可篡改 |
| H6 配置边界 16 项 | `agents/decisions.md:146` | C0–C4、6 类不可配 |
| H6 审批流 7 类 | `agents/decisions.md:147` | T1–T7 名称与 T6 免审批 |
| H6 触达数值 | `agents/decisions.md:148` | T4 频次/时段/素材 |
| H6 原始议程（10+16+7） | `agents/decisions.md:181` | 七道闸来源占位（内容缺失） |
| L20 | `agents/decisions.md:236` | 未留痕 tier 变更 fail-closed；deploy 双字段 |
| L24 | `agents/decisions.md:254` | 清 hold = T2 + H5 |
| L51 | `agents/decisions.md:640-650` | `apr_<uuidv7>`、建单事务、DB CHECK |
| L72 | `agents/decisions.md:959` | 缺 approval_ref 的负样本口径 |
| L104 公网窗口 | `agents/decisions.md:1229-1234` | T2 全部要素 |
| L111/L112/L113/L114/L115 | `agents/decisions.md:1269-1348` | 内部员工、q3、外溢边界、评测台八条件 |
| L125 / ADR-008 会签 | `agents/decisions.md:1457-1468` | H2 会签条件、`internal_active` CHECK |
| 内部访问风险提示 | `agents/decisions.md:1288` | 内部水印/访问日志/导出审计 |
| L127 | `agents/decisions.md:1479-1487`（commit 76a7e03） | owner 持最高签发权、D8→ACTIVE-INTERNAL-ONLY、mirror a/b 未解 |
| ADR-008 | `docs/adr/ADR-008-user-tiers-and-entitlement.md` D1/D2/D3 | 两类用户、审批人、tier 语义 |
| RB-REL-001 | `docs/runbook/release-rollback.md` | T6 唯一执行者/批准人、冻结窗口、不可逆迁移 |
| H5 T6 裁定（2026-11-06） | `configs/rbac/H5-T6-conflict-brief.md` §7（A15 收件；正式入库待 Lead） | 预授权单/事后签收/事件先写/break-glass/前滚否 |
| 通用审批契约 | `contracts/approval/openapi.yaml` 0.1.0（commit b73c293） | 6 operations、create 不收 approval_ref、decide 仅人类、events append-only、evaluate 可 yellow |
| 规则真源 | `rules/README.md`；`rules/ai-content-policy.json`（1.1.1）；`rules/redline-basis.json`（1.0.0） | T3/T7 判据与 fail-closed |
| 审批 id 实现 | `services/identity/src/domain/approval-ref.ts`；`migrations/001_identity.sql:32-58` | 形态、生成点、CHECK |
| 审批服务 | `services/identity/src/service/identity-service.ts:147-162,455+`；`plugin.ts` | 人类审批人、路由未暴露 |
| 配置一致性 | `agents/decisions.md §4 #6` | version/If-Match、draft/published |

## 附录 B · 判定记录示例（仅示意字段，不是生效规则）

```json
{
  "decision": "yellow_route",
  "rule_id": "T2-PUBLIC-WINDOW-001",
  "rule_version": "v0.1-draft",
  "source_refs": ["agents/decisions.md:1229-1234", "docs/runbook/release-rollback.md"],
  "policy_snapshot": null,
  "input_hash": "sha256:...",
  "reason_codes": ["HIGH_RISK_NO_AUTO_PASS", "MISSING_H5_SIGNOFF"],
  "route_to": "H5",
  "required_reviews": ["H5_WRITTEN_APPROVAL"],
  "approval_ref": "prod:apr_0190f3c2-7a4b-7c3d-8e2f-0123456789ab",
  "decided_by": null
}
```

## 附录 C · 变更记录

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| v0.1 | 2026-11-06 | A15 | 首版：七类 + ADR-008 两类映射、判定模型、C-01..C-15 缺口、覆盖矩阵。**未生效**。 |
| v0.1.1 | 2026-11-06 | A15 | C-14 按 L127 划出 must_escalate；T3/C-04 同步 owner 签发；C-01/C-02/C-13 整理为一页交 H5。 |
| v0.1.2 | 2026-11-06 | A15 | 落 H5 T6 裁定（C-01=b / C-02=i+N=15 / C-13=否）：§2.6 重写、C 表与 §5 标注已裁、矩阵 T6 行与 §7 更新、附录加裁定来源。 |
| v0.1.3 | 2026-11-06 | A15 | A0 通用审批契约落盘（`contracts/approval/openapi.yaml` 0.1.0，b73c293）：C-09 改为「契约已落、A4 实现未落」，T6 绿档前置不变。 |
| v0.1.1 | 2026-11-06 | A15 | L127 入库后更新：C-14 划出 must_escalate（owner 签发权 + D8 翻 ACTIVE-INTERNAL-ONLY）；T3 内部 basis 改指 owner decision、C 端 q3=A 不变；F1 对外授权落地、mirror a/b 仍未答。 |
