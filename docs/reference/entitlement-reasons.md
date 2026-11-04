# 降级原因与审计缺口 · canonical 表

> **唯一真源是 `entitlement-reasons.json`**，本文件只是它的人读版本。
> 代码常量、healthz 字段、A11 断言、验收文档一律从 JSON 取值或与之逐项相等；
> 文档与代码谁先改都行，**但两者不一致即红**。

## 阻断（effective=internal_eval、blocked=true、行情 403）

| reason | 含义 |
|---|---|
| `control_unavailable` | control 表/连接不可达（瞬态重试后仍失败） |
| `control_stale` | control 或 reconciler 状态超过陈旧阈值（**由响应者自己按时间算，不依赖 reconciler 存活**） |
| `control_missing` | 运行时无 control 行（配置错误） |
| `hold_active` | 人工 hold 生效中 |
| `config_mismatch` | 签名/指纹与配置不符 |
| `expired` | 授权时间盒到期 |
| `audit_write_misconfigured` | 写路径的确定性错误（42501/42P01/schema 不符）——不是"偶尔写失败"，是"根本写不进去" |

## 非阻断（resolution 不变，仅 `degraded=true` + 告警）

| reason | 含义 |
|---|---|
| `audit_write_failed` | 写审计事件瞬态失败（连接/超时/序列化冲突），补偿控制 = reconciler 2min raise hold |
| `expired_event_write_failed` | 到期事件瞬态写失败（此时已是 internal_eval，写失败不扩大授权） |

## 禁用别名

`control_unreachable` / `control_deterministic_error` / `hold_stale` / `reconciler_stalled`

出现即红。**同一件事两个名字，会让两份都自洽的断言得出两个结论。**

## 审计缺口事件 `audit_gap`

- JSON 键：`window_start` / `window_end` / `lost_count` / `reason` / `owner`
- `event_key = gap|<deployment_uid>|<window_start ISO8601 UTC>`
- 去重身份用 `deployment_uid`，**不是 `boot_id`**：service 与 reconciler 必须能算出同一个键，而 `boot_id` 只有 service 知道
- `lost_count >= 1`（写 0 条丢失是自欺）
- 不做补记重放：**断口可见，不靠"补得像没断过"**

## 窗口起点与去重键（2026-11-04 收口）

- `window_start` = **链上最后一条任何类型事件**的 `occurred_at`（含 `audit_gap` 自身）。
  取"最后一条非 gap"会让连续两个断口算出同一个 `event_key`，第二次被唯一索引吞掉——
  **断口连续出现时，第二次恰恰是最该被看见的那次。**
- `event_key = gap|<deployment_uid>|<window_start>`
- `DEPLOYMENT_UID` 在 prod **缺失即启动失败**（`services/market/src/config.ts:194` 目前为可选，须改）
- reconciler 双向判定：Running 但链里无该 `deployment_uid` 的 `observed` → gap + hold；**有 `observed` 但无对应事件 → 同样 gap + hold**（两种写入失败模式不同，只判一个方向会漏）
