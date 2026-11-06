# antd 组件映射表（antd-component-mapping）

> 归属：A10（UI/UX）｜状态：v1（待 A0 评估依赖、owner 确认后由 A7/A8 落地）
> 输入文档：`docs/design/system-v2.md`、`docs/design/c-end-h5-v2.md`、`docs/design/console-v2.md`
> 版本基线（2026-11）：**antd 5.29.x**（中后台）、**antd-mobile 5.43.x**（C 端）、React 19.3。
> 本文只做**组件映射与接入规范**，不改 `package.json`、不写业务实现（A7/A8 写域）。

---

## 0. 先读这三条（决定后面所有映射）

1. **antd-mobile 没有设计 token 主题 API。** 5.43 的 `ConfigProvider` 只接受 locale 与图标插槽（`ConfigProviderProps = Partial<Config>`，`Config` 里只有 locale / checkList / list / searchBar 等图标项），**没有 `theme` 属性**。C 端的主题只能靠 CSS 变量（`--adm-*`）覆盖，见 `design/token-integration.md`。这与 antd 5 的 `ConfigProvider theme={{token,components,algorithm}}` 完全不同——两端不能用同一段 Provider 代码。
2. **antd 的语义色与行情色语义冲突，不能混用。** antd `colorError`（红）表示"操作失败"，我们的 `--up`（红）表示"涨"。把 `colorError` 映射成 `--up` 会让"接口出错"和"股票上涨"同色。规则：**涨跌色只走 `--ms-up/--ms-down`；antd `colorError` 映射 `--ms-danger`（危险/失败）**。
3. **合规契约组件不迁移。** `AiGeneratedBadge` / `DisclaimerNotice` / `DataGapCard` / `EntitlementNotice` 承载"文案来自服务端、无关闭路径、受控原因枚举、403 零数值"等契约，antd 组件没有这些能力；它们保留自研外壳，内部允许用 antd 原子组件拼装。见 §2。

---

## 1. 映射总表

类型图例：`antd-mobile` = 直接使用 C 端组件库；`antd` = 直接使用中后台组件库；`自研保留` = 保留现有组件，仅内部换 antd 原子件；`基础设施` = 非组件级接入（主题/国际化/图标/深色）；`组合` = antd 容器 + 自研内容。

### 1.1 跨端基础设施

| # | 出处 | 场景 | 映射（组件 / 关键 props） | 类型 | 现有实现 → 动作 | 合规 / 风险备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | system-v2 §2–§4 | 主题注入（中后台） | `<ConfigProvider theme={{ token, components, algorithm, cssVar }} locale={zhCN}>` | 基础设施 | 无 → A8 在 console 根节点包一层 | 静态方法（`message.xxx`/`Modal.xxx`）拿不到 theme，必须改用 `App.useApp()`（见 #58） |
| 2 | system-v2 §2 | 主题注入（C 端） | `:root` 覆盖 `--adm-*` CSS 变量；`html[data-prefers-color-scheme="dark"]` 覆盖深色 | 基础设施 | 现有 `tokens.css` 临时变量 → 换成生成文件 | antd-mobile 无 theme API（§0.1）；`data-prefers-color-scheme` 是它内建的深色开关 |
| 3 | 两文档 | 图标 | `antd-mobile-icons`（C 端 TabBar/NavBar）、`@ant-design/icons`（中后台） | 基础设施 | 现在无图标依赖 → A0 评估新增两个包 | TabBar 的 `icon` 需要真实图标组件；不要用 emoji/方向箭头 |
| 4 | system-v2 §6 | 深色模式 | C 端 `data-prefers-color-scheme`；中后台 `theme.darkAlgorithm` + `components` 覆盖 | 基础设施 | 现有 `prefers-color-scheme` 只作用自研 CSS | 深色涨跌色已单独调亮（§2.1），验收按对比度断言，不要求 antd algorithm 与色板逐值相等 |
| 5 | console-v2 §1.1 | 国际化 | `ConfigProvider locale={zhCN}`（`antd/locale/zh_CN`） | 基础设施 | 现文案全硬编码中文 → 仅接 locale，不做 i18n 迁移 | 与 `lib/copy.ts` 单一文案源不冲突：copy 管业务文案，locale 管 antd 内建文案 |

### 1.2 C 端 H5（antd-mobile）

