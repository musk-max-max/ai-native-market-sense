# 中后台控制台方案 v2（console-v2）

> 基准 **1440 × 900**，组件库 **antd 5**（Layout / Menu / Table / Form / Modal / Badge / Statistic），Layout=左侧 Menu + 顶部面包屑 + Card 栅格。
> 现状基线：`web/console/src`（无 antd 依赖的自研 `AppShell` + `DataTable`/`StatusBadge`/`DoubleConfirm`/`DiffViewer`；`domain/state-machine.ts` 状态机；5 个页面）。

---

## 1. 四中台导航结构

### 1.1 顶层骨架

```
┌─ 1440 ──────────────────────────────────────────────────────────────────────┐
│ Topbar 56: 面包屑「运营中台 / 配置编辑器 / crm.followup」    [搜索] [ActorBadge]│
├──────────┬──────────────────────────────────────────────────────────────────┤
│ Sidebar  │  Content (24 栏栅格, gutter 16)                                    │
│ 232      │                                                                   │
│          │  ┌─StatCard─┐┌─StatCard─┐┌─StatCard─┐┌─StatCard─┐                 │
│ 运营中台  │  └──────────┘└──────────┘└──────────┘└──────────┘                 │
│  看板    │  ┌────────────────────────────────────────────┐                  │
│  编辑器  │  │ 主 Card：Table / Form / Diff                │                  │
│ 合规中台  │  │                                            │                  │
│  审计    │  └────────────────────────────────────────────┘                  │
│  AI标识  │  ┌───────────────┐┌───────────────┐                              │
│  锁定项  │  │ 副 Card        ││ 副 Card        │                              │
│ 管理后台  │  └───────────────┘└───────────────┘                              │
│  审批队列 │                                                                  │
│  权限矩阵 │                                                                  │
│ CRM      │                                                                  │
│  客户跟进 │                                                                  │
│  规则配置 │                                                                  │
│          │                                                                  │
│ ──────── │                                                                  │
│ 常驻脚注: │                                                                  │
│ 数据源    │                                                                  │
│ tushare   │                                                                  │
│ AI内容仅  │                                                                  │
│ 供参考    │                                                                  │
└──────────┴──────────────────────────────────────────────────────────────────┘
```

### 1.2 导航分组（对齐现有 `lib/router.ts` 的 `group`）

现有 5 路由按 `ops / admin / compliance / crm` 分组。v2 扩到 4 中台共 **10 项**，每项标注归属与新增/保留：

| 中台（Menu Group） | 菜单项 | 路由 | 现状 |
| --- | --- | --- | --- |
| **运营中台 ops** | 配置看板 | `/overview` | 已有 `OverviewPage` |
| | 配置编辑器 | `/config` | 已有 `ConfigEditorPage` |
| **合规中台 compliance** | 审计日志 | `/compliance/audit` | 现有 `CompliancePage` 拆分 |
| | AI 标识管理 | `/compliance/ai-labels` | **新增** |
| | 合规锁定项 | `/compliance/locked` | 现有 `CompliancePage` 拆分 |
| **管理后台 admin** | 审批队列 | `/approvals` | 已有 `ApprovalQueuePage` |
| | 权限矩阵 | `/admin/permissions` | **新增** |
| **CRM** | 客户跟进 | `/crm` | 已有 `CrmPage`（P2 占位） |
| | 规则配置 | `/crm/rules` | 现有 `crm.followup` 配置项独立入口 |

### 1.3 Menu 规范（antd `Menu`）

