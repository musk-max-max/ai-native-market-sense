# 交接说明：运营配置 schema → Config Service 契约（A14 → A0）

日期：2026-11-06 ｜ 发起：A14（运营自动化操作员）｜ 评审：A0（架构/契约）｜ 抄送：H5、H6、A8

## 背景

运营配置目前没有契约（A14-handoff：配置 API 未建；A8-handoff：运营中台「栏目/内容/策略配置 + 草稿→校验→审批→发布状态机」即将启动）。为避免 A8 表单字段与后续 API 契约各自起飞，A14 先起草了结构草案，请 A0 收敛成 Config Service 契约；契约再回到 A14 作为读域实现依据。约定链路：

```
A14 起草结构草案(configs/ops/schema/) → A0 收敛 OpenAPI 契约 → 契约回到 A14/A8 做实现与表单依据
```

## 1. 需要 A0 先做的一件事（阻塞 CI）：激活 `configs/ops/` 写域

`ownership.yaml` 中 `configs/ops/` 仅出现在 `notes.reserved_paths`（owner A14），未在 `paths` 登记；`notes.unmatched_paths: deny`。实测：

```
$ node infra/ci/path-guard.mjs --files configs/ops/README.md --actor A14 --json
{"violations":[{"file":"configs/ops/README.md","code":"UNMATCHED",
  "detail":"路径未在 ownership.yaml / 根文件白名单登记（default-deny）"}]}
```

=> 本目录的 PR 会被 path-guard 判红。A14 不可改 `ownership.yaml`（A0 owns，reviewers [H2]，forbidden ["*"]），请 A0 在 `paths` 增加条目（建议：owner `A14`，reviewers 含 A0/H6，`modes` 允许 write，与 `configs/rbac/` 同级惯例），并把 `notes.reserved_paths` 里的旧条目移除或注明已激活。

## 2. 结构真源与规模

- 文件：`configs/ops/schema/ops-config.schema.json`（JSON Schema 2020-12，`$schema` 已声明）。
- 规模：**50 个叶字段** = 34 运营填写 + 5 信封服务端维护（`schema_version`/`config_id`/`environment`/`version`/`status`）+ 11 `meta` 系统只读；另含对象/数组容器 8 个（未计入叶字段）。
- 顶层 required：`schema_version`、`config_id`、`environment`、`version`、`status`、`change_reason`、`impact_scope`、`spec`。
- 每个对象 `additionalProperties: false`；未登记字段（含全部不可配项）→ 结构校验硬拒绝，不做静默忽略。
- 逐字段类型/约束/默认值/审批分类/可见性/影响面：`configs/ops/schema/field-catalog.md`（评审时以此为准）。

## 3. 需要 A0 在契约中定义的 component（10 个）

| #   | Component           | 说明                                                                                                                                  | 字段数          |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | `OpsConfigDocument` | 信封 + spec + meta；GET/PUT 的顶层体                                                                                                  | 7 + spec + meta |
| 2   | `OpsSpec`           | 配置主体容器                                                                                                                          | 3 个数组        |
| 3   | `Column`            | 栏目                                                                                                                                  | 6               |
| 4   | `ContentItem`       | 内容编排项（含 display_window）                                                                                                       | 10 + 3          |
| 5   | `DisplayWindow`     | 展示时段                                                                                                                              | 3               |
| 6   | `RankingStrategy`   | 榜单策略                                                                                                                              | 11              |
| 7   | `RotationStrategy`  | 轮播策略                                                                                                                              | 5               |
| 8   | `SystemMeta`        | 系统只读元数据                                                                                                                        | 11              |
| 9   | `Actor`             | `{kind: human/agent, id, model_version?}`，建议 `$ref` 复用 `identity.AuditSink` 的 actor 定义                                        | 3               |
| 10  | `ReleaseMeta`       | `{release_id, published_at, approval_ref, content_hash, schema_version, policy_version}`，建议与审批契约（A4）交叉引用 `approval_ref` | 6               |

约定：schema_version 为 `const "0.1"`；契约里保留版本枚举位，加字段必须走 schema 版本升级（minor），不得在 0.1 上放宽 `additionalProperties`。

## 4. API 能力清单（请 A0 定义路径/方法/错误码，A14 提供语义要求）

