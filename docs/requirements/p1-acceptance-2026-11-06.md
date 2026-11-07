# P1 产物验收结论清单（2026-11-06，H1 归口）

- **性质**：本轮 P1 产物验收记录，对照 `docs/requirements/prd-v2.md`（§8.3 Now 范围、§10 P1 四条主线 AC、§9.2 三条不可破契约）。
- **验收人**：H1（PM/PO，验收签字不可delegate）；**验收时间**：2026-11-06 17:30 前后（北京时间）。
- **验收对象（本轮交付声明，来自 L0 派单）**：① C 端 5 tab 已落地（`web/h5/src/App.tsx` + `web/h5/src/components/TabBar.tsx`）；② Console 骨架已落（`web/console/src/`）；③ antd 未引入。
- **证据等级**沿用 prd-v2 §10.0：A=自动门禁实跑通过；B=命令可复跑未接 CI；C=未测量（写「未验证+原因」）。
- **状态词表**沿用 `docs/requirements/go-live-blockers.md` §0.3：PASS / PARTIAL / FAIL / PENDING-<责任人>。

---

## 0. 总判定

| # | 交付声明 | 判定 | 一句话结论 |
| --- | --- | --- | --- |
| 1 | C 端 5 tab 已落地 | **PARTIAL**（实现面 PASS，证据面 PENDING-A7） | 5 tab/5 路由/深链映射/文案顺序已实现、本地门禁全绿；E2E、375×667、深色、首屏 6 元素实测证据未出 |
| 2 | Console 骨架已落 | **PASS（骨架级）** | 5 页 + 四中台分组导航 + design-system/domain/mocks 齐；默认仍 `MockBackend`（P1-6 未开工，属预期状态） |
| 3 | antd 未引入 | **PASS（事实确认）** | 两 package.json 无 antd/antd-mobile 依赖，web 源码无 antd import；符合「改 package.json 须 owner 确认」纪律 |

> **工程验收 ≠ go-live 放行**（prd-v2 §10.6）：本清单全绿也不构成上线；G1/G2/G3 三主卡状态不变，见 `docs/requirements/go-live-blockers.md`（均未闭环）。

---

## 1. C 端 5 tab 逐条 AC（prd-v2 §10.2）

| AC | 标准 | 证据（2026-11-06 H1 亲验） | 等级 | 判定 |
| --- | --- | --- | --- | --- |
| AC-P15-1 | 5 tab 文案顺序固定；5 路由直达非 404 | 文案顺序 `web/h5/src/lib/copy.ts:173-177`（`行情/自选/组合/AI/我的`）+ `TabBar.tsx` `TABS` 顺序一致；路由 `web/h5/src/lib/router.tsx` `parseRoute` 含 `/ai`、`/me`，`App.tsx` 8 分支渲染 `AiHomePage`/`MePage`；**运行级**复核：node 载入 parseRoute/tabKeyForRoute 实测 `/`→home、`/watchlist`→watchlist、`/review/portfolio`→portfolio、`/ai`→ai、`/me`→me 均直达渲染（非 notFound） | B（e2e 运行级 PENDING-A7） | **PARTIAL** |
| AC-P15-2 | 深链激活 + `tabKeyForRoute` 显式映射 | `TabBar.tsx:38-53` 显式映射：`/stocks/:id`→market ✓、`/review/limits`→**market（行情）**（勘误①）；激活态载体 `aria-current="page"`（勘误②）；实测 `tabKeyForRoute(parseRoute('/stocks/SSE:600519'))=market`、`('/nope')=null` | B（e2e 断言 PENDING-A7） | **PARTIAL** |
| AC-P15-3 | `/ai` 壳：空态 + 每条 AiGeneratedBadge/AI 免责/as_of 展示位 + 缺口卡；不接生成 | `web/h5/src/pages/AiHomePage.tsx`：列表空态（`copy.aiHome.aggregateEmpty`）+ `DataGapCard reason="not_integrated"`（受控枚举内，对应 §3.6「unavailable」状态）+ 明示「本页不展示模型生成文案」；**零伪造 AI 文案** ✓；条目模板（`AiAnalysisList`/`AiContentBlock`，badge/as_of/免责展示位）未建——空列表下「每条」类要素不渲染，模板随生成层（Next）落 | B | **PARTIAL**（附条件，见勘误⑤） |
| AC-P15-4 | `/me` 壳：登录态、我的自选入口、退订入口置顶不可隐藏、免责版本、数据来源说明 | `web/h5/src/pages/MePage.tsx`：退订区**置顶**（`#unsubscribe`）✓、账户/登录态 ✓、免责摘要 ✓、全站 footer 退订入口可点（`App.tsx` footer `Link`）✓；**缺**：我的自选入口（无 /watchlist 链接）、免责声明 version 号展示、`COPY_VERSION` 展示、数据来源说明独立条（footer meta 部分覆盖） | B | **PARTIAL**（PENDING-A6 补 4 尾项，见勘误③④） |
| AC-P15-5 | 375×667 无横向滚动、5 tab 不换行重叠、深色可用 | 未验证：真栈/浏览器环境未起，无 viewport 与 dark emulation 证据 | C | **未验证**（PENDING-A6/A7） |
| AC-P15-6 | E2E 基线 11 passed/1 skipped 不降 | 未验证：`tests/e2e` 需真栈（PG@55432/API@8081/Web@3000），curl 实测 3 端口均无响应；按交接纪律未自行起共享环境。基线 `tests/e2e/E2E-RUN-2026-11-04-native.md` §2c 在档 | C | **未验证**（PENDING-A7，task-9） |

