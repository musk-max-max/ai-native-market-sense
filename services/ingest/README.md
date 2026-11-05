# services/ingest — 数据接入（A1）

S0 竖切片：`bars` 日线（不复权源真值）+ 复权因子 + 停牌证据 + `instrument`
主数据（L17）+ 最小财务摘要（L16）→ 不可变 raw 台账 / checkpoint / ODS 批次
文件（供 A2 数仓消费）。端口与 canonical 模型见 `contracts/` 与
`docs/adr/ADR-002-datasource-port.md`。

## 分层与硬边界

- `market_ingest/adapters/`：**唯一**允许出现数据源（tushare）字样、`ts_code`、
  源接口名/字段名、单位换算（手→股、千元→元）的地方。业务层只依赖
  `ports.MarketDataSource` 与 canonical 模型（`EXCH:CODE`、股、元）。
- 边界闸：`tests/test_boundaries.py` 扫描 `src/` 下除 `adapters/` 外的源码，
  出现源字样即失败（C01）。**需 A0/A11 在 CI grep 规则中豁免 `adapters/` 与
  A12 录播夹具**（原始 payload 必然含 `ts_code`），否则 CI 无法同时满足 C01
  与录播要求（已在 handoff 中提出）。
- 令牌只从环境变量 `TUSHARE_TOKEN` 读取；`DATA_SOURCE_MODE=replay` 时放松 token
  校验（占位 `replay-no-auth`），端点优先级 `options.endpoint` > `TUSHARE_API_URL`
  > 默认端点。

## 快速开始

P0 默认模式是**按交易日全市场拉取**（L11）：省略 `--instruments` 即 market-wide，
每个交易日 3 次调用（日线 + 全市场因子 + 停牌名单），checkpoint 以 `trade_date` 为粒度。

```bash
cd services/ingest
PYTHONPATH=src python -m market_ingest sync-bars \
  --start 2005-01-01 --end 2025-12-31 --dry-run
```

`--dry-run` 只打印预算（不调用数据源、不写库）：

| calls_per_trading_day | × trading_days | + anchor_calls | = total_calls | / effective_per_minute | = eta_minutes |
|---|---|---|---|---|---|
| 3 | 5093 | 5000（首跑，仅一次） | 20280 | 400 | 51 |
| 3 | 5093 | 0（锚已缓存/续跑） | 15280 | 400 | 39 |

按标的模式仍保留（小范围补数据/联调）：`--instruments SSE:600519,SZSE:000001`
（每标的日线 1 次 + 因子 1 次 + 首跑锚 1–2 次，停牌名单全市场共享）。

主数据与最小财务批次（L16/L17，均一次性、无 checkpoint）：

```bash
# 一次 stock_basic 取全量在册 → instrument.v1 批次（固定 1 次调用）
PYTHONPATH=src python -m market_ingest sync-instruments --dry-run

# 切片 3–5 标的的最近一期财务 → fundamental.v1 批次（每标的 2 次调用：
# fina_indicator 比率 + income 绝对值；无已披露数据不产行，serving 返 404）
PYTHONPATH=src python -m market_ingest sync-fundamentals \
  --instruments SSE:600519,SZSE:000001 --dry-run
```

预算口径：instrument = 1 次（全市场固定）；fundamental = 2 × 切片标的数
（本次 S0 为 3–5 标的 → 6–10 次，可忽略）。

### 展示用基础信息：交易所 CSV 导入（合规硬条件）

C 端白名单内的基础信息（代码/简称/交易所/法定板块/上市状态/上市日期）**不得经
tushare 取得**（lead m00796）。`instrument.v1` 因此有两条路：

- tushare `stock_basic` 路径（默认 `auto` 且未给 CSV）：产物只作**内部交叉校验**与
  测试，manifest 记 `channel=tushare`、`display_safe=false`，展示态校验必须拒绝；
- CSV 自建导入路径（`--source csv`）：仓库内维护 `data/instruments/base_info.csv`
  （当前切片 5 只，全量在册后续补），落同一 `instrument.v1` shape，供 C 端白名单。

CSV 列：`instrument_id,name,board,list_status,list_date[,change_basis_url]`
（缺列/未知列/点号格式/非法日期/空名即整批失败；`change_basis_url` 用于更名、退市等
变更的公告依据）。

```bash
# 预览：解析 + 与上一版快照 diff，不写事件/快照/ODS
PYTHONPATH=src python -m market_ingest sync-instruments \
  --source csv --csv-file ../../data/instruments/base_info.csv --dry-run

# 正式导入（必须带齐取证字段，缺一项退出码 2）
PYTHONPATH=src python -m market_ingest sync-instruments \
  --source csv --csv-file ../../data/instruments/base_info.csv \
  --channel authorized_download \
  --source-url https://example.invalid/exchange/list \
  --terms-version v1 --terms-file /path/to/terms.txt \
  --credential-ref sha256:<下载凭证哈希> \
  --operator "$DATA_IMPORT_OPERATOR" \
  --manifest-root var/audit --ods-root var/ods
```

