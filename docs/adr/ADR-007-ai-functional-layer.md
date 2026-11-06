# ADR-007：AI 功能层架构与 P0 交付拆解

- **状态**：Proposed（A0 起草，2026-11-05；H2 架构签字 PENDING，H3/H4/H5 会签 PENDING）
- **起草**：A0 arch-contract
- **关联**：`market-sense/docs/research/ai-native-product-requirements.md` §1/§3–§8/§10；ADR-001（契约标准）、ADR-002（数据源端口）、ADR-004（来源词表/合规）、ADR-006（用户可见文案）；`agents/decisions.md` L41/L44/L74/L78/L79；`docs/release/S0-STATUS.md`（F1 未落地，tier 暂为 `internal_eval`）
- **影响面**：A0（契约/架构）、A1（ingest）、A2（数仓/DWS）、A3（后端；拟兼任 AI 服务）、A7（H5）、A11（契约测试）、A12（E2E）、A13（部署/CI）、A16/H3（合规）、H2/H4/H5（签字）
- **可逆性**：中高。服务边界可通过插件搬迁回退；`/v1/ai/*` 为 additive 新契约；不引入 P0 数据库迁移/队列，回退成本主要是 prompt/策略版本与已发布文案的历史保留。

## 背景

### B1 任务与边界

本文只回答「AI 功能层怎么落、P0 功能点按什么依赖顺序开工」，不写业务代码、不改契约/roster/ownership。
后续每个功能点按本文的任务编号直接派给 owner；任何与本文冲突的实现，先改 ADR 再开工。

### B2 现状证据（以仓库事实为准，不假设能力存在）

1. **AI 推理/LLM 网关服务不存在。** `services/api/src/domains.ts` 目前只注册 `marketPlugin`；
   `services/content/` 只有 `.gitkeep`；`services/market` 只提供 instrument/quote/bars/fundamental-summary/watchlist，
   没有任何 LLM、prompt、AI 生成或 AI 合规过滤代码。`docs/reference/event-payloads.json` 也没有 AI 事件类型。
2. **研究数据域 ingest 未接。** `services/ingest/src/market_ingest/cli.py` 当前只有
   `sync-bars`、`sync-instruments`、`sync-fundamentals`、`verify-manifest`；tushare adapter 实际调用的数据接口是
   `daily`、`adj_factor`、`calendar`、`suspensions`、`stock_basic`、`fina_indicator`、`income`
   （`services/ingest/src/market_ingest/adapters/tushare/adapter.py:65-67`）。
   **没有 `daily_basic`、`top_list`/`top_inst`、`moneyflow`、`margin`、`hk_hold`、`fund_portfolio`、
   `stk_holdernumber`、`pledge_*`、`share_float`、`block_trade`、`repurchase`、`index_daily`。**
   任务书里「ingest 主要到日线/daily_basic」需要更正：**`daily_basic` 也还没有接**。
3. **数仓没有研究 mart。** `warehouse/serving/ports.yaml` 只有 5 个 view：
   `serving_instrument`、`serving_quote_latest`、`serving_bar_daily`、`serving_factor_latest`、
   `serving_fundamental_summary`；DWS 没有龙虎榜/两融/北向/资金流/估值/行业分位聚合。DWD 只有
   bars/adjust/suspended/dim_instrument/fundamental_report。
4. **契约只有 4 域。** `contracts/{shared,market,fundamental,watchlist}/openapi.yaml`，没有 AI 域契约；
   `/v1` 现有能力不足以支撑对话/生成式解读。
5. **前端只有 4 个页面。** `web/h5/src/lib/router.tsx` 只有 `/`、`/stocks/:id`、`/stock/:id`、`/watchlist`；
   没有 AI 对话、解读、复盘、筛选页面。
6. **C 端目前不可见。** `docs/release/S0-STATUS.md`：F1 授权未落地，`entitlement.tier=internal_eval`，
   行情/财务路径 403，C 端页面为空。AI 功能属于 C 端商用展示，**同样受 F1/entitlement 约束**；在授权翻转前
   只能在内部评测态构建、验收，不能以「先上线后补授权」绕过。

### B3 由此得到的架构结论

P0 的 9 个 AI 功能点**没有一个能在今天的仓库上端到端交付**。瓶颈不是一个，而是三条并行：
**AI 网关层缺失、研究数据 ingest/数仓缺失、AI 契约与页面壳缺失。**
因此本文不按「功能听起来简单/复杂」分批，而按**首个阻塞依赖**分批，并把并行基础设施单独列出，
避免出现「功能在等数据、数据在等契约、前端在等 mock」的串行空转。

## 决策

### D1 AI 网关层：新建独立服务 `services/ai/`，不并入 API/market/content

