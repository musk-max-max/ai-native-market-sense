# market-sense-h5 · 团队状态板

> 更新：2026-11-04 08:12 · Lead 维护
> 编制：6 个人类席位 + 20 个 agent = 26 个 durable teammate
> 决策源：`agents/decisions.md`（§0.5 已裁定 C1/C2/13 条；§9 记录 L1–L10 工程裁定）

## 一、人类席位

| 席位 | 角色 | 否决范围 | 状态 |
|---|---|---|---|
| H1 PM/PO | 产品负责人 | 范围、优先级、验收、预算、排期 | 已拍板；已会签 `docs/p0-acceptance.md` |
| H2 架构与技术 | 技术负责人 | 契约、技术栈、部署形态、agent 接入 | 已拍板；已会签 L6（ownership 补 5 目录） |
| H3 合规与 DPO | 合规 | 表述红线、牌照、AI 内容、留痕、PII | 已拍板；红线待落机器可读规则文件（A5 执行） |
| H4 数据负责人 | 数据 | 授权路径、口径、质量阈值 | **欠三签**：`docs/metrics` 口径、L3 因子锚点、L9 质量分只计 blocker |
| H5 安全运维与发布 | 安全/发布签字 | 认证、分级、发布卡点、SLO | 已拍板；SLO 已按 C2=A 改为「收盘后 ≤15min」 |
| H6 业务线 Owner | 业务验收 | 可配项、审批流、客户旅程、触达 | 已拍板（P2 阶段才真正启用） |

## 二、Agent 状态

| ID | teammate | 角色 | 阶段 | 状态 |
|---|---|---|---|---|
| A0 | a0-arch-contract | 架构 / 契约 owner | P0 | **在跑**：建 `services/api` 外壳（插件注册表 + 错误映射） |
| A1 | a1-data-ingest | 数据接入 + 调度 | P0 | **在跑**：adapter / ODS / 限流 80% / checkpoint；mypy 已过；欠回补预算表 |
| A2 | a2-data-warehouse | 数仓 + 指标 + 质量 | P0 | ✅ task-6 完成；待补 ST 5% 样本 + golden README + serving 接口 |
| A3 | a3-backend-market | 后端 行情 / 内容 | P0 | **在跑**：task-5 后端（HTTP 层 + 403 矩阵 + 端口注入） |
| A4 | a4-backend-identity | 后端 用户 / 权限 / 审批 | P2 | 待命 |
| A5 | a5-backend-compliance | 后端 合规域 | P2 | 待命（等 H3 规则文件） |
| A6 | a6-backend-crm | 后端 CRM 域 | P3 | 待命 |
| A7 | a7-frontend-h5 | 前端 H5 | P0 | **在跑**：task-5 前端（路由 + testid + 数据网关 + mock） |
| A8 | a8-frontend-console | 前端 中后台 | P2 | 待命 |
| A9 | a9-security | 安全 | P0 | 待命（等 A0 外壳 + A4 权限模型） |
| A10 | a10-design | UI/UX | P2 | 待命 |
| A11 | a11-qa-contract-data | 测开 契约 + 数据 | P0 | ✅ task-4 完成：契约 32 项 + 数据 78 项，含变异自证 |
| A12 | a12-qa-e2e | E2E | P0 | ✅ task-7 完成：compose 6 服务 + 11 用例 + RUNBOOK + reason code |
| A13 | a13-sre | SRE | P0 | **在跑**：task-2（CI 工具链：path-guard / typecheck / redocly） |
| A14–A19 | 运营 / 管理员 / 合规复核 / 拓客 / 模拟用户 / 红队 | — | P2–P3 | 待命 |

## 三、任务板

| 任务 | Owner | 状态 |
|---|---|---|
| task-1 骨架 + 契约 + ADR | A0 | ✅ |
| task-2 CI + IaC + SLO | A13 | 进行中 |
| task-3 最小数据链路 | A1 | 进行中 |
| task-4 门禁与 fixture | A11 / A12 | ✅ |
| task-5 竖切片 | A3 + A7 | 进行中 |
| task-6 数仓链路 | A2 | ✅ |
| task-7 真栈 E2E | A12 | ✅ |

## 四、当前阻塞

| # | 阻塞 | 影响 | 需要谁 |
|---|---|---|---|
| 1 | **本机无 docker**（node/pnpm/python/oasdiff 齐全；磁盘剩 11G） | 真栈 E2E 一次未真跑，M2 验收无实据 | 用户决定装 colima / Docker Desktop，或走远端 CI |
| 2 | H4 三处会签未签 | 口径、因子锚点、质量分口径处于「按推荐执行、待追认」 | H4 |
| 3 | H2 会签 L6 | ownership 有 5 个目录靠 Lead 代批 | H2 |
| 4 | `.github/workflows` 仍空 | CI 门禁只在本机跑过 | A13 |

