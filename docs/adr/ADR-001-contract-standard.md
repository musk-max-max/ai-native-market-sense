# ADR-001 契约标准：OpenAPI 3.1 单一真源

- **状态**：Accepted（依据 agents/decisions.md 决策 #1，人类 2026-11-03 拍板）；**H2 签字**：PENDING（门禁=契约规范 H2，随 PR 书面签字）
- **起草**：A0 arch-contract（2026-11-04）；**批准人**：H2；**影响面**：A1/A2/A3/A4/A7/A8/A11/A12/A13
- **关联**：决策 #1（契约单一真源）、#2（单仓 + ownership）、#4（canonical 模型 / instrument_id）、#5（三入口一判定点）、#8（P0 范围）、C2（不做盘中实时）、F1（tushare 授权未定）

## 背景

平台有 C 端 H5、agent 调用、员工手动配置三类入口（决策 #5），且 6 个工作面、20 个 agent 并行开发。
如果没有一份机器可校验、可生成客户端、可做破坏性变更检测的契约真源，接口语义、错误码、授权与时效字段会在各端各自定义，最终无法审计（H3/H6 要求）也无法并行。

决策 #1 已拍板：以 OpenAPI 3.1 为单一真源。本 ADR 把这条决策落成可执行的工程规范，覆盖文件布局、命名、响应包络、版本兼容、变更流程与质量门禁；后续所有 P0/P1 契约必须遵守。

## 决策

### D1 规范与书写格式
- 规范：**OpenAPI 3.1.0**（支持 JSON Schema 2020-12：`type: [number, "null"]`、`const`、`pattern` 等，不使用 3.0 的 `nullable` 伪字段）。
- 文件：UTF-8、LF、2 空格缩进；`$ref` 一律相对路径（禁止绝对 URL / 本地文件路径）；组件名 PascalCase，operationId camelCase。
- 每个文件自带 `info.version`（SemVer）：拍板期 `0.x.y`；P0 上线冻结为 `1.0.0`；之后仅做 additive 变更时 bump minor/patch。

### D2 文件布局（按域一文件）
```
contracts/
  shared/openapi.yaml        # 公共 schema / parameters / responses 唯一真源（A0）
  market/openapi.yaml        # instrument / quote / bars + limit-ladder / page-summary（B1 确定性读模型）
  fundamental/openapi.yaml   # fundamental-summary
  watchlist/openapi.yaml     # 自选增删查 + review（B1 自选组合区间统计）
```
- 规则：**每个域一个 `contracts/<domain>/openapi.yaml`**，与 `services/<domain>/` 对应，便于 oasdiff 按域 diff、按域归属与门禁。
- 跨域复用只允许引用 `shared/`；`shared/` 不得引用任何域（依赖方向单向）。
- 域契约之间不得互相 `$ref`（例如 fundamentals 不引用 market 的 schema）；跨域组合由 BFF / 前端完成。
- 新增域（P1：content/compliance/crm/identity）按同一结构扩展，域名与 `ownership.yaml` 的 services 路径对齐。

### D3 命名与语义约定
- 路径：`/v1/<resource>`，多词用 kebab-case（如 `/fundamental-summary`），资源用单数；动作通过 HTTP 方法表达，禁止 `/getXxx` 式路径。
- 字段名：**snake_case**（与 canonical 内部模型、Python 数据侧一致），禁止 camelCase 字段混用。
- 枚举值：小写下划线（`none/qfq/hfq`、`limit_up`），禁止中文或数字开头。
- `instrument_id`：**EXCH:CODE**（`^(SSE|SZSE|BSE):[0-9]{6}$`）；禁止「代码 + 点号 + 交易所后缀」的点号格式出现在契约、代码、配置、测试夹具。
- 数值单位写进 description：金额=元、成交量=股、比率为百分数数值（`1.23` 表示 +1.23%）、EPS=元/股。
- 日期：`format: date` 表示交易日/报告期；时间：`format: date-time` 且必须带 `+08:00`（A 股统一时区）。
- 空值：数据缺失/停牌/不适用用 `null`（schema 显式 `type: [..., "null"]`），**禁止用 0 冒充**；可选字段缺省表示未提供，两者语义不同（见各 schema description）。
- 列表：`limit` + `has_more`；P0 不做 cursor 分页（数据量小），后续加 cursor 必须 optional 兼容。