采用以下拓扑（P0）：

```text
H5 / 未来 console
      │  HTTPS + Bearer（OIDC/agent OAuth2）
      ▼
services/api（公共 BFF：auth / entitlement / rate-limit / no-store / copy 注入）
      │  内部 HTTP（mTLS 或集群内网 + service token）
      ▼
services/ai（AI 网关：provider 适配 / prompt 编排 / tool 调用 / 证据装配 / 后处理 / 审计）
      │  只读工具调用
      ├── services/market 读 API（quote/bars/instrument/fundamental-summary）
      ├── 研究读 API（DWS/serving，P0 后续由 A2/A3 提供）
      └── LLM provider（经 provider adapter；密钥只在 services/ai）
```

**边界与职责**

| 组件 | 负责 | 不负责 |
|---|---|---|
| `services/api` 的 `ai` 域插件 | 公共 `/v1/ai/*` 路由、鉴权/entitlement/限流/no-store、调用 `services/ai`、从 `copy.ts` 注入 AI 标识/免责声明、最终响应 schema | 不直接调 LLM、不拼 prompt、不跑合规过滤、不持有 provider 密钥 |
| `services/ai` | provider 抽象（超时/重试/熔断/成本预算）、prompt 注册表与版本、tool 调用与证据收集、后处理流水线、审计事件、缓存 | 不拥有行情/财务/研究数据的真源；不直接面客；不写业务库 |
| `services/market` / 研究读服务 | 只读确定性数据；继续执行既有 entitlement/403/as_of 语义 | 不感知 LLM、不生成自然语言 |
| H5 | 展示、SSE 消费、固定标识渲染 | 不直连 provider、不自行改写/关闭 AI 标识 |

**为什么是新服务，而不是并入现有服务**

1. **凭据与故障隔离**：LLM provider 密钥、超时/重试/熔断、token 成本只应存在于一个服务。并入 `services/api`
   会让模型供应商抖动直接拖垮行情 BFF；并入 `services/market` 会把确定性读路径与概率性生成路径混在同一 p99 里。
2. **生命周期不同**：行情请求是毫秒级确定性读；AI 分析是秒级到几十秒、可流式、可取消、可重试的长请求。
   同进程会迫使 API 放大连接/内存/超时配置，且难以独立扩缩容。
3. **合规与审计边界**：prompt、模型输出、证据链、policy_version 需要独立留存与采样复核；独立服务才能把
   「哪些数据进了模型、模型说了什么、后处理改了什么」按同一条 trace 审计，不污染行情访问日志。
4. **契约演进**：AI 输出 schema 会快速迭代（D2/D3），独立服务/独立契约可用 additive 方式演进，
   不必每次改 market 契约或重启行情域。
5. **不选 `services/content`**：content 是业务内容域（且当前为空），AI 网关是**跨域平台能力**；
   把平台能力塞进内容域会让后续所有域都依赖 content 的发布节奏，也会让 content 的 owner 同时承担模型成本/安全。

**归属与落地前置**

- 建议目录：`services/ai/`；公共契约：`contracts/ai/openapi.yaml`（A0）；生成客户端复用 `packages/api-client`。
- P0 owner（H2 L126 裁定）：**A3（现有后端，兼任 AI 平台）**，不扩编 A24。无论谁写，
  **契约归 A0，合规策略归 H3，数据口径归 H4**。INF-01/INF-02 由 A0 在验收期临时持有写权，
  验收后 `services/ai/` 写域移交 A3。
- 需要 H2 批准的两件事：① 新增 LLM provider 这一外部依赖；② roster/ownership 增加 `services/ai/`
  写域（A3 或 A24，reviewers 至少 H2 + H3）。在批准前，A0 只写契约与 ADR，不写 `services/ai/` 代码。
- 回退方案：若 H2 不批独立服务，P0 允许把 `services/ai` 作为 `services/api` 的内部插件挂载，
  但必须保留同一套模块边界与后处理接口；该回退记录为技术债，P1 再拆进程。

### D2 公共 AI 契约：一个通用「分析任务」入口，避免每个功能点一套端点

新增 `contracts/ai/openapi.yaml`（additive；不改既有四域），P0 只定义两类入口：

| 方法/路径 | 用途 | 说明 |
|---|---|---|
| `POST /v1/ai/analyses` | 创建一次结构化分析（解读/复盘/筛选/简报/异动/资金特征） | 请求含 `kind`、`subject`、`options`、`idempotency_key`；短任务可直接 200 返回结果，长任务 202 + `analysis_id` |
| `GET /v1/ai/analyses/{analysis_id}` | 查询结果/状态 | 支持轮询；结果含 `sections`、`citations`、`compliance`、`ai`、`meta` |
| `GET /v1/ai/analyses/{analysis_id}/events` | SSE 进度/增量文本 | 仅传输已通过后处理的片段；断开可重连 |
| `POST /v1/ai/chat` | 全局 AI 对话（P0-AI-01） | SSE；服务端维护有限轮上下文，工具调用走同一 tool registry |

