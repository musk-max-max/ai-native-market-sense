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

## 当前状态（2026-11-06，分区签发）

- `policy_version = ai-content-policy/1.1.2`（**待签**），`status=pending`。
- **分区签发（L130）**：`authority.h3_policy_version_signature` 为 c_end 分区（H3 签），`authority.owner_policy_version_signature` 为 internal 分区（owner 签，A5 不代签）；生产加载要求两个分区均 `signed`，缺任一/未签即拒绝启动。
- `basis_scope = {"applies_to":"c_end","internal_basis":"owner decision 2026-11-06 (m06899)"}`：`H3-Cxx` 只是 C 端红线依据，不构成 H3 对 internal 的背书。
- 12 个 `category[].basis` 均为 `见 rules/redline-basis.json#H3-C01..C12`；patterns/default_action/白名单/前缀/definition_refs 与 1.1.1 一致（definition_refs 6 条已恢复）。
- 1.1.1 已签字节**不存在于仓库**（H3 按 `3e03535e…` 全仓搜索确认）；A16 登记簿 E-0003 记 evidence gap，r2 作为当时记录继续有效但不可复现。
- **当前待签 pending 字节 sha256=`aae8032a1423566d7d3f0355326a891ee88d8236959ebe5605557da57291a2bd`**；已归档到 `rules/archive/ai-content-policy/`。
- 归档机制：`rules/archive/ai-content-policy/<sha256>.json` 与 `rules/archive/redline-basis/<sha256>.json`，字节完全一致、只读、文件名=内容 sha256；`packages/ai-policy/test/archive.test.ts` 做 CI 校验。签前归档 pending 字节，签后归档最终字节。
- **redline-basis.json v1.0.2**（H3 已签，pending `f071cbc9…` / 部署 `cfe50982…`）：`policy_signed_content_sha256` 跨文件等于 policy 的 c_end 签认内容 sha；`policy_deployed_file_sha256_observed_at_signoff` 仅记录签认时观测值、**非门禁**（部署字节由 policy loader 的 `AI_CONTENT_POLICY_EXPECTED_SHA256` 强制）。这样 owner 签 internal / 任何签名分区字节变化不再牵连 redline 重签。
- redline v1.0.1（H3 已签，pending `8e8ef728…` / 部署 `51d06e3d…`）**已被 v1.0.2 取代**：1.0.1 的部署 pin 会随 policy 签名分区变化而失配，故解除该重复绑定；1.0.1 归档保留不删。

### 1.1.2 编辑状态表（给 H3 核）

| # | 时间（2026-11-06） | sha256（前 8） | 修改者 | 改了什么 |
|---|---|---|---|---|
| 1 | 09:05 commit `6ddeedc` | `62efd1da` | Lead 提交 A5 工作树 | 1.1.2 pending 初版（version/12 basis/note）被提交；commit message 误写「1.1.1 signed」，属流程事故（Lead 记 L130/decisions） |
| 2 | ~11:14 | `45ad5028` | A5 | 按 Lead m01915 把 pending note 改为等待 owner 签认 |
| 3 | 11:16 | 未知（未落盘不可复算） | Lead | 越权把 signoff 置 `signed`/`defined_by=owner`，已回滚 |
| 4 | 11:17:53 | `0cbcaab8` | Lead | 错误把 `definition_refs` 由 6 条裁到 3 条，已回滚 |
| 5 | 11:22:33 | `47dc47d3` | Lead | 恢复 definition_refs 6 条 + note 改分区签发措辞 |
| 6 | 11:2x | `aae8032a` | A5 | 分区签名结构（H3 c_end / owner internal）+ `basis_scope` + 删「1.1.1 已签字节保留为历史」不实句 + 归档 pending 字节 |
| 7 | 11:27:11Z（c_end 翻转） | `7f795503` | A5 | 按 Lead m02065/H3 授权翻转 c_end：仅改 `h3_policy_version_signature` 的 status/content_sha256_at_signoff/sign_at/note 四字段（其余字节未动，diff 已核）；最终字节归档 `rules/archive/ai-content-policy/7f795503….json`；internal 仍待 owner |
| 8 | 11:30:54Z（redline 1.0.1 翻转） | `51d06e3d`（redline） | A5 | redline-basis 升 1.0.1、policy_version→1.1.2、重绑 policy 双 sha；pending `8e8ef728….json` 与最终 `51d06e3d….json` 均归档；翻转只改 signed/signed_at/content_sha256_at_signoff/sign_at 四字段。**已被 1.0.2 取代**（解除签名分区变更牵连） |
| 9 | 11:34:19Z（redline 1.0.2 翻转） | `cfe50982`（redline） | A5 | 绑定语义修正：绑定 c_end 签认内容 sha；部署 sha 改名 observed、非门禁；pending `f071cbc9….json` 与最终 `cfe50982….json` 均归档；H3 签认 pending 字节，翻转只改 4 字段 |

## 历史生效记录（1.1.1，H3 签认，2026-11-06）

> 1.1.2 c_end 分区已签（H3，部署 pin `7f795503…`）；internal 分区待 owner 签，生产仍拒绝启动。

| 项 | 值 |
|---|---|
| `policy_version` | `ai-content-policy/1.1.1` |
| 签字 ref | `m01561` |
| 签字内容 sha256 | `eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293` |
| 最终文件 sha256（部署 pin） | `3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9` |
| 生产 env | `AI_CONTENT_POLICY_EXPECTED_VERSION=ai-content-policy/1.1.1`、`AI_CONTENT_POLICY_EXPECTED_SHA256=3e03535e…` |

生效范围仅规则层。C 端 AI 生成内容展示仍卡 AI-1（隐式标识元数据 + 生成/展示留痕 ≥3 年）、AI-2（时点真实）、AI-3（不可关闭/复制导出携带/无硬编码 fallback）；未闭环前只能联调、不得对用户可见。以后任何规则/词表/前缀/白名单变动须升 `policy_version` 并重新签字，`3e03535e…` 立即失效，不得同版本改字节。1.1.1 历史记录仅作审计；1.1.2 未签前只用于 A3/A16 联调；按 H3 m02810 条件 1，满足留痕/标识门禁前不得对用户展示模型生成可见内容。
- 12 类禁用：`investment_advice`、`directional_conclusion`、`rating`、`target_price`、`market_timing`、`position_advice`、`causal_attribution`、`guarantee`、`selection_solicitation`、`future_prediction`、`suitability_advice`、`nonpublic_information`；决策映射由引擎消费（blocked→blocked、redact/caveat→passed），未知 action 抛错。
- 白名单按 audience 分档：internal 7 类（含 `data_gaps`）；C 端 6 类（无 `data_gaps`，缺口文案由 copy.ts 常驻）。
- 允许结论前缀仅 `数据显示`（须有 numeric 证据）与 `历史统计上`（须有 historical_statistical 证据）；无证据/类型不匹配时 P6 直接 block，不再自动补前缀。
- `scope.rewrite_rules.skip_p6_classes=["data_gaps"]`：缺口声明不跑 P6（策略机读，A16 可断言）。
- `Section.title` 禁止由模型生成（P2 `model_generated_title_not_allowed`）；标题由 copy.ts 常驻，防止标题成为词表旁路。
- P4 数字 token 排除 ISO 日期/`YYYY-MM-DD`/`YYYY年M月D日`/`HH:mm`，避免 `timestamps` 白名单被误伤；证据外数字仍 block。
