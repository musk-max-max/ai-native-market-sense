# 数仓（A2）· P0 竖切片

A 股行情从 tushare 到 serving 的第一条竖切片：**ODS 批次 → DWD（不复权日线 + 复权因子）→ 指标 SQL / 质量门禁**。
本目录 owner=A2，reviewer=H4；跨目录边界见 `agents/ownership.yaml`。

## 1. 分层与契约

| 层 | 位置 | 内容 | 责任 |
| --- | --- | --- | --- |
| ODS | A1 的落地目录（本仓库外） | 我的**唯一输入**：canonical 批次文件 v1 | A1 |
| DWD | `warehouse/dwd/` | `dwd_stock_bar_daily`（不复权 OHLC）、`dwd_adj_factor`、`dwd_suspended_daily`、`dim_instrument`、`dwd_bar_revision`、`dwd_fundamental_report` | A2 |
| Serving | `warehouse/serving/schema.sql` | 只读 view：`serving_instrument` / `serving_quote_latest` / `serving_bar_daily` / `serving_factor_latest` / `serving_fundamental_summary` | A2 |
| 指标 | `warehouse/metrics/*.sql` | M01/M02/M04/M08（见 `docs/metrics/P0-metrics.md`） | A2 |
| 质量 | `warehouse/quality/` | 13 条规则 + 质量分（config 版本化） | A2 |

模型与端口依据 `contracts/`（A0 的 canonical 模型 ADR-002）：内部只认 `EXCH:CODE`，DWD 只存不复权价 +
每股累计因子，qfq/hfq 由 `warehouse/dwd/adjust.py` 确定性重算，不存三份 OHLC。

## 2. ODS 交换格式 v1（A1 → A2）

> 状态：**待 A1 确认**（通过 lead 约定，双方都不改对方目录）。实现：`warehouse/ods/loader.py`。

目录布局：

```
<ODS_ROOT>/<endpoint>/dt=<YYYY-MM-DD>/<batch_id>.json
endpoint ∈ {bar, adj_factor, instrument, fundamental}
```

批次信封（缺字段/类型不符 → `OdsFormatError`，整批拒绝入库，不猜测补齐）：

```json
{
  "batch_id": "20260930-bar-001",
  "endpoint": "bar",
  "schema": "bar.v1",
  "source": {
    "source": "tushare",
    "as_of": "2026-09-30T20:05:00+08:00",
    "fetched_at": "2026-09-30T20:06:00+08:00"
  },
  "rows_total": 3,
  "rows_rejected": 0,
  "rows": [
    {
      "instrument_id": "SSE:600519",
      "trade_date": "2026-09-30",
      "open": "10.00",
      "high": "10.50",
      "low": "9.90",
      "close": "10.30",
      "volume": "1000000",
      "amount": "10300000.00",
      "prev_close": "10.20"
    }
  ]
}
```

不变式与硬约束：

1. `rows_total == len(rows) + rows_rejected`；违反即整批拒绝。
2. **金额/价格必须是十进制字符串**，JSON float 一律拒绝（丢精度）；`volume` 单位=股且必须整数，`amount` 单位=元（C09）。
3. `as_of` / `fetched_at` 必须带 `+08:00` 时区（C18），且 `fetched_at >= as_of`（C04）。
4. canonical 行禁止出现 tushare 字段名（`ts_code`、`vol`、`pct_chg`、`turnover_rate`、`pe`、`pb`、`total_mv` 等，
   C01）；字段映射只允许在 `services/ingest/adapters/` 内。
5. `batch_id` 在同一 endpoint 下唯一（幂等键，C15）；重复批次整批拒绝。
6. `bar.v1` **必填** `prev_close`（涨跌幅基准 M08，除权日写除权参考价；首日/无基准可空，L7）；`suspended: true`
   为停牌**证据行**，由 A1 用 `suspend_d` 按交易日批量取（约 4,860 次/20 年，L8）——该日确实无行情，
   禁止补 0 或合成 K 线（C08）；不得用"停牌=无行"替代。