`kind` 为封闭枚举（新增值视为契约变更，走 D6）：
`stock_interpretation`、`watchlist_review`、`post_market_review`、`lhb_review`、`capital_features`、
`factor_screen`、`research_brief`、`anomaly_alert`。

所有成功响应遵循既有信封与四要素（ADR-001 D4）：`data` + `meta.source`/`meta.as_of`/`meta.entitlement`/
`meta.disclaimer`；`meta.adjustment` 仅价格序列类结果需要。AI 结果额外带：

```text
AnalysisResult {
  analysis_id, kind, subject, as_of,
  sections: [{
    id, title,
    claims: [{ text, evidence_ids: [] }],       # 每一条结论必须绑定证据
    data_refs: [{ module, as_of, period? }]      # 可下钻的数据模块，不含内部码
  }],
  caveats: [string],                             # 不确定性/数据缺口说明
  compliance: { policy_version, decision: "passed" | "blocked", reason_codes: [] },
  ai: {
    generated: true,
    label_version: string,                       # 标签版本；具体文本由 API 层 copy.ts 注入
    content_version: string,                     # P7 文案/免责版本；由 API 内部上下文传入
    model_family: string,                        # 只到家族/档位，不出现供应商名
    prompt_version: string,
    policy_version: string
  },
  meta: { source, as_of, entitlement, disclaimer }
}
```

约束：

- **不新增手写 DTO**：H5 通过 `packages/api-client` 的生成类型消费；服务间用同一契约的生成类型或 JSON Schema。
- 契约内**不出现供应商名/模型名/内部 tier**；`source` 继续使用 ADR-004 的 `platform_*` 词表。
- 所有 `/v1/ai/*` 响应沿用 `Cache-Control: no-store`（与 ADR-006 D4 出口规则一致）；AI 结果禁止跨 entitlement 缓存。
- 破坏性变更（删 `kind`、改字段语义、删除 `evidence_ids` 等）按 ADR-001 D5/D6 走 H2 签字；
  additive（新增 `kind`/新增 optional 字段）也须 A11 契约测试与版本号。
- **内部审计上下文不进公共契约**：`content_version`/`label_version`/`model_id`/审计 `as_of`
  由 `services/api` 在服务端构造成 `InternalAiGenerationContext`
  （`contracts/ai/internal-generation-context.schema.json`）随内部调用传给 `services/ai`；H5 永不生成或覆盖这些值。
  公共 `AnalysisSubject.as_of` 是客户端期望的数据截止时点，不能替代审计的业务时点 `as_of`。
  `content_version` 缺失、或 chat 无数据上下文时，`services/ai`/API 必须在调用模型前拒绝（fail-closed），
  不产生半条审计。

### D3 统一后处理组件：一处实现，所有功能点复用

**位置**：`services/ai/src/postprocess/`，一个 `runPostprocess(draft, ctx)` 纯函数式管线；功能点只提供
prompt、输出 JSON Schema、确定性 fallback，**禁止各自实现过滤/文案**。`services/api` 的 `ai` 插件只做
最后一步 copy 注入与 schema 校验，不重复法律判断。

| 阶段 | 动作 | 失败行为 |
|---|---|---|
| P0 授权解析 | 服务端从 token/Config Service 解析 `tier`；不信任客户端传入 | 未认证 401；tier 不可用 403 |
| P1 工具取数 | 只调用 allowlist 只读工具；每个工具声明所需 tier 与 as_of 语义；403 数据不进入 prompt | 该证据标记缺失；全部受限 → 403 |
| P2 结构校验 | 按 feature 的 JSON Schema 校验模型输出；拒绝自由文本裸返回 | 重试一次；仍失败 → 降级为数据卡 |
| P3 证据绑定 | 每个 `claim` 必须引用至少一个 `evidence_id`；无来源断言删除/改写；数字必须能在证据中找到 | 删除该 claim；核心段为空 → 降级 |
| P4 数值一致性 | 复算比率/同比/涨跌幅与证据一致；禁止模型自算新数字 | 修正为证据值；无法修正 → 删除 |
| P5 合规过滤 | 词法 + 语义双检：买入/卖出/加仓/减仓/目标价/建议建仓/择时/必涨等；`as_of` 复述；预判附不确定性；缺口显式 | 命中即改写中性表述；不可改写 → 阻断并记事件 |
| P6 结论定性 | 只允许「数据显示/历史统计上/存在…特征」；禁止将来时指令与保证性措辞 | 改写或阻断 |
| P7 标识/免责 | `services/api` 从 `copy.ts` 注入 `AI_COPY`（H3 m02666 定稿：label「AI 生成 · 仅供参考」、disclaimer「本内容由 AI 生成，基于页面标注时点的市场数据整理，仅供参考，不构成投资建议，也不构成任何买卖依据。」）；AI 服务不持有该文案 | 缺 copy 版本 → 500，不降级返回 |
| P8 审计 | 写 `analysis_id`、输入证据摘要、prompt_version、policy_version、模型输出 hash、过滤命中、最终结果 hash | 审计失败 → 请求失败（fail-closed） |