### D4 统一响应包络
成功响应固定为 `{ data, meta }`，`meta` 必须能回答「数据从哪来、什么时候、有没有授权、口径是什么、免责是什么」：

| 字段 | 强制程度 | 说明 |
|---|---|---|
| `meta.source`（`SourceRef`） | 全部成功响应必填 | `source` / `as_of` / `staleness_ms`；`source` 是**平台来源词表的封闭枚举**（见 ADR-004），禁止厂商标识；`as_of` 是市场时点，不是抓取时间；`source_id` 仅内部审计、不参与展示 |
| `meta.entitlement`（`Entitlement`） | 全部成功响应必填 | F1 未落地也不改结构，只切换 `tier` 取值 |
| `meta.adjustment`（`AdjType`） | **价格/序列类**响应必填 | `none` 为 H4 主口径；K 线响应必须回显实际生效口径 |
| `meta.disclaimer`（`DisclaimerMeta`） | 价格/财务类响应必填 | 合规文案；`closable` 恒 `false`（H6 不可配，A10 不得渲染关闭入口） |

- 财务数据不适用复权：`fundamental` 响应不携带 `adjustment`，原始/追溯调整两套口径由 `data.statement_basis`（`reported`/`restated`）表达（H4 D6）。这是唯一经批准的**面客**例外，扩展面客例外需 H2 签字。
- 内部接口例外（H2 会签 2026-11-06）：仅当**同时满足**下列两项时，成功响应可直接返回资源对象（如 `OpsConfigDocument`/`Approval`/`Release`/`ValidationReport`），不套 `{data, meta}`：① 该域已在 A11 的 `INTERNAL_DOMAINS` 注册；② 该域**全部** operation 路径均以 `/v1/internal/` 开头。任一条件不成立即按面客信封规则处理，CI 红灯。理由：内部域只服务内部运营/审批，不面向 C 端或 agent，不涉及行情授权与 C 端免责元数据；若套 shared `ResponseMeta` 会注入无意义的 source/entitlement。例外只覆盖成功包络：错误仍统一 `application/problem+json` + shared `Problem`（含新两码）；内部 schema 仍闭合 `additionalProperties:false`；不得出现 shared `ResponseMeta`/`disclaimer`；`OpsConfigDocument.meta` 是内部 `SystemMeta`，不是 C 端 meta。任何面客/agent 契约不得套用。内部域生成客户端须放**独立入口**（`packages/api-client/src/internal/`），`web/h5` 与 agent 面代码不得 import 内部域类型（A13 构建期/CI 断言）。
- 错误响应统一 `application/problem+json`，结构 `Problem`（RFC 9457）：`type/title/status/code/detail/trace_id`；`code` 是契约测试（A11）唯一断言依据，P0 已定义 10 个错误码（见 `contracts/shared/openapi.yaml`；`NOT_FOUND` 于 2026-11-04 以 additive 方式加入；`CONFLICT`/`PRECONDITION_FAILED` 于 2026-11-06 为 config/approval 内部接口以 additive 方式加入，H2 2026-11-06 已书面追认，语义见下）。`409 CONFLICT` = 版本/审批状态冲突（approval 的状态冲突一律 409 + `CONFLICT`，body 以 `current_status` 区分）；`412 PRECONDITION_FAILED` = If-Match/前置条件不满足。approval 不得用 412 表达状态冲突，也不为对称补 412；两码不得用于 C 端契约。
- 授权降级路径：受授权约束的数据接口（quote/bars/fundamental-summary）在**无权展示**时必须返回 `403` + `code=ENTITLEMENT_RESTRICTED`；`403` 语义是「无权展示」，**不是**「无数据」（无数据用 404）。成功响应里的 `meta.entitlement.is_entitled=false` 仅用于前端预判与降级提示，**不得替代** 403。基础信息 `getInstrument` 不因授权缺失整体 403（个股页必须先能渲染证券标识），授权状态同样由 `meta.entitlement` 表达。watchlist 的越权（已认证但操作他人自选）返回 `403` + `code=FORBIDDEN`。
- 404 语义：证券标识不存在/未收录 → `INSTRUMENT_NOT_FOUND`；标识存在但请求的资源无数据（无行情快照、无财报）或路由不存在 → `NOT_FOUND`。**判定顺序（Lead m00443；A3 封版复核补受限档例外，H4 m02334 签）**：
  - **正常/已授权档**：先判存在性（未收录/不存在 → `INSTRUMENT_NOT_FOUND`）→ 再判授权（确认存在但无权展示 → `403 ENTITLEMENT_RESTRICTED`）→ 最后取数（存在且有权但该资源无数据 → `NOT_FOUND`）。正常档禁止用 403 掩盖 404；存在性属公开信息，藏它只增加客服与排障成本。
  - **受限/降级档（gate `resolution.blocked`：`expired`/`hold`/`control_*`/`config_mismatch`，P1 临时语义）**：`403` 短路、跳过 serving 读，对「已存在」与「未收录」返回**逐字节相同**的受限档 403 body，**不泄露标的存在性**。F1 翻 `c_end_display` 时**恢复 404 优先**（A11 已有「两档顺序」测试，防临时语义被永久化）。
  - **禁止绝对化表述**：正常档 404 优先；受限/降级档是明确例外。不得把任一档的判定顺序写成无条件规则，也不得用 403 掩盖正常档的 404。