| 能力                                             | 要求                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /configs/{config_id}`                       | 返回 published 或指定 `?status=draft`（运营读域）；带 `ETag`/`version`                                                                                             |
| `PUT /configs/{config_id}`（draft 写入）         | 必须 `If-Match: <version>`；冲突 409 + 三点 diff（base/current/submitted）；成功 version+1                                                                         |
| `POST /configs/{config_id}/validate`             | 返回结构错误（JSON Schema）与语义错误（V-01–V-12）分列，带稳定错误码（供 A8 表单逐字段定位）；**不产生副作用**                                                     |
| `POST /configs/{config_id}/submit`               | 建审批单（T1/T3 由 A15 规则引擎判定）；T3 需附 H3 预检 `policy_version`                                                                                            |
| `POST /configs/{config_id}/publish`              | 需可解析的 `approval_ref`（A4 账本具名记录，L51：不得申请人预填）；生成**不可变 release**（快照 + `content_hash`）；**灰度 ≤10%，禁止全量参数**；返回 release 指针 |
| `GET /configs` / `GET /releases`                 | 列表 + 按 release 回滚指针（rollback = 切指针，不改历史 release）                                                                                                  |
| `GET /configs/{config_id}/diff?base=&submitted=` | 三点 diff 的精确结构由 A0 定义（开放问题 6）                                                                                                                       |

错误体沿用 `contracts/shared/openapi.yaml#/components/schemas/Problem`；不新增错误体形状。契约只增不删、新增字段 optional（仓库既有契约惯例）。

## 5. 数据域引用（配置只存引用，不存数据）

| 字段                                                      | 指向         | 责任方 | 契约需要                                                                                                                     |
| --------------------------------------------------------- | ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `strategies[].metric_id`（`^M[0-9]{2}$`）                 | 指标口径     | A2/H4  | 机器可读指标注册表（当前 `docs/metrics/P0-metrics.md` 仅文档；executable：M01/M02/M04/M08，M03/M05/M06/M07 为 pending-data） |
| `content_items[].content_ref`（`^cnt_...$`）              | 已审内容实体 | A3     | id 命名空间确认（当前为 A14 提案）                                                                                           |
| `content_items[].asset_ref`（`^ast_...$`）                | 素材库       | A10    | id 命名空间 + 素材合规状态可查询                                                                                             |
| `content_items[].target_route`                            | 站内路由     | A7     | 路由白名单（V-05 校验用）                                                                                                    |
| `meta.published_release.approval_ref`（`^apr_<uuidv7>$`） | 审批账本     | A4     | 可解析性 + 校验接口                                                                                                          |

请 A0 决定这些引用在契约里是裸字符串 + 服务端校验，还是带 `SourceRef` 风格包装（不建议包装：运营配置不是数据响应，`as_of` 不在配置域）。

## 6. 一致性/发布语义（对齐 L6，请 A0 确认落法）

- 乐观锁 `version` + `If-Match`；409 三点 diff；运营在 latest 上 rebase 后再提交。
- draft/published 双态；publish 生成不可变 release；回滚 = release 指针切换。
- publish 前服务端必须校验（V-11/V-12）：`approval_ref` 可解析 + `policy_version` 与当前 `rules/ai-content-policy.json` 一致，不一致拒绝并提示重新预检。
- 灰度：接口必须显式要求灰度参数且上限 10%；全量参数应 **不存在**（宁可 400，不接受全量请求）——这是 A14 的硬约束，请在契约中固化为校验而非文档约定。

## 7. 待决/开放问题（与 field-catalog §9 对应，需 A0 给结论的形状）

1. H6 配置五级分类 C0–C4 的字段级映射未落仓：本草案暂只标 T1/T3，落地后补 `Cx` 列（依赖 H6，不阻塞契约形状）。
2. 指标注册表机器可读化（A2）。
3. `content_ref`/`asset_ref` 命名空间（A3/A10）。
4. 一个编排项是否可投放到多个栏目：v0.1 限单栏目；若需多栏目，改为 `placements[]`，属破坏性变更，请现在定。
5. 灰度粒度：按用户桶还是请求比例？需写入契约参数。
6. 三点 diff 精确结构（base/current/submitted 的字段级表示）。
7. published release 是否需要在仓库留导出快照供审计（涉及审计与仓库双真源问题）。
8. 轮播间隔 3–30s 的上下限（A10 设计系统/无障碍）。

## 8. 评审检查清单（请 A0 逐项给结论）

- [ ] `configs/ops/` 已在 `ownership.yaml` paths 激活（§1）。
- [ ] 10 个 component 是否全部需要，`Actor`/`ReleaseMeta` 是否改为 `$ref` 复用（§3）。
- [ ] 34 个运营字段中哪些不应由运营写入（与 H6 分类交叉核对）。
- [ ] API 能力与错误码（§4）；`validate` 是否可离线/无副作用。
- [ ] 引用字段（§5）的校验归属。
- [ ] 一致性/发布语义（§6），尤其「全量参数不存在」的固化方式。
- [ ] 开放问题 4/5/6 的结论（其余可并行）。
- [ ] 输出物：OpenAPI 契约文件路径 + 错误码表 + diff 结构 + canary 参数定义。

## 9. A14 不做/不决定的

字段的业务分类（T1/T3 的最终判定、C0–C4 映射）由 H6 定；对外的 12 类禁用词与白名单由 H3 定；文案过审由 H3 执行。A14 不修改 `ownership.yaml`、`rules/ai-content-policy.json`、ADR、代码与数据库。
