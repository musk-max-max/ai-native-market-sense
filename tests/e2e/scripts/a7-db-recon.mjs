// A7 临时侦察：枚举 55432 上的库，找 serving 数据 + identity 齐备的库（只读）。
import { createRequire } from 'node:module';
const require = createRequire('/Users/leiyu/Documents/deepseek-harness/default-workspace/services/api/package.json');
const pg = require('pg');

const ADMIN = 'postgresql://ms@127.0.0.1:55432/postgres';
const c = new pg.Client({ connectionString: ADMIN, connectionTimeoutMillis: 4000 });
await c.connect();
const dbs = await c.query("SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname");
console.log('DBs:', dbs.rows.map((r) => r.datname).join(', '));
await c.end();

for (const { datname } of dbs.rows) {
  if (['postgres', 'template0', 'template1'].includes(datname)) continue;
  const cc = new pg.Client({ connectionString: 'postgresql://ms@127.0.0.1:55432/' + datname, connectionTimeoutMillis: 4000 });
  try {
    await cc.connect();
    const probe = async (sql) => {
      try { const r = await cc.query(sql); return r.rows[0].n ?? JSON.stringify(r.rows[0]); }
      catch (e) { return 'ERR:' + (e.code ?? e.message); }
    };
    const quote = await probe("SELECT count(*)::int n FROM serving.serving_quote_latest WHERE instrument_id='SSE:600519'");
    const bars = await probe("SELECT count(*)::int n FROM serving.serving_bar_daily WHERE instrument_id='SSE:600519'");
    const instr = await probe("SELECT count(*)::int n FROM serving.serving_instrument");
    const users = await probe("SELECT count(*)::int n FROM identity.users");
    const holds = await probe("SELECT count(*)::int n FROM audit.entitlement_hold");
    console.log(datname + ' | quote600519=' + quote + ' bars=' + bars + ' instruments=' + instr + ' identity.users=' + users + ' holds=' + holds);
  } catch (e) {
    console.log(datname, 'CONNECT ERR', e.message);
  }
  await cc.end().catch(() => {});
}
