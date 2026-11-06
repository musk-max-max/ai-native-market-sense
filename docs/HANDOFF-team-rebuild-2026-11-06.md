# Market Sense 团队重建 · 交接文档

> 交接目的：新模型接管项目，按本文重建 agent 团队。编制从 31 席收敛到 **17 席**。
> 模型分配：**主 agent = DeepSeek**；**图文/设计/视觉相关 = 多模态 MiMo**；**其余全部 = SenseNova**。
> 生成日期：2026-11-06。交接人：原 Team Lead（lead）。

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

## 2. 新编制（17 席）

### 模型分配总表

| 模型 | 席位 |
|---|---|
| **DeepSeek**（主 agent / 协调） | L0 |
| **MiMo**（多模态，图文/设计/视觉） | M1 |
| **SenseNova**（其余全部） | H1–H4, A1–A11 |

### 席位清单

| ID | 角色 | 模型 | owns（写权限范围） | 由原编制合并自 |
|---|---|---|---|---|
| **L0** | 主 agent / 项目协调 | DeepSeek | 编排、跨席协调、落账 decisions.md | lead |
| **H1** | PM / PO（产品负责人） | SenseNova | PRD、backlog、验收标准、范围/优先级 | H1 |
| **H2** | 架构与技术负责人 | SenseNova | ADR、API 契约终审、模块边界、发布拓扑 | H2 |
| **H3** | 合规负责人（兼 DPO） | SenseNova | 产品表述边界、合规否决、redline/政策签发 | H3 |
| **H4** | 数据负责人 + 安全运维 | SenseNova | 数据源边界、授权合规、安全、发布签字 | H4 + H5 + A9 |
| **M1** | UI/UX 设计（多模态） | **MiMo** | `docs/design/`、`packages/design-tokens/`、组件映射 | A10 |
| **A1** | 数据接入 + 调度 | SenseNova | `services/ingest/`、tushare/AKshare 适配 | A1 |
| **A2** | 数仓建模 + 指标 + 质量 | SenseNova | `warehouse/`（ODS/DWD/ADS/serving） | A2 |
| **A3** | 后端 · 行情/内容/研究域 | SenseNova | `services/market/`、`services/ai/`、研究数据 serving | A3 |
| **A4** | 后端 · 用户/权限/审批/CRM | SenseNova | `services/identity/`、`services/approval/`、`services/crm/` | A4 + A6 |
| **A5** | 后端 · 合规域 + 审计 | SenseNova | `services/compliance/`、审计事件、entitlement gate | A5 |
| **A6** | 前端全栈（H5 + 中后台） | SenseNova | `web/h5/`、`web/console/` | A7 + A8 |
| **A7** | QA · 契约/数据/E2E | SenseNova | `tests/`、契约测试、E2E、C 端模拟用户 | A11 + A12 + A18 |
| **A8** | SRE / 平台工程 | SenseNova | 部署、CI、Docker、DB migration 执行 | A13 |
| **A9** | 业务线 · 运营 + 管理员 + 拓客 | SenseNova | 运营配置、审批操作、CRM 拓客流程 | A14 + A15 + A17 |
| **A10** | 研究 · 证券/标的/资金面 | SenseNova | 投研数据 BRD、标的/基金/资金面研究 | A20 + A22 |
| **A11** | 研究 · 宏观/政策 + 合规复核/红队 | SenseNova | 宏观政策研究、公开源检索供给；兼合规复核+对抗测试 | A21 + A23 + A16 + A19 |

> 编制合计 **17 席** = L0(1) + H1–H4(4) + M1(1) + A1–A11(11)。

### 裁掉的席位（并入关系）

- A9(安全) → 并入 H4
- A6(CRM 后端) → 并入 A4
- A7(H5 前端) + A8(中后台前端) → 合并成 A6 前端全栈
- A10(设计) → 升级为 M1 多模态设计席
- A11+A12(测试) + A18(模拟用户) → 合并成 A7 QA
- A14(运营) + A15(管理员) + A17(拓客) → 合并成 A9 业务线
- A20+A22(证券研究) → 合并成 A10
- A21+A23(宏观+检索) → 合并成 A11
- A16(合规复核) + A19(红队) → 并入 A11（研究宏观，兼合规复核/红队）

