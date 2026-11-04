# S0 状态快照（2026-11-04 08:45，Lead 亲验）

> 本文件只写**我本人执行过命令验证过**的事实。agent 自报未复核的，标注「自报」。

## 一、当前可运行的东西

| 层 | 状态 | 证据 |
|---|---|---|
| 数据链路 | ODS → DWD → 质量门禁 → serving → API → H5 | 坏数据 quality 80/black，`load` 退出 3 且**不连库**；好数据 100/green |
| 真栈 | 本机 Postgres 16 + API 8081 + Web 3000 | `/healthz` 200，`/v1/instruments/SSE:600519/quote` 200 |
| E2E | **11 passed / 1 skipped**（P0-10 已转绿） | 真栈 19 条合成录制；唯一 skip=P0-11 hold；详见 `tests/e2e/E2E-RUN-2026-11-04-native.md`（path+sha256 为准） |
| 单测 | `258 passed, 1 skipped`（根，Lead 2026-11-04 亲跑 13.7s）+ `133 passed`（ingest） | `pytest tests/contract tests/data warehouse/tests` |
| 类型 | `pnpm -r typecheck` 5/5 Done | api / market / web-h5 / ingest / api-client |
| 契约 | 4 域 OpenAPI + 生成客户端 | oasdiff 无破坏性变更，redocly 0 error |

## 二、必须说清的三条限制（别读成"完成了"）

1. **M2 演示用的是合成数据。** 截图里 `SSE:600519` 收盘 10.30，来自 `data/golden/p0_bars20.yaml:32`；真实 2024-01-04 收盘约 1685。M2 证明的是**链路通 / 契约一致 / 护栏生效**，不证明数据正确。
2. **F1 数据授权未取得**（时间盒 2026-11-12）。当前 `entitlement.tier=internal_eval`，C 端不渲染行情。11-12 后仍未取得 → 服务端拒答，不是降级。
3. **CI 从未在真实 runner 跑过**（仓无 git remote）。5 个 workflow 只过 actionlint；`helm` 渲染与 oasdiff 破坏性 diff 两处 skip 属环境缺件。

## 三、11-12 门禁（8 + 4 条，H5 按此签）

**entitlement**：①到期 fail-closed（quote/bars/fundamental 三路径分别断言）②配置非法→启动失败（退出码≠0 且端口未监听）③`(c)` 白名单 7 字段 ④hold/stale 生效 + 403 不可复用 + 凡含 `meta.entitlement` 的响应 `no-store` ⑤渲染无占位、四原因文案一致 ⑥事件可回指且幂等（含 hold set/clear 与 deploy）⑦前端无可绕开关（A19 攻击必须失败）⑧裸启动 → 403 + `internal_eval`

**限流**：①第 61 次 429 + `Retry-After` 整数 ≥1s ②problem+json `RATE_LIMITED` ③伪造 XFF 不换桶 ④文案不露内部码

当前：PASS 4.5 条；FAIL 1（no-store）；BLOCKED 3（hold/stale、事件、限流）。

## 四、唯一硬依赖

| 依赖 | owner | 卡住什么 |
|---|---|---|
| `audit.entitlement_events` / `control` 迁移 | A13（A5/H3 review） | A3 写事件、A11 三条断言、H5 签字 |
| api 出口层两件套（no-store + 限流） | A0 | 门禁 #4 与限流桶 |

## 五、等用户决定

1. **11-12 授权主体**：以哪个主体签、有没有资质。
2. **是否接 git remote**：不接则 CI 永远「未验证」，H5 不签发布。

## 五、今天新增的裁定（`agents/decisions.md`）

| 编号 | 一句话 |
|---|---|
| L41 | `ioredis` 批准（限流须跨副本共享）；oasdiff 报不出"删 optional response property"是门禁的洞 |
| L42 | `display_safe` 不许路径信任，改证据式合取派生，默认 false |
| L43 | manifest 完整性由**读取方**验证（`prev_hash`/`head` 链），不由写入方声明 |
| L44 | hash 只能脚本重算；`E2E_MODE` 生产拒启；清单不得代人签字 |
| L45 | 不自写 differ，用 oasdiff `--severity-levels`；两处门禁口径必须同一个文件 |
| L46 | `APP_PROFILE` 缺省 prod，开发必须显式声明；`NODE_ENV` 退出安全判定 |
| L47→L48→L49 | `reason` 最终单列 6 值；我改判两次，教训写在 L49 末尾 |
| L65 | 降级原因唯一真源 = `docs/reference/entitlement-reasons.json`，代码从文件读，散文里并列两个真源谁先被读到谁赢 |
| L68 | `002_audit_gap.sql` 补库级 CHECK（jsonb 漏字段不报错 = 检测侧 fail-open） |
| L74 | 状态词表唯一 PASS/PARTIAL/FAIL/PENDING-H5；PASS 只由 A11 事实 + H5 签字产生 |
| L75 | 引用文件前必须亲验（存在/size>0/sha256）；裁定材料不得出现未经亲验的量化数字 |
| L76 | `MARKET_NOW` 冻结时钟 = 等价绕过时间盒 → prod 拒启；`ENTITLEMENT_AUDIT=0`/`EVENT_PAYLOADS_PATH` 同罪 |
| L77 | #4 真实缺口是「没有超时」不是「造不出环境」——`plugin.ts:97` Pool 无超时，黑洞下 403 都到不了 |
| L78 | H1 成本裁定：A 路直接过 / B 路 8–30 万要重签 / C 路范围降级须留痕；**git remote 缺失 = P0 记未发布** |
| L79 | H2 纠正：L6 第三条不变式**已在**（非待办）；ci-gate 不得无条件打印「CI 通过」；P0-10 已转绿 |

