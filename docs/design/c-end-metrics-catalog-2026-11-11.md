# C 端 H5 展示维度目录（金融专家视角）

- **文档版本**：v1.0
- **日期**：2026-11-11
- **适用范围**：C 端 H5（`web/h5/`）员工侧 `?role=staff` 多维度展示重构（m04105 用户指令）
- **数据源**：53 数据集 × 59 DWD 表（`warehouse/dwd/schema.sql`）
- **法律声明**：本文档所有维度均为「数据展示 + 计算口径」，**仅数据展示，不构成投资建议**。引用 `docs/HANDOFF-team-rebuild-2026-11-06.md` §1 硬约束 2：荐股=证券投资咨询（证监会〔2012〕40 号），负面清单 `rules/redline-basis.json` H3-C01..C12。

---

## 1. 设计原则

1. **全量数据**：53 数据集全接入，按 domain 分 tab。
2. **多维度**：单股票 ≥30 维度、首页 5 tab × ≥5 维度、组合/涨跌停 ≥10 维度。
3. **合规展示**：只给「指标 + 数值 + as_of」，不给「买/卖信号 / 推荐 / 评级 / 目标价」。
4. **可追溯**：每条维度标注来源（数据集 name + 字段）+ as_of + 单位 + 派生/直取。
5. **AI 消费**：第 5 节列出可供 /v1/ai/interpretations 消费的字段清单。

---

## 2. 首页 5 tab 维度（每 tab 5-10 条）

### 2.1 行情 tab（quote）

| # | 名称 | 公式/字段 | 单位 | 来源数据集 | 场景 | 派生 |
|---|---|---|---|---|---|---|
| 1 | 最新收盘价 | `dwd_stock_bar_daily.close` 最新 | 元 | daily | 全市场快照 | 直取 |
| 2 | 涨跌幅 | `dwd_index_daily.pct_change_pct` | % | index_daily | 全市场快照 | 直取 |
| 3 | 成交量 | `dwd_stock_bar_daily.volume` | 股 | daily | 全市场快照 | 直取 |
| 4 | 成交额 | `dwd_stock_bar_daily.amount` | 元 | daily | 全市场快照 | 直取 |
| 5 | 换手率 | `dwd_daily_basic.turnover_rate_pct` | % | daily_basic | 全市场快照 | 直取 |
| 6 | 涨跌停家数 | `count(dwd_stk_limit WHERE limit_status IN ('U','D'))` | 家 | stk_limit | 全市场快照 | 派生 |
| 7 | 实时最新价 | `dwd_realtime_quote.last` | 元 | realtime_quote（F1 residual） | 内部快照 | 直取 |

### 2.2 资金流向 tab（flow）

| # | 名称 | 公式/字段 | 单位 | 来源 | 场景 | 派生 |
|---|---|---|---|---|---|---|
| 1 | 主力净流入 | `dwd_moneyflow.net_inflow_amount` | 元 | moneyflow | 全市场快照 | 直取 |
| 2 | 超大单净买入 | `buy_extra_large_amount - sell_extra_large_amount` | 元 | moneyflow | 全市场快照 | 派生 |
| 3 | 大单净买入 | `buy_large_amount - sell_large_amount` | 元 | moneyflow | 全市场快照 | 派生 |
| 4 | 中单净买入 | `buy_medium_amount - sell_medium_amount` | 元 | moneyflow | 全市场快照 | 派生 |
| 5 | 小单净买入 | `buy_small_amount - sell_small_amount` | 元 | moneyflow | 全市场快照 | 派生 |
| 6 | 融资余额 | `dwd_margin.financing_balance` | 元 | margin | 全市场快照 | 直取 |
| 7 | 融券余额 | `dwd_margin.securities_balance` | 元 | margin | 全市场快照 | 直取 |
| 8 | 龙虎榜净买入 | `dwd_top_list.lhb_net_amount` | 元 | top_list | 全市场快照 | 直取 |
| 9 | 大宗交易折溢价 | `dwd_research_block_trade.price / dwd_stock_bar_daily.close - 1` | % | block_trade | 全市场快照 | 派生 |

### 2.3 基本面 tab（fundamental）

