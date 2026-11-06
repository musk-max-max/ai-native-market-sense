# BOARD — market-sense-h5 团队状态板

> 更新：2026-11-06 · Lead 维护
> 编制唯一真源：`agents/roster.yaml`（本日重建为 **17 席**：L0 + H1–H4 + M1 + A1–A11）
> 任务细节：Team 任务板（`team_task_list`）；席位身份底稿：`agents/team-rebuild-2026-11-06/prompts/`
> 上一版快照：`agents/team-rebuild-2026-11-06/.snapshot-BOARD-v2026-11-04.md`

## 〇、2026-11-06 17:00 更新（L133，覆盖下文「已派出」旧状态）

- **轻量建队模式**（用户 quota 指令）：不批量常驻 teammate，17 席以 `roster.yaml` + `prompts/` 为真源台账，**按需逐席唤醒**（单席单任务）。下表「已派出」为上一会话遗留状态，该会话 teammate 已消亡，产物已留在工作树。
- **门禁核验（Lead 亲跑）**：typecheck 9 工程 ✅；`pnpm run test` 全绿 ✅（修 1 处旧席位断言 `infra/ci/test/mini-yaml.test.mjs` A13/H5→A8/H4）；首屏 JS 83.7KB gzip PASS（预算 200KB）。E2E（真栈 10 passed/1 skipped）待 A7 复跑。
- **P0 AI 卡状态**：`reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md` — AI-1/2/3 均**不签**，闭环判据挂 A3(/v1/ai/* 路由+留痕)/A4(AuditSink)/A6+A7(computed-style/E2E 证据)，H3 复核后解除。
- **唤醒优先序**：P0 AI 证据链（A3→A4→A7→H3）＞ P1 Console HTTP adapter（A6+A4）＞ AKshare（A1+A3）＞ 其余按需。

## 一、2026-11-06 轮次：重建 + P1

**依据**：`docs/HANDOFF-team-rebuild-2026-11-06.md`（§2 编制、§4 未完成、§5 交接顺序）。
**owner 口径**：交付目标 = 建队 + 推进 P1；编制 30 席 → 17 席；合并不减职责。

**本轮目标**
1. 编制收敛为 17 席，`roster.yaml` + `ownership.yaml` 同步重映射（旧 A0/A12–A23/H5/H6 不残留）。
2. 开工 P1：①antd 全家桶 ②C 端 5 tab ③Console 四中台接真实契约 ④AKshare 实时行情。
3. 门禁不回归：E2E 10 passed/1 skipped、contract 69 passed、首屏 JS ≤200KB gzip。

## 二、席位状态（17 席）

| 席位 | 角色 | DSH 成员 target | 模型（实际路由） | 本轮任务 | 状态 |
|---|---|---|---|---|---|
| L0 | 主 agent / 协调 | `lead`（宿主会话） | DeepSeek 系 | 编排、落账、验收、git 提交 | 进行中 |
| H1 | PM/PO | `h1-pm` | deepseek-flash（teammate） | task-10 PRD v2 backlog + P1 acceptance | 已派出 |
| H2 | 架构与技术负责人 | `h2-arch` | deepseek-flash（teammate） | task-2 antd 引入评估（ADR-009） | 已派出 |
| H3 | 合规负责人兼 DPO | `h3-compliance` | deepseek-flash（teammate） | task-11 AI-1/2/3 签发 + 视觉合规规格 | 已派出 |
| H4 | 数据负责人 + 安全运维 | `h4-data-security` | deepseek-flash（teammate） | task-12 tushare 授权三件台账 | 已派出 |
| M1 | UI/UX 设计（多模态） | 常驻 `subagent`（非 Team 成员） | SenseNova（MiMo 路由本会话不可用，见 §五） | task-1 antd 映射 + design tokens | 已派出 |
| A1 | 数据接入 + 调度 | `a1-data-ingest` | deepseek-flash（teammate） | task-6 AKshare + dc_member/dc_index 实测 | 已派出 |
| A2 | 数仓建模 + 指标 + 质量 | `a2-data-warehouse` | deepseek-flash（teammate） | task-8 serving 视图 + 质量门禁 | 已派出 |
| A3 | 后端·行情/内容/研究 | `a3-backend-market` | deepseek-flash（teammate） | task-7 行情接真实源 + as_of 口径 | 已派出 |
| A4 | 后端·用户/权限/审批/CRM | `a4-backend-identity` | deepseek-flash（teammate） | task-5 /v1/internal/* 契约对齐 | 已派出 |
| A5 | 后端·合规域 + 审计 | `a5-backend-compliance` | deepseek-flash（teammate） | task-13 control 心跳 + observed | 已派出 |
| A6 | 前端全栈（H5 + 中后台） | `a6-frontend` | deepseek-flash（teammate） | task-3 5 tab → task-4 Console 真契约 | 已派出 |
| A7 | QA·契约/数据/E2E | `a7-qa` | deepseek-flash（teammate） | task-9 P1 回归门禁 | 已派出 |
| A8 | SRE / 平台工程 | `a8-sre` | deepseek-flash（teammate） | task-14 path-guard + 部署冒烟 | 已派出 |
| A9 | 业务线·运营+管理员+拓客 | `a9-business-ops` | deepseek-flash（teammate） | task-15 三线可用性验收 | 已派出 |
| A10 | 研究·证券/标的/资金面 | `a10-research-equity` | deepseek-flash（teammate） | task-16 投研口径 + 首批研究 | 已派出 |
| A11 | 研究·宏观/政策 + 合规复核/红队 | `a11-research-macro-audit` | deepseek-flash（teammate） | task-17 研究 + 证据 + 红队 | 已派出 |

## 三、P1 四项 → 任务映射

| P1 项 | 主责 | 协作 | 任务 |
|---|---|---|---|
| antd 全家桶引入 | M1 产物 → H2 评估 → A6 落地 | H3（视觉规格）、owner（package.json） | task-1 / task-2 / task-3 |
| C 端导航 5 tab | A6 | M1（tab 规格）、A7（E2E 门禁） | task-3 / task-9 |
| Console 四中台接真实契约 | A6 | A3/A4/A5/A2（/v1/internal/*）、A9（运营验收） | task-4 / task-5 |
| AKshare 实时行情 | A1 | A3（serving 消费）、A2（质量）、H4（来源授权） | task-6 / task-7 / task-8 |

## 四、硬门禁（每轮必跑，不得下调）

- 首屏 JS ≤ 200 KB gzip：`node web/h5/scripts/check-budget.mjs`（H1 veto，不可上调）
- 契约测试 69 passed 不降；E2E 10 passed / 1 skipped 不降
- 403 = 无权展示：受限必须 403 `EntitlementRestricted`，禁止 200 + `is_entitled=false`
- AI 内容：标识 + 不可关闭免责 + `as_of`（c_end 由 H3 签、internal 由 owner 签）
- 发布签字归 H4；Lead 只在 owner 明确授权时代签（历史事故见 decisions.md L130）

## 五、平台限制（需 owner 知悉）

`spawn_teammate` 无 `model/provider` 参数，teammate 路由继承 profile 默认 `deepseek-flash`，**无法逐席指定 SenseNova/MiMo**。
- M1 改走 `subagent` 通道可指定路由；`mimo-v2.6-pro` 被 Session 拒绝、`mimo-v2.6-flash` 两次启动后无消息失败 → 本会话实际用 `sense/sensenova-6.8-flash` 跑 M1。
- 若要 15 席对齐 SenseNova：改 profile `subagent-spawn-in-process` 的 `agentOptions` + 重启 GUI，方案与回滚见 `agents/team-rebuild-2026-11-06/teammate-model-patch.snippet.yml`（未应用）。

## 六、沿用事实（2026-11-04 已验证，本轮不改）

- **本机无 docker 也能真栈**：brew postgresql@16 → `initdb -D .state/pgdata -U ms --auth=trust` → `pg_ctl -o "-p 55432 -k /tmp"` → `psql -f warehouse/dwd/schema.sql -f warehouse/serving/schema.sql` → `python3 -m warehouse.load` → API 8081 + web/h5 3000（反代 /v1）。
- E2E 复跑：`E2E_PG_DSN=postgresql://ms@localhost:55432/market_sense E2E_SKIP_PREFLIGHT=1 npx playwright test` → **10 passed / 1 skipped（P0-10 缺 replay 资产）**。记法：10/11 通过，不记「E2E 通过」。
- **M2 证据是合成数据**：截图 10.30 来自 `data/golden/p0_bars20.yaml`，只证明链路通/契约一致/护栏生效，不证明数据正确（DA 组不得用 golden 自证）。
- 发布卡点遗留：H5-R4 fail-open 默认值、`services/api/Dockerfile`、`errors.ts` 泄露「（F1）」、H4 三签（metrics 口径 / 因子锚点 / 质量分）、`.github/workflows` 从未在真 runner 跑过（不得记「CI 通过」）。
- F1 取数合规时间盒：11-12。

## 七、当前阻塞

| # | 阻塞 | 影响 | 需要谁 |
|---|---|---|---|
| 1 | tushare 官方授权三件（书面回复/条款文本/白名单+来源解耦） | C 端商用 residual 未闭环，11-12 时间盒 | H4 + owner |
| 2 | C 端 AI 展示卡 AI-1/2/3 未签 | H5 go-live 卡住 | H3 |
| 3 | antd 引入需 owner 确认 package.json | P1-4 落地前置 | H2 出评估单 → owner |
| 4 | 行情价格是 fixture | P1-7 数据正确性 | A1 + A3 |
| 5 | H4 三签（自 11-04） | 口径/锚点/质量分「按推荐执行、待追认」 | H4 |

## 八、下一手（L0）

1. 收 15 席 + M1 首单报告，核验产物与门禁数字；失败项重派或接管。
2. 审 `roster.yaml` / `ownership.yaml` 重写结果（17 席、reviewers ⊆ {H1..H4}、旧 id 不残留）。
3. 汇总 P1 交付状态 + P0 未闭环项给 owner。
4. 统一 git 提交（git 写由 L0 独占）。

## 九、变更记录

- 2026-11-06：按交接文档重建 17 席；15 个 durable teammate + M1 常驻 subagent 上岸；17 个任务派单；P1 四项进入执行。
