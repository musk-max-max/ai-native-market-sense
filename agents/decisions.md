# 决策清单 v0 — 六席议程合并

> 来源：H1 PM/PO、H2 架构、H3 合规、H4 数据、H5 安全运维、H6 业务线，各自独立议程。
> 原始议程共 57 条 + 19 条红线 + 14 条安全基线。本文档做三件事：**去掉重复、标出冲突、分清"你能拍"和"你必须先去问别人"**。
> 状态：**已于 2026-11-03 批量批准**，见 §0.5 裁定记录。带 ★ 的席位推荐全部采纳为正式决定。

---

## 0. 怎么用这份文件

- **第 1 节**是三个外部事实。它们不是你开会能决定的，但没它们，后面一半的决策都是空转。
- **第 2 节**是六席独立得出的三条一致结论。不需要讨论，直接执行。
- **第 3 节**是两处席位之间的真冲突，只有你能仲裁。
- **第 4 节**是必须今天拍的 13 条，按阻塞顺序排。
- **第 5 节**是可以批量点头的，不用逐条过。
- 答复格式见第 6 节。

---

## 0.5 裁定记录

| 时间 | 裁定人 | 范围 | 结论 |
|---|---|---|---|
| 2026-11-03 | 用户（唯一决策人） | C1、C2、第 4 节 1–13、第 5 节 10 组 | **批量同意，全部按推荐值执行** |

生效细则：

- **C1 = A**：A15 = 审批调度员 + 低风险自动放行。放行主体必须是规则引擎判定，A15 不取得终审权；终审归人类。
- **C2 = A**：不做盘中实时。H5 SLO 中「盘中 as_of ≤60s」正式改为「**收盘后 ≤15min**」，且页面必须显式标注 stale。
- **第 4 节 13 条全部按推荐值成立**，即刻作为开发硬约束，不再逐条复议。
- **第 5 节 10 组全部「直接接受」**。其中 H4-D6 的三个待表态项按 H4 推荐：不复权为主口径、资金流不含大宗、涨跌幅按板块规则。
- **F1**：仍待 H4 于 7 日内取得 tushare 书面授权范围。不阻塞适配层与回补开发；阻塞 C 端行情展示上线。
- **F2**：按「**公司不持有证券投资咨询牌照**」推进（保守假设）。如实际持牌，须重开 H3-Q1。
- **F3**：待外部律师意见。不阻塞开发；阻塞 C 端上线。

> 签字人：用户本人。本文件自此为项目的**单一决策源**，agent 不得以「推荐值」为由自行偏离或扩大解释。

---

## 1. 三个外部事实（先确认，再决策）

| 编号 | 事实 | 当前状态 | 谁负责拿 | 拿不到的后果 |
|---|---|---|---|---|
| **F1** | tushare 是否授予 to-C 商用与再分发权 | **未取得** | H4，7 日内书面回复 | H3 已列为发布否决线：无书面授权不得对 C 端展示行情 |
| **F2** | 公司是否持有证券投资咨询资格 | **未知**（需你确认） | 你本人 | 决定 H3-Q1 走"纯数据工具"还是"持牌合作" |
| **F3** | 40 号文对本产品的定性 | 初步判断，非法定结论 | 外部律师 | 红线清单只是内部判断，不构成抗辩 |

**为什么这三条排最前**：H1-D1、H3-Q4、H3-Q10、H4-D1 四条议题表面上是四个问题，本质是 F1 一个事实的四种问法。F1 不落地，这四条怎么答都会返工。

---

## 2. 六席一致的三条结论（直接执行，不用讨论）

### G1 · 契约先行

H2 把它列为唯一前置：契约不定 → A0 无产出 → A3–A8 六个编码 agent 全部无契约可依。
H3 要求红线清单必须是**机器可读规则文件**（rule_id / 触发条件 / block|warn / 依据条款 / 版本），否则合规只能写进 prompt。
H4 要求契约里带 `source` + `as_of` + 复权口径 + `data_entitlement` 字段。
三者都指向同一件事：**没有契约，另外 19 个 agent 什么也做不了。**

> H2 的量化：今天不定，明天净损失 7 个 agent-day；第 3 天必然出现 3 套并存的字段命名。

### G2 · 适配层现在就要做，这是全项目性价比最高的一笔

三个席位独立算出同一结论：

| 席 | 现在做 | 不做，换源时 |
|---|---|---|
| H2 | 3–4 人日 | 3–4 人周 + 数仓重做 |
| H4 | ≈2.4 万元 | 7.2–14.4 万元 + 3–6 个月停摆 |
| H3 | 保留换源能力 | 无授权即无法上线，且无法快速切换 |

**这不是架构洁癖，是一份 2.4 万元的保险，保的是 3–6 个月停摆。**

### G3 · 数据授权是 P0 的第一个里程碑，不是上线前的检查项

H3 的否决线 + H4 的切换成本，两条合起来：授权不是"最后补个合同"，它是 M0 的一部分。

---

## 3. 两处需要你仲裁的冲突

### C1 · A15 管理员 agent 到底有没有终审权（**已裁定 = A**）

| 来源 | 主张 |
|---|---|
| 你原始设计（m00001） | 「管理员 agent，用于自动化审批」 |
| H6-1 | A15 只做预审/填单/路由/催办，**终审必须是人**；只有规则引擎可判定的低风险单可机器过 |
| README §3 | 硬约束：**agent 永远不能批准 agent** |
| H5-1 | A15 只走审批 API，不直写 rbac；不得自批、不得改自己权限 |

H6 的方案与 README 冲突于你的原始意图。三个选项：

- **A（推荐）**：A15 = 审批调度员 + 低风险自动放行。规则引擎判定为绿的单子机器过，其余路由给人。保住"自动化审批"的效率，不破坏"agent 不批 agent"。
- **B**：按你原设计，A15 有终审权。效率最高，但一次提示词注入就能让 agent 自批闭环——H5 把它列为本项目最大安全风险。
- **C**：撤销 A15，审批全人工。最安全，但你原编制里"自动化审批"的诉求落空。

### C2 · 是否做盘中实时（H4 与 H5 的 SLO 打架）（**已裁定 = A**）

| 来源 | 主张 |
|---|---|
| H4-D3 | ★不做实时，T 日 20:00 收盘数据，增量成本 **0 元** |
| H5-SLO | 「盘中 as_of 落后 ≤60s」 |

二者不能同时成立。**H5 的这条 SLO 是照通用行情产品写的，没考虑 H4 的成本结论。**

- **A（推荐）**：不做实时。H5 的 SLO 改为「收盘后 ≤15min」+ 页面显式标 stale。
- **B**：做实时日线（S2），+2.4 万元/年。
- **C**：全实时（S3），+16.4 万元/年。

---

## 4. 必须今天拍的 13 条（**已全部批准，按推荐**）

> 排序逻辑：上一条不定，下一条就没有输入。

| # | 决策 | 推荐 | 一句话理由 | 不定的代价 |
|---|---|---|---|---|
| **1** | **契约规范** | OpenAPI 3.1 单一真源；`/v1`；字段只增不删；新增必 optional；枚举加值视为破坏；oasdiff 进 CI | 消费者是浏览器 TS 与 LLM tool schema，oasdiff 能机器判定破坏性；proto 在 P0 无内部 RPC，等于维护两套 | A0 停工，6 个 agent 各写 DTO，第 3 天三套命名 |
| **2** | **仓库与 ownership** | 单仓 pnpm workspace，按域分目录，`ownership.yaml` + CI path guard | 一目录一写者，写域可机器执行；拆多仓会让 A0 变成人工同步器 | 晚 3 天各建目录，import 全返工 |
| **3** | **技术栈与形态** | 模块化单体（api + worker 两进程，单 PG/Redis）；在线 TS/Fastify，数据 Python；生产 K8s + Helm | A12 的"真栈"能在 CI 3 分钟起；微服务是单向门 | A13 搭不了 CI，A3 选不了框架 |
| **4** | **数据源适配层** | 六边形端口 + canonical 内部模型 + 20 条 conformance；`instrument_id = EXCH:CODE` | 换源只改 adapters/，3–4 人日 | ODS 固化 tushare schema，换源 = 重做数仓 |
| **5** | **agent 接入与身份** | 三入口一判定点：员工 OIDC / 内部 agent OAuth2 机器身份 + MCP / C 端 tool calling；权限只在 Config Service 服务端强制 | 权限判定只有一个点，越权测试才有意义 | A4 的 RBAC 落不了地，A9 无法做越权测试 |
| **6** | **配置一致性** | version + If-Match 乐观锁，冲突返 409 + 三点 diff；draft/published 双态，publish 生成不可变 release | 乐观锁字段可加，但双态与不可变 release 现在就要定 | A8 做不了 diff，A14 落不了地 |
| **7** | **第一个用户** | 有自选股习惯的散户，「每天 3 分钟看完我的自选股发生了什么」 | 高频、需求明确、不需要牌照也能交付价值 | A7 首页无法定，A0 不知道契约该覆盖哪几个域 |
| **8** | **P0 范围** | 一条竖切片：个股页（行情 + 基本面摘要 + 自选 + as_of + 免责）真栈端到端。**明确不做**：AI 荐股/评级、盯盘推送、开户、社区、付费墙、多市场、中后台四合一、CRM | 先跑通一条，再横向铺 | 契约范围从"个股页"膨胀到全量，评审队列 >5 触发停派 |
| **9** | **北极星 + 护栏** | 北极星 = 周内 ≥3 天查看自选且单次 ≥60s 的用户数；护栏 = 免责展示率 100%、合规漏拦率 0、as_of P95、质量分阈值、单用户 token 上限 | 护栏里必须同时有合规和数据质量，否则出事才补 | A11 门禁、A13 SLO、A2 质量阈值全部拍脑袋 |
| **10** | **tushare 套餐** | 10000 积分 = **1 万元/年**（机构价 = 个人价 ×10） | 含概念板块，板块轮动依赖它；5000 档砍掉板块才够用 | A1 无法申请账号，A2 无法建模 |
| **11** | **回补深度** | **全历史 20 年**：26,000 次调用 / 2 小时 / 1.2 亿行 / 18GB | 边际成本是多 15GB 存储（≈1000 元/年）和多 0.5 人周，不是配额 | 只回 3 年，后面要重洗 |
| **12** | **榜单去留** | 保留，但中性化：标题写口径与截止时间，禁"主力/抢筹/值得关注"，不做个性化推送 | 榜单本身是事实统计，改造后可留 | 首页与栏目结构无法定稿，A14 无法上线 |
| **13** | **A15 权力边界** | 见 C1-A：调度员 + 低风险自动放行 | 保住自动化，不破坏"agent 不批 agent" | A4 权限模型、A8 审批界面全部停在设计稿 |

