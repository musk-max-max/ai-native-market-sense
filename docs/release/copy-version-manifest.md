# 用户可见文案发版 manifest（append-only）

同一版本轴：`COPY_VERSION` 格式 `YYYY.M.D`。每次发版（前后端任一可见文案变化）**追加一行**，
记录两端版本与内容 hash；旧行不修改。快照见 `docs/release/copy-snapshots/<version>.<content-hash12>.<side>.json`（文件名带内容 hash，同日多版不覆盖）。
规则与判据见 `docs/adr/ADR-006-user-visible-copy.md`。

| release | 日期       | frontend COPY_VERSION | backend COPY_VERSION | frontend hash | backend hash      | 快照文件（实际文件名）                                                       | 依据                                                                        |
| ------- | ---------- | --------------------- | -------------------- | ------------- | ----------------- | --------------------------------------------------------------------------- |
| P0-pre  | 2026-11-04 | 2026.11.4             | 2026.11.4            | f55da29b4940db24343d0317ddbb26729cff86668d803cf14ae7a425c572aa51 | 34031f022b29c2ef6c55e9af0d0671c0a63f4e51331fedfd78acdddc2480100f | backend `2026.11.4.34031f022b29.backend.json`；frontend `2026.11.4.f55da29b4940.frontend.json`；H3 m00839/m00870 初版 + A12 m01314 基础信息文案 |

| P0-pre-2 | 2026-11-04 | 2026.11.4             | 2026.11.4            | aa617e39c03e52261f561e3288e5a15b92fb3b4e9ed5405a65c65d3005f11cce | 34031f022b29c2ef6c55e9af0d0671c0a63f4e51331fedfd78acdddc2480100f | backend `2026.11.4.34031f022b29.backend.json`；frontend `2026.11.4.aa617e39c03e.frontend.json`；H3 m01536/m01541 条件通过：listStatus 文案修正（已上市/终止上市/未上市）、上市日期 label、异常态不得省略（delisted/prelisted/suspended 断言） |

| B1-P0 | 2026-11-05 | 2026.11.5 | 2026.11.5 | 58aecaead57cb0e2ebc7df914a376a3e605ca78cd765bb3898f957bd563fc8a9 | b90fb608bd1b5d6fa6bea9de3f3c83df7740af59dae075c591adf7337eedfc3b | backend `2026.11.5.b90fb608bd1b.backend.json`（待 A0 按 H3 修订重配对）；frontend `2026.11.5.58aecaead57c.frontend.json`；KD-AIP0-B1 第 1 批 AI 骨架/缺口/自选组合/涨跌停市场级汇总文案（主表 69 + 附录 7） | **历史行：已被 B1-P0-3 取代（frontend 2dfd 的 H3 回签见 B1-P0-3 / H3 m02683）**；前端第 3 稿按 m02565 修正 emptyList/provisional/存量「稍后重试」收窄/footerNote；快照 hash 由 5ce103 更新为 58ae |

| B1-P0-2 | 2026-11-05 | 2026.11.5 | 2026.11.5 | 58aecaead57cb0e2ebc7df914a376a3e605ca78cd765bb3898f957bd563fc8a9 | afe932c929316ead5570db2c20f9dd6287a84e1ba4f990eaf2939b4fc247b037 | backend `2026.11.5.afe932c92931.backend.json`；frontend `2026.11.5.58aecaead57c.frontend.json`；H3 m02666 文案替换（label「AI 生成 · 仅供参考」/ disclaimer 补「由 AI 生成」、市场数据、仅供参考与买卖依据）；前端 A7 第 3 稿 58ae，后端同步配对 | **历史行：已被 B1-P0-3 取代（frontend 2dfd 的 H3 回签见 B1-P0-3 / H3 m02683；H3 m02666 给出替换文本并附四项机制条件）** |

| B1-P0-3 | 2026-11-05 | 2026.11.5 | 2026.11.5 | 2dfd627b35c1d6c884b1d6ba185d287e8a63bafb945c6c94a8a4dbeafea777a3 | ac875c9d9237009cbe366f9879cb94739d1a8194c90173dbb29b4768ebb46a4b | backend `2026.11.5.ac875c9d9237.backend.json`；frontend `2026.11.5.2dfd627b35c1.frontend.json`；A7 m02765/H3 m02565 §C1：401 detail 改为「请先登录后再使用自选功能。」；AI 文案同 m02666；前端补「连板分布从首板 1 板起」修正（58ae→2dfd） | **H3 文案侧通过（前端 m02683 / 后端 m02810）；AI 生成功能放行仍待 ADR-006 D7 四项机制条件 1–3** |

