# security/ — A9 安全域（提案稿，非运行代码）

> Owner: A9 (security)。写域依据 `ownership.yaml` `reserved_paths`（`security/`、`auth/` 归 A9）。
> **本目录全部为提案/结论/用例设计，不含任何可执行加固或运行代码。** 认证/鉴权/密钥/支付类改动按 roster
> 硬规则：A9 只能提案，**须 H5 与人类架构双签**后才可由 A13/相应 owner 合入。生产环境操作（含 ECS 主机加固）
> 一律不由 A9 执行：执行归 A13，云控制台归用户。

## 1. 本目录在回答什么问题

| 问题 | 文档 | 状态 |
|---|---|---|
| 现在有哪些高危漏洞、release gate 是否被阻断 | [`findings/register.md`](findings/register.md)、[`gate/release-gate-block-2026-11-05.md`](gate/release-gate-block-2026-11-05.md) | 已出（只读结论） |
| 基线 #11「生产只走 IaC」违反（R7）的措辞与验收标准 | [`baselines/BL-11-R7-host-state-not-in-iac.md`](baselines/BL-11-R7-host-state-not-in-iac.md) | 已出（待 H5 认措辞） |
| 认证方式与主机加固提案（覆盖 H5 门禁 ⑤） | [`../auth/proposal-2026-11-05-authn-and-host-hardening.md`](../auth/proposal-2026-11-05-authn-and-host-hardening.md) | 已出（**待 H5 + 人类架构签字**） |
| 越权用例集（含主机层/隧道两类新面） | [`test-cases/overreach-cases.md`](test-cases/overreach-cases.md) | 设计稿；执行方 A19/A12 |
| tushare 授权三件到哪一步、card 端能否上线、换源成本多少 | [`compliance/tushare-authorization-ledger.md`](compliance/tushare-authorization-ledger.md) | **未闭环**（三件 0/3，11-12 到期；residual 口径见文档 §2） |

## 2. 结论的三个来源（可复核）

1. **事实层**：A19 红队 L91 内网复核 artifact `infra/evidence/internal-exposure-redteam-20261104T2356Z.txt`
   （commit `370c6bb`，errata `0657fc1`，302 行，E1–E4 / I1–I5 / I10–I11，manifest 已登记 sha256/bytes）。
   A9 未重复探测，只做证据核对与仓库侧交叉验证。
2. **基线层**：`agents/decisions.md` — 14 条安全基线（§5）、L91（内网访问、不暴露公网）、L98（④ PASS 口径与四条
   residual）、L99（P2 事件关闭口径）、L100（H3 合规定性：内网改暴露面、不改权利基础）。
3. **口径层**：H5 2026-11-05 裁定 — R2=P1 release-blocking（修复时限用户确认后 24h，11-05 24:00 前）、R1/R3=P2、
   R4/R6 技术事实归 A9、定性归 H3；门禁新增 ⑤「主机管理面」（6 项可验证条件，见 gate 文档 §3）。

## 3. 红线（本域自约束）

- 不写「越权测试全绿」除非门禁 ⑤ 通过且 EXC 用例集有可复现证据 —— 见 `gate/` 文档 §4。
- 不把「内网」当「豁免」：L100 明确内网只降暴露面、不产生权利基础；本目录任何文档不得出现「内网=自用」表述。
- 不在任何真实主机（含 ECS）执行加固/探测；不启动 `ms-nginx`；不做口令爆破。
- 不自行降低安全基线（roster forbidden），任何基线口径变更走「提案 → H5 → 用户」。
