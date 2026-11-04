/* eslint-disable no-console */
/**
 * task-8 真栈验证脚本（本地 PG16；A11/A13 可复跑）：hold / 事件 / 链。
 *
 * 前置：目标库已应用 warehouse/dwd/schema.sql、warehouse/serving/schema.sql、
 *       services/compliance/migrations/001_audit_entitlement_events.sql、infra/db/sql/20_grants.sql，
 *       且已 seed 一条 serving_instrument（SSE:600519）。
 * 环境：
 *   MARKET_TEST_DATABASE_URL       应用角色（market_app）连接串
 *   MARKET_TEST_ADMIN_DATABASE_URL 管理员连接串（造 hold/读链/清事件用）
 * 用法：cd services/market && node --import tsx scripts/real-stack-audit.ts
 */
process.env.APP_PROFILE = 'test';
process.env.NODE_ENV = 'test';
process.env.E2E_MODE = '1';
const APP_DSN = process.env.MARKET_TEST_DATABASE_URL ?? 'postgresql://market_app@127.0.0.1:55432/market_a3_test';
const ADMIN_DSN = process.env.MARKET_TEST_ADMIN_DATABASE_URL ?? 'postgresql://ms@127.0.0.1:55432/market_a3_test';
process.env.DATABASE_URL = APP_DSN;
process.env.ENTITLEMENT_TIER = 'c_end_display';
process.env.ENTITLEMENT_EXPIRES_AT = '2030-12-31T00:00:00Z';
process.env.ENTITLEMENT_HOLD_CHECK = '1';
process.env.ENTITLEMENT_AUDIT = '1';
process.env.LOG_LEVEL = 'silent';

import { Pool } from 'pg';

import { buildApp } from '../../api/src/app.js';
import { loadMarketConfig } from '../src/config.js';
import { createMarketPlugin } from '../src/plugin.js';
import { PgEntitlementEventRepo } from '../src/adapters/pg-entitlement-event-repo.js';
import type { EntitlementEventRecord } from '../src/ports/entitlement.js';

const BOOT = '11111111-1111-4111-8111-111111111111';
const admin = new Pool({ connectionString: ADMIN_DSN });

/**
 * 让脚本可在"干净但已迁移"的库上独立跑：schema 由迁移负责，fixture 由脚本幂等自种。
 * 不建 dwd/serving/audit 表（那是 A1/A2/A5 迁移的职责），缺 schema 时给出明确报错。
 */