| # | 出处 | 场景 | 映射（组件 / 关键 props） | 类型 | 现有实现 → 动作 | 合规 / 风险备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | c-end §2.1 | 页面骨架（吸顶 header + main + footer + TabBar） | 自研 `.app-shell` + `<NavBar>` + `<TabBar>`；**antd-mobile 无 Layout 组件** | 组合 | `App.tsx` 现在只有 NavBar + 链接 → A7 重构骨架 | TabBar 官方 FAQ 明确"不含定位/外层布局"，`position:fixed` 必须自己写 |
| 7 | c-end §1.1 | 底部 TabBar 5 项 | `<TabBar activeKey onChange safeArea>` + `<TabBar.Item key title icon badge>` | antd-mobile | 无 → 新增 | 图标取 `antd-mobile-icons`；不动效、不弹跳 |
| 8 | c-end §2.1 | 顶部导航 / 返回 | `<NavBar back onBack right>`（`back={null}` 隐藏返回区；`backIcon` 只换图标） | antd-mobile | `App.tsx` 手写 header → 换 NavBar | ⚠️ 文档示例用的 `backArrow` 在 5.43 **已废弃**；返回区显隐由 `back` 控制，`backIcon` 只管图标 |
| 9 | c-end §2.1 | 首页搜索 | `<SearchBar placeholder onFocus onSearch clearable />` | antd-mobile | HomePage 自研 form | 透传 `aria-label`（支持 `React.AriaAttributes`）；搜索页跳转用 `onFocus` |
| 10 | c-end §2.2 | 指数横滑容器 | **自研 `.scroll-row`**：`overflow-x:auto; scroll-snap-type:x mandatory` | 自研保留 | 现有 `.index-row` | ⚠️ 文档里的 `ScrollRow` **在 antd-mobile 5.43 不存在**（`es/index.d.ts` 无此导出），必须删掉该 import |
| 11 | c-end §2.2 | 指数卡 | `<Card title extra onClick bodyStyle headerStyle>` | antd-mobile | 现有 `.card` 自研 | ⚠️ Card **没有 `block` 属性**（文档示例误用）；圆角走 `style.borderRadius` 或 `--adm-card-border-radius` |
| 12 | system-v2 §5.5 | 涨跌胶囊（无箭头） | `<Tag fill="solid" style={{'--background-color':'var(--ms-up-weak)','--text-color':'var(--ms-up-weak-text)'}}>` | antd-mobile | 现有 `.chg-pill` | Tag 支持 `--background-color/--text-color` 自定义变量；**禁用箭头 icon**，方向只由正负号表达 |
| 13 | c-end §2.3 | 成交额榜单 | `<List>` + `<List.Item children prefix extra clickable arrowIcon={false}>` | antd-mobile | 无 | **`arrowIcon={false}` 是合规项**：antd-mobile 列表默认右侧箭头是方向符号，榜单必须关掉 |
| 14 | c-end §2.3 | 榜单页脚注（ST 排除计数 + as_of） | 自研 `.card__note`（普通段落，不折叠） | 自研保留 | 现有 `card__note` | 计数与 as_of 必须同屏可见，不能进 Tooltip/二级页 |
| 15 | c-end §3.2 | 资讯流上滑加载 | `<InfiniteScroll loadMore hasMore threshold>`（`loadMore` 返回 `Promise<void>`） | antd-mobile | 无 | 失败态给重试，不无限转圈；底部 24px 灰条 |
| 16 | c-end §3.1 | 下拉刷新 | `<PullToRefresh onRefresh>`（必须返回 Promise） | antd-mobile | 无 | **硬约束**：刷新完成必须更新 `as_of`，不能只换数值不换时间戳 |
| 17 | c-end §1.3 A | 个股行情卡 | `<Card title extra={as_of}>` + 自研 `QuoteBlock`（价格/涨跌/meta dl/stale 标记） | 组合 | 现有 `QuoteBlock` 是纯自研 `<section class="card">` | as_of 放 `Card.extra`（system-v2 §5.2 允许的唯一右侧元素之一）；`source` 与 `as_of` 结构不得删 |
| 18 | c-end §1.3 A | 分时段控（分时/五日/日K/周K/月K） | `<Segmented options block value onChange>`（5 段等宽） | antd-mobile | 无 | 备选 `CapsuleTabs`；段控只切数据窗口，不改变 as_of 语义 |
| 19 | c-end §2.4 | 自选按钮 | `<Button size="mini" fill color aria-pressed>` + `Toast.show` | antd-mobile | 现有 `WatchlistToggle`（aria-pressed/aria-live/匿名不发请求） | 保留 `WatchlistToggle` 的状态机与 testid，只把视觉换成 Button；`aria-pressed` 必须透传 |
| 20 | c-end §2.4 | 操作反馈 | `Toast.show({ content, duration })` | antd-mobile | 现有 inline `aria-live` 状态 | 不加 success 图标动效；Toast 不替代 inline 可访问状态（两者都要） |
| 21 | system-v2 §5.6 | Loading 骨架 | `<Skeleton animated rows>`（或自研 `LoadingBlock`） | antd-mobile | 现有 `LoadingBlock`（带 testId） | **个股页首屏 6 元素区禁止骨架**（A12 契约）；其他区块可用 |
| 22 | system-v2 §5.6 | 空自选 | `<Empty description>` + `<Button>` CTA | antd-mobile | 现有 `EmptyBlock`（文案走 copy） | 空态文案必须来自 `lib/copy.ts`；如 antd Empty 的插图偏"营销感"，保留自研 EmptyBlock |
| 23 | c-end §1.3 B | 基本面摘要 | `<Card>` + 自研 `dl` 两列指标网格 | 组合 | 现有 `FundamentalSummary` | 8 个指标用 `<dl>` 更适合读屏；antd-mobile `Grid` 是图标宫格，不适用 |
| 24 | c-end §1.3 C | AI 分析五段 | `<Card>` + 自研 `AiInterpretation`（五段 + `AiTextSlot` 占位） | 组合 | 现有 `AiInterpretation` | 五段标题与"本节数字来自财报字段"说明不可折叠 |
| 25 | 合规红线 | 免责声明 | 自研 `DisclaimerNotice` / `DisclaimerUnavailable`（文案原样来自 API） | 自研保留 | 已实现 | **不得**换成 antd `Collapse`/`NoticeBar`（NoticeBar 自带关闭 ×） |
| 26 | 合规红线 | AI 标识 | 自研 `AiGeneratedBadge`（label + disclaimer 必填、无关闭、无折叠、无透明度） | 自研保留 | 已实现 | 视觉可对齐 system-v2 §5.5（方形 AI 标 + text-muted 文字），但组件契约不能换成 antd `Tag` |
| 27 | 合规红线 | 数据缺口 | 自研 `DataGapCard`（受控 gapKey/reason 枚举 + 虚线中性卡） | 自研保留 | 已实现 | 原因枚举受控（pending_batch/permission/upstream_missing/not_integrated/no_coverage） |
| 28 | 合规红线 | 权限受限（403） | 自研 `EntitlementNotice`（原样 Problem title/detail、零数值、无重试） | 自研保留 | 已实现 | antd `ErrorBlock` 会诱导"重试/返回"，不符 |
| 29 | system-v2 §5.6 | 请求错误 | 自研 `ErrorState`/`ErrorBlock`（按 HTTP status 映射、403 不给重试） | 自研保留 | 已实现 | 只换视觉（图标/间距），不改"403 无重试"规则 |
| 30 | c-end §2.1 | 底部安全区 | `<SafeArea position="bottom">` | antd-mobile | CSS `env(safe-area-inset-bottom)` | TabBar 用 `safeArea` 时不要重复叠加 SafeArea 高度 |
| 31 | c-end §1.3 注 | 分时/K 线图 | **不在 antd 范围**：图表库待 A0 选型（轻量、可水印 as_of） | 基础设施 | 无 | 图内禁止支撑/压力线、买卖点箭头、金叉标注；水印 as_of 固定在图内 |
| 32 | system-v2 §5.5 | 图内 as_of 水印（可选） | `<WaterMark content={as_of} fullPage={false}>`（antd-mobile 5.43 提供） | antd-mobile | 无 | 仅当图表库不支持内绘水印时使用；水印不得低对比（≥3:1 非文本对比） |
| 33 | c-end §1.4 | 财报/行情双 as_of 提示 | 自研 `card__hint`（纯文本） | 自研保留 | 已实现 | 两个时点必须分开渲染，不能合并成一个"更新时间" |