```tsx
import { Layout, Menu, Breadcrumb, Badge } from 'antd';
const { Sider, Header, Content } = Layout;

const MENU_ITEMS = [
  { key: 'ops', label: '运营中台', children: [
    { key: 'overview', label: '配置看板' },
    { key: 'config', label: '配置编辑器' },
  ]},
  { key: 'compliance', label: '合规中台', children: [
    { key: 'audit', label: '审计日志' },
    { key: 'ai-labels', label: 'AI 标识管理' },
    { key: 'locked', label: '合规锁定项' },
  ]},
  { key: 'admin', label: '管理后台', children: [
    { key: 'approvals', label: <span>审批队列 <Badge count={pending} size="small" /></span> },
    { key: 'permissions', label: '权限矩阵' },
  ]},
  { key: 'crm', label: 'CRM', children: [
    { key: 'crm', label: '客户跟进' },
    { key: 'crm-rules', label: '规则配置' },
  ]},
];

export function ConsoleShell({ active, pendingApprovals, actor, breadcrumb, children }) {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={232} theme="light" className="c-sider">
        <div className="c-brand">Market Sense · 中后台</div>
        <Menu
          mode="inline"
          selectedKeys={[active]}
          defaultOpenKeys={[groupOf(active)]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key as ConsoleRoute)}
        />
        <div className="c-sider-foot">
          数据源 tushare · AI 内容仅供参考<br />
          所有配置变更：草稿 → 校验 → 审批 → 发布
        </div>
      </Sider>
      <Layout>
        <Header className="c-topbar">
          <Breadcrumb items={breadcrumb} />
          <ActorBadge actor={actor} />
        </Header>
        <Content className="c-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
```

- 审批队列项挂 `Badge count={pending}`（复用现有 `AppShellProps.nav[].badge`）。
- `ActorBadge`（human / agent）从顶栏右侧**常驻**——操作者身份是审计上下文，不可只在列表行出现。
- 脚注常驻「数据源 tushare · AI 内容仅供参考」，沿用现有 `AppShell` 文案。

---

## 2. 配置编辑器状态机

### 2.1 状态与迁移（对齐 `domain/state-machine.ts`，前端不绕过）

```
                     ┌──────────┐
        保存         │  draft   │◄─────────────┐
      ┌─────────────►│   草稿   │              │
      │              └────┬─────┘   驳回/回退   │
      │                   │ 校验通过            │
      │                   ▼                    │
      │              ┌──────────┐              │
      │   退回修改    │validated │              │
      │  ┌───────────│  已校验   │              │
      │  │           └────┬─────┘              │
      │  │                │ 提交审批            │
      │  │                ▼                    │
      │  │           ┌──────────────┐          │
      │  │           │pending_approval│         │
      │  │           │    待审批      │         │
      │  │           └───┬────────┬──┘          │
      │  │      驳回─────┘        └─────通过     │
      │  │         ▼                  ▼         │
      │  │   ┌──────────┐        ┌──────────┐   │
      │  │   │ rejected │        │ approved │   │
      │  │   │  已驳回   │        │  已批准   │   │
      │  │   └────┬─────┘        └────┬─────┘   │
      │  └────────┘                   │ 发布     │
      │                               ▼          │
      │                         ┌──────────┐     │
      └─────────────────────────│ published │     │
        回滚 = 追加新 release    │   已发布   │     │
                                └────┬─────┘     │
                                     │ 回滚       │
                                     ▼           │
                              ┌────────────┐     │
                              │ rolled_back │─────┘
                              │   已回滚     │
                              └────────────┘
```

状态标签沿用 `CONFIG_STATE_LABEL`（草稿 / 已校验 / 待审批 / 已批准 / 已发布 / 已驳回 / 已回滚），`StatusBadge` 颜色映射：

| 状态 | antd Badge `status` | 色语义 |
| --- | --- | --- |
| draft 草稿 | `default` | 灰 |
| validated 已校验 | `processing` | 蓝（brand） |
| pending_approval 待审批 | `warning` | 橙 |
| approved 已批准 | `success` | 绿 |
| published 已发布 | `success` | 绿（+ 实心点） |
| rejected 已驳回 | `error` | 红 |
| rolled_back 已回滚 | `error` | 红（虚线边） |

### 2.2 迁移动作与门禁

| 迁移 | 触发动作 | 门禁（`domain/impact.ts` + `LevelBadge`） |
| --- | --- | --- |
| draft → validated | 点「校验」 | `computeImpact` 无 error 级 `ValidationIssue` |
| validated → pending_approval | 点「提交审批」 | C2 及以上**必须**人类审批；C0/C1 可走规则引擎低风险自动放行（`C1=A`，A15 无终审权） |
| pending_approval → approved | 审批人在 `ApprovalQueuePage` 通过 | `DoubleConfirm`：勾选「已阅读影响面」+ 输入 `dangerConfirmWord`；Modal 顶部固定渲染 `DiffViewer` |
| pending_approval → rejected | 驳回 | 必填 `rejectReason`；驳回原因进审计日志 |
| approved → published | 发布 | 二次确认 + 影响面 `ImpactPanel`；发布产物不可变 |
| published → rolled_back | 回滚 | 选 `rollbackTarget` 版本 → `DoubleConfirm`；**回滚 = 追加新 release，不改写历史** |