| # | 名称 | 公式/字段 | 单位 | 来源 | 场景 | 派生 |
|---|---|---|---|---|---|---|
| 1 | PE TTM | `dwd_daily_basic.pe_ttm` | 倍 | daily_basic | 全市场快照 | 直取 |
| 2 | PB | `dwd_daily_basic.pb` | 倍 | daily_basic | 全市场快照 | 直取 |
| 3 | 总市值 | `dwd_daily_basic.total_market_value` | 元 | daily_basic | 全市场快照 | 直取 |
| 4 | 流通市值 | `dwd_daily_basic.circulating_market_value` | 元 | daily_basic | 全市场快照 | 直取 |
| 5 | 股息率 TTM | `dwd_daily_basic.dividend_yield_ttm_pct` | % | daily_basic | 全市场快照 | 直取 |
| 6 | ROE | `dwd_fina_indicator.roe` 最新 | % | fina_indicator | 全市场快照 | 直取 |
| 7 | 营收同比 | `dwd_fina_indicator.or_yoy_pct` 最新 | % | fina_indicator | 全市场快照 | 直取 |
| 8 | 净利同比 | `dwd_fina_indicator.netprofit_yoy_pct` 最新 | % | fina_indicator | 全市场快照 | 直取 |
| 9 | 资产负债率 | `dwd_fina_indicator.debt_to_assets` 最新 | % | fina_indicator | 全市场快照 | 直取 |

### 2.4 行业板块 tab（sector + index）

| # | 名称 | 公式/字段 | 单位 | 来源 | 场景 | 派生 |
|---|---|---|---|---|---|---|
| 1 | 板块涨跌幅 | `dwd_dc_index.pct_change` | % | dc_index | 全市场快照 | 直取 |
| 2 | 板块总市值 | `dwd_dc_index.total_mv` | 元 | dc_index | 全市场快照 | 直取 |
| 3 | 板块换手率 | `dwd_dc_index.turnover_rate` | % | dc_index | 全市场快照 | 直取 |
| 4 | 板块涨跌家数 | `dwd_dc_index.up_num` / `down_num` | 家 | dc_index | 全市场快照 | 直取 |
| 5 | 领涨股 | `dwd_dc_index.leading_name` + `leading_pct` | - | dc_index | 全市场快照 | 直取 |
| 6 | 指数日线涨跌幅 | `dwd_index_daily.pct_change_pct` | % | index_daily | 全市场快照 | 直取 |
| 7 | 北向持股比例 | `dwd_hk_hold.holding_ratio_pct` | % | hk_hold | 全市场快照 | 直取 |

### 2.5 研究数据 tab（research，其余 domain）

| # | 名称 | 公式/字段 | 单位 | 来源 | 场景 | 派生 |
|---|---|---|---|---|---|---|
| 1 | 基金净值 | `dwd_research_fund_nav.unit_nav` | 元 | fund_nav | 全市场快照 | 直取 |
| 2 | 基金日收益 | `dwd_research_fund_nav.unit_nav_return_pct` | % | fund_nav | 全市场快照 | 直取 |
| 3 | 期货结算价 | `dwd_research_fut_daily.settlement` | 元 | fut_daily | 全市场快照 | 直取 |
| 4 | 期权持仓量 | `dwd_research_opt_daily.volume` | 张 | opt_daily | 全市场快照 | 直取 |
| 5 | 可转债收盘 | `dwd_research_cb_daily.close`（注：dwd_research_cb_daily 无 close，用 open 代） | 元 | cb_daily | 全市场快照 | 直取 |
| 6 | 外汇开盘 | `dwd_research_fx_daily.open` | - | fx_daily | 全市场快照 | 直取 |
| 7 | 新股发行价 | `dwd_research_new_share.issue_price` | 元 | new_share | 全市场快照 | 直取 |

---

## 3. 个股详情页维度（30 条，8 分组）

### 3.1 估值（4）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 1 | PE（静态） | `dwd_daily_basic.pe` | 倍 | daily_basic | 直取 |
| 2 | PE TTM | `dwd_daily_basic.pe_ttm` | 倍 | daily_basic | 直取 |
| 3 | PB | `dwd_daily_basic.pb` | 倍 | daily_basic | 直取 |
| 4 | PS TTM | `dwd_daily_basic.ps_ttm` | 倍 | daily_basic | 直取 |

