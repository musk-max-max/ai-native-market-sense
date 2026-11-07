# tests/fixtures/ai —— AI 卡 E2E mock 响应夹具（A7 owns）

用途：AI-2/AI-3 E2E（E-AI2-02 / E-AI3-01）在**契约边界** mock `/v1/ai/analyses*` 响应，
驱动 web 侧模型文本渲染路径。形状严格按 `contracts/ai/openapi.yaml` 的
`AiAnalysisResponse{data:AnalysisResult,meta:AiResponseMeta}` 与 `contracts/shared/openapi.yaml`
的 `ResponseMeta{source,entitlement,disclaimer}`。

红线声明：

- 本目录全部内容为**合成哨兵文本**，非真实上游数据、非投资建议内容；
  不含任何 tushare 录播/转载数据（tushare 许可红线：录播件只在 `tests/fixtures/tushare/`）。
- 哨兵文案带 `【E2E哨兵…】` 前缀，用于 N6「文案只来自服务端注入、零硬编码 fallback」严格相等断言：
  若 web 渲染出来的 label/disclaimer 不是哨兵原文，即证明 web 侧有兜底/改写。

## 文件

| 文件 | 场景 | 判据 |
| --- | --- | --- |
| `analysis-valid.json` | 正对照：as_of 完整合法（`2026-11-06T15:00:00+08:00`，含 +08:00 不换算） | AI2-1：每生成块带 ai-as-of，textContent 与 `data.as_of` 逐字相等 |
| `analysis-no-as-of.json` | `as_of` 缺失（`data.as_of` 与两级 `meta.source.as_of` 全部移除；契约非法样本） | AI2-2：badge / disclaimer / 数值节点三类均不渲染 |
| `analysis-invalid-as-of.json` | `as_of` 非法（`"not-a-date"`，非 ISO8601） | AI2-2 同上 |
| `analysis-empty-as-of.json` | `as_of` 空串（`""`） | AI2-2 同上 |

对抗夹具（no/invalid/empty）是**故意违反契约**的样本：考 web 端 fail-closed（无合法 as_of 时
不得渲染 badge/disclaimer/数值），不得当正常数据用。

哨兵常量（断言必须引用这些值，禁止在 spec 里另抄一份文案）：

- `AS_OF = "2026-11-06T15:00:00+08:00"`
- disclaimer 哨兵：`【E2E哨兵AI-DISCLAIMER】…`（见 `analysis-valid.json` 的
  `data.meta.disclaimer.text`，与信封 `meta.disclaimer.text` 同值）
- claim 哨兵：`【E2E哨兵CLAIM-ALPHA】…` / `【E2E哨兵CLAIM-BETA】…`（不含数字，
  便于数值泄露扫描不误报）
- `analysis_id = "ai-e2e-valid-0001"`（满足 `^[A-Za-z0-9_-]+$` 8..128）

维护约定：契约（contracts/ai/openapi.yaml）字段变更时同步本目录；断言只认 `data.as_of`
与 `meta.disclaimer.text` 的严格相等，不对展示格式做假设。