7. `adj_factor.v1` 行：`{instrument_id, trade_date, factor}`；`factor` 为**累计因子**，`1.0` = 该标的
   **最早可得因子日**（1990-12-19 前上市老股锚定 1990-12-19，L3 待 H4 会签）；DWD 不二次归一。
8. `instrument.v1` 行：`{instrument_id, exchange, code, name, board, security_type, list_status, lot_size?, listed_at?}`；
   交易所/板块组合合法性由 loader 校验（`SSE: main|star`、`SZSE: main|gem`、`BSE: bse`）。`lot_size` A1 按板块推导
   （科创板 200，其余 100），`board` 由代码前缀推导，不透传源端中文 market 枚举。
9. `fundamental.v1` 行（M06，A1 按 L16/L17 补）：必填 `instrument_id, report_period(YYYYQn), report_end_date,
   announced_at(+08:00), statement_basis(reported|restated), currency(CNY), revenue, net_profit`（金额=元、字符串、
   可负）；可选 `revenue_yoy_pct, net_profit_yoy_pct, eps, roe_pct, gross_margin_pct`（无值必须显式 `null`，
   禁止 0 冒充）；**不得出现** `trade_date/adjustment/suspended/factor` 等行情字段；批次分区 `dt=` 用
   `report_end_date`，`source.as_of` = 本批最大 `announced_at`。DWD 落 `dwd_fundamental_report`，
   PK=`instrument_id+report_period+statement_basis`，reported/restated 两套并存。

A1 的 raw payload（tushare 原始响应）**不进入我的读取路径**——审计/重放归 A1；我只消费 canonical 批次。

## 3. 复权语义（L3 待 H4 会签；A1 归一后提供，DWD 不二次归一）

- 因子：累计复权因子，`1.0` = 该标的**最早可得因子日**；1990-12-19 前上市老股锚定 1990-12-19。
  M02 收益在两种锚下等价，hfq 绝对价不同 —— 故该归一属复权算法变更，待 H4 会签。
- 后复权：`hfq = close × factor`（M02 收益口径，不受后续除权影响）。
- 前复权：`qfq = close × factor / factor(区间内最新交易日)`（仅画图，随 as_of 变化）。
- 内部计算结果量化到 4 位小数；DWD 不落 qfq/hfq 价格。
- 因子口径/算法变更属于 `must_escalate`（复权算法变更），先改 `docs/metrics/P0-metrics.md` + H4 签字。

## 4. 质量门禁

```bash
python3 -m warehouse.pipeline --ods-root <ODS_DISPLAY_ROOT> --internal-ods-root <ODS_INTERNAL_ROOT> --json   # L34 双 root；质量分 + 是否阻断
# 也可只给一个 root（其下含 display/ + internal/ 标准布局时自动识别）；旧平铺目录保持兼容：
python3 -m warehouse.pipeline --ods-root services/ingest/var/ods-smoke --json
python3 -m warehouse.pipeline --golden data/golden/p0_bars20.yaml  # 22 正例 + 9 负例回归（31/31）
python3 -m pytest warehouse/tests -q                               # 单测：格式/复权/评分/落库/文档一致性
# A1 录播冒烟批次端到端（ODS→DWD→质量→落库计划；仅 dry-run，不连库）：
python3 -m warehouse.load --ods-root services/ingest/var/ods-smoke --dry-run
```

- 权重 0.2/0.3/0.3/0.2，阈值 ≥95 green / 90–95 yellow / 85–90 red / <85 black；任一 blocker → black + 阻断下游。
- `<85` 或 `blocked=true` 时 CLI 退出码 1，下游任务不得消费该批次（硬门禁，`agents/README.md`）。
- 阈值与规则变更属于 `must_escalate`（质量阈值调整），须 H4 签字后同步改 `quality_config.json` 与 docs。

## 5. P0 限制（已登记的待确认项）

