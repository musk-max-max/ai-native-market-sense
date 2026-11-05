# P0 指标口径（A2 立法产物 · 待 H4 签字）

- 状态：**`signed`（H4，2026-11-04；条件见 `p0_metrics.json::sign_off.conditions`）**——此后任何口径/规则/阈值变更须重新会签
- owner：A2 data-warehouse；reviewer/sign-off：**H4**（agent 不能批准 agent，见 agents/README.md 门禁）
- 生效范围：P0 竖切片（个股日线 + 复权因子 + 8 条口径中的可执行 4 条）
- 变更流程（硬约束，roster A2 system_prompt #2）：**先改本文件 → H4 签字 → 再改 SQL/代码**。
  口径变更同时属于 `must_escalate`，未签字的口径改动不得进入 SQL 或 serving 层。
- 机器可读注册表：`docs/metrics/p0_metrics.json`（metric_id → sql_file、状态、依赖表）。
- 一致性保证：`warehouse/tests/test_docs_sql_sync.py` 断言本文 fenced `sql` 块与对应 `.sql` 文件
  归一化后逐字节一致；改 SQL 不改本文（或反之）CI 直接红灯。

## 0. 口径总表

| 编号 | 名称 | 口径 | P0 状态 | 实现 |
| --- | --- | --- | --- | --- |
| M01 | 行情主口径 | 不复权 OHLC | executable | `warehouse/metrics/m01_bars_none.sql` |
| M02 | 收益口径 | 后复权 hfq | executable | `warehouse/metrics/m02_return_hfq.sql` |
| M03 | 资金流 | 主力净流入，不含大宗 | pending-data（A1 无 moneyflow 落地） | — |
| M04 | 涨跌停 | 按板块幅度 | executable | `warehouse/metrics/m04_limit_status.sql` |
| M05 | 龙虎榜 | 保留上榜原因 | pending-data（无 dragon_tiger 落地） | — |
| M06 | 财务 | reported + restated 两套并存 | pending-data（**P0 不验收**；A1 已落最小 reported 切片，restated 待定） | — |
| M07 | 指数/概念成分 | 按日快照 | pending-data（无成分快照落地） | — |
| M08 | 涨跌幅 | 基准 = 前收盘价（除权日=除权参考价） | executable | `warehouse/metrics/m08_change_pct.sql` |

## 1. M01 行情主口径 = 不复权

**定义**：DWD 主表 `dwd_stock_bar_daily` 只存交易所公布的原始 OHLC（不复权），K 线/行情快照默认返回该口径；
契约 `contracts/market` 的 `AdjType=none` 与之对应。

**依据**：①H4-D6 已批准「不复权为主口径」；②不复权价与交易所逐分一致，可对账、可回放；
③任何复权都可由 `close × factor` 确定性重算，存三份会制造三份真相（ADR-002 D2）。

**失效/禁止**：禁止在 DWD 里用前复权价覆盖 close；禁止没有因子时用 1.0 冒充复权（qfq/hfq 计算直接报错）。

**内部 canonical 扩展 `market_segment`（H4 2026-11-05 签死语义，L124①）**：`bar.v1` 可选字段，唯一合法值
`neeq_select`，**仅 `BSE:` 且 `trade_date < 2021-11-15`（原精选层时期）允许出现**；其余行必须缺省。
loader **fail-closed**：BSE 早期行缺失或值≠`neeq_select` 拒载；非 BSE 或 ≥2021-11-15 带值也拒载。
DWD `dwd_stock_bar_daily.market_segment` 原样透传；**不进 `contracts/market/openapi.yaml::Bar`、不进
serving_c_end/display/任何 C 端响应**（Bar 保持 `additionalProperties:false` 不动）。20 年回补验收时按
「BSE 2021-11-15 前行 100% 带 `neeq_select`、无一行漏标」核对。

```sql
-- M01 个股日线（主口径：不复权）
-- 依据：H4-D6 已批准「不复权为主口径」；契约 contracts/market AdjType=none 为 K 线默认。
-- 用途：K 线、行情快照；不使用复权因子，保证与交易所公布的原始价格逐分一致。
-- 参数（binding，:name 形式，由 serving 层注入）：:instrument_id, :start_date, :end_date
SELECT instrument_id,
       trade_date,
       open,
       high,
       low,
       close,
       volume,
       amount
FROM dwd_stock_bar_daily
WHERE instrument_id = :instrument_id
  AND trade_date BETWEEN :start_date AND :end_date
ORDER BY trade_date;
```

## 2. M02 收益口径 = 后复权（hfq）

**定义**：区间收益用后复权价计算：`hfq_close = close × factor`，
`return_pct = (末 hfq_close / 首 hfq_close − 1) × 100`，保留 4 位小数。

**依据**：①H4-D6 已批准「后复权算收益」；②后复权价只依赖历史因子，不随未来除权变化，
同一区间不同 `as_of` 重算结果一致（可复现）；③前复权 qfq 以「最新因子」归一，历史价会随新除权跳动，
只能用于画图（契约 `AdjType=qfq`），不能进入收益/回测口径。

**因子语义（L3）**：累计复权因子，归一化 `1.0` = 该证券**最早可得因子日**（不是"首个上市交易日"）；
1990-12-19 前上市的老股锚定 1990-12-19。DWD 不二次归一。区间收益在两种锚下等价，但 hfq 绝对价
随锚变化，因此**锚一变即口径变更**：`factor_version` 随之改变，必须重新会签；hfq 绝对价不得直接进 C 端
（仅收益用途），要展示 hfq 绝对价需另立口径并会签。

```sql
-- M02 区间收益率（口径：后复权 hfq）
-- 依据：H4-D6 已批准「后复权算收益」；前复权只用于画图（qfq 依赖 as_of，不能用于收益比较）。
-- 公式：hfq_close = close × factor；return_pct = (末 hfq_close / 首 hfq_close − 1) × 100
-- 说明：因子为累计因子，1.0 = 该标的**最早可得因子日**（L3），不是"首个上市交易日"；
--       1990-12-19 前上市的老股锚定 1990-12-19。区间内 hfq 收益与锚选择无关，但 hfq 绝对价
--       随锚变化——锚一变即口径变更，必须重新会签。
-- 输出：anchor_date（该标的因子序列起点）、factor_version（含锚的版本串，锚变则串变）、
--       factor_as_of（因子批次 as_of，用于追溯数据来源）。hfq 绝对价不得直接进 C 端展示，
--       仅用于收益；要展示 hfq 绝对价需另立口径并会签。
-- 参数：:instrument_id, :start_date, :end_date
WITH factor_meta AS (
    SELECT instrument_id,
           MIN(trade_date) AS anchor_date,
           MAX(as_of) AS factor_as_of
    FROM dwd_adj_factor
    WHERE instrument_id = :instrument_id
    GROUP BY instrument_id
),
adj AS (
    SELECT b.trade_date,
           b.close * f.factor AS hfq_close
    FROM dwd_stock_bar_daily AS b
    JOIN dwd_adj_factor AS f
      ON f.instrument_id = b.instrument_id
     AND f.trade_date = b.trade_date
    WHERE b.instrument_id = :instrument_id
      AND b.trade_date BETWEEN :start_date AND :end_date
),
ranked AS (
    SELECT trade_date,
           hfq_close,
           ROW_NUMBER() OVER (ORDER BY trade_date ASC) AS rn_first,
           ROW_NUMBER() OVER (ORDER BY trade_date DESC) AS rn_last
    FROM adj
)
SELECT (SELECT trade_date FROM ranked WHERE rn_first = 1) AS start_date,
       (SELECT trade_date FROM ranked WHERE rn_last = 1) AS end_date,
       ROUND(
           ((SELECT hfq_close FROM ranked WHERE rn_last = 1)
            / (SELECT hfq_close FROM ranked WHERE rn_first = 1) - 1) * 100,
           4
       ) AS return_pct,
       m.anchor_date,
       'L3:anchor=' || m.anchor_date::text AS factor_version,
       m.factor_as_of
FROM factor_meta AS m
WHERE EXISTS (SELECT 1 FROM ranked);
```

