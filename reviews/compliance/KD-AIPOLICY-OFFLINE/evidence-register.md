# A16 合规证据登记簿（append-only）

> 规则：只追加，不修改、不删除既有条目。每条例证登记含对象、sha256、来源 ref、状态；所有 sha 均由脚本从磁盘计算（禁止手抄）。
> 治理：每次 append 后由 **H5 或 H3** 抽核一次（重算 sha + 核对只追加 diff），**A16 不得自写自证**；H3 每季度全量抽核。

## E-0001 · 2026-11-06 · `ai-content-policy/1.1.1` 复核与签署

- 对象：`rules/ai-content-policy.json`（`policy_version=ai-content-policy/1.1.1`）
- 签认内容 sha256（H3 签字绑定，翻转前）：`eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293`
- 最终文件 sha256（部署 pin）：`3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`
- 复核包 r2（**签署生效 / 冻结**）：`review-package-H3-1.1.1-r2.md` — r2 冻结 sha `beacdf5dce5e569e7616e515644e433038f9b0303b51518ce0731fcdeece0546`
- 复核包 r1（**作废**：§1 表 sha 过期；保留作留痕，不删）：`review-package-H3-1.1.1.md` — `8dcbd1b0db28d85260598c4ad4e07aaa606ebe0fb2e8af4a4584b2365d1b25b3`
- 确定性复跑证据：`determinism-evidence.json` — `56244b040595c48b1dc20f2c5d4cfd8fc99af9b3798bcca8bc75157e8c4523b1`（两次连跑 md/json sha 逐字节一致）
- 实测报告：`report-samples-1.1.1-2026-11-06.md` — `5f926cbb317d1dc33f267f350cf44f96291259ad609083b5236bb8ebb59b6dd3`；`report-samples-1.1.1-2026-11-06.json` — `cfa5e81233e190c2d6fee29e178cf85061c9e828bb45b0122762b89785860f8a`
- 样本：`fixtures.json` — `e74735c04471b8fb1379b9ff16fb66fdb3953c33692ce50cb95cccdab4c2e93c`
- 复跑脚本：`run-samples.ts` — `05c157c90ecee6173db82f741c91e43f5c17968638257efef2717ae3d8fd1d9d`
- 映射：`mapping-draft-R1-R19.md` — `f78a8e18454e7dceb9c7b099ebdd90f99157f2f93a4d96f54bce33da92d22857`
- 结论（H3 本人）：**附条件通过（仅规则层）**
- 条件：
  1. `agents/decisions.md:141` R 编号矛盾由 Lead/H1 更正；编号只用 H3-C01–C12，R1–R19 仅历史别名。
  2. ADR-007 P5/P6 文本由 A0/H2 修订；A5 下一 policy 版本同批更新 `definition_refs`。
  3. **AI-1**（隐式标识 + 3 年留痕）/ **AI-2**（时点真实）/ **AI-3**（不可关闭/复制导出携带 label+disclaimer）未闭环前，不得对任何用户展示 AI 生成内容——本签署不构成 C 端展示放行。
  4. `audit.ai_generation_events` 留痕抽查待 003 migration 落地后由 Lead 正式指派 A16；抽检口径先报 H3。
  5. `policy_content_sha256_expected` 改名 `policy_file_sha256_expected` 留待下一版，本次不重签。
- 来源 ref：H3 m00533（r2 签署生效、冻结 sha 确认）；签认内容来源 H3 m01561。
- 登记人：A16 compliance-reviewer；登记时间：2026-11-06。
- 状态：生效（规则层）；C 端展示未放行。

## E-0002 · 2026-11-06 · 更正 E-0001 来源 ref + H3 抽核记录

- 更正对象：E-0001「来源 ref：H3 m00533」→ **unresolvable**。A16 侧可见编号在 H3 侧无法解析为 r2 签署消息；按登记规则不填猜测编号。
- 签署绑定以 **r2 冻结 sha `beacdf5dce5e569e7616e515644e433038f9b0303b51518ce0731fcdeece0546`** + policy 两个 sha（签认内容 `eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293` / 最终文件 `3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`）为准；ref 仅作检索线索，不得填猜测编号。
- H3 本次抽核：登记簿 sha `2acd92c34d6a52a09cfc3da94b26e6efb58b0dcb45cd648c5f1c7acd11f86a97`（E-0002 追加前的版本）；E-0001 内 8 个 sha（r2/r1/evidence/报告 md/报告 json/fixtures/runner/mapping）经 H3 脚本重算与磁盘一致；check-only 生效（r2 sha 未变 `beacdf5dce5e569e7616e515644e433038f9b0303b51518ce0731fcdeece0546`，生成器拒绝写入）。
- 登记人：A16 compliance-reviewer；登记时间：2026-11-06；治理抽核：H3（本次）。

