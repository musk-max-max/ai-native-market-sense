# ADR-008：两类用户分层（C 端 / 内部员工）与双层 entitlement

- **状态**：Proposed（A0 起草，2026-11-05；H2 架构签字 PENDING；H3 的 q3 裁定 BLOCKED-PENDING-H3；H4 数据范围会签 PENDING；H5 内部防护会签 PENDING）
- **起草**：A0 arch-contract
- **关联**：用户裁定 m06048 / 四点澄清 m06061；`agents/decisions.md` §12 L111/L112；ADR-001（契约标准）、ADR-004（来源词表/授权时间盒）、ADR-006（用户可见文案）、ADR-007（AI 功能层）；`services/market/src/domain/entitlement-gate.ts`、`domain/entitlement.ts`、`config.ts`、`auth.ts`、`routes.ts`、`routes-b1.ts`、`ports/serving-repo.ts`；`docs/release/S0-STATUS.md`（F1 未落地，C 端仍 403）
- **影响面**：A4（identity/认证/角色/审批流）、A3（gate 双维度改造与路由）、A8（console 审核与内部工具页）、A11（契约/门禁测试）、A12（E2E）、A16/H3（两条审查流水线）、A13（部署/限流/日志告警）、H2/H4/H5（签字）
- **可逆性**：高。P0 不引入破坏性数据模型；gate 以 feature flag 分阶段启用，JWT 额外 claim 对旧 token 缺省即忽略；内部路由为 additive namespace，关闭后回到现有 C 端单 tier 行为。

## 背景

### B1 用户裁定原文

用户（m06048）：「客户端有两类用户。c端普通用户，以及内部员工用户。所以，注册和登录时需要区分角色，内部员工用户需要后台审核。所以，c端页面的合规性审查要考虑两种情况，内部员工可见的内容无需考虑合规性。」

用户四点澄清（m06061，Lead 记 L112）：

| 澄清点 | 裁定 |
|---|---|
| q1 内部审核流程 | H3 或用户**人工审批**；通过前 `internal_pending` **不可登录** |
| q2 「全部审查都免」 | 含 UI 装饰（AI 标识/免责/footer）、未过滤原始数据、C 端被否形态（如涨跌停个股梯队） |
| q3 荐股红线 | 内部可给明确建议（建议买入/目标价）——**BLOCKED-PENDING-H3**，本 ADR 只留占位与风险，不写实现 |
| q4 entitlement tier | 内部员工绑定更高 tier，按用户角色取 tier；服务 tier 为上限 |

### B2 现状证据（以代码为准，不假设能力存在）

1. **只有一个服务级 tier，没有用户/受众维度。** `services/market/src/config.ts:9-11` 定义
   `DataTier = internal_eval | c_end_display | research_only | platform_user_data`，由环境变量
   `ENTITLEMENT_TIER` 单值解析（`config.ts:80-90`、`:212-294`）。
2. **Gate 在插件启动时创建一次，判定不接收请求上下文。** `services/market/src/plugin.ts:160`
   构造 `new EntitlementGate(config, controlRepo, clock)`；`services/market/src/domain/entitlement-gate.ts:145-184`
   的 `evaluate()` 只读服务配置、control 行和时间盒，没有 `request.user` / JWT claim 输入。
3. **`is_entitled` 只对 `c_end_display` 为 true。** `services/market/src/domain/entitlement.ts:85`
   `isEntitled = config.entitlementTier === 'c_end_display' && !degraded`；
   `services/market/src/domain/build.ts:69` 的 `entitlementForTier()` 在响应 meta 中回显该语义。
4. **路由层把受众硬编码为 C 端。** `services/market/src/routes.ts:150` 与 `routes-b1.ts:88` 都是
   `const audience = 'c_end' as const;`；当前 `Auth.ts` 的 `Principal` 只有 `userId`
   （`services/market/src/auth.ts:16-18`），没有 `user_type`、没有 tier。
5. **数据端口已经预留 internal 受众。** `services/market/src/ports/serving-repo.ts:47-51`
   定义 `Audience = 'c_end' | 'internal'`，`:137-151` 的读方法接受 `audience?`；
   `pg-serving-repo.ts:194-196` 在 `audience='c_end'` 时追加 `display_safe = true`，
   `audience='internal'` 时不过滤。**管道已存在，缺的是授权/身份和路由选择。**
6. **注册/登录/审批全部不存在。** 当前只有 E2E 静态 token（`auth.ts:36-52` 的 `createAuthenticator`），
   无 `user_type` 字段、无审批流、无 JWT claim；内部员工没有可执行的身份入口。