交易日历用自然工作日近似、ST 仅主板 5%、停牌证据行（L8 由 A1 提供，COMP-03 不降级）、修订保留窗口未定、
不做盘中实时（T 日 20:00 收盘数据）。**ODS 交换格式支持 market-wide 批次**（A1 P0 默认每交易日一个 `bar` 批次
+ 一个 `adj_factor` 批次，行形状与 per-instrument 模式一致），`load_batches` 按 batch_id 去重不变。
**instrument.v1 是必需项**（L34 标准布局里应在 `display` root 或旧平铺 root）：缺主数据时 pipeline / load fail-closed（退出码 2），因为 dim_instrument /
BIZ-01 板块幅度 / 首日豁免 / `serving_instrument` 都依赖它；decisions L17 已改判为 A1 **当前**任务（一次 `stock_basic` 调用），A2 不等排期。停牌标的的 Quote 只能用"停牌证据日"表达（无交易日历无法补成
"市场最新交易日"行，P1 接 trade_cal 后补齐）；财务数据未接入（M06 pending-data），
`serving_fundamental_summary` 当前恒返回 0 行。完整清单见 `docs/metrics/P0-metrics.md §7`。

## 6. Serving 接口（A3 的读取端口；签名见 `warehouse/serving/ports.yaml`）

数据流向：**A1 → ODS canonical 批次 → A2 DWD → serving 只读 view → A3 的 ServingRepo 端口**。
A1 只负责产出 ODS v1（不产出复权价）；A3 **只读 `serving.*`**，不直接查 DWD 表、不在 TS 里算 qfq/hfq。
view 定义（幂等，由 A13 在 bootstrap 按 `warehouse/dwd/schema.sql` → `warehouse/serving/schema.sql` 顺序执行）：

| view | 用途 | 关键口径 |
| --- | --- | --- |
| `serving.serving_instrument` | 证券维表 | dim 快照 + `source/as_of/staleness_ms`；`display_safe=false` 只能进内部评测态（L30） |
| `serving.serving_quote_latest` | 最新行情 | 最近 bar；停牌时 `suspended=true`、价格/涨跌幅 NULL；`limit_status` 按板块（M04） |
| `serving.serving_bar_daily` | 日线三口径 | 每根 bar 三行 `adj_type ∈ none/hfq/qfq`，价格由 SQL 按因子固化（M01/M02）；volume/amount 不调整 |
| `serving.serving_factor_latest` | 最新累计因子 | latest = 该标的全历史最新一条，与 `adjust.py` qfq 分母一致 |
| `serving.serving_fundamental_summary` | 财务摘要最近一期 | reported/restated 双口径并存，按 `announced_at` 取；P0 无数据 → 0 行（A3 返 404） |

TS 侧接口（A3 在 `services/market` 的 infrastructure 层实现，只做「查 view + 形状映射」）：

```ts
export type AdjType = 'none' | 'qfq' | 'hfq';
export interface SourceRef { source: string; as_of: string; staleness_ms: number; }

export interface BarsQuery {
  instrument_id: string;          // EXCH:CODE
  adj_type: AdjType;              // 默认 none（M01 主口径）
  from?: string; to?: string;     // 闭区间 [from, to]
  limit?: number;                 // 1..500，默认 120；repo 取 limit+1 判 has_more
}
export interface BarsPage { rows: BarRow[]; has_more: boolean; adjustment: AdjType; }

export interface ServingRepo {
  getInstrument(instrumentId: string): Promise<InstrumentRow | null>;
  getQuote(instrumentId: string): Promise<QuoteRow | null>;        // null=无数据；suspended=true=停牌
  getBars(q: BarsQuery): Promise<BarsPage>;                        // 无数据=空数组（200）
  getLatestFactor(instrumentId: string): Promise<FactorRow | null>;
  getFundamentalSummary(instrumentId: string): Promise<FundamentalSummaryRow | null>; // P0 恒 null
}

// 行类型（价格/金额/比率为十进制字符串，A3 在 HTTP 边界转 number）：
// InstrumentRow / QuoteRow / BarRow / FactorRow / FundamentalSummaryRow
// 字段与 view 列一一对应，逐字段定义见 warehouse/serving/ports.yaml 的 row_types。
```

三态与时效（契约强制，A3 不得自拼）：`getQuote` 返回 **有行情 / suspended=true（价格 NULL）/ null（数据未就绪）**；
每一行自带 `source`、`as_of`（+08:00）、`staleness_ms`（serving SQL 计算、钳制 ≥0），A3 原样放进
`meta.source`；`staleness_ms > 900000` 由 A3 按契约标 stale。
A13 需建只读角色并 `GRANT SELECT ON ALL TABLES IN SCHEMA serving`（不授 DWD 表）。

