# A12 · H4 11-12 #5 证据包（fail-closed DOM + 页面文案逐字节）

- 生成时间：2026-11-04T13:53:10+08:00
- 主机：ly-2.local / macOS-26.5.1-arm64-arm-64bit
- 工具链：node v23.11.0 / python 3.12.2 / Playwright（`tests/e2e` 本地 devDependency）
- 场景覆盖：expired=PASS, hold_active=PASS, hold_stale=PASS, restricted_malformed_403=PASS, unauthorized_config=PASS
- 证据根目录：`tests/e2e/evidence/11-12-f1-dom-20261104T1049Z/`（run-scoped，不覆盖旧 run）
- 本包为 A12 独立跑出的 transcript + api.json + page-*.png；A7 自测结果不作为验收证据。
- 真实 tushare 报文未进入仓库（L32）：replay 数据为 `tests/fixtures/tushare/synthetic/build_recordings.py` 合成生成；`restricted_malformed_403` 在浏览器网络层注入 403，真实 API 不变。

## 场景结论

| 场景 | verdict | quote-price | stale-badge | notice | page_copy_matches_api |
|---|---|---|---|---|---|
| expired | PASS | 0 | 0 | 1 | PASS |
| hold_active | PASS | 0 | 0 | 1 | PASS |
| hold_stale | PASS | 0 | 0 | 1 | PASS |
| restricted_malformed_403 | PASS | 0 | 0 | 0 | N/A（整页错误态） |
| unauthorized_config | PASS | 0 | 0 | 1 | PASS |

## 判定口径

- 页面 `entitlement-notice` 的 innerText 归一空白后，必须 **严格等于** 同一 403 Problem 的 `title + ' ' + detail`（标题与详情之间一个空格）；删掉 `title` 与 `detail` 之后剩余必须为空——页面不得自造第三句、不得改写标点。
- 受限页 `quote-price` 与 `quote-stale-badge` 计数必须为 0；正文不得出现金额形状的「元」、`%`、`小时`。
- fail-closed DOM 扫描：价格/涨跌 testid 带任何文本即失败；数字类节点、伪元素、骨架屏一律失败，hidden/opacity:0 **不算**「没有」。
- `restricted_malformed_403`：403 无合法 `title`/`detail` → 整页中性错误态（`error-banner` 可见、notice 0、价格 0）；`injected_403_malformed` 校验注入确实发生（拦截计数来自 Playwright route）。
- 任一场景 verdict != PASS 就不打包（脚本直接 exit 1），不隐去失败项。

## 逐场景文件与规则

### expired（PASS）
- 规则：`quote_403`=PASS, `problem_copy_present`=PASS, `page_copy_matches_api`=PASS, `dom_no_numeric_leak`=PASS, `disclaimer_and_notice_visible`=PASS, `no_quote_artifacts`=PASS, `body_no_currency_percent_hours`=PASS, `playwright_P0_06_P0_12`=PASS
- `expired/transcript.log`（host/工具链/命令/exit code/时间戳）
- `expired/api.json`、`expired/dom-expired.json`、`expired/page-expired.png` / `.html`

### hold_active（PASS）
- 规则：`quote_403`=PASS, `problem_copy_present`=PASS, `page_copy_matches_api`=PASS, `dom_no_numeric_leak`=PASS, `disclaimer_and_notice_visible`=PASS, `no_quote_artifacts`=PASS, `body_no_currency_percent_hours`=PASS, `playwright_P0_06_P0_12`=PASS
- `hold_active/transcript.log`（host/工具链/命令/exit code/时间戳）
- `hold_active/api.json`、`hold_active/dom-hold_active.json`、`hold_active/page-hold_active.png` / `.html`

### hold_stale（PASS）
- 规则：`quote_403`=PASS, `problem_copy_present`=PASS, `page_copy_matches_api`=PASS, `dom_no_numeric_leak`=PASS, `disclaimer_and_notice_visible`=PASS, `no_quote_artifacts`=PASS, `body_no_currency_percent_hours`=PASS, `playwright_P0_06_P0_12`=PASS
- `hold_stale/transcript.log`（host/工具链/命令/exit code/时间戳）
- `hold_stale/api.json`、`hold_stale/dom-hold_stale.json`、`hold_stale/page-hold_stale.png` / `.html`

### restricted_malformed_403（PASS）
- 规则：`injected_403_malformed`=PASS, `full_page_error_no_numeric`=PASS
- `restricted_malformed_403/transcript.log`（host/工具链/命令/exit code/时间戳）
- `restricted_malformed_403/api.json`、`restricted_malformed_403/dom-restricted_malformed_403.json`、`restricted_malformed_403/page-restricted_malformed_403.png` / `.html`

### unauthorized_config（PASS）
- 规则：`quote_403`=PASS, `problem_copy_present`=PASS, `page_copy_matches_api`=PASS, `dom_no_numeric_leak`=PASS, `disclaimer_and_notice_visible`=PASS, `no_quote_artifacts`=PASS, `body_no_currency_percent_hours`=PASS, `playwright_P0_06_P0_12`=PASS
- `unauthorized_config/transcript.log`（host/工具链/命令/exit code/时间戳）
- `unauthorized_config/api.json`、`unauthorized_config/dom-unauthorized_config.json`、`unauthorized_config/page-unauthorized_config.png` / `.html`

## 完整性

- `evidence-manifest.json`：包内每个文件的 repo-relative path + sha256 + size（不含 manifest 自身）。
- `README.tar.gz`：解包后文件集合与 `evidence-manifest.json.files` 一一对应；包外 `PACKAGE.sha256` 给 tar.gz 与 manifest 自己的 sha256。

## Residual（未验证项，不隐去）

1. **不是 docker 真栈证据**：本轮全部为本机原生进程（api 8082/8083/8084 + web 3001/3003/3004），镜像构建未验证（Dlv-4；见 `tests/e2e/ci/BUILD-SMOKE.md` 与 RUNBOOK §0）。
2. **replay 是 L32 合成录制**：`tests/fixtures/tushare/recordings/` 由 `synthetic/build_recordings.py` 生成，无真实 tushare 报文；不得作为数据准确性/DA 证据，不进入 release note/对外材料。
3. **hold 控制行由 admin DSN 造**：`audit.raise_hold` / `clear_hold`（doc_sha 64 位小写 hex）在 A13 已迁移的 E2E 库执行，采集后已恢复 `hold=false`、`last_reconciled_at` 新鲜；生产侧 hold 操作路径未验证。

`#5` 的最终状态由 H5 记录；A12 不替 H5 签 PASS，只提供可复核的 evidence。

## 变更记录

- v1 draft（2026-11-04）：`TRANSCRIPTS.md` 的「场景覆盖」行有生成 bug（复用循环外变量，五个场景都写成最后一个场景的 verdict）。被 H4 拒收，**未签、未分发**。
- v2（2026-11-04）：同目录整体重生成——coverage 逐场景独立、补 `evidence-manifest.json` + `PACKAGE.sha256`、文案口径改为严格等于 `title + ' ' + detail`、补 Residual；H4 复核接受数据侧结论，`#5` PASS 由 H5 记录。
- **签收后本目录不可再改**：任何内容变化必须新建 run 目录 + 新 `PACKAGE.sha256`，旧包保留原样（run-scoped，不覆盖）。