> **硬约束（沿用现有代码注释）**：单条审批，**列表不提供批量通过/驳回入口**；agent 只能发起变更，终审必须是人类。前端不得渲染任何绕过 `assertTransition` 的按钮。

### 2.3 编辑器界面布局

```
┌─ 配置编辑器 ─ /config?item=crm.followup ─────────────────────────────┐
│ 左栏 (8 栏)               │ 右栏 (16 栏)                              │
│ ┌──────────────────────┐ │ ┌──────────────────────────────────────┐│
│ │ 配置项列表 (Table)     │ │ │ crm.followup   [LevelBadge C2]       ││
│ │ 名称 | 状态 | 风险 | 版│ │ │ 状态: 待审批  已发布 v12              ││
│ │ 🔒 锁定项不在此列出    │ │ ├──────────────────────────────────────┤│
│ │  (跳锁定项页)          │ │ │ Form (antd)                          ││
│ │                       │ │ │  跟进间隔(天) [ 7      ]              ││
│ │                       │ │ │  提醒渠道     [站内信 ▾]              ││
│ │                       │ │ │  启用        [✓]                     ││
│ │                       │ │ │  * 合规锁定字段灰显 + 🔒 说明         ││
│ │                       │ │ ├──────────────────────────────────────┤│
│ │                       │ │ │ 变更预览 DiffViewer (before / after)  ││
│ │                       │ │ │  409 时切三点合并 base/mine/theirs    ││
│ │                       │ │ ├──────────────────────────────────────┤│
│ │                       │ │ │ ImpactPanel 影响面                    ││
│ │                       │ │ │ [保存草稿] [校验] [提交审批] [回滚]    ││
│ └──────────────────────┘ │ └──────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘
```

- 锁定项**不出现在编辑器左栏**，左栏底部给一行「N 项为合规锁定项，去合规中台查看 →」——对齐现有 `CompliancePage` 的「只说明为什么没有入口，不渲染编辑按钮」。
- 409 冲突走 `threeWayMerge`（`domain/diff.ts` 已有），UI 上把 base/mine/theirs 三列并排，冲突单元格标 `--warning-bg`。
- 每次字段变更立即重算 `computeImpact`，危险变更（`dangerDescription`）时「提交审批」按钮升级为 `ghost-danger` + 强制 `DoubleConfirm`。

---

## 3. 审计日志表格设计

归属：**合规中台 / 审计日志**（`/compliance/audit`）。数据来自 `services.listAudit()`（现有 `CompliancePage` 已接）。

### 3.1 列定义

| 列 | 字段 | 宽度 | 渲染 |
| --- | --- | --- | --- |
| 时间 | `at` | 160 | `formatDateTime` + `--font-mono`，右对齐 |
| 动作 | `action` | 120 | `StatusBadge` + 动作标签（映射见 §3.2） |
| 对象 | `itemId` | 200 | `--font-mono`，可点跳配置编辑器 |
| 操作者 | `actor` | 160 | `ActorBadge`（human=头像，agent=`AI` 方标） |
| 详情 | `detail` | 自适应 | 纯文本，超长省略 + Tooltip |
| 结果 | — | 100 | 成功 / 驳回 / 失败（新增，见下） |