---

## 3. 每个席位的交接要点

### L0 主 agent（DeepSeek）
- 职责：编排、派活、跨席协调、维护 `agents/decisions.md`（已落 L1–L132 裁定）。
- **不能做的事**：不擅自代签 owner 专属权限（曾两次越权事故，记 L130：①误判授权覆盖 policy 代签 ②回滚误删 definition_refs）。
- 分区签发权：c_end 政策 = H3 签；internal 政策 = owner 签（Lead 只在 owner 明确授权时代签，且只填 status/signed_at 两字段）。

### H1 产品（SenseNova）
- owns PRD/backlog/验收。**关键产出**：`docs/requirements/prd-v2.md`（565 行，13 页面节/21 组件）。
- 范围口径：PRD 用 **Now/Next/Later**（交付批次）；BRD 用 P0/P1/P2（数据就绪度）。两套不可混用。
- **H1 veto 项**：首屏 JS 预算上限 200 KB，不可上调。

### H2 架构（SenseNova）
- owns ADR/契约终审。**关键产出**：ADR-001..008（`docs/adr/`）。契约在 `contracts/{shared,market,fundamental,watchlist,ai,config,approval}/openapi.yaml`。
- ADR-007：AI 网关独立服务 `services/ai/`。ADR-008：两类用户拆双轴（发布轴 RELEASE_RANK + 内部 user.internal_tier）。

### H3 合规（SenseNova）
- owns 表述边界/合规否决/政策签发。**只管 C 端**（内部不通知/不审批，见 L115/L116/L127）。
- 关键产出：`rules/redline-basis.json`（H3-C01..C12，v1.0.2）、`rules/ai-content-policy.json`（c_end 分区签）。

### H4 数据 + 安全运维（SenseNova）
- owns 数据源边界/授权合规/安全/发布签字。**合并了原 A9 安全**。
- **待办**：tushare 官方授权三件（书面回复/条款文本/白名单+来源解耦），11-12 到期。

### M1 设计（**MiMo**）
- owns `docs/design/` + `packages/design-tokens/`。**关键产出**：`system-v2.md`/`c-end-h5-v2.md`/`console-v2.md`/`antd-component-mapping.md`(59 条)/`token-integration.md`(404 行)。
- token 单源：`packages/design-tokens/tokens.json` 唯一真值 → 生成 tokens.css/antd-theme.mjs/adm-tokens.css。
- **边界**：不写 React/TS 实现代码（那是 A6 前端），不擅自改 package.json。

### A1 数据接入（SenseNova）
- owns `services/ingest/`。取数走 tuaremax.top mirror。**待办**：实测 dc_member/dc_index（owner 有 15000 积分）、AKshare 实时行情接入（替换 fixture 价格）。

### A2 数仓（SenseNova）
- owns `warehouse/`。已建成 ODS + 17 DWD 表 + serving 视图 + 23 RES 规则。

### A3 后端行情/研究域（SenseNova）
- owns `services/market/` + `services/ai/`。研究数据 serving（龙虎榜/资金面/margin/hk_hold）。
- **已知缺陷**：`services/market/src/routes.ts` 曾先 loadInstrument 再 requireEntitled（熔断 1011ms→修后 3ms）。

### A4 后端用户/审批/CRM（SenseNova）
- owns `services/identity/` + `services/approval/` + `services/crm/`。**CRM 契约设计稿未交**（原 A6 遗留，转 A0 评估）。

### A5 后端合规/审计（SenseNova）
- owns `services/compliance/`。审计 DDL 001/002/003 已封版。
- **待办**：control 心跳/observed 列两个基础设施缺口（本机栈实跑暴露）。