## 五、已验证事实（Lead 亲自跑）

- `pytest tests/contract tests/data warehouse/tests` → 151 passed（agent 写入期间会有瞬时失败，需在静止态复验）
- `pnpm -r typecheck` → api-client / web-h5 / ingest 全部通过
- `oasdiff 1.35.0` 对四域「No breaking changes」；redocly 0 error

## 六、2026-11-04 E2E 首次真跑（推翻阻塞 #1）

本机 **无 docker 也能真栈**：`brew install postgresql@16` → `initdb -D .state/pgdata -U ms --auth=trust` → `pg_ctl -o "-p 55432 -k /tmp"` → `psql -f warehouse/dwd/schema.sql -f warehouse/serving/schema.sql` → `python3 -m warehouse.load --dsn postgresql://ms@localhost:55432/market_sense` → `services/api`（8081）+ `web/h5/server.mjs`（3000 反代 /v1）。

`E2E_SKIP_PREFLIGHT=1 E2E_AUTH_TOKEN=dev-token npx playwright test`：

| 结果 | 用例 | 说明 |
|---|---|---|
| ✅ 通过 8 | P0-00..P0-07 | 含 as_of 严格相等、stale 双向一致、免责版本一致、restricted 403 矩阵 |
| ❌ 失败 1 | P0-08 | 首跑时 `lib/harness.js:128` 的 `dbQuery` 写死 `docker compose exec psql`；A12 增加 `E2E_PG_DSN` 直连分支后**已转绿** |
| ⏸ 未运行 2 | P0-09 / P0-10 | 首跑未运行；P0-09 已随 P0-08 转绿，P0-10 仍缺 replay recordings |

**二次复跑（A12 修 harness 后，Lead 执行）**：`E2E_PG_DSN=postgresql://ms@localhost:55432/market_sense E2E_SKIP_PREFLIGHT=1 npx playwright test` → **10 passed / 1 skipped (5.2s)**。跳过的是 P0-10（`replay ready=false`）。

证据截图：`/tmp/real-stack.png`（贵州茅台 10.30 元 / -1.90% / as_of 2024-01-04T15:00 / 来源「平台行情（收盘）」）。
**结论**：M2 验收已有实据。**记法：10/11 通过（1 条因缺 replay 资产跳过），不记作「E2E 通过」**——资产缺口与环境缺口不是一回事。

## 七、阻塞更新

| # | 阻塞 | 变化 |
|---|---|---|
| 1 | 本机无 docker | **已降级**：真栈改走本机 PG + 直连 DSN，不再阻塞；compose 路径仍未验证 |
| 2 | H4 三签 | 未变 |
| 3 | H2 会签 L6 | 未变，新增 `lot_size` 删字段待 H2 |
| 4 | `.github/workflows` | **已交付**（5 个 workflow，actionlint 通过），但**从未在真 runner 跑过**（仓无 remote），不得记「CI 通过」 |
| 5 | **H5-R4 fail-open 默认值** | 新增，P0 发布卡点：tier 缺省 `c_end_display` / 无到期时间盒 / Helm 未注入 → 已派 A3+A13 |
| 6 | `services/api/Dockerfile` 缺失 | 新增，E2E compose build 不起来 → 已派 A0 |
| 7 | `errors.ts` 泄露「（F1）」与 `title=error.message` | 新增，H3/H5 判为对外泄露供应商标识，非 UX 问题 → 已派 A0 |


## 八、验收口径更正（2026-11-04，H1）

- `docs/p0-acceptance.md` **已会签**；R-1 已登记为「发布卡点」，不关闭不发版。
- **Dlv-4 未达成**：文档写"11 条全过"，实际 10/11（P0-10 缺 fixture）。**不签降级**。
- **M2 证据是合成数据**：截图里 `SSE:600519` 收盘 10.30 来自 `data/golden/p0_bars20.yaml:32`，与真实 2024-01-04 收盘（约 1685）无关。M2 证明的是「链路通 / 契约一致 / 护栏生效」，**不证明数据正确**；DA 组不得用 golden 自证（循环论证），需 A1 回补样本。
- AC 分类更正：AC-6（自选三处一致）与 AC-9（79.1KB gzip）**已有证据**；AC-7（零裸 fetch）当前为真但**无 CI 门禁**；AC-1b 只有单测、无 E2E；AC-10 纯纸面（口径已定：390×844、不节流、3 次中位数 ≤3000ms）。
- 仓库根收集 `services/*/tests` 会 `ModuleNotFoundError: market_ingest` —— 验收要求"第二个人能复现"，需 A13 固化命令。


## 九、当前状态快照

见 `docs/release/S0-STATUS.md`（Lead 亲验，2026-11-04 08:40）：typecheck 5/5、pytest 227+121、E2E 10/11；M2 为合成数据；F1 11-12 时间盒；CI 未真跑。