- 鉴权：`securitySchemes.bearerAuth`（JWT）；C 端用户/员工用 OIDC token，agent 用 OAuth2 机器身份 token，服务端统一判定（决策 #5）；请求体/查询参数中的 `user_id` 一律不可信。

### D5 版本与兼容（/v1 冻结）
- `v1` 路径冻结，**不做 URL 版本协商之外的版本头协商**（三入口统一，降低实现复杂度）。
- 非破坏（允许，minor bump）：新增**optional** 字段；新增可选枚举外的扩展字段需在 schema 中显式声明。
- `Problem.code` 词表版本规则（H2 2026-11-06 裁定）：`code` 仍为 `string` 时，**新增错误码或修订 description = patch**（生成类型里的 `code: string` 未变）；把 `code` 改为 schema `enum`、删除码、改码义或合并码 = minor/breaking。词表变更不升 minor，以保留 minor 作为「生成物需要重新产出」的信号。
- 破坏（必须显式声明 + H2 书面签字）：删除字段；改字段类型/单位/含义；把 optional 改为 required；**枚举加值**（消费方 switch 会落空，决策 #1 明确视为破坏）；删除/重命名 operation；改错误码含义。
- 破坏性变更只能通过 `/v2` 提供，或经 H2 书面签字后在 `/v1` 内按发布门禁执行（默认不允许）。
- `additionalProperties: false` 用于响应对象以尽早暴露未申报字段；因此**新增响应字段必须走契约 PR（本身是 additive），并同步重新生成客户端**。部署顺序：API 先发（旧客户端忽略未知字段），客户端后发。请求体对象同样 `additionalProperties: false`，禁止塞未声明字段。

### D6 契约变更流程（每次 PR）
1. 修改 `contracts/**`（A0 或经 A0 评审的域 owner），PR 描述必须包含：**契约 diff（oasdiff 输出）+ 兼容性结论 + 迁移说明 + 影响面**。
2. CI 校验（A13 落地）：`redocly lint`（或等效 OpenAPI 校验）必须 0 error；`oasdiff breaking --severity-levels contracts/oasdiff-severity.txt` 对 `main` 必须为空；`$ref` 全部可解析；目录与 `ownership.yaml` 一致；`infra/ci/check-source-vocabulary.mjs` 必须通过（对外契约与生成产物无厂商标识、`SourceRef.source` 为显式平台词表，见 ADR-004）。
3. 破坏性变更：附决策记录与 **H2 书面签字**，并更新 A11 契约测试与（如涉及）A12 e2e 夹具。
4. 合并后由 A13 触发 `packages/api-client` 重新生成；生成物不得手改。
5. 发布守门按 README 门禁（发布 H5）；合规相关内容（免责、授权）须 H3/H6 过目。