### A6 前端全栈（SenseNova）
- owns `web/h5/` + `web/console/`。**合并了原 A7+A8**。
- **当前状态**：C 端 6 页已通（`web/h5/src/App.tsx:27-76` 仅 3 链接，未达 5 tab）；Console 仍 MockBackend 未连 `/v1/internal/*`。
- **待办**：antd-mobile/antd 落地（依赖清单见 M1 token-integration.md）、新增 TabBar + `/ai` + `/me`。

### A7 QA（SenseNova）
- owns `tests/`。合并契约/数据测试 + E2E + C 端模拟用户。
- **当前**：E2E 10 passed/1 skipped（真栈）；contract 69 passed。

### A8 SRE（SenseNova）
- owns 部署/CI/Docker/migration 执行。**当前**：ECS `47.120.16.239`（SSH root 已禁改 lyuddu）五容器 healthy；GitHub `github.com/musk-max-max/ai-native-market-sense` 已连。

### A9 业务线（SenseNova）
- 运营配置 + 审批操作 + CRM 拓客。对齐最初「运营/管理员/拓客」诉求。

### A10 研究证券（SenseNova）
- 投研数据 BRD + 标的/基金/资金面研究。BRD 初稿 `docs/requirements/brd-c-end.md`(239 行 v1.1) 已归档。

### A11 研究宏观 + 合规复核/红队（SenseNova）
- 宏观政策研究 + 公开源检索供给；兼合规复核 + 对抗测试 + 政策抽核。证据登记簿 `reviews/compliance-policy-review/`（append-only）。
- **注意**：合规复核与宏观研究合并是减人安排，两者职责边界在排期时仍须分开跑（宏观研究不越权做合规签认，合规复核不越权做宏观研判）。

---

## 4. 未完成工作（按优先级）

### P0（阻塞 C 端上线）
1. **tushare 官方授权三件**（书面回复/条款文本/白名单+来源解耦）—— 11-12 到期，H4 催。
2. **C 端 AI 展示卡 AI-1/2/3 H3 未签**（签认≠C 端放行）。
3. **F1 取数合规**：无 tuaremax 书面转售授权 = residual 未闭环。

### P1（本轮主线）
4. **antd 全家桶引入**：M1 出映射+token 方案（已完成）→ A0/H2 评估体积与依赖 → A6 落地。改 package.json 须 owner 确认。
5. **C 端导航达 5 tab**：`web/h5/src/App.tsx:27-76` 现仅 3 链接，需 TabBar + `/ai` + `/me`。
6. **Console 四中台接真实契约**：现 MockBackend，需连 `/v1/internal/*`。
7. **AKshare 实时行情接入**：替换 fixture 价格（当前行情走 PG serving 视图，价格是假数据）。

### P2
8. A1 实测 dc_member/dc_index（15000 积分）；AKshare 接入。
9. H3 签免责/AI 标识/as_of 视觉规格（M1 只改数值口径未动文案）。
10. A4 CRM 契约设计稿。
11. control 心跳/observed 列基础设施缺口。
12. 越层授权台账落地（Leader>H4 内部授权层级作强制指令）。

---

## 5. 交接顺序（新模型接管步骤）

1. **读硬约束**（§1）—— 不可违反的红线。
2. **按 §2 重建 agent 团队**（17 席），按模型分配表给每个席位配模型。
3. **读 §4 未完成工作**，P0 三件先推进。
4. **读 `agents/decisions.md`**（L1–L132 裁定，跨整个项目的历史决策，避免重复裁定或推翻已定结论）。
5. **读关键产出文档**：PRD(`prd-v2.md`)/BRD(`brd-c-end.md`)/设计四件套(`docs/design/`)。
6. **本轮在途**：antd 落地（M1 已出方案，A6 待落地）。

---

## 6. 关键路径与文件索引