**降级策略**：P2–P5 任一失败时，非对话类功能返回**确定性数据卡**（只有表格/事实数字，无 LLM 文案，
仍带 AI 标识与 policy_version）；对话类返回明确的「当前无法生成，请查看数据」状态，不返回未过滤文本。
任何情况下不得把模型原始输出直接透传。

**H3/A16 覆盖方式**

- H3 签 `policy_version` 与 `copy.ts` 中的 AI 标识/免责声明；策略文件/词表变更必须升版本。
- A16 在每个发布版本前做**离线样本复核**（按 kind 分层抽样：正常、边界、受限、缺口），并在运行时按日抽样；
  发现违规即阻断该 `policy_version` 并回滚。
- 高风险模板（首次上新 kind、涉及预判/资金特征的新 prompt）在 H3 预审前不得开 C 端开关；
  普通模板走「策略版本签字 + 抽样」而不是每条人工预审，避免把 H3 变成吞吐瓶颈。
- A20–A23 研究 agent 的产物如果进入 AI 网关作为证据，仍按既有规则走 A16 初筛 + H3 终审；
  它们不是 C 端内容的最终出口。

**H3 m02666 AI 标识/免责签字条件**

- 文案定稿：label「AI 生成 · 仅供参考」、disclaimer「本内容由 AI 生成，基于页面标注时点的市场数据整理，仅供参考，不构成投资建议，也不构成任何买卖依据。」；`AI_COPY` 由 `services/api/src/copy.ts` 唯一持有。
- 条件 1（隐式标识/留痕）：AI 响应必须有 `meta.ai.generated=true` + `content_version`/模型标识；服务端生成/展示留痕（模型、版本、时间、输入口径版本）≥3 年。本 ADR 的 D2 结果 schema 已规划 `ai.*` 字段，但 P7 路由尚未实现，**上线前必须验收**。
- 条件 2（时点真实）：页面无 `as_of` 时，badge/disclaimer 与数值同时不得渲染；A7 前端 + A11/A12 测试。
- 条件 3（不可关闭/复制导出携带）：badge/disclaimer 不可关闭/折叠，复制/导出文本必须带 label+disclaimer；前端不得硬编码 fallback。
- 条件 4（措辞边界）：将「不构成投资建议」这类法律定性写进常驻标签的「免责即定性」表述不得进入将来任何正文；`非投资建议` 不豁免〔2012〕40 号文。本次已从 `AI_COPY` 与对外文案移除，ADR 不再引用旧标签字面。
- 四项条件在 P7/C 端 AI 上线前逐项验收；未满足时不得把 AI 输出标为已合规或开放 C 端。
- **H3 m02810 签字分工**：文案侧已通过（backend `2026.11.5.ac875c9d9237.backend.json`，凭证 m02810）；机制条件 1–3 是「AI 生成内容上线」门禁，不是文案签字对象。条件 1 未满足期间，AI 路由可开发/可 mock，但**不得对任何用户展示模型生成的可见内容**。

### D4 与分级/entitlement/403 的协同

1. `tier` 在 `services/api` 解析，随内部请求传到 `services/ai`；AI 服务不自行猜测。
2. 工具注册表为每个数据集声明 `required_tier` 与 `display_safe`；`internal_eval` 数据不得进入 C 端 prompt，
   也不得在 C 端响应中出现原始值/可推断摘要。
3. 若分析所需数据对当前 tier 全部受限：**在调用 LLM 前**返回 403（`ENTITLEMENT_RESTRICTED`），
   不消耗 token、不产生模型调用；403 语义沿用 shared 0.2.2（受限档 403 短路，不泄露存在性）。
4. 部分受限：从证据集中删除受限项，`caveats` 标「该维度数据当前不可得」，绝不标注供应商名。
5. 响应 `meta.entitlement` 与 `meta.source` 沿用既有契约；`source` 只用平台词表，LLM 供应商名不出现在任何
   用户可见字段/日志可下发字段。
