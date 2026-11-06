# H4 · tushare 授权三件台账 + 来源解耦核查（2026-11-06）

> Owner：H4（数据负责人 + 安全运维）。对应任务板 `task-12`；写域 `security/`。
> **修订 2026-11-06（H4 复核轮）**：①逐件补「状态/责任人/催办路径」表（§5.1）；②§4 安全半状态按 decisions.md
> L102–L110 更新（root 禁登 CLOSED、SG=ACCEPTED-RISK，原「SEC-001 P1 公网 22/root 密码」表述已过时）；
> ③门禁四条复跑 2026-11-06 全绿（§3.1）；④owner 材料/签认清单另出 [`owner-signoff-checklist.md`](owner-signoff-checklist.md)。
> 依据口径：`agents/decisions.md` L118（mirror 边界）、L127（owner 口头声明被拦截）、L131（Open⑤ a/b 未答）、
> L32（不落真实报文）、L100（授权三要件）、L91/L98（内网≠免授权）；`docs/HANDOFF-team-rebuild-2026-11-06.md:96,147`
> （三件 11-12 到期）。
>
> **一句话结论：三件 0/3 齐，residual=未闭环；11-12 到期，今日（11-06）剩 6 天；C 端/display/serving 维持关闭，
> 数据授权半的发布签字不签。本台账只记事实、缺口、责任人、到期与可复跑证据，不代 owner 签字。**

## 1. 三件台账总表（0/3 齐）

| # | 件 | 当前状态 | 缺什么 | 谁提交 | deadline | 风险等级 |
|---|---|---|---|---|---|---|
| ① | tushare 官方书面回复 | **未闭环** | 书面文本本体 + 授权三要件 + a/b 两问答案 | owner（用户）→ H4 归档 | 2026-11-12 | **P1 release-blocking** |
| ② | 授权条款文本 | **未闭环** | 官方条款全文 + 版本号 + 来源 URL（快照机制已就绪） | owner 提供文本 → H4/A1 落 sha 快照 | 2026-11-12 | **P1 release-blocking** |
| ③ | 白名单 + 来源解耦 | **部分达标**（代码内白名单 + 架构解耦已做；账号权限表缺、端点配置有 3 处缺陷） | owner 账号权限表/接口授权清单 + 可展示字段清单；G1–G3 技术修复（A1） | owner（权限表）→ H4；技术缺口 A1 | 2026-11-12 | **P1（白名单）/ P2（技术缺口）** |

### ① 官方书面回复 —— 未闭环

- **事实**：owner 于 m06899 口头表示「已获授权」，Lead 已拦截、未按整链路合规处理（`agents/decisions.md` L127：
  「owner 未答 a/b，取数合规状态=待确认，F1 只关『对外』一半」；L131 Open⑤ 仍记「F1 取数合规 a/b owner 未答」）。
- **仓库内零书面实体**：`git ls-files` 无 `*.pdf/*.eml/*.docx`；`reviews/compliance/` 只有 KD-AIPOLICY-OFFLINE；
  `rules/archive/` 只有 ai-content-policy/redline-basis。即：无主体、无范围、无期限、无再许可条款、无章/签名。
- **缺什么**（三要件，L100 原文口径）：
  1. 允许向**非本人第三方**（小范围、不收费）展示；
  2. 覆盖**其数据及上游/交易所权利**的再许可；
  3. 构成**书面授权**并写明用途/期限/范围。含糊 = 未覆盖，继续 403。
- **a/b 两问（未答）**：a=授权是否覆盖第三方 mirror（tuaremax.top）取数；b=若只覆盖官方端点，则须切
  `api.tushare.pro` 并重拉全量（授权基础改变，不是配置切换）。
- **风险**：mirror 是 reseller，L118 明示「F1 书面授权只认官方 tushare 回复，reseller 不构成授权」；
  口头声明不能替换书面（不得写「owner 已获授权」当结论）。

### ② 授权条款文本 —— 未闭环

- **现状**：仓库内唯一「条款」是 `services/ingest/config/terms-synthetic.txt:1-3`，首行自述
  「SYNTHETIC TERMS — 非真实条款全文（e2e/样例占位）…不构成任何授权或条款依据」。
- **机制已就绪，缺内容**：`services/ingest/src/market_ingest/manifest.py:116-118`（terms_version /
  terms_snapshot_path / terms_snapshot_sha256）、`:336` `terms_dir(root)`、`:344` `write_terms_snapshot(root, text)`
  （sha256 内容寻址存 `<manifest-root>/terms/<sha>.txt`）；`services/ingest/README.md:81-90` 要求
  `source_url + terms_version + 快照路径/哈希 + credential_ref + operator`。
