# P0-1 状态盘点快照 · tushare 三件 / 安全半三项 / SEC-011（2026-11-06 18:15 CST）

> 拟稿：H4 席（按需 subagent，数据负责人 + 安全运维）· 2026-11-06 18:15 亲验仓库现状。
> **本文只做整理与起草，不代任何人签字**：签认（数据半 B6 / 安全半 / c_end 翻档 / policy）一律 owner/H3。
> 证据纪律：每条结论带 commit / file:line / 可复跑命令锚；单样本不证覆盖；合成/回放产物不作真实证据。
> 基线 commit：`01e079e`（2026-11-06 重建台账轮，HEAD）。台账真源：`security/compliance/tushare-authorization-ledger.md`、
> `security/compliance/owner-signoff-checklist.md`、`security/gate/security-half-acceptance-2026-11-12.md`、`security/findings/register.md`。

---

## 1. tushare 官方授权三件（清单 B1–B6）—— **0/3 齐，11-12 到期，剩 6 天**

### 1.1 三件本体（台账 §1 总表口径，11-06 18:15 复核无变化）

| # | 件 | 状态 | 缺什么（验收判据锚） | 责任人 |
|---|---|---|---|---|
| ① | 官方书面回复 | **未闭环** | 书面文本本体 + L100 三要件（非本人第三方展示 / 上游交易所再许可 / 用途·期限·范围）+ a/b 两问作答；`owner-signoff-checklist.md:14`（A1） | owner → H4 归档 |
| ② | 授权条款文本 | **未闭环** | 官方条款全文 + 版本号 + 来源 URL（sha256 快照机制已就绪，内容缺；仓内仅 `services/ingest/config/terms-synthetic.txt` 自述 SYNTHETIC 占位）；`owner-signoff-checklist.md:15`（A2） | owner → H4/A1 落快照 |
| ③ | 白名单 + 来源解耦 | **部分达标，不计入齐** | 代码内 11 数据集白名单 ✅ + 架构解耦 ✅（门禁 4 条 11-06 复跑全绿，台账 §3.1）；缺 owner 账号权限表 + 可展示字段清单（A3/A4），档位三处口径不一致（决策#10 10000 分 / L117 15000 / HANDOFF A1 15000）待权限表统一；技术缺口 G1–G3（SEC-007/008/009）OPEN 归 A1 | owner（权限表）+ A1（技术） |

**实体核验（11-06 18:15 亲跑，可复现）**：
- `git ls-files | grep -Ei '\.(pdf|eml|docx|msg)$'` → **空（exit=1）**：仓内零书面授权实体。
- `security/compliance/evidence/` 目录**不存在**：无任何归档件、无 sha256 回填。
- `services/ingest/var/**/research_coverage.json` 现 `source_channel=replay` / `endpoint_host=null`：**仓内无一次 mirror 真实取数端点证据**（SEC-007），`.env` 的 `TUSHARE_HTTP_URL` 是死配置，不得当证据。

### 1.2 清单 B1–B6 逐条状态（`security/compliance/owner-signoff-checklist.md:23-28`）

| # | 签认件 | 签发方 | 当前状态（11-06 18:15） | 解锁什么 |
|---|---|---|---|---|
| B1 | 商用/再分发书面授权 | tushare 官方 | **未取得**（三要件书面覆盖=0；reseller 回复不算，L118） | F1 residual 闭环依据、C 端商用权利基础 |
| B2 | a/b 两问事实回答 | owner 本人 | **未答**（decisions L131 Open⑤ 仍记「F1 取数合规 a/b owner 未答」；m06899 口头「已获授权」被 L127 拦截，不作数） | 三件①验收要件；答 b 则触发换源（3–4 人日 + 重拉全量） |
| B3 | 账号权限表 + 档位口径 | owner | **未提供**（档位口径仍悬；dc_index/dc_member 可用性已由 L136.1 落定=15000 积分下实测可用） | 白名单口径统一 |
| B4 | F1 residual 复核关闭记录 | H4 出复核 → 人类追认 | **未出**（前置 ①②③+a/b 均未满足；agent 不代签） | 台账「待复核→闭环」、数据半签字前提 |
| B5 | c_end_display 翻档 | H4 + H3 + owner 三方 | **未触发**：维持 `internal_eval` + 403 `EntitlementRestricted`（红线③）；AI-1/2/3 另由 H3 签且当前不签，签认≠C 端放行 | 解除 403 |
| B6 | 11-12 发布数据半签字 | H4（生产执行归 A8） | **当前不可签**：三件 0/3 + B2/B3 未答；`owner-signoff-checklist.md:34` 到期不齐=数据半不签 | 发布放行（数据半） |

**并行不计数但阻塞「可举证」**：SEC-007（端点死键+静默回落）、SEC-008（默认 http 明文无 TLS）、SEC-009（限流未接线，实际 400/min 超 mirror 200/min 声明）——owner A1，均 OPEN（register.md §10.1–10.3）。

---

## 2. 安全半三项（gate 判据）—— **3/3 OPEN，任一 OPEN 不签半**

判据真源：`security/gate/security-half-acceptance-2026-11-12.md`（PASS / ACCEPTED-RISK / OPEN 三值，带证据 ref）。

