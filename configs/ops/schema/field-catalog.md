# 运营配置字段清单（KD-OPS-001 v0.1 草案）

> 结构真源：`configs/ops/schema/ops-config.schema.json`（JSON Schema 2020-12，A14 起草，待 A0 收敛为 Config Service 契约）。
> 状态：**草案，未评审**。owner A14；评审 A0（契约）、H6（运营边界）、H3（对外文案）。
> 约束来源：`agents/roster.yaml` A14 段、`agents/decisions.md`（L6 配置一致性、L12 榜单中性化、H3 §2.4 立法权、H6 配置边界 16 项/审批流 7 类）、`docs/adr/ADR-006`（文案治理）、`docs/adr/ADR-008`（用户分级与授权）、`rules/ai-content-policy.json`。

## 0. 标注口径

- **审批**：T1 常规 / T3 文案（H6 七类审批流，decisions.md 第 5 节）。凡「对外文案」一律 T3 + H3 话术白名单过审（roster gates：对外文案须 H3 过审）。A14 **不自行判定**绿/黄/红与 T2，路由由 A15 规则引擎判定；规则未覆盖即升级 H5/H6。
- **对外可见**：是 = 会出现在 C 端 H5；否 = 仅内部配置与审计。对外可见字段同时受 `rules/ai-content-policy.json` 禁用词预检。
- **影响面**：用户可感知面；回滚以 release 为单位（L6 不可变 release），不按字段回滚。
- **可配**：是（运营填写）/ 条件（创建后锁定或仅系统可改）/ 否（契约或服务端维护）。
- 所有对象均 `additionalProperties: false`：写入任何未登记字段（含不可配项）→ 结构校验硬拒绝，**不是静默忽略**。

## 1. 文档信封（7 字段）

| 字段             | 类型 / 约束                     | 默认    | 可配                                                                           | 审批       | 对外可见 | 影响面                        |
| ---------------- | ------------------------------- | ------- | ------------------------------------------------------------------------------ | ---------- | -------- | ----------------------------- |
| `schema_version` | const `"0.1"`                   | —       | 否（随契约版本）                                                               | —          | 否       | 全部（结构版本）              |
| `config_id`      | `^ops_[a-z0-9_]{3,48}$`         | —       | 条件（创建时定，不可改）                                                       | T1（创建） | 否       | 整个配置集                    |
| `environment`    | enum `dev` / `staging` / `prod` | —       | 条件（契约 0.1.0：query 必填，写请求体也含；二者须一致，服务端校验待 A0 确认） | —          | 否       | 目标环境；prod 需 H5 人类确认 |
| `version`        | int ≥1，乐观锁                  | 1       | 否（服务端维护；客户端用 `If-Match` 传）                                       | —          | 否       | 并发一致性（L6）              |
| `status`         | enum `draft` / `published`      | `draft` | 否（状态机驱动）                                                               | —          | 否       | 发布态 / 草稿态（L6 双态）    |
| `change_reason`  | str 8–200，内部字段             | —       | 是                                                                             | T1         | 否       | 审计留痕（为什么改）          |
| `impact_scope`   | enum[]，1–6 项                  | —       | 是                                                                             | T1         | 否       | gates 的「影响范围」机器校验  |

## 2. 栏目 `spec.columns`（6 字段）

| 字段        | 类型 / 约束                                  | 默认   | 可配 | 审批             | 对外可见 | 影响面                            |
| ----------- | -------------------------------------------- | ------ | ---- | ---------------- | -------- | --------------------------------- |
| `id`        | `^[a-z][a-z0-9_]{2,31}$`，published 后不可改 | —      | 条件 | T1（首次创建）   | 否       | 栏目身份；改 id = 新建栏目 + 迁移 |
| `title`     | str 1–20，**对外文案**                       | —      | 是   | **T3** + H3 过审 | 是       | 栏目标题（首页/模块）             |
| `subtitle`  | str 1–40，**对外文案**，可省略               | —      | 是   | **T3** + H3 过审 | 是       | 栏目副标题                        |
| `order`     | int 0–999，集内唯一                          | —      | 是   | T1               | 否       | 栏目展示顺序                      |
| `visible`   | bool                                         | `true` | 是   | T1               | 是       | 栏目是否展示                      |
| `max_items` | int 1–50                                     | `10`   | 是   | T1               | 是       | 栏目内最多展示条数                |

## 3. 内容编排 `spec.content_items`（13 字段）

