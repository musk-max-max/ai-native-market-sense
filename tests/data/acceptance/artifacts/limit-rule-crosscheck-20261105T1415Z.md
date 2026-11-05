# M04 时点限价规则：参考实现逐条对照（G25–G37 / N10–N12）

- 生成时间：2026-11-05T14:02:10Z
- 实现：`tests/data/quality_lib.py` 的 `limit_pct_for` / `limit_prices` / `limit_status_for`（独立实现，不复用 warehouse）
- 口径：`docs/metrics/P0-metrics.md` §6 + `agents/decisions.md` L118/L119/L120；H4 2026-11-05 已签（M04 + RES-05 取整）
- 取整：沪深 A 0.01 half-up；北交所 43/83/87/88/92 涨停 floor、跌停 ceil；沪 B 900xxx 0.001 half-up；深 B 200xxx 0.01 half-up
- 参考实现测试：`pytest tests/data` = **150 passed / 1 warning**；全量 `pytest tests/contract tests/data` = **213 passed / 2 warnings**
- BSE 样本：golden 覆盖 43 段（G04）与 83 段（G10/G30/G31）；87/88 无样本；92 段无样本（按同规则实现）

| case | board | date | limit_pct | up | down | close | status | expect | 结论 |
|---|---|---|---|---|---|---|---|---|---|
| G25 | main | 2026-06-15 | 5.0 | 10.50 | 9.50 | 10.50 | limit_up | green | pass |
| G26 | main | 2026-07-06 | 10.0 | 11.00 | 9.00 | 11.00 | limit_up | green | pass |
| G27 | gem | 2019-06-03 | 10.0 | 11.00 | 9.00 | 11.00 | limit_up | green | pass |
| G28 | gem | 2021-06-01 | 20.0 | 12.00 | 8.00 | 12.00 | limit_up | green | pass |
| G29 | main | 2026-06-15 | 5.0 | 10.50 | 9.50 | 10.50 | limit_up | green | pass |
| G30 | bse | 2021-06-01 | NULL | - | - | 15.00 | - | green | pass |
| G31 | bse | 2021-11-15 | 30.0 | 13.00 | 7.00 | 13.00 | limit_up | green | pass |
| G32 | star | 2026-09-28 | NULL | - | - | 13.50 | - | green | pass |
| G33 | - | - | - | - | - | - | - | research_batches（stk_limit，RES-05 由 A2 pipeline 评估），A 股 bar 参考实现不适用 | 不适用 |
| G34 | - | - | - | - | - | - | - | research_batches（stk_limit，RES-05 由 A2 pipeline 评估），A 股 bar 参考实现不适用 | 不适用 |
| G35 | star | 2026-03-02 | NULL | - | - | 10.00 | - | green | pass |
| G35 | star | 2026-03-03 | NULL | - | - | 13.00 | - | green | pass |
| G36 | gem | 2021-06-01 | NULL | - | - | 10.00 | - | green | pass |
| G36 | gem | 2021-06-02 | NULL | - | - | 10.50 | - | green | pass |
| G36 | gem | 2021-06-03 | NULL | - | - | 13.65 | - | green | pass |
| G37 | main | 2023-04-10 | NULL | - | - | 10.00 | - | green | pass |
| G37 | main | 2023-04-11 | NULL | - | - | 11.50 | - | green | pass |
| N10 | star | 2026-05-04 | NULL | - | - | 10.00 | - | black BIZ-01 | pass |
| N10 | star | 2026-05-05 | NULL | - | - | 10.10 | - | black BIZ-01 | pass |
| N10 | star | 2026-05-06 | NULL | - | - | 10.20 | - | black BIZ-01 | pass |
| N10 | star | 2026-05-07 | NULL | - | - | 10.10 | - | black BIZ-01 | pass |
| N10 | star | 2026-05-08 | NULL | - | - | 10.00 | - | black BIZ-01 | pass |
| N10 | star | 2026-05-11 | 20.0 | 12.00 | 8.00 | 12.50 | limit_up | black BIZ-01 | pass |
| N11 | gem | 2021-06-01 | NULL | - | - | 10.00 | - | black BIZ-01 | pass |
| N11 | gem | 2021-06-02 | NULL | - | - | 10.10 | - | black BIZ-01 | pass |
| N11 | gem | 2021-06-03 | NULL | - | - | 10.20 | - | black BIZ-01 | pass |
| N11 | gem | 2021-06-04 | NULL | - | - | 10.10 | - | black BIZ-01 | pass |
| N11 | gem | 2021-06-07 | NULL | - | - | 10.00 | - | black BIZ-01 | pass |
| N11 | gem | 2021-06-08 | 20.0 | 12.00 | 8.00 | 12.50 | limit_up | black BIZ-01 | pass |
| N12 | main | 2023-04-10 | NULL | - | - | 10.00 | - | black BIZ-01 | pass |
| N12 | main | 2023-04-11 | NULL | - | - | 10.05 | - | black BIZ-01 | pass |
| N12 | main | 2023-04-12 | NULL | - | - | 10.02 | - | black BIZ-01 | pass |
| N12 | main | 2023-04-13 | NULL | - | - | 10.00 | - | black BIZ-01 | pass |
| N12 | main | 2023-04-14 | NULL | - | - | 10.00 | - | black BIZ-01 | pass |
| N12 | main | 2023-04-17 | 10.0 | 11.00 | 9.00 | 11.20 | limit_up | black BIZ-01 | pass |

## 结论

- 14 个 case（G25–G37 中 12 个 bar 类 + G33/G34 research_batches 不适用；N10–N12）逐 bar 对照：**0 差异**。
- 关键边界：G25/G29 主板 ST/S 股 5% 涨停命中；G26 主板 ST 2026-07-06 起 10%；G27 创业板 2019 年 10%；G28 创业板 2021 年 20%；G30 北交所开市前 NULL；G31 开市日 30%；G32 科创板首日 NULL；G35–G37 注册制前 5 日 NULL；N10–N12 第 6 日恢复档位并因超限判 BIZ-01。
- `G21`（ST 恰好 5% 取整 10.40→10.92）与 `G22`（prev=10.05, up 10.5525→10.55）也在参考实现的限价计算覆盖内（非本表 25–37 范围）。
