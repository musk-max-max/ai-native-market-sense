# agent 席位重建 handoff

本目录存放 durable teammate 删除重建时的历史上下文快照。模型切换（deepseek-flash → sensenova-6.8-flash）需要删旧建新，历史上下文不能丢，所以落盘成文件，重建时作为第一次会话发过去。

## 约定

- 文件名 `<id>-handoff.md`，例 `A6-handoff.md`
- 内容 = 该席位入场必须知道的：身份、写域、已发生的相关裁定、当前待办、硬边界
- 权威真源永远是 `agents/roster.yaml`（席位定义）+ `agents/decisions.md`（L1..Lnn 裁定）+ `docs/adr/`（架构决策），handoff 只是加速入场，不替代真源
- 席位定义在 `agents/roster.yaml`，入场先读并按 system_prompt 行事
- model 一律 sensenova-6.8-flash（用户 m06899 指令）

## 已重建席位

- A6 backend-crm（services/crm/）
- A8 frontend-console（web/console/）
- A14 ops-operator
- A15 admin-approver
- A16 compliance-reviewer

## 重建时间

2026-11-06，用户 m06899/m06917 指令：「重建。你把历史上下文存储，初始化模型时作为第一次会话发过去」。