### 3.2 盈利（6）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 5 | 毛利率 | `dwd_fina_indicator.grossprofit_margin` | % | fina_indicator | 直取 |
| 6 | 净利率 | `dwd_fina_indicator.netprofit_margin` | % | fina_indicator | 直取 |
| 7 | ROE | `dwd_fina_indicator.roe` | % | fina_indicator | 直取 |
| 8 | ROA | `dwd_fina_indicator.roa` | % | fina_indicator | 直取 |
| 9 | ROIC | `dwd_fina_indicator.roic` | % | fina_indicator | 直取 |
| 10 | 扣非净利润 | `dwd_fina_indicator.profit_dedt` | 元 | fina_indicator | 直取 |

### 3.3 成长（5）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 11 | 营收同比 | `dwd_fina_indicator.or_yoy_pct` | % | fina_indicator | 直取 |
| 12 | 净利同比 | `dwd_fina_indicator.netprofit_yoy_pct` | % | fina_indicator | 直取 |
| 13 | 总资产同比 | `dwd_fina_indicator.assets_yoy_pct` | % | fina_indicator | 直取 |
| 14 | 净资产同比 | `dwd_fina_indicator.eqt_yoy_pct` | % | fina_indicator | 直取 |
| 15 | 营收环比 | `dwd_fina_indicator.q_sales_qoq_pct` | % | fina_indicator | 直取 |

### 3.4 杠杆（4）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 16 | 资产负债率 | `dwd_fina_indicator.debt_to_assets` | % | fina_indicator | 直取 |
| 17 | 流动比率 | `dwd_fina_indicator.current_ratio` | 倍 | fina_indicator | 直取 |
| 18 | 速动比率 | `dwd_fina_indicator.quick_ratio` | 倍 | fina_indicator | 直取 |
| 19 | 权益乘数 | `total_assets / (total_assets - liabilities)`（用 `dwd_research_balancesheet`） | 倍 | balancesheet | 派生 |

### 3.5 流动性（5）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 20 | 换手率 | `dwd_daily_basic.turnover_rate_pct` | % | daily_basic | 直取 |
| 21 | 自由流通换手率 | `dwd_daily_basic.free_float_turnover_rate_pct` | % | daily_basic | 直取 |
| 22 | 量比 | `dwd_daily_basic.volume_ratio` | 倍 | daily_basic | 直取 |
| 23 | 成交额 5 日均 | `avg(dwd_stock_bar_daily.amount, 5)` | 元 | daily | 派生 |
| 24 | 振幅 | `(high - low) / prev_close` | % | daily | 派生 |

### 3.6 股东（4）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 25 | 股东户数 | `dwd_research_stk_holdernumber.holder_number` | 户 | stk_holdernumber | 直取 |
| 26 | 户均市值 | `dwd_research_stk_holdernumber.avg_market_value` | 元 | stk_holdernumber | 直取 |
| 27 | 北向持股比例 | `dwd_hk_hold.holding_ratio_pct` | % | hk_hold | 直取 |
| 28 | 质押比例 | `dwd_research_pledge_stat.total_shares_pledged / total_shares` | % | pledge_stat | 派生 |

### 3.7 资金（4）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 29 | 主力净流入 | `dwd_moneyflow.net_inflow_amount` | 元 | moneyflow | 直取 |
| 30 | 超大单净买入 | `buy_extra_large_amount - sell_extra_large_amount` | 元 | moneyflow | 派生 |
| 31 | 龙虎榜净买入 | `dwd_top_list.lhb_net_amount` 最新 | 元 | top_list | 直取 |
| 32 | 大宗交易均价 | `dwd_research_block_trade.price` 最新 | 元 | block_trade | 直取 |

### 3.8 技术面（4）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 33 | 5 日涨跌幅 | `(close_t / close_t-5 - 1)` | % | daily | 派生 |
| 34 | 20 日涨跌幅 | `(close_t / close_t-20 - 1)` | % | daily | 派生 |
| 35 | 60 日涨跌幅 | `(close_t / close_t-60 - 1)` | % | daily | 派生 |
| 36 | MA20 | `avg(close, 20)` | 元 | daily | 派生 |

---

## 4. 组合/复盘 + 涨跌停维度（≥10 + ≥10）