## 3. M04 涨跌停 = 按板块幅度

**定义**：

| 板块 | 代码示例 | 涨跌幅限制 |
| --- | --- | --- |
| 主板 main（非 ST、非 S 股） | SSE:600519 / SZSE:000001 | ±10% |
| 主板 main（ST / *ST） | SSE:600xxx | **时点**：`< 2026-07-06` ±5%；`≥ 2026-07-06` ±10%（沪深同步） |
| 主板 main（S 股，非 ST） | SSE:600182 S佳通 | ±5% |
| 创业板 gem | SZSE:300xxx | **时点**：`< 2020-08-24` ±10%；`≥ 2020-08-24` ±20% |
| 科创板 star | SSE:688xxx | ±20% |
| 北交所 bse | BSE:43/83/87/88/92xxxxx | `≥ 2021-11-15` ±30%；更早 **NULL（不猜精选层规则）** |
| 首日（trade_date = listed_at） | 任意 | **NULL**（无涨跌幅） |
| 上市前 5 个交易日（trade_seq ≤ 5） | 科创板（listed_at ≥ 2019-07-22）/ 创业板（≥ 2020-08-24）/ 主板（≥ 2023-04-10） | **NULL**（注册制无涨跌幅；trade_seq 按全历史 bar 序号） |
| listed_at 缺失 | 任意 | **NULL**（fail-closed，无法判首日/上市初期） |