6. **F1 未落地期间**：AI 功能默认 `internal_eval`，C 端 403/不渲染；不得用 mock 数据伪装面客。F1 授权 +
   H4 签字 + tier 翻 `c_end_display` 后才开 C 端开关（与 ADR-004 的 kill-switch 一致）。
7. 缓存键必须含 `tier`、`policy_version`、`prompt_version`、证据集 hash；跨 tier 不共享缓存；
   AI 结果不落公共 CDN。

### D5 研究数据依赖与 P0 批次

> 说明：批次按**首个阻塞依赖**划分，不按功能「看起来简单」划分。第一批不是「AI 功能上线」，
> 而是现有能力上可独立验收的确定性切片；AI 文案统一在第三批接入网关后完成。

#### 第 0 批（并行基础设施，不是功能点；立即开工）

| ID | 任务 | owner | 前置 | 规模 |
|---|---|---|---|---|
| INF-01 | `contracts/ai/openapi.yaml`：D2 的 analyses/chat/schema + A11 契约测试脚手架 | A0 | 本文签字；H2 契约会签 | S（2–3d） |
| INF-02 | `services/ai` 骨架：Fastify、provider 接口 + FakeProvider、tool registry 接口、postprocess 空管线、health | A3 | INF-01；H2 批 roster/依赖 | M（5–8d） |
| INF-03 | provider adapter（OpenAI-compatible/内部网关）+ 超时/重试/熔断/密钥读取 | A3/A24 | H2 批外部依赖；A9 review | M（3–5d） |
| INF-04 | postprocess P0–P8 + policy_version + 审计事件 schema | A3/A24 + A16/H3 | INF-02；H3 签策略 | L（8–10d） |
| INF-05 | 研究数据 ingest：`daily_basic`、`top_list`、`top_inst`、`moneyflow`、`margin`、`hk_hold`、`index_daily`、`stk_limit` 等（见第 2 批拆分） | A1 | H4 确认接口/积分；F1 不阻塞 ingest | L（按数据集拆，合计 15–20d） |
| INF-06 | 研究 DWD/DWS mart + 只读 serving 端口（LHB 席位、资金流、两融、北向、估值、行业分位） | A2 | INF-05 | L（15–20d） |
| INF-07 | H5 AI 页面壳/路由/错误态/标识组件（mock client） | A7 | INF-01；A0 契约冻结 | M（4–6d） |

并行建议：INF-01/02/03/04 与 INF-05/06 两条线同时启动；INF-07 在 INF-01 冻结后启动。

> 落地状态（2026-11-06）：INF-01 `contracts/ai/openapi.yaml` 已落盘（4 operations，kind 封闭 8 值，additive，redocly valid；
> 内部审计上下文字段见 `contracts/ai/internal-generation-context.schema.json`，不进公共请求/响应）；
> INF-02 `services/ai/` 骨架已落盘（Fastify、`AiProvider`/FakeProvider、tool registry、postprocess 空管线、`/healthz`）。
> A11 契约脚手架已落地（ai 域 DOMAINS/baseline/specimens，commit `6d28560`）：`pytest tests/contract` 67 passed；
> `services/ai` typecheck 通过、测试 16 passed。A3 在验收后接管 `services/ai/` 写域。
这是 P0 的关键路径，**先做功能页面等数据会空转**。

#### 第 1 批（现有能力可开工，不依赖 AI 网关/新数据域）

| ID | 功能切片 | 所需数据接口（现有） | owner 候选 | 前置依赖 | 规模 |
|---|---|---|---|---|---|
| B1-01 | **P0-06 持仓复盘·自选组合绝对表现版**（区间涨跌/波动/最大回撤/等权组合对比；固定模板，不含 LLM） | 新增 `GET /v1/watchlist/review`（watchlist 0.3.0，内部只读 `GET /v1/watchlist` + bars + quote） | A3（计算/API）、A7（页面）、A11/A12（测试） | watchlist + bars 已可用；**相对基准/板块对比待第 2 批**；不称「真实持仓」，P0 无持仓账本 | M（6–8d） |
| B1-02 | **P0-08 盘后复盘·涨跌停梯队切片**（涨停/跌停/连板梯队；按 board 规则从 bars 推导，ST 先排除并标注） | 新增 `GET /v1/market/limit-ladder`（market 0.4.0，内部只读 market-wide bars + instrument.board/name） | A2（DWS 派生）、A3（API）、A7（页面） | H4 确认涨跌停/ST 口径；精确 `stk_limit` 待第 2 批；不含 LHB/两融/北向/大宗 | M（6–8d） |
| B1-03 | **P0-02 个股页「AI 解读」五段骨架 + 数据缺口卡**（只做 UI/证据位/缺口显式，不接 AI 文案；行情+财务摘要两段可先填） | 新增 `GET /v1/instruments/{instrument_id}/page-summary`（market 0.4.0，内部只读 instrument/quote/bars/fundamental-summary） | A7（页面/组件）、A3（汇总 API） | 只覆盖已接入标的；基本面当前仅 3–5 标的，不能伪装全市场；H4 白名单 | S–M（4–6d） |