> **以上 13 条已于 2026-11-03 全部批准（按推荐值）。** 任何 agent 若认为某条在实现层面不可行，走「提案 → Lead → 人类」路径，不得自行改判。

---

## 5. 可以批量点头的（**已全部接受**）

| 来源 | 内容 | 建议 |
|---|---|---|
| **H3 红线清单 R1–R19** | 可做 3 条 / 需改造 9 条 / 禁止 7 条 | 直接接受。R3/R4/R5/R6/R8/R9/R10/R14/R15/R16 是无改造空间的禁止项 |
| **H3 §2.3 执行参数** | AI 首字角标、红线意图 100% 拦截、日常抽检 5%/日且 ≥200 条、IM ≤1/日·≤3/周·≤10/月、留痕 3 年、注销 15 工作日删除、5 分钟接管 | 直接接受，这是不需要拍板就可生效的基线 |
| **H3 §2.4 立法权** | 规则由 H3 起草 → 法务会签 → 发布；A5 只实现、A16 只能提提案、A14/A17 只遵守 | 直接接受 |
| **H5 安全基线 14 条** | 机器身份唯一、凭证 ≤15min、默认拒绝、防互借、双人高危、配置不直写、审计不可篡改、默认脱敏、密钥三不入、认证双签、只走 IaC、可回滚、供应链、模型版本绑定 | 直接接受 |
| **H5 SLO 9 条** | 交易时段 99.9% / 非交易 99.0%、行情 P95 ≤300ms、agent 首 token ≤2s、异常率 ≤1%、接管率 ≤5% | 接受，但 C2 选 A 后要改"盘中 as_of ≤60s"这一条 |
| **H6 配置边界 16 项** | 5 级分类 C0–C4；免责/AI 标识/as_of/退订/风险提示/话术白名单 = **不可配，界面不渲染入口** | 直接接受。这 6 类"改不了"比"能回滚"更强 |
| **H6 审批流 7 类** | T1 常规 / T2 高风险 / T3 文案 / T4 触达 / T5 权限 / T6 紧急回滚（唯一免审批）/ T7 数据导出 | 直接接受 |
| **H6 触达数值** | 单日 ≤1、单周 ≤2、单月 ≤6；9:00–20:00；同素材 7 天不重复 | 接受，与 H3 的 1/日·3/周·10/月 兼容（取更严） |
| **H4 D6 指标口径 8 条** | 不复权为主口径、后复权算收益/前复权仅画图、资金流不含大宗、涨跌停按板块分规则、财务保留"原始+调整"两套 | 接受，其中三个必须你表态：前复权还是后复权、资金流是否含大宗、涨跌幅基准 |
| **H4 D7/D8/D9** | 新鲜度 T 日 19:00；质量分 ≥95 绿 /90–95 黄 /85–90 红/<85 黑；golden 500 条含 150 条边界 | 接受 |
| **H2 D8 冻结清单** | 冻结语言/框架大版本/DB/部署形态/契约工具链/身份模型；新增外部依赖须 ADR | 接受 |

---

## 6. 答复格式（**已按此格式答复完毕**）

最简单的方式：**只回第 4 节的 13 个编号 + 第 3 节两个字母**。

```
C1=A  C2=A
1=按推荐 2=按推荐 3=按推荐 4=按推荐 5=按推荐 6=按推荐
7=按推荐 8=按推荐 9=按推荐 10=按推荐 11=按推荐 12=按推荐 13=按推荐
F1=待询价  F2=无牌照  F3=待律师意见
```

有条件的写法：`4=A，但 status 枚举由 H4 补`。

未回答的一律记「待定」，对应 agent 不派发任务——**六个席位都已明确表示不拿推荐值当默认值推进。**

---

## 7. 席位原始议程索引

| 席 | 议题数 | 特色产出 |
|---|---|---|
| H1 | 9 | 里程碑 M0–M4 与验收人、WIP ≤3 |
| H2 | 8 + D1 三小节 | 契约破坏性变更声明模板、目录骨架、端口定义、20 条 conformance |
| H3 | 10 + 19 红线 + 8 删减 | 红线清单 v0、定位可说/不可说、立法权边界 |
| H4 | 9 + 3 张核算表 | 套餐预算 S0–S3、回补核算、三条退路切换成本 |
| H5 | 10 + 14 基线 + 9 SLO | 安全基线、SLO、runbook 覆盖 7 类 |
| H6 | 10 + 16 边界 + 7 流程 | 配置五级分类、审批流、七道闸防误配 |

---

## 8. 下一步（拿到答复后）

1. 写 `agents/decisions.md` 定稿版，逐条标注「已决/待定」与签字人。
2. H2 出 ADR-001（契约规范）与目录骨架，A0 出 P0 五域契约骨架。
3. A13 搭 CI 骨架；A1 写适配层端口；A2 建 ODS。
4. A11/A12 补门禁与 E2E fixture。
5. A3/A7 做竖切片，M2 验收。
6. 通过后再启动 A4/A5/A6/A8/A14/A15/A16/A17/A19。

---

## 9. 工程裁定记录（Lead 代行，标「待会签」的需人类追认）

> 席位议程之外的实现层裁定。Lead 有权直接定，但必须留痕；涉及合规、口径、授权的除外。

| # | 日期 | 裁定 | 性质 |
|---|---|---|---|
| **L1** | 2026-11-04 | tushare 原生标识禁止的**豁免范围**（实际路径已更正）：`services/ingest/src/market_ingest/adapters/tushare/**`、`warehouse/ods/` 的 raw 列、`tests/fixtures/tushare/**` 与 `tests/e2e/tushare-replay/recordings/**`。**执行方式见 L14** | 已生效 |
| **L2** | 2026-11-04 | P0 不建常驻调度。`worker` = one-shot seed job（ingest-once），调度循环推迟到 P1。决策 #3 的「api + worker 两进程」描述形态，不要求 P0 跑轮询 | 已生效 |
| **L3** | 2026-11-04 | 复权因子归一：`adj_factor.v1 = 原始因子 / 锚因子`，锚 = 该标的**最早可得因子日**；1990-12-19 前上市的老股锚定 1990-12-19 并在文档标注。M02 收益在两种锚下等价，但 hfq 绝对价不同 —— 因此这是**口径变更，需 H4 签字** | **待 H4 会签** |
| **L4** | 2026-11-04 | 回补切块按**行数**（单页 6000 行 ≈ 24 年）而非按天。按天切（chunk_days=366）会得到 21 块/标的 × 5000 ≈ 10.5 万次调用，超 #11 的 2.6 万上限；按行切每标的 daily + adj_factor 各 1 页 ≈ 2 次，全量约 1 万次 | 已生效，待 A1 出预算表核对 |
| **L5** | 2026-11-04 | `adj_factors` 作为端口**一等方法**（非可选）。理由：STRUCT-06「每根 bar 必须有因子」是硬校验，可选方法必然漂移成两套实现。ADR-002 升 v1.1 | 已生效，A0 执行 |
| **L6** | 2026-11-04 | ownership 补 5 个目录：`services/api`→A0、`packages/api-client`→A0、`.github/workflows`→A13、`docs/runbook`→A13、`warehouse/quality`→A2 | **H2 会签（2026-11-04，附条件 a/b/c）**——见下方「L6 落地条件」 |
| **L7** | 2026-11-04 | ODS 的 bar 行**必填 `prev_close`**（tushare daily 原生 `pre_close`，首日可空）。理由：M08/BIZ-01 是已批准口径，缺它则涨跌幅只能降 warn，除权日误判测不出 | 已生效，A1 执行 |
| **L8** | 2026-11-04 | 停牌日**保留证据行**（`suspended:true`），不采用「停牌=无行」。证据行由 `suspend_d` 按交易日批量取（1 次调用/交易日，约 4,860 次/20 年），从而 COMP-03 不必降级。若 A1 证明成本不可接受，再走 H4 降级流程 | 已生效，A1 执行 |
| **L9** | 2026-11-04 | 质量分只由 blocker 计分：每类别得分 = 1 − 该类 blocker 命中数 / 该类规则数；`warn` 不计入分子分母，仅作展示与趋势。「违规数」与「质量分」是两个独立指标，不得混用 | 已生效，**待 H4 会签** |
| **L10** | 2026-11-04 | 契约未引用的 shared 组件（`ProblemResponse`/`Forbidden`/`EntitlementRestricted`）必须**被引用而非删除**：行情三接口补 403 声明后自然消化 | ✅ 已由 A0 完成 |
| **L11** | 2026-11-04 | 增量抽取改为**按交易日、全市场**（`daily`/`adj_factor` 均支持 `trade_date`，单页覆盖全市场），逐标的拉取降为兜底。理由：①调用量 3 次/日 vs 10,001 次/日，失败面小三个数量级；②checkpoint 对齐 `trade_date`，续跑只需记「哪天完成」；③tushare 修正按日整批下发，批次边界与上游一致。**注意**：不以配额为理由——按积分档表 5000 分以上常规接口无日上限（10 万次/天是 2000 分档约束），该口径待 H4 复核 | 已生效，A1 执行 |
| **L12** | 2026-11-04 | `DataSourcePort` 签名**不变**（instrument 粒度读接口）；市场级批量抽取作为 adapter 能力新增 `fetch_market_snapshot(trade_date)`，**不进端口**。ingest 只产出 ODS 行（不复权价 + `volume` 股 + `amount` 元 + `prev_close` + 已归一因子），**禁止输出复权价**；复权一律在读侧/DWD 计算 | 已生效，A1/A2 执行 |
| **L13** | 2026-11-04 | `NOT_FOUND` 作为**第 8 个冻结错误码**接受（shared 0.1.2），不追 H2 书面签：additive、未改任何既有码义、未收窄枚举、403 先于 404 不变。**边界**：删码 / 改码义 / 合并码 → 破坏性变更，必须 H2 签字 | 已生效 |
| **L14** | 2026-11-04 | C01 守卫由「黑名单豁免」改为**数据承载面正向清单**（ADR-002 D2a）：只有点名的面允许出现 tushare 标识，其余默认拒绝；新增豁免须 Lead/H2 签字。理由：黑名单漏一处即静默放行，正向清单漏一处是误报（安全侧） | 已生效，A0 定稿 |
| **L15** | 2026-11-04 | 迁移执行归 **A13**：A3 交 `services/market/migrations/*.sql` + 幂等 runner，A13 在发布流水线/bootstrap 执行；`E2E_MODE` 下才允许自动 `CREATE TABLE`；**A0 不碰迁移脚本** | 已生效 |
| **L16** | 2026-11-04 | E2E-P0-07 定为**补数据而非改断言**：A1 为切片 3–5 个标的落最小 `fina_indicator` 批次；未导入标的返 404 `NOT_FOUND`（存在但无数据），禁止空对象或 0 冒充。A11 断言拆两条：切片标的 200 且有报告期 / 未导入标的 404 | 已生效，A1/A11 执行 |
| **L17** | 2026-11-04 | **撤销**「instrument.v1 不进 S0」：主数据进 S0 **最小集**（一次 `stock_basic` 调用取全量在册：instrument_id/exchange/code/name/board/security_type/list_status/lot_size/listed_at）。原因：个股页要显示名称与板块、BIZ-01 涨跌停按板块、首日豁免需要 `listed_at`，缺它 A2 已 fail-closed 退出码 2，真实 ODS 链路无法验收 | 已生效，A1 执行 |

