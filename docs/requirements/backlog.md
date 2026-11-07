# Backlog（H1 归口 · 2026-11-06 更新）

- **性质**：执行优先级 backlog（承接 `docs/HANDOFF-team-rebuild-2026-11-06.md` §4 未完成工作编号）。此前无独立 backlog 文件，条目散于 HANDOFF §4 / `agents/BOARD.md` §三，本文件为唯一执行台账。
- **口径纪律**（prd-v2 §8.0）：本文件 P0/P1/P2 = 执行优先级，**≠** BRD 数据就绪度 P0/P1/P2；交付批次只用 PRD §8.3 的 Now/Next/Later。
- **状态词表**（go-live-blockers §0.3）：PASS / PARTIAL / FAIL / PENDING-<责任人>。
- **维护**：H1。状态变更须挂证据（路径+命令输出）；引用纪律 L75（未亲验不引用）。

---

## P0（阻塞 C 端 go-live，= 三主卡 G1/G2/G3，详见 `go-live-blockers.md` §1）

| 编号 | 事项 | 现状（2026-11-06） | 关闭条件 / 下一步 | 责任 |
| --- | --- | --- | --- | --- |
| P0-1 | G1 tushare 授权三件（书面回复 / 条款文本 / 白名单+来源解耦） | PENDING-H4；①②未入档，③ PARTIAL（mirror `tuaremax.top` 无转售授权 = residual 未闭环）；deadline **11-12** | 三件入档 `security/`；或切回官方端点由①覆盖 + 全量回补 | H4 + owner |
| **P0-2** | **G2 AI 证据链（AI-1/2/3 签发）** | **三项均不签**（`reviews/compliance/AI-CARD-SIGNOFF-2026-11-06.md`）；闭环判据台账 `reviews/compliance/AI-CARD-CLOSURE-TRACKER-2026-11-06.md` | 证据链顺序（BOARD 唤醒序第一）：**A3**（/v1/ai/* 路由 + `audit.ai_generation_events` 生成/展示留痕）→ **A4**（AuditSink/契约落库）→ **A6+A7**（computed-style/E2E 证据：`ai-as-of` testid 注册、无 as_of 不渲染负例、13px 字号修复清单见 tracker AI3-1）→ **H3** 复核逐卡解除 | A3→A4→A6/A7→H3 |
| P0-2 证据收件 | E-AI1-01（A3）、E-AI2-01（A6/A11/A12）、E-AI2-02（A7）、E-AI3-01（A6/A7） | E-AI1-01 **在途**；其余 3 件 **未提交** | 证据到件 → H3 逐条对照 tracker「验收口径」列 | 各 owner |
| P0-3 | G3 F1 取数合规二选一（(a) 授权覆盖 mirror / (b) 只覆盖官方端点） | PENDING-owner：L127/L131 Open⑤ 未答；F1 只关「对外」一半 | owner 书面回执入档 → A3 落 entitlement/白名单/403 文案 → 真栈 403 矩阵复跑 | owner → L0 → A3 |

> P0-2 与 P1-5 的关系：`/ai` 页面壳（Now）不展示模型生成内容，不被 G2 阻塞；但「AI 内容对 C 端可见」以 G2 关闭为前提。AI-4（措辞扫描）DONE ≠ G2 关闭。

---

## P1（本轮主线剩余；验收现状见 `p1-acceptance-2026-11-06.md`）

### P1-4 antd 全家桶引入 —— **PENDING-owner**（阻塞：package.json 须 owner 确认）

| 尾项 | 现状 | 下一步 | 责任 |
| --- | --- | --- | --- |
| **antd 待 owner 确认 package.json** | 两 package.json 无 antd/antd-mobile（2026-11-06 核）；M1 映射+token 方案已出（`packages/design-tokens/` 预生成产物） | H2 评估单（ADR-009，task-2 在途）→ **owner 确认** → A6 落地（h5 加 antd-mobile 5.43.x、console 加 antd 5.29.x，以评估单为准） | H2 → owner → A6 |
| AC-P14-1..7 | 未开工（预期） | 落地后必跑：`check-budget.mjs` 复测（基线 83.7KB gzip，**200KB 不上调，H1 veto**）、`check-testids.mjs`、§9.2 三条对照、Console 不退化断言 | A6 / A8 / A7 |

### P1-5 C 端 5 tab + `/ai` + `/me` 页面壳 —— **PARTIAL**（实现 PASS，证据 PENDING）

| 尾项 | 现状 | 下一步 | 责任 |
| --- | --- | --- | --- |
| `/me` 补 4 尾项：我的自选入口、免责 version 号、COPY_VERSION、数据来源说明独立条 | 未落（p1-acceptance 勘误④） | A6 补齐后随 e2e 复验 | A6 |
| `/ai` 条目模板（`AiAnalysisList`/`AiContentBlock`：badge/as_of/免责展示位） | 未建（空壳合规，不伪造） | 随生成层（Next）同批；**`ai-as-of` testid 注册提前**（P0-2 判据 AI2-1） | A6 |
| E2E 证据：AC-P15-1/2 运行级断言、AC-P15-5（375×667 + 深色）、AC-P15-6 基线 11p/1s 不降、§9.2③ 首屏 6 元素 390×844 实测留图 | 全部未验证（真栈未起） | A7 task-9：`specs/p1-*.spec.js` + 证据落 `tests/e2e/evidence/` | A7 |
| §9.2② 403 语义复验（受限档 E2E-P0-06/12 复跑） | 未复跑 | 随 task-9 一并 | A7 |

### P1-6 Console 四中台接真实 `/v1/internal/*` —— **PENDING-A6/A4**

| 尾项 | 现状 | 下一步 | 责任 |
| --- | --- | --- | --- |
| HTTP adapter 默认化（AC-P16-1） | `web/console/src/App.tsx:20` 默认 `new MockBackend(...)`；`CONTRACT-MAP.md` 映射已备 | 默认走 `src/adapters/http-config-service.ts`，mock 仅显式开关 | A6 |
| `/v1/internal/configs|approvals|releases` 实现 + 409 三点合并 + 写路径乐观锁 + 403 矩阵（AC-P16-2..4） | 契约在（`contracts/config/openapi.yaml`、`contracts/approval/openapi.yaml`），实现未见 | A4 task-5；契约测试基线 63+ 不降 | A4 |
| 合规审计 openapi 契约缺口（`contracts/` 无审计契约） | 缺口（prd-v2 §10.3 前置） | H2 定契约 → A4 实现；缺口关闭前该子项记「未验证+原因」 | H2 → A4 |
| 审批留痕不退化断言（AC-P16-6：审计表列序/分页、human/agent 区分、DoubleConfirm 两步、Modal 顶部 DiffViewer） | 单测覆盖状态机/锁定项；UI 断言未出 | `pnpm -C web/console test` 扩展 + e2e | A6 / A7 |

### P1-7 行情/基本面真实数据 + as_of 口径 —— **PENDING-A1/A3**（BOARD 阻塞 #4：价格仍是 fixture）

| 尾项 | 现状 | 下一步 | 责任 |
| --- | --- | --- | --- |
| AKshare 依赖落地（AC-P17-6） | `python3 -c "import akshare"` = ModuleNotFoundError | A1 落 pin 可安装，或定案 mirror 适配器并写进报告 | A1 |
| 无 fixture 兜底 + as_of 严格批次 + 403 顺序（AC-P17-1..3） | 工程口已真实化（pg-serving-repo 取数、as_of 取自行值），证据未出 | A3 单测三态 + 间隔请求断言 + spy 顺序 | A3 |
| golden 30/30 + bars 溯源（AC-P17-4）、限流降级（AC-P17-5） | 待复跑留数 | A2/A3 按既有命令输出 | A2 / A3 |

---

## P2（不排期；索引不重复维护）

- PRD §8.3 Later：分时/五日（C2=A 重估前不排）、研究板块 RSR-01..08、基金/宏观、资讯流（H3/H4 结论前不做）。
- go-live-blockers 附表：H4 三签、CI 发布状态待核（remote 在、已推 01e079e）、红队 #7、AC-10「3 秒可交互」测量、Dlv-4 证据行。

## 环境/基础设施阻塞（影响一切证据产出）

| # | 阻塞 | 影响 | 需要谁 |
| --- | --- | --- | --- |
| 1 | 真栈未起（PG@55432 / API@8081 / Web@3000，2026-11-06 curl 实测无响应） | E2E/真栈类 AC 全线 C 级；按交接纪律 H1 未自行起栈 | L0 安排 |
| 2 | ~~仓无 git remote~~（**已更正 2026-11-06 L0**）remote 在（origin=git@github.com:musk-max-max/ai-native-market-sense.git，已推 01e079e） | CI 发布状态待核（是否真跑过 runner 未验）；P0 发布签字以 CI 实跑留数为准 | A8 核 CI 发布状态 |

## 变更记录

- 2026-11-06 H1 首建：承接 task-10（PRD v2 backlog + P1 acceptance）；三桶 = P0 AI 证据链（P0-2）/ P1 剩余项（P1-4..7）/ antd 待 owner 确认 package.json（P1-4 首行）；验收结论见 `p1-acceptance-2026-11-06.md`。
- 2026-11-06 L0 更正：「仓无 git remote → CI 记未发布」不成立——remote 在（origin=git@github.com:musk-max-max/ai-native-market-sense.git，已推 01e079e，H1 已亲验 `git remote -v`）；环境阻塞 #2 与 P2 行改为「CI 发布状态待核」；`go-live-blockers.md` §2.3/§3 同步更正。
