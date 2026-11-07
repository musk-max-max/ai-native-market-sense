# 安全半三项卡点 · 可验收口径（11-12 发布签半用）

> Owner：H4（数据负责人 + 安全运维，含发布签字）。起因：lead 2026-11-06 指示「安全半卡的值班/寻呼/staging
> 三项在 11-12 前给可验收口径，到时随三件一并签半」。
> 本文只定**判据**；数据提供归 owner/Lead，取证与登记归 A13（`infra/ops/oncall-roster.md`、
> `infra/ops/release-evidence-status.md`、`infra/evidence/evidence-manifest.json`），核验与签字归 H4。
> 现状（2026-11-06）：值班姓名/手机 **BLOCKED**、真实寻呼通道 **BLOCKED**、staging 15min 演练 **NO-ENV**。

## 0. 签半总规则（11-12）

- 逐项判定只用 **PASS / ACCEPTED-RISK / OPEN**，不用「应该没问题」；每项须带证据 ref（文件路径或 `mNNNNN`）。
- **任一项 OPEN → 安全半不签**（与数据半三件并列，两半都签才发布）。
- **ACCEPTED-RISK 只认 owner 书面**（消息 ref 为准，口头不算），须写明风险内容+复核日期，进 release note。
- 核验时点：11-09 中期检查看进度；11-12 签半时逐项核验；材料到齐随时可预检（H4 提前核，不留到 11-12 当天）。
- **不可采信项（三项通用）**：webhook HTTP 200（只是链路可达，不是到人）、IM 群聊/私聊回执（L74/L77）、
  E2E 合成栈结果（只能标 drill，不进签字包）、口头承诺、`______`/「待定」占位。

## 1. 值班姓名/手机 —— PASS 判据（现 BLOCKED）

| 判据 | 验收标准（全满足才 PASS） | 证据 |
|---|---|---|
| 1.1 具名齐全 | `infra/ops/oncall-roster.md` §3 四班次（早/晚/夜间/周末）× primary+backup **8 格全具名**：真实人类姓名 + 手机号（大陆 11 位或 E.164；工号可选），零空格、零「待定/____」 | 该文件更新版 |
| 1.2 不重班 | 同一班次 primary ≠ backup | 同上 |
| 1.3 覆盖承诺 | 至少 1 名人类书面确认「11-12 发布窗口起 72h 按表覆盖」（含夜间/周末 on-call 不必在线但寻呼可达） | 确认记录存 `infra/evidence/`，登记 manifest |
| 1.4 联系可达 | 抽测 1 个班次：电话接通记录 **或** 短信送达回执（证明号码真实可达，不是填表应付） | `infra/evidence/` + manifest |
| 1.5 状态迁移 | oncall-roster.md 状态由 DRAFT-BLOCKED 更新，证据登记 manifest（`authority=authoritative`，signed_ref 记 H4） | manifest 条目 |

**不满足处置**：任一格缺 → OPEN → 安全半不签；不得用「A13 L1 自动化响应」顶替人类值班格（A13 是补充不是值班人）。

## 2. 真实寻呼通道 —— PASS 判据（现 BLOCKED）

| 判据 | 验收标准（全满足才 PASS） | 证据 |
|---|---|---|
| 2.1 通道实体 | Alertmanager `sre-pager` receiver 指向**真实电话/短信网关**（或替代方案「值守手机 + 短信 API」）；webhook 占位不算 | `infra/monitoring/alertmanager/alertmanager.yaml` 配置 + 网关侧截图/开通记录 |
| 2.2 端到端实测 | 一次真实测试：注入 critical 告警 → 寻呼发出 → **人类接听/短信送达** → **ack 回执**，含时间戳、接收人姓名/工号、ack 时间 | `infra/evidence/paging-receipt-*.txt` + manifest |
| 2.3 合规通道 | 到人通道满足 L74/L77：IM 群聊/私聊**不算**寻呼；到手机/电话才算 | 与 2.1/2.2 同证 |
| 2.4 接收人承诺 | 至少 1 名人类明确同意接收测试告警且已实际 ack 一次（与 §1 的值班人可为同一人） | 2.2 回执即证 |
| 2.5 状态迁移 | 告警到人能力由 UNVERIFIED → PASS，登记 manifest | manifest 条目 |

**不满足处置**：无端到端回执 → OPEN → 安全半不签；「配置已写但没实测」按 UNVERIFIED，不进 PASS。

## 3. staging 15min 演练 —— PASS 判据（现 NO-ENV）

**演练内容**（`docs/runbook/entitlement-hold-drill.md`）：15min 未确认 → 自动降 `internal_eval`
（无权展示一律 403 `EntitlementRestricted`，红线③口径）。

**路径 A · PASS（staging 就绪时，全满足）**：

| 判据 | 验收标准 | 证据 |
|---|---|---|
| 3A.1 真环境 | staging 集群/域名就绪，**非 E2E 合成栈**（`E2E_MODE` 栈结果不采信） | 环境清单/域名记录 |
| 3A.2 全链路演练 | 跑通一次完整链路并留时间戳：告警 → 寻呼（用 §2 通道）→ 15min 计时未确认 → 自动 `internal_eval` + 403 生效 → 复原 | 演练记录标 `drill` + manifest |
| 3A.3 复盘 | 演练后复盘一段（实际耗时/偏差/改进），随记录归档 | 同上 |

**路径 B · 降级（11-12 前 staging 仍不就绪）——不能判 PASS，只能 ACCEPTED-RISK**：

1. owner **书面**接受「未演练自动降档」风险（消息 ref，写明风险内容）；
2. H4 在签半记录注明「安全半 = conditional，staging 演练 residual OPEN」并进 release note；
3. 写死补演练期限：**S1 起 5 个工作日内**完成路径 A，逾期安全半复核、可能撤签；
4. 期间自动降档链路不得宣称「已验证」，仅可写「代码就绪、未演练」。

**不满足处置**：路径 A 未达且无 owner 书面（路径 B 第 1 条缺）→ **OPEN → 安全半不签**。
11-09 中期检查若仍 NO-ENV，提前按路径 B 走 owner 书面，不等 11-12 当天。

## 4. 11-12 签半记录模板（H4 逐项填，缺一不签）

| 项 | 判定（PASS/ACCEPTED-RISK/OPEN） | 证据 ref | 备注 |
|---|---|---|---|
| 值班姓名/手机 | | | |
| 真实寻呼通道 | | | |
| staging 15min 演练（路径 A 或 B） | | | |

> 同表另签数据半三件（书面回复/条款文本/白名单+来源解耦，见
> `../compliance/tushare-authorization-ledger.md` §1/§5.1）。**agent 不代 owner 签字**；最终放行 = owner。
