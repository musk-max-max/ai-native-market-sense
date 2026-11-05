# ADR-006：用户可见文案治理（copy.ts / COPY_VERSION / 客户端可达出口）

- 状态：Accepted（H3 门禁，H3 验收线 m00839 / m00870；H4 文案口径 m00789）
- 日期：2026-11-04
- 关联：ADR-001 D4（Problem 错误体）、ADR-004（来源词表/合规）、H3 m00839/m00870、H4 m00789、Lead m00844
- 可逆性：高。文案文件拆分/合并均可回退；版本轴与快照一旦发布按 append-only 保留历史。

## 背景

C 端响应里出现供应商标识、内部 tier 码、`source_id`、错误码原值或英文原文，不只是 UX 缺陷：
F1 授权未落地时可能同时构成对上游的保密义务违反（H3 m00839）。H3 要求"客户端可取得即出口"，
包括 HTTP body/headers、错误 title/detail、回传前端的日志字段、`copy.ts`，以及**生产构建下发的 DOM 属性**
（如 `data-problem-code`）。已知一处 `services/market/src/errors.ts:32` 的「（F1）」按"存在一类"处理。

## 决策

### D1 单一文案来源（每端一个文件）

- 后端：`services/api/src/copy.ts` 是**所有服务端用户可见文本**的唯一来源；域插件（如 `services/market`）
  不得自建文案表，import 外壳的 copy 模块（`../../api/src/copy.js`）。
- 前端：`web/h5/src/lib/copy.ts` 是前端用户可见文本的唯一来源（A7 已建）。
- 禁止：handler/组件/错误构造器里拼中文字面量；把 `error.message`、`error.code`、tier 值、`source_id`、
  厂商名直接写进响应或 `detail`/`title`。
- 免责声明正文与版本仍以服务端 `meta.disclaimer` 为准（契约字段），前端只展示不改写。

### D2 同一版本轴 + 成对发版 manifest

- 两端 `COPY_VERSION` 用同一格式 `YYYY.M.D`（同一天发布可同值，但**每次发版必须成对登记**）。
- `docs/release/copy-version-manifest.md` 按发版追加一行：release、frontend COPY_VERSION、
  backend COPY_VERSION、两端内容 hash、依据（PR/变更说明）。改一端文案未登记 manifest = 发版不完整。
- 不要求两端合并成一个文件或一个包（部署边界不同），但"线上生效文案唯一回指"必须由 manifest 保证。

### D3 append-only 文本快照 + 构建期 hash 校验

- 每个 `COPY_VERSION` 在 `docs/release/copy-snapshots/<COPY_VERSION>.<content-hash12>.<side>.json`（side = backend / frontend）存该版本该端全部用户可见文本；文件名带内容 hash，保证同日多版不会覆盖旧快照；
  快照只增不改，旧版本回指以快照为准。
- 构建期校验（`services/api/scripts/check-copy-version.mjs`，挂在 `pnpm --filter @market-sense/api build`）：
  1. `COPY_TEXT_HASH` 必须等于当前文本的规范化 hash；
  2. 当前 `COPY_VERSION` 的快照必须存在且逐字匹配当前文本；
  3. manifest 里的 hash **只能来自校验脚本重算并写入/核对**，禁止手抄任何一方口头回报值；人工只审脚本产物的 diff。
     hash 变化必须能由文本变化解释；解释不了即视为规范化算法变更，须在 ADR 记录（H3 m01237）。
- 文案改了不升版本 / 不加快照 → 构建失败。前端对应校验由 A7 在其构建脚本实现（H3 m00870）。
- manifest 数字列由 `services/api/scripts/copy-manifest.mjs` 重算并覆盖写入（`pnpm --filter @market-sense/api copy:manifest`），
  `--check` 版本挂在 build 链（`check:manifest`）；人工只写 release/日期/依据列，不改数字（H3 m01237 / Lead m01254）。

### D4 客户端可达出口判据（非"肉眼可见"）

