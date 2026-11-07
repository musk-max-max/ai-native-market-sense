# Go-Live 卡点清单（2026-11-06，H1 归口维护）

- 文档性质：**放行判定清单**。本清单只回答「能不能上线、还差什么、谁负责」，不替代 BRD/PRD，也不替代 `docs/p0-acceptance.md`（发布卡点 R-1 与 AC 验收面）。
- 维护：H1（PM/PO）只做**归口与状态记录**，不代任何 owner 签字（L44/L130）；签字权归各卡点责任席位。
- 关联依据：`agents/decisions.md` L100/L118/L127/L131、`docs/release/copy-export-scan.md`（AI 门禁表 `:34-36`）、`docs/release/S0-STATUS.md`（11-12 门禁与三条限制）、`docs/p0-acceptance.md` §0/§4b、`docs/requirements/prd-v2.md` §10。

## 0. 判定规则

1. **三项主卡点（G1/G2/G3）任一未「关闭」，即 go-live 不放行。**「关闭」= 各自关闭条件全部满足且有证据（文件/命令输出/签字），不接受「口头确认」「已安排」「下周给」。
2. 主卡点关闭后，附表项仍须逐条过；附表项可由 L0 裁定「带风险放行」，但必须在发布说明里逐条留痕（写清 residual 与 owner）。
3. 状态词表沿用 L74：**PASS / PARTIAL / FAIL / PENDING-&lt;责任人&gt;**。禁止「基本完成」「已搞定」这类无判定力度的词。
4. 引用纪律（L75）：引用文件须亲验存在且非空，引用数字须带日期与证据文件；本清单所有状态行在 2026-11-06 由 H1 亲验过来源文件。

## 1. 三项主卡点

### G1 数据源授权：tushare 授权三件 + mirror 转售授权（责任人 H4，deadline 2026-11-12）

| 子件 | 当前状态 | 缺什么 | 关闭条件 | 证据应落 |
| --- | --- | --- | --- | --- |
| ① 官方书面回复 | **PENDING-H4**：未取得入档。owner 口述「已获授权」（L127, 2026-11-06），但无书面文件 | 官方书面回复（授权主体/日期/覆盖范围：C 端展示 + 再分发） | 具备 authorization 文件（截图/邮件/合同均可），覆盖 C 端商业展示 | `security/`（H4 task-12 台账） |
| ② 条款文本 | **PENDING-H4**：未见 | tushare 用户协议/商用条款全文及版本 | 条款文本入档，并给出与红线①「个人许可不可转让、C 端商用违约」的逐条比对结论 | 同上 |
| ③ 白名单 + 来源解耦 | **PARTIAL**：工程侧已解耦——`services/ingest/.env` 的 `TUSHARE_API_URL=https://tuaremax.top`（第三方 mirror），业务层无 tushare 标识；技术缺口 SEC-007/008/009 已修（2026-11-07，fail-closed + https 强制 + 限流接线）；但 mirror 无书面转售授权 | mirror（tuaremax.top）的转售/再分发书面授权，或切回官方端点并由①覆盖 | 书面授权入档；或切回官方 `api.tushare.pro` 且①覆盖，并完成全量回补 | 同上 |

- **不得改写的 residual 表述**：无 mirror 书面转售授权 = **C 端商用违约风险未闭环**（L100/L118），不得写「已解决」。11-12 前未取得 → 服务端拒答（fail-closed），不是降级（S0-STATUS §二.2、L76）。
- 与 G3 的分工：G1 = 数据源许可（能不能取/能不能再分发）；G3 = 对外 entitlement 语义（能不能展示）。

### G2 C 端 AI 展示卡 AI-1 / AI-2 / AI-3 签发（责任人 H3，task-11）

现状：**三项均未签**（L131 Open ④：「C 端 AI 展示卡 AI-1/2/3 仍 H3 未签，签认不构成 C 端展示放行」；`docs/release/copy-export-scan.md:34-36` 均 OPEN）。

| 卡 | 要求（摘要） | 现状 | 关闭条件 | 责任 |
| --- | --- | --- | --- | --- |
| AI-1 | 响应带 `meta.ai.generated=true` + `content_version`/模型标识；服务端生成/展示留痕（模型、版本、时间、输入口径版本）≥3 年 | OPEN | 实现 + 留痕样本 + 契约/实现证据，再经 H3 签认 | A0/A3/A4 → H3 |
| AI-2 | 时点真实：无 `as_of` 时数值、badge、disclaimer 均不渲染 | OPEN（A11/A12 测试证据缺） | 负向 e2e（无 as_of 不渲染）+ H3 签认 | H3/A7 |
| AI-3 | badge/disclaimer 不可关闭/折叠；复制/导出携带 label+disclaimer；前端无硬编码 fallback | OPEN | e2e + 门禁证据 + H3 签认 | H3/A7 |