7. **控制面仍有约束，且对内部同样适用。** `EntitlementGate` 的 hold /
   `last_reconciled_at` 新鲜度 / 配置指纹 / 到期时间盒 / 审计事件（`entitlement-gate.ts:145-184`、
   `:220-239`、`:248-279`）目前是服务级 fail-closed；这些不是「C 端装饰」，不能因内部账号而关闭。
8. **F1 未落地，C 端展示仍 403。** `docs/release/S0-STATUS.md` 与 ADR-004 的判定：授权未落地期间
   `tier` 停 `internal_eval`、`is_entitled=false`、行情/财务 403；内部员工开放**不改变** F1 的 C 端展示门禁。

### B3 问题拆解

现状把三件不同的事压在同一个 `tier` 上：

1. **发布/展示授权**（C 端能不能展示：只 `c_end_display` 可以）；
2. **数据访问范围**（内部评测能看多原始：`internal_eval` 可看未过滤数据，`research_only` 看研究口径）；
3. **合规装饰与审查**（AI 标识/免责/footer/H3 逐条文案 vs 内部工具页）。

因此不能把「内部员工」实现成「把 `ENTITLEMENT_TIER` 调高」或「给内部账号发一个 admin 布尔值」——那会同时改变 C 端发布门禁和数据范围，是两类不同的风险。本 ADR 用**受众（audience）+ 发布轴（release tier）+ 内部数据档（internal tier）**三件显式对象拆开。

### B4 范围与非目标

- 本文只定义架构、角色/授权语义、迁移路径和签字边界；**不改代码、不改契约、不改 roster/ownership**。
- 不实现注册/登录/审批（A4）、不改 gate（A3）、不建 console 页面（A8）、不改 C 端契约。
- q3 的「AI 对内部员工给明确建议」不在本 ADR 实现范围，只留占位和风险清单，等 H3 书面裁定。
- 不改变 F1 时间盒、hold/审计、`display_safe`、no-store、限流等既有安全机制。

## 决策

### D1 角色模型：三值 `user_type`，审批是唯一升级路径

P0 采用用户裁定的三值（不再增加第四种「suspended」值；停用/吊销用账号状态与 token 版本表达，见 D2）：

```text
user_type = c_end | internal_pending | internal_active
```

| 字段 | 类型/取值 | 说明 |
|---|---|---|
| `user_id` | string | 服务端生成，永不复用 |
| `user_type` | `c_end` \| `internal_pending` \| `internal_active` | 公开注册默认 `c_end`；内部注册进入 `internal_pending`；只能由人工审批转 `internal_active` |
| `internal_tier` | `internal_eval` \| `research_only` \| null | 仅 `internal_active` 有效；默认 `internal_eval`；审批时由审批人显式选择并记录；**不允许绑定 `c_end_display`**（`c_end_display` 是 C 端发布授权，不是内部数据档） |
| `approved_by` | `H3` \| `user`（人类席位/平台所有者） | 只允许人类；agent 不能审批（README 硬约束「agent 不能批准 agent」） |
| `approved_at` | ISO8601 | 审批时间 |
| `approval_ref` | string | 审批记录/工单/decisions 引用，必须可回指 |
| `session_version` | integer | 审批、改 tier、停用时递增；用于 token 失效 |
| `account_locked` | boolean | 停用/吊销；不改变 `user_type`，但登录拒绝且旧 token 失效 |

状态机：

```text
未注册 ──公开注册──> c_end
未注册 ──内部注册（邀请/企业邮箱）──> internal_pending
internal_pending ──H3 或用户人工通过──> internal_active
internal_pending ──人工拒绝──> rejected（不签发 token；可重新申请，P1）
internal_active ──停用/吊销──> account_locked=true（user_type 保留；token 全失效）
```

硬规则：

1. **`internal_pending` 没有任何登录态**：登录校验通过也不签发 token；返回 403（通用 `FORBIDDEN`，不在响应体暴露审核原因，原因只进服务端审计日志）。
2. **不允许自审批/自动审批**：注册请求里的「我是内部员工」只是申请，不是角色；`internal_active` 只能由 `approved_by` 人工写入。A15 可以作为审批工具/流程编排，但不能作为审批主体。
3. **内部注册必须有防滥用入口**：邀请码或企业邮箱域名白名单 + 频率限制；白名单只降低噪声，不替代人工审批。
4. **角色变更必须使旧 token 失效**：审批通过、tier 调整、停用都递增 `session_version`；JWT 校验 `session_version` 与当前值一致。
5. **P0 不允许客户端自报 tier**：`user_type`/`internal_tier` 只来自服务端存储与签发的 token；请求体/查询参数/自定义 header 一律不参与授权（沿用决策 #5「服务端只信 token 主体」）。