### 已知缺陷台账（A11 维护）

契约测试不放行红灯，但允许登记带到期日的债务，过期自动转红：

| ID | 到期 | 内容 | owner | 状态 |
|---|---|---|---|---|
| KD-001 | 2026-11-18 | shared: `components.responses.ProblemResponse` 未在四域中统一引用 | A0 | ✅ 已清（四域补 `default`） |
| KD-002 | 2026-11-18 | shared: `components.responses.Forbidden` 同上 | A0 | ✅ 已清（watchlist 3 个 operation） |
| KD-003 | 2026-11-18 | shared: `components.responses.EntitlementRestricted` 同上 | A0 | ✅ 已清（quote/bars/fundamental-summary） |

### L18–L22 安全默认值与白名单（2026-11-04，H5-R4 落定）

| # | 日期 | 裁定 | 性质 |
|---|---|---|---|
| **L18** | 2026-11-04 | **三处 fail-open 默认值全部改掉**（P0 发布卡点）：①`services/market/src/config.ts:66` tier 缺省 `c_end_display` → **`internal_eval`**（未配置=最小授权，不是最大授权）；②`tier != internal_eval` 且缺 `ENTITLEMENT_EXPIRES_AT` → **拒绝启动**，不是「时间盒不启用」；③响应 `meta.tier` 用 **effective tier**；④Helm `values.yaml` 与 E2E compose 必须显式注入两个 key，且默认值与代码默认值一致——两处默认值不一致等于配置系统有洞 | 已生效，A3/A13 执行 |
| **L19** | 2026-11-04 | 变量名定稿 **`ENTITLEMENT_EXPIRES_AT`**，不采纳 H4 的 `ENTITLEMENT_VALID_UNTIL`。理由：实现已存在且被单测覆盖的一方保留命名权，改名只会制造两套语义 | 已生效，H4/H5 遵循 |
| **L20** | 2026-11-04 | **未留痕的 tier 变更按「未授权」处理，立即 fail-closed 回 `internal_eval`**——不只告警。机制：启动时无条件写 `tier_state_observed`，A13 部署流水线写 `deploy` 事件，两者对不上即回退；部署事件分**执行者/审批者**两字段；回灌后原始 JSONL **不得删除**（≥3 年），否则回灌成了删除原始记录的借口 | 已生效，A3/A13/A5 执行 |
| **L21** | 2026-11-04 | `(c)` 档白名单定稿 **7 类**：`instrument_id`/`name`/`exchange`/`board`/`security_type`/`list_status`/`listed_at`。`security_type` 属交易所规则分类事实（是白名单疏漏，补入）；**`lot_size` 不在白名单**，走 D5 从契约删除（P0 无消费方，且「最小申报数量 ≠ 交易单位倍数」会误导）。运行时兜底：响应出现白名单外字段 → 抛 `ServingDataError`（500），**不静默丢弃** | 已生效，A3 完成；`lot_size` 删字段待 H2 |
| **L22** | 2026-11-04 | 免责文案允许用**占位**至 E2E 通过，但要：①README 明写「占位，非 A5 正式 rule_version」；②加一条单测断言「当前为占位」，A5 上线后该测试转红以提醒替换。所有用户可见字符串统一收进 `copy.ts` + 不可配 `COPY_VERSION` + 构建期 hash↔版本校验 + 每版本文本快照存档 | 已生效，A3/A7 执行 |

### L23 H5-R5 分阶段落地（2026-11-04）

H5 的 control 表 + reconciler 设计**接受**，但**分两阶段**，理由写在裁定里。

| 阶段 | 范围 | 交付方 |
|---|---|---|
| **P0** | ①`audit.entitlement_control` 表 schema + 三个独立 PG role（CI 写 deploy / pod 写 observed / reconciler 写 hold，INSERT-only + 各自最小权限）②服务**启动时**读 control：命中 hold 或 `last_reconciled_at` 失效 → `internal_eval` ③启动时**无条件**写 `tier_state_observed` 事件 ④`expires_at` 本地硬判定在最前 | A13（表/角色）+ A3（判定顺序与 boot observe） |
| **P1** | reconciler CronJob + 心跳告警 + SLO 登记 + 15min 失效窗口 | A13 |

**裁定理由**：reconciler 的失效模式是"它自己挂了 → 15 分钟后 C 端全部 403"。这是一个**必须在真实集群上验证过**才能上线的组件；而当前仓没有 git remote、没有集群、没有 docker，它一次都不会真跑。**没跑过的 fail-closed 组件不是安全网，是"看起来安全"**——真出事时它会把一次部署事故放大成一次全站不可用。

P0 阶段 boot 期判定 + 无条件 observed 事件已经覆盖了主路径（"改 env 静默发授权"），先落这个；reconciler 等有真实环境时再上，届时用 15min 窗口做演练而不是首次上线。

**幂等键定稿**：`deploy` 用 `deployment_uid`（不用 `release_id`，回滚要可倒查）；`tier_switch` 用 `(event_type, boot_id, state_version)`——**不用 content hash**，A→B→A 的合法抖动会被误杀。
**hold 只能人工清**：清 hold = 扩大授权边界 = T2 + H5 工单签字，A13 执行；reconciler 与 agent 均不得自动清。hold 的 set/clear 本身也写 `entitlement_events`。

### L24 P0 风险 R-1 与审计事件归属（2026-11-04）

**R-1（P0 收尾前插入，1.5 人日，A3 1.0 + A13 0.5）**：三处 fail-open 叠加导致「今天按 Helm 部署 = C 端展示行情」。已由 L18 反转默认值；本条只做**排期与责任人**登记，由 **H1** 放进 P0 收尾清单，不挂在 task-2 名下。

**审计事件 schema 归属：A5（不是 A2）。** 此前派单时口误说过 A2，现更正并作废：审计事件属合规域，A5 出 DDL；A13 迁移与权限；A3 只 INSERT；A2 与本案无关，**不存在双头**。

**对账窗口的两个数字不冲突，分开定**：
- `reconciler` **运行间隔 2 分钟**（H4）——决定"多久发现一次不一致"；
- `last_reconciled_at` **陈旧阈值 15 分钟**（H5）——决定"多久没对账就 fail-closed"。

理由：间隔要短才有意义，阈值要长才不会因为一次抖动把全站打成 403（15min ≈ 连丢 7 次）。**把这两个数合成一个，要么太脆，要么太迟钝。**

### L25 零窗口 known limitation 与审计表 ACL 澄清（2026-11-04，H3 判定）

**Known limitation（记入，不当作已解决）**：11-12 前做不到"改 env 与对账之间的零窗口"。现状是启动自检指纹不符立即降档，双改 env 靠 reconciler ≤2 分钟关窗。
H3 判定：**现在可过，因为 C 端不渲染，窗口无对外后果；go-live 前不可过。**
⇒ **go-live 门禁**：C 端首次展示真实行情之前，必须换成签名配置 / Config Service；否则 H3 不放行。

**两条硬口径**：
1. `ENTITLEMENT_CONFIG_EXPECTED_SHA256` 必须由流水线从**审批记录**派生，不可手改——否则"双改"是同一个人一个动作的两半。
2. **授权证据是 source of truth**：没有对应审批事件的 tier 提权，事后一律判"未授权"并追责；配置只是载体。

**审计表 ACL 澄清（回答 H3 的缺口）**：**"INSERT-only" 是应用写入路径的属性，不是表的全局 ACL。** 应用对 `entitlement_events` 只有 INSERT；reconciler 是**独立主体**，有 SELECT 与 control 表 UPDATE。角色共四个：
`ci_deploy_writer`（INSERT deploy）/ `svc_observed_writer`（INSERT observed + SELECT control）/ `reconciler`（INSERT hold + UPDATE control + SELECT events）/ `audit_reader`（SELECT，给对账与法务取证）。

**告警口径**：必须**到人 + 绑 runbook**；15 分钟无人确认 → 自动降 `internal_eval` 并阻断发布。**只进 IM 消息流不算机制**（没人认领的告警等于没有告警）。自动降档随 reconciler 在 P1 落地；P0 阶段靠人工确认。

### L26 零延迟归属与 403 窗口的对外解释红线（2026-11-04，H3 判定）

1. **零延迟是 go-live 前置条件，不是 11-12 的交付物。** 11-12 交的是"启动自检立即降档 + reconciler ≤2 分钟关窗 + 15 分钟陈旧阈值"这套 fail-closed 机制，H3 已判可通过。**不要为了让 11-12 的验收单显得干净而把 go-live 门禁提前**——那会拖垮其他 P0，且换不来任何真实风险下降（11-12 前 C 端根本不渲染）。
2. **2 分钟 / 15 分钟窗口记为 known limitation**，触发条件、责任人与失效模式已明确（见 L25）。known limitation 的正确待遇是"写下来、有触发条件、有人负责"，不是"当它不存在"。
3. **hold 的职责分离**：清 hold 的签字人 **≠** 发起变更/部署的人；agent 既不能清也不能代签。
4. **对外解释红线**：15 分钟静默 fail-closed 窗口内 C 端全 403 时，**任何人（含 A17 拓客、客服）不得临场解释为"授权问题/供应商问题/第三方故障"**——这类解释会把供应商关系从我方嘴里漏出去，同时把一个内部机制问题说成外部事故。对外文案只能来自 `copy.ts` 的中性版本，H3 抽查。

### L27 control 表读失败的处置（2026-11-04，H4 判定）

**不一刀切，按错误类型分两类：**