涨跌停价 = `prev_close × (1 ± limit_pct)` 按**市场/报价单位取整**后再比较（沪深 A 0.01 half-up；
北交所 A 涨停 floor、跌停 ceil；沪 B 0.001；深 B 0.01，B 股待签）；`limit_status` 取
`limit_up | limit_down | none`。注册制新股（科创 ≥2019-07-22、创业 ≥2020-08-24、主板 ≥2023-04-10）
上市后前 5 个交易日的涨跌停价与 `limit_status` 均为 NULL——第 2–5 日涨幅可远超档位，**不得错标涨停**。
`trade_seq` 按 `trade_date <= :end_date` 的全历史 bar 排序；若某标的**上市首日 bar 缺失**，`trade_seq` 窗口整体后移 1 日，
逐行输出 `known_limitation` 提示（窗口可能错位）。`listed_at IS NULL` 的覆盖率用
`warehouse/metrics/m04_listed_at_coverage.sql` 诊断。**当前实际数字（2026-11-05，P0 冒烟 ODS 去重 7 只标的 / 6 行 bar）**：
`listed_at IS NULL` 标的 **0 只（0/7=0.0%）**，受影响 bar **0 行（0/6=0.0000%）**；尚非 20 年全量，
全量回补后必须重跑该查询——若占比 > 1% 属覆盖口径变化，回 H4 决策（H4 2026-11-05 条件 3），
<=1% 才可只记 known_limitation。**时点规则（2026-11-05 H4 口径更正）**：主板 ST/*ST 在
`2026-07-06` 前为 5%、之后为 10%（旧「一律 5%」作废）；创业板在 `2020-08-24` 前 10%、之后 20%；
北交所在 `2021-11-15` 前 `limit_pct=NULL`（不猜精选层规则）；主板 S 股 5%；首日无涨跌幅（NULL）。

**按市场取整（不能一律 half-up）**：沪深 A 股 0.01 元 half-up；北交所 A 股（43/83/87/88/92）
涨停价 `floor`、跌停价 `ceil`（0.01 元，A1 真实样本 354/354 命中）；沪市 B 股 900xxx 0.001 美元
half-up、深市 B 股 200xxx 0.01 港元 half-up（H4 2026-11-05 已签：沪 B 41/41、深 B 35/35 命中；B 股仍只研究域）。
取整是交易所规则，不能用涨跌幅百分比直接判：例如主板 ST
`prev_close=10.05`，`10.05×1.05=10.5525→10.55`，收盘 10.55 即涨停（当日涨幅 4.9751%，仍 ≤5%）。
**不得硬编码 10%**（C11）。

**fail-closed（不可静默）**：板块未知/为空 → `limit_pct=NULL`、`limit_status=NULL`（"不知道"≠"没涨跌停"），
质量规则 BIZ-01 对未知板块直接 blocker。

**ST 时点性（L80，P0 known limitation）**：ST 判定只用 `dim_instrument.name` 当前名称快照，历史交易日
未还原；跨戴帽/摘帽/退市窗口的结果不适用。SQL 逐行输出 `st_by_current_name`、`st_status_source`、
`known_limitation`；质量规则 BIZ-03（warn）对「当前 ST 名称且 `trade_date < dim.as_of` 日期」的 bar 出告警，
不拖绿、不阻断。P1 接入 tushare namechange 后按交易日状态重算并转 blocker（已记 P1 数据依赖）。

**依据**：①H4-D6 已批准「涨跌停按板块」；②ST 判定用展示名派生（name 以 `ST`/`*ST` 开头），
`dim_instrument` 不落 `is_st`（ADR-002：派生字段不落库）；③基准用 M08 的 `prev_close`，
除权日由适配层写除权参考价，否则除权会被误判为跌停。

```sql
-- M04 涨跌停状态（口径：按板块 + 时点 + 上市初期；P0 ST 判定=当前名称快照，L80）
-- 依据：H4-D6 已批准「涨跌停按板块」，C11 禁止硬编码 10%；L80 裁定 P0 不还原历史 ST 状态。
-- 时点规则（H4 2026-11-05 口径更正；旧「主板 ST 一律 5%」作废）：
--   主板           10%
--   主板 ST/*ST    < 2026-07-06 → 5%；>= 2026-07-06 → 10%（沪深同步，2026-07-06 起施行）
--   主板 S 股      名称 S 开头且非 ST（如 600182 S佳通）→ 5%；S 股规则优先于 ST（S*ST 历史名也 5%）
--   创业板         < 2020-08-24 → 10%；>= 2020-08-24 → 20%
--   科创板         < 2019-07-22（开板前不存在）→ NULL；>= 2019-07-22 → 20%
--   北交所         >= 2021-11-15 → 30%；更早 → NULL（不猜精选层规则，禁止把 30% 套到更早日期）
-- 上市初期无涨跌幅（注册制改革，P0 用 trade_seq 判定）：
--   trade_date = listed_at → NULL（首日）
--   科创板（listed_at >= 2019-07-22）、创业板（listed_at >= 2020-08-24）、
--   主板（listed_at >= 2023-04-10）上市后前 5 个交易日 → NULL
--   注：trade_seq 在 trade_date <= :end_date 的全历史上按 instrument_id 排行号，
--       再按 :start_date 过滤，避免窗口起点重置序号；缺 bar 的交易日按已有 bar 近似。
--   北交所新股仅首日无涨跌幅（已被 listed_at 规则覆盖）。
--   listed_at IS NULL → NULL，fail-closed（无法判首日/上市初期，不猜）。
-- 基准：M08 的 prev_close（除权日为除权参考价，由适配层写入，避免除权误判涨跌停）。
-- fail-closed：板块未知/为空时 limit_pct=NULL、limit_status=NULL，禁止 CASE 静默落到 'none'
--             （"不知道"≠"没涨跌停"）；质量规则 BIZ-01 对未知板块直接 blocker。
-- ST 时点性（L80）：P0 只有 dim_instrument.name 当前快照，历史交易日未还原；
--             输出 st_by_current_name / st_status_source / known_limitation，跨戴帽、摘帽、
--             退市窗口的结果不适用。P1 接入 namechange 后改按交易日状态并转 blocker。
-- 限价取整（按交易所/报价单位，不能一律 half-up）：沪深 A 0.01 元 half-up
--   （10.05×1.05=10.5525→10.55）；北交所 A（43/83/87/88/92）涨停 floor、跌停 ceil；
--   沪市 B 股 900xxx 0.001 美元 half-up、深市 B 股 200xxx 0.01 港元 half-up
--   （H4 2026-11-05 已签：沪 B 41/41、深 B 35/35 命中；B 股仍只研究域，不进 C 端）。
-- known limitation：创/科/主板注册制前 5 交易日序号按已有 bar 近似；缺 bar 的交易日会使序号偏小。
-- 参数：:start_date, :end_date
WITH hist AS (
    SELECT b.instrument_id,
           b.trade_date,
           b.close,
           b.prev_close,
           i.exchange,
           i.code,
           i.board,
           i.name,
           i.listed_at,
           ROW_NUMBER() OVER (PARTITION BY b.instrument_id ORDER BY b.trade_date) AS trade_seq,
           MIN(b.trade_date) OVER (PARTITION BY b.instrument_id) AS first_trade_date
    FROM dwd_stock_bar_daily AS b
    JOIN dim_instrument AS i
      ON i.instrument_id = b.instrument_id
    WHERE b.trade_date <= :end_date
),
base AS (
    SELECT instrument_id,
           trade_date,
           close,
           prev_close,
           exchange,
           code,
           board,
           name,
           listed_at,
           trade_seq,
           first_trade_date,
           CASE
               WHEN board IS NULL THEN NULL
               WHEN listed_at IS NULL THEN NULL
               WHEN trade_date = listed_at THEN NULL
               WHEN trade_seq <= 5 AND (
                        (board = 'star' AND listed_at >= DATE '2019-07-22')
                     OR (board = 'gem'  AND listed_at >= DATE '2020-08-24')
                     OR (board = 'main' AND listed_at >= DATE '2023-04-10')
               ) THEN NULL
               WHEN board = 'main' AND name LIKE 'S%' AND name NOT LIKE 'ST%' THEN 5.0
               WHEN board = 'main' AND (name LIKE 'ST%' OR name LIKE '*ST%') THEN
                   CASE WHEN trade_date < DATE '2026-07-06' THEN 5.0 ELSE 10.0 END
               WHEN board = 'main' THEN 10.0
               WHEN board = 'gem' THEN
                   CASE WHEN trade_date < DATE '2020-08-24' THEN 10.0 ELSE 20.0 END
               WHEN board = 'star' THEN
                   CASE WHEN trade_date < DATE '2019-07-22' THEN NULL ELSE 20.0 END
               WHEN board = 'bse' THEN
                   CASE WHEN trade_date < DATE '2021-11-15' THEN NULL ELSE 30.0 END
               ELSE NULL
           END AS limit_pct
    FROM hist
    WHERE trade_date >= :start_date
      AND prev_close IS NOT NULL
),
priced AS (
    SELECT instrument_id,
           trade_date,
           board,
           name,
           limit_pct,
           CASE
               WHEN limit_pct IS NULL THEN NULL
               WHEN board = 'bse' AND (code LIKE '43%' OR code LIKE '83%' OR code LIKE '87%'
                                       OR code LIKE '88%' OR code LIKE '92%')
                   THEN FLOOR(prev_close * (1 + limit_pct / 100.0) * 100) / 100
               WHEN exchange = 'SSE' AND code LIKE '900%'
                   THEN ROUND(prev_close * (1 + limit_pct / 100.0), 3)
               ELSE ROUND(prev_close * (1 + limit_pct / 100.0), 2)
           END AS limit_up_price,
           CASE
               WHEN limit_pct IS NULL THEN NULL
               WHEN board = 'bse' AND (code LIKE '43%' OR code LIKE '83%' OR code LIKE '87%'
                                       OR code LIKE '88%' OR code LIKE '92%')
                   THEN CEIL(prev_close * (1 - limit_pct / 100.0) * 100) / 100
               WHEN exchange = 'SSE' AND code LIKE '900%'
                   THEN ROUND(prev_close * (1 - limit_pct / 100.0), 3)
               ELSE ROUND(prev_close * (1 - limit_pct / 100.0), 2)
           END AS limit_down_price,
           close
    FROM base
)
SELECT instrument_id,
       trade_date,
       board,
       limit_pct,
       limit_up_price,
       limit_down_price,
       CASE
           WHEN limit_pct IS NULL THEN NULL
           WHEN close >= limit_up_price THEN 'limit_up'
           WHEN close <= limit_down_price THEN 'limit_down'
           ELSE 'none'
       END AS limit_status,
       CASE
           WHEN board = 'main' AND (name LIKE 'ST%' OR name LIKE '*ST%'
                                     OR name LIKE 'S*ST%' OR name LIKE 'SST%') THEN true
           ELSE false
       END AS st_by_current_name,
       'dim_instrument.name@as_of' AS st_status_source,
       CASE
           WHEN board IS NULL THEN 'board 未知：fail-closed，不判涨跌停'
           WHEN listed_at IS NULL THEN '上市日缺失，无法判首日/上市初期：limit_pct=NULL（fail-closed）'
           WHEN first_trade_date > listed_at AND first_trade_date <= listed_at + 10
               THEN '上市首日 bar 缺失：trade_seq 窗口整体后移 1 日（该标的上市初期的豁免/判定可能错位）'
           WHEN trade_date = listed_at THEN '首日无涨跌幅限制（listed_at 判定）'
           WHEN trade_seq <= 5 AND (
                    (board = 'star' AND listed_at >= DATE '2019-07-22')
                 OR (board = 'gem'  AND listed_at >= DATE '2020-08-24')
                 OR (board = 'main' AND listed_at >= DATE '2023-04-10')
               ) THEN '注册制新股上市前 5 个交易日无涨跌幅（trade_seq<=5，limit_pct=NULL）'
           WHEN board = 'star' AND trade_date < DATE '2019-07-22'
               THEN '科创板 2019-07-22 开板前无该板块（limit_pct=NULL）'
           WHEN board = 'bse' AND trade_date < DATE '2021-11-15'
               THEN '北交所 2021-11-15 前无 30% 涨跌幅口径（不猜精选层），limit_pct=NULL'
           WHEN board = 'bse'
               THEN '北交所取整按交易所规则（涨停 floor / 跌停 ceil）；沪 B 900xxx 0.001 美元 / 深 B 200xxx 0.01 港元 half-up（H4 2026-11-05 已签；B 股只研究域）'
           WHEN board = 'main' AND name LIKE 'S%' AND name NOT LIKE 'ST%'
               THEN 'S 股规则优先（5%）；若名称同时含 ST（如 S*ST），仍按 S 股 5%'
           WHEN board = 'main' AND (name LIKE 'ST%' OR name LIKE '*ST%')
               THEN 'ST 判定=当前名称快照，历史交易日未还原；跨戴帽/摘帽/退市窗口不适用（L80；P1 接 namechange 后转 blocker）；ST 限价 2026-07-06 起为 10%'
           ELSE NULL
       END AS known_limitation
FROM priced
ORDER BY instrument_id, trade_date;
```

## 4. M08 涨跌幅 = 前收盘价为基准

**定义**：`change_pct = (close / prev_close − 1) × 100`，保留 4 位小数；
`prev_close` 正常日为上一交易日收盘价，除权除息日为除权参考价（由适配层写入，禁止 DWD 猜测）。
停牌/新股无基准时契约允许 `null`，**禁止用 0 冒充**；DWD 侧对应质量规则 BIZ-02（warn）。
**L7（已生效）**：`bar.v1` 非首日行必填 `prev_close`（A1 从 tushare daily 的 `pre_close` 取），
首日可空；BIZ-02 只告警不拦截，门禁依赖"必填"约定而非规则本身。

**依据**：①H4-D6 已批准「涨跌幅按板块规则」，板块判定依赖同一基准；②用除权参考价才能让
除权日的涨跌幅与交易所公告一致；③不改 close 本身（M01 主口径不变）。

```sql
-- M08 涨跌幅（口径：以前收盘价为基准）
-- 依据：H4-D6 已批准「涨跌幅按板块规则」，基准为前收盘价；除权除息日基准为除权参考价（由适配层写入 prev_close）。
-- 契约：Quote.change_pct 可为 null（停牌/新股），禁止用 0 冒充。
-- 参数：:instrument_id, :start_date, :end_date
SELECT instrument_id,
       trade_date,
       prev_close,
       close,
       ROUND((close / prev_close - 1) * 100, 4) AS change_pct
FROM dwd_stock_bar_daily
WHERE instrument_id = :instrument_id
  AND trade_date BETWEEN :start_date AND :end_date
  AND prev_close IS NOT NULL
  AND prev_close > 0
ORDER BY trade_date;
```

## 5. M03 / M05 / M06 / M07（P0 只立法，不实现；M06 已有最小 reported 批次入口）

> M06 数据侧进展（L16/L17）：A1 首版只产 `statement_basis=reported` 的最近一期 `fundamental.v1`（每标的最多
> 2 次调用，≤10 次/切片），`restated` 待下一任务确认 tushare `update_flag` 语义；ODS loader 与
> `dwd_fundamental_report` 已支持两套并存。在 restated 到位且口径复核前，M06 仍记 `pending-data`。

| 编号 | 口径（H4-D6 已批准方向） | P0 状态与原因 |
| --- | --- | --- |
| M03 资金流 | **主力净流入，不含大宗交易** | A1 尚未落地 `moneyflow` 端点；DWD 无资金流表。落地时须保留 `source/as_of` 与单位（元），禁止把大宗并入主力。 |
| M05 龙虎榜 | **保留上榜原因**（不合并成单一"上榜"） | 无 `dragon_tiger` 落地；口径要求原样保留 reason 字段并可按 reason 聚合。 |
| M06 财务 | **reported 与 restated 两套并存**，回显 `statement_basis` | **P0 不验收**：A1 已落最小 `reported` 切片（L16/L17），restated 待 `update_flag` 语义确认；ADR-002 C12：禁止只保留调整后数据。 |
| M07 指数/概念成分 | **按日快照**（point-in-time） | 无成分快照落地；禁止用"当前成分"回算历史（幸存者偏差）。 |

这四条**没有 SQL**，注册表 `p0_metrics.json` 里 `status=pending-data`，serving 层不得对其出具数值。

**M06 状态边界（lead 2026-11-04 裁定，见 agents/decisions.md L30）**：`pending-data` 是指标定义状态，**不是 P0 验收项**；E2E 对
`GET /fundamental-summary` 返回 200（A1 已给切片标的落最小 `fina_indicator`）不改变 M06 的 pending-data 状态，
验收时不得把它当成"没做完"。

## 6. 数据质量分（可执行配置）

- 配置：`warehouse/quality/quality_config.json`（版本化；阈值/权重改动属 `must_escalate`）。
- 四类权重：结构 **0.2** / 业务规则 **0.3** / 完整性及时性 **0.3** / 一致性 **0.2**（task-6 指定）。
- 计分（L9 裁定，待 H4 会签）：`类别分 = 100 × (1 − 该类别命中 blocker 的不同规则数 / 该类别规则总数)`；
  `总分 = Σ 权重 × 类别分`，保留 2 位。
  - 分子**按规则去重**：同一规则命中多条违规只算 1（避免样本量放大/缩小分数）；分母 = 该类别在
    `quality_config.json::rules` 声明的规则总数（结构 6 / 业务规则 6 / 完整性及时性 5 / 一致性 6；共 23 条。业务类含 BIZ-02/BIZ-03 两条 warn；研究域 RES-01..04 于 2026-11-05 按 KD-INGEST-CONSUME 加入，RES-05..08 于 2026-11-05 按 KD-DSW-P2 加入，RES-09（warn）于同日按 H4 KD-RES-HARDEN 加入。「已备案 2026-11-05（H4）」）。
  - `warn`（如 BIZ-02 缺基准）**不进分子**，但计入该类规则总数；`warn` 条数单列为告警指标。
  - 报告输出两个独立指标：`score`（质量分）与 `violation_counts`（blocker/warn 逐条计数）。
  - 理由：P0 只有 24 条正例样本；warn 若参与计分会让整批从绿转黄，从而诱使团队调阈值，
    阈值一调门禁就失效。分母固定为规则数而非评估条数，分数不随样本量漂移。
  - 配置见 `warehouse/quality/quality_config.json::scoring`（`score_counts=blocker_rules`）。
- 阈值：**≥95 green（放行）/ [90,95) yellow（放行但告警）/ [85,90) red（需人工确认）/
  <85 black（阻断下游）**；H4-D8 已批准该分档。
- **一票否决**：任一 `blocker` 级违规 → 直接 `black` + `blocked=true`。
  理由：门禁验收条件是"改坏一条数据必须红灯"。单条 blocker 在规则数分母下最多拉低一个类别
  （如业务规则命中 1/6 → 类别分 83.33、总分 95.00），可能停在 red 而非 black；否决规则保证阻断语义明确。
  阈值本身不放宽，否决规则叠加在阈值之上（待 H4 签字确认该叠加方式）。
- 规则清单（id ↔ 实现 `warehouse/quality/checks.py`）：

| 类别 | 规则 |
| --- | --- |
| 结构 struct | STRUCT-01 必填/类型；STRUCT-02 主键唯一；STRUCT-03 OHLC 关系 `high ≥ max(open,close) ≥ min(open,close) ≥ low`；STRUCT-04 价格 > 0、volume/amount ≥ 0；STRUCT-05 价格小数位 ≤ 2；STRUCT-06 因子 > 0 且每根 bar 有因子 |
| 业务 business | BIZ-01 涨跌幅在板块限内（容差 0.5pp；上市首日不判；注册制新股上市后前 5 个交易日不判，科创 ≥2019-07-22/创业 ≥2020-08-24/主板 ≥2023-04-10；未知板块 fail-closed）；BIZ-02 prev_close 缺失（warn）；BIZ-03 ST 时点性限制（warn，L80） |
| 完整性/及时性 completeness | COMP-01 无周末 bar；COMP-02 as_of 属当日 ≥15:00（T 日收盘后取数）；COMP-03 工作日覆盖（bar ∪ 停牌证据） |
| 一致性 consistency | CONS-01 prev_close = 前一交易日 close（除权日因因子变化豁免 / 首日豁免）；CONS-02 bar/因子引用的 instrument 必须在 dim_instrument；RES-03 研究数据 instrument_id 必须在 dim_instrument（index_daily 指数、margin 无 instrument 豁免）；RES-07 行业分类层级自洽（level∈{1,2,3}、level>1 必须有 parent_code、level=1 不得有、parent_code≠index_code）；RES-08 成分时点自洽（in_date ≤ snapshot_date、out_date ≥ in_date、is_new=Y 时 out_date 必须为空） |
| 研究数据 research（按类别归入） | **RES-01**（完整性）周末粗筛：`weekday()>=5` 判违规，**不含法定节假日校验**（非交易日历，P1 接 `trade_cal`）；**RES-02**（业务）量纲：**只对 DWD canonical 字段生效**，金额/量/市值非负、百分比 \|x\| ≤ 1000（ODS 源字段如 `total_mv` 不在范围）；**RES-03**（一致性）外键：A 股标识必须在 `dim_instrument`；`hk_hold` 的 `HKEX:#####` 港股命名空间显式豁免并计数（不静默跳过）；**RES-04**（完整性）per-endpoint as_of 阈值：A 股研究数据当日 15:00、`hk_hold` T+1 次日 15:00、`index_daily` 当日 15:00、`stk_limit` 当日 15:00；**RES-05**（业务，KD-DSW-P2）涨跌停原始价自洽 `previous_close>0` 且 `up_limit > previous_close > down_limit`，**不判 5/10/20/30 档位**（H4 口径）；**RES-06**（业务）财报公告时点 `announced_at ≥ report_end_date`、report_period 与季度末一致、不晚于批次 as-of（防未来函数）；**RES-07**（一致性）申万行业树层级自洽；**RES-08**（一致性）成分时点自洽（含 `is_new=N` 必须有 `out_date`）；**RES-09**（一致性，warn）`out_date > snapshot_date` 未来退出日告警。RES-01..08 均 blocker（研究域 provisional）。H4 KD-RES-HARDEN 加固：RES-07 增加同快照 parent 存在、`level(parent)=level(child)-1`、链≤2 跳到 L1 且无环（每链唯一根）；RES-05 增加 `limit_pct` 候选档重算交叉验证（按声明档 `round_half_up(prev×(1±pct/100),2)` 与 up/down 精确比对，防适配层静默错档，低价股舍入不误伤）；RES-06 对 `announced_at=null` 维持 blocker（无公告日无法 as-of join，不进可用数据） |

## 7. 待确认事项（未签字前按本文实现，签字后另起变更）

1. **复权因子归一化（L3）**：A1 归一为"累计因子，`1.0` = 该标的**最早可得因子日**"，1990-12-19 前上市的
   老股锚定 1990-12-19；DWD **不二次归一**，只校验 `factor > 0` 与"每 bar 有因子"。M02 区间收益在两种
   锚下等价、hfq 绝对价不同，故仍属复权算法变更，**待 H4 会签**；签字前按 L3 实现。
2. **主板以外 ST 的涨跌幅**：本文仅对 `board=main` 的 ST 应用 5%，创业/科创/北交所 ST 沿用板块幅度
   （与注册制规则一致）。若 H4 要求"所有 ST 一律 5%"，改 `st_limit_boards` 即可（须签字）。
3. **交易日历**：P0 的 COMP-03 用自然工作日近似，节假日会误报"缺日"；P1 接交易日历服务后替换。
4. **停牌证据（L8）**：停牌日保留 `bar.v1` 证据行（`suspended:true`），由 A1 用 `suspend_d` 按交易日批量取
   （约 4,860 次/20 年）；**不采用"停牌=无行"**，COMP-03 不降级、仍一票否决。若 A1 证明成本不可接受，
   再走 H4 降级流程。
5. **修订窗口**：DWD 保留全部 `revision` 历史；对下游只暴露 `revision = max` 的行。保留时长待 H4 定。
6. **结算/盘后数据**：C2 已定 P0 不做盘中实时（T 日 20:00 收盘数据），COMP-02 以此为门槛。
7. **质量分只计 blocker（L9）**：分子 = 命中 blocker 的不同规则数（按规则去重），warn 不进分子但计入
   该类规则总数；违规数与质量分拆成两个独立指标。当前实现见
   `warehouse/quality/checks.py::QualityReport.violation_counts` 与 `quality_config.json::scoring`。
   **待 H4 会签**，签字前按 L9 实现。
8. **证券主数据（instrument.v1）依赖**：DWD `dim_instrument` 与 BIZ-01 板块幅度、首日豁免、
   `serving_instrument` 都依赖 instrument.v1（含 board/name/listed_at）。A1 P0 竖切片首版只产
   `bar.v1 + adj_factor.v1`，故 `python3 -m warehouse.pipeline --ods-root` 在缺 instrument 批次时
   **fail-closed（退出码 2）**，不拿空维表出质量分；golden 夹具自带 instrument 不受影响。
   需列为 A1 下一任务输入依赖（最小集：stock_basic 的 instrument_id/name/board/listed_at/lot_size）。
9. **ST 历史时点性（L80，P1 数据依赖）**：P0 的 M04 只用当前名称快照判 ST，历史交易日不还原；
   输出 `known_limitation`，质量规则 BIZ-03（warn）对「当前 ST 名称且早于 `dim.as_of`」的 bar 告警。
   **P1 依赖 tushare namechange 进 ODS**（`instrument_name_history`），到位后按交易日状态重算并把
   BIZ-03 收紧为 blocker；在此之前禁止把退市/摘帽标的历史涨跌停结论用于回测或对外解释。
10. **研究数据集边界（RES-01..04，已备案）**：RES-01 是周末粗筛、非法定节假日/交易日历校验（P1 接 `trade_cal`）；
    RES-02 只对 DWD canonical 字段生效；RES-03 对 `hk_hold` 的港股命名空间 `HKEX:#####` 显式豁免并计数
    （`exemptions` 同时出现在 pipeline/load 运行摘要与 `quality.json`）；RES-04 按 endpoint 配 as_of 阈值。
    研究数据只能进 `internal/` root，**不得进 display root、不参与 `display_safe` 派生、不进 C 端 ports**；
    `index_member_all` 保留 `in_date/out_date/is_new` 全历史，`snapshot_date` 由 ODS 行或信封 as_of 派生；
    A1 `_meta/research_coverage.json` 的 `current_snapshot_only` 快照**不得用于历史回测**（DWD `coverage` 列显式标记）。
    （隔离门禁 `infra/ci/check_display_safe_failclosed.py`）。**hk_hold 状态 active_internal**：A1 港股后缀映射
    （`00700.HK → HKEX:00700`，commit `97c8f3e`）已落地，`HKEX:#####` 可经 A1 canonical 化进入
    ODS→DWD→serving；fixture 为命名空间样例，另以 A1 `map_row` → A2 loader 交叉验证；读取端对非法标识
    报错，不静默跳过、不降级成 A 股样例。

## 8. H4 会签记录（已签 2026-11-04，M04/RES-05 补签 2026-11-05；变更须重新会签）

> 以下 8 条口径 + 规则变更已由 A2 落成可执行物（SQL / 配置 / golden）。请 H4 逐条签"同意/修改"；
> 签字后把 `docs/metrics/p0_metrics.json::sign_off.status` 改为 `signed`，并记录签字人与日期。

| # | 事项 | 现状与证据 | 需 H4 确认 | H4 核签意见（2026-11-04） |
| --- | --- | --- | --- | --- |
| 1 | M01 主口径不复权 | `warehouse/metrics/m01_bars_none.sql`；DWD 只存不复权 OHLC | 同意/修改 | **可签**（不动） |
| 2 | M02 收益口径后复权 | `warehouse/metrics/m02_return_hfq.sql`；hfq = close × factor；新增 `anchor_date`/`factor_version`/`factor_as_of` | 同意/修改 | **可签**（L3 条件见 #6） |
| 3 | M04 涨跌停按板块 | `warehouse/metrics/m04_limit_status.sql`；主板 10% / 主板 ST 2026-07-06 前 5%、之后 10% / 创业板 2020-08-24 前 10%、之后 20% / 科创 2019-07-22 开板后 20% / 北交所 2021-11-15 起 30%、之前 NULL / S 股 5%（优先于 ST） / 首日 NULL / **注册制新股上市后前 5 个交易日 NULL（科创 ≥2019-07-22、创业 ≥2020-08-24、主板 ≥2023-04-10，trade_seq 全历史排序）** / listed_at 缺失 NULL；按市场取整（沪深 A half-up、北交所 floor/ceil、沪 B 0.001 美元/深 B 0.01 港元 half-up）；未知 board 与缺失上市日 fail-closed；ST 时点性 known_limitation | 同意/修改 | **H4 2026-11-05 重签通过（带条件）**：KD-M04-EFFECTIVE-DATE + KD-M04-PRE5D-NULL + 按市场取整 + B 股规则；条件见 `p0_metrics.json::sign_off.conditions` |
| 4 | M08 涨跌幅基准=prev_close | `warehouse/metrics/m08_change_pct.sql`；除权日由适配层写入除权参考价 | 同意/修改 | **可签** |
| 5 | M03/M05/M06/M07 立法但 P0 无数据 | §5；M06 的 DDL 已备（`dwd_fundamental_report`），数据待 A1 | 同意"P0 只立法" | **可签** |
| 6 | **L3 因子归一** `adj_factor = raw / anchor` | 锚=该标的最早可得因子日，老股锚 1990-12-19；DWD 不二次归一；M02 收益两锚等价、hfq 绝对价不同 | **复权算法变更，需会签** | **条件签（三件已落）**：①`m02_return_hfq.sql` 注释已改 L3（不再写"首个上市交易日"）；②输出 `anchor_date` + `factor_version`（锚变则版本串变、须重新会签）；③hfq 绝对价不进 C 端（仅收益），展示绝对价需另签 |
| 7 | **L9 质量分只计 blocker** | warn 违规不进分子；warn 规则计入该类分母 1 个槽；`violation_counts` 与 `score` 拆成两个独立指标；`quality_config.json::scoring` | 同意/修改 | **可签**（已注明 warn 计入分母，与声明一致） |
| 8 | L7/L8 输入前提 | bar 必带 `prev_close`（首日可空）；停牌保留 `suspended:true` 证据行（约 4,860 次/20 年） | 同意/修改 | **可签** |
| 9 | 质量阈值与一票否决 | 权重 0.2/0.3/0.3/0.2，阈值 95/90/85（H4-D8 已批）；叠加"任一 blocker → black + 阻断下游" | 确认叠加方式 | **可签**（分数照算、状态 black） |
| 10 | P0 边界样本 | `data/golden/p0_bars20.yaml`：37 正例 + 12 负例，含 M04 时点规则边界（G25–G32：ST 生效日前后/创业板前后/S 股/北交所前后/首日 NULL）、注册制新股前 5 日 NULL（G35–G37 正例；N10–N12 第 6 日超档 blocker）、按市场取整（G34 北交所截断）、ST 恰好 +5.00%（G21）、ST 取整边界（G22）、低价股候选档重算（G23/G24/G33）、停牌、除权 | 确认覆盖充分 | **可签**（覆盖基本够；G22–G34 随本次补） |

签字栏（H4）：

- [x] 以上 10 项全部同意（如有修改，在对应行批注；A2 先改 docs，获签字后再改 SQL）
- 签字人 / 日期：H4（数据负责人） / 2026-11-04
- [x] M04（KD-M04-EFFECTIVE-DATE + KD-M04-PRE5D-NULL + 按市场取整 + B 股规则）与 RES-05 取整口径补签：H4（数据负责人） / 2026-11-05，带 4 条条件（见 `p0_metrics.json::sign_off.conditions`）
- 备注：条件见 `p0_metrics.json::sign_off.conditions`——L3 锚变更须重签；M04 ST 按 L80 当前名称快照（BIZ-03 warn 单列，P1 namechange 到位后转 blocker）；规则集变化须记 before/after 且不得借新增 warn 规则跨阈值；M03/M05/M06/M07 数据未到不得进 C 端。

### 签署后规则集变更（2026-11-05，已备案；附注已落）

- 新增 RES-01..04（研究数据集，均 blocker）：业务规则数 3→4、完整性及时性 3→5、一致性 2→3；结构 6 不变。
- 同一 blocker（BIZ-01）命中时 business 类别分 **66.67→75.00**、总分 **90.00→92.50**，仍因一票否决 `black`；
  阈值、权重、否决规则均不变，门禁结论不变（仍阻断）。新增规则只作用于研究数据集，不影响 P0 行情门禁结论。
- `quality_config.json` version 1→2；`ruleset_note` 记录本次变更。请 H4 在 §8 备注或 decisions 中确认备案。

## 9. 变更记录

| 日期 | 变更 | 签字 |
| --- | --- | --- |
| 2026-11-04 | 初版：M01/M02/M04/M08 可执行；质量分 0.2/0.3/0.3/0.2、阈值 95/90/85、blocker 一票否决 | 待 H4 |
| 2026-11-04 | 记录 L3（因子锚=最早可得因子日，待 H4 会签）、L7（prev_close 必填）、L8（停牌证据行）；规则/阈值/否决均不变 | 待 H4 |
| 2026-11-04 | 记录 L9（质量分只计 blocker，warn 独立计数）与 §8 H4 会签清单；新增 G21（ST 恰好 +5.00%）边界样本 | 待 H4 |
| 2026-11-04 | H4 核签 2026-11-04 后修复：M04 未知板块 fail-closed（`limit_status=NULL`，BIZ-01 blocker）+ ST 时点性 L80（`known_limitation`/`st_status_source`、BIZ-03 warn）；M02 注释改 L3 锚并输出 `anchor_date`/`factor_version`/`factor_as_of`；新增 G22 取整边界 | H4 重签通过 |
| 2026-11-04 | **规则集变更 before/after（H4 条件 3）**：新增 BIZ-03（warn）后业务规则数 2→3；同一 blocker（BIZ-01）命中时 business 类别分 **50.00→66.67**、总分 **85.00→90.00**，仍因一票否决 `black`；结构 6 / 完整性 3 / 一致性 2 不变。阈值、权重、否决规则均不变；该变化不改变任何门禁结论。**signed / H4 / 2026-11-04 / 条件见 `sign_off.conditions`** | 已签 |
| 2026-11-05 | **hk_hold unblocked（KD-HK-UNBLOCK）**：A1 `.HK → HKEX:#####` 映射落地（`97c8f3e`），hk_hold 状态 active_internal；A1 `map_row` 产出的 `HKEX:00700`/`HKEX:09988` 经 ODS→DWD 质量链路验证（quality 100 green、exemptions={RES-03:2}）；本轮回填 `northbound_channel` 被 normalizer 丢弃的缺陷（`text` 白名单遗漏）并加回归 | A1 映射 + A2 全量验证 |
| 2026-11-05 | **H4 收口补充**：质量运行摘要（pipeline/load stdout）必带 `exemptions={...}`；`hk_hold` 在 A1 `.HK → HKEX` 映射落地前记 blocked，fixture 不冒充验收数据、非法标识不静默跳过 | H4 2026-11-05 收口 |
| 2026-11-05 | **H4 备案附注已落（KD-RES-FIX）**：RES-01 明确为周末粗筛（非法定节假日/交易日历，P1 接 `trade_cal`）；RES-02 限定只对 DWD canonical 字段生效；`hk_hold` 换真实港股命名空间 `HKEX:#####` 并由 RES-03 显式豁免+计数（fixture 已改 `HKEX:00700`/`HKEX:09988`）；RES-04 改 per-endpoint 阈值（`hk_hold` T+1 次日 15:00，其余当日 15:00）；新增研究数据集不得进 display root 的隔离门禁（prod 拒绝、不参与 `display_safe` 派生） | H4 备案通过（2026-11-05） |
| 2026-11-05 | 研究数据集（KD-INGEST-CONSUME）：DWD 新增 7 表、serving 新增 7 个 `serving_research_*` 内部 view（不接 C 端）；质量规则新增 RES-01..04（blocker），规则数 14→18，before/after：业务 3→4（同一 blocker 66.67→75.00、总分 90.00→92.50，仍 black）、完整性 3→5、一致性 2→3；阈值/权重/否决不变 | 已备案 2026-11-05（H4） |
| 2026-11-04 | H4 会签 §8 十项：#1/#2/#4/#5/#7/#8/#9/#10 同意；#3 按 L80 条件收（时点 ST 限制+BIZ-03 warn，未知板 fail-closed）；#6 L3 条件已落（anchor_date/factor_version、锚变重签）。条件见 `p0_metrics.json::sign_off.conditions` | H4（signed） |
| 2026-11-05 | **KD-DSW-P2 研究数据集第 2 批**：DWD 新增 `dwd_stk_limit`/`dwd_fina_indicator`/`dwd_index_classify`/`dwd_index_member_all` 4 表，serving 新增 4 个 `serving_research_*` 内部 view（不接 C 端、不改 `ports.yaml`）；loader 注册 `stk_limit.v1`/`fina_indicator.v1`/`index_classify.v1`/`index_member_all.v1`（ENDPOINT_SCHEMAS 11→15）；质量规则新增 RES-05..08（均 blocker），规则数 18→22，before/after：业务 4→6（同一 blocker 75.00→83.33、总分 92.50→95.00，仍 black）、一致性 3→5；完整性 5、结构 6 不变；阈值/权重/否决不变。H4 口径：`fina_indicator` 可见时点=announced_at（禁按 report_end_date join）、`index_member_all` 保留全历史时点字段、`index_classify` PK 含 snapshot_date、`stk_limit.limit_pct` 由 A1 派生 A2 只透传、质量层用原始价独立交叉验证（±0.3pp）；`_meta/research_coverage.json` 的 `current_snapshot_only` 显式标记为不可用于历史回测 | 已备案 2026-11-05（H4；加固三条同日落） |
| 2026-11-05 | **KD-RES-HARDEN（H4 备案加固）**：RES-07 增加树结构校验（同快照 parent 存在、层级差 1、链≤2 跳到 L1、无环）；RES-08 增加 `is_new=N → out_date 非空`；RES-05 增加 `limit_pct` 与原始价比值的独立交叉验证（±0.3pp）并在原始价合法时校验 5–30 区间；新增 RES-09（warn）`out_date > snapshot_date`。规则数 22→23（一致性 5→6），业务分母不变。**before/after（一致性单 blocker 场景）**：一致性类别分 100×(1−1/5)=80.00 → 100×(1−1/6)=83.33；其余三类满分时总分 = 0.2×100+0.3×100+0.3×100+0.2×类别分 = **96.00 → 96.67**（round 2）。仍因一票否决为 black，不跨 95/90/85 阈值、门禁结论不变；新增 warn 规则只改变分母不改变 blocker 判定。阈值/权重/否决均不变 | 已备案 2026-11-05（H4） |
| 2026-11-05 | **KD-RES-PRECISE（H4 新口径）**：RES-05 的 `limit_pct` 交叉验证由比值容差（±0.3pp）改为**候选档重算精确匹配**——声明档必须 ∈{5,10,20,30}，`round_half_up(previous_close×(1±pct/100),2)` 与 `up_limit/down_limit` 精确比对（±0.005 仅吸收浮点），与 A1 分档算法同一套；低价股舍入边界不再误伤。golden 增 G23（prev=1.35→up=1.49）/G24（prev=0.45→up=0.50），正例 22→24、总数 31→33。接口对齐：`index_member_all.out_date` 改为可选日期（键可缺/为 null，DWD 存 NULL）、`fina_indicator.update_flag`→`revision_flag`（A1 canonical，C01）。规则数仍 23、阈值/权重/否决不变 | 已备案 2026-11-05（H4；RES-05 算法按 H4 指示修订） |

| 2026-11-05 | **KD-M04-EFFECTIVE-DATE（H4 口径更正，待重签）**：M04 `limit_pct` 由静态 CASE 改按 `trade_date` 生效日规则——主板 ST `<2026-07-06` 5%、`≥` 10%；创业板 `<2020-08-24` 10%、`≥` 20%；科创板 `<2019-07-22`（开板前）NULL；北交所 `<2021-11-15` NULL、`≥` 30%；主板 S 股（S 开头非 ST）5%；首日（`trade_date=listed_at`）NULL。限价取整按市场：沪深 A 0.01 half-up、北交所 43/83/87/88/92 涨停 floor/跌停 ceil、沪 B 900xxx 0.001 half-up、深 B 200xxx 0.01 half-up（B 股待 H4 签）。quality `limit_regimes` v4 同步；golden 增 G25–G32（时点/板块/首日）、G34（北交所截断）+ G33（ST 10% 档 RES-05），正例 24→34、总数 33→43。规则条数 23 不变；对历史回补的行为变化：2026-07-06 前主板 ST 命中 5%、之后 10%；2020-08-24 前创业板 10%；2021-11-15 前北交所不判。**待 H4 重签 §8 M04 行（2026-11-04 签字不覆盖本次口径变化）** | 待重签 |
| 2026-11-05 | **KD-M04-PRE5D-NULL（H4 复核拒签后整改）**：M04/BIZ-01 增加「注册制新股上市后前 5 个交易日无涨跌幅」——科创板 listed_at ≥2019-07-22、创业板 ≥2020-08-24、主板 ≥2023-04-10，`trade_seq<=5` → `limit_pct=NULL`/`limit_status=NULL`；`trade_seq` 在 `trade_date<=:end_date` 全历史 `row_number` 后按 `start_date` 过滤，不在窗口内重置。`listed_at IS NULL` → limit_pct NULL + known_limitation（fail-closed，不猜）。S 股优先于 ST（S*ST 历史名仍 5%），写进 known_limitation。quality `ipo_no_limit` 配置 + BIZ-01 同步豁免；`_expected_limit_prices` docstring 纠正 900xxx=沪市 B 股（非北交所）；RES-05 规则文本改「按市场+报价单位取整」。golden 增 G35–G37（前 5 日 NULL）与 N10–N12（第 6 日超档 blocker），正例 34→37、负例 9→12、总数 43→49。规则条数 23 不变、阈值/权重/否决不变。B 股取整同日获 H4 签署（沪 B 41/41、深 B 35/35 命中），RES-05 两条 skip 解除、按「交易所+报价单位」启用 | 待 H4 重签 §8 M04 + RES-05 取整口径 |
| 2026-11-05 | **H4 补签 M04 + RES-05 取整口径（带条件）**：BIZ-01 规则描述补「注册制新股前 5 个交易日不判」；`st_by_current_name` 对 `S*ST…`/`SST…` 置 true（limit_pct 仍按 S 股 5%，定档逻辑不动）；新增 `m04_listed_at_coverage.sql` 诊断（`listed_at IS NULL` 只数与 bar 行占比，>1% 回 H4）；known_limitation 补「上市首日 bar 缺失 → trade_seq 窗口整体后移 1 日」；RES-05 条件：BSE 仅 92 段三日 1062/1062、43/83/87/88 无样本、每日对账 null+warn、B 股仅研究域 | 已签 2026-11-05（H4） |
10. **M04 `listed_at` 覆盖率回补验收（H4 2026-11-05 条件 7，挂回补验收清单）**：`m04_listed_at_coverage.sql`
    当前的 0/6 只代表「P0 冒烟数据无缺失」，**不是**覆盖结论。20 年全量回补完成后，A2 必须用该查询出
    `dim_instrument` 中 `listed_at IS NULL` 的只数与这些标的在全量 bar 的行数占比，并把真实数字报 H4；
    **>1% 属覆盖口径变化，回 H4 重议；≤1% 才落 `known_limitation`**。该条挂回补验收清单，回补验收时逐项核对。
11. **BSE `market_segment` 回补验收（L124①，H4 2026-11-05）**：`bar.v1` 的 `market_segment` 只在
    `BSE:` 且 `trade_date < 2021-11-15` 出现、唯一值 `neeq_select`；loader fail-closed。20 年回补完成后
    按「BSE 2021-11-15 前行 100% 带标、无一行漏标」核对；该字段只在 A2 内部 canonical/DWD，不进 C 端契约。
    **存量 ODS 核查（2026-11-05）**：扫描 `services/ingest/var/**` 全部 `bar.v1` 批次共 6 行，BSE 2021-11-15 前
    老行 **0 行**，故回补可直接重放。若未来重放含上线前采集的旧行（无 `market_segment`），loader 一律拒载、
    **不给历史行开豁免**——必须重新抓取/补标后重放（A12 replay 同样 fail-closed）。
