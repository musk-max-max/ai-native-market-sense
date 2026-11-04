# P0 验收标准（个股页竖切片）

> 状态：Lead 起草，**H1 已会签（2026-11-04）**——会签同时加入 §0 发布卡点、§4b 证据状态，并拍定 §6 的 AC-10 口径
> 生效条件：已生效，作为 A3 / A7 / A12 的共同验收口径
> 原则：**每条都必须能被机器判定**。写不出判定方法的，不进这份文档。

---

## 0. 发布卡点（P0 收尾清单）

> H1 会签 2026-11-04。本节是**发版闸门**，不是待办列表：下列任一条未关闭，P0 不发版；M2 的"可演示"不能顺延成"可发布"。

| # | 卡点 | 内容 | 责任人 | 预算 | 关闭条件 |
|---|---|---|---|---|---|
| **R-1** | 授权 fail-open（H5-R4 / L18 / L24） | 三处 fail-open 叠加 → 按 Helm 部署即对 C 端展示行情 | A3 1.0 + A13 0.5 | 1.5 人日 | 见 §0.1 |

### 0.1 R-1 的关闭条件

**性质澄清**：L18 的三处默认值**代码侧已反转且有单测**（`services/market/src/config.ts:66` 缺省 `internal_eval`；`assertEntitlementTimebox` 缺到期时间即拒绝启动；`services/market/test/market-plugin.test.ts:557-599` 覆盖），Helm 模板也已写 `required` / `fail`（`infra/helm/market-sense/templates/configmap.yaml:11-13`）。所以这 1.5 人日**不用于写实现**，只用于证明"部署形态下确实生效"。

**真实缺口：部署面验证一次都没跑过。** 本机 `helm` 未安装（`which helm` 为空），`helm lint` / `helm template` 只存在于 `.github/workflows/ci.yml:404-411`，而该 workflow 从未在真 runner 跑过。

R-1 关闭需同时满足：

1. `helm template` 在 `ENTITLEMENT_TIER != internal_eval` 且缺 `ENTITLEMENT_EXPIRES_AT` 时**渲染失败**（非零退出）；默认 values 渲染出的 configmap 含 `ENTITLEMENT_TIER=internal_eval`；
2. 用渲染出的 configmap 起一次真栈（原生栈即可），**不配置** `ENTITLEMENT_TIER` 时行情/财务接口返 403 + `ENTITLEMENT_RESTRICTED`；
3. 启动时无条件写 `tier_state_observed`（L20 前半段）。**不含** reconciler 对账回退——L23 已把 reconciler 推迟到 P1，P0 的验收不建立在"从未跑过的组件"上。

**预算纪律**：1.5 人日封顶，不挂在 task-2 名下、不算新功能。若第 2 条需要新起一整套环境而超出，回来重报；若 1.5 人日做不完上述三条，说明缺口比登记的大，按卡点升级处理。**不接受"先发版再补"。**

### 0.2 R-1 与竖切片的排期规则

- 冲突时 **R-1 优先**。理由是误放行一次，之后所有合规结论都要重做（H3 的否决线判定建立在"当前未对 C 端展示"之上）。
- 但优先的是**闸门执行顺序，不是 A3 的工作顺序**：A3 的 1.0 人日从竖切片里借，代价记在**里程碑完成时间**（M2 后移），**不记在范围上**。不接受用"砍 AC-1b / 砍 P0-10"来腾这 1.5 人日。
- 竖切片验收标准一条不降。R-1 不构成"少验一条 AC"的理由。

---

## 1. 范围

一条用户旅程，真栈端到端：

> 打开个股页 → 看到行情 → 看到 as_of → 看到数据来源 → 看到免责 → 数据过期时看到 stale 标记 → 加自选 → 刷新后自选还在

**不做**：AI 荐股/评级、目标价、盯盘推送、开户、社区、付费墙、多市场、中后台四合一、CRM。
（decisions.md #8 已列明确排除项，任何一条被加进来，本验收自动失效。）

---

## 2. 功能验收（AC）