| 类型 | 例子 | 处置 |
|---|---|---|
| **确定性配置错误** | 表不存在 `42P01`、权限不足 `42501`、schema 不匹配 | **启动直接失败（crashloop）**。这是部署错误，crashloop 比"静默跑一个永远 403 的服务"显眼，且能让发布门禁拦住 |
| **瞬态故障** | 连接断、超时、PG 不可用 | **不 crash**，进 `degraded_unauthorized`：effective=`internal_eval`；行情/财务 403；**基础信息与合规文案照常**（不依赖授权）；`/healthz` 报 degraded；告警；30s 重试；恢复且 control 新鲜、无 hold → 回 env tier，**恢复本身也写事件** |

**理由（H4 原话）**：DB 读不到时行情数据本来也取不到，"怕页面全空"不构成放开授权的理由——**那是拿授权换可用性，不换**。而且 fail-closed 只影响需要授权的行情/财务域，不是全站空。

**对账读权限**：`market_app` 是 INSERT-only；reconciler 用**独立只读账号**（只 SELECT 视图）。"INSERT-only"限定的是应用角色，不是所有角色——与 L25 一致，四个角色。

### L28 go-live 可判定化与 approval_ref 可信度（2026-11-04，H3 判定）

1. **go-live 触发点可判定化（H3 于同日更正，以此版为准）**：
   - **不引入第二个"渲染开关"**；唯一真相源 = `effective_tier`。前端不得有 env/flag 自行放行，**出现即按未授权处理**。
   - go-live 触发点 = **把 `effective_tier` 翻成 `c_end_display` 的那次部署**，以 `tier_switch` 事件 + `approval_ref` 作门禁审计记录。
   - `meta.entitlement.is_entitled` 必须由 `effective_tier` **现算**，不得独立存储（否则又造一个真相源）。
   - **门禁是三方**：该次部署需 H4 + H5 签字，且需 H3 在零延迟验收通过后出书面放行；**缺 H3 同样按未授权处理、事后追责**。
   - 验收加攻击用例：A19 尝试从前端绕过 403 自行放行渲染，必须失败。

   理由：靠人判断"算不算正式上线"，门禁一定会被绕；而**再加一个开关就是再加一个真相源**——两个真相源打架时，赢的总是宽松的那个。
2. **`approval_ref` 必须是 A15 审批事件主键**：append-only、与签字人绑定；CI **只读、不得自填自造**；doc 级校验 tier 一致，**不得复用、不得跨环境复用**。
   理由：`H(approval_ref|tier|expires_at)` 是**流程控制，不是密码学控制**——它的强度全压在 `approval_ref` 是否可信上；如果 CI 能自己造一个 ref，那这套签名等于自己给自己开证明。
3. **reconciler 只读账号**：SELECT 仅限两个视图，不带副本/导出权限；账号与授权记录留痕。

### L29 H5-R6 角色与告警闭环（2026-11-04）

1. **角色分工落定**：reconciler 只读账号 = `SELECT` 两视图 + `EXECUTE audit.raise_hold`（SECURITY DEFINER，只能置位）；**清 hold 走 `audit.clear_hold`，只授人工 `hold_clear` 角色**；`market_app` 仍 INSERT-only；`deploy` 由 CI 写。
2. **哈希链并发**：三个写入者（服务 / CI / reconciler）→ 触发器内用 `pg_advisory_xact_lock` 串行化，否则链会分叉。计入 A13 的 0.3 人日，不加预算。
3. **读异常分级**（细化 L27）：确定性错误（表/权限/schema 版本）→ 启动失败，且**错误文案要能区分"迁移没跑"与"权限不足"**；瞬态 → 先 60 秒有限重试，仍失败再进 `degraded_unauthorized`（`internal_eval` + 行情 403 + 30s 重试 + 告警），不 crash。
4. **告警闭环**：到值班手机/寻呼（**IM 不算**）；15 分钟未确认 → 自动降 `internal_eval` + 阻断发布；**该自动升级路径必须有 staging 演练证据，无演练 H5 不签**；runbook 与值班表要有具名 owner。
5. **go-live 门禁**：C 端首次展示真实行情前切签名配置 / Config Service 消掉检测窗口，**release-blocking，不影响 11-12**。
6. **预算锁定 1.5 人日**（1.0 + H4 加 0.5），H5 不再加码；超预算须单列变更。

### L30 display_safe 落在 dim_instrument（2026-11-04）

**问题**：A1 把渠道与 `display_safe` 记在导入 manifest，但 ODS 行里没有这两个字段，A2 的质量门禁与 serving 无法据此拒绝"经 tushare 取得的基础信息"进入展示态。

**裁定**：**不改 ODS 行格式**，把 `display_safe` 落到 `dim_instrument`（load 时从 manifest 派生），serving 视图透出该列。展示判定 = `entitlement_ok AND display_safe`。

理由：ODS 是**数据形态**，渠道是**来源属性**——把来源塞进每一行，等于让所有下游都承担它；而 `dim_instrument` 本来就是"标的的属性表"，`display_safe` 正是标的属性。改一个维度表比改全部 ODS 行便宜得多，且不会让 A1/A2 的既有回归重跑一遍。
**注意**：`display_safe=false` 的标的不进 C 端 serving 结果集，但**仍可在内部评测态用于交叉校验**——否则我们连"这条数据对不对"都无法自证。

### L31 审计表两处结构约束（2026-11-04，H4）

1. `hold_clear` 事件必须带 `hold_ticket` + `hold_signer`，且 **`hold_signer` ≠ 发起变更/部署的人**。职责分离只限"人"不够，要限"同一个人"——同一个 agent 换个身份签两次，等于没分离。
2. `entitlement_control` 迁移时 **seed 单行 `(1,false,now())`**；运行时读不到行 = 配置错误，按 fail-closed 处理并告警（不是"默认无 hold"）。

### L32 录播 fixture 必须是合成数据，不得录制真实 tushare 报文（2026-11-04）

**现状**：A12 的 `recordings/` 为 0 条，P0-10 记 `BLOCKED(no recordings)`；A12 建议用 `record-fixtures.sh` + 真实 token 录一遍。

**裁定：不录真实报文。** fixture 用**合成数据**生成，字段名与结构按 tushare 公开文档的 schema 镜像，值全部伪造。

理由（三条，任一条都够）：
1. **F1 条款是"个人、非商业、仅个人查看"**。把真实报文落进公司仓库，等于把上游数据**再分发**给团队内部——这已经不是"个人查看"，是我们自己先违约，然后才谈 C 端授权。
2. **录播数据是衍生数据**，它同样受上游条款约束；"我们只是测试用"不是抗辩理由。
3. **真正要测的不是数值，是形状与异常路径**——字段缺失、`429`、部分失败、乱序、重复、历史修正。这些用合成数据能 100% 覆盖，用真实数据反而覆盖不全（真实数据很少给你一条 `429`）。

**要求**：合成 fixture 必须能被一眼认出是假的（如 `SYNTHETIC-` 前缀或明显不合理的价格），防止有人把 fixture 当真实数据拿去验证业务结论。`record-fixtures.sh` 保留但**默认禁用**，需 H4 书面批准才可对非生产用途运行。

### L33 低频事件的复核与内部原因码（2026-11-04，H3）

1. **`hold_clear` 全量复核**：每次 clear 后 24h 内 100% 复核（复核人 ≠ 签字人），设季度基线；异常上升触发 H3 单独审查。低频事件全量复核比抽检便宜且更强。
2. **对外统一文案 ≠ 内部不区分**：服务端必须保留 `expired` / `hold` / `stale` / `unauthorized` 四个原因码并写事件，**响应体只出同一份中性文案**。否则事后查不出是"到期"还是"有人改 env 被拦下"。
3. fail-closed 断言补一条：DOM 中也不得出现数值占位（`0` / `--` / 骨架屏）——占位符同样在暗示"这里本该有价格"。

### L34 展示态与内部态分 ODS root（2026-11-04，细化 L30）

**裁定：选 (a) 分 root，不改 ODS 行格式；`display_safe` 由 root 派生。**

- `ODS_DISPLAY_ROOT`：只接收 `csv` / `official_api` 渠道批次（A1 保证一次调用只产一个 channel 的批次）；
- `ODS_INTERNAL_ROOT`：tushare 交叉校验批次；
- `warehouse.load` 接收两个 root，按来源 root 给 `dim_instrument.display_safe` 赋值；serving 透出；C 端结果集 = `entitlement_ok AND display_safe`。

**为什么不是 (b) ODS v1.1 加 channel 列**：渠道是**批次级属性，不是行级属性**——同一批里所有行渠道相同。把它写进每一行，等于让 5000 万行重复同一个值，还要让每个消费者都读一遍；而 root 天然是批次级边界，物理隔离比字段标记更难被绕过（**想混进去就得写进错的目录，而不是忘了填一个字段**）。

**代价**：部署多一个 root 路径。这个代价应该付。

### L35 单一真相源的缓存旁路与 approval_ref 可验证性（2026-11-04，H5-R7）

1. **403 必须 `Cache-Control: no-store`**（含 CDN/ingress）；SW/PWA 不缓存行情与 entitlement 响应；**SSR 不把数值烤进 HTML**；A11 断言含"403 不被复用"。
   理由：封前端 flag 只封住了"主动放行"，**缓存是"被动放行"**——一次 200 被 CDN 缓存，后面所有 403 都白做。
2. **`approval_ref` 必须可解析到审批账本的具名记录**，自由字符串不算（等于给 agent 留编造空间）；节点设计归 H6，"门禁只认可验证引用"归 H5。
3. H5 签字前必备四件：runbook 落盘、值班表具名、寻呼链路**实测到人**、staging 中 15 分钟未确认自动 `internal_eval` 的**演练记录**。缺一不签 11-12。
4. H4 的 5 条断言须贴原文，H5 按同一清单签字——**不认口头"全绿"**。

### L36 11-12 release job 的 7 条验收与三方门禁（2026-11-04，H4）

**翻 `c_end_display` 的部署是三方门禁**：**H4 + H5 + H3**。H3 须在零延迟验收通过后出**书面放行**；缺 H3 放行按未授权处理、事后追责。（补进 L24/L28 的门禁条目，三份文件口径统一。）

**8 条验收清单**（H5-R8 加第 8 条；挂进 11-12 的 release job，**不阻塞日常 CI**）：
1. 到期 fail-closed
2. 启动拒绝（配置非法/缺失即不启动）
3. `(c)` 白名单（白名单外字段默认拒绝）
4. hold / stale 生效且 **403 不可被复用**
5. 渲染无占位（`0`/`--`/骨架屏均不得出现）且对外文案一致
6. 事件可回指条款原文与规则版本，且幂等
7. 前端不存在可绕过的开关
8. **裸启动**：不设任何 `ENTITLEMENT_*` 环境变量启动 → 正常起、全部行情接口 403、`meta.tier=internal_eval`（第 1/2 条都走显式 env 路径，**默认值反转本身没有断言**——改回 `c_end_display` 也能绿着过）

