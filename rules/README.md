# rules/ — H3 定义的合规规则文本（A5 只实现，不立法）

本目录存放**监管/政策规则文本**（H3 定义、签字）。A5 backend-compliance 负责工程形态（文件结构、正则、版本号、测试与消费约定），**不得自行新增/删除规则或放宽阈值**。

## 文件

| 文件 | 内容 | 定义方 | 实现方 |
|---|---|---|---|
| `ai-content-policy.json` | AI 内容白名单（按 audience）、12 类禁用类别、允许结论前缀与证据匹配、data_gap caveat、`policy_version` | H3（ADR-008 D8 q3=A、ADR-007 P5/P6、L3、H3 m01300） | A5 |
| `redline-basis.json` | 12 条 P5 红线 `H3-C01..H3-C12` 与 policy category 的对应、三档依据（`CSRC_40_DEF`/`L3_FIVE_NO`/`ADR007_P5_P6`/`PENDING_LEGAL`）、双 policy sha pin、文件自身版本 | H3（m01732 草稿） | A5 |
| `README.md` | 版本管理、消费契约、变更流程 | A5（工程约定） | A5 |

## 消费契约（单一真源）

- **`packages/ai-policy/`** 读取本文件（由调用方加载后传入纯函数）；禁止在 `services/ai/src/postprocess/`、`services/compliance/`、A16 脚本里复制一份词表/判定逻辑（L45/L126 两份真源教训）。
- A3 在线（`services/ai/src/postprocess/`）与 A16 离线复核使用**同一个包、同一个文件、同一个 `policy_version`**。
- 审计事件 `audit.ai_generation_events.policy_version` 写入本文件的 `policy_version`；A16 抽样时校验事件中的版本与当前文件一致。
- `services/compliance/src/ai-content-policy.ts` 提供只读 loader（唯一允许的文件 I/O 落点：`loadAiContentPolicy` / `loadRedlineBasis`），`packages/ai-policy` 保持无 I/O。
- **红线依据单一真源**：`rules/redline-basis.json` 由 `parseRedlineBasis()` 校验；每一条 `H3-Cxx` 必须对应 policy 的 12 个 category 之一，集合双向相等、`default_action=block`、`reason_code===category id`、policy 版本/双 sha 必须匹配。生产加载缺/错即拒绝启动。
- `Claim.class` 必填：每条 claim 必须声明其客观类别（`objective_fields` / `metrics` / `quantiles` / `statistics` / `historical_facts` / `timestamps` / `data_gaps`），由 P2 按 audience 白名单校验；缺省/未知即 blocked。

## 变更流程（硬约束）

1. 任何词表/类别/正则/允许前缀/阈值变化 → 先由 **H3 书面签字**（记录到 `agents/decisions.md` 或同等级文档），A5 才可提交。
2. 同步升 `policy_version`（语义化：`ai-content-policy/<major>.<minor>.<patch>`；放宽/删除规则为 major，新增类别为 minor，文案/正则等价改写为 patch）。
3. 更新 `updated` 日期与 `authority.h3_policy_version_signature`（签字状态/依据链接）。
4. A3/A16 各自升级依赖版本；A16 用同一批样本重跑，证明行为变化符合签字口径。
5. **fail-closed**：策略文件加载/解析失败、版本不一致、规则为空 → 调用方阻断，不得回退到“无过滤”。生产环境（`NODE_ENV=production` 或 `APP_PROFILE=prod`）下 `status != signed` 时 `parseAiContentPolicy()` 直接抛 `policy_not_signed_for_production`，进程启动即失败。

## 当前状态（2026-11-06）

- `redline-basis.json`：`version=1.0.0`，H3 m01732 草稿落盘（H3 定义、A5 实现）；`policy_version=ai-content-policy/1.1.1`，双 policy sha 指向 `eee14c62…`（签字内容）与 `3e03535e…`（部署 pin）；12 条 `H3-C01..C12`，C12 仅 `PENDING_LEGAL`。
- `policy_version = ai-content-policy/1.1.1`，H3 已签认（m01561；签字内容 sha256=`eee14c62…`，翻转 status=signed 后最终文件 sha256=`3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`）。
- **H3 对本文本签字状态：signed（m01561）；生产 pin 必须使用翻转后的最终 sha256，不是签字内容 sha。**

## 生效记录（H3 签认生效，2026-11-06）

| 项 | 值 |
|---|---|
| `policy_version` | `ai-content-policy/1.1.1` |
| 签字 ref | `m01561` |
| 签字内容 sha256 | `eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293` |
| 最终文件 sha256（部署 pin） | `3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9` |
| 生产 env | `AI_CONTENT_POLICY_EXPECTED_VERSION=ai-content-policy/1.1.1`、`AI_CONTENT_POLICY_EXPECTED_SHA256=3e03535e…` |

生效范围仅规则层。C 端 AI 生成内容展示仍卡 AI-1（隐式标识元数据 + 生成/展示留痕 ≥3 年）、AI-2（时点真实）、AI-3（不可关闭/复制导出携带/无硬编码 fallback）；未闭环前只能联调、不得对用户可见。以后任何规则/词表/前缀/白名单变动须升 `policy_version` 并重新签字，`3e03535e…` 立即失效，不得同版本改字节。（`authority.h3_policy_version_signature.status`）。未签字前只用于 A3/A16 联调；按 H3 m02810 条件 1，满足留痕/标识门禁前不得对用户展示模型生成可见内容。
- 12 类禁用：`investment_advice`、`directional_conclusion`、`rating`、`target_price`、`market_timing`、`position_advice`、`causal_attribution`、`guarantee`、`selection_solicitation`、`future_prediction`、`suitability_advice`、`nonpublic_information`；决策映射由引擎消费（blocked→blocked、redact/caveat→passed），未知 action 抛错。
- 白名单按 audience 分档：internal 7 类（含 `data_gaps`）；C 端 6 类（无 `data_gaps`，缺口文案由 copy.ts 常驻）。
- 允许结论前缀仅 `数据显示`（须有 numeric 证据）与 `历史统计上`（须有 historical_statistical 证据）；无证据/类型不匹配时 P6 直接 block，不再自动补前缀。
- `scope.rewrite_rules.skip_p6_classes=["data_gaps"]`：缺口声明不跑 P6（策略机读，A16 可断言）。
- `Section.title` 禁止由模型生成（P2 `model_generated_title_not_allowed`）；标题由 copy.ts 常驻，防止标题成为词表旁路。
- P4 数字 token 排除 ISO 日期/`YYYY-MM-DD`/`YYYY年M月D日`/`HH:mm`，避免 `timestamps` 白名单被误伤；证据外数字仍 block。
