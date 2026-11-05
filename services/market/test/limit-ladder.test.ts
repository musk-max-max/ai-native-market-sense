import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLimitLadder } from '../src/domain/limit-ladder.js';
import type { LadderInstrument } from '../src/domain/limit-ladder.js';

function stock(id: string, name: string, board: LadderInstrument['board']): LadderInstrument {
  return { instrumentId: id, name, board, securityType: 'stock', listStatus: 'listed' };
}

describe('B1-02 涨跌停梯队（provisional 口径）', () => {
  const instruments: LadderInstrument[] = [
    stock('SSE:600001', '主板标的', 'main'),
    stock('SZSE:300001', '创业标的', 'gem'),
    stock('BSE:830001', '北交标的', 'bse'),
    stock('SSE:600002', 'ST标的', 'main'),
    stock('SSE:600003', '跌停标的', 'main'),
    { instrumentId: 'SSE:510300', name: 'ETF标的', board: 'main', securityType: 'etf', listStatus: 'listed' },
  ];

  const bars = [
    // 主板连续两日 +10%
    { instrumentId: 'SSE:600001', tradeDate: '2026-01-02', close: '10.00' },
    { instrumentId: 'SSE:600001', tradeDate: '2026-01-05', close: '11.00' },
    { instrumentId: 'SSE:600001', tradeDate: '2026-01-06', close: '12.10' },
    // 创业板连续两日 +20%
    { instrumentId: 'SZSE:300001', tradeDate: '2026-01-02', close: '20.00' },
    { instrumentId: 'SZSE:300001', tradeDate: '2026-01-05', close: '24.00' },
    { instrumentId: 'SZSE:300001', tradeDate: '2026-01-06', close: '28.80' },
    // 北交所最后一日 +30%
    { instrumentId: 'BSE:830001', tradeDate: '2026-01-02', close: '10.00' },
    { instrumentId: 'BSE:830001', tradeDate: '2026-01-05', close: '11.00' },
    { instrumentId: 'BSE:830001', tradeDate: '2026-01-06', close: '14.30' },
    // ST 按 5% 判定触板，但只进 excluded_st
    { instrumentId: 'SSE:600002', tradeDate: '2026-01-02', close: '5.00' },
    { instrumentId: 'SSE:600002', tradeDate: '2026-01-05', close: '5.50' },
    { instrumentId: 'SSE:600002', tradeDate: '2026-01-06', close: '5.78' },
    // 主板连续两日 -10%
    { instrumentId: 'SSE:600003', tradeDate: '2026-01-02', close: '10.00' },
    { instrumentId: 'SSE:600003', tradeDate: '2026-01-05', close: '9.00' },
    { instrumentId: 'SSE:600003', tradeDate: '2026-01-06', close: '8.10' },
    // ETF 不参与个股梯队
    { instrumentId: 'SSE:510300', tradeDate: '2026-01-06', close: '4.00' },
  ];

  const data = buildLimitLadder({ tradeDate: '2026-01-06', instruments, bars });

  it('规则版本与 gap 固定可追溯', () => {
    assert.equal(data.trade_date, '2026-01-06');
    assert.equal(data.rule.version, 'b1-02-provisional-v1');
    assert.equal(data.rule.st_handling, 'excluded');
    assert.deepEqual(
      data.gaps.map((gap) => gap.code),
      ['STK_LIMIT_PRECISE_PENDING', 'MARKET_BREADTH_PENDING'],
    );
  });

  it('涨停梯队按连板数降序，含连板计数与涨跌幅', () => {
    assert.deepEqual(
      data.limit_up.map((entry) => [entry.instrument_id, entry.consecutive_boards]),
      [
        ['SSE:600001', 2],
        ['SZSE:300001', 2],
        ['BSE:830001', 1],
      ],
    );
    const main = data.limit_up.find((entry) => entry.instrument_id === 'SSE:600001');
    assert.equal(main?.close, 12.1);
    assert.equal(main?.prev_close, 11);
    assert.equal(main?.change_pct, 10);
  });

  it('跌停梯队同规则；ST 只出现在 excluded_st；非股票不参与', () => {
    assert.deepEqual(
      data.limit_down.map((entry) => [entry.instrument_id, entry.consecutive_boards]),
      [['SSE:600003', 2]],
    );
    assert.deepEqual(
      data.excluded_st.map((entry) => entry.instrument_id),
      ['SSE:600002'],
    );
    const allIds = [...data.limit_up, ...data.limit_down].map((entry) => entry.instrument_id);
    assert.equal(allIds.includes('SSE:510300'), false);
    assert.equal(allIds.includes('SSE:600002'), false);
  });

  it('缺前一交易日 close 的标的不可判涨跌停', () => {
    const data = buildLimitLadder({
      tradeDate: '2026-01-06',
      instruments: [stock('SSE:600009', '无前收', 'main')],
      bars: [{ instrumentId: 'SSE:600009', tradeDate: '2026-01-06', close: '10.00' }],
    });
    assert.deepEqual(data.limit_up, []);
    assert.deepEqual(data.limit_down, []);
  });

  it('中小板股按 10% 而非 20%：+10% 触板，+19% 才是创业板触板', () => {
    const data = buildLimitLadder({
      tradeDate: '2026-01-06',
      instruments: [stock('SSE:600010', '主板二', 'main'), stock('SZSE:300010', '创业二', 'gem')],
      bars: [
        { instrumentId: 'SSE:600010', tradeDate: '2026-01-05', close: '10.00' },
        { instrumentId: 'SSE:600010', tradeDate: '2026-01-06', close: '11.00' },
        { instrumentId: 'SZSE:300010', tradeDate: '2026-01-05', close: '10.00' },
        { instrumentId: 'SZSE:300010', tradeDate: '2026-01-06', close: '11.00' },
      ],
    });
    assert.deepEqual(data.limit_up.map((entry) => entry.instrument_id), ['SSE:600010']);
  });
});