出现即红：`F1`、供数方/厂商名（tushare/wind/choice/ifind/akshare/eastmoney）、积分套餐、
`internal_eval`、`c_end_display`、`platform_user_data`、`research_only`、`channel=`、`source_id`、
`ENTITLEMENT_RESTRICTED` 等内部码、Fastify/Node 英文原文。
范围：HTTP body/headers、Problem 的 title/detail、返回前端的日志字段、copy 文本、
生产构建下发的 DOM 属性（`data-*`、aria 等）。E2E/test 专用属性必须被生产构建剥离或仅在 E2E 模式注入。

**生产构建产物本身也是出口**（H3 m01038 条件 4）：bundle/sourcemap 下发的源码注释同样可被客户端取得。
因此生产构建必须 `removeComments`（`services/api/tsconfig.build.json`）且不发布 sourcemap；
`services/api/scripts/check-dist.mjs` 在 build 后断言 dist 无 `.map`、无厂商名/`F1` 标识（挂在 `check:dist`）。
只清可见字符串、不清注释/sourcemap = 白做。

**响应头也是出口**（H3 m01498）：生产不得下发 `X-Entitlement-Cause` 或任何授权原因区分头；
授权的 6 值 cause 只进服务端事件/审计日志，排障凭 `trace_id` 反查，内部后台要走内部路由。
如确需非生产诊断，必须默认关闭、显式开关（`ENTITLEMENT_CAUSE_HEADER=1` 且 profile=dev/test/e2e），
生产配置该开关直接拒绝启动。外壳在 `/v1/*` 的 onSend 统一 `removeHeader` 作 defense-in-depth，
`services/api/test/app.test.ts` 断言 403 头集合无该头且头值不含 expired/hold/stale/unauthorized；
A12 E2E 出口扫描必须覆盖响应头而不只是 body。

### D5 扫描与测试交付物

- 静态扫描清单：`docs/release/copy-export-scan.md`（文件:行 + 处置 + owner）。
- 后端断言：`services/api/test/app.test.ts` 的「客户端可达出口不含内部标识/英文原文」用例
  （覆盖 400/404/500 与 problem+json）。
- HTTP 全链路断言：由 A12 在 E2E 对所有客户端可见响应做一次统一扫描（H3 验收线）。
- 生产构建产物断言：`services/api/scripts/check-dist.mjs`（无 sourcemap、无厂商标识/`F1`），
  挂在 `pnpm --filter @market-sense/api build` 的 `check:dist`。
- DOM 断言：由 A7 用 Playwright（生产构建）断言 DOM 不含内部码；`data-problem-code` 若保留，
  生产值必须是用户语义且**单一值** `entitlement`（所有授权类 403 共用，不区分 expired/hold/stale/unauthorized；
  区分只留服务端事件）。做不到单一值就生产不下发该属性（H3 m01038 条件 5）。
- 扫描清单中的每一项必须给出 owner 与处置（改 copy / 删除 / 标为内部不再下发），不留"待定"。

### D6 H3 验收条件（m01038，全部满足前扫描清单 OPEN 项不得标 DONE）

1. 404 对外统一措辞可用「资源不存在」；技术成因（路由 404 / 资源 404 / 403）只进事件与日志，不进用户文案。
   C 端深层链接路由类 404 由前端兜底页处理，标的类用「暂未找到该标的」。**403 判定先于 404**，
   由 `services/market/test/market-plugin.test.ts` 的「存在但受限不返回 404」用例证明。
2. 扫描清单不得有「DONE（待 X 确认）」；未完成就是 OPEN，第 4/5 项已合并为一条 A3 任务。
3. 快照文件名必须带内容 hash（或序号），同日多版不得覆盖；manifest 每行引用实际文件名。
4. 出口判据包含生产构建产物本身：js/css/html 及 sourcemap（若下发）的字符串扫描；API 侧
   `removeComments` + 不生成 sourcemap + `check:dist` 断言（见 D4）。
5. DOM 生产值 `entitlement` 必须单一值（见 D5）。
6. 本 ADR 标 Accepted，但以上 5 条是 Acceptance 条件；待办 owner 同步更新。

### D7 AI 标识/免责（H3 m02666，2026-11-05）

AI 生成内容的显式标识与免责由**后端 copy**（`services/api/src/copy.ts` 的 `AI_COPY`）唯一持有，
由 `services/api` 在 P7 最终响应层注入；前端 `AiGeneratedBadge` 只渲染必填的 `label`/`disclaimer`，
**不得硬编码 fallback 文案**（否则双源、且可能绕过 H3 签字）。