```bash
# 迁移/bootstrapping（A13；幂等）
psql "$DATABASE_URL" -f warehouse/dwd/schema.sql
psql "$DATABASE_URL" -f warehouse/serving/schema.sql
# 已有库升级（L30/L34；CREATE TABLE IF NOT EXISTS 不会补列）：A13 迁移执行
#   ALTER TABLE dim_instrument ADD COLUMN IF NOT EXISTS display_safe boolean NOT NULL DEFAULT false;
#   ALTER TABLE dim_instrument ALTER COLUMN display_safe SET DEFAULT false;
#   UPDATE dim_instrument SET display_safe = false;  -- 历史行一律先置 false，等 manifest 证据回放再翻
#   psql ... -f warehouse/serving/schema.sql  -- 重建 view
```


### 6.1 研究数据集（KD-INGEST-CONSUME；内部只读，不接 C 端）

A1 把 7 个研究数据集写入 `<ODS_ROOT>/internal/<endpoint>/dt=<trade_date>/<batch_id>.json`（schema `<endpoint>.v1`，
信封与 ODS v1 相同）。A2 只消费 ODS，**不二次换算单位**（A1 适配层已把万/千/手换成元/股/百分数）。

| DWD 表 | serving view | 关键列 |
| --- | --- | --- |
| `dwd_daily_basic` | `serving.serving_research_daily_basic` | close / pe / pe_ttm / pb / ps / ps_ttm / turnover_rate_pct / volume_ratio / total_market_value / limit_status |
| `dwd_index_daily` | `serving.serving_research_index_daily` | OHLC / prev_close / change / pct_change_pct / volume / amount（5 个基准指数） |
| `dwd_top_list` | `serving.serving_research_top_list` | reason 原文保留（M05）；lhb_* 金额 |
| `dwd_top_inst` | `serving.serving_research_top_inst` | 机构席位明细：seat_name / side(0 买、1 卖) / buy|sell_amount / net_buy_amount |
| `dwd_moneyflow` | `serving.serving_research_moneyflow` | 五档买卖 volume/amount + net_inflow_* |
| `dwd_margin` | `serving.serving_research_margin` | 两融余额/买入/偿还/融券（PK exchange+trade_date，无 instrument_id） |
| `dwd_hk_hold` | `serving.serving_research_hk_hold` | 北向持股 volume/ratio/channel |

边界（不可越线）：

- **不接 C 端契约**：这 7 个数据集只进 internal root + DWD + `serving_research_*` 内部 view；C 端仍
  `internal_eval` 恒 403，`serving/ports.yaml` 不新增方法。B2 功能点走 `/v1/internal/*`，需 H2 签字后另立任务。
- **字段映射 provisional**：保持 A1 canonical 字段名，不重命名；待 H4 对齐后才可作为正式指标口径。
- **top_inst 依赖 5000 分档**：数据缺失时 DWD 无行、view 返回空，不报错（load/pipeline 不因缺该 endpoint 失败）。
- 研究 DWD 为 **last-write-wins**（无 revision 列）；质量规则 RES-01..04（工作日 / 量纲 / 外键 / as_of 及时性）覆盖。
- 本地链路验证（fixture 由 A1 `research.map_row` 生成）：

```bash
python3 -m warehouse.load \
  --ods-root warehouse/tests/fixtures/research_ods --profile dev --dry-run
python3 -m pytest warehouse/tests/test_research.py -q
```

## 7. 落库（P0 唯一写库路径：`warehouse/load.py`）

链路：`ODS 批次（L34：display + internal 两个 root）→ load_ods_roots（格式/来源校验，按 root 标记 origin）→ build_dwd（复用同一份 DWD 行）→ 质量门禁 → 单事务 upsert`。
**质量门禁与落库走同一条代码路径**：质量分 `red` / `black` / `blocked` 时**先原子写 `quality.json`（证据）
再拒绝写库并退出码 1**，不连接数据库（没有 `--force`，也不做降级写入 —— 降级写入会让 CI 学会绕过门禁）。
`yellow` 写库并告警（报告 `level=yellow`）。