| # | 断言 | 判定方法 | 责任 |
|---|---|---|---|
| **AC-1** | 打开 `/stocks/{instrument_id}`（`/stock/*` 为保留别名，不进验收），首屏出现证券名称、最新价、涨跌幅、as_of、数据来源、免责声明 6 个元素 | E2E：6 个 testid 全部可见，且**无需滚动** | A7 |
| **AC-1b** | 数据来源以**人可读标签**展示（契约枚举 → 受控映射表），不得直接渲染内部标识（如 `snapshot`）；映射表未覆盖的枚举值**原样显示**而非留空或写「未知」；映射不得美化（`delayed` 不得显示为「实时」） | E2E：mock 返回 `platform_snapshot` → 页面显示「平台行情快照」；注入未知枚举 `weird_source` → 页面原样显示 `weird_source` | A7 |
| **AC-2** | 页面 as_of 文本与 API `source.as_of` 严格一致 | E2E：读 API 响应 → 与 `[data-testid=as-of]` 文本比对，字符串相等 | A3 / A7 |
| **AC-3** | `staleness_ms > 900000` 时出现 `[data-testid=stale-badge]`；≤900000 时不得出现 | E2E：两条 fixture，一条 stale 一条新鲜，断言相反 | A7 |
| **AC-4** | 免责声明元素首屏可见，且**没有任何关闭/折叠入口** | E2E：断言 `[data-testid=disclaimer]` 可见；断言 DOM 内不存在 `[data-testid=disclaimer] [aria-label*=close]` 之类的关闭控件 | A7 |
| **AC-5** | 未授权时 API 返回 **403 + Problem `ENTITLEMENT_RESTRICTED`**（不使用 200+`is_entitled=false`，避免客户端渲染出数字），页面显示 `entitlement-notice`，**不得出现任何行情数字** | E2E：restricted 矩阵（`internal_eval`）→ 断言 403 + code + 断言页面无价格选择器 | A3 / A7 |
| **AC-6** | 点击加自选 → `POST /v1/watchlist` 成功 → 刷新页面后该标的仍在自选列表 | E2E：点击 → 刷新 → 断言列表包含该 instrument_id | A3 / A7 |
| **AC-7** | 前端代码 0 处裸 `fetch` / `axios` | CI：`grep -rE "fetch\(|axios" web/h5/src --include=*.ts*` 结果为空 | A13 |
| **AC-8** | 涨跌幅带正负号与单位（%），价格带币种 | E2E：正则匹配 `^[+-]\d+(\.\d+)?%$` | A7 |
| **AC-9** | 首屏 JS ≤ 200 KB（gzip） | CI：构建产物体积断言 | A13 |
| **AC-10** | 页面 3 秒内可交互（真栈本地） | E2E：`performance` 断言 | A12 |

---

## 3. 数据验收（DA）

| # | 断言 | 判定方法 | 责任 |
|---|---|---|---|
| **DA-1** | golden 全过。资产现为 **21 正例 + 9 负例 = 30 条**（原文「20 条」已过期，按资产实际条数验收；条数只增不减） | CI：`tests/data` 全绿 | A2 |
| **DA-2** | 质量分 ≥ 90（黄区可发布但需 H4 备注；< 90 阻断） | CI：质量分计算脚本输出 → 与阈值比对 | A11 |
| **DA-3** | 适配层外 0 处 tushare 原生标识 | CI：`grep -rE "tushare|ts_code|pct_chg" --exclude-dir=adapters --exclude-dir=fixtures --exclude-dir=recordings --exclude-dir=ods` 结果为空 | A13 |
| **DA-4** | 每条 bars 记录带 source / as_of / adj_type，无一为空 | CI：数据校验断言非空率 100% | A11 |
| **DA-5** | 质量规则可被破坏性验证：注入一条 `high < low` 的数据必须让 CI 红灯 | CI：负向用例 | A11 |

---

## 4. 交付验收（Dlv）

| # | 断言 | 判定方法 |
|---|---|---|
| **Dlv-1** | 契约 4 份可被 oasdiff 解析，破坏性 diff 为 0 | CI |
| **Dlv-2** | ownership path guard 生效：越界写目录的 PR 必须红 | CI（构造一个越界提交验证一次） |
| **Dlv-3** | 真栈一条命令起：`tests/e2e/scripts/up.sh` 后 preflight 全绿 | 有 docker 的环境跑一次并留记录 |
| **Dlv-4** | 11 条 P0 E2E 用例全过（无 skip） | CI |

## 4b. 验收证据状态（H1 记录，2026-11-04）

