/**
 * 适配器单测：用 stub pg.Pool 验证 SQL 形状与行映射（不连真实 PostgreSQL）。
 * 重点：serving 行级 source/as_of/staleness 直出、decimal 字符串不转 number、bars limit+1/倒序翻正、
 * 自选幂等 ON CONFLICT 与 advisory lock 幂等建表。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';

import { PgEntitlementControlRepo } from '../src/adapters/pg-entitlement-control-repo.js';
import { PgEntitlementEventRepo } from '../src/adapters/pg-entitlement-event-repo.js';
import { PgServingRepo } from '../src/adapters/pg-serving-repo.js';
import { PgWatchlistRepo } from '../src/adapters/pg-watchlist-repo.js';

type QueryResult = { rows: unknown[]; rowCount?: number };

class StubPool {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(private readonly rowsFor: (sql: string, params?: unknown[]) => unknown[]) {}

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.queries.push({ sql, ...(params !== undefined ? { params } : {}) });
    return { rows: this.rowsFor(sql, params), rowCount: 0 };
  }
}

const sourceColumns = {
  source: 'tushare',
  as_of: '2026-11-04T09:30:00+08:00',
  staleness_ms: '1800000',
};

describe('PgServingRepo', () => {
  it('instrument：行级 source/as_of/staleness 直出，lot_size 数字转换，SQL 全限定 serving schema', async () => {
    const pool = new StubPool(() => [
      {
        ...sourceColumns,
        instrument_id: 'SSE:600519',
        exchange: 'SSE',
        code: '600519',
        name: '贵州茅台',
        board: 'main',
        security_type: 'stock',
        list_status: 'listed',
        lot_size: '100',
        listed_at: '2001-08-27',
      },
    ]);
    const repo = new PgServingRepo(pool as unknown as Pool);
    const row = await repo.getInstrument('SSE:600519');
    assert.ok(row !== null);
    assert.equal(row.source, 'tushare');
    assert.equal(row.asOf, '2026-11-04T09:30:00+08:00');
    assert.equal(row.stalenessMs, 1800000);
    assert.equal(row.lot_size, 100);
    const sql = pool.queries[0]?.sql ?? '';
    assert.match(sql, /FROM serving\.serving_instrument/);
    assert.doesNotMatch(sql, /\bFROM\s+(?:dwd_|dim_)/);
    assert.deepEqual(pool.queries[0]?.params, ['SSE:600519']);
  });

  it('instrument：查不到返回 null', async () => {
    const repo = new PgServingRepo(new StubPool(() => []) as unknown as Pool);
    assert.equal(await repo.getInstrument('SSE:600519'), null);
  });

  it('quote：停牌行价格 null 原样保留（不在这里补 0），volume 字符串转整数', async () => {
    const pool = new StubPool(() => [
      {
        ...sourceColumns,
        instrument_id: 'SSE:600519',
        trade_date: '2026-11-03',
        open: null,
        high: null,
        low: null,
        close: null,
        prev_close: null,
        change: null,
        change_pct: null,
        volume: '1234500',
        amount: '2080000000.00',
        suspended: true,
        limit_status: 'none',
      },
    ]);
    const repo = new PgServingRepo(pool as unknown as Pool);
    const row = await repo.getQuote('SSE:600519');
    assert.ok(row !== null);
    assert.equal(row.close, null);
    assert.equal(row.volume, 1234500);
    assert.equal(row.amount, '2080000000.00');
    assert.equal(row.suspended, true);
    assert.match(pool.queries[0]?.sql ?? '', /FROM serving\.serving_quote_latest/);
  });

  it('bars：limit+1 判 has_more、DESC 转升序、闭区间参数绑定', async () => {
    const pool = new StubPool((sql, params) => {
      assert.match(sql, /ORDER BY trade_date DESC/);
      assert.deepEqual(params, ['SSE:600519', 'hfq', '2026-11-01', '2026-11-03', 3]);
      return [
        { ...sourceColumns, instrument_id: 'SSE:600519', trade_date: '2026-11-03', adj_type: 'hfq', open: '1', high: '1', low: '1', close: '1', volume: '10', amount: '10.00', factor: '2.0' },
        { ...sourceColumns, instrument_id: 'SSE:600519', trade_date: '2026-11-02', adj_type: 'hfq', open: '1', high: '1', low: '1', close: '1', volume: '10', amount: '10.00', factor: '2.0' },
        { ...sourceColumns, instrument_id: 'SSE:600519', trade_date: '2026-11-01', adj_type: 'hfq', open: '1', high: '1', low: '1', close: '1', volume: '10', amount: '10.00', factor: '2.0' },
      ];
    });
    const repo = new PgServingRepo(pool as unknown as Pool);
    const page = await repo.getBars({
      instrumentId: 'SSE:600519',
      adjType: 'hfq',
      from: '2026-11-01',
      to: '2026-11-03',
      limit: 2,
    });
    assert.equal(page.hasMore, true);
    assert.equal(page.adjustment, 'hfq');
    assert.deepEqual(
      page.rows.map((row) => row.trade_date),
      ['2026-11-02', '2026-11-03'],
    );
    assert.equal(page.rows[0]?.volume, 10);
    assert.equal(page.rows[0]?.close, '1');
  });

  it('fundamental：audited 行映射 + 可选字段原样（null 保留）', async () => {
    const pool = new StubPool(() => [
      {
        ...sourceColumns,
        instrument_id: 'SSE:600519',
        report_period: '2026Q3',
        report_end_date: '2026-09-30',
        announced_at: '2026-10-25T00:00:00+08:00',
        statement_basis: 'reported',
        currency: 'CNY',
        revenue: '100.00',
        net_profit: '50.00',
        revenue_yoy_pct: '10.5000',
        net_profit_yoy_pct: null,
        eps: null,
        roe_pct: '30.0000',
        gross_margin_pct: null,
      },
    ]);
    const repo = new PgServingRepo(pool as unknown as Pool);
    const row = await repo.getFundamentalSummary('SSE:600519');
    assert.ok(row !== null);
    assert.equal(row.report_period, '2026Q3');
    assert.equal(row.revenue, '100.00');
    assert.equal(row.revenue_yoy_pct, '10.5000');
    assert.equal(row.net_profit_yoy_pct, null);
  });

  it('非法枚举/负数 staleness 视为 serving 契约破坏（抛错→上层 500，不静默容忍）', async () => {
    const repo = new PgServingRepo(
      new StubPool(() => [
        {
          ...sourceColumns,
          staleness_ms: '-1',
          instrument_id: 'SSE:600519',
          exchange: 'SSE',
          code: '600519',
          name: '贵州茅台',
          board: 'main',
          security_type: 'stock',
          list_status: 'listed',
          lot_size: '100',
          listed_at: null,
        },
      ]) as unknown as Pool,
    );
    await assert.rejects(() => repo.getInstrument('SSE:600519'), /staleness_ms/);
  });
});

describe('PgWatchlistRepo', () => {
  it('add 新增：INSERT ... ON CONFLICT DO NOTHING RETURNING；返回 created=true', async () => {
    const pool = new StubPool((sql) => {
      if (sql.includes('INSERT')) return [{ instrument_id: 'SSE:600519', added_at: new Date('2026-11-01T01:00:00Z') }];
      return [];
    });
    const repo = new PgWatchlistRepo(pool as unknown as Pool, 'watchlist_items');
    const result = await repo.add('u1', 'SSE:600519', 100);
    assert.equal(result.created, true);
    assert.equal(result.item.instrument_id, 'SSE:600519');
    assert.match(pool.queries[0]?.sql ?? '', /ON CONFLICT \(user_id, instrument_id\) DO NOTHING/);
    assert.deepEqual(pool.queries[0]?.params, ['u1', 'SSE:600519']);
  });

  it('add 幂等：冲突后读回首次 added_at（不更新 added_at）', async () => {
    const pool = new StubPool((sql) => {
      if (sql.includes('INSERT')) return [];
      return [{ instrument_id: 'SSE:600519', added_at: new Date('2026-10-01T01:00:00Z') }];
    });
    const repo = new PgWatchlistRepo(pool as unknown as Pool, 'watchlist_items');
    const result = await repo.add('u1', 'SSE:600519', 100);
    assert.equal(result.created, false);
    assert.equal(pool.queries.length, 2);
    assert.match(pool.queries[1]?.sql ?? '', /SELECT instrument_id, added_at FROM "watchlist_items"/);
  });

  it('list 最近加入在前、remove 幂等 DELETE、非法表名启动期拒绝', async () => {
    const pool = new StubPool(() => []);
    const repo = new PgWatchlistRepo(pool as unknown as Pool, 'watchlist_items');
    await repo.list('u1');
    assert.match(pool.queries[0]?.sql ?? '', /ORDER BY added_at DESC/);
    await repo.remove('u1', 'SSE:600519');
    assert.match(pool.queries[1]?.sql ?? '', /DELETE FROM "watchlist_items"/);
    assert.throws(() => new PgWatchlistRepo(pool as unknown as Pool, 'watchlist; drop table x'), /非法/);
  });

  it('ensureSchema：advisory lock + CREATE TABLE/INDEX IF NOT EXISTS，finally 释放锁', async () => {
    const statements: string[] = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string) {
            statements.push(sql);
            // to_regclass 预检：返回 null → 走 CREATE TABLE/INDEX（模拟空库）
            if (sql.includes('to_regclass')) return { rows: [{ table_name: null }] };
            return { rows: [] };
          },
          release() {
            statements.push('--released--');
          },
        };
      },
    } as unknown as Pool;
    const repo = new PgWatchlistRepo(pool, 'watchlist_items');
    await repo.ensureSchema();
    assert.ok(statements.some((sql) => sql.includes('pg_advisory_lock')));
    assert.ok(statements.some((sql) => /CREATE TABLE IF NOT EXISTS "watchlist_items"/.test(sql)));
    assert.ok(statements.some((sql) => /CREATE INDEX IF NOT EXISTS watchlist_items_user_added_idx/.test(sql)));
    assert.ok(statements.includes('--released--'));
  });
});


describe('PgServingRepo：display_safe 受众过滤（L30）', () => {
  it('c_end 受众 SQL 追加 display_safe=true；internal 受众不过滤（内部评测态可取）', async () => {
    const baseRow = {
      ...sourceColumns,
      instrument_id: 'SSE:600519',
      exchange: 'SSE',
      code: '600519',
      name: '贵州茅台',
      board: 'main',
      security_type: 'stock',
      list_status: 'listed',
      lot_size: '100',
      listed_at: '2001-08-27',
      display_safe: true,
    };
    const cEndPool = new StubPool(() => [baseRow]);
    const cEnd = new PgServingRepo(cEndPool as unknown as Pool);
    const row = await cEnd.getInstrument('SSE:600519', 'c_end');
    assert.equal(row?.display_safe, true);
    assert.match(cEndPool.queries[0]?.sql ?? '', /display_safe = true/);

    const internalPool = new StubPool(() => [{ ...baseRow, display_safe: false }]);
    const internal = new PgServingRepo(internalPool as unknown as Pool);
    const hidden = await internal.getInstrument('SSE:600519', 'internal');
    assert.equal(hidden?.display_safe, false);
    assert.doesNotMatch(internalPool.queries[0]?.sql ?? '', /display_safe = true/);
  });
});

describe('授权端口适配器：control 只读 / 事件 INSERT-only', () => {
  it('control 行读取 audit.entitlement_hold_state 视图（hold_reason AS reason）WHERE id = 1，并把 NULL 保留为 null（gate 判 stale）', async () => {
    const pool = new StubPool(() => [{ hold: true, hold_id: null, hold_reason: null, last_reconciled_at: null }]);
    const repo = new PgEntitlementControlRepo(pool as unknown as Pool);
    const row = await repo.fetchControl();
    assert.equal(row?.hold, true);
    assert.equal(row?.lastReconciledAt, null);
    const sql = pool.queries[0]?.sql ?? '';
    assert.match(sql, /FROM audit\.entitlement_hold_state WHERE id = 1/);
    assert.match(sql, /^SELECT hold, hold_id, hold_reason AS reason, last_reconciled_at/);
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
  });

  it('control 无行返回 null（调用方 fail-closed）', async () => {
    const pool = new StubPool(() => []);
    const repo = new PgEntitlementControlRepo(pool as unknown as Pool);
    assert.equal(await repo.fetchControl(), null);
  });

  it('事件写入 INSERT audit.entitlement_events（不含 event_key 列）+ 裸 ON CONFLICT DO NOTHING，无 UPDATE/DELETE', async () => {
    const pool = new StubPool(() => []);
    const repo = new PgEntitlementEventRepo(pool as unknown as Pool);
    await repo.insert({
      eventKey: 'obs|boot-1',
      eventType: 'tier_state_observed',
      occurredAt: new Date('2026-11-04T02:00:00Z'),
      bootId: 'boot-1',
      stateVersion: 0,
      oldValue: { effective_tier: 'internal_eval' },
      newValue: { effective_tier: 'internal_eval' },
      reason: 'startup',
      effectiveTier: 'internal_eval',
      configuredTier: 'internal_eval',
      configFingerprint: 'a'.repeat(64),
    });
    const sql = pool.queries[0]?.sql ?? '';
    assert.match(sql, /INSERT INTO audit\.entitlement_events/);
    assert.match(sql, /ON CONFLICT DO NOTHING/);
    assert.doesNotMatch(sql, /UPDATE |DELETE FROM/);
    // A5 触发器权威计算 event_key/hash，应用列级 INSERT 无 event_key 权限。
    assert.doesNotMatch(sql.slice(0, sql.indexOf('VALUES')), /event_key/);
    const params = pool.queries[0]?.params ?? [];
    assert.equal(params[0], 'tier_state_observed');
    assert.equal(params[1], '2026-11-04T02:00:00.000Z');
    assert.equal(params[2], 'boot-1');
    assert.equal(params[5], JSON.stringify({ effective_tier: 'internal_eval' }));
    assert.equal(params[6], JSON.stringify({ effective_tier: 'internal_eval' }));
  });
});