**ingest-once 契约（`tests/e2e/docs/INGEST-ONCE-CONTRACT.md` §1/§2，A12）退出码**：

| 码 | 含义 |
| --- | --- |
| 0 | 落库成功（yellow 也算成功） |
| 1 | 质量红/黑拒绝写库（报告已先写） |
| 2 | 环境/DB/schema 错误（DSN、psycopg、连接、写库回滚、报告无法落盘） |
| 3 | 输入缺失/为空（ODS 无批次、缺 instrument 主数据、ODS/manifest 校验失败） |

`QUALITY_REPORT_PATH`（默认 `/state/quality.json`）由 `warehouse.load` 原子写（tmp + fsync + rename），
schema：`{schema_version:1, level, score, checked_at, counts:{dwd_rows,serving_rows}, reasons}`；
`score` 归一化到 [0,1]，`black` 归并为 `level=red`，`reasons` 在红/黄时非空。
**报告是证据，退出码是结论**，两者都要有（A12 的 `seed_once.sh` 第 3 步依赖报告，缺它恒 `REPORT_INVALID`）。

```bash
# 只出写库计划（不连库；用于 CI/评审）
python3 -m warehouse.load --ods-root <ODS_DISPLAY_ROOT> --internal-ods-root <ODS_INTERNAL_ROOT> --dry-run

# 真实落库（DSN 也可用环境变量 DSN / DATABASE_URL）
python3 -m warehouse.load --ods-root <ODS_DISPLAY_ROOT> --internal-ods-root <ODS_INTERNAL_ROOT> \
  --dsn "postgresql://user:pass@host:5432/db"
```

- **依赖**：`warehouse/requirements.txt` 只有 `psycopg[binary]>=3.1,<4` 一个；不在 `services/api` 声明（API 用只读角色，
  不该有能力写库），不引入 ORM。builder/门禁/执行计划不 import 驱动，单测无需安装。
- **幂等 upsert**：`dim_instrument(instrument_id)`、`dwd_stock_bar_daily(instrument_id,trade_date)`、
  `dwd_adj_factor(instrument_id,trade_date)`、`dwd_suspended_daily(instrument_id,trade_date)`、
  `dwd_fundamental_report(instrument_id,report_period,statement_basis)`；同批次重放结果完全相同。
  `dwd_bar_revision` 只增（`ON CONFLICT DO NOTHING`），历史修正不允许被覆盖。
- **停牌**：停牌证据行与同键 bar 互斥 —— 写库计划先删同键 bar（C08：停牌日不建行），再写停牌证据。
- **单事务**：任一语句失败整体回滚，serving 不会看到半批数据。
- **ODS root 双目录（L34：物理隔离比字段标记更难绕过）**：`ODS_DISPLAY_ROOT` 只接 `csv` / `official_api`
  渠道批次（`<root>/<endpoint>/dt=.../<batch_id>.json`），`ODS_INTERNAL_ROOT` 接 tushare 交叉校验批次；
  调用方给 `--ods-root`（display）+ `--internal-ods-root`（internal），或只给一个其下含 `display/` + `internal/`
  的父目录（自动识别）。**旧平铺单 root（如 `services/ingest/var/ods-smoke`）保持兼容**，行为不变。
  两个 root 的批次会合并做全局 `batch_id` 唯一校验（跨 root 重复直接拒绝）。
