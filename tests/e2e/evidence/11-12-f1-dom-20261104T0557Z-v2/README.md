# A12 · H4/H5 11-12 #5 证据包（fail-closed DOM + 页面文案）

- run_id：`11-12-f1-dom-20261104T0557Z-v2`（单次 run 全量采集，非拼包）
- run_started_at：2026-11-04T13:57:11+08:00；run_finished_at：2026-11-04T13:57:33+08:00
- 打包时间：2026-11-04T13:57:33+08:00；主机：ly-2.local / macOS-26.5.1-arm64-arm-64bit
- 证据根目录：`tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/`
- 场景覆盖（包级计算）：expired=PASS, hold_active=PASS, hold_stale=PASS, restricted_malformed_403=PASS, unauthorized_config=PASS
- 本包为 A12 独立跑出的 transcript + api.json + page-*.png；A7 自测不作为验收证据。
- 真实 tushare 报文未进入仓库（L32）：replay 数据由 `tests/fixtures/tushare/synthetic/build_recordings.py` 合成生成；`restricted_malformed_403` 在浏览器网络层注入 403，真实 API 不变。

## 场景结论

| 场景 | verdict | quote-price | stale-badge | notice | page_copy_matches_api |
|---|---|---|---|---|---|
| expired | PASS | 0 | 0 | 1 | PASS |
| hold_active | PASS | 0 | 0 | 1 | PASS |
| hold_stale | PASS | 0 | 0 | 1 | PASS |
| restricted_malformed_403 | PASS | 0 | 0 | 0 | N/A（整页错误态） |
| unauthorized_config | PASS | 0 | 0 | 1 | PASS |

## 文案判定口径（与实现同一函数）

以 `expired` 实测为例：

- API Problem：`title` = `行情数据暂不可用`，`detail` = `当前版本暂不提供该标的行情数据`
- 页面 `entitlement-notice.textContent` = `行情数据暂不可用当前版本暂不提供该标的行情数据`（title/detail 直接拼接，**无分隔符**）
- 页面 `entitlement-notice.innerText` = "行情数据暂不可用\n\n当前版本暂不提供该标的行情数据"（title/detail 两段换行，仅人工核对）

判定（`tests/e2e/scripts/collect_f1_dom_evidence.py` 的 `page_copy_matches_api`）：

```python
expected = Problem.title + Problem.detail      # 无分隔符
actual   = notice.textContent.strip()           # 不用 innerText
ok = actual == expected and (actual.replace(title, '', 1).replace(detail, '', 1).strip() == '')
```

即：`textContent` 去首尾空白后严格等于 `title+detail`，且去掉两段后不剩任何文本；页面不得自造第三句、不得改写标点。`innerText` 的换行不是契约。

## 判定口径（其余）

- 受限页 `quote-price` 与 `quote-stale-badge` 计数必须为 0；正文不得出现金额形状的「元」、`%`、`小时`。
- fail-closed DOM 扫描：价格/涨跌 testid 带任何文本即失败；数字类节点、伪元素、骨架屏一律失败；hidden/opacity:0 **不算**「没有」。
- `restricted_malformed_403`：403 无合法 `title`/`detail` → 整页中性错误态（`error-banner` 可见、notice 0、价格 0）；`injected_403_malformed` 校验注入确实发生。
- 任一场景非 PASS 则本包不生成；场景缺失/run_id 不一致同样拒绝打包。

## 完整性

- `evidence-manifest.json`：run_id / run_started_at / run_finished_at / coverage（包级计算）+ 包内每个文件的 repo-relative path + sha256 + size（不含 manifest 自身）。
- `README.tar.gz`：解包后文件集合与 `manifest.files` 一一对应；包外 `PACKAGE.sha256` 给 tar.gz 与 manifest 自己的 sha256。
- `TRANSCRIPTS.md` 是五份 `transcript.log` 的索引，不与 README 同文。

## Residual（未验证项，不隐去）

1. **不是 docker 真栈证据**：本轮全部为本机原生进程（api 8082/8083/8084 + web 3001/3003/3004），镜像构建未验证（Dlv-4；见 `tests/e2e/ci/BUILD-SMOKE.md` 与 RUNBOOK §0）。
2. **replay 是 L32 合成录制**：`tests/fixtures/tushare/recordings/` 由 `synthetic/build_recordings.py` 生成，无真实 tushare 报文；不得作为数据准确性/DA 证据，不进入 release note/对外材料。
3. **hold 控制行由 admin DSN 造**：`audit.raise_hold` / `clear_hold`（doc_sha 64 位小写 hex）在 A13 已迁移的 E2E 库执行，采集后已恢复 `hold=false`、`last_reconciled_at` 新鲜；生产侧 hold 操作路径未验证。

`#5` 的 PASS 由 H5 记录；A12 不签，只提供可复核的 evidence。