- `2026.11.5.ab4e14a6838e.frontend.json`（hash `ab4e14a6838ec1743752100122f3fec3683ddae9b08c282ff6097e80d5aa1513`）**superseded by** `2026.11.5.5ce103f14b5f.frontend.json`（hash `5ce103f14b5f1ac76123c6549602882bea7ea3e65e53ceb3e9c38a6d649d2138`），reason: Lead m02521 签字前修正——标题「涨跌停梯队」统一为「涨跌停概览」、删除「稍后重试」承诺性引导；旧快照文件删除（同版本未发布，不构成覆盖）。
- `2026.11.5.5ce103f14b5f.frontend.json`（hash `5ce103f14b5f1ac76123c6549602882bea7ea3e65e53ceb3e9c38a6d649d2138`）**superseded by** `2026.11.5.58aecaead57c.frontend.json`（hash `58aecaead57cb0e2ebc7df914a376a3e605ca78cd765bb3898f957bd563fc8a9`），reason: H3 m02565 条件通过要求 f58——emptyList 改「无可统计的涨跌停样本」、连板分布全分段口径写入 provisional、存量「稍后重试」按场景收窄（429/自选保留）、footerNote 改「市场公开披露数据」。
- `2026.11.5.58aecaead57c.frontend.json`（hash `58aecaead57cb0e2ebc7df914a376a3e605ca78cd765bb3898f957bd563fc8a9`）**superseded by** `2026.11.5.2dfd627b35c1.frontend.json`（hash `2dfd627b35c1d6c884b1d6ba185d287e8a63bafb945c6c94a8a4dbeafea777a3`），reason: H3 m02683 / lead m02635 第 3 条——连板分布「从 2 板起」构成低端截断（首板段缺失=选择性呈现），改为从首板（1 板）起逐档统计、全段展示，provisional 口径横幅同步。
说明：初版轴与两端快照均已落盘；快照文件名带内容 hash（H3 m01038 条件 3），任何一行都能回指唯一一份原文。前端 hash 为规范化文本清单 sha256，校验脚本 `web/h5/scripts/copy-snapshot.mjs --check`。

## 快照变更墓碑（append-only）

- `2026.11.4.d831dd5bf0fd.frontend.json`（hash `d831dd5bf0fdfc7726e977de2e24f3f25e53918308c728219c3eb0ff6ccc162d`）**superseded by** `2026.11.4.f0282f1bec57.frontend.json`（hash `f0282f1bec571162d08f2ee6386e9d3cd5e58f5735cf51e5483c072358aa432c`），reason: H3 m01237 四条文案必修后 copy.ts 文本变更；旧文件删除，同版本未发布不构成覆盖（Lead m01343 要求留墓碑）。
- `2026.11.4.f0282f1bec57.frontend.json`（hash `f0282f1bec571162d08f2ee6386e9d3cd5e58f5735cf51e5483c072358aa432c`）**superseded by** `2026.11.4.f55da29b4940.frontend.json`（hash `f55da29b4940db24343d0317ddbb26729cff86668d803cf14ae7a425c572aa51`），reason: A12 m01314 要求补 5 个基础信息 testid，新增 4 条中性展示标签（主板/证券类型/正常上市/上市日期）；旧快照文件已删除（同版本未发布，不构成覆盖），保留本墓碑。
- `2026.11.4.0172b842b079.frontend.json`（hash `0172b842b0790c940385e4c77c894227594f1d076cdf63bc995fae4da801e739`）**superseded by** `2026.11.4.f55da29b4940.frontend.json`（hash `f55da29b4940db24343d0317ddbb26729cff86668d803cf14ae7a425c572aa51`），reason: 上市日期加「上市」前缀以明确语义，避免裸日期歧义；旧文件删除，留墓碑。
- `2026.11.4.f55da29b4940.frontend.json`（hash `f55da29b4940db24343d0317ddbb26729cff86668d803cf14ae7a425c572aa51`）**superseded by** `2026.11.4.aa617e39c03e.frontend.json`（hash `aa617e39c03e52261f561e3288e5a15b92fb3b4e9ed5405a65c65d3005f11cce`），reason: H3 m01536 / Lead m01541 条件通过——「正常上市」→「已上市」、「上市」→「上市日期」，并补异常态（终止上市/未上市/停牌）可见性断言；旧文件删除，留墓碑。
- `2026.11.5.b90fb608bd1b.backend.json`（hash `b90fb608bd1b5d6fa6bea9de3f3c83df7740af59dae075c591adf7337eedfc3b`）**superseded by** `2026.11.5.afe932c92931.backend.json`（hash `afe932c929316ead5570db2c20f9dd6287a84e1ba4f990eaf2939b4fc247b037`），reason: H3 m02666 不签旧 AI 措辞——label 去「信息整合非投资建议」（改为「AI 生成 · 仅供参考」）、disclaimer 补「由 AI 生成」「市场数据」「仅供参考」「买卖依据」；旧快照保留，B1-P0 行保留墓碑（同版本未发布，新行 B1-P0-2）。
- `2026.11.5.afe932c92931.backend.json`（hash `afe932c929316ead5570db2c20f9dd6287a84e1ba4f990eaf2939b4fc247b037`）**superseded by** `2026.11.5.ac875c9d9237.backend.json`（hash `ac875c9d9237009cbe366f9879cb94739d1a8194c90173dbb29b4768ebb46a4b`），reason: A7 m02765 / H3 m02565 §C1——401 detail 由「自选为私有数据，需要有效的 Bearer 凭据。」改为「请先登录后再使用自选功能。」（C 端不直出协议词）；旧快照保留，新行 B1-P0-3。