第 4 条收紧：**凡响应含 `meta.entitlement` 的（含 getInstrument 的 200）一律 `Cache-Control: no-store`**，不只 403。只防 403 被缓存不够——CDN 缓存了"到期前的 200"，到期后会继续 200，且没有任何一次 403 可被抓到。
第 6 条补：事件抽样必须含 **hold set/clear 与 deploy（`deployment_uid`）**，否则最敏感的人工清 hold 动作不在链上。

**发布门禁是两桶**：`entitlement`（7+1 条）+ `限流`（第 61 次 429、`Retry-After` 整数 ≥1s、problem+json、伪造 XFF 不换桶、文案不露内部码）。H5 按两桶签字，缺一不签。

配套：A19 攻击用例「从前端绕过 403 自行放行渲染」，**必须失败**——属"测"不属"新机制"。
H5 签字前四件证据（runbook 落盘、值班表具名、寻呼实测到人、staging 中 15min 未确认自动 `internal_eval` 的演练记录）由 **A13 出、H5 验收**。

**进度记法纠偏**：A1 报的三项完成中，**第三项"条款评估"仍等 H4 的 11-12 结论，不得记闭环**。

### L37 自检默认必须是"开"，不是"跳过"（2026-11-04，H3 发现）

A3 在 `services/market/src/config.ts` 的两处 fail-open：

1. `:36` 注释写「F1 未落地默认 `c_end_display`」，而 `:68-70` 代码默认 `internal_eval`——**注释与代码相反**。后来者会照注释"修正"回去。注释必须与代码一致，且要写明为什么默认是拒绝。
2. `:58-59` 的 `ENTITLEMENT_CONFIG_EXPECTED_SHA256` **缺省时跳过自检**——等于自检默认关闭。

**裁定**：`tier != internal_eval` 且 `ENTITLEMENT_CONFIG_EXPECTED_SHA256` 缺失 → **拒绝启动**（与 L18 的"缺到期时间即拒启"同一条逻辑：没有审批指纹就没有授权）。`internal_eval` 不要求指纹。

理由：**"没配置就跳过检查"是所有 fail-open 里最隐蔽的一种**——它不改变任何默认值，只是让检查不发生；而检查不发生，在日志里和检查通过长得一模一样。

同时接受 H3 对 A0 文案门禁的 6 条条件（清单不得写"DONE（待…）"、快照禁止同日覆盖破坏 append-only、出口判据必须含**生产 sourcemap**（`services/market/src/errors.ts:8` 注释里的「（F1）」会随 sourcemap 下发）、DOM 生产值须单一、403 必须先于 404 且有测试证据）。404 措辞沿用「资源不存在」，不单独给"路由不存在"——对外统一，成因只进事件日志。

### L38 11-12 验收的四个缺口裁定（2026-11-04）

1. **`no-store` 归外壳（A0）**，不归域插件。做法：`services/api` 对 **所有 `/v1/*` 响应**统一加 `Cache-Control: no-store`（`onSend` 钩子），而不是"判断有没有 `meta.entitlement` 再加"。理由：**按内容判断等于给每个新接口埋一次漏配的机会**；行情类接口本来就不该被缓存——数据带 `as_of`，缓存一次就是一次静默的陈旧。断言改为"扫描全部 `/v1/*`，无一例外"。
2. **reason 与 cause 拆成两个字段**（回答 L24 后的 DDL 缺口）：
   - `reason` = 授权状态**为何变更**：`expired | manual_signoff | valid_until_set | clause_change`
   - `cause` = 本次请求**为何被拒**：`expired | hold_active | hold_stale | unauthorized_config | control_unreachable | tier_internal_eval`
   理由：一个回答"谁按了什么"，一个回答"这一次为什么不行"。合成一个枚举，两边都会被污染，且事后无法区分"到期"与"有人改 env 被拦下"。
3. **限流归外壳（A0）**：`services/api` 的 `preHandler` 中间件（唯一判定点），Redis 共享计数，Redis 不可用时每副本降级 30/min、**绝不 unlimited**；A13 在 compose/Helm 提供 Redis；A11 断言 4 条。
4. **release job 归 A13**：按 `tests/contract/CI_MOUNT.md §7.1/§7.2` 顺序挂 6 组命令（expired/unset/bare-start、whitelist、copy、hold stale/unreachable、events、rate-limit），真栈 8081 + `A11_AUDIT_DSN`（迁移用高权限 DSN，应用角色只有 INSERT）。


#### L6 落地条件（H2 会签，2026-11-04）

H2 拒绝把这条定性为「机械补全」：其中 roster 收窄是**实质治理变更**。实际状态：前四条已登记，`warehouse/quality/` **无显式条目**，被 `warehouse/`（A2/H4 前缀）覆盖，功能等价。

- **a.** `warehouse/quality/` 显式登记，**或**把 L6 措辞改成「已由 `warehouse/` 覆盖」。二选一，不许两边写法并存——default-deny 下显式条目就是审计面。
- **b.** 收窄 A0 的 `write_scope`：原 `["contracts/","docs/"]` 中 `docs/` 过宽，会诱导越界写 `docs/runbook`（A13）、`docs/metrics`（A2）——path-guard 只读 `ownership.yaml`，所以 CI 不会红，但 agent 会照 roster 越界写，这正是本条要堵的口子。**已改为 `["contracts/","docs/adr/","docs/release/","services/api/","packages/api-client/"]`，`forbidden` 增 `docs/runbook/`、`docs/metrics/`。**
- **c.** A13 补 `.github/workflows/`、`docs/runbook/`；删 `reserved_paths` 里 `quality/`(A2) 与 `ops/runbooks/`(A13) 两个**幽灵路径**（与 `warehouse/quality`、`docs/runbook` 双份登记，P2 激活时会再建一份）。
- A2 的 roster 不改（`warehouse/` 已覆盖）。**会签以落地为准**：`ownership.yaml` 与 `roster.yaml` 一致 + 本条标注，改完 diff 交 H2 过目。
- **d.（H2 追加，L6 关闭条件）把一致性做成 CI 不变式**：`infra/ci/path-guard.mjs --validate-registry` 扩成同时读 `roster.yaml`，两条不变式——①roster 里每个 agent 的 `write_scope` 前缀必须能在 `ownership.yaml` 找到 **owner 相同**的条目覆盖（无覆盖即红）；②roster 的 `forbidden` 与 `ownership.yaml` 的 owner 不得指向同一路径（自相矛盾即红）。A13 实现，CI 必跑。
  理由（H2 原话）：**没有这条检查，b 修完下一次还会漂，而漂的那次不会有人发现。** 这次的问题不是"某个文件写错了"，是"两个治理文件互相不一致，而且没有任何东西检查它们一致"——修一次只能挡住一次。

#### L6-附：`lot_size` 删除的签字条件（H2，2026-11-04）

按破坏性变更走四件：`tests/contract/waivers.yaml` 登记（`approved_by` 以 H2 开头、引 ADR-001 D5、`expires_at` 2026-12-15、finding 用 oasdiff 实出）／不动 `baselines/v1` 与 manifest／版本按 **0.2.0→0.3.0**（A0 说的 0.2.1 不成立，他把 shared 的版本串了）／oasdiff 只允许这一条 breaking。

内部端口 `warehouse/serving/ports.yaml:68` 不跟删，**P1 单独签**（与 H2 原话一致，此前误记为 P2）。风险面已确认：`services/market` 的 `build.ts` 白名单在 HTTP 边界 default-deny 拦掉 `lot_size`（`market-plugin.test.ts:714` 有断言），所以这是**契约卫生，非行为变更**。

**流程真实操作面**：仓无 git remote，`h2-approved` label 没有承载物——签字落 `waivers.yaml` 的 `approved_by: H2` + 本条会签，**不得把「H2 加了 label」写进流程**。

### L39 审计证据的三个前提（2026-11-04，H4/H3 会签中发现）

**一、能写 ≠ 能举证。** worker 是 `readOnlyRootFilesystem: true` + 只有 `/tmp` emptyDir、无 PVC——生产写的 manifest **重启就没了**。H4 原话：这比没有更坏，因为清单上会有一个「已完成」而证据已经蒸发。要求：A13 给 worker 挂 PVC 到 `/data`；A1 加启动校验（root 落在容器 rootfs 上即拒绝启动）；release job 加一条「重启后 manifest 仍在」的冒烟。**没有那条冒烟，等于写了没验。**

**二、阻断批不得带可展示产物。** blocked 批标 `display_safe: true` 是错的——`display_safe` 只能由状态派生，不能手填。display root 的批次必须恰好 7 字段（`instrument_id`/`name`/`exchange`/`board`/`security_type`/`list_status`/`listed_at`），出现 `lot_size`、`code` 即越界，加导入期硬校验。时间戳统一 UTC（审计流里 `+08:00` 与 `Z` 混用会让排序出错）。

**三、豁免必须按规则判定，不按文件归属。** H3 对 vendor chunk 里 `"F1"` 的裁定：不接受「vendor 目录整体豁免」，改规则级形态判定（仅在中文/括号/引号上下文或与"授权/积分"共现时判红；裸键名进低置信清单、每次发版人工签）。理由一句话：**以文件归属豁免代替内容判定，业务代码一打进 vendor 就自动免检。** `<noscript>` 接受逐字锁定，但须双向一致（改任一侧必红）、比对前规范化空白与实体、不得含授权/供应商解释措辞。

### L40 `display_safe` 的唯一权威是 display root（2026-11-04，A2 依 A1 反馈修正 L34）

- 某标的在 display root 有 instrument 批次 → `display_safe=TRUE`（以 display 最新批次为准）；
- 只有 internal 批次（display 缺失）→ `FALSE`，fail-closed；
- **internal 批次不得修改 `display_safe`，也不得覆盖 display 的维表行**（name/source/as_of 保留 display 的），只做审计与交叉校验；
- 旧平铺 root 仍退回 manifest 派生。

理由：**交叉校验任务不该有把 C 端清空的权力。** 若按"as_of 后写覆盖"，一次 tushare 交叉校验晚跑就会把可展示标的降级——校验任务的失败模式必须小于它要校验的对象。回归用例：`display(csv,早) + internal(tushare,晚)` 同标的仍 `TRUE` 且行仍来自 display；`internal-only → FALSE`。`warehouse/tests` 101 passed / 1 skipped。

