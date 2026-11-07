# 催办 / 升级通报草稿 · tushare 三件 + 安全半三项（2026-11-06，H4 拟）

> **性质：草稿，不是签认。** 本文件由 H4 席（agent）起草，供 L0 择机发出/上呈 owner；
> 任何签认（数据半 B6、安全半、c_end_display 翻档、policy 签发）**一律 owner/H3**，agent 不代签。
> 依据：`security/compliance/owner-signoff-checklist.md`（材料与签认矩阵）、
> `security/gate/security-half-acceptance-2026-11-12.md`（安全半判据）、
> `security/compliance/tushare-authorization-ledger.md`（三件台账）、
> `security/findings/register.md` SEC-011；裁定口径 L100/L110/L118/L127/L131（不重开、不推翻）。
> 状态事实见 `p0-status-snapshot-2026-11-06.md`（11-06 18:15 亲验：三件 0/3、安全半 3/3 OPEN）。

---

## 草稿 A · 给 owner 的催办通报（即时可发，11-06）

**主题：P0 授权与安全材料催办 —— 11-12 到期，两半签字取决于以下 6 项输入**

owner 您好。截至 2026-11-06 18:15 仓库核验：**tushare 授权三件 0/3、安全半三项 3/3 OPEN**，
11-12 发布的「数据半 + 安全半」两半均按现状不可签，C 端商用继续阻塞（维持 403 `EntitlementRestricted`）。
以下 6 项全部需要**您本人/官方渠道**的输入，agent 无法代为取得：

**授权三件（清单 `owner-signoff-checklist.md` A 节 / B 节）**
1. **A1/B1 官方书面回复**：向 tushare 官方渠道（工单/客服邮箱/商务；**reseller 回复不算**，L118）索取书面回复，
   须逐条覆盖三要件：①允许向非本人第三方（小范围、不收费）展示；②覆盖其数据及上游/交易所权利的再许可；
   ③写明用途/期限/范围。口头/转述不算（L127）。
2. **B2 a/b 两问作答**（事实确认，不是签发）：a=授权是否覆盖第三方 mirror（tuaremax.top）取数？
   b=若只覆盖官方端点，是否切 `api.tushare.pro` 并重拉全量（3–4 人日 + 回补成本）？含糊=未覆盖。
3. **A2 条款文本**：tushare 官方服务协议/授权条款**全文** + 版本号 + 来源 URL（不依赖官方回复，可先行交付）。
4. **A3/A4 权限表与字段清单**：账号后台权限截图/导出（实际授权的接口、字段、额度）+ 套餐档位口径
   （10000 vs 15000 积分三处不一致；dc_index(362)/dc_member(363) 已实测可用，L136.1 作废「不可用」旧说）+ 可展示字段清单。

**安全半三项（任一 OPEN → 安全半不签）**
5. **值班 8 格**：四班次 × primary+backup 的**真实人类姓名 + 手机号**（大陆 11 位或 E.164），
   加 1 名人类书面确认「11-12 发布窗口起 72h 按表覆盖」；当前 `infra/ops/oncall-roster.md` 8 格全为占位。
6. **真实寻呼通道**：电话/短信网关（或值守手机 + 短信 API）+ 一名愿意接收测试告警并回 ack 的人类；
   及 **staging 演练路径二选一**：A=提供 staging 环境跑 15min 降级演练；B=**书面**接受「未演练自动降档」风险
   （消息 ref + 风险内容 + 复核日期，H4 签半时注 conditional 并写死 S1 起 5 个工作日内补演练）。

**时间盒与后果（提前知悉）**
- 11-09 中期检查：无任何书面进展 → L0 出升级通报（见草稿 B）。
- 11-12 到期不齐：台账记「**未闭环**」（禁写「已获授权/已解决/合规」）、SEC-011 residual 保留显著登记、
  **数据半与安全半均不签**、C 端维持 403，C 端商用上线继续阻塞（P0）。
- 若 a/b 答 b（仅官方端点）：换源是**授权基础变更**，另行排期，不是配置切换。

---

## 草稿 B · L0 升级通报（触发条件：11-09 中期检查仍无书面进展；提前版备用于 11-06 12:00 逾期项）

**主题：【升级 · P0】授权三件 0/3 + 安全半 3/3 OPEN，11-12 两半签字与 C 端上线继续阻断**

- **触发**：`owner-signoff-checklist.md` D 节 / 台账 §6 / `docs/runbook/tushare-authorization-chase.md` 升级节
  ——11-09（剩 3 天）无任何书面进展即出本通报；另注：`infra/ops/release-evidence-status.md` 第 1/2 项
  （值班表、寻呼回执）截止 **11-06 12:00 已逾期**，可即时引用。
- **事实**（11-06 18:15 亲验，锚见 `p0-status-snapshot-2026-11-06.md` §5）：
  ①三件 0/3，`git ls-files` 零书面实体（pdf/eml/docx/msg 空，exit=1）；②a/b 未答（L131 Open⑤）；
  ③值班 8 格占位（oncall-roster DRAFT-BLOCKED）；④寻呼仅 in-cluster webhook 占位、无 ack 回执；
  ⑤staging NO-ENV 且路径 B owner 书面未启动。
- **影响**：F1 residual（SEC-011，厂商法律授权缺口）未闭环 → **C 端商用上线继续阻塞（P0）**，
  维持 `internal_eval` + 403 `EntitlementRestricted`；**11-12 发布数据半、安全半均不签**（H4 veto 范围），
  授权期限风险随 11-12 临近上升。
- **升级路径**：H4 → L0 → owner（agent 不代签、不代 owner 决策；涉及许可解释由 owner 寻外部律师/tushare 法务书面澄清）。
- **请 owner 决策/提供**：草稿 A 的 6 项输入，或对 staging 走路径 B 书面 ACCEPTED-RISK；二选一无默认答案。

---

## 使用说明（给 L0）

1. 草稿 A 可即时发给 owner（催办不等 11-09）；草稿 B 默认 11-09 触发，若 L0 判定逾期项需立即升级可提前发。
2. 发出不改变任何台账状态：状态只认 sha256 实体回填，进展一律**追加**不改历史行。
3. 本文件不含任何签认；B6 数据半、安全半、B5 翻档、AI-1/2/3 签认分别归 H4（条件满足后）/owner/H3。