manifest（H4 m00801）：append-only JSONL `<manifest-root>/manifest.jsonl`，事件写一次、
无覆盖/删除接口；条款全文快照按 sha256 内容寻址存 `<manifest-root>/terms/<sha>.txt`；
每批快照 `<manifest-root>/snapshots/instruments-<checksum>.json` 供下一版 diff。
成功事件要求 `source_url + terms_version + 条款快照路径/哈希 + credential_ref + operator`；
失败/中断/阻断同样写事件（`status` 取 succeeded/failed/interrupted/blocked）。
操作人 = `--operator` 或 `DATA_IMPORT_OPERATOR`；凭证只记路径或 sha256，不落明文。

**审计完整性（H4 m01376）**：每条真实事件带 `prev_hash` 与 `hash`
（`hash = sha256(prev_hash + "\n" + canonical_json(event 去掉 prev_hash/hash))`，
首条 `prev_hash="0"*64`（64 个 0，不用字符串哨兵）；canonical = `sort_keys`、UTF-8、无空格）；同 root 下每次 append 原子更新
`manifest.head = {"schema_version":1,"count","last_hash","updated_at"}`，读取方要求
schema_version==1、未知键忽略。`--synthetic` 生成样例事件（`"synthetic": true`），
**不参与 head/count 且 display_safe 恒 false**；真实批禁止
携带该字段。时间戳序列化为 UTC（毫秒 + `Z`）。读取方用
`PYTHONPATH=src python -m market_ingest verify-manifest --manifest-root <root>`
校验链断裂 / count 不符 / head 缺失 / event_id 重复 / finished_at 倒序；
跨域互验：`warehouse/tests/fixtures/display_manifest/`（A2 读取侧 fixture）必须可复算（缺失则 skip）；
并逐条回算 succeeded 事件的快照文件字节 sha256、快照内嵌 checksum 与 rows 数（改/删快照即报错）。
**DEMO 根**（目录里有 `DEMO` 标记文件，如 `var/audit-demo/`）默认拒绝
`verify-manifest`，只有 `--allow-demo` 可做机制冒烟；release 证据脚本不得引用。

**内容哈希 ≠ 取数凭证（H4 m01346）**：`checksum_sha256` 是批次内容身份（与
`snapshots/instruments-<checksum>.json` 同名）；`source_sha256` 是原始来源载荷
（如 CSV 文件）哈希；来源证明另看 `channel + source_url + run_id + credential_ref`。

冲突自动阻断、裁决人工：代码唯一性、名称↔代码、板块与代码前缀不一致、相对上一版
无公告依据的更名/状态变更/消失。单批冲突 ≤5 条输出 diff 待人工终审（事件 `blocked`、
退出码 **4**，不写 ODS）；>5 条整批退回查来源。

退出码：`0` 成功 / `1` 失败 / `2` 参数或取证缺失 / `4` 冲突阻断待裁决。

**切片回补（3–5 标的，E2E/验收用）**：用 per-instrument 模式（不要用 market-wide，
那是全市场 3 次/日）。默认 `--budget-calls` 1000，够「5 标的 × 最近两年」的切片；
区间只要落在上市之后，实际调用 ≈ 5(bar) + 5(因子) + 10(锚) + 少量停牌日，通常 < 100 次：

```bash
PYTHONPATH=src python -m market_ingest sync-bars \
  --instruments SSE:600519,SZSE:000001,SZSE:300750,SSE:688001,BSE:830799 \
  --start 2024-01-01 --end 2025-12-31 --ods-root var/ods
```

注意：区间若跨到标的上市之前，缺失 bar 会被当成「停牌待取证」而按交易日触发
停牌名单查询（预算上限=区间交易日数）；长区间切片需先用 `instrument.v1.listed_at`
裁剪区间（回补编排属后续任务），或显式调低/调高 `--budget-calls`。

真实运行（生产只跑增量，令牌由运维/H4 注入）：

```bash
export TUSHARE_TOKEN=...           # 禁止写进仓库/配置
PYTHONPATH=src python -m market_ingest sync-bars \
  --start 2024-01-02 --budget-calls 1000 --calls-per-minute 500 \
  --ods-root var/ods
```

`--budget-calls` 是本次运行硬上限（配置默认 1000，够切片与单年 market-wide 增量），
全量回补必须显式给足（如 `--budget-calls 21000`），否则会按预算中断（退出码 3），
这是预期行为，不是数据错误。