| 类别 | 路径 |
|---|---|
| 历史裁定 | `agents/decisions.md`（L1–L132） |
| PRD / BRD | `docs/requirements/prd-v2.md` / `brd-c-end.md` |
| 设计 | `docs/design/system-v2.md` / `c-end-h5-v2.md` / `console-v2.md` |
| antd 映射 / token | `design/antd-component-mapping.md` / `token-integration.md` |
| 合规红线 | `rules/redline-basis.json`（H3-C01..C12） |
| AI 政策 | `rules/ai-content-policy.json`（v1.1.2） |
| ADR | `docs/adr/ADR-001..008.md` |
| 审计 DDL | `services/compliance/migrations/001/002/003` |
| 取数配置 | `services/ingest/.env`（tuaremax token，.gitignore 已排除） |
| C 端截图 | `docs/screenshots/local-2026-11-06/` |
| 分工表（本轮） | `docs/roster-division-2026-11-06.md` |
| 本轮裁定 | `docs/decisions-2026-11-06-ui-round.md` |

---

## 7. 旧 agent 上下文历史地址（新 agent 打包 prompt 用）

> 用途：新 agent 接管时，按本表把**旧席位的上下文历史**抽取出来，打包成新席位的初始 prompt 输入。
> 上下文历史分三层：**①专属人设**（旧 roster.yaml 的 `mission`+`system_prompt` 块，逐字抽取）**②专属 handoff**（部分席位有独立 handoff.md）**③共享记忆**（decisions.md，全团队共用，每席都读）。

### 7.0 上下文历史的三类来源

| 层 | 文件 | 说明 |
|---|---|---|
| **①专属人设** | `agents/roster.yaml` | 每个 A 席有 `mission` + `system_prompt` 块。行号见 §7.1。逐字抽取作为新席人设底稿 |
| **②专属 handoff** | `agents/handoff/*-handoff.md` | 仅 5 席有：A6/A8/A14/A15/A16。已合并席要一并读 |
| **③共享记忆** | `agents/decisions.md`（L1–L131，1568 行） | **全团队共用**，每席都要读。89 条裁定记录 |
| **④编制手册** | `agents/README.md`（880 行手册 + roster 定义源说明） | 原编制的运行原则（人=责任主体，agent=产能单元，agent 不能签字） |

> **注意**：H1–H6 是人席，旧 roster 里**只有 role/authority/owns/must_decide/cannot_delegate，没有 system_prompt 块**（行 18–94）。新编制里这 4 席同样按职责定义，不抽 prompt。

### 7.1 旧 A 席 → 上下文历史行号（roster.yaml）

| 旧席 | 新归属 | mission 行 | system_prompt 行 | 专属 handoff |
|---|---|---|---|---|
| A0 | H2（架构，见 ADR） | 101 | 118 | — |
| A1 | A1（数据接入） | 135 | 149 | — |
| A2 | A2（数仓） | 165 | 180 | — |
| A3 | A3（行情/内容/研究） | 198 | 210 | — |
| A4 | A4（用户/权限/审批/CRM） | 225 | 237 | — |
| A5 | A5（合规/审计） | 253 | 265 | — |
| A6 | A4（并 CRM 后端） | 282 | 294 | **A6-handoff.md** |
| A7 | A6（前端 H5） | 310 | 322 | — |
| A8 | A6（前端中后台） | 339 | 351 | **A8-handoff.md** |
| A9 | H4（安全并入） | 368 | 380 | — |
| A10 | M1（设计，MiMo） | 396 | 408 | — |
| A11 | A7（QA 契约/数据） | 423 | 435 | — |
| A12 | A7（QA E2E） | 451 | 463 | — |
| A13 | A8（SRE） | 479 | 492 | — |
| A14 | A9（业务线·运营） | 510 | 522 | **A14-handoff.md** |
| A15 | A9（业务线·管理员） | 539 | 551 | **A15-handoff.md** |
| A16 | A11（合规复核） | 568 | 580 | **A16-handoff.md** |
| A17 | A9（业务线·拓客） | 596 | 608 | — |
| A18 | A7（QA·C端模拟用户） | 624 | 636 | — |
| A19 | A11（红队） | 652 | 664 | — |
| A20 | A10（研究·证券） | 687 | 718 | — |
| A21 | A11（研究·宏观） | 737 | 767 | — |
| A22 | A10（研究·标的/基金） | 787 | 815 | — |
| A23 | A11（研究·检索） | 832 | 865 | — |

