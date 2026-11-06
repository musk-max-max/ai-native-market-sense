# 2026-11-06 UI 重构 + 需求文档轮（L132）

## 触发
owner（m07519）决策：原 UI 设计师不用；委托金融 agent + 产品 agent 出 BRD/PRD；UI 全权优化，组件参考 antd。

## 裁定
1. **不新建任何 agent**。UI→A10、PRD→H1、BRD→A20+A21，全部现有席位复用（职责重复裁定见 `docs/roster-division-2026-11-06.md` §二）。临时 subagent 仅跑手，产出归现有席位。
2. **antd 全家桶正式引入**（owner 选定）：`web/h5` 加 antd-mobile、`web/console` 加 antd。跨 A0（评估成本/改 package.json 须 owner 确认）/A10（组件映射+token 方案）/A7（H5 落地）/A8（console 落地）。
3. **唤醒 A10 + H1**（本轮），A20/A21 保持（研究产出已归档），其余静默。

## 交付（5 文件 1382 行，Lead 亲验存在+行数）
- `docs/requirements/brd-c-end.md` 220行 A20+A21：29 功能条/10 P0/合规负面清单 H3-C01..C12
- `docs/requirements/prd-v2.md` 419行 H1：13 页面节/21 组件/3 大 gap（C端未达5tab、AI tab 缺失、console 仍 MockBackend）
- `docs/design/system-v2.md` 226行 A10：设计系统 token/色板/间距/组件规范
- `docs/design/c-end-h5-v2.md` 375行 A10：TabBar+首页四板块+个股页
- `docs/design/console-v2.md` 326行 A10：四中台导航+配置状态机+审计表格

## Lead 复算更正（WCAG）
UI 文档称东财红 `#e63e31`「大字 ≥3:1」——Lead 复算 4.12:1（达标，比原措辞好）。真正擦边是东财绿 `#00a854`=3.12:1（正文不达标，仅大字勉强过）。正文降档 `#00804a`(5.02:1) 处理正确。已转 A10 核对写准。

## 关键 gap（交开发排期，H1 §7）
1. C 端导航未达 5 tab（App.tsx:27-76 仅 3 链接，无 TabBar/`/ai`/`/me`）
2. AI tab 页面缺失，未消费 page-summary（ADR-007 B1-03）+ POST /v1/ai/analyses
3. Console 仍 MockBackend，四中台未连 /v1/internal/*

## Open objectives（承接自全局）
- antd 引入 A0 评估 + A10 映射/token 方案 + A7/A8 落地（本轮主线）
- H1 回填 PRD §8 BRD 映射 + antd 产品影响一节
- MiMo-V2.6-Pro 无 provider 入口（durable/subagent override 均不可用），未使用；UI 跑 deepseek-flash
- C 端 AI 展示卡 AI-1/2/3 H3 未签；AKshare 实时行情未接入（fixture 价格）