- **display_safe（L30/L34/L40 + H4 2026-11-04 裁定；证据式、fail-closed，DEFAULT false；裁定见 agents/decisions.md L40/L42/L43）**：
  `dim_instrument.display_safe` 不从 ODS 行取，**不能靠目录位置信任**。派生规则：
  `display_safe = (origin=='display') AND (manifest 有该 instrument 的 succeeded instrument_import) AND
  (channel ∈ {manual_import, authorized_download, official_api}) AND（快照文件字节哈希通过且
  快照内嵌 checksum/rows 与事件一致）`。只有 `internal` 批次 → FALSE；internal 批次不得覆盖 display
  的维表行，也不得把已展示标的降级。旧平铺 root 无可展示性证据 → 全部 FALSE（离线回归语义，
  不回退 manifest 默认值）。
  manifest 完整性（读取侧复算，H4 2026-11-04 裁定 + lead L52；agents/decisions.md L43/L52）：`event_id` 全局唯一、`finished_at` 非降序、
  每条事件 `hash = sha256(prev_hash + "\n" + canonical_json)`（canonical = 键排序、紧凑分隔符、UTF-8、
  排除 `prev_hash`/`hash` 两键）、`prev_hash` 接上一条 hash（首条 = 64 个 0，不用 `GENESIS` 字符串）、
  `manifest.head`（文件，JSON `{"schema_version":1,"count":n,"last_hash":"...","updated_at":"..."}`）：
  `schema_version` 必须为 1（缺失报错）、count 与非 synthetic 事件数一致、last_hash 与末条事件一致，
  **未知键忽略**（head 会演进，读取方不假设键集固定）；全 synthetic 目录没有 head。
  `synthetic: true` 整条跳过（不进 count、不进链、不参与派生，也不校验其链；下一条真实事件的 prev_hash
  跨过 synthetic 行接最后一条真实 hash）；synthetic 行声明 `display_safe:true` 一律报错（样例不得充当展示证据）。
  **快照证据（H4 2026-11-04 裁定）**：`checksum_sha256` 是来源 CSV 内容哈希（证明内容一致），**不能**证明
  快照文件没被改；成功事件还必须带 `snapshot_path` + `snapshot_sha256`（快照文件字节 sha256），
  loader 严格复算文件字节哈希并拒绝越出 manifest root 的路径。两字段缺失 = 无证据：prod 报错，
  dev 降 false（不产生 true）；旧格式（只有 checksum）在 dev 下最多派生出 false。
  生产 profile（`--profile prod`，默认）下：display root 有 instrument 批次却没有 `--manifest-root`、
  或某标的缺 positive 证据、或 manifest 缺 hash 链/`manifest.head`（count/last_hash）、`event_id` 重复、
  `finished_at` 倒序、快照缺失/不一致 → **直接报错退出，不降级**。离线回归用 `--profile dev`
  （仍不产生 true，只是不因缺证据失败）。展示判定 = `entitlement_ok AND display_safe`；
  `display_safe=false` 的标的不进 C 端结果集，但保留内部评测态。
  **状态：closed（H4 2026-11-04）**——A1 写入侧两问已闭合：(a) 成功事件增加 `snapshot_path` +
  `snapshot_sha256`（快照文件字节哈希），(b) synthetic 不参与链/count；读取侧已按此实现并由
  `warehouse/tests/test_display_safe.py` 锁定，本节无悬案。
- **验证边界（如实声明）**：本机没有 PostgreSQL，`warehouse/tests/test_load.py` 验证的是 builder 生成的 SQL/列/
  主键/参数绑定、注入安全、门禁在何处拒绝、执行顺序与计数；真实写库只在 compose / CI 的 PG 上跑
  （设 `PG_TEST_DSN` 的集成测试）。README 不声称"已验证落库"。

## 8. 落库镜像（`warehouse/Dockerfile`）

`warehouse/Dockerfile` 是单职责镜像：python 3.12 + `psycopg[binary]` + `warehouse` 包，入口
`python -m warehouse.load`。构建上下文是仓库根：

```bash
# 默认用境内 pip 镜像（ECS 实测官方 pypi.org 不通）
docker build -f warehouse/Dockerfile -t market-sense/warehouse-load .

# 境外 CI/构建机可覆盖回官方源
docker build --build-arg PIP_INDEX_URL=https://pypi.org/simple/ \
  -f warehouse/Dockerfile -t market-sense/warehouse-load .
```

pip 源是 build-arg（`PIP_INDEX_URL`，默认 `https://mirrors.aliyun.com/pypi/simple/`），
不改 `requirements.txt`；证据：lead 2026-11-04 在 ECS 实测官方源无响应、阿里云 200/2.9s，
临时 Dockerfile 改 `-i` 后 build 成功并跑通（quality=100 green，rc=0）。