### D2 注册、登录与审批流

责任边界：A4 拥有 identity（注册/登录/用户表/审批状态/签发 token）；A8 提供审批与内部工具页 UI；H3/用户是审批人；A0 定义契约/ADR；A3 在 gate 消费 principal；A16/H3 负责审查流水线；A15 只可作为人工审批的流程工具，不能自动通过。

#### 注册

- 公开注册：默认 `c_end`；不允许在请求里指定 `user_type=internal_active`。
- 内部注册：需要邀请码或企业邮箱域名命中（配置项由 A4/H5 定），创建 `internal_pending`，并写 `internal_registration` 审计事件（邮箱、邀请码引用、时间、来源 IP 哈希）。
- 注册接口必须限流，且对邮箱/手机号做等时响应，避免枚举内部账号。

#### 登录

1. 校验凭证（密码/SSO/MFA，具体归 A4）。
2. 读取 `user_type` 与 `account_locked`：
   - `account_locked=true` → 403（通用文案）；
   - `internal_pending` → 403 `FORBIDDEN`，**不签发 token**，不返回 `internal_tier`/审批人；
   - `c_end` / `internal_active` → 签发短期 JWT。
3. JWT claims（最小集）：

```json
{
  "sub": "user_id",
  "aud": "market-sense",
  "user_type": "c_end | internal_active",
  "tier": "c_end_display | internal_eval | research_only",
  "session_version": 3,
  "iat": 0,
  "exp": 0
}
```

- `tier` 是**用户侧档位**：`c_end` → `c_end_display`；`internal_active` → `internal_tier`。
- `user_type`/`tier` 必须由 identity 服务签名；服务端不从客户端 header 读取角色。
- `aud` 只用于 token 来源/受众校验，**不用于选择路由的 audience**；路由 audience 由路径决定（见 D6），防止「改 header 绕合规」。

#### 审批

- 审批动作：`approve(application_id, internal_tier, approved_by, approval_ref)` / `reject(...)`。
- 只允许 `approved_by ∈ {H3, user}`；服务端校验调用者是人类身份，agent 机器身份即使有权限也不能审批。
- 审批通过时一次性写入 `internal_tier`（`internal_eval` 默认；`research_only` 需审批人显式选择并写理由），递增 `session_version`，写 `internal_approval` 审计事件。
- 审批拒绝也写事件；`internal_pending` 不因拒绝自动删除，保留申请记录供审计。
- 审批 UI（A8）必须显示申请人的公司邮箱/邀请码来源、申请时间、拟绑 tier、风险提示；审批人不能批量一键通过（P0；防「审批疲劳」）。
- 审批记录是 `internal_active` 的唯一证据；没有 `approval_ref` 的 `internal_active` 视为数据错误，gate 直接拒绝（fail-closed）。

### D3 entitlement 双维度：受众 + 发布轴 + 内部数据档

#### D3.1 先把语义拆开

当前四个 tier 不是一条全序：

| tier | C 端发布/展示 | 内部数据范围 | 说明 |
|---|---|---|---|
| `internal_eval` | 否 | **最原始的内部评测数据**（未过滤、含 C 端被否形态） | 当前也是 C 端 fail-closed 的默认档 |
| `research_only` | 否 | 研究口径/派生数据（不含 C 端展示授权） | 介于内部评测与 C 端展示之间 |
| `c_end_display` | **是**（F1 授权后） | C 端 `display_safe` 子集 | 只有它能令 `is_entitled=true` |
| `platform_user_data` | 否 | 仅用户自己的自选等私有数据 | **正交资源域**，不参与市场数据 min 比较 |

因此「`min(user_tier, service_tier)`」在**发布/展示轴**上成立，但不能直接拿来当内部数据范围：`internal_eval` 在展示轴最低，在内部数据范围却最高，二者语义相反。ADR 的落地方式：

- **发布轴 `releaseRank`**：`internal_eval(0) < research_only(1) < c_end_display(2)`，数值越高越接近 C 端发布；`platform_user_data` 不参与该轴。
- **C 端**：`user_release_tier = c_end_display`，`effective_release_tier = min(c_end_display, service_tier)`；只有等于 `c_end_display` 且未过期/未 hold/指纹一致才允许 C 端展示，才令 `is_entitled=true`。
- **内部**：不使用 release min；`effective_internal_tier = user.internal_tier`，仅允许 `internal_eval` / `research_only`。它表示数据范围，不表示发布授权；内部响应不宣称 C 端 `is_entitled`。
- **服务 tier 仍是发布上限**：`ENTITLEMENT_TIER` 不新增取值、不改变既有默认；它限制 C 端能发布到哪一档。内部数据范围由审批人绑定的 `internal_tier` 决定，但仍受数据合同/审计/hold 约束（见 D3.3）。