调度入口：仓库根 `jobs/sync_bars.py`（生产只跑增量；退出码 3 表示中断，可原命令重跑续跑）。

## 确定性时钟（e2e/回放，A12 m01420）

所有「取当前时间」的路径最终走 `models.market_now()`；e2e/回放必须 pin：

```bash
export MARKET_NOW=2026-11-03T15:00:00+08:00   # ISO 8601，必须带时区；缺省才用系统时间
# 或每条命令加 --now 2026-11-03T15:00:00+08:00
```

它同时决定 adj_factor 锚点区间（`ANCHOR_START → today`）、`fetched_at`/`as_of`、
checkpoint 日期、quota 周期与台账时间戳，避免录制隔天失效。

## 容器（e2e / K8s）

- `services/ingest/Dockerfile`：`python:3.12-slim`，非 root（uid 10001），
  `PYTHONPATH=/app/services/ingest/src`，入口 `python -m market_ingest`（子命令同上）。
- compose 构建上下文是仓库根（`context: ../..`）；镜像内不建议用裸 `var/`：
  建议挂载 `/data/ods`（`--ods-root /data/ods`）、`/data/ingest.db`（`--db`）、
  `/data/audit`（`--manifest-root`），把 ODS/台账/审计证据都放到持久卷。
- **读容器安全上下文**：worker 容器是 `readOnlyRootFilesystem: true` 且只挂 `/tmp`；
  `var/audit` 在容器内重启即丢，不是审计证据。生产 manifest 必须显式放 PVC 或对象存储
  （H4 m01064）；本地/CI 用仓库内 `var/` 可以。
- e2e 录播：`DATA_SOURCE_MODE=replay` + `TUSHARE_API_URL=http://<replay-proxy>`，
  `FIXTURES_DIR` 由代理消费；`MARKET_NOW` 必须与录制时一致（见上一节）。
  seed 两步（compose 里同 `MARKET_NOW`）：

```bash
# 1) 展示用基础信息（CSV → display root；证据参数缺一退出码 2）
python -m market_ingest sync-instruments --source csv \
  --csv-file /app/data/instruments/base_info.csv --channel manual_import \
  --operator e2e-seed --synthetic \
  --source-url https://example.invalid/e2e/base_info.csv \
  --terms-version synthetic-terms-v1 \
  --terms-file /app/services/ingest/config/terms-synthetic.txt \
  --credential-ref sha256:$(sha256sum /app/data/instruments/base_info.csv | cut -d' ' -f1) \
  --manifest-root /data/audit --ods-root /data/ods --db /data/ingest.db

# 2) 行情（录播代理；budget 100 够 5 个交易日）
python -m market_ingest sync-bars --start 2026-10-28 --end 2026-11-03 \
  --ods-root /data/ods --db /data/ingest.db --budget-calls 100
```

## 配额与续跑

- 限流只吃套餐配额的 80%：`effective = floor(calls_per_minute × (1 - reserve_ratio))`，
  周期（日）配额同样打 8 折；`--budget-calls` 是本次运行的硬上限，**不**再二次打折。
- 配额耗尽 → 退出码 3（interrupted），不是数据错误；已成功 chunk 的 checkpoint
  保留，重跑从下一个交易日起续跑。market-wide 模式只记「哪天完成」，续跑从
  `trade_date + 1` 开始（L11：与上游按日修正边界对齐）。
- `--budget-calls` 估算偏保守（首次运行含每标的 1–2 次因子锚调用）；续跑时锚已持久化
  到 `ingest_factor_anchor`，实际调用更少。
- SQLite（`var/ingest.db`）：`ods_raw_page` 按 response 哈希幂等（重放不重复）、
  只追加（UPDATE/DELETE 触发器 ABORT）；`ods_rejected_row` 是 DLQ；批次表
  `ods_batch` 记录成功/失败/中断与行数。ODS 批次文件才是 A2 的读取路径，
  SQLite raw 只作审计。

## 两种抽取模式（L11/L12）

- **market-wide（P0 默认）**：`fetch_market_snapshot / fetch_market_factors /
  fetch_market_suspensions` 按 `trade_date` 各 1 次调用拉全市场，adapter 侧批量
  映射后按日写 `bar.v1` + `adj_factor.v1` 批次。市场级方法属于 adapter 的批量
  抽取能力，**不进** `MarketDataSource` 端口（L12）。
- **per-instrument**：端口 `list_bars` 逐标的逐 chunk，用于小范围补数/联调；因子
  窗口与锚、停牌证据规则相同，产出同样的 ODS v1 行。
- 两种模式共用同一套 mapper、单位换算（手→股、千元→元）与 ODS 落地。