### D7 生成客户端与「禁止手写 DTO」
- `packages/api-client` 由契约生成（推荐 `openapi-typescript` + 薄封装；最终工具由 A13 在 CI 固化），**禁止**在任何业务模块手写请求/响应类型、msw 假数据之外的 DTO。
- 生成产物入库或由 CI 发布，取决于 A13 的工程裁决；无论哪种，单一真源都是 `contracts/`，代码侧类型只能 import 生成结果。
- 契约测试（A11）与 e2e（A12）使用同一份契约与夹具；错误码、`meta` 四要素、`instrument_id` 格式为必测项。
- 内部域（`INTERNAL_DOMAINS` 且全路径 `/v1/internal/`）的生成类型必须放独立入口（`packages/api-client/src/internal/`），不得并入面客 `ApiPaths`；`web/h5` 与 agent 面代码不得 import 内部入口，A13 在构建期/CI 断言。防止「internal-only」只停留在文档承诺。

### D8 质量门禁
- 解析层：所有 YAML 必须能被 OpenAPI 3.1 解析器解析；本地与 CI 均用 oasdiff 1.35.0（版本锁定）+ `redocly lint`（A13 已接入 `infra/ci/contract-diff.mjs`，本地非 git 目录跳过破坏性 diff、CI 中执行）。
- 结构层：`shared` 无 domain 引用；domain 无相互引用；无未使用组件；示例中的 `instrument_id` 全部符合 EXCH:CODE。
- 语义层：A11 的 20 条 conformance（见 ADR-002）覆盖 `source/as_of/staleness_ms/adjtype/entitlement/disclaimer` 的强制出现与取值。
- 注释安全：代码/文档的**块注释内容禁止出现 `*/` 序列**（包括 `dwd_*/dim_*` 这类 glob 写法——`*/` 会提前闭合块注释，把后续内容当代码编译，报错行号还会指向别处）。用文字描述代替（如「dwd_ 与 dim_ 前缀表」）；A13 用 ESLint/格式检查兜底，评审时同样视为 blocking。

## 被否选项及原因

| 选项 | 否决原因 |
|---|---|
| 全部域合并为一个 `openapi.yaml` | diff 噪声大、按域 ownership 与门禁不可行、多人并行必然冲突；oasdiff 无法按域限定影响面 |
| OpenAPI 3.0.3 | 3.0 无原生 `null`（需 `nullable` 伪字段）、无 JSON Schema 2020-12；决策 #1 已定 3.1，降级会迫使 schema 写法回退 |
| 先 gRPC/Protobuf 再转 HTTP 对外 | 三入口（H5/agent/MCP）全部是 HTTP/JSON；多一层 IDL 转换，收益低于复杂度；canonical 由契约生成已足够 |
| 代码优先（从 Fastify/装饰器注解生成 OpenAPI） | 契约从实现漂移，无法在无代码时评审；A7/A11/A15 无法与 A3 并行；违反「契约先行」Sprint 0 顺序 |
| GraphQL BFF 作为契约真源 | agent tool calling/MCP 需要显式 operation 边界、权限点、错误码；GraphQL 使授权判定与审计点分散，难以满足「一个判定点」 |
| 每端点一个契约文件 | `$ref` 与公共组件碎片化，oasdiff 跨文件 diff 噪声大，评审成本高 |
| 手写共享 TS 类型/DTO 包 | 双源必然漂移，违反 A0 hard rule「任何模块不许手写 DTO」 |
| 用 version header 做兼容 | 三入口都要实现，收益低；`/v1` 冻结 + additive 变更更简单，也便于 agent 调用 |

## 可逆性评估

