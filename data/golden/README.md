# data/golden/ — P0 golden dataset（A2 所有，`data/golden/` owner=A2）

**用途**：这是 data 域的门禁回归集。`warehouse/pipeline.py --golden` 与 `warehouse/tests/test_golden.py`
会把每条用例走 **ODS 交换格式 → load_batches → build_dwd → run_quality_checks** 全链路，
断言分数/评级/阻断/违规集合。**任何一条不通过 = 门禁失败，下游不得消费数据。**
它同时也是口径的可执行证据：新增/修改口径时，先改 `docs/metrics/`（H4 签字），再补 golden。

**权威顺序**：`docs/metrics/P0-metrics.md`（口径）→ `warehouse/quality/quality_config.json`（规则/阈值）
→ 本目录样本（回归证据）。样本不得反过来定义口径。

## 文件与命名

| 约定 | 说明 |
| --- | --- |
| 单一文件 | `p0_bars20.yaml`（文件名保留历史，现含 22 正例 + 9 负例；**不改名**，外部引用已固定） |
| 用例 id | `G01`…`G22` = 正例（必须 green、score=100、不被阻断）；`N01`…`N09` = 负例（必须按 `expect` 精确命中） |
| 边界标记 | 正例中 ST / 停牌 / 除权除息 / 涨跌停 / 新股首日 / ST 恰好 5% / ST 限价取整 等边界在 `title` 写明，`warehouse/tests/test_golden.py::BOUNDARY_CASES` 登记 |
| 编号只增 | 不回收编号；删条目不删语义，用新编号覆盖场景 |

## 正例（G*）语义

- `expect.grade: green`、`blocked: false`、质量分必须 100；`violations` 一般为 `[]`。
  例外：ST 正例（G05/G06/G21）含历史 bar（`trade_date < dim.as_of`）→ 允许且必须精确命中
  `["BIZ-03"]`（L80：ST 判定时点性限制，warn 不拖绿、不阻断）。
- 额外可断言：`score_min/score_max`、`revisions`（历史修正留痕，如 G19）、`hfq`/`qfq`（复权价格，如 G17）。
- 边界用例的意义是**钉住容易写错的方向**，例如：
  - `G22` 主板 ST **限价取整**：`10.05×1.05=10.5525→10.55`，收盘 10.55 即涨停（涨幅 4.9751%），
    锁死"用百分比直接判涨跌停"的错误；与 G21 合起来覆盖"恰好 5%"与"取整后触发"两个边界。
  - `G21` 主板 ST **恰好 +5.00%**：若实现把规则写成"严格 ≥ 上限即违规"，恰好 5% 会被误杀；
    若容差被滥用（例如对 +5.6% 也放行），`N05`（ST +6%）会失败。两条样本合起来锁死边界。

## 负例（N*）语义

- 每条只制造**一个**预期违规，`expect.violations` 是精确的 rule_id 列表（顺序无语义），
  另断言 `grade`/`blocked`；`raw_batches` 类负例断言 `rejected: true` + `error_contains`。
- 负例的验收目标是：**改坏一条数据 → 质量规则红灯 → 阻断下游**（task-6 验收项）。
- 例外：`N07`（非首日缺 `prev_close`）只有 BIZ-02 `warn`：**告警不阻断、不扣分**（L9），
  因此它断言 `grade: green` + `violations: ["BIZ-02"]`，用于验证 warn 与 blocker 的计分边界。

## YAML 字段（与 `warehouse/README.md §ODS 交换格式 v1` 对应）

```yaml
- id: Gxx
  title: 人能读懂的场景说明
  instrument: {instrument_id, exchange, code, name, board, security_type, list_status, lot_size, listed_at}
  as_of: 'YYYY-MM-DDTHH:MM:SS+08:00'   # 市场时点（收盘后）
  fetched_at: '...'                     # 采集时点，必须 >= as_of
  bars: [ {trade_date, open, high, low, close, volume, amount, prev_close}, ... ]  # 价格/金额写成字符串
  factors: [ {trade_date, factor}, ... ]        # 省略则每条 bar 自动用 1.0
  suspended: ['YYYY-MM-DD', ...]                # 停牌证据日（生成 suspended:true 行，不生成 bar）
  batches: [...]                                # 多条批次（幂等 / 历史修正 / 跨日），如 G18/G19
  raw_batches: [...]                            # 直接构造非法 ODS 信封，验证格式拒绝
  expect: {grade, blocked, violations, score_min?, score_max?, revisions?, hfq?, qfq_first?}
```

硬约束：金额/价格必须十进制字符串（JSON float 会被 loader 拒绝）；canonical 行禁止 tushare 字段名。

## 新增/修改一条样本，谁签

1. **提出**：A2（data 域 owner）提 PR/改动，必须附"为什么这条能钉住某个 bug 方向"。
2. **口径相关**（新增口径、改变正负例判据、涉及阈值/板块/复权口径）：**H4 签字**，同时先改 `docs/metrics/`。
3. **纯回归补强**（不改变口径，如补一条 ST 恰好 5% 边界）：A2 自签即可，但须全量回归通过。
4. **门禁消费方**：A11 只读消费，不得改本目录期望值；`tests/` 归 A11，`warehouse/tests/` 归 A2。
5. 任何样本改动都必须同时更新 `warehouse/tests/test_golden.py` 的计数/边界登记与本 README 清单。

## 门禁命令

```bash
python3 -m warehouse.pipeline --golden data/golden/p0_bars20.yaml  # 期望 31/31 通过
python3 -m pytest warehouse/tests -q                              # 含 golden 门禁测试
```

当前清单：G01 主板正常 / G02 创业板 +15% / G03 科创 / G04 北交所 30% / G05 主板 ST / G06 *ST 5.05% 容差 /
G07 主板涨停 10.02% / G08 跌停 / G09 创业板 20% / G10 北交所 30% / G11 除权除息 / G12 停牌无 bar /
G13 新股首日 / G14 低价股涨停 / G15 跨周末 / G16 退市历史 bar / G17 qfq/hfq 连续 / G18 多批次幂等 /
G19 历史修正 revision=1 / G20 +9.98% 未涨停 / **G21 ST 恰好 +5.00% 涨停边界** / **G22 ST 限价取整边界**；
N01 high<low / N02 high<max(open,close) / N03 非正价格或负量 / N04 主板 +11% / N05 ST +6% /
N06 因子≤0 / N07 缺 prev_close(warn) / N08 除权日缺参考价 / N09 内部缺日。