**这一处是对 Lead 公式的细化，需 H2 在架构评审确认**：若强行把内部数据范围也套 `min`，`internal_active + internal_eval` 会被算成「最低权限」而误封内部评测，与 q2/q4 直接冲突。ADR 建议保留公式用于发布轴，内部范围用独立字段；如果 H2 要求单一 `effective_tier` 字段，则 gate 返回结构里同时保留 `effective_release_tier` 与 `effective_internal_tier`，由调用方按 audience 取用，**不得**把两者压成一个字符串。

#### D3.2 Gate 返回结构（建议）

```ts
type Audience = 'c_end' | 'internal';

interface AudienceGateDecision {
  audience: Audience;
  /** C 端发布档；internal 请求为 undefined（内部不产生发布） */
  releaseTier?: DataTier;
  /** 内部数据档；c_end 请求为 undefined */
  internalTier?: 'internal_eval' | 'research_only';
  /** C 端展示授权；仅 c_end 且 releaseTier=c_end_display 且未降级为 true */
  displayAllowed: boolean;
  /** 内部访问是否允许；仅 internal_active 且 internalTier 合法 */
  internalAccessAllowed: boolean;
  /** 现有 hold/stale/config/expired 语义，对两个 audience 都计算 */
  blocked: boolean;
  degraded: boolean;
  reason?: DegradedReason;
}
```

- **身份输入**：gate 的 `evaluate(request)` 接收已认证 principal（`user_id`、`user_type`、`user_tier`、`session_version`），不再只依赖 service config；principal 由 `services/api` 统一认证后注入（A0/A4 边界，见 D6）。
- **fail-closed**：principal 缺失、claim 非法、session_version 不符、`internal_active` 无 `approval_ref`、`internal_tier` 不在允许集合 → 一律拒绝（C 端 403；内部 403/500 中的 403，不降级为 raw）。
- **`is_entitled` 保持契约原义**：C 端响应 meta 仍只对 `c_end_display` 且未降级为 true；内部响应使用内部契约（D6），不复用 C 端 `is_entitled`。

#### D3.3 hold / 过期 / 审计对内部仍适用

- **hold**：control 行 `hold=true` 时，**C 端和内部都拒绝行情/财务数据**（内部也必须走 hold 检查）；内部工具页可以展示「hold 中」状态与运营说明，但不得展示被 hold 的数据。
- **control 缺失/陈旧/配置指纹不一致/读失败**：两个 audience 都按现有 fail-closed 语义阻断数据读取；内部不因角色更高而绕过。
- **到期时间盒**：`ENTITLEMENT_EXPIRES_AT` 到期首先关闭 **C 端发布**（`c_end_display`→`internal_eval`，行情/财务 403）。内部 `internal_eval` 评测是否可在 F1 到期后继续，取决于 tushare 合同对内部使用的约定（H4 会签）；在 H4 书面确认前，ADR 取保守：**到期后内部仅允许 `internal_eval` 的非展示原始数据，且写入 `internal_access_after_expiry` 审计事件；`research_only` 一并关闭**。
- **审计**：内部访问写 `internal_access` 事件（谁、何时、路径、查询对象、结果条数、tier、audience）；审批/tier 变更写 `internal_approval`/`internal_tier_change`；C 端既有 `entitlement_events` 语义不变，新增 `audience` 字段为 additive。

#### D3.4 缓存与限流

- C 端缓存键继续按现有规则（含 tier/source/as_of）；**内部响应一律 `Cache-Control: no-store`，不写共享缓存、不进 CDN**。
- 内部查询按用户/路径单独限流（复用 `services/api` preHandler 桶，但内部流量单独配额，避免内部批量拉数影响 C 端）；具体数值归 H5/A13。
- 内部与 C 端不得共用可被 CDN 缓存的 URL；内部路由放在独立 path（D6）。

### D4 合规分层：L1 / L2 / L3