**对任务书预判的验证结论（必须纠正）**

- **龙虎榜复盘（P0-07）不在第 1 批。** 现在没有任何 `top_list`/`top_inst` ingest，也没有 serving view；
  仅凭日线无法复盘席位类型/上榜原因。它排在第 2 批，首个阻塞是 A1 的 LHB ingest。
- **盘后复盘（P0-08）只有「涨跌停梯队」切片可在第 1 批做。** 完整的盘后复盘依赖
  龙虎榜、两融、北向、大宗交易、股东户数——这些都不存在，不能把「盘后」整体算作现有能力。
- **个股 AI 深度解读（P0-02）只有 UI/缺口卡与已接入两段属于第 1 批**；估值分位、资金、质押/解禁等
  五段的大部分数据在第 2 批，AI 文案在第 3 批。
- 因此第 1 批可立即开工的是 **B1-01、B1-02、B1-03 三个切片**，且都不以「AI 功能完成」验收，
  只以「确定性结果 + 契约/页面骨架 + 缺口显式」验收。

#### 第 2 批（依赖研究数据域 ingest 先接；先数据/规则、后 AI 文案）

按数据依赖排序（先接的解锁更多功能点）：

| 序 | 数据集/任务（A1 → A2） | 解锁的 P0 功能点 | owner | 规模 |
|---|---|---|---|---|
| 2-1 | `daily_basic` + 财务四表/`fina_indicator` 全量（含估值、换手、量比、市值、ROE/毛利率等） | P0-03 多因子筛选、P0-04 研究简报、P0-02 估值/成长段 | A1 ingest + A2 DWD/DWS + A3 API | A1 5–7d；A2 3–4d |
| 2-2 | `top_list` + `top_inst`（席位、上榜原因、买卖额） | P0-07 龙虎榜复盘、P0-08 盘后复盘、P0-09 游资特征 | A1 3–4d；A2 LHB mart 3–4d；A3 API 2–3d | L |
| 2-3 | `moneyflow`（大中小单/主力资金） | P0-05 持仓异动（降级）、P0-02 资金段、P0-08 资金段 | A1 2–3d；A2 2–3d | M |
| 2-4 | `margin` + `hk_hold`（两融、北向） | P0-09 杠杆/北向、P0-08 盘后 | A1 2–3d each；A2 2d each | M |
| 2-5 | `index_daily` + 行业分类/板块资金流（tushare 行业较粗，概念标签缺口需 H4 确认） | P0-06 相对表现、P0-02 行业分位、P0-03 行业对比 | A1 3–4d；A2 3–4d | M |
| 2-6 | `stk_holdernumber`、`top10_holders`、`pledge_*`、`share_float`、`block_trade`、`repurchase` | P0-02 风险段、P0-08 大宗/筹码 | A1 4–5d；A2 3–4d | M–L |
| 2-7 | `stk_limit`（精确涨跌停价，替代 B1-02 的规则推导） | B1-02 精确化、P0-08 | A1 1d；A2 1d | S |

第 2 批的功能点/规则层交付（仍不含 AI 生成）：

| ID | 功能点/规则层 | owner 候选 | 前置 | 规模 |
|---|---|---|---|---|
| B2-01 | P0-03 多因子筛选引擎（条件 DSL → 候选池 + 特征表；只呈现特征不荐股） | A3 + A2 | 2-1 | L（8–10d） |
| B2-02 | P0-04 个股研究简报数据包（复用 P0-02 数据卡，轻量版） | A3 | 2-1/2-6 | M（5–7d） |
| B2-03 | P0-07 龙虎榜复盘数据/规则层（上榜原因分布、席位类型、净买额、连续上榜） | A2 + A3 | 2-2 | L（8–10d） |
| B2-04 | P0-08 盘后复盘数据/规则层（LHB + 两融 + 北向 + 大宗 + 涨跌停梯队） | A2 + A3 | 2-2/2-4/2-7 | L（10–12d） |
| B2-05 | P0-09 游资/北向/杠杆特征统计层（席位 N 日表现分布、北向增减持、两融变化；历史统计口径） | A2 + A3 | 2-2/2-4 | L（10–12d） |
| B2-06 | P0-05 持仓异动规则引擎（量比/换手/涨跌停/资金突变；watchlist 作为 P0 持仓代理） | A3 | 2-1/2-3 | M（5–7d） |
| B2-07 | P0-02 个股深度解读数据卡（估值/成长/盈利质量/资金/风险五段，缺口显式） | A2 + A3 | 2-1/2-3/2-5/2-6 | L（10–12d） |

