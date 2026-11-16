/**
 * limitLadderAggregate unit tests (C-end limit-ladder wiring).
 *
 * Covers empty/unknown-time fail-closed, up/down counting by limit_status
 * (Z=unsealed touch ignored), provisional zeroing (streak/stExcluded), and
 * latest as_of selection. Plain node --test (no jsdom), staff.test.ts style.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LimitLadderRow } from '../src/data/cEndMetricsGateway.ts';
import {
  LIMIT_LADDER_CALIBER_VERSION,
  aggregateLimitLadder,
} from '../src/data/limitLadderAggregate.ts';

function row(overrides: Partial<LimitLadderRow>): LimitLadderRow {
  return {
    instrument_id: 'SSE:600000',
    instrument_name: null,
    trade_date: '2026-11-16',
    limit_pct: '10.00',
    close: '10.00',
    turnover_rate_pct: '1.23',
    pe_ttm: '8.90',
    total_market_value: '1000000000',
    limit_status: 'U',
    net_inflow_amount: '1000000',
    l1_name: null,
    as_of: '2026-11-16T15:00:00+08:00',
    ...overrides,
  };
}

test('aggregateLimitLadder returns null for empty rows (no 0-substitute)', () => {
  assert.equal(aggregateLimitLadder([]), null);
});

test('aggregateLimitLadder returns null when no row carries an as_of (unknown time)', () => {
  const rows = [row({ limit_status: 'U', as_of: null })];
  assert.equal(aggregateLimitLadder(rows), null);
});

test('counts up/down by limit_status; ignores Z (unsealed touch)', () => {
  const rows = [
    row({ instrument_id: 'SSE:600000', limit_status: 'U' }),
    row({ instrument_id: 'SSE:600001', limit_status: 'U' }),
    row({ instrument_id: 'SZSE:000002', limit_status: 'D' }),
    row({ instrument_id: 'SZSE:000003', limit_status: 'Z' }),
  ];
  const ladder = aggregateLimitLadder(rows);
  assert.ok(ladder);
  assert.equal(ladder?.upCount, 2);
  assert.equal(ladder?.downCount, 1);
});

test('is provisional: streak/stExcluded zeroed, caliber version pinned', () => {
  const rows = [
    row({ limit_status: 'U' }),
    row({ instrument_id: 'SZSE:000002', limit_status: 'D' }),
  ];
  const ladder = aggregateLimitLadder(rows);
  assert.equal(ladder?.provisional, true);
  assert.equal(ladder?.caliberVersion, LIMIT_LADDER_CALIBER_VERSION);
  assert.equal(ladder?.maxStreakDays, null);
  assert.deepEqual(ladder?.streakBuckets, []);
  assert.equal(ladder?.stExcludedCount, 0);
  assert.equal(ladder?.demo, false);
});

test('picks the latest as_of across rows for source', () => {
  const rows = [
    row({ instrument_id: 'SSE:600000', limit_status: 'U', as_of: '2026-11-16T15:00:00+08:00' }),
    row({ instrument_id: 'SZSE:000001', limit_status: 'D', as_of: '2026-11-16T15:00:05+08:00' }),
  ];
  const ladder = aggregateLimitLadder(rows);
  assert.equal(ladder?.source.asOf, '2026-11-16T15:00:05+08:00');
});