### L41 新增依赖批准 + 一个"门禁看不见的破坏性变更"（2026-11-04）

**一、`ioredis ^5.4.2` 批准**（A0 已按 must_escalate 上报）。理由：限流需要跨副本共享计数，没有它每副本独立计数等于把 60/min 变成 60×N/min；这是安全机制的必要依赖，不是便利依赖。约束：只允许 `services/api` 使用，`services/market` 不得直连 Redis。

**二、oasdiff 1.35.0 报不出「删除 optional response property」为 breaking**（A0 已给最小复现：`No breaking changes... exit 0`）。这是**门禁的洞，不是登记方式的问题**——如果工具看不见这类变更，那么"waivers 里没登记"就不能解释为"没有破坏性变更"。

裁定：**A + B 都做，B 为准。**
- **A（立即）**：`lot_size` 按 D5 策略视为破坏性变更，在 `decisions.md` 与 ADR 声明，**不放进 `waivers.yaml`**——waivers 的语义是"工具报了、人批准了"，把工具没报的东西塞进去会让台账失去含义。签字行由 Lead 落（`agents/` 是 Lead 写域，A0 不要动）。
- **B（本周）**：A11 的契约门禁扩一条 **policy-breaking** 检查：对冻结基线逐 operation 比较 response schema 的 property 集合，**删除 required 或 optional property 一律判红**，与 oasdiff 结果取并集。理由：**一个无法发现某类变更的门禁，它的绿灯不构成证据。**

这条不只修 `lot_size`：今天之前我们也无法发现"删了一个 optional 字段但没人注意"——这类变更最危险，因为消费方通常也注意不到，直到运行时。

### L42 第四类"看起来有证据、实际没证据"：路径信任（2026-11-04，H4 发现）

`warehouse/dwd/schema.sql:71` 的 `dim_instrument.display_safe DEFAULT true`；`warehouse/dwd/build.py:126` 只要批次来自 display root 就直接 `display_safe = True`，**不看 manifest 的 channel/status**。README 写"缺证据 fail-closed"，代码是 fail-open。后果：tushare 批误写进 display root、或 manifest 丢了，数据照样进 C 端结果集。

**裁定**：默认 `false`；派生必须是**合取**——`origin == display` **AND** manifest `succeeded` 事件存在 **AND** `channel` 在允许集 **AND** snapshot 哈希一致；缺 manifest → `false`，生产 profile 直接报错不静默降级；带 `synthetic: true` 的事件一律忽略。

**本轮已出现四类同源缺陷**：
1. entitlement 缺省 `c_end_display`（默认放行）
2. manifest 写在 emptyDir（证据不持久化）
3. `display_safe` 路径信任（把"放在正确的目录里"当成"有证据"）
4. `EXPECTED_SHA256` 缺省跳过自检（自检默认关闭）

**统一规则（写进门禁，不只写进文档）**：任何"缺省即放行"的开关，必须有一条**裸启动测试**（不设任何相关环境变量/配置，断言拒绝）或**删证据测试**（删掉 manifest / 快照 / control 行，断言降级为不可展示）。A11 已有 entitlement 裸启动那条，数仓这条补进 `tests/data/`。

理由：**这些缺陷的共同点不是"配置写错了"，而是"当证据缺失时，系统选择相信"**。而证据缺失恰恰是故障、误配置、攻击最常制造的状态。

### L43 manifest 完整性由读取方验证（2026-11-04）

append-only 现在只是一句声明：JSONL 单写者只保证"我们不会改"，不保证"没人改过 / 没坏过"。补：

- 每条 manifest 事件加 `prev_hash` + `hash`（`hash = sha256(prev_hash + 规范化 JSON 其余字段)`，与 `audit.entitlement_events` 同构）；另存 `manifest.head`（末条 hash + 条数 + mtime）。
- **读取方校验**：链断、条数不符、head 缺失 → 生产 profile **拒绝启动**，A2 loader **拒绝派生**（不是告警）。
- loader 另校 `event_id` 唯一、`finished_at` 单调、`synthetic:true` 忽略。

原则：**证据的完整性必须由读取方验证，不能由写入方声明。** 这与 L42 同源——"我写了 append-only" 和 "它在被篡改时会报错"，是两件事。A11 的删证据测试顺带覆盖这一条。

### L44 哈希不许手抄、E2E 模式不许在生产存在、清单不许代签（2026-11-04）

**一、哈希只能来自脚本重算，人工只审 diff。**
A0 的 `copy-export-scan` 清单第 8 行引用的 hash `d831dd5bf0fd` 与磁盘实际 `f0282f1bec57` 不符；且他声称"内容未动"，而内容没动 hash 不会变——说明清单里的 hash 是**手抄的**。后果：校验脚本对着一个不存在的文件跑绿。
裁定：`docs/release/` 下所有清单里的 hash **必须由脚本生成并覆盖写入**，人工只许改 diff 与结论，不许改数字。脚本自检：清单里的每个 hash 都要能重新算出同一个值，否则红。

**二、`E2E_MODE=1` 必须在生产 profile 下被拒绝启动。**
`services/market/src/config.ts:180/186` 里 `e2eMode` 会同时打开 `allowDevAuth` 与 `autoMigrate`——这是**测试便利直接变成认证后门**的那类设计。裁定：`NODE_ENV=production`（或显式 `APP_PROFILE=prod`）且 `E2E_MODE=1` → **拒绝启动**，错误信息写明"E2E 模式在生产不可用"。同一规则适用于 `WATCHLIST_DEV_AUTH`、`E2E_AUTH_TOKEN`。

**三、清单不得代人签字。**
A0 的清单第 9 行写「H3 验收」，而 H3 明确没签过。这条性质比措辞严重：**一个从未发生的签字，会让下游所有人跳过复核。** 裁定：任何文档里出现"由 X 验收/批准"，必须能回指到 `decisions.md` 的会签行或 `waivers.yaml` 的 `approved_by`；回指不到的一律改为「待 X 复验」。

### L45 B 的落地形态：不要自写 differ（2026-11-04，H2 实测后修正）

H2 实测：`oasdiff 1.35.0` **自带 `--severity-levels`**。`response-optional-property-removed` 本来就在检查里，只是默认 `severity=info`，所以 `--fail-on ERR` 看不见。配置是**行式**格式（`rule-id level`，level ∈ `err|warn|info`），YAML 会被拒。

```
printf 'response-optional-property-removed err\nresponse-optional-write-only-property-removed err\n' > sev.txt
oasdiff breaking <baseline> <current> --fail-on ERR -f json --severity-levels sev.txt
→ error: {id: response-optional-property-removed, operationId: getInstrument, fingerprint: 29e737155bc9, text: "removed the optional property data/lot_size"}
```

**裁定：B 走配置，不自写 differ。** 自写要重新实现 `$ref`/`allOf`/`oneOf` 的 property 展开，等于第二套判定逻辑；两边对同一变更给出不同结论时没人能说清哪边对。
- 新增 `contracts/oasdiff-severity.txt`（**契约治理产物**，A0 写、H2 审；不放 `infra/ci/`，因为它是策略不是工具）。
- A11：`tests/contract/contract_diff_lib.py:112` 的 `cmd` 加 `--severity-levels`。
- A13：`infra/ci/contract-diff.mjs:187` 加同一文件——**否则 PR 门禁与 baseline 门禁口径分裂，一边绿一边红，这种分裂比洞本身更难查。**
- 白送的 fail-closed：未知 rule id → oasdiff exit 106，不静默忽略。

**验收两条**：①回放本次 `lot_size` 变更必须红；②删一个 optional **request** property 必须不红（负样本，防配置写宽）。四域预检基线：升级后**只允许 market 那 1 条 error**（shared 0、fundamental 3 warning、watchlist 6 warning）。

**时序（必须写进任务单）**：B 落地当天，同一条变更就变成"工具报了"，按 waiver 语义当天必须补登记，否则 **B 上线即红**，而 A11 大概率会以为是自己的配置写错了。登记内容：`finding: response-optional-property-removed`、`operation_id: getInstrument`、`fingerprint: 29e737155bc9`、`approved_by: H2`、ADR-001 D5、`expires_at: 2026-12-15`，到期用 baseline 再冻结消解、不续期。
**A13 须知**：`contract-diff.mjs` 没有 waiver 通道，删字段 PR 会硬红——那是设计，不是误报，不要调阈值。

### L46 生产守卫不能依赖"别忘了配"：profile 默认 prod（2026-11-04，H3 复核后追加）

**问题**：`services/market/src/config.ts:154-166` 的守卫触发条件是 `NODE_ENV === 'production' || APP_PROFILE === 'prod'`。这个写法有一个我们已经踩过四次的形状：**漏配即静默不触发**。也就是说这道门只在"环境变量配对了"的时候存在，而漏配恰好是最常见的部署错误。

**裁定**：把判定反过来——**默认 prod，开发环境必须显式声明**。

- `APP_PROFILE` 缺省值 = `prod`（不是 `dev`、不是 undefined 跳过）。
- 只有显式取值 ∈ {`dev`,`test`,`e2e`} 时，生产守卫与 E2E 后门才被允许；其余任何值（含未设、空串、拼错）一律按 prod 处理。
- 守卫判定改为：「profile 不在显式开发集合里」→ 拒绝 `E2E_MODE`/`WATCHLIST_DEV_AUTH`/`E2E_AUTH_TOKEN`。
- `NODE_ENV` 不再参与安全判定（它只影响日志与构建行为）。**一个变量决定两件事，是漏配的温床。**

**验收（没有这条不算做完）**：

1. **裸启动测试**：清空所有 `APP_PROFILE`/`NODE_ENV` 启动 + 注入 `E2E_MODE=1` → 必须拒绝启动（不是告警）。
2. **拼错测试**：`APP_PROFILE=prodd`、`APP_PROFILE=`（空串）→ 按 prod 处理，拒绝启动。
3. **部署面断言**：helm 渲染结果里 `APP_PROFILE` 必须显式出现且为 `prod`，没出现就渲染失败；compose 同理。
4. CI 里对生产 manifest 做一次 `grep -c 'APP_PROFILE=prod'`。

**理由一句话**：今天已经出现过三次"缺省即放行"（tier 默认 `c_end_display`、`display_safe` 默认 true、指纹缺省跳过自检）。**凡是"没有配置就当作安全"的默认值，都是在赌部署者不会忘。** 与之配套的统一规则已写在 L44：任何"缺省即放行"的开关，必须配裸启动测试或删证据测试，没有不算做完。