#### 第 3 批（依赖 AI 网关；生成式解读/对话）

| ID | 功能点 | 依赖 | owner 候选 | 规模 |
|---|---|---|---|---|
| B3-01 | **P0-01 AI 对话入口**（工具调用、意图识别、SSE、受限数据 403、多轮上下文） | INF-01/02/04 完成；第 2 批工具可用；H3 签 policy | A3/A24（网关）+ A7（对话 UI）+ A0（契约） | L（10–15d） |
| B3-02 | **P0-02 个股 AI 深度解读**生成层（五段叙述 + 证据/缺口） | B2-07 + INF-04；第 1 批页面壳 | 网关 + A3/A7 | M（4–6d） |
| B3-03 | **P0-03 多因子筛选**语言化解读（只解释特征/分位，不给建议） | B2-01 + INF-04 | 网关 + A3 | M（3–5d） |
| B3-04 | **P0-04 个股研究简报**生成层 | B2-02 + INF-04 | 网关 + A3 | M（3–5d） |
| B3-05 | **P0-05 持仓异动提醒** AI 归纳（规则命中后生成中性说明） | B2-06 + INF-04 | 网关 + A3/A7 | M（3–5d） |
| B3-06 | **P0-06 持仓复盘** AI 叙述（事实归纳，不承诺收益归因） | B1-01 + INF-04 | 网关 + A3/A7 | S–M（2–4d） |
| B3-07 | **P0-07 龙虎榜复盘** AI 叙述 | B2-03 + INF-04 | 网关 + A3/A7 | M（3–5d） |
| B3-08 | **P0-08 盘后复盘** AI 叙述 | B2-04 + INF-04 | 网关 + A3/A7 | M（3–5d） |
| B3-09 | **P0-09 资金特征** AI 叙述（历史统计表 + 不确定性声明，严禁转化为跟随建议） | B2-05 + INF-04 | 网关 + A3 | M（4–6d） |

**批次验收口径**

- 第 1 批：确定性 API + 页面可验收；不得标「AI 功能完成」；不得出现无来源数字。
- 第 2 批：数据可追溯（ODS→DWD→DWS→API）、口径经 H4 确认、契约测试通过；规则结果可复算。
- 第 3 批：每条 AI 结论有证据、有 `policy_version`、过 P5 过滤；H3/A16 抽样通过；C 端只在 entitlement
  允许时可见；任何未过 pipeline 的输出都算未交付。

### D6 规模/排期假设

- 规模单位：S ≤3 人日，M 4–8 人日，L 9–15 人日，XL >15 人日（单 agent；可并行时按 owner 拆）。
- 关键路径：INF-01 → INF-02/03/04（网关）与 INF-05/06（数据）并行；第 3 批只有在两条都完成后才开始。
- 粗略节奏：第 0 批（1 周）→ 第 1 批与第 2 批并行（2–3 周）→ 第 3 批（2–3 周）。实际以 F1/H4 签字与
  tushare 接口确认为准；F1 未落地不阻塞内部构建，但阻塞 C 端验收。

### D7 风险与待签字项

| 待签/风险 | owner | 具体内容 | 不签的后果 |
|---|---|---|---|
| **H4：tushare 接口与字段范围** | H4 | 逐项确认 `daily_basic`、`top_list`/`top_inst`、`moneyflow`、`margin`、`hk_hold`、`fina_indicator`、财务四表、`stk_limit`、`index_daily` 的权限/字段/更新时间；确认 `top_list`/`top_inst` 是否可区分游资/机构/北向席位；确认行业分类/板块资金流可用性；确认涨跌停/ST 口径与 `stk_limit` 是否替代规则推导 | 第 2 批无法开工；LHB 席位分类可能返工；B1-02 规则推导可能口径错误 |
| **H3：AI 输出红线与策略版本** | H3 | 签 `policy_version`、禁用词/语义过滤、历史统计表述、免责声明文案、抽样比例、新 kind 的预审规则；确认外部 LLM 的数据出境/保密边界 | 第 3 批不能开 C 端；可能违反对上游保密义务 |
| **H5：数据分级与上线门禁** | H5 | 每个数据集的 `internal_eval`/`c_end_display` 映射；AI 结果是否算 C 端展示（是）；F1 时间盒 2026-11-12 与 kill-switch；限流/成本预算 | C 端恒 403 或越权展示；无法在 11-12 门禁签字 |
| **H2：新外部依赖 + roster/ownership** | H2 | 批准 LLM provider（供应商、数据驻留、成本）；批准 `services/ai/` 写域归属（A3 或新 A24）；批准 `contracts/ai` 新域 | 网关无法落地；契约无 owner |
| **F1 授权** | H4/H5/法务 | C 端商用/再分发书面授权；与 tushare 来源解耦前基础信息也不能展示 | 所有 C 端 AI 功能不可见，仅内部评测 |
| LLM 幻觉/无来源断言 | A3/A24 + A16 | 证据绑定 + 数值复算 + 抽样 | 误导性输出/合规事件 |
| 供应商不可用/成本失控 | A3/A24/A13 | 超时/熔断/预算/降级为数据卡 | 页面不可用或成本超支 |
| Prompt injection（数据/网页内容） | A3/A9 | 工具结果按数据处理、不执行指令；输入/输出双向校验；工具 allowlist | 模型被诱导输出违规内容 |
| 跨 tier 缓存泄露 | A3/A13 | 缓存键含 tier/policy；不共享 CDN | 受限数据/结果泄露 |
| 数据缺口被伪装 | H4/A12 | 缺口显式（B1-03 起强制执行），无数据不得编造 | 违反 PRD §2.3 的「不可假装有」 |

