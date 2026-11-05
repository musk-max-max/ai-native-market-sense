import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPageSummary } from '../src/domain/page-summary.js';

describe('B1-03 个股页五段骨架 + 数据缺口', () => {
  it('五段顺序固定；行情/财务可用时给 data_refs，其余 pending + 固定 gap', () => {
    const data = buildPageSummary({
      instrumentId: 'SSE:600519',
      restricted: false,
      quote: { asOf: '2026-11-03T15:00:00+08:00', tradeDate: '2026-11-03' },
      fundamental: { asOf: '2026-10-31T18:00:00+08:00', reportPeriod: '2026Q3' },
    });

    assert.deepEqual(
      data.sections.map((section) => [section.id, section.availability]),
      [
        ['quote', 'available'],
        ['fundamental', 'available'],
        ['valuation', 'pending'],
        ['capital', 'pending'],
        ['risk', 'pending'],
      ],
    );
    assert.deepEqual(data.sections[0]?.data_refs, [
      { module: 'market.quote', as_of: '2026-11-03T15:00:00+08:00', period: '2026-11-03' },
    ]);
    assert.deepEqual(
      data.gaps.map((gap) => gap.code),
      ['DAILY_BASIC_MISSING', 'MONEYFLOW_MISSING', 'RISK_DATASETS_MISSING'],
    );
  });

  it('无行情/无财务：标 gap 并给显式原因，不返回 0 或空对象', () => {
    const data = buildPageSummary({
      instrumentId: 'SSE:600519',
      restricted: false,
      quote: null,
      fundamental: null,
    });
    assert.deepEqual(
      data.sections.slice(0, 2).map((section) => section.availability),
      ['gap', 'gap'],
    );
    assert.deepEqual(
      data.gaps.map((gap) => gap.code),
      [
        'DATA_NOT_READY',
        'FUNDAMENTAL_NOT_READY',
        'DAILY_BASIC_MISSING',
        'MONEYFLOW_MISSING',
        'RISK_DATASETS_MISSING',
      ],
    );
    for (const section of data.sections) {
      assert.equal('payload' in section, false);
    }
  });

  it('受限档：行情/财务标 restricted，不带 data_refs 与数值', () => {
    const data = buildPageSummary({
      instrumentId: 'SSE:600519',
      restricted: true,
      quote: { asOf: '2026-11-03T15:00:00+08:00', tradeDate: '2026-11-03' },
      fundamental: { asOf: '2026-10-31T18:00:00+08:00', reportPeriod: '2026Q3' },
    });
    assert.equal(data.sections[0]?.availability, 'restricted');
    assert.equal(data.sections[1]?.availability, 'restricted');
    assert.deepEqual(data.sections[0]?.data_refs, []);
    assert.deepEqual(data.sections[1]?.data_refs, []);
    const text = JSON.stringify(data);
    for (const forbidden of ['last_price', 'close', 'volume', 'amount', 'change_pct', '1510']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });
});