- **缺什么**：官方服务协议/授权条款**全文**（须含个人使用、不可转让、非商业、二次展示等条款）+ 版本号 + 来源 URL。
  个人许可不可转让/非商业/仅个人查看这些结论目前只有转述，没有可核对的原文。
- **落法**：owner 提供文本（或可核对的官方页面截图/PDF）→ `terms_version` 定名 → 用 ingest CLI
  `--terms-file` 落快照，将 sha256/路径/日期回填本表 §1。

### ③ 白名单 + 来源解耦 —— 部分达标

- **已有（代码内白名单）**：`services/ingest/src/market_ingest/adapters/tushare/research.py:280-310`
  `_DATASET_META` 声明 11 个研究数据集的 `doc_id + points_min + 取数模式`：
  top_list(106/2000)、top_inst(107/5000)、moneyflow(170/2000)、margin(58/2000)、hk_hold(188/2000)、
  daily_basic(32/2000)、index_daily(95/2000，需 index_codes)、fina_indicator(79/2000，单票)、
  stk_limit(183/2000)、index_classify(181/2000)、index_member_all(335/2000)。
- **缺什么**：①owner **账号权限表**快照（实际授权了哪些接口/字段/额度，不是按公开文档推断）；
  ②**可展示字段清单**（哪些字段允许出现在展示/研究产物里，这是白名单的合规含义）；
  ③档位事实三处不一致，必须由权限表统一（见下方注）。
- **注（事实不一致，不得写死）**：决策 #10（`agents/decisions.md:128`）记「10000 积分套餐 = 1 万元/年」；
  L117 记「15000 套餐」且原句「15000 套餐 < 6000 阈值」自相矛盾（dc_index/doc 362、dc_member/doc 363 被判不可用）；
  HANDOFF A1 段记「owner 有 15000 积分」。⇒ 档位与「为什么 6000 分接口不可用」待 owner 权限表/官方页面确认，
  在拿到前不写具体档位，也不得据此判定「所有 2000 分接口均可用」。
  **更新（L136.1，2026-11-06 18:37，A1 m00452 实测）**：dc_index(362)/dc_member(363) 在 15000 积分下**完全可用**
  （code=0 有数据；dc_member 需 `.DC` 后缀如 BK1184.DC + trade_date 过滤返当日成分），L117「6000 分不可用」**作废**；
  档位口径（10000 vs 15000）仍待 owner 权限表统一。

## 2. residual 表述（精确口径，禁止写「已解决」）

| residual | 真实状态 | 允许写法 | **禁止写法** |
|---|---|---|---|
| F1 取数合规 | 未闭环 | 「取数合规=待确认；a/b 未答；mirror 通道 `authorization_status=unverified_third_party`」 | 「已获授权」「已解决」「合规」 |
| 授权条款文本 | 未闭环 | 「条款快照机制就绪，真实条款全文未落」 | 「条款已归档」 |
| 白名单 | 未闭环 | 「代码内接口白名单已声明；账号权限表未提供」 | 「白名单已确认」 |
| 来源解耦 | 架构达标、配置有缺陷 | 「适配层边界达标（门禁绿）；端点配置有漂移/明文风险（SEC-007/008）」 | 「解耦完成」「可直接换源」 |
| C 端展示 | 禁止 | 「403 / `EntitlementRestricted`」（红线③） | 「200 + `is_entitled=false`」 |
| 过渡期 | 仅 owner 本人单人访问 | 「内网≠免授权（L100）」 | 「内网=自用即可」 |
| 样本入仓 | 已知残留 | 「真实报文样本已入 git，与 L32 冲突，m02923 授权引用不可追溯（SEC-010）」 | 「样本已获授权/无风险」 |

## 3. 来源解耦核查（域名/字段是否抽到适配层 + 换源成本）

### 3.1 已达标（逐条 + 门禁实测）