## 六、唯一硬依赖（等决策）

`entitlement.tier` 停在 `internal_eval` ⇒ 恒 403 ⇒ **C 端页面为空**（连证券名称都取不到，基础信息还须来源解耦）。
时间盒 2026-11-12。三条路：A 拿 tushare 商用+再分发授权 / B 找持牌数据商转授权（8–30 万/年）/ C 降级为非行情工具。

## 门禁 #7 红队（2026-11-04）

- 结果：46 checks → 44 BLOCKED / 1 LEAK（R4，条件性）/ 1 INFO；**无 BYPASS**。
- **状态：#7 = `PARTIAL`（`L74` 四列清单）**
  - 已证：A19 动态攻击 46 项机器结果（44 BLOCKED / 1 LEAK→R4 已修 / 1 INFO，每项含 observed 响应）+ 5 张截图 + REPORT §3 样例；R4 修复后 `TRUST_PROXY` 启动拒绝 4/4、R4 FAIL→PASS。
  - 缺① 原始 HTTP 日志：`artifacts/http-attempts.jsonl` 现为 0 字节（`cases/api.mjs:17-20` 每次 run truncate；且被删前仅 2 行）→ **需 A19 全量重跑重建，owner A19，证据入 v3 后记 path+sha256**。
  - 缺② 公网 ingress（`/v1` 之外外部 404）→ owner A13，需 staging。
  - **release note 措辞**：「46 项机器结果 + 截图；原始日志重建中（residual, owner A19）」。**不得写「100+ 条原始往返」——那是我未经核实给出的数字，已作废。**
- **仍未覆盖**：条件 2（ingress 覆写而非追加 XFF）需 staging；条件 3（helm 静态守卫）不在攻击环境，已由 A0/A13 单测+helm 4.3.1 交叉验证替代，**不记为攻击侧证据**。
- 证据口径：受限态判定只认隔离栈（18182–18187/3200–3201）+ 独立库 `market_sense_a19`；本机 8081 为有效态 demo，不得作未授权证据。

## 11-12 门禁回执（2026-11-04 09:16，A11）

**entitlement 8 + 限流 4 = 12/12 有证据**（a13_verify @ 002 `c118eeb3`，API :18095–18099）。证据包 `tests/data/acceptance/artifacts/11-12-evidence-20261104.tar.gz` sha256 `feda377a0d31ce6076241b2153618033560a9c6b79c13b3db924a6ce928391d0`（同目录 `SHA256SUMS`；原 `ea10e5fc…` 作废——tar 先建、后改 CI_MOUNT），明细 `tests/contract/CI_MOUNT.md §7.7`。日常门禁 `pytest tests/contract tests/data` = **136 passed / 1 warning**。

**本次未取证 3 条（不得计入 PASS）：**
1. #5 的 DOM/渲染层数值泄漏断言 —— 属 A12 `tests/e2e` 域，A11 未执行。
2. #7 公网 ingress（`/v1` 之外外部 404）—— A13 未配 `PUBLIC_BASE_URL`；H5 对 R4 的书面风险接受未落（R4 已修复，引用 A19 修复后 PASS）。
3. #4 的 control「真实网络不可达」P95 —— 最终复跑未含，仅早前记录与 fake-control harness。

**仍未闭合（非 A11 域）**：真实 GitHub runner 首跑（仓无 remote）；`docker compose build` / 镜像构建未验证；H4 授权三件（11-12 到期）。

| **L78** | H1：授权主体代价（A=1万/年在预算内直接过；B=8-30万/年需 H1 重签+再分发条款；C=个股页降基本面+自选+免责）；合成数据三条（明写合成/不进 release note/不作 DA 组证据）；**git remote 缺失=P0 记未发布，不接受「本地全绿」顶替** | 2026-11-04 |
| **L79** | H2：L6 第三条不变式已在（path-guard owns 解析）；ci-gate 否决「CI 通过」必须带例外标注；`lot_size` waiver 截止 2026-12-15 到期不续 | 2026-11-04 |
| **L80** | M04 ST 时点性 P0 用当前名称快照（无历史名称源）；未知 board fail-closed=limit_status NULL；namechange 记 P1 数据依赖 | 2026-11-04 |
| **L81** | C01 正向清单扩 `services/ingest/tests/**` + 渠道标识 `tushare`（H4 强制名）豁免；`samples/h4-audit/` 清除 | 2026-11-04 |
| **L82** | ① L52 哈希范围句：事件表按 001，JSONL 按 L52（不推翻已交证据）② 11-12 compliance 纯 DDL（clause_review 走运维角色 psql，apr_uuidv7 属 P1/A4）③ 外部校验哈希 DB canonical 文本不用 Python 重排 float ④ copy 版本裁 b：死常量不触发门禁，受限页时效显示是 bug 现在删，其余记 2026.11.5 文案清单（f56 保持）⑤ 自指哈希=坏模式，CI 只校验 manifest 覆盖率+独立复算，不扫内容十六进制串 ⑥ M04 维持 L80 ②（A1 纠偏：上游下游均无历史名称源）⑦ C01 扩 ingest/tests | 2026-11-04 |
