# Market Sense 团队重建 · 交接文档（v2 · 精简编制版）

> **v2（2026-11-06 17:40，L0 修订）覆盖同日初版。** 变更：常驻 teammate **17 → 5 席**，其余 **12 席一律改按需 subagent**（不常驻、任务完即退）；**subagent 统一模型 mimo-v2.6-flash**（路由事实与代跑规则见 §2.0）。
> 原则不变：**精简只减常驻编制，不减职责**——17 个 role 的 owns 全保留（§2.3），只是执行形式从「常驻 teammate」改为「按需 subagent」。
> 交接人：L0（lead）。模型分配原始意图：**L0=DeepSeek、M1=MiMo（多模态）、其余=SenseNova**（实际路由偏差见 §2.0）。

---

## 0. 项目一句话

用 tushare 数据源搭建 AI-native「market sense」H5 平台。**6 个工作面**：C 端 H5 / 数仓与数据平台 / 运营配置+数据看板中台 / 数据合规中台 / 权限管理+流程审批后台 / CRM 拓客平台。H5 需支持 agent 调用 + 员工手动配置。

---

## 1. 不可违反的硬约束（红线，先读这段）

1. **tushare 个人许可「不可转让 / 非商业 / 仅个人查看」⇒ to C 商用违约。** 当前取数走第三方 mirror `tuaremax.top`（`services/ingest/.env` 的 `TUSHARE_HTTP_URL`），**无 tuaremax 书面转售授权 = 厂商法律授权缺口，记 residual，未闭环**。C 端商用上线前必须拿到官方书面授权。
2. **荐股 = 证券投资咨询（证监会〔2012〕40号）。** C 端输出「某票值得关注」/目标价/择时/涨跌预测即踩线。合规负面清单 = `rules/redline-basis.json` 的 H3-C01..C12。
3. **403 = 无权展示，不是无数据。** 契约层强制：受限返回 403 `EntitlementRestricted`，禁止用 200 + `is_entitled=false` 替代。
4. **AI 生成内容必带标识 + 不可关闭免责 + as_of**，政策文件 `rules/ai-content-policy.json`（当前 version 1.1.2，c_end + internal 两分区均 signed）。
5. **C 端 AI 展示卡 AI-1/2/3 未签** —— 签认≠C 端放行，整体 go-live 卡住。
6. **首屏 JS 预算 200 KB gzip**（`web/h5/scripts/check-budget.mjs`），引入 antd-mobile 后重跑，超了砍组件不上调上限。

---

## 2. 编制（v2 精简：5 常驻 + 12 按需 subagent）

### 2.0 模型路由（规则 + 平台事实）

- **规则（owner 指令）**：subagent 一律 **mimo-v2.6-flash**。
- **平台事实（2026-11-06 实测）**：`xiaomi-token-plan-cn/mimo-v2.6-flash` 当前 Session **未放行**（`list_subagent_models` 拒绝："child LLM route ... is not allowed for this Session"）；可用子路由仅 `xiaomi-token-plan-cn/mimo-v2.6-pro` 与 `sense/sensenova-6.8-flash`。**owner 放行 flash 路由前，subagent 以 mimo-v2.6-pro（同族代跑）执行并在派单标注偏差**；不得擅自改用 sense 系。放行后即切 mimo-v2.6-flash。
- **teammate 通道**（spawn_teammate）无 model 参数，实测统一路由 **mimo-v2.6-pro**（偏离"其余=SenseNova"原分配）；严格对齐需 profile 补丁 + 重启 GUI（`agents/team-rebuild-2026-11-06/teammate-model-patch.snippet.yml`，owner 决策）。
- L0 主 agent 实测路由 mimo-v2.6-pro（原意 DeepSeek），已记 BOARD§五。

### 2.1 常驻 teammate（5 席，P0 AI 证据链在途执行席）