| # | 检查项 | 事实 | 判定 |
|---|---|---|---|
| D1 | 厂商字样只活在适配层 | `adapters/tushare/transport.py:1-6`（唯一知协议处）、`adapter.py:1-8`（目录边界）；`services/ingest/README.md:11-19` 与 `config/ingest.yaml` 注释同口径 | ✅ |
| D2 | 端点可注入、不硬编码业务路径 | `adapter.py:72-74`（`TUSHARE_API_URL`/`DATA_SOURCE_MODE`/`TUSHARE_TOKEN`）、`adapter.py:945` `options.endpoint or os.environ.get(TUSHARE_API_URL) or ts_transport.DEFAULT_ENDPOINT` | ✅（但见 G1/G2） |
| D3 | 契约层平台词表 | `docs/adr/ADR-004-source-vocabulary.md`：`SourceRef.source` 封闭枚举 `platform_*`，禁厂商名进 `contracts/generated` | ✅ |
| D4 | 研究数据与面客数据物理隔离 | `config/ingest.yaml` OdsConfig display/internal 子目录 + `display_safe=false`；mirror 批次必须写 `source_channel/authorization_status/endpoint_host` 到 `_meta/research_coverage.json` + append-only `_meta/research_sources.jsonl`（`services/ingest/README.md:382-395`） | ✅ |
| D5 | 面客侧 fail-closed | `services/market/src/config.ts:37-38,92-94,113-130,144`：tier 默认 `internal_eval`，非 internal_eval 缺 `ENTITLEMENT_EXPIRES_AT`/指纹即拒启 | ✅ |

**实测（2026-11-06，可复跑，命令见附录 A）**：

- `pytest services/ingest/tests/test_boundaries.py` → **2 passed**（src 除 adapters 外不得出现源字样）。
- `node infra/ci/check-source-vocabulary.mjs` → **PASS**（扫描 11 文件，无厂商标识；SourceRef.source 为平台词表 enum）。
- `node infra/ci/check-internal-boundary.mjs` → 202 代码文件无越界 import（11-06 复跑值；上轮记 198，文件数增长）；面客 ApiPaths 不含 14 条内部 path。
- `python3 infra/ci/check_display_safe_failclosed.py` → ✅ 研究数据集不进 display root、不参与 display_safe、不进 C 端 ports。

### 3.2 缺陷（换源/取数控制面不全）

| ID | 缺陷 | 证据（file:line） | 影响 | 建议修法 | owner |
|---|---|---|---|---|---|
| G1/`SEC-007` | 配置漂移：`.env` 的 `TUSHARE_HTTP_URL=https://tuaremax.top` 是**死配置**，代码只读 `TUSHARE_API_URL`；全仓无 dotenv loader | `services/ingest/.env:6`；`adapter.py:72-74,945` | 仅写 `.env` 不会走 mirror；未导出 `TUSHARE_API_URL` 时**静默回落** `DEFAULT_ENDPOINT`（官方端点）→ 「mirror 已配置」不可当事实 | 代码与文档统一为单一变量（或 `TUSHARE_API_URL` 优先 + `.env` 注释改名）；未配置端点时 **fail-closed 拒绝启动**（研究域无端点=配置错误） | A1 |
| G2/`SEC-008` | 默认端点为 **http 明文** 且 transport 无 TLS/证书校验；token 在 POST body | `transport.py:21` `DEFAULT_ENDPOINT = "http://api.tushare.pro"`；`transport.py:91-104` | 未配端点时 token 明文出网，且打到官方端点（同时**改变授权基础**）；中间人可读 token | 默认改 `https://`；HTTPS 强制校验；非 https 端点启动即报错（可用显式 `ALLOW_INSECURE_ENDPOINT=1` 仅限本地回环） | A1 |
| G3/`SEC-009` | 限流未接线：`TUSHARE_RATE_LIMIT_PER_MIN=200` 全仓无引用；`quota.calls_per_minute=500`（reserve_ratio 0.2 → 实际 400/min），超 mirror 公开限速 200/min | `services/ingest/.env`；`config/ingest.yaml` quota 段；`transport.py:97`（只用了 USER_AGENT） | 打 mirror 超速 → 429/封禁，研究跑批可能中断；且「已限流」不可声明 | 把限流变量接进 transport（或 ingest 调度器）并按 mirror 声明 ≤200/min；配置注释写明来源 | A1 |

### 3.3 换源成本评估

- 架构层：决策 #4（`agents/decisions.md:122`）估「换源只改 `adapters/`，3–4 人日」。本次核查与该估计**一致**：
  端点/字段/协议全部收敛在 `adapters/tushare/`，契约层只看平台词表，切换数据源不动 contracts/serving。
- 但**当前不能只靠改配置换源**：①G1 使 `.env` 改端点无效（须改环境变量或代码）；②G2 要求新源必须 https；
  ③换源后须以运行产物 `_meta/research_coverage.json` 的 `endpoint_host` 举证（现有 smoke 产物 endpoint_host=null、
  `source_channel=replay`，属合成回放，**不能作为 mirror 取数证据**）。