**P1-5 整体判定：PARTIAL**——实现面（5 tab/路由/映射/文案）PASS，证据面（E2E/viewport/深色/首屏实测）PENDING-A7；另 4 项 `/me` 尾项 PENDING-A6。**不得记「已完成」**。

---

## 2. §9.2 三条不可破契约对照（破一条即 P0 不通过）

| # | 契约 | 核验 | 判定 |
| --- | --- | --- | --- |
| ① | `data-testid`/`aria-*` 不丢 | `node web/h5/scripts/check-testids.mjs` = **PASS（59 个 id 与 `tests/e2e/testids.json` 对齐）**；`disclaimer-close` 不渲染（门禁规则覆盖）✓ | **PASS**（B） |
| ② | 403 语义不被组件吃掉 | 本轮未动受限路径（`EntitlementNotice` 原样保留）；受限档 E2E（E2E-P0-06/12）未复跑 | **未验证**（C，PENDING-A7 复跑） |
| ③ | 个股页首屏 6 元素 390×844 免滚动可见 | TabBar（50px+safe-area）新增挤压竖向空间，风险实存；未实测 | **未验证**（C，PENDING-A7 实测留图，按 §9.2 ③：放不下砍装饰/间距，不砍 6 元素、免责不折叠） |

---

## 3. Console 骨架验收（prd-v2 §2.2/§3.9–3.13 + §10.3 现状）

| 核对项 | 证据 | 判定 |
| --- | --- | --- |
| 五页齐 + 四中台分组 | `web/console/src/pages/` Overview/ConfigEditor/ApprovalQueue/Compliance/Crm 5 页；`App.tsx:25-30` `GROUP_LABEL` = `ops=运营/admin=管理/compliance=合规/crm=CRM`，与 §2.2 一致；approvals 侧栏 `pendingCount` 徽标在 | PASS |
| 状态机/留痕组件骨架 | `web/console/src/domain/`（registry/state-machine/diff/impact/validation）+ `design-system`（AppShell/DataTable/DiffViewer/DoubleConfirm 等）；单测含「不能跳步」「发布门禁」「锁定项永不在可配置列表」 | PASS |
| AC-P16-1 默认数据源真实化 | `web/console/src/App.tsx:20` 仍 `const services: ConsoleServices = new MockBackend({ seedDemoApprovals: true });` | **本轮按预期不满足**（P1-6 未开工）→ PENDING-A6 |
| 契约映射准备 | `web/console/src/mocks/CONTRACT-MAP.md`（L133：映射已更、HTTP adapter 未落） | PASS（准备度） |

**骨架判定：PASS（骨架级）**；P1-6 整体 = PENDING-A6（HTTP adapter 默认化）+ PENDING-A4（`/v1/internal/configs|approvals|releases` 实现、409 三点合并、403 矩阵）+ PENDING-H2（合规审计 openapi 契约缺口，prd-v2 §10.3 前置缺口）。**禁止用 Mock 充当 P1-6 通过**（§10.3 纪律）。

---

## 4. antd 未引入确认（prd-v2 §10.1）

- **依赖核**：`web/h5/package.json` 依赖仅 react/react-dom/@market-sense/api-client；`web/console/package.json` 仅 react/react-dom——**无 antd/antd-mobile**。
- **源码核**：`web/*/src` 无 antd import；仓库内 antd 字样仅 `packages/design-tokens/`（M1 的映射+token **预生成产物**：`dist/antd-theme.mjs`、`dist/adm-tokens.css`、`tokens.json`），未被 web 消费。
- **判定**：事实成立，且符合 `docs/roster-division-2026-11-06.md` §三「改动 package.json 前须 owner 确认」纪律。**P1-4 = PENDING-owner**（前置链：H2 评估单（ADR-009，在途）→ owner 确认 package.json → A6 落地）。
- **AC-P14-1..7 全部未开工（预期状态）**；接入前预算基线本轮实测 **83.7 KB gzip**（§5），较 prd-v2 §9.4 记录的 79.1 KB 已增长（5 tab/页壳新增所致），余量 116.3 KB 充足；AC-P14-2 引入后必须复测留数。