为什么不塞进 `services/ingest/Dockerfile`：让"抓数"与"写库"共享同一个镜像会同时放大攻击面与发布节奏；
compose 里是独立的一次性服务 `warehouse-load`（`restart: "no"`）。

**验证状态：未构建验证**

原因：本机没有容器运行时，磁盘也不够。已静态核对：只用 Python 标准库 + psycopg、
不读仓库内相对路径以外的资源、ENTRYPOINT 与 CLI 一致；真实构建/运行留给 A12/A13 的 compose/CI。

compose 约定（A12 2026-11-04）：`warehouse-load` 服务**覆盖 entrypoint** 为 `sh /e2e/warehouse_load_once.sh`
（否则镜像 ENTRYPOINT 会把脚本当子命令参数）；env 为 `DATABASE_URL`、`ODS_ROOT=/data/ods`、
`AUDIT_ROOT=/data/audit`、`QUALITY_REPORT_PATH=/state/quality.json`。镜像内预建 `/state` 并
`chown 10001:10001`：named volume 会继承该属主；A12 实际用 host bind（`./.state:/state`，契约 §4 要求
报告落在宿主可查路径），由 `up.sh` 事前 `mkdir -p && chmod 0777`，否则报告写入会因 EACCES 退 2（环境错误）。
`AUDIT_ROOT` 必须直接指向含 `manifest.jsonl`+`snapshots/` 的那层；`/data/ods`、`/data/audit` 只读挂载即可。

## 9. 交付纪律（lead 2026-11-04 裁定，通用规则）

1. **契约是唯一真源，口头裁定不是。** 当口述与已发布契约冲突时，契约赢；口述方须明说作废了哪一句。
   本仓实例：`warehouse.load` 退出码 `0=成功 / 1=质量红或黑拒绝 / 2=环境/DB/schema / 3=输入缺失或为空`
   （见 `tests/e2e/docs/INGEST-ONCE-CONTRACT.md` §1，A12 的 `seed_once.sh` 按此映射），lead 口述的
   "red 退 3" 已作废——退出码是归因通道，不是随意返回码。
2. **「交付但未验证」必须单独成行**，不能写在括号里或句尾。括号里的验证边界没人读，等同于谎报已验证。
3. 本 README 中每条外部依赖的验证状态都要可追溯到一条命令或一个 agent 的实测输出；没有就写"未验证"。

## 10. 合成 fixture 证据哈希（L79）

`warehouse/tests/fixtures/display_manifest/` 是 A2 读取侧的合成 fixture（也供 A1 反向校验），
非 11-12 授权件。证据包口径：**一版一个目录；内容变则换名/升版，不许就地改**（H4 2026-11-04）。

当前 `SHA256SUMS`（逐文件哈希、不含自身）的 sha256 = `7f2a19491b38826d15c90f460033014b6de016c805e6d8a52994108879af6cb4`。

哈希变更记录（旧值保留可追，不删除）：

| 时间 | 旧 → 新 | 原因 | 数据文件是否变化 |
| --- | --- | --- | --- |
| 2026-11-04 | `a4bfd64834aab50c1ed8f50a62adeaaa1c7fab1acd65f4dc6f61429da5628c8b` → `7f2a19491b38826d15c90f460033014b6de016c805e6d8a52994108879af6cb4` | 审计文档去会话 message ref，只改了 `README.md` / `manifest.head` 的说明文字 | **否**：`manifest.jsonl`=`0bf426f9…`、两张快照=`3239b3ee…`/`bb46f2f5…` 均未变；A/B 事件 hash 未变 |

旧值 `a4bfd648…` 已作废，仅作历史记录；任何下游证据包若仍引用它，**按新版本另起目录**，不得就地改编号。

下一版 fixture 起拆两层哈希（H4 建议，本次不改）：`payload_digest`（仅 `manifest.jsonl` + `snapshots/`，
绑定数据内容）与 `bundle_digest`（含 README/head/SHA256SUMS 等说明文件）。这样改一句文档说明不会
让"数据证据"的哈希变一次，绑定力反而更强。