- 结论口径：**「架构上可换源（3–4 人日）；当前配置下换源会被静默忽略」**。发布前应把 G1/G2 修为 fail-closed，
  否则「换源」只是文档事实。

## 4. 发布与安全边界（H4 veto 口径）

**不签的判定（数据授权半）**：三件未齐 + a/b 未答 → 11-12 发布**不签**。理由：无书面授权 = 无权利基础；
口头声明与 mirror 转售链条均不构成 L100 三要件；条款文本缺失使「个人/非商业/不可转让」无法核对。

**C 端维持关闭（技术事实，不由签字解除）**：

- `services/market/src/config.ts` 默认 `internal_eval`、缺 `ENTITLEMENT_EXPIRES_AT`/指纹拒启 → 当前未翻档；
- 红线③：无权展示一律 403 `EntitlementRestricted`，禁 200+`is_entitled=false`；
- `c_end_display` 翻档是**三方门禁 H4（含旧 H5 安全半）+ H3 + owner**（H3 书面放行、owner 最终放行），缺一不翻。

**签字边界**：我的 veto 只覆盖「数据源授权 + 安全运维」两半；**不代 owner 签授权、不代 A8 执行生产**。
安全半状态（2026-11-06 按 decisions.md L102–L110 更新，替代 11-05 gate 快照的旧表述）：
root 禁登已完成（L108 `PermitRootLogin no` + 具名 sudo `lyuddu`，L109 root 登录 residual=**CLOSED**、门禁⑤-3 PASS）；
密码登录已关（L102）；云 SG 80/8888 = **ACCEPTED-RISK**（用户 m05524 书面接受 + HOST-EXPOSURE-01 补偿控制，
L110 书面确认「SG 与 root 两项不再作为 11-12 发布签核前提」）。11-12 发布安全半现卡三项：
值班姓名/手机（BLOCKED）、真实寻呼通道（BLOCKED）、staging 15min 演练（NO-ENV），见 `security/gate/release-gate-block-2026-11-05.md`
（11-05 快照）与 `docs/runbook/README.md` 值班表状态。**三项可验收口径已出**：`security/gate/security-half-acceptance-2026-11-12.md`（逐项 PASS/ACCEPTED-RISK/OPEN 判据 + 证据清单 + 签半记录模板；任一 OPEN → 安全半不签）。

**即使三件齐，也不自动解除**：须 (a) 三要件逐条对上；(b) a/b 明确覆盖 mirror，或转官方端点方案并重拉全量；
(c) 条款文本与真实报文样本的处置口径（SEC-010）；(d) H4 复核（含旧 H5 职能） + H3 对 C 端出具书面放行 + owner 最终放行。

## 5. 催办清单

### 5.1 逐件催办路径（状态 / 责任人 / 催办路径——任务①交付口径）

| # | 件 | 当前状态（11-06） | 责任人 | 催办路径（谁催谁 → 催不到怎么升级） | 下一节点 |
|---|---|---|---|---|---|
| ① | 官方书面回复 | **未闭环**（仓库零书面实体，11-06 复核 `git ls-files` 仍无 `*.pdf/*.eml/*.docx`） | **owner**（向 tushare 官方索取并作答 a/b）→ H4 归档复核 | H4 → owner（本清单 A1+B2）→ 11-09 无书面进展则 L0 出升级通报 → 11-12 不齐记「未闭环」、发布数据半不签、residual 保留并上呈 owner | 11-09 中期检查 / 11-12 到期 |
| ② | 授权条款文本 | **未闭环**（机制就绪、内容缺；仓库内仅 `terms-synthetic.txt` 占位） | **owner**（提供全文+版本号+来源 URL）→ H4/A1 落 sha256 快照 | H4 → owner（清单 A2；不依赖 tushare 回复，可先行交付）→ 同上升级链 | 同上 |
| ③ | 白名单 + 来源解耦 | **部分达标**（代码白名单/架构解耦 ✅；账号权限表、可展示字段清单缺；G1–G3 技术缺陷待 A1） | **owner**（权限表+档位+字段清单，清单 A3/A4）；技术缺口 **A1**（G1/G2/G3） | H4 → owner（A3/A4）；技术件 H4 → A1（修 G1–G3 后重跑 smoke 使 `endpoint_host` 可举证）→ 11-12 时点同上；技术缺口本体不阻塞三件计数但阻塞「可举证」 | 同上 |