| 项 | 判定 | 事实证据（11-06 18:15 亲验） | 未满足判据 |
|---|---|---|---|
| 值班姓名/手机（8 格） | **OPEN（BLOCKED）** | `infra/ops/oncall-roster.md` 状态仍 **DRAFT-BLOCKED**（mtime 2026-11-04 20:44，此后无更新）；§3 四班次 × primary+backup **8 格全为 `______________` 占位**（:24-27），零真实姓名/手机 | 1.1 具名齐全、1.2 不重班、1.3 覆盖承诺、1.4 抽测可达、1.5 状态迁移——**全未满足**；A13 L1 自动化不得顶替人类值班格 |
| 真实寻呼网关 + ack 回执 | **OPEN（UNVERIFIED）** | `infra/monitoring/alertmanager/alertmanager.yaml:39-42`：`sre-pager` 仅 in-cluster **webhook 占位** `http://alert-sink.market-sense-dev.svc.cluster.local:8080/pager`，无电话/短信网关；`infra/evidence/` 下 **无 `paging-receipt-*`** 文件；mtime 2026-11-04 08:23 | 2.1 通道实体、2.2 端到端到人+ack 回执、2.3（IM 不算，L74/L77）、2.4 接收人 ack、2.5 状态迁移——**全未满足**；webhook 200 只是链路可达，不进签字包 |
| staging 15min 演练（路径 A 或 B） | **OPEN（NO-ENV，且路径 B 未启动）** | `infra/ops/release-evidence-status.md:9` 第 3 行 **NO-ENV**（无 staging 集群/域名，不拿 E2E 合成栈冒充）；**未见 owner 书面接受「未演练自动降档」**（路径 B 第 1 条缺）→ 按 gate §3「不满足处置」记 OPEN | 3A.1–3A.3 全未达成；路径 B 四条（owner 书面 / conditional 签半注记 / S+5 工作日补演练期限 / 禁称已验证）一条未落 |

**附注（逾期与已解除项，避免重复卡）**：
- `infra/ops/release-evidence-status.md:7-8` 第 1/2 项截止 **11-06 12:00 已逾期约 6 小时**，仍 BLOCKED（Lead/H5 → A13 输入未到）。
- **不再作为签核前提**：云 SG 80/8888 = ACCEPTED-RISK（m05524/L108 书面 + HOST-EXPOSURE-01 补偿）、root 禁登 CLOSED（L108 `PermitRootLogin no` + 具名 sudo `lyuddu`，L109）；**L110 书面确认 SG 与 root 不再作为 11-12 发布签核前提**——本快照不重开这两项。
- 两半关系：数据半卡三件（§1），安全半卡三项（本节），**两半都签才发布**；安全半任一 OPEN → H4 不签（H4 veto 范围）。

---

## 3. SEC-011 F1 residual 当前口径（`security/findings/register.md` §11，11-06 复核照录）

- **判定**：🔴 **未闭环** ——「无 tuaremax.top 书面转售授权 = 厂商法律授权缺口」。三件 0/3，11-12 到期，**P0 阻塞 C 端商用上线（release-blocking）**；页首 ⚠️ 显著标注保持。
- **允许写法**：「取数合规=待确认；a/b 未答；mirror 通道 `authorization_status=unverified_third_party`」。
- **禁止写法**：「已获授权」「已解决」「合规」「内网=自用」（L100 内网≠免授权；L127 口头声明被拦截；L118 reseller 不构成授权）。
- **C 端状态**：维持 `internal_eval` + 403 `EntitlementRestricted`；`c_end_display` 翻档须 H4+H3+owner 三方（B5）。
- **闭环判据（all-of，register.md:230-234）**：①三件齐且逐条对上 L100 三要件（sha256 实体）；②a/b 书面答「覆盖 mirror」或走 b 路径换源重拉；③条款文本与 SEC-010 样本处置口径落定；④H4 复核记录 + H3 书面放行 + owner 最终放行。
- **连带未闭环**：SEC-010（真实报文 11 文件入 git，与 L32 冲突，m02923 授权无 decisions 留痕）待 H3 定性 + L0 补记；SEC-007/008/009 归 A1。

---

## 4. 汇总结论（截至 2026-11-06 18:15）

1. **三件 0/3**（①②未闭环、③部分达标不计齐），**a/b 未答**，仓内零书面实体 → **11-12 数据半按现状不可签**；C 端继续 403。
2. **安全半 3/3 OPEN**（值班 8 格占位 / 寻呼仅 webhook 占位无 ack 回执 / staging NO-ENV 且路径 B owner 书面未启动）→ **11-12 安全半按现状不可签**。
3. **SEC-011 F1 residual = 未闭环**，口径见 §3，任何材料不得写「已获授权/已解决/合规」。
4. 时间盒：**11-09 中期检查**（无任何书面进展 → L0 出升级通报，草稿见
   `security/compliance/owner-chase-escalation-draft-2026-11-06.md`）；**11-12 到期**（不齐 → 记未闭环 + 保留阻断 + 两半不签）。
5. 本快照不产生新裁定，不推翻 L100/L110/L118/L127/L131 任何既有口径。

## 5. 证据与复跑命令（11-06 18:15 亲跑，全绿=如上所述）

```bash
git rev-parse --short HEAD                          # 01e079e
git ls-files | grep -Ei '\.(pdf|eml|docx|msg)$'      # 空，exit=1 → 零书面实体
ls security/compliance/                             # 仅 checklist + ledger，无 evidence/
grep -n -A4 'name: sre-pager' infra/monitoring/alertmanager/alertmanager.yaml   # 仅 webhook 占位
ls infra/evidence/ | grep -i paging                 # 空 → 无 ack 回执
grep -c '______________' infra/ops/oncall-roster.md  # 8 格全占位
PYTHONPATH=services/ingest/src python3 -m pytest services/ingest/tests/test_boundaries.py -q -o addopts=""   # 2 passed（台账 §3.1 口径）
node infra/ci/check-source-vocabulary.mjs           # PASS（台账 §3.1 口径）
```

> 未验证项（明示）：上述 pytest / check-source-vocabulary 两条引用台账 11-06 已记录结果，本轮盘点**未复跑**（盘点任务不涉代码变更）；其余命令均为本轮亲跑。