```tsx
import { Table, Tag } from 'antd';

const auditColumns: ColumnsType<AuditEvent> = [
  { title: '时间', dataIndex: 'at', key: 'at', width: 160, align: 'right',
    render: (at) => <span className="c-mono">{formatDateTime(at)}</span> },
  { title: '动作', dataIndex: 'action', key: 'action', width: 120,
    render: (action) => <AuditActionTag action={action} /> },
  { title: '对象', dataIndex: 'itemId', key: 'itemId', width: 200,
    render: (id) => <a className="c-mono" onClick={() => openItem(id)}>{id}</a> },
  { title: '操作者', dataIndex: 'actor', key: 'actor', width: 160,
    render: (_, ev) => <ActorBadge actor={ev.actor} /> },
  { title: '详情', dataIndex: 'detail', key: 'detail', ellipsis: true },
  { title: '结果', key: 'result', width: 100,
    render: (_, ev) => resultTag(ev) },
];

<Table<AuditEvent>
  rowKey={(ev) => `${ev.at}-${ev.itemId}-${ev.action}`}
  columns={auditColumns}
  dataSource={events}            // 倒序，最新在上
  pagination={{ pageSize: 20, showSizeChanger: false }}
  rowClassName={(ev) => ev.actor.kind === 'agent' ? 'row--agent' : ''}
  sticky
/>
```

### 3.2 动作标签映射（沿用现有 `ACTION_LABEL`）

`draft.saved` 保存草稿 · `config.validated` 校验配置 · `approval.submitted` 提交审批 · `approval.approved` 审批通过 · `approval.rejected` 驳回变更 · `config.published` 发布配置 · `config.rolled_back` 回滚配置。

### 3.3 表格设计要点

1. **agent 行左侧 2px `--brand-emphasis` 竖条**（`rowClassName="row--agent"` + CSS `border-left`）：机器改动在长列表里一眼可辨。这是 v2 新增——现有 `ActorBadge` 只在行内，扫读时不突出。
2. **筛选条固定在表头下**：动作（多选）/ 操作者类型（human|agent）/ 对象 / 时间范围。筛选条件**写入 URL query**，便于把「某次回滚前后 10 分钟」作为审计链接分享。
3. **不可编辑、不可删除**：审计日志只读；页面不渲染任何写操作按钮。
4. **导出**：右上「导出 CSV」需走 `DoubleConfirm`（导出属敏感操作，记录到审计日志本身）。
5. **分页固定 20**，`showSizeChanger` 关闭，避免口径漂移。
6. 时间列 ISO + 本地时区双显示（Tooltip 给原始 ISO 字符串），与 C 端 `as_of` 严格相等口径一致。

---

## 4. 新增页面的最小规范

### 4.1 AI 标识管理（`/compliance/ai-labels`）

- 展示全站 `ai.generated` 标识的**投放清单**：哪些位置渲染了 AI 标识、标识文案版本、免责文本版本。
- **只读 + 版本历史**。标识文案来自服务端注入（现有 `AiGeneratedBadge` 契约：前端不硬编码、不提供关闭开关），本页不允许出现「关闭某处 AI 标识」的入口——那等于给运营开合规后门。
- 提供「标识覆盖率」指标：应展示位置数 / 实际展示位置数（由 E2E 契约 testid 统计）。

### 4.2 合规锁定项（`/compliance/locked`）

从现有 `CompliancePage` 拆出 `LOCKED_CONFIG_AREAS` 表（`id / title / lockedBy / reason / 操作=不可配（无入口）`）。**不渲染编辑按钮、表单、跳转**（现有 H6 硬约束）。v2 只在视觉上升级：每行加 `LockOutlined` 图标 + `--warning-bg` 行底，强化「这块动不了」的辨识度。

### 4.3 权限矩阵（`/admin/permissions`）

- 行=角色，列=权限（配置读 / 配置写 / 提交审批 / 审批通过 / 发布 / 回滚 / 审计读 / CRM 读 / CRM 写）。
- 单元格：`✓` 允许 / `—` 不允许 / `🔒` 继承自上级且不可改。
- **终审权不可授予 agent**（`C1=A`、A15 无终审权）：矩阵中 agent 行的「审批通过」格固定 `🔒`，悬浮说明「合规红线：机器无终审权」。
- 修改权限 = 走与配置相同的 草稿→校验→审批→发布 链路（复用 `ConfigEditorPage`），本页只读展示矩阵 + 入口按钮。

### 4.4 CRM（`/crm` + `/crm/rules`）