> 催办纪律：每次进展**追加**记录（§6），不改历史行；状态只认 sha256 实体，不认口头/转述；任何情况下不写「已解决」。
>
> **F1 同类 residual 并列跟踪**：SEC-012 AKshare/东方财富爬取（L136.3，2026-11-06 登记，见
> `../findings/register.md` §12）——来源=爬取东方财富，限内部研究/展示域，C 端实时行情展示放行待 H3/H4 裁；
> 与三件同在 11-12 节点盘点，催办口径并用本表纪律。

### 5.2 给 owner（用户）—— 3 条动作，11-12 前

> **完整版「需要什么材料 / 找谁签」清单已单列：[`owner-signoff-checklist.md`](owner-signoff-checklist.md)**（材料验收判据、签认矩阵、到期后果、常见误区）。

1. **书面回复**：发 H4 官方书面回复（邮件/PDF/盖章截图任一），并明确回答 **a/b**：是否覆盖第三方 mirror（tuaremax.top）
   取数；若否，是否改为官方端点 `api.tushare.pro` 方案（需重拉全量）。含糊回复按「未覆盖」处理，C 端继续 403。
2. **条款文本**：发 tushare 官方服务协议/授权条款**全文** + 版本号 + 来源 URL（含个人使用/不可转让/非商业/二次展示条款），
   H4 落 sha256 快照后回填台账；仅转述不算。
3. **权限表**：发账号权限表/接口授权清单截图（哪些接口、字段、额度），并确认套餐档位（10000 vs 15000 积分口径统一；
   dc_index/doc 362、dc_member/doc 363 已由 L136.1 实测可用，「不可用原因」一项作废）。

**内部（不占 owner 时间）**（操作级催办/到期处置流程见 [`docs/runbook/tushare-authorization-chase.md`](../../docs/runbook/tushare-authorization-chase.md)）：

- **A1**：修 G1（变量统一 + 未配端点 fail-closed）、G2（默认 https + 证书校验）、G3（限流接线 ≤200/min）；
  修复后重跑 research smoke，使 `research_coverage.json` 的 `endpoint_host` 可举证 mirror。
- **H4**：收件后把 sha256/路径/日期写进本表 §1，更新 `security/README.md` 索引；三件齐才把状态改「待复核」，
  **任何情况下不写「已解决」**。
- **L0/A0**：`infra/ci/path-guard.mjs` 的真实注册表在 11-06 重建后不合法（`packages/design-tokens/` owner `M1`、
  `agents/` owner `L0` 不在主体白名单 A0–A19/H1–H6/lead），导致 CI 路径门禁无法校验真实路径（自检 13 项仍 PASS）——
  建议修白名单，不在 H4 写域。

## 6. 复核节奏

| 时间 | 动作 | 判据 |
|---|---|---|
| 11-09（剩 3 天） | 中期检查：三件进度 | 无任何书面进展 → 出升级通报：C 端继续阻断，F1 授权期限风险上升 |
| 11-12（到期） | 三件齐 → 复核记录交 H5/Lead；不齐 → 记「未闭环」并保留阻断 | 以 sha256 实体为准，不以口头/转述为准 |
| 每次进展 | **追加**记录，不改历史行 | 保留「当时结论」可追溯 |

## 附录 A：证据复跑命令

```bash
PYTHONPATH=services/ingest/src python3 -m pytest services/ingest/tests/test_boundaries.py -q -o addopts=""
node infra/ci/check-source-vocabulary.mjs
node infra/ci/check-internal-boundary.mjs
python3 infra/ci/check_display_safe_failclosed.py
grep -rn "TUSHARE_HTTP_URL" services/ingest/ ; grep -rn "TUSHARE_RATE_LIMIT_PER_MIN" services/ | grep -v "\.env"
git ls-files | grep -Ei "\.(pdf|eml|docx|msg)$"   # 预期空 → 无书面授权实体
```

## 附录 B：关联文档

- `security/compliance/owner-signoff-checklist.md` — owner 材料/签认清单（任务③交付物）
- `security/findings/register.md` — SEC-011（F1 residual 显著登记）、SEC-007/008/009（取数控制面缺陷）、SEC-010（真实报文样本入 git）
- `security/gate/release-gate-block-2026-11-05.md` — 安全半 gate 判定（11-05 快照；安全半现状见本文 §4 更新）
- `docs/runbook/tushare-authorization-chase.md` — 催办/到期处置 runbook（六段式）
- `agents/decisions.md` L32 / L91 / L98 / L100 / L102 / L108–L110 / L118 / L127 / L131；决策 #4 / #10
- `services/ingest/README.md`（§条款快照、§mirror 批次 gate）；`docs/adr/ADR-004-source-vocabulary.md`