H3 m02666 替换后的定稿：

- label：`AI 生成 · 仅供参考`
- disclaimer：`本内容由 AI 生成，基于页面标注时点的市场数据整理，仅供参考，不构成投资建议，也不构成任何买卖依据。`

措辞理由（H3）：label 只承担标识义务——对生成过程的事实描述词（如「整合」）未来生成分析时可能不实；
「非投资建议」是法律定性，放常驻标签等于每次自我定性，由免责正文承担。disclaimer 补「由 AI 生成」
（显式标识要素）、「公开数据」→「市场数据」（授权未落地不对数据权利基础表态）、保留时点。

H3 附四项机制条件（是「能不能签」的前提，不是措辞；在 P7/C 端 AI 上线前必须验收）：

1. **隐式标识 + 留痕**：AI 响应体带机器可读元数据（如 `meta.ai.generated=true` +
   `content_version`/模型标识），服务端保留生成/展示留痕（模型、版本、时间、输入口径版本）≥3 年；
   只有显式 badge 不够。归属：A0 契约 + A3/A4 实现；状态：P7 尚未接路由，未满足。
2. **时点必须真实存在**：disclaimer 声称「页面标注时点」时，页面必须实际有 `as_of` 字段；
   若无 `as_of`，badge/disclaimer 与数值同时不得渲染；须有测试。归属：A7 前端 + A11/A12 测试；
   状态：待 A7 实现并补测试。
3. **不可关闭/不可折叠隐藏**，复制/导出文本必须携带 label + disclaimer；前端不得硬编码 fallback。
   归属：A7；状态：`AiGeneratedBadge` 无关闭入口已具备，复制/导出与 fallback 待验收。
4. 把「不构成投资建议」这类法律定性写进常驻标签的「免责即定性」措辞，不得出现在将来任何正文里；
   `非投资建议` 是标识义务，不豁免〔2012〕40 号文四项。归属：A0/A16/H3；本次已从 `AI_COPY`
   与对外契约/ADR 文案中移除，且 ADR 不再引用旧标签字面，避免文档/实现漂移。

H3 m02810 回签记录：先签「文案」、四项机制条件作为「AI 生成内容上线」门禁，两个签字对象不合并；
backend 快照 `2026.11.5.ac875c9d9237.backend.json` 记「文案侧 H3 通过」，凭证 m02810。
**条件 1 未满足期间，AI 路由可开发/可 mock，但不得对任何用户展示模型生成的可见内容。**
机制条件验收清单见 `docs/release/copy-export-scan.md`「AI 生成内容上线门禁」节。

## 被否选项

| 选项 | 否决理由 |
| --- | --- |
| 两端各自独立版本号、不做 manifest | 无法回指线上生效文案；H3 明确否决 |
| 一个 monorepo 共享 copy 包 | 部署边界不同、前端/后端发布节奏不同，强耦合收益低；且 H5 构建会带后端文案 |
| 只修已知 `services/market/src/errors.ts:32` | H3 按"存在一类"处理，必须建立机制 |
| 用 grep 黑名单代替出口测试 | 漏一处即静默放行；测试断言 + 正向清单更可靠 |
| DOM 属性不算出口 | H3 m00870 明确"客户端可取得"即出口 |

## 后果

- 改文案需走版本 + 快照 + manifest，略增流程成本；但线上文案可回指、可审计、可法务取证。
- `services/api` 构建新增 `check:copy`；Docker 构建若失败先检查是否漏升版本/漏快照。
- 域插件文案收口到外壳 copy 模块，`services/market` 需改为 import（A3 处理）。

## 待办（owner）

- A3：`services/market/src/errors.ts` 的 403 detail 去掉「（F1）」并改为引用 `services/api/src/copy.ts` 的文案；
  全量扫 `services/market` 用户可见出口（扫描清单第 4 项，OPEN）。
- A7：前端 copy 快照改为 hash 文件名并同步校验脚本；生产构建剥离/改写 DOM 内部码；manifest 前端文件名回填实际值。
- A12：E2E 统一出口扫描。
- A0：后端 copy/hash/snapshot/扫描清单/manifest 骨架（已完成初版）。
