# 限价取整独立单元测试证据（H4 m04155 补 B 股/北交所缺口）

- 生成时间：2026-11-05T14:04:44Z
- 测试文件：`tests/data/test_limit_prices_unit.py`，sha256 `9031b57ea494c555be47f8c06a46b3999163367fc6887e73193515460d216dc3`
- 实现：`tests/data/quality_lib.py::quote_unit` / `limit_prices`（独立实现，不依赖 golden 采样）
- 口径：docs/metrics/P0-metrics.md §6（H4 2026-11-05 已签 M04 + RES-05 取整）；未改 golden、未改政策数值
- 运行：`python3 -m pytest tests/data/test_limit_prices_unit.py -q`
- 结果：**11 passed in 0.02s**

## 断言覆盖

| # | 标的 | 档位 | prev | 期望涨停 | 期望跌停 | 方向 |
|---|---|---|---|---|---|---|
| 1 | SSE:900901（沪 B） | 10% | 1.234 | 1.357 | 1.111 | 0.001 half-up |
| 2 | SZSE:200011（深 B） | 10% | 5.55 | 6.11 | 5.00 | 0.01 half-up |
| 3 | BSE:920001 | 30% | 1.26 | 1.63 | 0.89 | 涨停 floor / 跌停 ceil |
| 4 | BSE:430047（43 段） | 30% | 8.33 | 10.82 | 5.84 | 涨停 floor / 跌停 ceil |
| 5 | BSE:830799（83 段） | 30% | 12.34 | 16.04 | 8.64 | 涨停 floor / 跌停 ceil |
| 6 | SSE:600182（主板 S 股） | 5% | 10.50 | 11.03 | 9.98 | 0.01 half-up（.005 进位） |

- 报价单位断言：SSE:900901=0.001；SZSE:200011/SSE:600519/SZSE:000001/BSE:920001=0.01。
- BSE 段样本说明：golden 覆盖 43（G04）与 83（G10/G30/G31）；87/88/92 段无 golden 样本，本单元测试按同规则固定方向断言，不假装有历史样本。

## 回归

- `pytest tests/data`：161 passed, 1 warning in 8.28s
- `pytest tests/contract tests/data`：224 passed, 2 warnings in 17.19s