> 口径：**"已被证据覆盖" ≠ "验收通过"**。任一 **AC** 落在 C 类，P0 即未通过（§5）。DA / Dlv 组不在本表代评，由 A11 另出证据台账。
> A = 有门禁且真跑过、可复现；B = 有实据但未进门禁，或门禁从未在真 runner 跑过；C = 纸面，无任何可执行证据。

| 断言 | 证据 | 类 |
|---|---|---|
| AC-1 | E2E-P0-00：6 元素 `toBeVisible` + `toBeInViewport`（390×844） | A |
| AC-1b | 单测 `web/h5/test/source-labels.test.ts`（枚举全覆盖 / 未知标识原样返回）；E2E-P0-00 只锚 `data-source` 属性，未验文案映射 | B |
| AC-2 | E2E-P0-03：UI 文本与 API `source.as_of` 严格相等 | A |
| AC-3 | E2E-P0-04：stale 双向断言 | A |
| AC-4 | E2E-P0-05：免责常驻、无关闭控件、版本与 API `meta` 一致 | A |
| AC-5 | E2E-P0-06：403 + `ENTITLEMENT_RESTRICTED` + 页面无价格选择器 | A |
| AC-6 | E2E-P0-08（UI + API + DB 三处一致）+ P0-09（刷新后仍在），二次复跑已绿 | A |
| AC-7 | 当前 `grep` 为空，但 **CI 无该门禁**（`ci.yml` 无此步，`eslint.config.mjs` 仅声明 `fetch` 为全局） | B |
| AC-8 | E2E-P0-02：`^[+-]\d+(\.\d+)?%$` + 币种 | A |
| AC-9 | 门禁脚本 `web/h5/scripts/check-budget.mjs` 已接入 `ci.yml:220-221`；本地跑 **79.1 KB gzip / 200 KB，PASS**；CI 未真跑 | B |
| AC-10 | 无任何测量 | C |

**证据环境口径（重要）**：M2 真栈的 11 条 E2E 跑在 `ods-smoke` / `data/golden/p0_bars20.yaml` 合成样本上——`/tmp/real-stack.png` 里 `SSE:600519` 收盘 **10.30** 与 golden 的 `close: '10.30'` 一致，不是 tushare 真实回报（茅台 2024-01-04 实际收盘约 1685 元）。所以这批证据只证明**"链路通、契约一致、护栏生效"**，不证明"数据正确"。数据正确性归 DA 组，且必须用真实回补样本产出——**不得用 golden 自证**（golden 是 A2 自己的回归集，拿它证明 A2 的数据是对的属于循环论证）。

### 4b.1 当前未通过项（不得写成"验收通过"）
| 项 | 现状 | H1 裁定 |
|---|---|---|
| **Dlv-4** | **10 passed / 1 skipped**（P0-10 缺 replay 资产：`tests/e2e/tushare-replay/recordings` 目录不存在） | **未通过**。不降级：P0-10 验的是"未录制请求不静默造假数据"，属 F1 授权面护栏。补资产后重跑；在此之前只允许说「10/11 有实据」 |
| **Dlv-3** | compose 真栈一次未跑（本机无 docker）；原生真栈已跑（BOARD §六） | **部分**。记"等价替代已验、compose 形态未验"，不得并成"真栈已验" |
| **AC-10** | 无测量，口径见 §6（H1 已拍） | 未通过；按 §6 口径补测后重判 |


---

## 5. 不通过的判定

任一 AC / DA / Dlv 失败即 P0 不通过。**不接受**以下理由：

- 「本地能跑，CI 不行」
- 「实现没问题，是测试写错了」（改测试须 A11 书面同意，且需说明为什么原断言是错的）
- 「先上线再补」

---

## 6. 未定项（需要人类表态）

| 项 | 需要谁 | 影响 |
|---|---|---|
| ~~首屏 3s 的测量口径~~ **已拍（H1，2026-11-04）** | A12 执行 | 冷启动（新 browser context，清 HTTP 缓存，保留登录态）；真栈原生形态（PG 55432 + api 8081 + web 3000）；视口 390×844；**不节流网络**；连跑 3 次取**中位数 ≤3000ms**。"可交互" = 首屏 6 元素可见且加自选按钮 `toBeEnabled`。测不出就记未通过，不记纸面 |
| 质量分 90 是硬门槛还是可豁免一次 | H4 | DA-2 |
| 无授权状态下是否允许展示「延迟 15 分钟的前收盘价」 | H3 | AC-5 的边界 |