async function ensureFixture(): Promise<void> {
  const schema = await admin.query<{ serving: string | null; events: string | null }>(
    `SELECT to_regclass('serving.serving_instrument')::text AS serving,
            to_regclass('audit.entitlement_events')::text AS events`,
  );
  const row = schema.rows[0];
  if (row?.serving === null || row?.serving === undefined || row.events === null || row.events === undefined) {
    throw new Error(
      'real-stack: 缺 schema。请先应用 warehouse/dwd/schema.sql、warehouse/serving/schema.sql、' +
        'services/compliance/migrations/001_audit_entitlement_events.sql、infra/db/sql/20_grants.sql。',
    );
  }
  await admin.query(
    `INSERT INTO dim_instrument (instrument_id, exchange, code, name, board, security_type, list_status,
       lot_size, listed_at, display_safe, source, as_of, fetched_at, ingested_at)
     VALUES ('SSE:600519','SSE','600519','贵州茅台','main','stock','listed',100,'2001-08-27',true,
       'tushare','2026-11-03T15:00:00+08:00',now(),now()) ON CONFLICT (instrument_id) DO NOTHING`,
  );
  await admin.query(
    `INSERT INTO dwd_stock_bar_daily (instrument_id, trade_date, open, high, low, close, volume, amount,
       prev_close, source, as_of, fetched_at, batch_id, revision, ingested_at)
     VALUES ('SSE:600519','2026-11-03',1500.00,1520.00,1490.00,1510.00,1000000,1510000000.00,1505.00,
       'tushare','2026-11-03T15:00:00+08:00',now(),'a3-real-stack',0,now())
     ON CONFLICT (instrument_id, trade_date) DO NOTHING`,
  );
  await admin.query(
    `INSERT INTO dwd_adj_factor (instrument_id, trade_date, factor, source, as_of, fetched_at, batch_id, revision, ingested_at)
     VALUES ('SSE:600519','2026-11-03',1.25,'tushare','2026-11-03T15:00:00+08:00',now(),'a3-real-stack',0,now())
     ON CONFLICT (instrument_id, trade_date) DO NOTHING`,
  );
  // 自选表在生产由迁移预建；真栈脚本用管理员兜底建表并交给应用角色（幂等）。
  const watchlist = await admin.query<{ oid: string | null }>(
    `SELECT to_regclass('public.watchlist_items')::text AS oid`,
  );
  if (watchlist.rows[0]?.oid === null || watchlist.rows[0]?.oid === undefined) {
    await admin.query(
      `CREATE TABLE public.watchlist_items (
         user_id text NOT NULL, instrument_id text NOT NULL, added_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, instrument_id)
       )`,
    );
  }
  await admin.query(`ALTER TABLE public.watchlist_items OWNER TO market_app`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.watchlist_items TO market_app`);
}

function marketFieldPaths(value: unknown, path = '$'): string[] {
  const banned = new Set([
    'price', 'last_price', 'prev_close', 'change', 'change_pct', 'volume', 'amount',
    'close', 'open', 'high', 'low', 'pct_chg', 'turnover', 'quote',
  ]);
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...marketFieldPaths(v, `${path}[${i}]`)));
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (banned.has(k.toLowerCase())) hits.push(`${path}.${k}`);
      hits.push(...marketFieldPaths(v, `${path}.${k}`));
    }
  }
  return hits;
}

async function makeApp() {
  const plugin = createMarketPlugin({ bootId: BOOT });
  return buildApp({ domainPlugins: [plugin] });
}

async function main(): Promise<void> {
  await ensureFixture();
  // 0) 清 hold、清空事件（测试库专用；append-only 触发器需临时禁用）
  await admin.query(`ALTER TABLE audit.entitlement_events DISABLE TRIGGER USER`);
  await admin.query(`DELETE FROM audit.entitlement_events`);
  await admin.query(`ALTER TABLE audit.entitlement_events ENABLE TRIGGER USER`);
  await admin.query(`UPDATE audit.entitlement_hold SET hold=false, hold_id=NULL, hold_reason=NULL, set_by=NULL, set_at=NULL, last_reconciled_at=now() WHERE id=1`);

  // 1) hold=false → 200
  const app1 = await makeApp();
  const q1 = await app1.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
  const i1 = await app1.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
  console.log('normal quote', q1.statusCode, 'instrument', i1.statusCode, 'cache', q1.headers['cache-control']);
  await app1.close();

  // 2) hold 生效 → quote/bars/fundamental 403，instrument 200 且无行情字段
  await admin.query(`SELECT audit.raise_hold('e2e-hold', 'A3-TASK8-TICKET')`);
  const app2 = await makeApp();
  const q2 = await app2.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
  const b2 = await app2.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/bars' });
  const f2 = await app2.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/fundamental-summary' });
  const i2 = await app2.inject({ method: 'GET', url: '/v1/instruments/SSE:600519' });
  const i2body = i2.json() as { data: unknown; meta: { entitlement: unknown } };
  console.log('hold quote/bars/fundamental', q2.statusCode, b2.statusCode, f2.statusCode, 'codes', q2.json().code, b2.json().code, f2.json().code);
  // H3 m01357 / Lead L56：cause 诊断头已删除，验证脚本断言其不存在（防止死机制被重新接回）。
  for (const [label, response] of [['quote', q2], ['bars', b2], ['fundamental', f2]] as const) {
    if (response.headers['x-entitlement-cause'] !== undefined) {
      throw new Error(`real-stack: ${label} 403 仍带 X-Entitlement-Cause`);
    }
  }
  console.log('hold 403 no X-Entitlement-Cause');
  console.log('hold instrument', i2.statusCode, 'entitlement', JSON.stringify(i2body.meta.entitlement));
  console.log('hold instrument market-field leaks', JSON.stringify(marketFieldPaths(i2body.data)));

  // 3) 清 hold 后立即 200（门在 hold 态不缓存，下一请求回读）
  await admin.query(`SELECT audit.clear_hold('A3-TASK8-CLEAR-TICKET', 'H5', repeat('a', 64))`);
  const q3 = await app2.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
  console.log('after clear (immediate) quote', q3.statusCode);
  await app2.close();

  // 4) 事件：A3 启动/清 hold 记录 + 重放幂等 + hash 链
  const marketPool = new Pool({ connectionString: APP_DSN });
  const repo = new PgEntitlementEventRepo(marketPool);
  const record: EntitlementEventRecord = {
    eventKey: 'obs|placeholder',
    eventType: 'tier_state_observed',
    occurredAt: new Date(),
    bootId: BOOT,
    stateVersion: 1,
    oldValue: { effective_tier: 'internal_eval' },
    newValue: { effective_tier: 'internal_eval' },
    effectiveTier: 'internal_eval',
    configuredTier: 'internal_eval',
    configFingerprint: 'a'.repeat(64),
  };
  await repo.insert(record);
  await repo.insert(record); // 重放：触发器算出同一 event_key → 裸 ON CONFLICT DO NOTHING
  await marketPool.end();

  const counts = await admin.query<{ event_type: string; n: string }>(
    `SELECT event_type, count(*)::text AS n FROM audit.entitlement_events GROUP BY event_type ORDER BY event_type`,
  );
  const chainProblems = await admin.query(`SELECT count(*)::text AS n FROM audit.verify_entitlement_chain()`);
  const dupObs = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit.entitlement_events WHERE event_type='tier_state_observed' AND boot_id=$1`,
    [BOOT],
  );
  const last = await admin.query<{ event_type: string; reason: string | null; prev_hash: string; hash: string }>(
    `SELECT event_type, reason, prev_hash, hash FROM audit.entitlement_events ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
  );
  console.log('event counts', JSON.stringify(counts.rows));
  console.log('observed rows for boot (replay => 1)', dupObs.rows[0]?.n);
  console.log('chain problems', chainProblems.rows[0]?.n);
  console.log('chain head', JSON.stringify(last.rows[0]));

  // 3) 到期降档 + 留痕（L20/L59）：先降档 → 写 entitlement_expired → 才服务；event_key 逐字 UTC 毫秒。
  const expiredConfig = loadMarketConfig({
    ...process.env,
    APP_PROFILE: 'test',
    E2E_MODE: '1',
    ENTITLEMENT_TIER: 'c_end_display',
    ENTITLEMENT_EXPIRES_AT: '2026-11-01T00:00:00+08:00',
  });
  const expiredPlugin = createMarketPlugin({
    config: expiredConfig,
    bootId: '44444444-4444-4444-8444-444444444444',
  });
  const expiredApp = buildApp({ domainPlugins: [expiredPlugin] });
  const expiredQuote = await expiredApp.inject({ method: 'GET', url: '/v1/instruments/SSE:600519/quote' });
  await expiredApp.close();
  const expiredRows = await admin.query<{ event_key: string; reason: string }>(
    `SELECT event_key, reason FROM audit.entitlement_events WHERE event_type = 'entitlement_expired'`,
  );
  const expectedKey = 'exp|c_end_display|2026-10-31T16:00:00.000Z|expires_at_passed';
  console.log(
    'expired startup quote',
    expiredQuote.statusCode,
    'events',
    expiredRows.rows.length,
    'key',
    expiredRows.rows[0]?.event_key ?? '(none)',
    'reason',
    expiredRows.rows[0]?.reason ?? '(none)',
  );
  if (expiredQuote.statusCode !== 403) throw new Error('real-stack: 到期启动行情未 403');
  if (expiredRows.rows.length !== 1 || expiredRows.rows[0]?.event_key !== expectedKey) {
    throw new Error(`real-stack: 到期事件缺失或 key 不符（期望 ${expectedKey}）`);
  }

  await admin.end();
}

await main();
