import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPortfolioReview } from '../src/domain/portfolio-review.js';

function closeTo(actual: number | null, expected: number, tolerance = 1e-3): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `${String(actual)} != ${expected}`);
}

const from = '2026-01-01';
const to = '2026-01-31';

describe('B1-01 自选组合绝对表现（确定性计算）', () => {
  it('区间收益 / 波动率 / 最大回撤 / 等权组合，缺口显式', () => {
    const data = buildPortfolioReview({
      from,
      to,
      adjustment: 'qfq',
      items: [
        {
          instrumentId: 'SSE:600519',
          name: '标的A',
          bars: [
            { tradeDate: '2026-01-02', close: '100.00' },
            { tradeDate: '2026-01-05', close: '110.00' },
            { tradeDate: '2026-01-06', close: '99.00' },
          ],
        },
        {
          instrumentId: 'SZSE:000001',
          name: '标的B',
          bars: [
            { tradeDate: '2026-01-02', close: '50.00' },
            { tradeDate: '2026-01-05', close: '55.00' },
            { tradeDate: '2026-01-06', close: '60.50' },
          ],
        },
      ],
    });

    const [a, b] = data.items;
    assert.equal(a?.range_return_pct, -1);
    assert.equal(a?.data_points, 3);
    closeTo(a?.volatility_pct ?? null, 224.4994);
    assert.equal(a?.max_drawdown_pct, -10);
    assert.equal(b?.range_return_pct, 21);

    assert.equal(data.portfolio?.equal_weight_return_pct, 10);
    assert.equal(data.portfolio?.data_points, 3);
    assert.equal(data.portfolio?.start_date, '2026-01-02');
    assert.equal(data.portfolio?.end_date, '2026-01-06');
    closeTo(data.portfolio?.volatility_pct ?? null, 112.2497);
    assert.equal(data.universe.count, 2);
    assert.equal(data.universe.indicators_available, 2);

    assert.deepEqual(
      data.gaps.map((gap) => gap.code),
      ['BENCHMARK_PENDING'],
    );
    assert.equal(data.adjustment, 'qfq');
  });

  it('历史不足的标的不补数：指标为 null 并进入 PARTIAL_HISTORY', () => {
    const data = buildPortfolioReview({
      from,
      to,
      adjustment: 'none',
      items: [
        {
          instrumentId: 'SSE:600519',
          name: '只有一天',
          bars: [{ tradeDate: '2026-01-02', close: '10.00' }],
        },
      ],
    });
    assert.deepEqual(data.items, []);
    assert.equal(data.portfolio, null);
    assert.equal(data.universe.count, 1);
    assert.equal(data.universe.indicators_available, 0);
    assert.deepEqual(
      data.gaps.map((gap) => gap.code),
      ['PARTIAL_HISTORY', 'BENCHMARK_PENDING'],
    );
  });

  it('空自选：200 空 items，不伪造组合指标', () => {
    const data = buildPortfolioReview({ from, to, adjustment: 'qfq', items: [] });
    assert.deepEqual(data.items, []);
    assert.equal(data.portfolio, null);
    assert.equal(data.universe.count, 0);
    assert.deepEqual(
      data.gaps.map((gap) => gap.code),
      ['BENCHMARK_PENDING'],
    );
  });
});