| ID | role | owns | 在途任务 | 退场条件 |
|---|---|---|---|---|
| **L0** | 主 agent / 项目协调 | 编排、派单、落账 decisions.md | 跨席协调、owner 催办 | 常驻 |
| **A3** | 后端 · 行情/内容/研究域 | `services/market/`、`services/ai/` | /v1/ai/* 实现+留痕（E-AI1-01） | AI-1 证据齐交 H3 |
| **A4** | 后端 · 用户/权限/审批/CRM | `services/identity/`、`services/approval/`、`services/crm/` | AuditSink + /v1/internal/* 契约对齐 | AI-1 证据链交齐 |
| **A6** | 前端全栈 | `web/h5/`、`web/console/` | Console 真契约 adapter + AI-2/3 修复清单 | AI-2/3 修复+adapter 完 |
| **A7** | QA · 契约/数据/E2E | `tests/` | AI-2/3 E2E 证据（独立端口自跑，L0 已授权） | AI-2/3 证据齐交 H3 |

> 停机记录（2026-11-06 17:40）：h2-arch / a2-data-warehouse / a5-backend-compliance / a8-sre 四席已中断退场，未完任务转 §2.2 按需重派。h1/h3/h4/a9/a10/a11 保持停机不唤醒。

### 2.2 按需 subagent 池（12 席）

**使用规则**：L0 用 `subagent` 工具按需拉起；prompt = `agents/team-rebuild-2026-11-06/prompts/<ID>.md`（17 份已预打包：人设逐字 + 合并说明 + handoff + 共享记忆 + 六红线 + 待办）+ 本次任务说明。模型 mimo-v2.6-flash（§2.0）。**写域不越界、任务完即退、不常驻、不互发消息**；结论回 L0 落账。

| ID | role（owns 不变，见 §2.3） | 拉起触发 |
|---|---|---|
| **H1** | PM/PO：PRD/backlog/验收/范围 | 验收批次、PRD 勘误、优先级裁定材料 |
| **H2** | 架构：ADR/契约终审/模块边界 | 契约评审（如 domains.ts 接入复核、G-03 写路径判定、C-APP-01 裁定材料） |
| **H3** | 合规兼 DPO：表述边界/合规否决/政策签发（c_end） | **AI-1/2/3 复核签认**、政策签发、RT-08 裁定、N4 口径澄清、token 冲突裁定 |
| **H4** | 数据+安全：数据源边界/授权合规/安全/发布签字 | tushare 授权台账、安全半材料、11-09 中期检查、SEC-011 续报 |
| **M1** | UI/UX 设计（多模态）：`docs/design/`、`packages/design-tokens/` | 视觉验收、token/组件映射、antd 落地方案（多模态任务） |
| **A1** | 数据接入+调度：`services/ingest/` | tushare/AKshare 适配、dc_index/dc_member 实测 |
| **A2** | 数仓建模+指标+质量：`warehouse/` | serving 视图、质量门禁、派生表（席位统计） |
| **A5** | 后端合规+审计：`services/compliance/` | control 心跳/observed、审计事件、entitlement gate |
| **A8** | SRE：部署/CI/Docker/migration | CI 真跑核验、部署冒烟、path-guard、runbook 门禁 |
| **A9** | 业务线：运营+管理员+拓客 | 三线可用性走查、审批操作演练、CRM 拓客流程 |
| **A10** | 研究·证券/标的/资金面 | 投研口径、龙虎榜/资金面 evidence 规范、基金特征卡 |
| **A11** | 研究·宏观/政策 + 合规复核/红队 | 宏观供给、红队抽核、证据抽样（A16/A19 职责） |

### 2.3 席位全表（17 role，owns 不变——减常驻不减职责）

| ID | 角色 | 执行形式 | owns（写权限范围） | 由原编制合并自 |
|---|---|---|---|---|
| L0 | 主 agent / 项目协调 | 常驻 | 编排、跨席协调、落账 decisions.md | lead |
| H1 | PM / PO | subagent | PRD、backlog、验收标准、范围/优先级 | H1 |
| H2 | 架构与技术负责人 | subagent | ADR、API 契约终审、模块边界、发布拓扑 | H2 |
| H3 | 合规负责人（兼 DPO） | subagent | 产品表述边界、合规否决、redline/政策签发 | H3 |
| H4 | 数据负责人 + 安全运维 | subagent | 数据源边界、授权合规、安全、发布签字 | H4 + H5 + A9 |
| M1 | UI/UX 设计（多模态） | subagent | `docs/design/`、`packages/design-tokens/`、组件映射 | A10 |
| A1 | 数据接入 + 调度 | subagent | `services/ingest/`、tushare/AKshare 适配 | A1 |
| A2 | 数仓建模 + 指标 + 质量 | subagent | `warehouse/`（ODS/DWD/ADS/serving） | A2 |
| A3 | 后端 · 行情/内容/研究域 | **常驻** | `services/market/`、`services/ai/`、研究数据 serving | A3 |
| A4 | 后端 · 用户/权限/审批/CRM | **常驻** | `services/identity/`、`services/approval/`、`services/crm/` | A4 + A6 |
| A5 | 后端 · 合规域 + 审计 | subagent | `services/compliance/`、审计事件、entitlement gate | A5 |
| A6 | 前端全栈（H5 + 中后台） | **常驻** | `web/h5/`、`web/console/` | A7 + A8 |
| A7 | QA · 契约/数据/E2E | **常驻** | `tests/`、契约测试、E2E、C 端模拟用户 | A11 + A12 + A18 |
| A8 | SRE / 平台工程 | subagent | 部署、CI、Docker、DB migration 执行 | A13 |
| A9 | 业务线 · 运营 + 管理员 + 拓客 | subagent | 运营配置、审批操作、CRM 拓客流程 | A14 + A15 + A17 |
| A10 | 研究 · 证券/标的/资金面 | subagent | 投研数据 BRD、标的/基金/资金面研究 | A20 + A22 |
| A11 | 研究 · 宏观/政策 + 合规复核/红队 | subagent | 宏观政策研究、公开源检索；兼合规复核+对抗测试 | A21 + A23 + A16 + A19 |

> 旧席合并关系（31→17）：A9安全→H4；A6 CRM后端→A4；A7+A8前端→A6；A10设计→M1；A11+A12+A18测试→A7；A14+A15+A17→A9；A20+A22→A10；A21+A23+A16+A19→A11。

---

## 3. 各席交接要点（关键事实）

### L0 主 agent
- 职责：编排、派单、跨席协调、维护 `agents/decisions.md`（已落 L1–L133+ 裁定）。
- **不能做的事**：不擅自代签 owner 专属权限（历史两次越权事故，L130：①误判授权覆盖 policy 代签 ②回滚误删 definition_refs）。c_end 政策 = H3 签；internal 政策 = owner 签（Lead 仅 owner 明确授权代填 status/signed_at 两字段）。
- teammate 与 subagent 用法：常驻席只留 P0 在途执行席；其余任务一律 subagent（prompt 引 `prompts/<ID>.md`）。

### A3（常驻）后端行情/AI
- 在途（P0 最高优先）：按 `contracts/ai/openapi.yaml` 实现 POST /v1/ai/analyses、GET /v1/ai/analyses/{id} 等；aiPlugin 接 `services/api/src/domains.ts`（待 H2 复核）；一次真实请求落 `audit.ai_generation_events`（留痕注入 `services/ai/src/postprocess/host.ts:181`→`postprocess/audit.ts:172`）；响应 meta.ai 六字段+as_of；全受限 403 ENTITLEMENT_RESTRICTED（L126：ai 不跑 entitlement gate，market gate 唯一判定点）。证据→`tests/data/acceptance/artifacts/ai1-evidence-2026-11-06.md`。
- 已知缺陷史：`services/market/src/routes.ts` 先 loadInstrument 再 requireEntitled（熔断 1011ms→修后 3ms）。

### A4（常驻）后端用户/审批/CRM
- 在途：AuditSink 留痕 + `/v1/internal/*` 契约对齐（contracts/config + contracts/approval）。
- 缺口（A9 走查）：G-03 `services/approval/` 写路径未实现（契约在、实现缺）；CRM 契约设计稿未交。

### A6（常驻）前端全栈
- 已完成：C 端 5 tab（App.tsx 六路由 + TabBar + /ai + /me）；Console 骨架（5 页+四中台）；h5 budget 83.7KB gzip/200KB。
- 在途：Console 真契约 HTTP adapter（CONTRACT-MAP.md 已映射 openapi.yaml，adapter 未落）。
- **AI-2/AI-3 修复清单**（A7 红项+M1 验收）：5 处字号 <13px（.ai-badge 11.5 / .ai-disclaimer 10.5 / .disclaimer__meta 11.5 / .quote__meta 11/12.5 / .ai-context__item 11/12.5，app.css）+ `.ai-badge__mark` 9px 违规格 + 字色 3 处偏差 + ai-as-of testid 缺（AiInterpretation.tsx:126）+ AiTextSlot 恒 content=null 无模型文本路径 + 复制/导出入口缺失。G-02：Console 自造 approval_ref（`console/...`、`seed/...`）违 L51 唯一生成点。
- antd 落地：清单 `design/antd-landing-checklist.md`（console=antd~5.29.3+@ant-design/v5-patch-for-react-19~1.0.2+icons~5.6；h5=antd-mobile~5.43.0+icons~0.3.x；禁 antd 进 h5；估 31–53KB+图表库），卡 H2/A0 依赖回执 + **owner 确认改 package.json**（agent 不改），落地后必复测 budget。

### A7（常驻）QA
- 在途：AI-2/AI-3 E2E 证据（390×844 浅+深 computed-style、无 as_of 三节点 fail-closed、复制/导出三件套），独立端口自跑（L0 授权，不动共享栈）；红项证据出齐，修复归 A6。
- 基线：E2E 10 passed/1 skipped（真栈）、contract 69 passed、testids 59 对齐。

### subagent 席要点（一行/席，拉起时读 prompts/<ID>.md + §6 全文）
- **H1**：验收口径 `docs/requirements/p1-acceptance-2026-11-06.md`+`backlog.md`+`go-live-blockers.md`（归口）；PRD v2.1.1 已勘误 2 处；remote 在（01e079e）、CI 发布状态待核（A8 核）。
- **H2**：ADR-001..008；契约 `contracts/*/openapi.yaml`；待办：domains.ts 接入复核、G-03 写路径判定、C-APP-01（PRD §3.11 approval_ref 输入 vs approvals/README 禁手写，A9 倾向删输入框案 b）。
- **H3**：`reviews/compliance/AI-CARD-CLOSURE-TRACKER-2026-11-06.md`（AI-1 四判据/owner=A3+A4、AI-2 owner=A6+A11·A7、AI-3 owner=A6+A7，均 OPEN）；待办：RT-08 裁定、N4 观察项 4 处 <13px 口径、ai-badge-bg token 冲突（#e63e31 东财红 vs 规格 #0b6357 青绿，M1 提案改青绿）、tracker 行号漂移回填。
- **H4**：tushare 授权三件 **0/3**（11-12 到期）+ SEC-011 F1 residual + `security/gate/security-half-acceptance-2026-11-12.md`（值班 8 格姓名手机/真实寻呼网关+ack 回执/staging 15min 演练或路径 B owner 书面，任一 OPEN 不签半）；11-09 中期检查无进展 L0 出升级通报。材料清单 `security/compliance/owner-signoff-checklist.md`。
- **M1**：`docs/design/ai-display-visual-acceptance-2026-11-06.md`（不通过，差距=字号/字色/testid）；`design/antd-landing-checklist.md`；token 单源 `packages/design-tokens/tokens.json`；不写 React/TS 实现、不改 package.json。
- **A1**：取数走 tuaremax mirror；dc_index doc_id=362 / dc_member doc_id=363 已实测 15000 积分可用（`services/ingest/src/market_ingest/adapters/tushare/research.py`）；待办 AKshare 实时行情接 fixture 替换。
- **A2**：`warehouse/` ODS+17 DWD+serving+23 RES；待办：席位统计派生表、hk_hold 覆盖口径、缺口码 5 个登记。
- **A5**：`services/compliance/` 审计 DDL 001/002/003 封版；待办 control 心跳/observed 列。
- **A8**：ECS `47.120.16.239`（lyuddu + sudo docker，五容器 healthy）；GitHub push 可达；待办：CI runner 实跑核验、path-guard、部署冒烟。
- **A9**：走查产出 `docs/runbook/业务侧/三线可用性验收清单-2026-11-06.md`（P0×2：G-02/G-03；MockBackend 默认数据源未达 AC-P16-1）。
- **A10**：`research/quant/2026-11-06-lhb-capitalflow-evidence-consumption-spec.md`（27 要素+E-1..E-7 规则）+ samples-v0（正负用例）。
- **A11**：`research/macro/2026-11-06-macro-evening-brief-batch1.md`（白名单源，无方向结论）+ `security/findings/RT-AICARD-REDTEAM-2026-11-06.md`（RT-01..11，高危 3：证据无 commit/CI 锚、AI1-2 单样本不证覆盖、FakeProvider 默认无来源证明）。

---

## 4. 未完成工作（截至 2026-11-06 17:40）

### P0（阻塞 C 端上线）
1. **tushare 官方授权三件**（书面回复/条款文本/白名单+来源解耦）0/3，11-12 到期——owner 催办（清单 `owner-signoff-checklist.md` B1-B6）；**安全半三项**（值班 8 格/寻呼网关+ack/staging 演练或路径 B owner 书面）并行，任一 OPEN 不签半。
2. **C 端 AI 展示卡 AI-1/2/3 签认**：证据链 A3→A4→A7→H3 在途（E-AI1-01 在途；AI-2/3 红项证据 A7 出、修复 A6）；RT 高危 3 条须先消（证据加 commit/CI 锚、多样本覆盖、FakeProvider 改显式+来源证明）。
3. **F1 取数合规 residual**：SEC-011 未闭环（与 1 同源，拿到 tuaremax/官方书面授权才消）。

### P1（本轮主线）
4. **antd 落地**：M1 清单已出；卡 H2/A0 依赖回执 + owner 确认 package.json → A6 落地 S1–S5，落地后必复测 budget（现 83.7KB/200KB）。
5. **Console 真契约 HTTP adapter**（A6+A4）：连 `/v1/internal/*`；消 G-02 自造 approval_ref；C-APP-01 待 H1/H2 裁。
6. **AKshare 实时行情**（A1+A3）：替换 fixture 价格。
7. **P1-5 尾项**：/me 4 项 + E2E/375×667/深色/首屏 6 元素证据（PENDING-A7）。

### P2
8. control 心跳/observed 列（A5）；CRM 契约设计稿（A4）；越层授权台账。
9. token 冲突 ai-badge-bg（H3 裁后 M1 改 tokens.json）；RT-08 原生复制/截屏/流式边界（H3 裁）；N4 观察项 4 处 <13px 口径（H3）。
10. 席位统计派生表 + hk_hold 覆盖口径 + AnalysisDataRef.module 命名（A2/H3/A5 裁）。

---

## 5. 交接顺序（新模型接管步骤）

1. **读红线**（§1）——6 条不可违反。
2. **按 §2 建队**：常驻 teammate 只建 §2.1 的 5 席（P0 在途席，完成后退场）；其余一律按需 subagent（§2.2 规则）。subagent 统一 mimo-v2.6-flash（§2.0 路由事实）。
3. **读 §4 未完成工作**，P0 三件先推进。
4. **读 `agents/decisions.md`**（L1–L133+ 裁定，避免重复裁定或推翻已定结论）。
5. **读关键产出**：PRD(`prd-v2.md`)/BRD(`brd-c-end.md`)/设计四件套(`docs/design/`)/合规台账(`reviews/compliance/`、`security/`)。
6. **本轮在途**：AI 证据链（A3→A4→A7→H3）> Console adapter（A6+A4）> AKshare（A1+A3）> antd（owner 确认后 A6）。

---

## 6. 关键路径与文件索引

| 类别 | 路径 |
|---|---|
| 历史裁定 | `agents/decisions.md`（L1–L133+） |
| **逐席 prompt 打包** | `agents/team-rebuild-2026-11-06/prompts/<ID>.md`（17 份，subagent 直接引用） |
| 编制台账 | `agents/roster.yaml`（17 席 mission+system_prompt 真源）、`agents/BOARD.md` |
| PRD / BRD | `docs/requirements/prd-v2.md`（v2.1.1）/ `brd-c-end.md` |
| 验收/backlog | `docs/requirements/p1-acceptance-2026-11-06.md`、`backlog.md`、`go-live-blockers.md` |
| 设计 | `docs/design/system-v2.md` / `c-end-h5-v2.md` / `console-v2.md` / `ai-display-visual-acceptance-2026-11-06.md` |
| antd / token | `design/antd-landing-checklist.md`、`design/antd-component-mapping.md`、`design/token-integration.md`、`packages/design-tokens/` |
| 合规红线 / AI 政策 | `rules/redline-basis.json`（H3-C01..C12）、`rules/ai-content-policy.json`（v1.1.2） |
| AI 卡闭环 | `reviews/compliance/AI-CARD-CLOSURE-TRACKER-2026-11-06.md`、`AI-CARD-SIGNOFF-2026-11-06.md` |
| 红队/安全 | `security/findings/RT-AICARD-REDTEAM-2026-11-06.md`、`register.md`（SEC-011）、`security/gate/security-half-acceptance-2026-11-12.md`、`security/compliance/owner-signoff-checklist.md` |
| 契约 | `contracts/{shared,market,fundamental,watchlist,ai,config,approval}/openapi.yaml` |
| ADR | `docs/adr/ADR-001..008.md` |
| 审计 DDL | `services/compliance/migrations/001/002/003`（003 = ai_generation_events） |
| 研究 | `research/quant/`（lhb 资金面口径）、`research/macro/`（宏观供给） |
| 取数配置 | `services/ingest/.env`（tuaremax token，.gitignore 排除） |
| 三线走查 | `docs/runbook/业务侧/三线可用性验收清单-2026-11-06.md` |

---

## 7. 旧 agent 上下文（subagent prompt 打包用）

- **已预打包**：`agents/team-rebuild-2026-11-06/prompts/` 下 17 份 `<ID>.md`，按 §7.3 格式含「人设逐字 + 合并说明 + handoff + 共享记忆 + 六红线 + 待办」。**拉起 subagent 直接引用该文件 + 任务说明即可，不需要重新打包。**
- **来源（重新打包时用）**：①专属人设 = `agents/roster.yaml` 各席 `mission`+`system_prompt` 块（A0–A23 行号表见 `prompts/MANIFEST` 或 roster 注释；H1–H6 人席只有 role/authority/owns 定义无 system_prompt）；②专属 handoff = `agents/handoff/`（A6/A8/A14/A15/A16 五份）；③共享记忆 = `agents/decisions.md`（每席必读）；④编制手册 = `agents/README.md`（人=责任主体，agent=产能单元，**agent 不能签字**）。
- **打包格式（§7.3）**：`[角色] ID+role → [模型] 分配模型 → [专属人设] mission+system_prompt 原文 → [专属 handoff] 若有 → [合并说明] 合并席列出两块职责 → [共享记忆] decisions.md 相关裁定 → [硬约束] §1 六红线 → [未完成] §4 相关待办`。

---

## 8. 交接人备注（给新模型的话）

- 项目真栈可用：PG@55432 + API@8081 + Web@3000（E2E 10 passed 基线）；ECS 47.120.16.239 五容器 healthy；GitHub push 可达（remote 在，CI 发布状态待核）。
- **owner 是最终决策者**。Lead 仅在 owner 明确授权时代行特定动作（如 policy internal 代签 status/signed_at），不可自作主张扩权（L130 两次事故）。改 package.json（antd）、签半、签认、RES 转正式政策均须 owner/H3。
- **减席不减职责**：§2.3 的 owns 是唯一写域真源，subagent 写域越界=拒收；遇到「有重复」时静默 + 分工表写明，不新建席位。
- **证据纪律**（RT 抽核教训）：验收证据须带 commit/CI 锚；单样本不证 1:1 覆盖；FakeProvider/合成响应不得当「真实响应」证据；computed-style 证据须防 scale 绕过。
- 旧 agent 上下文没丢：roster.yaml + handoff/ + decisions.md 三层全在，prompts/ 已预打包，接续无需重跑历史决策。