- **低—中可逆**。若改用其他 IDL（gRPC/GraphQL），H5 客户端、三入口网关、A11/A12 测试链路需重写，成本高。
- 3.1 → 3.0 可机械降级（`type: [x, "null"]` → `nullable: true`、`const` 改写），成本中等，但会丢失 JSON Schema 2020-12 语义。
- 单文件 ↔ 按域文件可互相迁移（合并/拆分脚本简单），但按域门禁收益是选择该布局的核心理由，回退需 H2 重新拍板。
- 回滚本 ADR 意味着 P0 契约重写、Sprint 0 顺延；建议在 Sprint 0 第 1 周内由 H2 确认，避免下游并行返工。

## 当前契约清单（2026-11-06）

| 文件 | 内容 | 状态 |
|---|---|---|
| `contracts/shared/openapi.yaml` | SourceRef、AdjType、Entitlement、InstrumentId、DisclaimerMeta、ResponseMeta、Problem；通用错误响应与 InstrumentIdPath | 已落盘 |
| `contracts/market/openapi.yaml` | `getInstrument`、`getInstrumentQuote`、`listInstrumentBars`、`getLimitLadder`、`getInstrumentPageSummary` | 已落盘 |
| `contracts/fundamental/openapi.yaml` | `getFundamentalSummary` | 已落盘 |
| `contracts/watchlist/openapi.yaml` | `getWatchlist`、`addWatchlistItem`、`removeWatchlistItem`、`getWatchlistReview` | 已落盘 |
| `contracts/ai/openapi.yaml` | `createAiAnalysis`、`getAiAnalysis`、`streamAiAnalysisEvents`、`createAiChat`；`AnalysisKind` 封闭 8 值；AI 结果信封 `AiAnalysisResponse` | 已落盘（**面客契约**，非 internal-only；SSE 两个 operation 的 data 为 `text/event-stream` 字符串帧；`202 AnalysisAccepted` 受理体无 `{data,meta}` 信封；A11 specimens 已补） |
| `contracts/ai/internal-generation-context.schema.json` | API→AI 内部生成上下文（request_id/audience/user_id/content_version/as_of 必填），H5 永不生成/覆盖 | 已落盘（非 OpenAPI） |
| `contracts/config/openapi.yaml` | `listOpsConfigs`、`getOpsConfig`、`putOpsConfigDraft`、`validateOpsConfig`、`submitOpsConfig`、`publishOpsConfig`、`rollbackOpsConfig`、`diffOpsConfig`、`listOpsReleases`、`getOpsRelease` | 已落盘（internal-only；If-Match 乐观锁、409 三点 diff、canary 1–10% 无全量） |
| `contracts/approval/openapi.yaml` | `createApproval`、`listApprovals`、`getApproval`、`evaluateApproval`、`decideApproval`、`listApprovalEvents` | 已落盘（internal-only；approval_ref 仅 A4 建单事务生成，只有人类可决定，决定不可复用） |
| `contracts/identity`、`content`、`compliance`、`crm` | P1 预留，未启动 | 未创建 |