| 字段                      | 类型 / 约束                                            | 默认   | 可配                        | 审批             | 对外可见                     | 影响面                     |
| ------------------------- | ------------------------------------------------------ | ------ | --------------------------- | ---------------- | ---------------------------- | -------------------------- |
| `id`                      | `^ci_[a-z0-9_]{3,40}$`，published 后不复用             | —      | 条件                        | T1（首次创建）   | 否                           | 编排项身份                 |
| `kind`                    | enum `editorial` / `data_card` / `banner`              | —      | 条件（发布后改类型 = 新建） | T1               | 是                           | 内容位形态                 |
| `column_id`               | 同栏目 id 正则，须存在于本集                           | —      | 是                          | T1               | 否                           | 归属栏目                   |
| `order`                   | int 0–999，同栏目内唯一                                | —      | 是                          | T1               | 否                           | 栏目内位置                 |
| `visible`                 | bool                                                   | `true` | 是                          | T1               | 是                           | 是否展示（不等于合规下架） |
| `content_ref`             | `^cnt_[a-z0-9_]{6,40}$`（A3 内容实体，命名空间待确认） | —      | 是                          | T1               | 间接（正文内容本身另有审核） | 引用哪条已审内容           |
| `asset_ref`               | `^ast_[a-z0-9_]{6,40}$`（素材库，命名空间待确认）      | —      | 是                          | T1               | 是（图片/封面）              | 素材引用；禁外链 URL       |
| `display_title`           | str 1–30，**对外文案**，可省略                         | —      | 是                          | **T3** + H3 过审 | 是                           | 内容位标题                 |
| `summary`                 | str 1–80，**对外文案**，可省略                         | —      | 是                          | **T3** + H3 过审 | 是                           | 内容位摘要                 |
| `target_route`            | 站内路径正则 `^/...`，须命中 A7 路由白名单             | —      | 是                          | T1               | 是（跳转目标）               | 点击落点；禁外链/scheme    |
| `display_window.start_at` | date-time（+08:00）                                    | —      | 是                          | T1               | 是                           | 展示时段起点               |
| `display_window.end_at`   | date-time（+08:00），晚于 start                        | —      | 是                          | T1               | 是                           | 展示时段终点               |
| `display_window.timezone` | const `Asia/Shanghai`                                  | —      | 否                          | —                | 否                           | 消除跨时区歧义             |

## 4. 策略 `spec.strategies`（两类型，13 个唯一字段）

| 字段               | 类型 / 约束                                                | 默认    | 可配                                      | 审批             | 对外可见             | 影响面                             |
| ------------------ | ---------------------------------------------------------- | ------- | ----------------------------------------- | ---------------- | -------------------- | ---------------------------------- |
| `type`             | enum `ranking` / `rotation`                                | —       | 条件（新增类型 = schema 升版 + 契约变更） | T1               | 否                   | 策略形态                           |
| `id`               | `^st_[a-z0-9_]{2,32}$`，集内唯一                           | —       | 条件（首次创建）                          | T1               | 否                   | 策略身份                           |
| `metric_id`        | `^M[0-9]{2}$`，须为已签口径且 executable                   | —       | 是                                        | T1               | 间接（决定展示口径） | 榜单口径；只引用不定义（H4/A2 域） |
| `metric_label`     | str 1–12，**对外文案**                                     | —       | 是                                        | **T3** + H3 过审 | 是                   | 口径中文标签                       |
| `universe`         | enum `all_a` / `main_board`                                | —       | 是                                        | T1               | 间接                 | 统计范围                           |
| `window`           | enum `d1` / `d5` / `d20`，须与 metric 匹配                 | —       | 是                                        | T1               | 间接                 | 统计窗口（P0 主口径 d1）           |
| `limit`            | int 1–50                                                   | `10`    | 是                                        | T1               | 是                   | 榜单展示条数                       |
| `title_template`   | str 4–40，**对外文案**，须含 `{metric_label}` 与 `{as_of}` | —       | 是                                        | **T3** + H3 过审 | 是                   | 榜单标题（L12：口径 + 截止时间）   |
| `schedule`         | enum `eod` / `manual`                                      | `eod`   | 是                                        | T1               | 间接                 | 更新时机（P0 不做盘中，C2）        |
| `personalized`     | const `false`                                              | `false` | 否（L12 硬裁定）                          | —                | —                    | 个性化推送被结构禁止               |
| `enabled`          | bool                                                       | `true`  | 是                                        | T1               | 是                   | 策略是否生效                       |
| `max_items`        | int 1–20（rotation）                                       | `5`     | 是                                        | T1               | 是                   | 轮播最大条数                       |
| `interval_seconds` | int 3–30（rotation）                                       | `8`     | 是                                        | T1               | 是                   | 轮播间隔（下限/上限待 A10 确认）   |