| 层 | 内容 | C 端 | 内部员工 | 备注 |
|---|---|---|---|---|
| **L1 数据授权** | tier/403、未过滤数据、C 端被否形态、F1 时间盒 | 严格：service tier + `c_end`，F1 未落地恒 403 | `internal_active` 按 `internal_tier` 放宽；仍受 tushare 合同/审计/hold 约束 | 内部 raw 不得进入 C 端契约/缓存/公开页面 |
| **L2 C 端 UI 合规装饰** | AI 标识、免责声明、footer、H3 逐条文案预审、copy 版本 | 必需，ADR-006/007 | **豁免**：内部工具页不要求 C 端 decoration，不要求 H3 逐条 copy 预审 | 豁免的是「合规装饰」，不是数据安全/审计 |
| **L3 荐股/投资建议监管红线** | 买卖建议、目标价、方向性/时机性结论、适当性匹配 | 硬禁止 | **q3 待 H3 裁定；在裁定前对内部同样硬禁止** | q3 见 D8；不得用 q2 的「全部审查都免」推导 L3 豁免 |

补充规则：

- 内部页面仍必须显示 **数据来源/as_of/口径**（这是数据完整性，不是 C 端合规装饰），否则内部判断会基于不可追溯数据。
- 内部页面不得出现 C 端免责文案的「复制版」冒充合规；如内部页面需要提示，应走内部 copy/运营文案，不纳入 C 端 COPY_VERSION。
- L1 的内部放宽不等于「可以二次分发」：tushare 合同边界（不转售、不再分发、不公开）对内部账号同样有效；导出/截图控制见 D7。

### D5 两条审查流水线

| 流水线 | 范围 | 审查人 | 产物/门禁 | 不做什么 |
|---|---|---|---|---|
| **C 端审查** | 所有 `/v1/*` 的对外文案、AI 标识/免责、AI 生成内容、C 端形态 | A16 初筛 + H3 逐条/抽样 | copy 版本签字、AI policy 版本、E2E/契约测试 | 不审内部工具页 |
| **内部审查** | 内部工具页、内部数据范围、内部 AI 输出（在 q3 未放开前仅查是否越 L3） | A16 初筛 + H3（L3/数据合同） | 内部页面风险记录、L3 结论、访问审计抽查 | 不要求 L2 装饰、不套 C 端 copy 版本 |

- 两条流水线**不可合并，也不可互相代签**：C 端 H3 签字不能被解释为内部 L3 放行；内部流水线通过不能被解释为 C 端发布授权。
- 审批人 `H3`/`user` 与内容审查 `H3` 是不同动作：审批 internal_active 不等于批准其 AI 建议内容；q3 另需 H3 书面裁定。
- 内部审查记录必须可回指（页面/查询/输出样本），不能只写「内部无需审查」一句。

### D6 路由与契约边界

1. **C 端路由保持 `/v1/*` 不变**：`services/market` 现有 market/fundamental/watchlist 路由继续只服务 C 端发布语义；C 端契约（shared/market/fundamental/watchlist）不改 `is_entitled` 语义。
2. **内部路由单独 namespace：`/v1/internal/*`**（additive；P0 可先只有 health/auth 壳，数据端点按批次增加）。理由：
   - 受众由路径决定，**不读客户端 header/query**，避免「加一个 `X-Audience: internal` 就绕 C 端」；
   - 内部响应不进 CDN/共享缓存，不与 C 端缓存键混用；
   - 契约可独立演进（内部字段可以比 C 端更原始），不污染 C 端 schema。
3. **内部契约**：后续由 A0 新增 `contracts/internal/openapi.yaml`（或等价内部 schema），不复用 C 端 required `disclaimer`/`is_entitled` 语义；内部响应的 `meta` 至少含 `audience=internal`、`as_of`、`tier`、`trace_id`。这是 additive 变更，走 D6 流程。
4. **统一判定点**：`services/api` 负责认证与 principal 注入；`services/market` gate 消费 principal；内部路由只能由 `internal_active` 且 `aud=internal` 访问；C 端路由不接受 `internal_pending`。
5. **A4/A3 边界**：A4 签发/校验身份；A3 只做授权判定与数据读取；A0 负责 ADR/契约；A8 负责审批/内部 UI；A15 不能作为审批主体。
6. **当前中间态**：P0 阶段 `services/market` gate 仍是服务级；内部路由在 D9 Stage 3 前不对外启用；不得在 C 端路由里用「内部 header」临时放行。

### D7 内部工具页防护（q2 放开后的补偿控制）

「内部无需合规审查」不等于「内部数据可以随便带走」。P0/第 2 批必须至少：

