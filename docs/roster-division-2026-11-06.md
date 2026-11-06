# 分工表 · 2026-11-06（UI 重构 + 需求文档轮）

owner 决策（本轮）：原 UI 设计师不用，**不新建 agent**；唤醒现有席位承接，避免职责重复。

## 一、本轮产出与归属（产出归现有席位，不立新门户）

| 产出文件 | 归属席位 | 状态 | 说明 |
|---|---|---|---|
| `docs/requirements/brd-c-end.md` (220行) | **A20 + A21**（金融研究） | 已交付 | 业务需求：29 功能条 / 10 P0 / 合规负面清单 H3-C01..C12 |
| `docs/requirements/prd-v2.md` (419行) | **H1**（PM/PO） | 已交付 | 实现级 PRD：13 页面节 / 21 组件 / 3 大 gap |
| `docs/design/system-v2.md` (226行) | **A10**（UI/UX） | 已交付 | 设计系统：token / 色板 / 间距 / 组件规范 |
| `docs/design/c-end-h5-v2.md` (375行) | **A10** | 已交付 | C 端：TabBar 架构 + 首页四板块 + 个股页 |
| `docs/design/console-v2.md` (326行) | **A10** | 已交付 | 中后台：四中台导航 + 配置状态机 + 审计表格 |

> 本轮 UI/BRD/PRD 由临时 subagent 跑手产出，**产出文件归 A10 / H1 / A20+21 所有**，不新增常驻席位。

## 二、职责重复裁定（为何不新建）

| 候选新建 | 现有编制已有 | 裁定 |
|---|---|---|
| UI 设计师 | A10（UI/UX，owns `design/`+`packages/design-tokens/`） | **不新建**，唤醒 A10 |
| 产品经理 | H1（PM/PO，owns PRD/backlog/验收） | **不新建**，唤醒 H1 |
| 金融研究 | A20（资金面/龙虎榜）+ A21（宏观政策） | **不新建**，研究产出即业务输入 |

## 三、antd 引入（本轮架构决策）

owner 选定：**正式引入 antd 全家桶** — `web/h5` 加 antd-mobile、`web/console` 加 antd。

现状：两 package.json 均无 antd 依赖，现有为自研 design-system（console 9 组件）+ 手写 CSS。

落地分工（antd 是架构级改动，跨 A10/A7/A8）：
- **A0**（架构/契约）：评估 antd 引入成本、版本锁定、与现有 build（Vite7）兼容性，**改动 package.json 前须 owner 确认**
- **A10**（UI）：按 design 文档出 antd 组件映射表 + token 接入方案
- **A7**（H5，owns `web/h5/`）：落地 antd-mobile，重构 6 页面 + 新增 TabBar/`/ai`/`/me`
- **A8**（console，owns `web/console/`）：从自研 AppShell 迁移到 antd Layout，落地四中台

## 四、设计文档一处数值更正（Lead 复算）

UI 交付称东财红 `#e63e31`「大字 ≥3:1 达标」——Lead 用 WCAG 公式复算为 **4.12:1**（达标，且比原文措辞更好）。
真正擦边的是东财绿 `#00a854` = **3.12:1**（正文不达标，仅大字勉强过）。正文色降档到 `#00804a`(5.02:1) 的处理正确。

## 五、唤醒状态

- **A10**：唤醒 → 接手 antd 组件映射 + token 落地
- **H1**：唤醒 → 回填 PRD §8 BRD 章节映射 + PRD/BRD 一致性对齐
- **A20/A21**：保持现状（研究产出已完成，BRD 归档）
- 其余席位：静默（不涉及本轮范围）