## 5. 系统只读 `meta`（11 字段，服务端写入）

| 字段                               | 类型 / 约束                 | 可配 | 审批 | 对外可见 | 说明                                         |
| ---------------------------------- | --------------------------- | ---- | ---- | -------- | -------------------------------------------- |
| `created_at` / `updated_at`        | date-time                   | 否   | —    | 否       | 服务端时间戳                                 |
| `created_by.kind`                  | enum `human` / `agent`      | 否   | —    | 否       | 可区分来源（agents/README 要求）             |
| `created_by.id`                    | str 1–64                    | 否   | —    | 否       | 员工 id 或 agent id（如 A14）                |
| `created_by.model_version`         | str 1–64，agent 必填        | 否   | —    | 否       | 模型版本/运行 id，用于漂移排查               |
| `published_release.release_id`     | `^rel_...`                  | 否   | —    | 否       | release 标识（服务端生成）                   |
| `published_release.published_at`   | date-time                   | 否   | —    | 否       | 发布时间                                     |
| `published_release.approval_ref`   | `^apr_<uuidv7>$`            | 否   | —    | 否       | 审批回指（L51：A4 建单生成，申请人不得预填） |
| `published_release.content_hash`   | `^sha256:[0-9a-f]{64}$`     | 否   | —    | 否       | 不可变校验 / 唯一回指                        |
| `published_release.schema_version` | const `"0.1"`               | 否   | —    | 否       | 发布时的结构版本                             |
| `published_release.policy_version` | `^ai-content-policy/x.y.z$` | 否   | —    | 否       | T3 预检所用 policy 版本（H3 签字，A5 持有）  |

## 6. 不可配项（结构排除，不是权限提示）

以下字段**不在本 schema 中定义**；因每层 `additionalProperties: false`，提交即校验失败。它们是 H6 16 项配置边界中「不可配，界面不渲染入口」的 6 类，加上运营配置不应承载的其他域。

| #   | 不可配项                                                       | 为什么运营不可配                                                                  | 真源 / 归属                                                                        | schema 处理                                         |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | 免责声明（正文/版本/可关闭性）                                 | 法律文本，措辞即定性；改一个字就是变更法律声明，须 H3 重新定稿并留痕              | ADR-006 D1/D7；契约 `meta.disclaimer`（`shared/openapi.yaml`）+ 后端 `copy.ts`；H3 | 无字段                                              |
| 2   | AI 标识文案（label/disclaimer）与是否展示                      | AI 生成内容标识是法定义务；badge 由后端注入，前端不得硬编码 fallback              | ADR-006 D7（H3 m02666 定稿）；A5/A7 实现；H3                                       | 无字段；运营配置不出现 `ai_label` / `ai_disclaimer` |
| 3   | `as_of` / `staleness`                                          | 数据时点由数据面产出，运营若可写即可伪造时点；C2 要求页面显式标注 stale           | `contracts/shared/openapi.yaml#/components/schemas/SourceRef`；A1 适配层产出       | 无字段；`display_window` 是展示时段，不是 `as_of`   |
| 4   | 退订入口（是否展示/文案/路径）                                 | 合规强制通道；隐藏或改文案即阻断用户退出营销触达                                  | 合规域（H3/H6）；ADR-006 出口治理                                                  | 无字段                                              |
| 5   | 风险提示                                                       | 合规强制展示，非运营文案                                                          | H3 红线清单；`rules/redline-basis.json`                                            | 无字段                                              |
| 6   | 话术白名单（词表/禁用词/规则/policy_version）                  | H3 立法权：规则由 H3 起草 → 法务会签 → 发布，A14/A17 只遵守不得自行创建或放宽     | `rules/ai-content-policy.json`（A5 持有，H3 签字）；H3 §2.4                        | 无字段；只在上架预检时引用其 `policy_version`       |
| 7   | 其他任何合规类字段（红线清单/audience 定义/审批规则/复核结论） | 合规判定与规则定义权不在运营侧；运营只提交待审配置                                | H3 / A5 / A16                                                                      | 无字段                                              |
| 8   | entitlement / tier / 授权原因文案                              | 授权由 Config Service 读侧注入；授权 cause 只进日志不外显；运营不可配「谁看什么」 | ADR-008；ADR-006 D4（H3 m01498）；A4                                               | 无字段                                              |
| 9   | 数据值与指标计算口径                                           | 数据是产品本身；口径归 H4/A2，运营只引用 `metric_id`，在配置里重算即第二真源      | `docs/metrics/P0-metrics.md`；A1/A2                                                | 只允许 `metric_id` 引用，禁公式/系数/权重字段       |
| 10  | 样式 / 设计 token（颜色/字号/间距/布局像素）                   | 设计系统单一真源；运营配置承载样式会造成线上视觉双源                              | `packages/design-tokens/`（A10）；ADR                                              | 无字段；`max_items` 等仅表达数量                    |
| 11  | 推送 / 触达文案与频次                                          | 触达受 T4 审批 + H3 频次（1/日·3/周·10/月）；A17 话术域；L12 不做个性化推送       | H3 执行参数；H6 触达数值；A17                                                      | 无字段；`personalized` const false                  |
| 12  | AI 生成内容本身（prompt/模型/生成参数）                        | 生成归 A3 AI 网关 + A5 策略；P7 未接路由；运营只编排已审内容                      | ADR-007；A3/A5                                                                     | 无字段                                              |