## ODS 交换格式 v1（A2 读取路径）

### 渠道隔离根（L34，写死；A2/A13 按此读）

单 root + 固定子目录（部署只配一个可写路径，少一个漏配机会）：

```text
<ODS_ROOT>/display/<endpoint>/dt=<分区日>/<batch_id>.json    # 只接 csv / official_api 渠道批次
<ODS_ROOT>/internal/<endpoint>/dt=<分区日>/<batch_id>.json   # 适配层交叉校验 + 行情/财务批次
```

- `--ods-root` 是**父目录**；CLI 内部按命令路由：`sync-bars`/财务/`sync-instruments`
  （tushare 交叉校验）→ `<root>/internal`；`sync-instruments --source csv` → `<root>/display`。
- `display` 下的批次可进展示态（`display_safe=true`）；`internal` 下的批次
  **不得**进 C 端结果集（C 端结果集 = `entitlement_ok AND display_safe`）。
- A2 侧 `pipeline`/`load` 支持两种读法：①`--ods-root <父目录>` 自动识别 `display/`+`internal/`；
  ②`--ods-root <display 目录> --internal-ods-root <internal 目录>` 显式分开。按来源 root 赋
  `dim_instrument.display_safe`（display 批次 TRUE / internal FALSE），不改 ODS v1 行/信封格式（L30/L34）。

### 布局与行形状

`<端点上文中的 root>/<endpoint>/dt=<分区日>/<batch_id>.json`

- 分区日 = 批次内最小 `trade_date`；`batch_id` 形如
  `ing-YYYYMMDDTHHMMSS-<slug>[-factor]`，同一 endpoint 全局唯一。
- 信封：`{"schema":"bar.v1"|"adj_factor.v1","endpoint":...,"batch_id":...,
  "source":{"source":"tushare","as_of":...,"fetched_at":...},
  "rows_total":...,"rows_rejected":...,"rows":[...]}`；`rows_total = len(rows) + rows_rejected`。
- `bar.v1` 行：`{instrument_id, trade_date, open, high, low, close, prev_close?, volume(股), amount(元)}`；
  停牌证据行：`{instrument_id, trade_date, suspended: true}`（L8，每交易日全市场批量取）。
  `prev_close` 首日可空（L7）；缺失/非法禁止补 0（C10），坏行进 DLQ 不静默丢。
- `adj_factor.v1` 行：`{instrument_id, trade_date, factor}`，**已按原始值/锚归一**
  （锚=该标的 1990-12-19 起最早因子），下游不得二次归一（L3，待 H4 会签）。
- `instrument.v1` 行：**display root 恰好 7 字段**
  `{instrument_id, name, exchange, board, security_type, list_status, listed_at}`
  （`code` 由 instrument_id 派生不重复存、`lot_size` 只进 internal root，H4 m01335）；
  internal root 为 9 字段（多 `code`/`lot_size`）。出现白名单外字段即整批失败。
  `board` 由代码前缀推导（688/689→star、300/301→gem、8/4→bse、其余 main），
  `lot_size` 科创 200 / 其余 100；一次 `stock_basic` 全量在册覆盖语义（不做 checkpoint）。
- `fundamental.v1` 行：`{instrument_id, report_period(YYYYQn), report_end_date,
  announced_at(+08:00), statement_basis, currency, revenue, net_profit, 可选
  revenue_yoy_pct/net_profit_yoy_pct/eps/roe_pct/gross_margin_pct}`；金额=元、比率=
  百分数、十进制字符串（允许负），缺失比率不写（loader 也接受 null，但不会当 0）；
  `dt=` 分区 = 批次内最大 `report_end_date`，`source.as_of` = 最大 `announced_at`。
- 只采不复权源真值；三口径（qfq/hfq）复权在 DWD/读侧用因子表计算。

## 研究数据集接入（KD-AIP0-INF-05）

按 ADR-007 §D5 第 2 批，把研究域依赖的 7 个数据集落到 **ODS 层**（DWD/DWS 归 A2）。
接口名/积分档/源字段/单位换算全部集中在
`src/market_ingest/adapters/tushare/research.py` 的 `DATASET_SPECS`（`ResearchDataset`），
下游（ODS/sync/CLI）只认 canonical 行；H4 确认字段/积分档后**只改适配层**。