| 控制 | P0/第 2 批 | 要求 |
|---|---|---|
| 访问日志 | P0（identity 后立即） | 谁、何时、哪个 user_id、路径、查询对象（instrument id/日期/参数哈希）、条数、结果码；append-only，保留 ≥180 天（H3/H5 定最终值） |
| 导出审计 | P0 设计，第 2 批实现 | 任何 CSV/JSON 下载/批量导出单独端点，记录 user_id、条件、条数、用途；默认关闭批量导出 |
| 页面水印 | 第 2 批（可选 P0） | 用户名/时间水印，仅威慑，不宣称防截图 |
| 防截图 | 可选/第 2 批 | 前端遮罩/禁用右键只能提高成本，不能作为安全控制 |
| 网络与认证 | P0 | 内部路由仅公司网络/VPN 或 SSO + MFA；短 TTL；内部 token 不进 URL/日志；CORS 不开放公网 |
| 数据最小化 | P0 | 内部 API 只支持按标的/按查询返回，不提供全市场打包下载；限流独立 |
| 离职/停用 | P0 | `account_locked` + `session_version` 递增，旧 token 立即失效；审批记录保留 |

这些控制**不能替代 L3**：如果 H3 后续放开 q3，仍需 D8 的三道护栏 + 独立签字。

### D8 q3 占位：BLOCKED-PENDING-H3

**状态：`BLOCKED-PENDING-H3`。本 ADR 不实现、不放行、不写 prompt/契约/代码。**

默认规则（H3 放开前）：

- L3 对**两个 audience 都硬禁止**：不生成「建议买入/卖出/持有」、目标价、方向性/时机性结论、适当性匹配、收益承诺。
- 内部 AI 与其他内部页面一样受 L3 约束；q2 的「全部审查都免」只覆盖 L1/L2，不覆盖 L3。
- feature flag 预留 `INTERNAL_AI_ADVICE_MODE=off`（默认 off；即使 H3 放开，也必须显式开启并带版本/签字）。

风险清单（H3 裁定时必须逐条回应）：

1. **AI 输出本身可能构成证券投资咨询/投顾行为**，需要相应资质；「内部使用」不是自动豁免。
2. **内部页面截图/导出/转述给客户后无法自证仅内部使用**；监管取证看行为与对象，不看权限配置。内部链接外传、员工离职带走都是现实路径。
3. **员工规模达到一定程度可能被认定为「特定对象」范围内的受监管服务**；q3+q2+q4 叠加 = 内部员工能看到 AI 明确荐股，风险随人数/访问通道放大。
4. **责任归属**：若 H3 放开，需明确谁对单条 AI 建议负责、如何留痕、如何撤回；否则出事后无法回溯。
5. **与 F1 的交叉**：F1 授权未落地时，内部 AI 引用未授权数据 + 给建议会放大合规风险；q3 不能绕过 F1 数据边界。

若 H3 书面放开，至少三道护栏（未满足不得实现）：

1. **水印 + 访问日志**：每条内部 AI 建议带「内部使用/禁止外传」水印与用户标识，记录谁何时看了哪条建议。
2. **导出/截图审计**：导出端点单独审计/限流；截图防护只作威慑，不作为合规证据。
3. **员工 NDA + 合规承诺**：明确不得外传、不得据以对客；入职/权限开通时签署并留档。
   另需：按员工/角色最小授权、单条建议可撤回、H3 书面 policy_version、kill switch、法务复核、H5 发布门禁；不得对 C 端复用同一输出。

H3 裁定需要回答的问题（供其书面回执）：允许的建议类型/边界、适用员工范围、审批与留痕方式、责任主体、与 F1 的关系、是否要求法务意见。

### D9 迁移路径（现有服务级 tier → 用户维度）

采用 feature flag 分阶段，**不一次性改 gate 语义**，每阶段可回退：

| 阶段 | 动作 | 行为变化 | Owner/门禁 | 回退 |
|---|---|---|---|---|
| **S0（本 ADR）** | 定义模型/路由/迁移；不写代码 | 无 | A0；H2 架构签字 | 关闭 ADR 实现即可 |
| **S1 identity** | A4 加 `user_type`/`internal_tier`/审批表；注册/登录/审批；JWT claims；`internal_pending` 禁登 | C 端现有行为不变；内部账号可创建但无数据权限 | A4；H3 审批人可用；A11 测试 | 新表 additive nullable；关闭注册入口不影响旧登录 |
| **S2 shadow gate** | A3 扩展 `EntitlementGate` 接受 principal，计算 audience/release/internal 结果，只记日志/metrics，不改变响应 | 无用户可见变化；用于对比 old vs new | A3/A11/A12；`AUDIENCE_GATE_MODE=off\|shadow` | flag=off 回到现状 |
| **S3 enforce internal** | 启用 `/v1/internal/*`（先 auth/health，再只读数据）；内部 gate 强制 `internal_active`；C 端仍走原 gate | 内部账号可用工具页；C 端不变 | A3/A4/A8/A12；H4 数据范围会签 | 关闭内部路由/flag；token audience 隔离 |
| **S4 enforce C-end claims** | C 端路由校验 token `user_type`（缺失按 c_end 兼容），C 端 release 仍由 service tier 决定 | 仅拒绝异常角色/停用账号；C 端展示门禁不变 | A3/A11/A12/H5 | flag=off，回退到旧 token 兼容 |
| **S5 第 2 批内部能力** | 内部工具页、raw 数据端点、导出审计、水印；q3 仅在 H3 放行后 | 内部功能扩展；C 端不变 | A8/A3/A16/H3/H5 | 按功能 flag 关闭 |