- `CrmPage` 保留 P2 占位诚实状态：客户名单/跟进记录**待 A16 CRM Service 契约**，不伪造客户数据（现有 `EmptyState` 文案保留）。
- `/crm/rules` 把现有 `crm.followup` 配置项独立成页：客户分群规则、跟进间隔、提醒渠道。复用 §2.3 编辑器（同一套 Form/Diff/Impact）。
- 规则字段中，涉及**话术**的部分受 `LOCKED_CONFIG_AREAS` 约束（话术白名单不可配）——编辑器遇到锁定字段灰显 + 🔒。

---

## 5. 通用规范落地

| 维度 | v2 约定 |
| --- | --- |
| StatCard | antd `Statistic` + `precision` 固定；数值变化不加动效（中后台要的是准确，不是吸睛） |
| Table | 行高 44，表头 `--surface-2`；数值右对齐 + `tabular-nums` |
| Modal | 高危走 `DoubleConfirm`；审批 Modal 顶部固定 diff |
| 面包屑 | 顶层=中台名，二级=页面名，三级=配置项 `itemId` |
| 空态 | 复用 `EmptyState`；缺口复用 `DataGapCard`；两者视觉区分（缺口=虚线+中性灰） |
| 响应式 | `<1200px` 侧栏收成 64 图标栏；`<992px` 提示「请使用桌面端」 |
| 深色 | 沿用 console `tokens.css` 深色档，涨跌色换 v2 新值（`#ff8b82` / `#3ddc97`） |

---

## 6. 对比分析（现有方案 vs v2）

| # | 现状 | v2 改进 | 价值 |
| --- | --- | --- | --- |
| 1 | **无 antd 依赖**，`AppShell`/`DataTable`/`StatusBadge` 全自研（`design-system/` 9 个文件） | 迁移到 antd 5（Layout/Menu/Table/Form/Modal/Badge/Statistic） | 自研表格缺虚拟滚动、列固定、键盘导航；antd 直接获得无障碍与大数据量能力，且与设计系统规范对齐 |
| 2 | 5 路由挤在一起，`CompliancePage` 同时塞审计 + 锁定项 | 拆成 4 中台 10 项，审计/AI 标识/锁定项各自独立 | 合规中台三类关注点（追溯/标识/锁定）职责分离，权限可按页授予 |
| 3 | 权限模型分散在 `Actor`/`ConfigLevel`，**无可视化** | 新增 `/admin/permissions` 权限矩阵，agent 终审格固定 🔒 | 「机器无终审权」从代码注释变成界面可验证事实，合规可对外举证 |
| 4 | **无 AI 标识管理视图**（标识由服务端注入，前端无处查看覆盖面） | 新增 `/compliance/ai-labels` 只读清单 + 覆盖率 | 运营能自证「全站 AI 内容都带了标识」，应对监管检查 |
| 5 | 状态机只在 `state-machine.ts` 里，界面靠按钮可用性暗示 | 状态机可视化（§2.1 图）+ `StatusBadge` 7 档色映射 + 迁移门禁表 | 新人/审计一眼看懂生命周期，减少「为什么这个按钮灰了」的沟通成本 |
| 6 | 审计日志**无 agent 行视觉区分**、无结果列、无 URL 化筛选 | agent 行红竖条 + 结果列 + 筛选写 URL + 导出 DoubleConfirm | 机器改动的可追溯性从「能查到」升级为「扫读即见」 |
| 7 | `ConfigEditorPage` 400+ 行单文件，diff/merge/impact 混排 | 左列表（8 栏）+ 右编辑（16 栏）栅格，DiffViewer / ImpactPanel 各占独立 Card | 长表单与影响面同屏，避免「提交了才知道危险」 |
| 8 | CRM 是纯占位，跟进规则藏在通用编辑器里 | `/crm/rules` 独立页 + 名单/记录诚实 P2 占位 | CRM 中台有明确归属页，规则配置不再「藏」在运营编辑器里 |
| 9 | 顶栏 `ActorBadge` 存在但无面包屑 | 面包屑（中台/页面/itemId）+ ActorBadge 常驻 | 深链进入三级页时有位置感；操作者身份始终可见 |
| 10 | token 是本地占位（`--up:#d64545`/`--down:#1f9d55`，未验证对比度） | 统一到 system-v2 §2.1，涨跌/状态色全档 ≥4.5:1 | 中后台免责/AI 标识/风险提示在浅深两色都达标，合规红线可量化验收 |