- 分区纪律：G2 的签发只归 H3 的 **c_end** 分区；internal 分区由 owner 签（L130/L131），H1 与任何非 owner/H3 席位不得碰 signoff 字段。
- 与 P1-5 的关系：`/ai` 页面壳（Now）**不展示模型生成内容**，故 G2 不阻塞页面壳开发；但「AI 内容对 C 端可见」以此关闭为前提。AI-4（措辞扫描）已 DONE，不等于 G2 关闭。

### G3 F1 取数合规对外语义（责任人 L0 拍板 + H4 台账 + A3 实现）

现状（L127）：owner 口述「已获授权」→ **F1 对外半关**（解锁 C 端放行）；但取数链走 mirror，**owner 对 (a)/(b) 两选一未答** → **取数合规 = PENDING-L0**，F1 只关「对外」一半。

待 owner 书面回答的二选一：

- **(a) 授权覆盖 mirror 取数**：mirror 标记 unverified → authorized，F1 完全关闭；
- **(b) 授权只覆盖官方端点**：对外合规成立，取数链须切回 `api.tushare.pro` 并重新拉全量（20 年回补需 token + budget，H4 会要求）。

关闭条件：owner 书面回执入档 + A3 按回执落 entitlement/白名单/403 文案 + 真栈 403 矩阵复跑（p0-acceptance §0 R-1 关闭条件不变）。**H1 无权替 owner 选 (a)/(b)**。

## 2. 需 owner 拍板（≤5 条，逐条一句话）

1. **G3 二选一**：授权覆盖 mirror（a），还是只覆盖官方端点（b）？（L127 未答项）
2. **G1 授权主体与资质**：以哪个主体签、有无资质？（S0-STATUS §五.1 未决；决定 11-12 是否可达）
3. **CI 发布状态待核**（**2026-11-06 L0 更正**：remote 在，origin=git@github.com:musk-max-max/ai-native-market-sense.git，已推 01e079e）：需核 CI 是否真跑/发布状态，发布签字以 CI 实跑留数为准（A8）。
4. **200KB 首屏预算是否维持**：H1 建议维持（PRD §9.4，veto 项）；若要上调须 owner 书面指令。
5. **AI 生成层（Next）是否在 G2 关闭前排期**：H1 不建议排期，避免「先展示后补签」（§8.3 范围纪律）。

## 3. 附表：不构成主卡点、但必须逐条过（2026-11-06 状态）

| 项 | 状态（2026-11-06 核对） | owner | 依据 / 证据 |
| --- | --- | --- | --- |
| 11-12 entitlement 8+4 门禁 | **PARTIAL**：PASS 4.5 / FAIL 1（no-store）/ BLOCKED 3（hold/stale、事件、限流） | A5/A3/A0 | `docs/release/S0-STATUS.md` §三（2026-11-04） |
| audit/observed 迁移 004 | 进行中（p0-acceptance §0 R-1 的上游依赖） | A5（task-13） | `docs/p0-acceptance.md` §0 |
| 红队 #7 | **PARTIAL**：44 BLOCKED / 1 LEAK（R4 已修）/ 1 INFO；原始 HTTP 日志 0 字节待重建；公网 ingress 缺 | A11/A13 | S0-STATUS「门禁 #7」 |
| CI 真跑 | **未验证→发布状态待核**（**2026-11-06 L0 更正**：仓无 git remote 之说不成立，remote 在、已推 01e079e）：runner 实跑留数未验，5 workflow 仅过 actionlint（S0-STATUS 时点） | A8（task-14） | S0-STATUS §二.3（remote 前提已更正） |
| E2E 基线 | 11 passed / 1 skipped（正常档，2026-11-04）；P1 后不得下降 | A7（task-9） | `tests/e2e/E2E-RUN-2026-11-04-native.md` §2c |
| 契约测试基线 | `pytest tests/contract tests/data` = 193 passed / 0 failed / 2 warnings（2026-11-05 16:45）；不得下降 | A4/A7 | `tests/contract/CI_MOUNT.md` |
| AC-10「3 秒可交互」 | **C 级：未测量**（无证据） | A7 | `docs/p0-acceptance.md` §4b |
| AC-9 预算门禁 | **B 级**：79.1 KB gzip 实测，CI 未接；P1-4 引入后须复测 | A6/A8 | prd-v2 §9.4、§10 AC-P14-2 |
| Dlv-4（P0-10） | 曾记「未通过」；P0-10 replay 资产已补，2026-11-04 复跑 11 passed / 1 skipped，正式关闭待 A7 出证据行 | A7 | `docs/p0-acceptance.md` §4b.1、E2E-RUN §2c |
| 数据正确性 | M2 演示用合成数据（`SSE:600519` 收盘 10.30 vs 真实约 1685）——**链路通 ≠ 数据对** | A1/A2 | S0-STATUS §二.1 |

## 4. 发布说明模板（放行时逐条填，不得留空）

```text
放行结论：G1=<PASS/PARTIAL/...> G2=<...> G3=<...>
residual（带风险放行项）：<逐条写：风险、owner、期限>
未验证项：<逐条写：项、原因、预计可验条件>
签字：G1=H4  G2=H3  G3=owner(<主体>)  发布=H4（A8 只执行不代签）
```