### 7.2 新席位的上下文打包清单（逐席）

新席位接管时，把下列来源**合并**成该席的初始 prompt：

| 新席 | 抽取的旧席上下文（mission+system_prompt） | 额外 handoff | 共享记忆 |
|---|---|---|---|
| L0 | 原 lead（无 roster 块，读 decisions.md 全文） | — | decisions.md L1–L131 |
| H1 | 人席定义（roster 18–29） | — | decisions.md |
| H2 | 人席定义（30–41）+ A0 人设 | — | decisions.md + ADR-001..008 |
| H3 | 人席定义（42–53） | — | decisions.md + redline-basis.json |
| H4 | 人席 H4(54–65) + H5(66–77) + A9 人设 | — | decisions.md |
| M1 | A10 人设（396–419） | — | decisions.md + design/ 四件套 |
| A1 | A1 人设（135–164） | — | decisions.md |
| A2 | A2 人设（165–197） | — | decisions.md |
| A3 | A3 人设（198–224） | — | decisions.md + ADR-007 |
| A4 | A4(225–252) + A6(282–309) 人设 | **A6-handoff.md** | decisions.md |
| A5 | A5 人设（253–281） | — | decisions.md |
| A6 | A7(310–338) + A8(339–367) 人设 | **A8-handoff.md** | decisions.md + antd 映射/token |
| A7 | A11(423–450) + A12(451–478) + A18(624–651) 人设 | — | decisions.md |
| A8 | A13 人设（479–509） | — | decisions.md |
| A9 | A14(510–538) + A15(539–567) + A17(596–623) 人设 + H6 人席定义(78–94) | **A14/A15-handoff.md** | decisions.md |
| A10 | A20(687–736) + A22(787–831) 人设 | — | decisions.md |
| A11 | A21(737–786) + A23(832–865) + A16(568–595) + A19(652–686) 人设 | **A16-handoff.md** | decisions.md |

### 7.3 打包 prompt 的格式建议

给每个新席位组装初始 prompt 时，按此顺序拼接：

```
[角色] 新编制席位 ID + role（见 §2 席位清单）
[模型] 分配的模型（DeepSeek/MiMo/SenseNova）
[专属人设] 旧席 mission + system_prompt 原文（见 §7.1 行号，逐字抽取）
[专属 handoff] 若有，读对应 handoff.md（见 §7.1 末列）
[合并说明] 若是新合并席，列出"你是 X+Y 合并，两块职责都要扛"（见 §7.2）
[共享记忆] decisions.md L1–L131（至少读与本席 owns 相关的裁定）
[硬约束] §1 的 6 条红线（每席都附）
[未完成] §4 中与本席 owns 相关的待办
```

---

## 8. 交接人备注（给新模型的话）

- 项目已跑通真栈（PG@55432 + API@8081 + Web@3000），E2E 10 passed。基础设施可用。
- **owner 是最终决策者**。Lead 只在 owner 明确授权时代行特定动作（如 policy internal 代签），不可自作主张扩权（历史事故 L130）。
- 编制从 31 收敛到 17 是为解决职责重叠（前端 3 并 1 / 后端 4 并 2 / 测试 3 并 1 / 研究 3 并 2 / 安全+合规复核并入）。**不要在合并席位里丢掉原 owns 范围**——合并是减人不减职责。
- 遇到「有重复」时优先**静默 + 在分工表写明**，而不是新建席位。
- **旧 agent 的上下文历史没有丢**：全部在 `agents/roster.yaml`（A0–A23 的 mission/system_prompt）+ `agents/handoff/`（5 席）+ `agents/decisions.md`（共享）。新 agent 按 §7 逐席抽取打包即可无缝接续，不需要重跑历史决策。