### L47 reason 与 cause 是两套词表，不许取并集（2026-11-04，A5/A3/A11 三方冲突）

**冲突**：L38 定 `reason ∈ {expired, manual_signoff, valid_until_set, clause_change}`；H4/A3 已实现 `reason = expires_at_passed | hold_active | hold_stale | hold_cleared | expected_fingerprint_mismatch`。A5 暂用并集 CHECK 放行，A11 按 L38 严格四值会红。

**裁定：不取并集。** 并集让"这个值到底什么意思"变得不可判定——同一个字段里既装"状态为什么变"，又装"这次为什么被拒"，两者回答的是不同问题。取并集的直接后果是：半年后没人能写出一个正确的聚合报表，因为两个语义混在一列。

**两套词表，两个字段：**

| 字段 | 回答 | 词表 | 出现位置 |
|---|---|---|---|
| `reason` | 授权状态**为什么变了** | `expired` \| `manual_signoff` \| `valid_until_set` \| `clause_change` | 审计事件 |
| `cause` | 这一次请求**为什么被拒** | `expired` \| `hold_active` \| `hold_stale` \| `unauthorized_config` \| `control_unreachable` \| `tier_internal_eval` | API 响应 |

**A3 已实现的五个值全部是诊断码，不是业务词表**，落 `internal_code` 列（可空，仅供排障），映射关系：

- `expires_at_passed` → `cause = expired`
- `hold_active` → `cause = hold_active`
- `hold_stale` → `cause = hold_stale`
- `hold_cleared` → `reason = manual_signoff`（hold 被清本身就是一次人工签字）
- `expected_fingerprint_mismatch` → `cause = unauthorized_config`

**DDL 改动（A5）**：`audit.entitlement_events` 增可空列 `cause`（6 值 CHECK）与可空列 `internal_code`（自由文本，无 CHECK）；`reason` 保持 4 值 CHECK。**A3 的事件必须三列都填**，A11 的校验按事件类型判定必填项（授权类事件才要求 `doc_sha256`/`clause_locator`）。**禁止 union CHECK。**

**A11 侧**：`cause`/`doc_sha256`/`clause_locator` 不是每行必填，按事件类型校验——**校验器把可选字段当必填，和把必填当可选一样是缺陷，只是发现得更晚。**

### L48 修正 L47 的 reason 词表：采用已实现的那套（2026-11-04，H4 复核后）

**我改判。** L47 定的 `reason` 四值是我从 L38 抄下来的，没有先看 A3 已经实现的事件码和 H4 的事件分类。结果是：一条裁决要同时改 A3 的事件写入、A5 的 DDL、A11 的校验器——**为了让一个字段的措辞符合我的记忆，去动三个已经跑通的写者，这个交易不划算。**

**L47 的原则保留**（`reason` 与 `cause` 是两个问题，不取并集）；**L47 的 reason 取值作废**，改用 H4/A3 已实现的那套：

**`reason`（授权状态为什么变了，写进审计事件）**
`env_change` | `expires_at_passed` | `expected_fingerprint_mismatch` | `manual_signoff` | `hold_active` | `clause_change`

被删掉的四个值及理由：`expired`（被 `expires_at_passed` 取代，语义更具体）、`valid_until_set`（字段已改名 `ENTITLEMENT_EXPIRES_AT`，值名跟着旧字段走会误导）、`hold_stale`/`hold_cleared`（是运行时 403 的原因，属于 `cause`，不该进事件表）、`unauthorized_config`（它是 `event_type`，不是 `reason`）。

**`cause`（这次请求为什么被拒，出现在 API 响应）**
`expired` | `hold_active` | `hold_stale` | `unauthorized_config` | `control_unreachable` | `tier_internal_eval`

**取消 `internal_code` 列**：L47 加它是因为 `reason` 词表与实现错位；现在 `reason` 直接采用实现词表，这一列没有存在理由了。**为了兼容而加的兜底列，会在兼容期结束后永久留下来。**

**新增事件类型 `clause_review`**：H3 的"三类事件"含条款复核，原 8 类漏了。必带 `doc_sha256` + `clause_locator` + `operator` + `verdict`。

**A15 契约新增硬要求**：`approval_ref` 全局唯一成立的前提是**审批 id 本身全局唯一且不可变**——UUID 或 `<env>:<id>`，**禁止裸自增序列**（分库/重放/环境切换都会撞）。这条写进 A15 的 must_escalate 与 A4 的审批 API 契约。

**A1 追加**：manifest 的 `checksum` 是 CSV 内容哈希，**证明不了快照文件没被改**；须补 `snapshot_sha256`（文件字节哈希）。A2 读取侧按证据式派生已落地（prod 缺 manifest 报错、dev 只降 false）。

### L49 终局：审计表只留单列 `reason`（6 值），不再拆字段（2026-11-04，A5 升级冲突后）

**这是本议题的最终裁定，前面 L38/L47/L48 关于本字段的部分全部作废。** 我在这个字段上改判了两次，原因是我在"语义纯度"和"改动成本"之间来回：先按记忆定 4 值，再按实现定 6 值，每次都保留了 `cause`/`internal_code` 这类"为了不丢信息"的附加列。**现在把它们全部去掉。**

**(a) 单列，不拆。** `audit.entitlement_events` 只有 `reason`。不加 `cause`，不加 `internal_code`。

理由：`cause`（本次请求为什么被拒）根本不进审计表——它属于运行时观测，进日志与指标即可。把它塞进事件表，等于让"状态为什么变"和"这次为什么被拒"在同一张表里共存，任何聚合都要先判断这行是哪种语义。**审计表回答的是历史，不是当下。**

**(b) `reason` 最终 6 值**（H4 版本，采纳）：
`env_change` | `expires_at_passed` | `expected_fingerprint_mismatch` | `manual_signoff` | `hold_active` | `clause_change`

删除项全部执行：`expired`（被 `expires_at_passed` 取代）、`valid_until_set`（字段已改名）、`hold_stale`/`hold_cleared`（运行时 403 原因，不是状态变更）、`unauthorized_config`（是 event_type）。

**(c) A3 五个诊断码的落点**（在写入侧映射，不在存储侧兼容）：
- `expires_at_passed` → `expires_at_passed`
- `hold_active` → `hold_active`
- `expected_fingerprint_mismatch` → `expected_fingerprint_mismatch`
- `hold_cleared` → `manual_signoff`（清 hold 本身就是一次人工签字）
- `hold_stale` → **不写事件**，只进日志/指标（它是"状态没变但请求被拒"，不是状态变更）

**(d) A11 按 6 值校验**，并按事件类型判定必填项；`clause_review` 必带 `doc_sha256`+`clause_locator`+`operator`+`verdict`。

**(e) 是。** H4 的删除项执行，`clause_review` 照加。

**给未来的规则（这是我今天第二次改判换来的）**：
1. **词表只在写入侧定义一次，其余侧做映射**；每多一个"为了兼容"的列，就多一套永远不会下线的语义。
2. 裁定前先看**已实现的代码**，再看文档——文档反映的是某一次讨论，代码反映的是当前事实。
3. 同一个字段我改判超过一次，说明这个字段承载了不止一个概念，应该拆的是**表**，不是词表。

### L50 已完成：`owns` 字段的防复发不变式（2026-11-04，修订）

**我原先记成 P2 待办，是错的——A13 已经做完，并带负样本测试。** 修订如下：

- `infra/ci/path-guard.mjs:208-213` 解析 `owns`；`validateRosterConsistency` 有 owns 分支（`[roster-owns-无覆盖]`）。
- `infra/ci/test/path-guard.test.mjs:146-154` 负样本：`owns: ['infra/','ops/runbooks/']` → 断言报错含 `A13 owns "ops/runbooks/"`。
- 实跑输出：`roster 一致性：20 个 agent 的 write_scope/forbidden/owns 与 ownership 一致`（绿）；合成 roster `A2 owns: ['warehouse/','quality/']` → `[roster-owns-无覆盖] A2 owns "quality/"`。

**这条反过来验证了今天的主题**：清单说没做、代码已做。**decisions 本身也会漂，而且它不在任何解析器的视野里。** 治它的办法只有一条：写「已完成/已生效」时必须附**可执行证据**（命令 + 期望输出），否则五分钟后就要别人替你纠正。

### L51 审批 id = `apr_<uuidv7>`，由 A4 建单事务内生成（2026-11-04，A15 答复后）

**现状**：`approvals/` 与审批 API 都不存在（A15 是 P2 待命），所以这条既不是自增也不是 UUID，是**还没有**。标记为「契约已确认、待 A4 落地」，不得写成「已满足」。

**裁定**：
- 形态：`apr_<uuidv7>`，跨环境加分段前缀（`prod:` / `staging:`）。字符集 `:`/`-` 与 `001_audit_entitlement_events.sql:84` 的 `approval_ref` CHECK 兼容。
- **生成点唯一**：A4 审批 API 的「建单」事务内生成。**不得由申请人预填、不得由 A15 代填**——谁填谁就能伪造回指。
- 状态流转不换 id；撤回/驳回永久保留、不复用。
- **DB 侧拒绝非 UUIDv7 形态**（CHECK），不只靠应用层。理由：A15 指出的那条——`approval_ref` 的部分唯一索引只保证「能回指」，**不保证生成器不是自增**。约束要落在"值的形状"上，不能落在"我们记得别用自增"上。

**A4 契约要求**：`text` 类型 + `UNIQUE`，禁 `identity`/`serial`；建单接口返回体含 id；A4 `write_scope` 内的 `approvals/` 目录随之建立。

### L52 审计链的三个口径：各取一半（2026-11-04，A1/A2 实现冲突）

**冲突**：A2 读侧写「首条 `prev_hash` = 64 个 0，`hash = sha256(canonical)`」；H4 m01376 写「首条 `GENESIS`，`hash = sha256(prev_hash + "\n" + canonical)`」。谁照自己的实现，对方的产物就会被判链断。

**裁定：取两边各一半，理由是这两个维度回答的问题不同。**

- **哨兵值用 64 个 0，不用 `GENESIS` 字符串。** 因为用了字符串，第一行就必须和其余行走不同的计算分支——**而特殊分支是所有链问题的发源地**。64 个 0 让"第一行"在计算上不是特例，只是 prev 恰好是 0。
- **摘要必须含 prev_hash**：`hash = sha256(prev_hash + "\n" + canonical_json)`。不含 prev 的"哈希链"不是链，是带序号的哈希列表——**它证明不了行被删过**。这一条不可协商，A2 的读侧要改。
- `canonical_json` = 键排序、无空白、UTF-8、时间戳 UTC Z。

