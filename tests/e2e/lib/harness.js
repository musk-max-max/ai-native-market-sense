// tests/e2e/lib/harness.js
// E2E 公共层（A12 owns）：准入状态、test-id 真源、API 调用、DB 检查、断言辅助。
// 设计原则：
//   1. 不在测试里硬编码选择器/URL/枚举——统一从 testids.json / scenarios / preflight 状态文件读取。
//   2. 空实现/环境未就绪 -> SKIP（test.skip），绝不把「没东西可测」算成产品失败；
//      但栈+实现就绪而 fixture 缺失 -> 由 preflight 判 FAIL，测试层不允许静默放行。
//   3. 断言只放宽「未知的展示格式」，不放宽语义：价格必须 >0、stale 阈值必须来自契约、免责版本必须一致。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(HERE, '..');
export const ROOT = path.resolve(E2E_DIR, '..', '..');
export const STATUS_FILE = process.env.E2E_STATUS_FILE || path.join(E2E_DIR, '.e2e-status.json');
// 断言不应依赖编排方式（Lead 2026-11-04）：有 DSN 直连 psql；没有才回退 docker compose exec。
// A13：本机 brew PG 真栈常用 DATABASE_URL；显式 E2E_PG_DSN/PG_DSN 优先（避免误用服务端容器内 DSN）。
export const PG_DSN = process.env.E2E_PG_DSN || process.env.PG_DSN || process.env.DATABASE_URL || '';
export const PSQL_BIN = process.env.E2E_PSQL || 'psql';
export const BASE_URL = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
export const REPLAY_URL = (process.env.E2E_REPLAY_URL || 'http://127.0.0.1:18081').replace(/\/$/, '');
// ADR-008 S1：认证是 identity JWT（无 dev-token 旁路）。token 来源优先级：
//   1. E2E_AUTH_TOKEN（CI/显式导出）；2. global-setup 自动种子/登录后写的 .state 文件（worker 读）。
// 自动种子只在 E2E_AUTH_AUTOSEED=1 时发生（见 scripts/seed_e2e_identity.py），避免默认写库。
export const TOKEN_FILE = process.env.E2E_AUTH_TOKEN_FILE || path.join(E2E_DIR, '.state', 'e2e-auth-token');
function readTokenFile() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}
export const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN || readTokenFile();
export const AUTH_STORAGE_KEY = process.env.E2E_AUTH_STORAGE_KEY || 'e2e_token';
export const STALE_THRESHOLD_MS = 900000; // shared/openapi.yaml: >15min 必须标 stale
export const COMPOSE_FILE = path.join(E2E_DIR, 'docker-compose.yml');

let _status;
let _testids;
let _scenario;

export function status() {
  if (_status) return _status;
  if (!fs.existsSync(STATUS_FILE)) {
    // Lead 2026-11-04：缺状态文件必须显式失败，不能安静地 skip 全部用例（会被误读成「环境没起来」）。
    throw new Error(
      `STATUS_FILE_MISSING: ${STATUS_FILE} 不存在。请先跑 python3 tests/e2e/scripts/preflight.py；`
      + '若确实要绕过准入（已手工验证环境），用 E2E_SKIP_PREFLIGHT=1 跑 global-setup，它会写 READY 状态。',
    );
  }
  _status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  return _status;
}

/** 每个用例开头调用：未就绪则 skip；资产/配置缺陷（decision=FAIL）则直接失败。 */
export function guard(test) {
  const s = status();
  if (s.decision === 'SKIP') {
    test.skip(true, `E2E 未就绪：${(s.reasons || []).join(' | ')}`);
  }
  if (s.decision === 'FAIL') {
    throw new Error(`preflight FAIL，E2E 资产/配置有缺陷：${(s.reasons || []).join(' | ')}`);
  }
  return s;
}

export function testids() {
  if (!_testids) _testids = JSON.parse(fs.readFileSync(path.join(E2E_DIR, 'testids.json'), 'utf8')).ids;
  return _testids;
}

/** 语义化 test-id 引用；未定义的 id 立即抛错（contract drift 必须是显式失败）。 */
export function tid(name) {
  const map = testids();
  if (!map[name]) throw new Error(`testids.json 未定义 id: ${name}（禁止在 spec 里硬编码 selector）`);
  return map[name];
}

export function scenario() {
  if (!_scenario) {
    _scenario = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'tushare', 'scenarios', 'p0-stock-page.json'), 'utf8'),
    );
  }
  return _scenario;
}

export function instrumentPath() {
  const s = scenario();
  return s.stock_page_path || `/stocks/${s.instrument_id}`;
}