## 7. 统计

- schema 共 **50 个叶字段**：**34 个运营填写** + **5 个信封服务端维护**（`schema_version` / `config_id` / `environment` / `version` / `status`）+ **11 个 `meta` 系统只读**。
- 其中 **T3 文案字段 6 个**：`columns[].title` / `columns[].subtitle` / `content_items[].display_title` / `content_items[].summary` / `strategies[].metric_label` / `strategies[].title_template`。
- 审批需求：**6 个字段走 T3 + H3 过审，其余运营可写字段走 T1**；A14 不自行升级/降级审批类型。

## 8. 语义校验（JSON Schema 表达不了，服务端实现；A14 提交前自检）

| 编号 | 规则                                                                                                                                                            | 失败处理                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| V-01 | `columns[].id`、`content_items[].id`、`strategies[].id` 在集内唯一                                                                                              | 校验失败，返校验错误清单 |
| V-02 | `columns[].order` 在集内唯一                                                                                                                                    | 同上                     |
| V-03 | `content_items[].column_id` 必须存在于本集 `columns[].id`                                                                                                       | 同上                     |
| V-04 | 同一 `column_id` 内 `content_items[].order` 唯一                                                                                                                | 同上                     |
| V-05 | `target_route` 必须命中 A7 路由白名单（防开放跳转/外链）                                                                                                        | 拒绝                     |
| V-06 | `display_window.start_at < end_at`，且均为 +08:00                                                                                                               | 拒绝                     |
| V-07 | 策略 `id` 集内唯一                                                                                                                                              | 拒绝                     |
| V-08 | `metric_id` 须为 H4 已签署且 executable 的口径；`window` 须被该指标支持（当前可执行：M01/M02/M04/M08；M03/M05/M06/M07 为 pending-data，不得用于对外榜单）       | 拒绝并提示口径状态       |
| V-09 | `title_template` 渲染前必须同时含 `{metric_label}` 与 `{as_of}`；渲染后受禁用词预检（L12：禁「主力/抢筹/值得关注」，`rules/ai-content-policy.json` 全部 12 类） | 拒绝；命中即 T3 驳回     |
| V-10 | 所有对外文案字段（§7 的 6 个）先过 `rules/ai-content-policy.json` 禁用词预检，再交 H3 过审；预检通过 ≠ 已批准                                                   | 未过审不发               |
| V-11 | `published` 状态必须有 `meta.published_release`，且 `approval_ref` 可解析到 A4 审批账本具名记录                                                                 | 拒绝发布                 |
| V-12 | 发布时 `policy_version` 必须等于当前 `rules/ai-content-policy.json` 的 `policy_version`；不一致须重新预检                                                       | 拒绝发布                 |
| V-13 | 路径 query `environment` 与写请求体 `OpsConfigWrite.environment` 必须相等（query 为路由键，以此为准）                                                           | 400 `VALIDATION_ERROR`   |

## 9. 待确认 / 开放问题（不阻塞 schema 草案，阻塞契约收敛与实现）

