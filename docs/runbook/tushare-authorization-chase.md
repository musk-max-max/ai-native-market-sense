# Runbook · tushare 授权三件催办与到期处置（F1 residual）

> Owner：H4（数据负责人 + 安全运维）。台账：`security/compliance/tushare-authorization-ledger.md`；
> residual 登记：`security/findings/register.md` SEC-011；owner 清单：`security/compliance/owner-signoff-checklist.md`。
> 时间盒：**11-12 到期**（2026-11-06 时剩 6 天）。本 runbook 是操作级流程；判定口径一律以台账/登记册为准。

## 症状

- 三件（官方书面回复 / 授权条款文本 / 白名单+来源解耦）任一未齐，当前 **0/3**。
- `git ls-files | grep -Ei "\.(pdf|eml|docx|msg)$"` 为空 → 仓库内零书面授权实体。
- a/b 两问 owner 未答（L131 Open⑤）；owner 口头「已获授权」无书面支撑（L127）。
- 到期临近信号：11-09 剩 3 天无书面进展；11-12 到期未齐。
- 误报面：任何文档出现「已获授权/已解决/合规」描述 F1 的表述（违禁写法，见台账 §2）。

## 影响

- **C 端商用上线阻塞（P0）**：无书面授权 = 无权利基础；`c_end_display` 不得翻档，维持 `internal_eval` + 403 `EntitlementRestricted`。
- **11-12 发布数据半不签**（H4 veto 范围）；F1 residual（SEC-011，厂商法律授权缺口）保持未闭环并显著登记。
- mirror（tuaremax.top）是 reseller，转售链条不构成 tushare 再许可授权（L118）；若被上游追责，当前无任何可举证书面材料。
- 若答案落 b 路径（仅覆盖官方端点）：换源 = 授权基础变更，需切 `api.tushare.pro` + 重拉全量（3–4 人日 + 回补成本）。

## 判断

1. **状态核对**：查台账 §1 总表 + §5.1 逐件催办路径表（状态/责任人/下一节点）；residual 口径查 register.md SEC-011。
2. **实体核对（不信口头）**：书面件须有 sha256 快照回填台账（三要件逐条对上：①非本人第三方小范围不收费展示
   ②上游/交易所再许可 ③书面用途/期限/范围）；缺一 = 未齐。
3. **a/b 判读**：a=是否覆盖第三方 mirror 取数；b=仅官方端点则换源重拉。含糊回复 = 「未覆盖」，按未齐处理。
4. **技术可举证性**（与三件并行，不计入三件齐否）：`services/ingest/var/**/research_coverage.json` 需
   `source_channel=third_party_mirror`、`authorization_status=unverified_third_party`、`endpoint_host=tuaremax.top`
   才能举证「走 mirror」；现为 `replay/null`（SEC-007）。`.env` 的 `TUSHARE_HTTP_URL` 是死配置，不得当证据。

## 止血

1. **不翻档**：C 端维持 `internal_eval` + 403；任何情况下不以口头承诺、内网、不收费为由放行（L100：内网≠免授权）。
2. **不签**：11-12 发布数据半不签；发布材料写明 F1 residual 未闭环（禁止「已获授权」表述）。
3. **催办**（不依赖对方回复即可先做）：A2 条款全文 + A3 权限表 + A4 字段清单先行收集（owner 清单 A 节）；
   A1 书面回复 + a/b 走 tushare 官方渠道（reseller 不算）。
4. **技术侧止损**（A1 席）：修 SEC-007/008/009（端点变量统一 fail-closed、默认 https、限流接线 ≤200/min）前，
   不跑真实 mirror 取数批量任务；不得新增真实报文样本入 git（SEC-010）。

## 升级

| 时点 | 动作 | 升级路径 |
|---|---|---|
| 每次材料到达 | H4 落 sha256 快照、回填台账 §1、追加记录（不改历史行） | — |
| 11-09（剩 3 天） | 中期检查；无任何书面进展 → L0 出升级通报（C 端继续阻断、F1 授权期限风险上升） | H4 → L0 → owner |
| 11-12（到期） | 三件齐 → H4 复核记录交 owner/H3/L0；不齐 → 记「未闭环」+ 保留阻断 + 发布数据半不签 | H4 → L0 上呈 owner（**agent 不代签、不代 owner 决策**） |
| owner 需要外部意见 | 涉及许可解释/再许可链条 → owner 寻外部律师或 tushare 法务书面澄清 | owner 主导，H4 只收口归档 |

## 复盘

- **记录纪律**：每次进展**追加**不改历史行；状态只认 sha256 实体；禁写「已解决/已获授权」（台账 §2 禁止写法表）。
- **11-12 复核输出**：三件齐否逐件记录 + residual 处置（闭环 or 保留显著标注）+ 对 C 端/发布的影响声明，
  交 L0 汇总给 owner；若走 b 路径换源，另出成本/排期评估（A1/A2）。
- **遗留跟踪**：SEC-007/008/009（取数控制面）、SEC-010（真实报文样本）、SEC-012（AKshare/东方财富爬取，
  F1 同类并列跟踪）、档位口径悬案（10000 vs 15000 积分；dc_index/dc_member 可用性已由 L136.1 落定）——
  均在台账挂账，闭环时一并复核。
- **演练建议**：11-09 中期检查即为一次桌面推演（材料缺席时的升级链是否走得通），结果记入台账 §6。