| dataset | 源接口 | 最低积分 | 调用粒度 | ODS endpoint |
| --- | --- | --- | --- | --- |
| `daily_basic` | `daily_basic`（doc 32） | 2000 | 按交易日 1 次/全市场 | `daily_basic.v1` |
| `index_daily` | `index_daily`（doc 95） | 2000 | 按交易日 × 每个指数 1 次（源要求代码必填） | `index_daily.v1` |
| `top_list` | `top_list`（doc 106） | 2000 | 按交易日 1 次 | `top_list.v1` |
| `top_inst` | `top_inst`（doc 107） | **5000**（特色数据） | 按交易日 1 次 | `top_inst.v1` |
| `moneyflow` | `moneyflow`（doc 170） | 2000 | 按交易日 1 次 | `moneyflow.v1` |
| `margin` | `margin`（doc 58） | 2000 | 按交易日 1 次 | `margin.v1` |
| `hk_hold` | `hk_hold`（doc 188） | 2000 | 按交易日 1 次 | `hk_hold.v1` |
| `stk_limit` | `stk_limit`（doc 183） | 2000 | 按交易日 1 次（2007-01-04 起） | `stk_limit.v1` |
| `fina_indicator` | `fina_indicator`（doc 79） | 2000 | **逐标的** × 区间 1 次（单次最多 100 行） | `fina_indicator.v1` |
| `index_classify` | `index_classify`（doc 181） | 2000 | 快照 × L1/L2/L3 三次（SW2021） | `index_classify.v1` |
| `index_member_all` | `index_member_all`（doc 335） | 2000 | 快照 × 2 次（`is_new=Y` + `N`，拉全量含历史退出） | `index_member_all.v1` |

```bash
# 预算（不联网）：datasets × 交易日 + index_daily 额外 × 指数数 + 日历 1 次
PYTHONPATH=src python3 -m market_ingest sync-research --start 2024-01-02 --end 2024-01-03 \
  --datasets daily_basic,index_daily --index-codes SSE:000300,SSE:000001 --dry-run

# 实际抓取（CI 用 --replay-fixture；生产按日增量，配额 500/分 → 守卫只吃 400/分）
PYTHONPATH=src python3 -m market_ingest sync-research --start 2024-01-02 --end 2024-01-02 \
  --datasets daily_basic --ods-root var/ods --budget-calls 100
```

- **canonical 行**：`instrument_id`(`EXCH:CODE`) / `trade_date`(`YYYY-MM-DD`) / 金额一律
  **元**、量一律 **股**、比率**百分数**，全部十进制字符串；源侧 `万元 ×10000`、
  `千元 ×1000`、`手 ×100` 在适配层换算；缺失值 `null`，**禁止补 0**（C10）。
  来源数据里没有直接给出、但 H4 明确要求的研究辅助字段（如 `stk_limit.limit_pct`）
  按「源值比值派生 + 记 `*_source`」处理；**不重算交易所价格、不从名称猜 ST**。
- **默认数据集与指数**：`config/ingest.yaml` 的 `research.datasets` / `research.index_codes`
  （默认 5 个基准指数：`SSE:000001`、`SZSE:399001`、`SZSE:399006`、`SSE:000300`、`SSE:000905`）。
- **checkpoint**：日频数据集记 `ingest_checkpoint(dataset, scope="market") = last_success_trade_date`；
  逐标的（`fina_indicator`）记 `scope=<instrument_id>`；快照（行业树/成分表）记 `scope="snapshot"`（同日幂等）。
  中断（信号/配额耗尽）→ 退出码 3，同一命令重跑只补剩余范围，不产生缺口。
- **失败语义**：接口无权限/不可用/字段漂移 → 运行 `failed`（退出码 1）并保留已完成 checkpoint；
  **不造数、不补 0**（验收口径：数据正确落到 ODS + 字段映射清晰，不以功能可用验收）。
  某交易日合法无记录 → 行数 0、不写空批次，仍推进 checkpoint。
- **港股通行（hk_hold）**：源 `hk_hold` 同时含 A 股（`600519.SH`→`SSE:600519`）与港股通
  标的（`00700.HK`→`HKEX:00700`，1–5 位数字左补 0）。映射在适配层 `mapper.parse_source_code`
  的 `.HK` 分支完成；源 `ts_code` 缺失时用 `code`+`exchange` 兜底拼回 TS 代码。`HKEX:` 命名空间**只用于研究域
  hk_hold**（H4 裁定）：不进 display root、不参与 `display_safe` 派生、不进 C 端白名单与
  serving 对外接口；P0 `instrument_id` pattern 不变。`research.hk_source_code()` 提供
  `HKEX:00700`→`00700.HK` 的逆映射（审计/回放）；非 `.HK` 后缀或其它数据集出现 `.HK` 一律拒绝。
  适配器未声明支持的 dataset 由 `sync_research` 直接抛错（不静默跳过）。
- **provisional**：`ResearchDataset.provisional=True` 表示字段清单/积分档待 H4 对齐全；
  改动只动 `research.py`，ODS/sync 下游不变。
