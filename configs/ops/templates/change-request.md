# 运营配置变更申请单（模板）

复制本文件到 `configs/ops/drafts/<YYYYMMDD>-<config_id>-<short-slug>.md`，填完随变更一起提交。**必填项缺一即退回**。

## 1. 基本信息

| 项                  | 值                                                                |
| ------------------- | ----------------------------------------------------------------- |
| 变更 id             | `ops-chg-<YYYYMMDD>-<序号>`                                       |
| 目标配置            | `<config_id>`（如 `ops_home_columns`）                            |
| 目标环境            | `dev` / `staging` / `prod`                                        |
| 基线版本            | `version=<v>`（`If-Match` 用；以 `GET` 返回的 ETag/version 为准） |
| 变更人              | `<员工 id>` 或 `<agent id>`（A14 等；agent 须附 `model_version`） |
| 提交时间            | `<ISO 8601 +08:00>`                                               |
| 关联 issue / 审批单 | `<链接或 pending>`                                                |

## 2. 为什么改（必填，8–200 字）

<只写观测到的事实与目标，不写推测。示例："近 7 日首页第二栏目点击率 <0.8%，低于其他栏目；拟调整 order 与标题以降低误导性，目标是把『榜单』入口移出首屏。">

## 3. 影响范围（勾选全部）

- [ ] 栏目结构（顺序/可见性/条数）
- [ ] 内容编排（内容项/素材/展示时段/跳转落点）
- [ ] 策略与榜单展示（口径引用/窗口/条数/更新时机）
- [ ] 对外文案（**T3，必须先过 H3**）
- [ ] 仅内部字段（`change_reason` / `impact_scope` 等）

影响面描述（用户可感知的部分）：<...>

## 4. before / after diff（必填）

以路径为粒度贴出变更前后，禁止只写「调整了顺序」：

````diff title="columns[].order (config_id=ops_home_columns, version 3 → 4)"
- pct_ranking.order: 2
+ pct_ranking.order: 3
- my_watchlist.order: 3
+ my_watchlist.order: 2

```diff title="strategies[st_pct_rank].title_template"
- "{metric_label}排序 · 截至 {as_of}"
+ "历史统计上，{metric_label}区间排序 · 截至 {as_of}"

> 完整 after 内容以 `configs/ops/drafts/<file>.yaml` 为准；diff 需与之一致。服务端 409 时按三点 diff（base/current/submitted）rebase 后重贴。

## 5. 校验结果（必填）

- [ ] 结构校验通过：`ops-config.schema.json`（请附命令/工具与输出摘要）
- [ ] 语义校验通过：V-01–V-12（至少 V-01/V-02/V-03/V-05/V-06/V-08/V-09）
- [ ] 未触碰不可配项（免责声明 / AI 标识 / as_of / 退订入口 / 风险提示 / 话术白名单 / 合规字段 / 授权 / 口径 / 样式 / 触达 / AI 生成内容）
- [ ] 未修改代码、数据库、`ownership.yaml`、`rules/ai-content-policy.json`、ADR

## 6. 审批（必填）

- 审批类型：`T1 常规` / `T3 文案`
- 若 T3：H3 话术白名单预检结果 = `<pass/reject + policy_version>`；H3 过审结论 = `<链接/待审>`
- 审批单：`approval_ref = <由 A4 生成，申请人不得预填>`；状态 `<pending/approved>`
- 灰度：`≤10%`，灰度参数 = `<用户桶/请求比例，见契约>`；**不申请全量**
- 期望发布窗口：`<时间窗>`；观察指标：`<点击率/曝光/错误率等>`

## 7. 回滚方案（必填）

- 回滚对象：`release_id=<上一个可用 release>`
- 回滚动作：release 指针切换（不改历史 release）
- 触发条件：<例如「发布后 30 分钟内 C 端错误率 > X%」或「H6 判定文案风险」>
- 回滚执行人：<人员/值班>

## 8. 检查清单（提交前自检）

- [ ] before/after diff 已贴且与 underlay 文件一致
- [ ] 影响范围已写，且与 `impact_scope` 字段一致
- [ ] 对外文案已过 H3（或本单无对外文案）
- [ ] 审批类型正确，未自行降级/升级
- [ ] 灰度 ≤10%，无全量请求
- [ ] 回滚方案可执行（目标 release 存在）
- [ ] 未触碰 `configs/ops/` 之外的写域
````