当前版本（2026-11-06）：`shared` **0.2.3**；`market` **0.4.0**；`watchlist` **0.3.0**；`fundamental` 0.2.0；`ai` / `config` / `approval` 均 **0.1.0**（新域，additive）。已落地变更：① 三域补 `403`（market quote/bars、fundamental → `EntitlementRestricted`；watchlist → `Forbidden`），并为全部 operation 统一补 `default: ProblemResponse`（消解 KD-001..003）；② shared 0.2.0 将 `SourceRef.source` 收紧为 7 值平台词表并加内部 `source_id`（ADR-004，Lead m00556；生成客户端已同步，A11 契约测试同步）；③ shared 0.2.1 为 description-only 修订：403/404 判定顺序改为「存在性 → 授权 → 取数」（Lead m00443），并把「基础信息白名单口径」引用补进 `getInstrument` 描述；schema 无变化，oasdiff 判定无破坏性变更；④ `market` 0.3.0 删除 `Instrument.lot_size`（H2 书面签字；ADR-004 基础信息白名单），oasdiff 默认不识别「删除 optional response property」，新增 `contracts/oasdiff-severity.txt` 将其升为 `err`；按 H2 L45 裁定不自写 policy-breaking differ，统一用 oasdiff 自带 `--severity-levels`（避免两套判定互相冲突）；⑤ shared 0.2.2 为 description-only 修订：受限/降级档（`resolution.blocked`）403 短路、不读 serving、不泄露存在性，标注 P1 临时语义与 F1 后恢复 404 优先（H4 m02334 签；无 schema/ABI 变更，H2 知会，oasdiff 无破坏性变更）；⑥ `market` 0.4.0 / `watchlist` 0.3.0 为 KD-AIP0-B1 后端切片的 additive 新增：`GET /v1/market/limit-ladder`（B1-02 涨跌停梯队，规则 provisional 并显式 gaps）、`GET /v1/instruments/{instrument_id}/page-summary`（B1-03 五段骨架/缺口卡）、`GET /v1/watchlist/review`（B1-01 自选组合区间统计）；均只组合已授权数据、不调用 LLM、不含投资结论，oasdiff breaking 对旧版 exit 0；⑦ `ai` 0.1.0（H2 L126 会签 ADR-007 第 0 批，INF-01）：新域、**面客契约**（非 internal-only；仅 `internal-generation-context.schema.json` 属内部），`AnalysisKind` 为封闭枚举，新增值须契约测试 + 版本号；result 含 `sections[].claims[].evidence_ids`、`caveats`、`compliance`、`ai` 与 `meta` 四要素；SSE 用 `text/event-stream` 字符串帧，不引入未引用的帧 component；⑧ `config` 0.1.0 与 `approval` 0.1.0（KD-OPS-001 / KD-APPROVAL-001）：新域、internal-only，均不接收客户端预填的 `approval_ref`，审批决定只有人类主体（agent/A15 403）；config 用整数 `version` + `If-Match "v<n>"` 乐观锁，publish 必须带可解析 approval_ref 且 canary 仅百分比 1–10，不存在全量参数；approval 建单必须带 `Idempotency-Key`，决定不可复用、事件 append-only。新域无 v1 基线，当前以 redocly lint + YAML/$ref 解析为门禁，破坏性变更进 v1 baseline 后按 D5/D6 走 H2；⑨ shared 0.2.3（description-only）：Problem.code 清单补 `CONFLICT`（409 版本/审批冲突）与 `PRECONDITION_FAILED`（412 If-Match 不满足），H2 2026-11-06 书面追认；两码仅内部接口使用、不用于 C 端，approval 禁止用 412 表达状态冲突；D5 同步补 `Problem.code` 词表 patch 规则。config/approval 的 409 扩展体改为直接定义 Problem 同名字段（字段级 `$ref` 到 shared Problem.properties）+ `diff`/`approval_ref`/`current_status`，不再 `allOf` 扩展被 `additionalProperties:false` 拒绝的基类。⑩ 内部域包络例外规则化（H2 2026-11-06 会签）：`INTERNAL_DOMAINS` + 全路径 `/v1/internal/` 双条件；客户端生成类型放独立入口，C 端/agent 不得 import；仅成功包络例外，错误仍 problem+json。⑪ config/approval 内部契约 additive 细化（H2 2026-11-06 追认）：`listApprovals` 新增可选 query `environment`（dev/staging/prod，按 `subject.environment` 过滤；A11 契约脚手架据此合法调用）；`EnvironmentQuery` 明确「query 为路由键，PUT/validate/submit body 的 environment 必须一致，不一致 400 VALIDATION_ERROR，以 query 为准」。两者均 additive，不改变现有请求形状，不引入新错误码。

工具链现状（2026-11-04）：oasdiff 1.35.0 已本机安装（`brew install oasdiff`，A13 在 CI 固化同版本）；契约 lint 用 `npx @redocly/cli lint contracts/*/openapi.yaml`（valid，0 error；shared 单文件 lint 的 unused-components warning 为跨文件引用误报）；生成客户端已固化为 openapi-typescript 7.13.0 + openapi-fetch 0.17（见 `packages/api-client/README.md`）。剩余待定：A13 把 lint/oasdiff/生成校验接入 `.github/workflows/`。