### 1.3 中后台（antd 5）

| # | 出处 | 场景 | 映射（组件 / 关键 props） | 类型 | 现有实现 → 动作 | 合规 / 风险备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 34 | console §1.1 | 四中台骨架 | `<Layout><Sider width={232} theme="light"><Menu/></Sider><Layout><Header/><Content/></Layout></Layout>` | antd | 自研 `AppShell`（nav groups/badge/actor/footnote） | 迁移后必须保留 `AppShellProps` 的 actor、脚注文案、badge 契约（E2E 依赖） |
| 35 | console §1.3 | 侧栏菜单 | `<Menu mode="inline" items selectedKeys defaultOpenKeys onClick>` | antd | 自研 nav 列表 | `items` 支持 `children` 分组；选中态色走 `components.Menu.itemSelectedBg/itemSelectedColor` |
| 36 | console §1.3 | 审批待办角标 | `<Badge count={pending} size="small">`（挂在 Menu label 内） | antd | `AppShellProps.nav[].badge` | 角标只做提示，不进 menu 文案（避免"待办"诱导） |
| 37 | console §1.1 | 顶栏面包屑 | `<Breadcrumb items={[{title},{title},{title}]}>` | antd | 无 | 三级 = 中台 / 页面 / `itemId`，深链有位置感 |
| 38 | console §1.1 | 操作者常驻标识 | 自研 `ActorBadge`（human/agent + modelVersion/runId + title） | 自研保留 | 已实现 | 操作者身份是审计上下文，**不可**只在表格行出现；迁移后仍常驻 Header 右侧 |
| 39 | console §1.1 | 指标卡 | `<Card>` + `<Statistic title value precision valueStyle>` + `<Col span={6}>` | 组合 | 无（现有 overview 用自研） | 数值变化不加动效（console §5） |
| 40 | console §1.1 / §2.3 | 24 栏栅格 | `<Row gutter={16}><Col span={8|16|6}>` | antd | CSS grid 手写 | gutter 16、编辑器左 8 右 16、四卡各 6 |
| 41 | console §2.3 | 配置项列表（左栏） | `<Table size="middle" columns rowKey onRow selectedKey 视觉}>` | antd | 自研 `DataTable` | 锁定项不出现在列表（只留"N 项锁定"说明行） |
| 42 | console §2.3 | 编辑器表单 | `<Form layout="vertical" form initialValues onFinish>` + `<Form.Item name label rules>` | antd | 自研 `FormField`（kind: boolean/enum/number/string-list/text） | 自研 FormField 可保留为包装层（统一 kind → 控件映射 + issues 校验），内部控件换 antd |
| 43 | console §2.3 | 字段控件 | `<InputNumber>` / `<Input>` / `<Select>` / `<Switch>` / `<TextArea>` | antd | 自研 FormField 内部 | 数值字段 `precision` 固定；`tabular-nums` |
| 44 | console §2.3 | 合规锁定字段 | `<Input disabled>` + `<Tooltip title="合规锁定">` + `<LockOutlined>` | 组合 | 自研灰显 | 锁定字段**只读且无入口**（H6 硬约束），不要做成"申请解锁"按钮 |
| 45 | console §2.3 | 变更预览 | 自研 `DiffViewer`（两点/三点合并、409 冲突、acknowledged 门禁） | 自研保留 | 已实现 | antd 无 diff 组件；审批 Modal 顶部**固定渲染**，不折叠 |
| 46 | console §2.3 | 影响面 | 自研 `ImpactPanel`（severity 列表 + dangerDescription） | 自研保留 | 已实现 | 危险变更时"提交审批"升 `ghost-danger` 并强制 DoubleConfirm |
| 47 | console §2.2 | 高危确认 | `<Modal open title onOk onCancel confirmLoading maskClosable={false}>` + 自研 `DoubleConfirm` 内容（勾选影响面 + 输入 dangerConfirmWord） | 组合 | 已实现（自研 dialog） | 两步不可合并；`maskClosable=false` 防误关；标题用 `--ms-danger-text` |
| 48 | console §3.1 | 审计日志表 | `<Table columns dataSource rowKey pagination={{pageSize:20,showSizeChanger:false}} sticky rowClassName ellipsis>` | antd | 自研 `DataTable`（原生 table） | 行高 44；agent 行 `rowClassName="row--agent"` → CSS 2px `--ms-brand-emphasis` 左边条；只读 |
| 49 | console §3.1 | 动作标签 | `<Tag color={...}>`（`AuditActionTag` 内部映射 `ACTION_LABEL`） | antd | 自研 | 颜色只取 system-v2 §2.4 状态色，白字不压浅底 |
| 50 | console §2.1 | 配置状态标签 | 自研 `StatusBadge`（7 态→`default/processing/warning/success/success/error/error`） | 自研保留 | 已实现 | 内部可用 `<Badge status>` 或 `<Tag>`；对外 props/testid 不变 |
| 51 | console §2.3 | 风险等级标签 | 自研 `LevelBadge`（L0–L3 灰→warning→danger 阶梯） | 自研保留 | 已实现 | 等级色不得用于"机会/推荐"语义 |
| 52 | console §4.1/§4.2 | 空态 / 锁定项表 | 自研 `EmptyState`（或 `<Empty>`）+ `<Table>` + `<Tag icon={<LockOutlined/>}>` | 组合 | 已实现 | 锁定项行底 `--ms-warning-bg`，**不渲染编辑按钮/表单/跳转** |
| 53 | console §3.3 | 审计筛选条 | `<Form layout="inline">` + `<Select mode="multiple">` / `<DatePicker.RangePicker>` | antd | 无 | 筛选条件写 URL query（可分享审计链接） |
| 54 | console §3.3 | 导出 CSV 确认 | `<Modal>` + 自研 `DoubleConfirm` | 组合 | 已实现 | 导出属敏感操作，需记录审计 |
| 55 | console §4.3 | 权限矩阵 | `<Table>` + 自定义 `render`（✓ / — / 🔒） | 组合 | 无 | agent 行"审批通过"格固定 🔒，悬浮说明"机器无终审权"（C1=A），不可编辑 |
| 56 | console §2.3 | 提交/校验/回滚按钮组 | `<Button type="primary">`（唯一主操作）/ `<Button>` / `<Button danger ghost>` | antd | 自研 button | 每屏唯一 primary；回滚必须 `ghost-danger` + DoubleConfirm；禁用涨跌色做按钮底 |
| 57 | console §2.1 | 状态机图 | 自研（SVG / CSS 流程）或 `<Steps>` 变体 | 自研保留 | `domain/state-machine.ts` | 前端不得渲染绕过 `assertTransition` 的按钮（组件层只是展示） |
| 58 | antd 限制 | 全局消息提示 | `App.useApp()` → `message` / `notification` / `modal` | 基础设施 | 无 | 静态 `message.xxx` 拿不到 ConfigProvider 的 theme 与 locale（antd 官方 warning），必须用 `App` 上下文 |
| 59 | console §3.1 | 分页 | `<Table pagination={{ pageSize: 20, showSizeChanger: false }}>` | antd | 自研分页 | 固定 20，避免审计导出口径漂移 |

