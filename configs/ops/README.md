# 运营配置（`configs/ops/`）

运营侧可配项的**结构草案**与变更申请模板。owner：A14（运营自动化操作员）。评审：A0（契约收敛）、H6（运营边界/审批分类）、H3（对外文案）。

## 状态

**草案，未评审、未接入线上**。Config Service 与配置 API 尚未建（A8 中后台启动中，审批入口 `/v1/internal/approvals/*` P0 刻意不暴露）。在当前阶段本目录只允许：起草 schema、写示例、写文档、写变更申请单。**不做任何 publish 动作**，不写生产配置。

## 目录

| 路径                             | 内容                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `schema/ops-config.schema.json`  | 配置文档结构真源（JSON Schema 2020-12）；所有对象 `additionalProperties: false`                                                 |
| `schema/ops-config.example.yaml` | draft 示例（staging），仅供填表/校验演示，非线上真值                                                                            |
| `schema/field-catalog.md`        | 逐字段清单：类型/约束/默认值、审批（T1/T3）、对外可见、影响面；§6 不可配项（12 条，含理由）；§8 语义校验 V-01–V-12；§9 开放问题 |
| `schema/handoff-to-a0.md`        | 交 A0 的契约收敛交接说明：component 清单、API 能力、依赖与待决项                                                                |
| `templates/change-request.md`    | 变更申请单模板（必带 before/after diff、为什么改、影响面、回滚、灰度）                                                          |
| `drafts/`                        | 按 `change-request.md` 起草的草稿配置；每份草稿须自包含变更理由                                                                 |

## 变更流程（与员工完全一致，不得跳过）

```
起草（drafts/）→ 结构校验（schema）+ 语义校验（V-01–V-12）→ 提交审批（T1/T3；T3 先过 H3 话术白名单）
→ 发布（生成不可变 release，灰度 ≤10%）→ 观察 →（必要时按 release 回滚）
```

- 每次变更必带 **before/after diff** 与 **影响范围**（roster gates）。
- 对外文案（field-catalog §7 的 6 个 T3 字段）未过 H3 过审 → 不发布。
- 灰度上限 **≤10%**，不许发起全量；灰度粒度由 Config Service 定义（见开放问题 5）。
- `approval_ref` 由 A4 审批 API 建单时生成，申请人/agent **不得预填**（L51）。
- 冲突按 L6 处理：`version` + `If-Match` 乐观锁，409 返三点 diff（base/current/submitted），由运营在最新版本上 rebase 后重新提交。

## 硬边界

- 不可配项（免责声明、AI 标识、as_of/staleness、退订入口、风险提示、话术白名单，及其他合规字段）**不在 schema 中定义**，写入即结构校验失败。详情见 `schema/field-catalog.md` §6。
- 不修改代码/数据库；不修改 `ownership.yaml`、`rules/ai-content-policy.json`、ADR 等他人写域文件；数据口径只引用 `metric_id`（如 M08），不在配置中定义或重算。
- 运营配置只描述「编排与展示」：不承载数据值、口径、授权、合规文本。

## 依赖（阻塞本目录进入 CI 与实现）

1. A0 在 `ownership.yaml` 的 `paths` 激活 `configs/ops/`——目前仅登记在 `notes.reserved_paths`，`infra/ci/path-guard.mjs` 对本目录返回 `UNMATCHED`（default-deny）。见 `schema/handoff-to-a0.md` §1。
2. A0 将本 schema 收敛为 Config Service OpenAPI 契约，契约回到本目录作为读域实现依据。