1. **H6 配置五级分类 C0–C4 的字段级映射未落仓**：`agents/decisions.md` 第 5 节只有摘要，本表暂只标 T1/T3；需要 H6 提供 16 项边界原文后再补 `Cx` 列。
2. **指标注册表未机器可读**：`docs/metrics/P0-metrics.md` 是文档，V-08 需 A2 提供机器可读 registry（或契约枚举）。
3. **`content_ref` / `asset_ref` 命名空间未定**：需 A3（内容）/A10（资产）确认 id 规则；当前为提案。
4. ~~**多栏目投放**~~ **已决（契约 0.1.0）**：一个 content_item 只属一个 column（`column_id` 单值）；若未来需要一份内容多处投放，改 `placements[]` 属破坏性变更。
5. ~~**配置灰度粒度**~~ **已决（契约 0.1.0）**：`canary_percent` 整数 1–10，无全量字段（全量请求不存在，额外字段 400）；分桶算法服务端实现，同一 config_id + 匿名会话桶稳定。
6. ~~**三点 diff 的精确结构**~~ **已决（契约 0.1.0）**：`ThreeWayDiff{base_version,current_version,submitted_version,changes[],conflicts[]}`，`FieldChange{path,kind:added|removed|modified,base,current,submitted}`，`FieldConflict{path,reason}`；409 `ConfigConflictProblem` 带 `diff`。
7. **发布快照是否入仓**：`configs/ops/` 只存 draft 文件，published release 存 Config Service（不可变，`GET /v1/internal/releases/{release_id}` 可读）；是否在仓库存导出快照供审计，待 H5/A0 定。
8. **轮播间隔上下限**：`3–30s` 为建议值，需 A10 设计系统确认（无障碍/动效规范）。契约已按 3–30 固化。

## 10. 契约对齐记录（2026-11-06）

- A0 已落盘 `contracts/config/openapi.yaml` 0.1.0（commit `b73c293`；后续 `9e85839` 下调枚举大小写/命名），10 operations，redocly lint 通过。逐个 component 比对 props/required/enum/pattern/边界：**除 `window` 枚举 token 外无差异**（`target_route`、`policy_version` 的 pattern 仅为 JSON 与单引号 YAML 的转义写法差异，语义相同）。
- `window` 枚举已对齐：契约 `9e85839` 改为 `d1`/`d5`/`d20`，本 schema 与示例、本表已同步（原为 `1d`/`5d`/`20d`）。`flow` 枚举契约用 `t1`/`t3`（小写）；本表 `T1`/`T3` 是审批流标签，不是配置字段，保持决策文档写法。
- 已按契约补 schema `$defs/OpsConfigWrite`（PUT/validate 写请求体）：`schema_version`/`config_id`/`environment`/`change_reason`/`impact_scope`/`spec` 必填，**不含** `version`/`status`/`meta`（服务端维护；请求体出现即 `additionalProperties:false` 拒绝）。
- 契约已定：单栏目投放、canary 1–10 无全量、三点 diff 结构、rollback 只切不可变 release 指针且需**新的** `approval_ref`（不复用发布审批）。
- **契约比 schema 松的 4 处**（服务端 validate 必须按 schema 执行，或由 A0 在契约补 allOf；已回报 A0）：
  1. `ContentItem` 条件必填：`editorial`/`banner` → `content_ref`+`asset_ref`；`data_card` → `content_ref`；
  2. `OpsConfigDocument`：`status=published` ⇒ `meta.published_release` 必填；
  3. `RankingStrategy.title_template` 的 `{metric_label}`/`{as_of}` 占位符 pattern（schema 结构校验 + V-09 双保险）；
  4. `Actor`：`kind=agent` ⇒ `model_version` 必填。
- 待 A0 澄清：`environment` 在 query 与写请求体双写，服务端须校验一致（建议契约注明，或写请求体去掉 environment 以 query 为准）。
- 仍未决（不阻塞实现，阻塞字段定稿）：H6 C0–C4 字段级映射、A2 指标注册表机器可读化、A3/A10 的 `content_ref`/`asset_ref` 命名空间、发布快照入仓、轮播间隔（已按 3–30 暂定）。

**A0 回复结论（2026-11-06，m00294，最终）**：

- `d1/d5/d20` 为最终口径（ADR-001 D3：枚举值小写下划线、首字符不能数字），语义仍为 1/5/20 个交易日；本 schema 已同步。
- `environment` 双写保留：query 是路由键，body 必须一致，不一致服务端返回 400 `VALIDATION_ERROR`（契约 `EnvironmentQuery` description 已写「以 query 为准」）；本表新增 V-13，服务端实现时校验。
- 上面 4 处条件必填：**契约不补 `allOf`**，保持「结构契约 + V-01–V-12 语义校验」分层；本 JSON Schema 是服务端执行真源，A11 只按契约结构断言，不会漏测。若 H6 后续要求升级为契约结构，走 D6 变更。
- `contracts/config/openapi.yaml` 工作区另有 409/412 错误码与 conflict schema 修订（shared 0.2.3）未提交，以 `contracts/` 现场为准；A14 复核当前工作区，除 pattern 转义写法外仍与本 schema 一致。
