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

## A12 e2e 注入点

- 录播在 **HTTP 边界**（A12 代理容器）：`TUSHARE_API_URL=http://<replay-proxy>`,
  `DATA_SOURCE_MODE=replay`, `FIXTURES_DIR=/fixtures/tushare`（FIXTURES_DIR 由代理
  消费，adapter 不读取）。
- adapter 映射/单位换算/校验照常真实执行；`fields` 顺序不敏感，分页每次调用独立
  录一个 key；真栈 503 `FIXTURE_MISSING` 时把 body 的 key/api_name 发 A12 重录。
- adapter 可注入点：`create_adapter(options, *, transport=..., guard=..., ledger=...)`；
  测试用 `ReplayTransport(entries)` / `ReplayTransport.from_file(path)`（JSONL）。

## 测试

```bash
cd services/ingest
PYTHONPATH=src /opt/anaconda3/bin/python3 -m pytest -q      # 133 tests
PYTHONPATH=src /opt/anaconda3/bin/python3 -m mypy           # 22 files clean
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