**`manifest.head` 取宽容读取**：写入方带 `schema_version` 与 `updated_at`（H4 要求），**读取方必须忽略未知键**。理由：head 会演进，读取方一遇未知键就报错，等于每次加字段都是一次停摆。

**`synthetic: true` 的行 `display_safe` 必须 false**（A1 的 manual 样例现在是 synthetic+true）。A2 跳过它所以没暴露，但**任何不跳过的消费者都会把假数据当真**——这种"我们这边跳过了"的防御，只在编写者记得跳过时成立。

**边界**：`services/ingest/var/audit-demo/` 是 smoke，**不是 11-12 的证据**。证据链只有一条路：真实渠道 + manifest + head + A2 复算。

**验收**：A2 改完 digest 后，用 A1 的 `var/audit-demo` 跑 `verify-manifest`，双向都能过（谁读谁的产物都成立），这条才算闭合。

### L53 `entitlement_hold.reason` 改名 `hold_reason`：一个词不能承载两种语义（2026-11-04，H2 举手）

**问题**：同一 schema 里有两个 `reason`——
- `audit.entitlement_events.reason`：6 值闭集 + CHECK；
- `audit.entitlement_hold.reason`：`text` 自由文本、无约束、`set_by` 人工填。

**一个词承载枚举和自由文本两种语义，任何联表写报表的人都会 `SELECT reason` 把两套并集**——这正是 L47 的病因。今晚正好在动这张表，改名成本现在最低。

**裁定**：`entitlement_hold.reason` → `hold_reason`；视图 `entitlement_hold_state` 同步改；**不留兼容别名**（留了就是下一次并集）。P0 下游只有 reconciler 读这个视图，一起改干净。

**L49 末尾追加规则**：**枚举用于解释，不用于驱动。** 哪天 reconciler 必须靠 `reason` 分叉才正确，说明状态机缺一个状态——**补状态，不是加列**。要区分的是行为，就该在状态里区分。

**证据**：H2 已 grep `services/compliance/src`、`services/api/src`、`warehouse/`，**没有任何代码按 audit reason 分叉**，所以现在删 `cause`/`internal_code` 是零迁移成本；等第一个分支写出来再删就要改行为。时机对，L49 定稿。

### L54 已执行的迁移文件不可改写，改 schema 一律新增迁移（2026-11-04，H2 收尾提醒）

**机制**：`infra/scripts/db-migrate.sh:120-124` 用 ledger 比对（`meta.schema_migrations` 的 `filename` + `sha256`，filename 为仓相对路径）。改写任何已执行过的迁移文件 → `迁移文件已被篡改…禁止改写已执行迁移，请新增迁移`，exit 5。

fail-closed 是对的，但**现象具有欺骗性**：部署突然失败，报的是"篡改"，没人第一眼会想到是自己改了列名。

**规则**：
1. 任何 schema 改动走**新增迁移**（如 `002_hold_reason.sql`），不就地改 `001`。
2. `CREATE OR REPLACE VIEW` 不会替读取方改列名——**改名必须同时重发视图**。
3. 判断"这个迁移有没有跑过"的唯一依据是 `SELECT * FROM meta.schema_migrations`，**不是记忆，也不是"应该没跑过"**。
4. 确实在全新库上原地改是允许的，但前提是先查 ledger 并留下查询输出。

**这条是今天第八个同形状的问题**：判断依据来自记忆而非现场。前七个是代码、配置、清单、哈希、默认值、证据链、裁定记录。

### L55 两处边界澄清：`clause_review` 进 DDL，`snapshot_sha256` 不进（2026-11-04，H4 复核后）

**1. `clause_review` 是第 9 个 event_type，要写进 DDL**（A5 的定稿迁移）。必带 `doc_sha256` + `clause_locator` + `operator` + `verdict`。

**2. `snapshot_sha256` 只属于 ingest manifest，不进审计表。**
它是"这批数据来自哪个文件、文件没被改过"的证据，属于数据血缘；审计表记录的是**授权状态为什么变**。两件事，两张表。

**因此 #6 抽样是跨表校验**，不是单表查询：
- 事件侧：`clause_review` 事件的 `doc_sha256`/`verdict` 齐全；
- 数据侧：对应批次的 manifest 有 `snapshot_sha256` 且 A2 复算一致；
- **两者用批次/批号关联，任一缺失即 FAIL。**

**给 A11**：不要为了"让 #6 在单表里可查"去要求审计表加 `snapshot_sha256`——那是把一个血缘字段塞进授权台账，两边的完整性语义不同（manifest 是链，审计是状态机）。**校验器需要跨两个真源时，就该让校验器跨，而不是让真源融合。**

### L56 撤销 `X-Entitlement-Cause`：响应头也是对外出口（2026-11-04，H3 直接否掉我的裁定）

**我错了。** 我裁定「`cause` 放响应头，别动契约」，理由是"header 不算产品语义"。H3 一句话就否了：**响应头是客户端可达出口**——body 中性化了、header 又把"为什么被拒"还回去，等于白做。

**裁定（H3 为准）**：
1. **生产不发送 `X-Entitlement-Cause`**；A3 删头。
2. 诊断面留在**内部**：事件/审计日志 + `trace_id`。排障凭 trace_id 查，不靠响应头。
3. A3 加测试：403 响应头**不含** `cause` 及 `expired`/`hold`/`stale`/`unauthorized` 等字样。
4. A12 的 E2E 出口扫描把**响应头**纳入扫描面（此前只扫 body，是个洞）。
5. runtime 原因码（`hold_stale`/`control_unreachable` 等）留在 A3 的 `DegradedReason` 内部类型里，不出口。

**教训（写给以后的我）**：我把 header 归类成"内部通道"，这是把**实现位置**当成了**暴露面**。判断是否对外，看的是"客户端能不能拿到"，不是"它在 body 还是在 header"。同类错误还有：sourcemap、错误堆栈、`Server` 头、缓存键。**凡是随响应回去的，都是出口。**

### L57 `clause_locator` 只对 `clause_review` 必填（2026-11-04，A5 升级）

**争议**：A11 的脚本对任何带 `authorization_doc_sha256` 的事件都要求 `clause_locator`；但运行期 `clear_hold()` 没有 locator 参数，H3 对 `hold_clear` 只定义了「工单 + 签字人 + 依据文件哈希」。

**裁定：locator 只对 `clause_review` 必填。DDL 与 `clear_hold()` 签名都不动，A11 收紧脚本。**

理由：两个字段回答不同问题。
- `authorization_doc_sha256` = **依据的是哪份文件**（任何引用授权依据的事件都该有）；
- `clause_locator` = **文件里的哪一条**（只有"逐条复核"这件事需要精确定位）。

`hold_clear` 是一次**运维动作**，它依据工单与签字，而不是某一条款；强行要 locator，只会逼人填一个形如 `"N/A"` 或 `"见工单"` 的假值——**而假值一旦被允许，字段的约束就失效了。**

**给 A11**：把「doc_sha 存在 ⇒ 必须有 locator」改成「event_type 为 `clause_review` ⇒ 必须有 locator」。其余类型只校 doc_sha + 各自必填项。
**给 A5**：`clear_hold()` 签名不动。

### L58 两个"证据没覆盖事实"的缺口（2026-11-04，H2 复核发现）

**① `90_verify_privileges.sql` 只断言表级权限，没断言 market_app 对 `clear_hold` 的 EXECUTE 必须为 false。**

现状：权限口径是对的（`infra/db/sql/20_grants.sql:81-87` market_app 只读 `audit.entitlement_hold_state` 视图、基表零权限；`:109-116` reconciler 仅 `raise_hold`/`mark_reconciled`；`:118-124` human_hold_clear 仅 `clear_hold`；`:127-137` audit_reader 只 SELECT；`001:671-689` 收了 PUBLIC 的默认 EXECUTE）。

**但那句 `REVOKE ... FROM PUBLIC`（001:688）是唯一挡住"应用自己抬闸门"的东西，而没有任何检查在读这个事实。** 一次 `DROP FUNCTION` + `CREATE`（ACL 重置回 PUBLIC），或新迁移加函数忘了收口，闸门静默打开、verify 仍全绿。

补法（A13，`90_verify_privileges.sql` audit 段，沿现有 violations 风格）：
- market_app 对 `audit.clear_hold/raise_hold/mark_reconciled` 的 `has_function_privilege` 必须 false；
- warehouse_loader 同理；
- 再直接查 `aclexplode(proacl)` 里 `grantee = 0`（PUBLIC）是否存在，存在即 violation——`has_function_privilege` 是"以角色视角"，显式断 PUBLIC 更抗将来。

**② `release-gate.yml:130-133` 的 `if: always()` 兜底被 `|| echo` 废掉了。**

`|| echo "::warning::--restore-fresh 失败…"` 让恢复失败降级成 warning。**恢复没做成也没人红**，于是环境停在 stale，A11 下次跑什么都 fail-closed——**他会把"环境坏了"当成"判定对了"**。

改法：**去掉 `|| echo`**。`seed-entitlement-audit.sh` 缺 DSN 是 exit 2、缺表 exit 3；release-gate 第 72 行用同一个 DSN seed 能成，restore 失败就是真失败，该红。本地无 PG 的容错属本地脚本分支，不该在 release gate 里降级。

**验收（H2 提）**：把 PUBLIC EXECUTE 打开 → verify 必须红（负样本）。

### L59 `entitlement_expired` 必须有调用点（2026-11-04，A11 第 1 条 FAIL）

**问题**：A3 的 `expiredEventKey` 有实现、无调用点——到期降档发生了，但事件层没有记录。

**裁定**：
1. 调用点放在**有效档位解析处**（`resolveEffectiveTier`），不在 HTTP 请求路径上——每次请求都算一次，会用请求量把审计表炸掉。
2. 顺序：**先降档（内存态 → `internal_eval`）→ 再写事件 → 才开始服务**。降档与写事件是同一件事的两半。
3. **写失败不得让服务以高权限继续**：写失败时保持 `internal_eval`，healthz 记 degraded，按 L20「未留痕的档位变更按未授权处理」执行。**注意这里的默认值方向是安全的**——失败态本身就是低权限态，不需要回滚。
4. 幂等：`event_key` 由 `(tier_state, expires_at, 业务日期)` 派生，进程重启不重复写。
5. 反向断言：**到期但事件缺失** 必须能被 A11 查红（不只看"有没有降档"，要看"降档有没有留痕"）。

**给 A3**：这是 A11 第 1 条唯一 FAIL，也是 H4「缺一样不交付」的卡口；修完 A11 复跑即可放行 11-12 的第 1 条。