迁移要点：

- **不改 `ENTITLEMENT_TIER` 的既有取值/默认**；新增内部配置（如 `INTERNAL_TIER_DEFAULT=internal_eval`、`AUDIENCE_GATE_MODE`、`INTERNAL_AI_ADVICE_MODE=off`）由 A3/A13 定义，默认 fail-closed。
- 旧 token 无 `user_type` → 按 `c_end` 兼容；内部 token 必须带 `user_type`/`tier`/`session_version`，缺失即拒绝。
- 现有用户全部是 `c_end`，无需数据回填；内部账号是新表记录，审批后才出现。
- C 端契约/生成客户端不改；内部契约后续 additive 新增，走 ADR-001 D6。
- gate 扩展必须保持现有 fail-closed 顺序：本地时间盒 → control/hold → 配置指纹 → 受众/tier；不得因新增 principal 分支打乱。
- 回滚优先级：先关内部路由/flag，再关 shadow；C 端 gate 保持旧行为；不删除审计数据。

### D10 现在做 vs 第 2 批做

**现在（P0，S0–S3）**

- A0：ADR-008、内部契约边界（D6）与 `/v1/internal` 命名；不写实现。
- A4：identity 数据模型（`user_type`/`internal_tier`/审批表/`session_version`）、注册/登录、JWT claims、pending 禁登、人工审批 API。
- A3：gate 接受 principal 的 shadow 模式；内部路由 shell；保持 C 端行为不变；hold/audit 双 audience。
- A8：审批列表/详情/通过/拒绝的最小 console；不做内部工具页数据能力。
- A11：角色/审批/双维度 gate 的契约与单元测试；A12：E2E 覆盖 pending 禁登、internal_active 进内部路由、C 端仍 403。
- H3/用户：审批人到位；H3 q3 仍 BLOCKED；H4 会签内部数据范围。

**第 2 批（S4–S5）**

- A8：内部工具页（数据页/查询/导出审计 UI）；A3：内部 raw 数据端点、独立限流、审计事件。
- A16/H3：内部审查流水线（L3/数据合同；不查 L2）。
- 水印/防截图/导出审计增强；q3 只有 H3 书面放开后才排期。
- 任何内部 AI 建议能力都在 q3 放行后单独 ADR/实现，不复用 C 端 AI 契约。

## 被否选项

| 选项 | 为什么不选 |
|---|---|
| 只加 `is_admin` 布尔值，内部账号绕所有 gate | 无法表达 pending/审批/数据范围；一个布尔值同时打开 L1/L2/L3，q3 风险不可控 |
| 把 `ENTITLEMENT_TIER` 调高给内部用 | 服务级全局值，会同时改变 C 端发布门禁；无法按用户区分，F1 时间盒失效 |
| `user_type` 自报 + 后端信 header | 客户端可伪造；违反决策 #5「只信 token 主体」 |
| 内部账号自动审批/域名命中即通过 | 用户明确要求人工审批；自动审批无法承担 L3 责任 |
| 内部与 C 端共用 `/v1/*`，用 `X-Audience` 区分 | 缓存/契约/合规装饰混用，一次 header 漏配就绕 C 端；应路径隔离 |
| 复用 C 端契约承载内部 raw 数据 | C 端 `disclaimer`/`is_entitled` 语义会被污染；内部字段（raw/未过滤）不应进入 C 端 schema |
| q3 直接放开，仅靠「内部可见」自证 | 监管看行为/对象，不看界面；截图/外传无法自证；q3 明确 BLOCKED-PENDING-H3 |
| 内部页面不做访问日志/导出审计 | 数据外泄无法追溯；q2 放开后这是必要补偿控制 |
| 一个 `effective_tier` 字符串同时表达发布与内部范围 | `internal_eval` 在两轴语义相反，必把内部评测误封或把 C 端误放 |

## 可逆性

- 高：S0–S3 全部可通过 `AUDIENCE_GATE_MODE=off`、关闭内部路由、回退 identity 新表（additive）恢复现状；C 端契约/客户端不改。
- 中：一旦内部工具页上线并产生审计数据，回退需保留审计/审批记录（不得删除）；数据导出能力的回退需按 H3 要求保留历史。
- 不可逆点：若 q3 被 H3 放开并产生对外/对客使用，无法用技术回退消除已发生的建议行为——因此 q3 必须走独立签字/法务复核，不能作为普通功能开关。