export function authHeaders() {
  return AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
}

export async function api(page, method, apiPath, body) {
  const response = await page.request.fetch(apiPath, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders() },
    data: body,
  });
  return response;
}

export async function apiJson(page, apiPath) {
  const response = await api(page, 'GET', apiPath);
  const json = await response.json();
  return { response, json };
}

/** 页面内注入登录态（A7 契约：web 从 localStorage[E2E_AUTH_STORAGE_KEY] 读取 E2E token）。 */
export async function seedAuth(page) {
  if (!AUTH_TOKEN) return false;
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    [AUTH_STORAGE_KEY, AUTH_TOKEN],
  );
  return true;
}

export function isoDateInShanghai(dateLike) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(dateLike));
}

export function epochMsAsOf(meta) {
  // SourceRef.as_of 是 ISO8601 时间戳；E2E 只信它，不读服务端其他时间。
  return new Date(meta.data_source.as_of ?? meta.as_of).getTime();
}

export function isStale(meta) {
  return Number(meta.data_source?.staleness_ms ?? meta.staleness_ms) > STALE_THRESHOLD_MS;
}

/**
 * 查 PG 验证「加自选」真的落库，而不只是前端状态/缓存。
 * 两条路径查同一张表（断言依赖数据，不依赖编排方式）：
 *   1) E2E_PG_DSN / PG_DSN / DATABASE_URL 存在 -> 直连 psql <dsn>（本机/pre-prod 无 compose 也可跑）；
 *   2) 否则 -> docker compose exec postgres psql（CI 默认路径）。
 * 两条都失败时给明确错误，不静默返回 false。
 */
export function dbQuery(sql) {
  const table = process.env.E2E_WATCHLIST_TABLE || 'watchlist_items';
  if (PG_DSN) {
    let out;
    try {
      out = execFileSync(PSQL_BIN, [PG_DSN, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql],
        { encoding: 'utf8', timeout: 30000 }).trim();
    } catch (err) {
      throw new Error(`dbQuery 直连失败（E2E_PG_DSN 已设置，psql=${PSQL_BIN}）：${err.message}`
        + '；请确认 psql 在 PATH 或设置 E2E_PSQL');
    }
    return { table, out, via: 'dsn' };
  }
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'postgres', 'psql', '-U', 'market', '-d', 'market',
        '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { encoding: 'utf8', timeout: 30000 },
    ).trim();
    return { table, out, via: 'docker-compose' };
  } catch (err) {
    throw new Error(`dbQuery 失败：E2E_PG_DSN/PG_DSN/DATABASE_URL 均未设置且 docker compose exec 不可用（${err.message}）。`
      + '无 compose 环境请设置 E2E_PG_DSN 或 DATABASE_URL（见 RUNBOOK §6）');
  }
}

export function watchlistRowExists(instrumentId) {
  const { out } = dbQuery(
    `SELECT count(*) FROM ${process.env.E2E_WATCHLIST_TABLE || 'watchlist_items'} WHERE instrument_id = '${instrumentId.replace(/'/g, "''")}'`,
  );
  return Number(out) > 0;
}

export function readRecordingKeys() {
  const dir = path.join(ROOT, 'tests', 'fixtures', 'tushare', 'recordings');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
}

/** 页面通用就绪：loading 结束，且内容或错误二选一出现。 */
export async function waitForSettled(page) {
  const loading = page.getByTestId(tid('loading'));
  if (await loading.count()) {
    await loading.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  }
  const content = page.getByTestId(tid('stockHeader'));
  const error = page.getByTestId(tid('errorBanner'));
  await Promise.race([
    content.waitFor({ state: 'visible', timeout: 15000 }),
    error.waitFor({ state: 'visible', timeout: 15000 }),
  ]);
}

export async function openStockPage(page) {
  await seedAuth(page);
  const response = await page.goto(instrumentPath(), { waitUntil: 'domcontentloaded' });
  return response;
}

/** 直接打录播代理（P0-10）：验证「已录制→回放、未录制→503 FIXTURE_MISSING」，不经产品栈。 */
export async function replayPost(payload) {
  const response = await fetch(`${REPLAY_URL}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json = {};
  try { json = await response.json(); } catch { json = {}; }
  return { status: response.status, json };
}

export function assertProblemShape(body) {
  // shared/openapi.yaml Problem: required [type,title,status,code]
  const missing = ['type', 'title', 'status', 'code'].filter((k) => !(k in (body || {})));
  if (missing.length) throw new Error(`错误响应不是 Problem 结构，缺 ${missing}: ${JSON.stringify(body)}`);
  return body;
}