- **ODS 根**：研究批次进 `<root>/internal`（展示态白名单不含研究数据；L34）。
- F1 授权不阻塞 ingest（ADR-007），但真实回补仍需 H4/运维 token 与预算；禁止为 E2E 跑真实回补。

### 第 2 批（KD-INGEST-P2 / KD-INGEST-INDUSTRY）

- **`stk_limit`**（B1-02 精确涨跌停依赖）：按交易日全市场拉原始字段，canonical 为
  `instrument_id/trade_date/previous_close/up_limit/down_limit/asset_type/exchange`。
  **不重算限价、不改精度**：`up_limit/down_limit` 按交易所原值入库（各家四舍五入规则不同，
  重算必错）。**ST 不从证券简称推、也不靠 `asset_type` 猜**（M04：名字会变/会漏）。
  `limit_pct` 用**候选档位重算比对**（H4 m03085）派生：对 `{5,10,20,30}` 每档计算
  `round_half_up(previous_close × (1 ± pct/100), 2)`，与交易所 up/down 分别精确相等
  （仅 ±0.005 吸收浮点误差）才算命中；**唯一命中**才落 `limit_pct`（字符串档位）与
  `limit_pct_source="exchange_price_candidate"`；零命中/多命中 → `limit_pct=null`（不猜）。
  低价股舍入边界（prev=1.35→up=1.49 归 10 档、0.45→0.50 归 10 档）由此正确落档。
  ⚠️ **除权日**交易所 `pre_close` 是除权调整后的值，**不能与日线前收盘直接对账**；
  需要比较时用 `ex_rights` 标记（当前 ODS 不含，后续补）。
  **按交易所分取整**（H4 m03258 要求先给数据；诊断见
  `tests/fixtures/tushare/real-sample-20261105/stk_limit_bj_rounding.json`）：
  北交所 A 股（非 900xxx）涨停向下截断、跌停向上截断，真实样本 **354/354 行 × 3 日全中**；
  900xxx.BJ 为 B 股（0.001 元报价单位、四舍五入），**41/41 × 3 日全中**；
  SSE/SZSE 维持 0.01 元四舍五入。三类规则不同、不能统一 half-up，也不得放宽容差凑命中。
  首日无涨跌幅（`up_limit=999999.999`）等仍自然落 `null`。
- **`fina_indicator`**（财务指标，per-instrument 模式）：
  ```bash
  PYTHONPATH=src python3 -m market_ingest sync-research --start 2024-01-01 --end 2024-12-31 \
    --datasets fina_indicator --instruments SSE:600519,SZSE:000001 --ods-root var/ods --budget-calls 100
  ```
  canonical 分区 `dt=report_end_date`（最新报告期）；`report_period`=`YYYYQn`；金额元、
  比率百分数、缺失 `null`；`announced_at` 由源公告日按 ISO 日期记录（无时点推断）。
  **时点口径（A2 下游必读）**：研究查询一律按 `announced_at`（公告日）做 as-of join，
  **禁止按 `report_end_date` join**（前视偏差）；`announced_at=null` 的行不进 as-of join，
  不补不猜。字段清单由 `research.py` 的 `fina_indicator` 列定义集中维护，provisional 待 H4 对齐。
  「金额元/比率百分数」当前是假设，摘 provisional 前需真实样本（如 600519 2023 年报）核对。
  canonical 字段名 `revision_flag`（源 `update_flag`，tushare 源侧列名不外泄，C01）；
  `roe_waa` 为加权平均 ROE，是年报口径（源 `roe` 是另一口径，两个都保留，下游按需取）。
- **`index_classify`**（申万分类树，snapshot）：一次运行按 `SW2021` 拉 L1/L2/L3 三层，
  canonical `index_code/industry_name/parent_code/level/industry_code/is_published/classification_source/snapshot_date`；
  分区 `dt=<运行日>`。**append-only 快照**（H4 m02718）：主键含 `snapshot_date`（拉取日），
  每次运行写新批次、绝不原地 UPDATE；**首快照之前的分类时点不可回补**，回测在首快照前要显式排除，
  不许用当前分类假装历史。
- **`index_member_all`**（申万三级成分，snapshot）：**Y/N 两次调用拉全量（含历史退出成分）**，
  canonical `instrument_id/name/l1_code..l3_name/in_date/out_date/is_new/snapshot_date`；
  `in_date/out_date` 保留原始时点字段，回测 join 两头都卡（含历史退出，避免幸存者偏差）；
  `is_new=Y` 行**省略 `out_date` 键**（不写 `null`：下游 RES-08 规则要求 Y 行不得带退出日）。
  若源对 `is_new=N` 无数据，本次运行在 `<ods_root>/_meta/research_coverage.json` 记
  `coverage="current_snapshot_only"`，`ResearchSyncResult.current_snapshot_only` 同时给出该列表；
  **下游必须把这部分数据排除出历史回测**，不得当全量成分使用。行业/指数编码
  （`index_code`、`l3_code` 等）保留源命名空间后缀（如 `.SI`）作为**不透明文本**，下游不解析；
  是否归一待 H4 定。