## 验收 / DoD

本 ADR 本身：

- [ ] ADR-008 覆盖角色模型、审批流、双维度 entitlement、L1/L2/L3、两条流水线、内部防护、迁移路径、q3 占位。
- [ ] H2 架构签字；H3 确认 q3 仍 BLOCKED；H4 会签内部数据范围/F1 到期后内部评测；H5 会签访问日志/导出/水印/网络要求。
- [ ] A4/A3/A8 的实现任务按 D9 阶段拆分，未在 q3 放行前实现任何「内部 AI 明确建议」。

实现验收（后续任务，不在本 ADR 交付）：

- [ ] `internal_pending` 登录返回 403 且无 token；`internal_active` 才可进 `/v1/internal/*`。
- [ ] 审批通过/拒绝/停用均递增 `session_version`，旧 token 失效；agent 不能调用审批。
- [ ] C 端 `releaseTier=min(c_end_display, service_tier)` 与现状语义一致；F1 未落地仍 403。
- [ ] 内部 `internal_eval` 不被 C 端 release min 误封；内部响应不宣称 C 端 `is_entitled=true`。
- [ ] hold/control 陈旧/指纹不一致对 C 端与内部都阻断；内部访问写审计事件。
- [ ] 内部路由 no-store、不进 CDN、独立限流；C 端缓存键不被内部响应污染。
- [ ] 内部工具页访问日志/导出审计可回指到 user_id 与查询对象。

## 风险与待签

| 风险 | 缓解 | Owner/状态 |
|---|---|---|
| q3 监管风险（投顾资质/特定对象/截图外传） | BLOCKED-PENDING-H3；风险清单；若放开需三道护栏 + 法务 + H3 签字 | H3 PENDING |
| 内部账号被误用为对客通道 | 内部路由网络隔离、水印、访问日志、导出审计、NDA | H5/A16 PENDING |
| `min` 语义误实现（内部评测被误封/C 端被误放） | D3 明确发布轴/内部档分离；shadow 对比；契约测试矩阵 | H2/A3/A11 |
| JWT claim 伪造/旧 token 残留 | 签名校验、`session_version`、短 TTL、audience 隔离 | A4/A3 |
| 审批疲劳/人情审批 | 单人单条、显示风险、审批留痕、抽样复核 | H3/A16 |
| F1 到期后内部评测继续的合同边界 | H4 书面确认；到期后仅 internal_eval + 审计；research_only 关闭 | H4 PENDING |
| 内部 raw 数据污染 C 端契约/缓存 | 独立 namespace/契约；no-store；cache key 不共享 | A0/A3 |
| 审计日志本身含敏感数据 | 只记对象 id/参数哈希/条数，不记原始值；访问日志访问也审计 | H5/A13 |

## 附：与现有代码的对应关系

- `services/market/src/config.ts:9-11`：`DataTier` 保持不变；新增内部档绑定的存储归 A4，**不把 `internal_tier` 塞进 env**（env 是服务级，用户级必须是数据）。
- `services/market/src/domain/entitlement.ts:85`：`is_entitled` 继续只对 C 端 `c_end_display` 为 true；内部契约不沿用该字段。
- `services/market/src/domain/entitlement-gate.ts:145-184`：`evaluate()` 增加 principal/audience 输入（A3 实现）；保持时间盒→control→指纹的 fail-closed 顺序。
- `services/market/src/routes.ts:150`、`routes-b1.ts:88`：目前硬编码 `audience='c_end'`；S3 起由路由/principal 选择，内部路由传 `'internal'`。
- `services/market/src/ports/serving-repo.ts:47-51`：`Audience` 已支持 `'internal'`，无需改端口类型；audience 过滤仍在 repo 层（display_safe）。
- `services/market/src/auth.ts:16-18`：`Principal` 从仅 `userId` 扩展为 `{ userId, userType, tier, sessionVersion }`（A4/A3 边界）；E2E dev auth 仅非生产、且必须显式带角色测试夹具，生产无后门（L44/L46）。
- `services/api/src/plugins`/统一判定点：认证/principal 注入归 A4/A0 外壳；内部路由复用现有 no-store/限流/错误映射，但使用内部契约/copy 策略。

## 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-05 | v0.1 | A0 起草；q1/q2/q4 定稿建议；q3 BLOCKED-PENDING-H3；待 H2/H3/H4/H5 会签 |