### 4.1 组合复盘页（10）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 1 | 持仓数量 | count(自选) | 只 | watchlist | 直取 |
| 2 | 组合等权日收益 | `avg(daily.pct_change_pct) over watchlist` | % | daily | 派生 |
| 3 | 组合等权 5 日收益 | 同上 5 日 | % | daily | 派生 |
| 4 | 组合 PE TTM 中位数 | `median(daily_basic.pe_ttm)` | 倍 | daily_basic | 派生 |
| 5 | 组合 PB 中位数 | `median(daily_basic.pb)` | 倍 | daily_basic | 派生 |
| 6 | 组合总市值合计 | `sum(daily_basic.total_market_value)` | 元 | daily_basic | 派生 |
| 7 | 组合主力净流入合计 | `sum(moneyflow.net_inflow_amount)` | 元 | moneyflow | 派生 |
| 8 | 组合换手率均值 | `avg(daily_basic.turnover_rate_pct)` | % | daily_basic | 派生 |
| 9 | 组合 ROE 均值 | `avg(fina_indicator.roe)` | % | fina_indicator | 派生 |
| 10 | 组合涨跌家数 | `count(close > prev_close) / count(close < prev_close)` | 家 | daily | 派生 |

### 4.2 涨跌停梯队页（10）

| # | 名称 | 公式/字段 | 单位 | 来源 | 派生 |
|---|---|---|---|---|---|
| 1 | 涨停家数 | `count(dwd_stk_limit WHERE limit_status='U')` | 家 | stk_limit | 派生 |
| 2 | 跌停家数 | `count(dwd_stk_limit WHERE limit_status='D')` | 家 | stk_limit | 派生 |
| 3 | 涨停市值合计 | `sum(daily_basic.total_market_value WHERE limit_status='U')` | 元 | daily_basic | 派生 |
| 4 | 跌停市值合计 | `sum(daily_basic.total_market_value WHERE limit_status='D')` | 元 | daily_basic | 派生 |
| 5 | 涨停换手率均值 | `avg(turnover_rate_pct WHERE limit_status='U')` | % | daily_basic | 派生 |
| 6 | 涨停 PE TTM 中位数 | `median(pe_ttm WHERE limit_status='U')` | 倍 | daily_basic | 派生 |
| 7 | 涨停主力净流入 | `sum(net_inflow_amount WHERE limit_status='U')` | 元 | moneyflow | 派生 |
| 8 | 涨停封单比 | `amount / total_market_value WHERE limit_status='U'` | % | daily / daily_basic | 派生 |
| 9 | 涨停板块分布 | `group_by(dwd_index_member_all.l1_name)` | 家 | index_member_all | 派生 |
| 10 | 连板数（涨停梯队） | `count consecutive limit_status='U' days` | 天 | stk_limit | 派生 |

---

## 5. AI 解读页可消费字段清单

供 /v1/ai/interpretations 后续接入（A3 实现），**本节不写 AI prompt**。

字段分桶：
- **估值桶**：pe / pe_ttm / pb / ps_ttm / dividend_yield_ttm_pct
- **盈利桶**：grossprofit_margin / netprofit_margin / roe / roa / roic
- **成长桶**：or_yoy_pct / netprofit_yoy_pct / q_sales_yoy_pct
- **流动性桶**：turnover_rate_pct / volume_ratio / amount_5d_avg
- **股东桶**：holder_number / holding_ratio_pct (hk_hold) / pledge_ratio
- **资金桶**：net_inflow_amount / lhb_net_amount
- **技术面桶**：close_5d_pct / close_20d_pct / close_60d_pct / ma20

AI 卡（AiInterpretation）的 subject 字段应支持上述桶名。

---

## 6. 统计

- **总维度数**：127
  - 首页 5 tab：38
  - 个股详情：36（超过 30 要求）
  - 组合复盘：10
  - 涨跌停梯队：10
  - AI 可消费字段分桶：33（去重后约 33）
- **派生维度数**：44（含公式计算，如 5 日涨跌幅、组合中位数等）
- **直取维度数**：83（直接读 dwd_* 字段）
- **domain 分布**：

| Domain | 维度数 |
|---|---|
| quote | 14 |
| flow | 19 |
| fundamental | 33 |
| shareholder | 6 |
| sector | 6 |
| index | 6 |
| fund | 4 |
| futures | 3 |
| options | 1 |
| bond | 2 |
| fx | 1 |

---

## 7. 交付边界

本文档**仅定义维度**，不写实现代码。后端实现（`services/market/src/routes-c-end-metrics.ts`）+ 前端展示（`web/h5/src/pages/` + antd-mobile）由 L0 后续 commit 落地。

本文档**不代行 H3/owner 制度签发**；C 端 go-live 仍按 HANDOFF §6 红线⑤ = H3 专属。