## E-0003 · 2026-11-06 · evidence gap：`ai-content-policy/1.1.1` 签认字节不可复现

- 对象：`ai-content-policy/1.1.1` 签认字节（H3 签认 ref m01561；签认内容 sha256 `eee14c6228151197dd751ecb2c47cc279c39afd80a0eb952860dc2989af63293`；部署 pin `3e03535efd02cb99fbeaddc476a408688b4b71e29e01e2a0bedbf37ccb990da9`）。
- 状态：**evidence gap**。上述 sha 仍为历史记录，r2（冻结 sha `beacdf5dce5e569e7616e515644e433038f9b0303b51518ce0731fcdeece0546`）作为当时记录继续有效，但**不能复现**——签认字节未归档、未进 git 历史；H3 已按部署 pin sha `3e03535e…` 全仓搜索确认不存在（note 中「1.1.1 已签字节保留为历史」为不实陈述，A5 已删）。
- 归档机制：现行 `1.1.2` 已建内容寻址归档 `rules/archive/ai-content-policy/<sha256>.json` + CI 校验；`1.1.1` 当时无此机制，字节丢失不可追回。
- 决议：后续版本（`1.1.2` 起）签认字节必须走内容寻址归档，不再依赖签认 note 的文字描述。
- 前版登记簿 sha（上一次 H3 回执，append 前实测）：`90ee05a3da5b979d9c6d3c5dd7bb1a6c38e24945ca99bd630c9d98b8851bc14c`。
- 来源 ref：Lead 任务单 KD-AIPOLICY-E0003（2026-11-06）；H3 要求；H3 签认 ref m01561。
- 登记人：A16 compliance-reviewer；登记时间：2026-11-06。
- 待抽核：按治理规则，本 append 由 H5 或 H3 抽核（重算 sha + 核对只追加 diff）。

## E-0004 · 2026-11-06 · 整改 E-0003：补 `90ee05a3…` 回执旁证 + 更正归档措辞（1.1.2/r3 签认顺延 E-0005）

- 前版登记簿 sha（上一次 H3 回执 `e1a728bd…`，append 前实测）：`e1a728bd9a973b1db0a0bdb5121afea4a6c7104ad2a59b42d4bc4d66a9f1a0d5`。
- 整改来源：H5 对 E-0003 的抽核整改项（2026-11-06，非阻塞）；H3 要求单开本条、立即更正、不等 internal 分区。
- ① `90ee05a3…` 回执链旁证（补 E-0003 中仅由 A16 handoff 作旁证、属自证的缺口）：
  - `ref_source`：H3「登记簿 E-0002 抽核回执」消息（跨席会话，编号不可解析）
  - `ref_resolvable`：false
  - 申明内容（**H3 侧复述，非逐字原话**；该消息不在 A16 当前可见上下文，不伪造逐字引用）：①抽核通过，登记簿生效版本 sha = `90ee05a3da5b979d9c6d3c5dd7bb1a6c38e24945ca99bd630c9d98b8851bc14c`；②下一次 append 的「前版 sha」以该 sha 为准；③两条约定：规则区改动亦算修改、须在当条 entry 记前版 sha（E-0002 记了 `2acd92c3…`，合法）；登记簿无法自记自身 sha，每次 append 后 H3/H5 回执 sha 即该版本生效依据，下次「前版 sha」必须等于上次回执 sha。三条旁证：E-0002 原文未改、E-0001 保留、`90ee05a3…` 与 H3 抽核时磁盘 sha 一致。
- ② 更正 E-0003 第 40 行措辞：「该行应读作『工作树归档已建、校验脚本已加，但 `rules/archive/` 尚未入库（未跟踪）』；入库后补记 commit sha」。本条与「归档必须随 commit 入库」合并为同一条件项（完整硬条件在 E-0005）。
- ③ 编号顺延：「1.1.2 两分区 + r3 签认」条目顺延为 **E-0005**，其前版 sha 以本条 E-0004 的回执 sha 为准。
- ④ 硬条件（先落一句，完整项在 E-0005）：`rules/` 下 policy/redline/README 与 `rules/archive/` 必须入库；未入库前相关签认字节状态写「工作树状态、无版本控制保护」。
- 既有条目不动：E-0001–E-0003 原文不改、不删（append-only）。
- 登记人：A16 compliance-reviewer；登记时间：2026-11-06。
- 待抽核：本 append 由 H3 或 H5 抽核（重算 sha + 核对只追加 diff）；H3 回执本条生效 sha。
