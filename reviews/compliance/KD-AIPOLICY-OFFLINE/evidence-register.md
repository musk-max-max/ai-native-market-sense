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
