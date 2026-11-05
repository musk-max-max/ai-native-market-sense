# 用户可见文案发版 manifest（append-only）

同一版本轴：`COPY_VERSION` 格式 `YYYY.M.D`。每次发版（前后端任一可见文案变化）**追加一行**，
记录两端版本与内容 hash；旧行不修改。快照见 `docs/release/copy-snapshots/<version>.<content-hash12>.<side>.json`（文件名带内容 hash，同日多版不覆盖）。
规则与判据见 `docs/adr/ADR-006-user-visible-copy.md`。

| release | 日期       | frontend COPY_VERSION | backend COPY_VERSION | frontend hash | backend hash      | 快照文件（实际文件名）                                                       | 依据                                                                        |
| ------- | ---------- | --------------------- | -------------------- | ------------- | ----------------- | --------------------------------------------------------------------------- |
| P0-pre  | 2026-11-04 | 2026.11.4             | 2026.11.4            | f55da29b4940db24343d0317ddbb26729cff86668d803cf14ae7a425c572aa51 | 34031f022b29c2ef6c55e9af0d0671c0a63f4e51331fedfd78acdddc2480100f | backend `2026.11.4.34031f022b29.backend.json`；frontend `2026.11.4.f55da29b4940.frontend.json`；H3 m00839/m00870 初版 + A12 m01314 基础信息文案 |

| P0-pre-2 | 2026-11-04 | 2026.11.4             | 2026.11.4            | aa617e39c03e52261f561e3288e5a15b92fb3b4e9ed5405a65c65d3005f11cce | 34031f022b29c2ef6c55e9af0d0671c0a63f4e51331fedfd78acdddc2480100f | backend `2026.11.4.34031f022b29.backend.json`；frontend `2026.11.4.aa617e39c03e.frontend.json`；H3 m01536/m01541 条件通过：listStatus 文案修正（已上市/终止上市/未上市）、上市日期 label、异常态不得省略（delisted/prelisted/suspended 断言） |

| B1-P0 | 2026-11-05 | 2026.11.5 | 2026.11.5 | 5ce103f14b5f1ac76123c6549602882bea7ea3e65e53ceb3e9c38a6d649d2138 | b90fb608bd1b5d6fa6bea9de3f3c83df7740af59dae075c591adf7337eedfc3b | backend `2026.11.5.b90fb608bd1b.backend.json`；frontend `2026.11.5.5ce103f14b5f.frontend.json`；KD-AIP0-B1 第 1 批新增 AI 骨架/缺口/自选组合/涨跌停市场级汇总文案（69 条）+ 后端 P7 AI 标识/免责 | **H3 签字状态：pending H3 signoff（H3 m02407 认领签字、清单已提交，正式回签后补消息 ref）**；前端第 2 稿修正「梯队」标题词与「稍后重试」，快照 hash 由 ab4e14 更新为 5ce103 |

- `2026.11.5.ab4e14a6838e.frontend.json`（hash `ab4e14a6838ec1743752100122f3fec3683ddae9b08c282ff6097e80d5aa1513`）**superseded by** `2026.11.5.5ce103f14b5f.frontend.json`（hash `5ce103f14b5f1ac76123c6549602882bea7ea3e65e53ceb3e9c38a6d649d2138`），reason: Lead m02521 签字前修正——标题「涨跌停梯队」统一为「涨跌停概览」、删除「稍后重试」承诺性引导；旧快照文件删除（同版本未发布，不构成覆盖）。
说明：初版轴与两端快照均已落盘；快照文件名带内容 hash（H3 m01038 条件 3），任何一行都能回指唯一一份原文。前端 hash 为规范化文本清单 sha256，校验脚本 `web/h5/scripts/copy-snapshot.mjs --check`。

## 快照变更墓碑（append-only）

- `2026.11.4.d831dd5bf0fd.frontend.json`（hash `d831dd5bf0fdfc7726e977de2e24f3f25e53918308c728219c3eb0ff6ccc162d`）**superseded by** `2026.11.4.f0282f1bec57.frontend.json`（hash `f0282f1bec571162d08f2ee6386e9d3cd5e58f5735cf51e5483c072358aa432c`），reason: H3 m01237 四条文案必修后 copy.ts 文本变更；旧文件删除，同版本未发布不构成覆盖（Lead m01343 要求留墓碑）。
- `2026.11.4.f0282f1bec57.frontend.json`（hash `f0282f1bec571162d08f2ee6386e9d3cd5e58f5735cf51e5483c072358aa432c`）**superseded by** `2026.11.4.f55da29b4940.frontend.json`（hash `f55da29b4940db24343d0317ddbb26729cff86668d803cf14ae7a425c572aa51`），reason: A12 m01314 要求补 5 个基础信息 testid，新增 4 条中性展示标签（主板/证券类型/正常上市/上市日期）；旧快照文件已删除（同版本未发布，不构成覆盖），保留本墓碑。
- `2026.11.4.0172b842b079.frontend.json`（hash `0172b842b0790c940385e4c77c894227594f1d076cdf63bc995fae4da801e739`）**superseded by** `2026.11.4.f55da29b4940.frontend.json`（hash `f55da29b4940db24343d0317ddbb26729cff86668d803cf14ae7a425c572aa51`），reason: 上市日期加「上市」前缀以明确语义，避免裸日期歧义；旧文件删除，留墓碑。
- `2026.11.4.f55da29b4940.frontend.json`（hash `f55da29b4940db24343d0317ddbb26729cff86668d803cf14ae7a425c572aa51`）**superseded by** `2026.11.4.aa617e39c03e.frontend.json`（hash `aa617e39c03e52261f561e3288e5a15b92fb3b4e9ed5405a65c65d3005f11cce`），reason: H3 m01536 / Lead m01541 条件通过——「正常上市」→「已上市」、「上市」→「上市日期」，并补异常态（终止上市/未上市/停牌）可见性断言；旧文件删除，留墓碑。