**统计**：59 条映射 —— 跨端基础设施 5 条（#1–5）、C 端 antd-mobile 28 条（#6–33）、中后台 antd 26 条（#34–59）。按类型列可直接 `grep -c '| antd-mobile |'` / `grep -c '| 自研保留 |'` 复核。

---

## 1.4 每组件对应的 token 组（消费映射表）

Token 单源见 `packages/design-tokens/tokens.json`；下表给出每条映射消费的 `--ms-*` 分组与生成产物。生成物三条路径：**antd 吃对象**（`dist/antd-theme.mjs`）/**antd-mobile 吃 `--adm-*`**（`dist/adm-tokens.css`）/**自研吃 `--ms-*`**（`dist/tokens.css`）。

| token 组 | `--ms-*` 语义 | antd 5（中后台） | antd-mobile 5.43（C 端） | 对应映射 # |
| --- | --- | --- | --- | --- |
| 品牌色 | `--ms-brand / -strong / -weak / -emphasis` | `colorPrimary / colorLink / colorInfo` + `Menu.itemSelectedBg` + `Progress` | `--adm-color-primary` | #1 #2 #7 #35 #48 #56 #58 |
| 功能色 | `--ms-danger / -warning / -success / -info`（含 `-bg/-text`） | `colorError / colorWarning / colorSuccess` + `Button danger` + `Alert` + `Tag color` | `--adm-color-danger / -success / -warning` | #47 #49 #50 #51 #52 #56 |
| **行情色（独立，禁混 antd 功能色）** | `--ms-up / -down / -flat` + `-weak / -weak-text` + `-strong` | **不映射进 antd theme**（`colorError`≠涨色，§0.2）；行情组件直接吃 CSS 变量 | 胶囊 `<Tag style={{'--background-color','--text-color'}}>`（仅 `-weak` 底 + `-weak-text` 文字） | #12 #17 #18 #23 |
| 中性面 | `--ms-surface / -surface-2 / -bg / -text / -text-muted / -border / -border-strong` | `colorBgLayout / colorBgContainer / colorText(Base) / colorTextSecondary / colorBorder` | `--adm-color-background / -box / -text / -text-secondary / -border` | #11 #17 #23 #24 #34 #35 #39 #41 #48 |
| 圆角 | `--ms-radius-sm/-md/-lg` | `borderRadius / borderRadiusLG / borderRadiusSM` | `--adm-radius-s/-m/-l` + `--adm-card-border-radius` | #11 #39 #40 #47 #48 |
| 间距 | `--ms-space-1..6` | `Layout` 内容 padding、`Row gutter=16`、`Card` bodyStyle | `Card/List/NavBar` bodyStyle/headerStyle padding | #6 #11 #39 #40 #48 |
| 字号/字体 | `--ms-font-sans / -numeric` + `--ms-font-caption..title-lg` | `fontSize / fontSizeHeading*`（console 下限 12px） | `--adm-font-family / -font-size-main`（H5 下限 13px） | #9 #17 #23 #39 #41 #48 |
| 控件态 | `--ms-border-control / -focus / -disabled-bg / -disabled-text` | `components.Input/Select/DatePicker/InputNumber.colorBorder`（覆盖 antd 默认 #d9d9d9 1.37:1→3.15:1） | `Input/SearchBar/Segmented/Switch` 自定义 CSS | #9 #18 #19 #42 #43 #44 #53 |
| 表格/列表 | `--ms-table-header-bg / -row-hover / -border-row` | `components.Table.headerBg / rowHoverBg` | `List` item 自定义 CSS | #41 #48 #59 |
| 浮层/遮罩 | `--ms-mask / -shadow` | `Modal` + `components.Modal.contentBg` | `Modal/Toast` 深色跟随 | #20 #47 #54 |
| **合规（不可折叠/关闭/透明）** | `--ms-ai-badge-bg / -text` + `--ms-danger-bg` + `--ms-text-muted`（as_of） | console 免责区（下限 12px） | H5 免责/AI 标识/as_of（下限 13px） | #14 #24 #25 #26 #27 #28 #29 #33 |
| 深色 | 同名深色档 | `theme.darkAlgorithm` + 显式 token 覆盖 | `html[data-prefers-color-scheme="dark"]` | #4 |

> 关键约束（详见 `design/token-integration.md`）：①行情色**永不**进 antd `colorError`；②涨跌胶囊文字只走 `--ms-up-weak-text/-down-weak-text`（4.79/4.89:1），禁 `--ms-up/-down` 压彩底（4.25/4.48 不达标）；③合规 token 无 opacity、无关闭路径，文案与放行待 H3 签发。

---

## 1.5 C 端（antd-mobile）与中后台（antd）token 差异

| 维度 | C 端 antd-mobile 5.43 | 中后台 antd 5 | token 层动作 |
| --- | --- | --- | --- |
| 主题 API | **无 `theme` 属性**（`ConfigProviderProps=Partial<Config>` 仅 locale/图标插槽），只能 CSS 变量 | `<ConfigProvider theme={{token,components,algorithm,cssVar}}>` | C 端覆盖 `--adm-*`；中后台注入 `dist/antd-theme.mjs` 对象 |
| 主题入口 | `:root` 覆盖 `--adm-*`，深色 `html[data-prefers-color-scheme="dark"]` | `theme.darkAlgorithm` + 显式深色 token 覆盖 | 两份产物 `adm-tokens.css` / `antd-theme.mjs` |
| 主题覆盖范围 | 仅全局变量（`--adm-color-*` / `--adm-radius-*` / `--adm-font-*`） | 全局 seed + 组件级 `components.Table/Menu/Input` 算法 | 中后台细粒度更高 |
| Layout | **无 Layout 组件**（TabBar 不含定位） | `Layout/Sider/Header/Content` | 骨架仍自研（#6），只换原子件 |
| 深色色差 | 涨跌色单独调亮（`--ms-up #ff8b82 / -down #4ade80`） | 深色由 algorithm 派生 + `border-control` 显式 `darkOverride #a3abb5` | 深色验收只看对比度断言（≥4.5:1），不要求与浅色逐值相等 |
| 行情色映射 | 直接消费 `--ms-up/-down` CSS 变量 | **不进 `colorError`**，行情组件吃 CSS 变量 | 避免接口错误与股票上涨同色（§0.2） |
| 输入框边界 | 无算法补偿，必须显式覆盖 | 默认 `#d9d9d9`(1.37:1) 不达标，`components.*.colorBorder` 已注入 3.15:1 | 两端都用 `--ms-border-control` |
| 字号下限 | H5 **13px** | console **12px** | `--ms-font-caption` 分端取值，免责/AI 标识/as_of 强制 |
| 静态方法 | `Toast.show`（无 theme 依赖问题） | 静态 `message/Modal.confirm` 拿不到 theme → `App.useApp()`（#58） | 中后台必须 `App` 包裹 |

> 一句话：**同一 `tokens.json` 真值，两条渲染路径**。C 端纯 CSS 变量、无算法、深色靠 `data-prefers-color-scheme`；中后台有算法、组件级覆盖、深色靠 `darkAlgorithm`。两端**不能共用同一段 Provider 代码**。

---

## 2. 自研保留组件清单（11 个，不可被 antd 组件整体替换）

| 组件 | 保留理由（契约，不是审美） | 迁移范围 |
| --- | --- | --- |
| `AiGeneratedBadge` | label + disclaimer 必填、无关闭/折叠/透明度；文案来自服务端 | 仅换内部视觉 |
| `DisclaimerNotice` / `DisclaimerUnavailable` | 文案原样渲染、不折叠不关闭；缺失时显式说明缺失 | 不动结构 |
| `DataGapCard` | 受控 gapKey/reason 枚举 + testid（`data-gap-code`/`data-gap-reason`） | 内部换 Tag/虚线样式 |
| `EntitlementNotice` | 403 原样 Problem 文案、零数值、无重试 | 不动结构 |
| `ErrorState` / `ErrorBlock` | 按 HTTP status 映射、403 不给重试、role=alert | 只换图标/间距 |
| `WatchlistToggle` | aria-pressed 双态、inline aria-live、匿名不发请求 | 视觉换 Button |
| `ActorBadge` | human/agent 可区分 + modelVersion/runId，审计上下文 | 内部换 Avatar/Tag |
| `StatusBadge` / `LevelBadge` | 状态机 7 态/风险 4 级的唯一映射源 | 内部换 Badge/Tag |
| `DiffViewer` / `ImpactPanel` / `DoubleConfirm` | 审批门禁（勾选+危险词）、diff 固定渲染、影响面 | 内部换 Modal/排版 |
| `EmptyState` | 文案走 `lib/copy.ts`，避免 antd 默认插图语气 | 可换 antd Empty + 自定义 image |
| `AiInterpretation` / `AiTextSlot` | 五段结构与占位语义（待接入 ≠ 空） | 容器换 Card |
| `AppShell`（console） | nav groups + actor + 脚注 + badge 的 E2E 契约 | 外壳换 Layout |

> 原则：**组件名、props、data-testid 不变**，只换内部实现。E2E 是合规验收的一部分（AI 标识覆盖率、as_of 可见性都靠 testid 断言），迁移不能顺手改 testid。

---

## 3. 文档勘误（三份设计文档 → 实现前必须修正）

| 文档位置 | 错误 | 事实（已核对 5.43 源码） | 修正 |
| --- | --- | --- | --- |
| c-end-h5-v2 §2.2 | `import { Card, ScrollRow } from 'antd-mobile'` | `es/index.d.ts` 无 `ScrollRow` 导出（横滑容器从来不是 antd-mobile 组件） | 删 import，改自研 `.scroll-row`（overflow-x + scroll-snap） |
| c-end-h5-v2 §2.2 | `<Card ... block>` | `CardProps` 无 `block`；只有 `title/extra/icon/headerStyle/bodyStyle/bodyClassName/onClick/onHeaderClick/onBodyClick` | 删 `block`；圆角用 `style.borderRadius` 或 `--adm-card-border-radius` |
| c-end-h5-v2 §2.1 | `<NavBar backArrow>` | `backArrow` 已标记 `@deprecated`；且 `back` 默认渲染返回区、`back={null}` 隐藏 | 改 `back={isStockPage ? undefined : null}`；`backIcon` 只换图标 |
| c-end-h5-v2 §2.1 | 代码片段中 TabBar 直接作为页面底部固定栏 | TabBar 官方 FAQ：**不含定位与外层布局** | 补 `.app-tabbar { position: fixed; bottom: 0; }` + main 预留 padding-bottom |
| c-end-h5-v2 §2.3 | 榜单 `<List.Item>` 默认带右侧箭头 | 箭头是方向符号，违反"禁方向箭头" | 显式 `arrowIcon={false}` |
| system-v2 §2.1 | 绿 `--down` 对 `--down-weak` 未列 4.48:1 | 复算 4.48:1（<4.5） | 彩底文字只能用 `--ms-down-weak-text`（4.89:1） |

> 前三处已由 A10 顺手修正到文档（见 git diff）；后三处是本轮新增规范，A7 落地前按上表执行。

---

## 4. 未映射 / 缺口清单

| 项 | 现状 | 归属 / 下一步 |
| --- | --- | --- |
| 分时 / K 线图 | 无图表库，antd 不提供 | A0 选型（轻量、可内绘 as_of 水印、可禁技术分析标注），A10 给视觉规格 |
| 虚拟滚动（大列表） | antd Table 支持虚拟滚动（`virtual`），antd-mobile List 不支持（官方建议 react-virtualized） | 资讯流若超 500 条，A0/A7 评估；首版按分页/InfiniteScroll |
| 拖拽排序 | antd-mobile List 不支持（官方建议 react-beautiful-dnd） | 首版不做 |
| 富文本 / 免责全文展开 | 现为纯文本段落 | 不引入富文本；展开只在详情页，摘要不折叠 |
| 图表内 Tooltip 的 as_of | 图表库能力 | 随图表选型定；不可只在图例里写 as_of |

---

## 5. 依赖评估移交 A0（A10 不改 package.json）

| 包 | 版本建议 | 用途 | 风险 / 需要 A0 评估的点 |
| --- | --- | --- | --- |
| `antd` | `^5.29.3`（锁 5.x，不上 6） | 中后台 | 体积（官方 size-limit 全量 dist ≈510 KiB gzip）；ESM tree-shaking 后实测；与 React 19 的兼容补丁 |
| `@ant-design/v5-patch-for-react-19` | `^1.0.2` | antd 5 在 React 19 下运行 | React 19 移除了 `ReactDOM.render`，antd 静态方法需此补丁；不装会在 `message/Modal.confirm` 路径报错 |
| `@ant-design/icons` | `^5.6` | 中后台图标 | antd 已作为依赖引入，是否显式声明由 A0 定 |
| `antd-mobile` | `^5.43.0` | C 端 | 体积；CSS 变量全局覆盖的副作用范围 |
| `antd-mobile-icons` | `^0.3.x` | C 端图标（TabBar/NavBar） | antd-mobile **不内置**图标包 |
| 图表库 | 待选型 | 分时/K 线 | 体积、canvas 水印能力、无障碍（图表需文字替代） |

> 引入前 A0 需回：包体积、构建影响、是否用 unplugin 按需引入、锁版本策略；改 `package.json` 须 owner 确认（decisions-2026-11-06-ui-round）。

---

## 6. 首屏 JS 体积预算结论（硬约束，不可上调）

**上限：C 端首屏 JS ≤ 200KB gzip**（门禁脚本 `web/h5/scripts/check-budget.mjs`，H1 veto）。规则：**超了砍组件，不上调上限。**

### 6.1 各依赖对预算的影响

| 包 | 影响面 | 结论 |
| --- | --- | --- |
| `design-tokens`（本包产物） | **不占 JS 预算**：`tokens.css` ≈5.6KB / `adm-tokens.css` ≈1.6KB raw，纯 CSS，gzip 后 ≈1–2KB | 零成本，可直接引入 |
| `antd` 全量 dist | ≈510 KiB gzip | **禁止进 C 端**；仅中后台，且 A6 需按需引入 / unplugin |
| `antd-mobile` | 按需引入，十几–几十 KiB gzip | **计入 C 端 200KB 池**；首屏只 import 首页实际用到的组件 |
| `antd-mobile-icons` / `@ant-design/icons` | 个位 KiB | 图标必须真实组件，禁 emoji/方向箭头（§1 #3） |
| `@ant-design/v5-patch-for-react-19` | 极小 | React 19 + antd 静态方法必需 |
| 图表库（分时/K 线） | **待选型** | 选型前必须报 gzip 体积，计入同一 200KB 池（A0 + 图表 owner） |

### 6.2 落地约束（A6/A7 执行，M1 只定结论）

1. **C 端按需引入 antd-mobile**：首屏仅 import 首页用到的（`TabBar`/`NavBar`/`SearchBar`/`Card`/`List`/`Tag`/`Button`/`Segmented`/`Skeleton`/`Empty`/`PullToRefresh`/`InfiniteScroll`）；`Table`/`Form` 等只在二级页用。禁 `import { Card } from 'antd-mobile'` 全量入口以外的无差别导入。
2. **中后台不进 H5 预算**，但仍需 unplugin 按需 + tree-shaking，避免构建产物膨胀影响构建时间。
3. **图表库选型前置**：分时/K 线在 antd 生态无官方组件，选型必须先报体积再引入（#31）。
4. **门禁执行**：A6 引入依赖后跑 `node web/h5/scripts/check-budget.mjs` 记录实测值；**阈值 200KB 不可上调**（硬红线 ⑥）。

### 6.3 当前实测（M1 只记录，不改阈值）

```bash
node web/h5/scripts/check-budget.mjs
# 2026-11-06 实测（antd/antd-mobile 尚未安装）：
#   vendor-react 67.1 + index 14.1 + vendor 2.6 = 83.7 KB gzip
#   合计 273.6 KB raw / 83.7 KB gzip（预算 200 KB）→ PASS，剩余 116.3 KB
```

**现状**：`antd`/`antd-mobile` 未安装（`web/h5/package.json` deps 仅 `react`/`react-dom`/`@market-sense/api-client`），上表为**未含新依赖的基线**。剩余 116.3KB gzip 池即将被 antd-mobile（按需十几–几十 KB）+ 图表库吃掉，余量偏紧。**阈值 200KB 不可上调**（硬红线 ⑥）；引入后由 A6 重跑记录，超了砍组件。design-tokens 本体为纯 CSS（≈1–2KB gzip），**不占此 JS 预算**。

---

## 7. 验收清单（A7/A8 交付时勾）

1. `grep -r "from 'antd-mobile'" web/h5/src` 中不含 `ScrollRow`；`grep -r "block"` 无 `Card block`。
2. 所有 `data-testid` 与迁移前**逐字一致**（`lib/testids.ts` 为唯一来源）。
3. 免责 / AI 标识 / as_of 三处：无关闭按钮、无折叠容器、无 `opacity<1`、字号 ≥13px（H5）/12px（中后台）。
4. 涨跌胶囊无箭头 icon；列表项无默认箭头（榜单 `arrowIcon={false}`）。
5. 深色模式下免责与 as_of 对比度 ≥4.5:1（用 token 断言脚本跑，见 token-integration.md §7）。
6. 中后台每个页面唯一 `type="primary"` 按钮；回滚按钮为 `ghost-danger` 且走 DoubleConfirm。
7. 审批 Modal 顶部 diff 固定渲染，无"查看详情"折叠。
8. 审计表 agent 行左边条可见（2px `--ms-brand-emphasis`）、分页固定 20、无批量通过入口。