---

## 5. 门禁实跑记录（2026-11-06，H1 亲跑）

| 命令 | 结果 | 等级 |
| --- | --- | --- |
| `pnpm -C web/h5 typecheck` | exit 0 | A |
| `pnpm -C web/h5 test` | **25 pass / 0 fail** | A |
| `node web/h5/scripts/check-testids.mjs` | **PASS：59 个 id 对齐**（关闭件按规则不渲染） | B |
| `node web/h5/scripts/check-budget.mjs` | **PASS：83.7 KB gzip / 200 KB**（vendor-react 67.1 + index 14.1 + vendor 2.6；余 116.3 KB） | B |
| `pnpm -C web/console typecheck` | exit 0 | A |
| `pnpm -C web/console test` | **16 pass / 0 fail** | A |
| 运行级路由/映射复核（node 载入 parseRoute/tabKeyForRoute） | 8 用例全符合预期（含 `/ai`、`/me` 直达；`/nope`→notFound） | B |
| `pnpm -C tests/e2e test` | **未验证**：真栈未起（PG@55432/API@8081/Web@3000 curl 无响应）；交接纪律「不自行改共享环境」，已报 L0 | C |

---

## 6. 偏差与勘误（H1 裁定，全部留痕）

1. **勘误①（PRD 已改）**：AC-P15-2 原写「`/review/limits`→组合」，与 §9.1 #1（「`/review/limits` 归入「行情」tab」）、设计 v2 `docs/design/c-end-h5-v2.md:153`（「review/limits 归到 market」）、实现三方冲突 → 按 §9.1 裁定改「→行情」。实现无改动。
2. **勘误②（PRD 已改）**：AC-P15-2 原写 `aria-selected="true"` + `[data-testid=tabbar]`，与 §5.3（`nav` role + `aria-current`）冲突；链接式导航 `aria-current="page"` 才是正确语义 → 状态载体勘误为 `aria-current="page"`。E2E 锚点先用 nav 语义选择器；A7 若需 testid 再在 `tests/e2e/testids.json` 注册 `tabbar` 并由 A6 补挂；**antd-mobile 落地时 §9.1 约束②（包装层输出 testid）不变**。
3. **裁定③（/me 退订「可点」口径）**：footer 全站退订入口可点且可达 `/me#unsubscribe` + `/me` 退订区置顶不可隐藏 = 满足「存在且可点」；**退订动作**待退订契约定义后由 A6 落地，禁止假按钮（`copy.me.unsubscribePending` 已明示不造假按钮，符合「不伪造」纪律）。
4. **偏差④（PENDING-A6）**：`/me` 缺「我的自选入口」「免责 version」「COPY_VERSION」「数据来源说明」4 尾项，列 P1-5 尾项表。
5. **偏差⑤（记录）**：`/ai` 壳未建条目模板（badge/as_of/免责展示位）→ 随生成层（Next）同批；但 AI 证据链判据 AI2-1 的 `ai-as-of` testid 注册属 P0（backlog P0-2），优先级高于页面模板。
6. **台账勘误⑥（已报 L0 转 H3，H1 不动 reviews/ 域）**：`reviews/compliance/AI-CARD-CLOSURE-TRACKER-2026-11-06.md` AI2-1 缺证现状行写「`App.tsx` 仅 6 条路由无 `/ai`」已过时——`/ai`、`/me` 壳已落，App.tsx 现 8 个路由分支；判据本身仍 OPEN（`ai-as-of` testid 未注册、模型文本路径缺），不影响 P0-2 状态。

---

## 7. 结论与下一步

- 本轮 3 项交付声明**成立**（5 tab 实现面 / Console 骨架 / antd 未引入）；P1-5 整体 **PARTIAL**，P1-4 **PENDING-owner**，P1-6 **PENDING-A6/A4**，P1-7 **PENDING-A1/A3**（详见 `docs/requirements/backlog.md`）。
- 本清单为工程验收记录，**不构成 go-live 放行**；G1/G2/G3 见 `go-live-blockers.md`（G2 = P0 AI 证据链，为当前唤醒第一优先）。
- 下一步顺序（对齐 BOARD 唤醒序）：**P0 AI 证据链（A3→A4→A7→H3）> P1 Console adapter（A6+A4）> P1-5 尾项 + E2E 证据（A6+A7）> AKshare（A1+A3）> antd（owner 确认 package.json 后 A6）**。