## 被否选项

1. **AI 网关并入 `services/api`**：省一个进程，但 provider 密钥、长请求、成本/熔断和审计会污染 BFF；
   API 一旦被模型延迟拖垮，行情/自选也一起不可用。仅作为 H2 不批独立服务时的回退。
2. **AI 网关并入 `services/market`**：market 是确定性只读域，p99 与 entitlement 语义明确；混入概率性生成
   会让「行情 200」不再代表确定性，且研究数据依赖会把 market 拖成万能服务。
3. **复用 `services/content` 作为 AI 服务**：content 是内容域且当前为空；平台能力与业务内容生命周期不同，
   后续每个域都要等 content 发布。保留 content 做内容运营/内容源，不承担模型调用。
4. **H5 直连 LLM**：密钥暴露、无统一过滤/审计、无法保证 AI 标识不可关闭；直接否。
5. **每个功能点一套端点/prompt/过滤器**：端点与过滤器会漂移；P0 用统一 analyses/chat + 统一 postprocess。
6. **每条 AI 输出人工预审**：合规上最稳，但吞吐不可行；改用「H3 签策略 + A16 抽样 + 高风险模板预审」。
7. **P0 引入新数据库/任务队列/常驻 worker**：当前 AI 请求是同步/SSE 的短生命周期；用 Redis 缓存 + 审计
   JSONL 足够，避免重复 ADR-003 的「常驻调度只增故障面」错误。若 P1 出现批量/长任务再评估队列。
8. **用 A20–A23 作为 P0 的生产 AI 层**：它们仍在 shadow、无 tool access、无 A16+H3 闭环；只能作为研究
   供给方，不能替代 C 端 AI 网关。

## 可逆性

- 服务边界：高。`services/ai` 若合并回 api，可保留同一 contract 与 postprocess 模块，作为插件挂载；
  搬迁不改契约。
- 契约：`/v1/ai/*` 为新增，回退只需下线该域并保留历史结果；不触碰 market/fundamental/watchlist。
- 数据：不新增 P0 数据库 schema；ingest 新增数据集是 additive，可按数据集独立停用/回滚。
- 合规：`policy_version`/`prompt_version`/copy 快照 append-only；回滚到旧版本必须保留审计与已发布文案历史。

## 验收与下一步

1. **本文签字**：H2（架构/新服务/新依赖）、H3（AI 合规策略边界）、H4（tushare 接口/口径）、H5（分级/上线门禁）。
2. **A0 立即做**：起草 `contracts/ai/openapi.yaml` 骨架 + A11 契约测试清单（INF-01）；在 H2 批准前不写
   `services/ai/` 代码。
3. **A3/A24 立即做**：provider 抽象 + FakeProvider + postprocess 空管线（INF-02/03/04），先用 fake/replay
   跑通确定性测试。
4. **A1/A2 立即做**：按第 2 批 2-1～2-7 拆 ingest 任务，先 `daily_basic`、`top_list`/`top_inst`、`moneyflow`、
   `margin`、`hk_hold`；每接一个数据集必须同步 serving 端口与契约测试。
5. **A7 立即做**：AI 页面壳/路由/错误态（INF-07），只接生成客户端与 mock，不硬编字段。
6. **A11/A12**：每个 contract/数据集落地后补契约测试与 E2E；AI 输出用 FakeProvider 做确定性 golden，
   真模型只做人工抽样，不进入 CI 断言。

**Definition of Done（P0 AI 功能）**：功能点对应的第 1/2 批数据与规则验收通过 + 第 3 批 pipeline 接入 +
H3/A16 抽样通过 + entitlement/F1 开关可回退 + 每条结论有证据/`as_of`/AI 标识。缺一不算完成。