- 单测：`tests/test_research.py` 覆盖 4 个数据集的字段映射/单位/形态分派/失败不造数/
  快照幂等/append-only/覆盖率标记/逐标的 checkpoint；仓库根 `pytest services/ingest/tests`
  = 200 passed。
- **provisional 不摘**（H4 m02718/m03258）：摘除需证据齐——① `fina_indicator` 单位样本证据
  + H4 签字；② `stk_limit` 分档有交易所/档位用例；③ index 两表快照/成分时点断言测试。
  齐之前四表只进研究域（internal-only），不进 serving 对外、不进 display root。
- **ST 档位口径（H4 m03352 更正）**：主板 ST/*ST 涨跌幅自 **2026-07-06** 起为 10%；
  5% 档适用于 **S 股**（如 `600182.SH`）与 **2026-07-06 前的历史 ST**。受控样本的
  142 只主板 ST=10%、53 只 20%、2 只 30% 符合现行规则，**ST 语义通过**。
  `stk_limit` 批次 metadata 记事实字段 `st_pct_rule_version="2026-07-06"` 与
  `_meta/research_coverage.json` 的 `st_named_but_pct10` 计数（按 ODS 内 instrument
  名称基线统计；基线缺失记 note）；不改源值、不反推 ST、不写 mismatch 标记。
- **来源通道审计（H4 m03258）**：`<ods_root>/_meta/research_coverage.json` 顶层记录
  `source_channel`（`official_tushare` / `third_party_mirror` / `replay`）、
  `authorization_status`（mirror=`unverified_third_party`，官方 token 未书面授权前=
  `pending_official_authorization`）、`endpoint_host`；每次运行另追加一行到
  `_meta/research_sources.jsonl`（append-only，含 run_id/datasets/rows）。
  经第三方 mirror 的批次**只做研究域内部使用**，不得进 C 端/display/serving，
  也不再在 mirror 上扩新数据集；F1 书面授权只认官方 tushare 回复。

### 研究 ODS 全链路冒烟（可交付 A2 复验）

`var/research-ods-smoke/` 是 11 个研究 endpoint + `instrument.v1` 的合成录播冒烟根
（`fixture.jsonl` 为 ReplayTransport 输入，**非真实数据**）：

- `internal/`：11 个研究数据集批次（`_meta/research_coverage.json` 记 coverage 与首快照日）；
- `display/instrument/`：5 标的 `instrument.v1`（CSV 导出口径，供 RES-03 维度引用）；
- `var/research-ods-smoke-audit/`：对应的主数据 manifest/snapshot/terms（`display_safe` 证据）。

```bash
# 仓库根执行；A2 ownership 内只读
PYTHONPATH=services/ingest/src:. python3 -m warehouse.pipeline \
  --ods-root services/ingest/var/research-ods-smoke \
  --manifest-root services/ingest/var/research-ods-smoke-audit
# batches=12 research=14 quality score=100.0 grade=green blocked=False
```

### 受控真实样本核对（H4 m02923，2026-11-05，仅本地一次）

样本落 `tests/fixtures/tushare/real-sample-20261105/`（独立 manifest，`channel=tushare`、
`display_safe=false`、记 `source_url/fetched_at/sha256`；stk_limit 为按档抽样 subset，
不是全量；**无生产验收证据效力**）。结论：

- `fina_indicator` 600519.SH / 20231231：`eps=59.49`、`roe=36.1755`、`roe_waa=34.19`、
  `ann_date=20240403`；`income`：`total_revenue=150560330316.45` 元、
  `n_income_attr_p=74734071550.75` 元。与 2023 年报（营收 1505.6 亿、归母净利 747.3 亿、
  EPS 59.49、加权 ROE 34.19%）一致 → **金额=元、比率=百分数**假设成立；
  年报口径 ROE 对应 `roe_waa`（`roe=36.18` 是另一口径）。
- `stk_limit` 三个交易日（20261103/04/05，各 5655 行、5655 个代码，未触 5800 单次上限）：
  候选档重算后 `limit_pct` 分布为 10%≈3270 / 20%≈2029 / 30%≈191 / 5% 仅 1 / null≈164。
  **5% 唯一行是 `600182.SH`（S 股「S佳通」，非 ST）**；用 `stock_basic` 名称含「ST」
  的 198 只做交集：**ST∩5% = 0**，198 只全部不在 5% 档（主板 ST 142 只落 10%、
  创业板/科创板 ST 53 只落 20%、北交所 ST 2 只落 30%、1 只 null）；198 只 ST 全部出现在
  `stk_limit`，无 missing → **排除分页截断**。即：该数据源当期给主板 ST 的限价是 10%、不是 5%，
  比值同样≈9.8–10.4%，不是比值法漏判。**5% 档 ST 语义未通过验证**，摘 `stk_limit`
  provisional 前需 H4 确认这是官方当期口径还是 mirror 源差异（H4 m03085 的第 1 条验收）。
  诊断明细落 `real-sample-20261105/stk_limit_st_diagnosis.json`（只存聚合统计，不含全量数据）。
- null 行（约 164–177/日）主要是北交所（920xxx.BJ）+ 001381.SZ（首日无涨跌停，
  `up_limit=999999.999`/`down_limit=0.01`，自然 null），按「不猜」记 null。
- `index_member_all`：`is_new=Y` 5922 行、`out_date` 全空；`is_new=N` 2006 行、
  `out_date` 全非空、302 只股票有多段 `in_date`（如 000004.SZ 三段），证明 N 是历史退出
  成分、可按 in/out 区间复原 → **默认 Y+N 全量成立**，非 `current_snapshot_only`。
  （`index_member_all` 的 `ts_code` 参数是**股票代码**，用 `000300.SH` 查返回 0 行属预期。）
- 去重键按 H4 m02923 定为 `l3_code+instrument_id+in_date`（保留退出再进入的多段区间）。

## A12 e2e 注入点

- 录播在 **HTTP 边界**（A12 代理容器）：`TUSHARE_API_URL=http://<replay-proxy>`,
  `DATA_SOURCE_MODE=replay`, `FIXTURES_DIR=/fixtures/tushare`（FIXTURES_DIR 由代理
  消费，adapter 不读取）。
- adapter 映射/单位换算/校验照常真实执行；`fields` 顺序不敏感，分页每次调用独立
  录一个 key；真栈 503 `FIXTURE_MISSING` 时把 body 的 key/api_name 发 A12 重录。
- adapter 可注入点：`create_adapter(options, *, transport=..., guard=..., ledger=...)`；
  测试用 `ReplayTransport(entries)` / `ReplayTransport.from_file(path)`（JSONL）。

## 合成 fixture 审计（L32 / L44）

`tools/audit_synthetic_fixtures.py` 只读 `tests/fixtures/tushare/`（A12 写域），校验
manifest 声明合成、无未登记孤儿文件，并由脚本重算 path+sha256 清单（不许手抄）：

    python3 tools/audit_synthetic_fixtures.py                       # 表格到 stdout
    python3 tools/audit_synthetic_fixtures.py --write var/fixture-inventory.md

清单交给 Lead 贴 `agents/BOARD.md`；脚本退出码 1 = 有真实报文/孤儿/清单不一致。

## 测试

```bash
cd services/ingest
PYTHONPATH=src /opt/anaconda3/bin/python3 -m pytest -q      # 190 tests
PYTHONPATH=src /opt/anaconda3/bin/python3 -m mypy           # 23 files clean
```

CI 一律录播，禁止真实接口调用；CSV 主数据导入用仓库内 `data/instruments/base_info.csv`，
不访问网络。

## 已知缺口 / handoff

- `config/datasource/` 未在 `ownership.yaml` 登记（仅 `reserved_paths`），配置暂放
  `services/ingest/config/`；A0 登记后迁移。
- `data/instruments/` 同为 `ownership.yaml` default-deny 未登记路径（A1 按 lead m00796
  指令落盘）；请 A0 登记 owner=A1。
- `staleness_ms` 按 ADR-002 D4/C05 由 API 响应时计算，端口只产出 `as_of`。
- `instrument.v1` 已进 S0（L17）；全市场长区间回补计划需用 `listed_at` 裁剪区间，
  否则质量规则会把上市前交易日判成缺 bar（回补编排属后续任务，不在本服务）。
- `fundamental.v1` 首版只产 `statement_basis=reported`；restated 并存依赖后续增量
  任务（loader 已支持并存）；按 lead m00796，C 端未授权期间不展示财务。
- 复权因子锚归一（L3）待 H4 会签；C01 grep 闸豁免范围待 A0/A11 明确。
- CSV 导入的官方渠道（上交所/深交所/证监会名录）尚未确定条款口径；当前只提供
  渠道抽象（authorized_download / manual_import / official_api），不写死具体 API，
  等 H4 11-12 结论。11-12 的 manifest/blocked/diff 三份样例（synthetic、无网络）在
  `samples/_synthetic/`（见该目录 README）；manifest 哈希链/
  head 的读取方校验见 `verify-manifest` 子命令（A2 侧待接入）。
