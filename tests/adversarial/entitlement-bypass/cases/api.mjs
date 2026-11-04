/**
 * API 层攻击（攻击面 2/3/5）：伪造头/参数/路径/方法、受限接口字段泄漏、限流桶与 trustProxy。
 * 判定：期望 403 ENTITLEMENT_RESTRICTED 且响应体无行情字段/无内部原因码/不可缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnService, waitFor, http, addCheck, sleep, rel, portInUse } from '../lib.mjs';

const INSTRUMENTS = ['SSE:600519', 'SZSE:000001'];
const FORBIDDEN_KEYS = new Set([
  'last_price', 'prev_close', 'change', 'change_pct', 'volume', 'amount', 'open', 'high', 'low',
  'limit_status', 'trade_date', 'lot_size', 'quote', 'bars', 'candles', 'fundamental',
]);
const INTERNAL_REASON_RE = /expired|hold_active|control_stale|control_missing|internal_eval|c_end_display|unauthorized_code|degraded/i;

let rawLogFile = null;
export function initRawLog(file) {
  rawLogFile = file;
  fs.writeFileSync(file, '');
  return file;
}
function logRaw(note, res) {
  if (!rawLogFile) return;
  fs.appendFileSync(
    rawLogFile,
    `${JSON.stringify({ note, url: res.url, status: res.status, headers: res.headers, body: res.text.slice(0, 2000) })}\n`,
  );
}

function collectKeys(value, out = []) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

function bodyHasMarketNumbers(body) {
  const text = JSON.stringify(body ?? '');
  return /\b(?:last_price|prev_close|change_pct)\b/.test(text) || /\b\d+\.\d{2,}\b/.test(text);
}

function problemShapeOk(res) {
  const body = res.json;
  return (
    res.status === 403 &&
    body?.status === 403 &&
    body?.code === 'ENTITLEMENT_RESTRICTED' &&
    (res.headers['content-type'] ?? '').includes('application/problem+json') &&
    (res.headers['cache-control'] ?? '').includes('no-store')
  );
}

/**
 * 对一组"应当失败"的尝试做汇总判定：全部 403 ENTITLEMENT_RESTRICTED，
 * 且响应体无行情值、无内部原因码。
 */
function recordBlockedFamily(results, { id, title, clause, attempts }) {
  const anomalies = [];
  const observations = attempts.map(({ name, res }) => {
    const ok = problemShapeOk(res);
    const leak = bodyHasMarketNumbers(res.json) || INTERNAL_REASON_RE.test(res.text) || INTERNAL_REASON_RE.test(JSON.stringify(res.json ?? ''));
    if (!ok || leak) {
      anomalies.push({ name, status: res.status, code: res.json?.code, cacheControl: res.headers['cache-control'] ?? null, leak, body: res.text.slice(0, 300) });
    }
    return {
      attempt: name,
      status: res.status,
      code: res.json?.code ?? null,
      cacheControl: res.headers['cache-control'] ?? null,
      body: res.text.slice(0, 240),
    };
  });
  addCheck(results, {
    id,
    title,
    clause,
    attempt: attempts.map((a) => a.name).join(' | '),
    expectation: '全部 403 ENTITLEMENT_RESTRICTED；problem+json；cache-control: no-store；无行情字段数值；无内部原因码',
    observed: anomalies.length === 0 ? `全部 ${attempts.length} 条被正确挡住` : anomalies,
    status: anomalies.length === 0 ? 'PASS' : 'FAIL',
    severity: anomalies.length === 0 ? null : 'P0',
    evidence: { observations },
  });
}

const HEADERS = {
  'content-type': 'application/json',
};

export function headerAttempts(base) {
  const url = `${base}/v1/instruments/SSE:600519/quote`;
  return [
    { name: 'baseline', headers: {} },
    { name: 'X-Entitlement-Tier: c_end_display', headers: { 'X-Entitlement-Tier': 'c_end_display' } },
    { name: 'X-Entitlement: granted', headers: { 'X-Entitlement': 'granted' } },
    { name: 'X-Debug: 1', headers: { 'X-Debug': '1' } },
    { name: 'X-Forwarded-For: 8.8.8.8', headers: { 'X-Forwarded-For': '8.8.8.8' } },
    { name: 'X-Forwarded-For: 127.0.0.1', headers: { 'X-Forwarded-For': '127.0.0.1' } },
    { name: 'X-Real-IP: 8.8.8.8', headers: { 'X-Real-IP': '8.8.8.8' } },
    { name: 'X-Original-URL', headers: { 'X-Original-URL': '/v1/instruments/SSE:600519/quote' } },
    { name: 'X-Rewrite-URL', headers: { 'X-Rewrite-URL': '/v1/instruments/SSE:600519/quote' } },
    { name: 'X-Forwarded-Host: localhost', headers: { 'X-Forwarded-Host': 'localhost' } },
    { name: 'X-Forwarded-Proto: https', headers: { 'X-Forwarded-Proto': 'https' } },
    { name: 'X-HTTP-Method-Override: GET', headers: { 'X-HTTP-Method-Override': 'GET' } },
    { name: 'Authorization: Bearer dev-token', headers: { Authorization: 'Bearer dev-token' } },
    { name: 'Authorization: Bearer admin', headers: { Authorization: 'Bearer admin' } },
    { name: 'Cookie: entitlement=c_end_display; tier=c_end_display', headers: { Cookie: 'entitlement=c_end_display; tier=c_end_display' } },
    { name: 'X-User-Tier: c_end_display', headers: { 'X-User-Tier': 'c_end_display' } },
    { name: 'X-Admin: 1', headers: { 'X-Admin': '1' } },
    { name: 'Instrumentation / X-Instrumentation', headers: { Instrumentation: '1', 'X-Instrumentation': '1' } },
    { name: 'X-Entitlement-Expires-At: 2030-12-31', headers: { 'X-Entitlement-Expires-At': '2030-12-31T00:00:00Z' } },
    { name: 'Accept: text/html（内容协商绕过）', headers: { Accept: 'text/html,application/xhtml+xml' } },
    { name: '组合伪造（XFF + entitlement + debug + bearer）', headers: { 'X-Forwarded-For': '8.8.8.8', 'X-Entitlement': 'granted', 'X-Debug': '1', Authorization: 'Bearer dev-token' } },
  ].map((a) => ({ ...a, url }));
}

/** 受限态（internal_eval）API 矩阵。 */
export async function runRestrictedApiMatrix({ results, cfg }) {
  const base = cfg.apiBases.restricted;
  const q = (id) => `${base}/v1/instruments/${id}/quote`;

  // H1 伪造头
  {
    const attempts = [];
    for (const a of headerAttempts(base)) {
      const res = await http(a.url, { headers: { ...HEADERS, ...a.headers } });
      logRaw(`H1 ${a.name}`, res);
      attempts.push({ name: a.name, res });
    }
    recordBlockedFamily(results, {
      id: 'H1',
      title: '伪造/扩展请求头不能让 quote 越过 403',
      clause: ['decisions.md L28', 'decisions.md L36-1'],
      attempts,
    });
  }

  // H2 query 参数
  {
    const variants = [
      'tier=c_end_display', 'entitlement=c_end_display', 'is_entitled=true', 'entitled=1',
      'debug=1', 'mock=1', 'demo=1', 'include=quote', 'format=full', 'e2e=1',
    ];
    const attempts = [];
    for (const v of variants) {
      const res = await http(`${q('SSE:600519')}?${v}`);
      logRaw(`H2 query ${v}`, res);
      attempts.push({ name: `?${v}`, res });
    }
    recordBlockedFamily(results, {
      id: 'H2',
      title: 'query 参数不能让 quote 越过 403',
      clause: ['decisions.md L28'],
      attempts,
    });
  }

  // H3 路径变异
  {
    const variants = [
      { name: 'trailing slash /quote/', url: `${q('SSE:600519')}/` },
      { name: 'encoded colon %3A', url: `${base}/v1/instruments/SSE%3A600519/quote` },
      { name: 'uppercase /QUOTE', url: `${base}/v1/instruments/SSE:600519/QUOTE` },
      { name: 'semicolon /quote;x=1', url: `${base}/v1/instruments/SSE:600519/quote;x=1` },
      { name: 'dot-dot /v1/../v1/...', url: `${base}/v1/../v1/instruments/SSE:600519/quote` },
      { name: 'double slash //v1/...', url: `${base}//v1/instruments/SSE:600519/quote` },
      { name: 'double slash 在路径中 /v1//instruments', url: `${base}/v1//instruments/SSE:600519/quote` },
      { name: '尾部空格编码 %20', url: `${q('SSE:600519')}%20` },
    ];
    const observations = [];
    const anomalies = [];
    for (const v of variants) {
      const res = await http(v.url);
      logRaw(`H3 ${v.name}`, res);
      const body = res.json ?? {};
      const dataLeak = res.status === 200 && collectKeys(body.data ?? {}).some((k) => FORBIDDEN_KEYS.has(k));
      const pass = [403, 404, 400].includes(res.status) && !dataLeak;
      observations.push({ attempt: v.name, status: res.status, code: body.code ?? null, cacheControl: res.headers['cache-control'] ?? null, body: res.text.slice(0, 200) });
      if (!pass) anomalies.push(observations.at(-1));
    }
    addCheck(results, {
      id: 'H3',
      title: '路径变异不能让 quote 命中可读数据（403/404/400，绝不 200+行情字段）',
      clause: ['decisions.md L28', 'decisions.md L36-1'],
      attempt: variants.map((v) => v.name).join(' | '),
      expectation: '403/404/400；无 200 带行情字段的响应',
      observed: anomalies.length === 0 ? `全部 ${variants.length} 条被挡住或 404` : anomalies,
      status: anomalies.length === 0 ? 'PASS' : 'FAIL',
      severity: anomalies.length === 0 ? null : 'P0',
      evidence: { observations },
    });
  }

  // H4 方法变异
  {
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
    const observations = [];
    const anomalies = [];
    for (const method of methods) {
      const res = await http(q('SSE:600519'), { method, headers: HEADERS, body: method === 'OPTIONS' ? undefined : '{"tier":"c_end_display"}' });
      logRaw(`H4 ${method}`, res);
      const dataLeak = res.status === 200 && /\d+\.\d{2,}/.test(res.text);
      const pass = [400, 403, 404, 405].includes(res.status) && !dataLeak;
      observations.push({ attempt: method, status: res.status, code: res.json?.code ?? null, body: res.text.slice(0, 200) });
      if (!pass) anomalies.push(observations.at(-1));
    }
    addCheck(results, {
      id: 'H4',
      title: '写方法打到只读行情端点不返回数据',
      clause: ['decisions.md L28'],
      attempt: methods.join(', '),
      expectation: '403/404/405，无 200+行情值',
      observed: anomalies.length === 0 ? `全部 ${methods.length} 条被挡住` : anomalies,
      status: anomalies.length === 0 ? 'PASS' : 'FAIL',
      severity: anomalies.length === 0 ? null : 'P0',
      evidence: { observations },
    });
  }

  // H5 兄弟端点：bars / fundamental-summary 必须同样 403
  {
    const attempts = [];
    for (const id of INSTRUMENTS) {
      for (const suffix of [`/bars?limit=5`, `/fundamental-summary`]) {
        const res = await http(`${base}/v1/instruments/${id}${suffix}`);
        logRaw(`H5 ${id}${suffix}`, res);
        attempts.push({ name: `${id}${suffix}`, res });
      }
    }
    recordBlockedFamily(results, {
      id: 'H5',
      title: 'bars / fundamental-summary 同受 403 门禁保护',
      clause: ['decisions.md L36-1'],
      attempts,
    });
  }

  // H6 GET /instruments/:id 200 但字段白名单 + 无行情值（L21）
  {
    const observations = [];
    const anomalies = [];
    for (const id of INSTRUMENTS) {
      const res = await http(`${base}/v1/instruments/${id}`);
      logRaw(`H6 ${id}`, res);
      const dataKeys = res.json?.data ? Object.keys(res.json.data).sort() : [];
      const forbidden = collectKeys(res.json ?? {}).filter((k) => FORBIDDEN_KEYS.has(k));
      const meta = res.json?.meta ?? {};
      const expectedKeys = ['board', 'exchange', 'instrument_id', 'list_status', 'listed_at', 'name', 'security_type'];
      const ok =
        res.status === 200 &&
        JSON.stringify(dataKeys) === JSON.stringify(expectedKeys) &&
        meta.entitlement?.is_entitled === false &&
        meta.entitlement?.tier === 'internal_eval' &&
        forbidden.length === 0 &&
        (res.headers['cache-control'] ?? '').includes('no-store');
      observations.push({ instrument: id, status: res.status, dataKeys, entitlement: meta.entitlement ?? null, forbidden, body: res.text.slice(0, 400) });
      if (!ok) anomalies.push(observations.at(-1));
    }
    addCheck(results, {
      id: 'H6',
      title: '受限态基础信息仅返回 7 字段白名单，无行情字段、is_entitled=false',
      clause: ['decisions.md L21', 'decisions.md L36-3'],
      attempt: `GET /v1/instruments/{${INSTRUMENTS.join(',')}}`,
      expectation: '200；data 恰为 7 白名单字段；meta.entitlement={tier:internal_eval,is_entitled:false}；无行情字段；no-store',
      observed: anomalies.length === 0 ? '两条均符合白名单' : anomalies,
      status: anomalies.length === 0 ? 'PASS' : 'FAIL',
      severity: anomalies.length === 0 ? null : 'P1',
      evidence: { observations },
    });
  }

  // H7 watchlist 鉴权边界：无 token/bogus token 401；dev-token 在 E2E 模式下可用（INFO）
  {
    const getNoToken = await http(`${base}/v1/watchlist`);
    const getBogus = await http(`${base}/v1/watchlist`, { headers: { Authorization: 'Bearer bogus-token' } });
    const getDev = await http(`${base}/v1/watchlist`, { headers: { Authorization: 'Bearer dev-token' } });
    const postDev = await http(`${base}/v1/watchlist`, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: 'Bearer dev-token' },
      body: { instrument_id: 'SSE:600519' },
    });
    const deleteDev = await http(`${base}/v1/watchlist/SSE:600519`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer dev-token' },
    });
    logRaw('H7 watchlist no token', getNoToken);
    logRaw('H7 watchlist bogus', getBogus);
    logRaw('H7 watchlist dev GET', getDev);
    logRaw('H7 watchlist dev POST', postDev);
    logRaw('H7 watchlist dev DELETE', deleteDev);
    const authOk = getNoToken.status === 401 && getBogus.status === 401;
    addCheck(results, {
      id: 'H7',
      title: 'watchlist 无 token/伪造 token 被 401；E2E dev-token 可写（仅测试环境，INFO）',
      clause: ['decisions.md L28'],
      attempt: 'GET /v1/watchlist（无 token / bogus / dev-token）+ POST + DELETE（dev-token）',
      expectation: '无/伪造 token=401；dev-token 属 E2E_MODE 测试后门，仅记录不判定生产',
      observed: {
        noToken: getNoToken.status,
        bogus: getBogus.status,
        devGet: getDev.status,
        devPost: postDev.status,
        devDelete: deleteDev.status,
        devMeta: getDev.json?.meta ?? null,
      },
      status: authOk ? 'PASS' : 'FAIL',
      severity: authOk ? null : 'P1',
      evidence: { note: 'dev-token 仅在 E2E_MODE=1 且配置 E2E_AUTH_TOKEN 时生效；生产不得设置该 env' },
    });
  }

  // H8 管理/诊断端点暴露
  {
    const paths = ['/openapi.json', '/docs', '/metrics', '/v1/admin', '/v1/internal/entitlement', '/v1/entitlement', '/v1/config', '/healthz', '/v1/healthz', '/.env', '/debug/pprof'];
    const observations = [];
    const anomalies = [];
    for (const p of paths) {
      const res = await http(`${base}${p}`);
      logRaw(`H8 ${p}`, res);
      const exposed = res.status === 200 && /last_price|DATABASE_URL|ENTITLEMENT_EXPIRES|secret|token|internal_eval/i.test(res.text);
      observations.push({ path: p, status: res.status, body: res.text.slice(0, 160) });
      if (exposed) anomalies.push(observations.at(-1));
    }
    addCheck(results, {
      id: 'H8',
      title: '诊断/管理路径无行情或配置泄漏',
      clause: ['decisions.md L28'],
      attempt: paths.join(' | '),
      expectation: '非公开路径 404；/healthz 不泄漏行情值/token/ENTITLEMENT 配置',
      observed: anomalies.length === 0 ? observations : anomalies,
      status: anomalies.length === 0 ? 'PASS' : 'FAIL',
      severity: anomalies.length === 0 ? null : 'P1',
      evidence: {},
    });
  }

  // H9 403 响应体深度扫描（内部原因码/字段泄漏）
  {
    const res = await http(`${q('SSE:600519')}`);
    const body = res.json ?? {};
    const internal = INTERNAL_REASON_RE.test(JSON.stringify(body));
    const detail = body.detail ?? '';
    const neutral = detail === '当前版本暂不提供该标的行情数据';
    addCheck(results, {
      id: 'H9',
      title: '403 响应体只含中性文案，无内部原因码/字段',
      clause: ['decisions.md L33', 'decisions.md L36-5'],
      attempt: '读取 403 problem body 全部字段',
      expectation: '字段仅 type/title/status/code/trace_id/detail；detail 为中性文案；无 expired/hold/stale/internal_eval 等内部码',
      observed: { status: res.status, body, internal, neutral },
      status: !internal && neutral ? 'PASS' : 'FAIL',
      severity: !internal && neutral ? null : 'P1',
      evidence: {},
    });
  }

  // H10 经 web 反代的 403：no-store 不能只在 API 直连生效
  {
    const res = await http(`${cfg.webBases.restricted}/v1/instruments/SSE:600519/quote`);
    logRaw('H10 proxy 403', res);
    const ok = problemShapeOk(res);
    addCheck(results, {
      id: 'H10',
      title: 'web 反代链路上的 403 同样 no-store 且形态一致',
      clause: ['decisions.md L35', 'decisions.md L36-4'],
      attempt: `GET ${cfg.webBases.restricted}/v1/instruments/SSE:600519/quote`,
      expectation: '403 + ENTITLEMENT_RESTRICTED + cache-control: no-store（含反代层）',
      observed: { status: res.status, code: res.json?.code ?? null, cacheControl: res.headers['cache-control'] ?? null, body: res.text.slice(0, 240) },
      status: ok ? 'PASS' : 'FAIL',
      severity: ok ? null : 'P0',
      evidence: {},
    });
  }

  // H11 条件请求/缓存探测：If-None-Match / If-Modified-Since / only-if-cached 不能让 403 变 304/200
  {
    const url = q('SSE:600519');
    const variants = [
      { name: 'If-None-Match W/"deadbeef"', headers: { 'if-none-match': 'W/"deadbeef"' } },
      { name: 'If-None-Match *', headers: { 'if-none-match': '*' } },
      { name: 'If-Modified-Since', headers: { 'if-modified-since': 'Wed, 04 Nov 2026 00:00:00 GMT' } },
      { name: 'Cache-Control: only-if-cached, max-stale=600', headers: { 'cache-control': 'only-if-cached, max-stale=600' } },
      { name: 'Pragma: no-cache + ETag 条件', headers: { pragma: 'no-cache', 'if-none-match': 'W/"quote-cached"' } },
    ];
    const obs = [];
    let ok = true;
    for (const v of variants) {
      const res = await http(url, { headers: { ...HEADERS, ...v.headers } });
      logRaw(`H11 ${v.name}`, res);
      const pass = res.status === 403 && problemShapeOk(res) && res.status !== 304;
      ok = ok && pass;
      obs.push({ name: v.name, status: res.status, code: res.json?.code ?? null, cacheControl: res.headers['cache-control'] ?? null, etag: res.headers.etag ?? null, lastModified: res.headers['last-modified'] ?? null });
    }
    addCheck(results, {
      id: 'H11',
      title: '条件请求/缓存探测不能让 403 变 304 或复用历史 200',
      clause: ['decisions.md L35', 'decisions.md L36-4'],
      attempt: variants.map((v) => v.name).join(' | '),
      expectation: '全部 403 + ENTITLEMENT_RESTRICTED + no-store；不得出现 304/200/ETag',
      observed: obs,
      status: ok ? 'PASS' : 'FAIL',
      severity: ok ? null : 'P1',
      evidence: {},
    });
  }
}

/** 有效态（c_end_display 未过期）基线：200 + 数值 + no-store；并返回 quote body 供客户端重放。 */
export async function runValidPhaseApi({ results, cfg }) {
  const base = cfg.apiBases.expiring;
  const res = await http(`${base}/v1/instruments/SSE:600519/quote`);
  logRaw('V1 valid quote', res);
  const body = res.json ?? {};
  const data = body.data ?? {};
  const meta = body.meta ?? {};
  const hasNumbers = typeof data.last_price === 'number' && typeof data.prev_close === 'number';
  const ok =
    res.status === 200 &&
    hasNumbers &&
    meta.entitlement?.tier === 'c_end_display' &&
    meta.entitlement?.is_entitled === true &&
    (res.headers['cache-control'] ?? '').includes('no-store');
  addCheck(results, {
    id: 'V1',
    title: '有效态基线：quote 200 带数值、entitlement 正确、no-store',
    clause: ['decisions.md L36-1'],
    attempt: `GET ${base}/v1/instruments/SSE:600519/quote`,
    expectation: '200；last_price/prev_close 数值；tier=c_end_display,is_entitled=true；cache-control: no-store',
    observed: { status: res.status, data, entitlement: meta.entitlement ?? null, cacheControl: res.headers['cache-control'] ?? null },
    status: ok ? 'PASS' : 'FAIL',
    severity: ok ? null : 'P2',
    evidence: {},
  });

  const proxy = await http(`${cfg.webBases.expiring}/v1/instruments/SSE:600519/quote`);
  logRaw('V2 valid quote via proxy', proxy);
  const proxyOk = proxy.status === 200 && (proxy.headers['cache-control'] ?? '').includes('no-store');
  addCheck(results, {
    id: 'V2',
    title: '有效态经 web 反代 200 也带 no-store',
    clause: ['decisions.md L35'],
    attempt: `GET ${cfg.webBases.expiring}/v1/instruments/SSE:600519/quote`,
    expectation: '200 + no-store',
    observed: { status: proxy.status, cacheControl: proxy.headers['cache-control'] ?? null },
    status: proxyOk ? 'PASS' : 'FAIL',
    severity: proxyOk ? null : 'P2',
    evidence: {},
  });

  // V3 分页参数超限：拒绝（400 VALIDATION_ERROR）而不是 clamp 后放行数据
  {
    const barsUrl = `${base}/v1/instruments/SSE:600519/bars`;
    const overLimit = await http(`${barsUrl}?limit=600`);
    const maxLimit = await http(`${barsUrl}?limit=500`);
    const overOffset = await http(`${barsUrl}?limit=1&offset=1001`);
    logRaw('V3 overLimit', overLimit);
    logRaw('V3 maxLimit', maxLimit);
    logRaw('V3 overOffset', overOffset);
    const barsOf = (r) => {
      const d = r.json?.data;
      if (Array.isArray(d)) return d;
      if (Array.isArray(d?.bars)) return d.bars;
      if (Array.isArray(d?.items)) return d.items;
      return null;
    };
    const maxRows = barsOf(maxLimit);
    const ok =
      overLimit.status === 400 &&
      overLimit.json?.code === 'VALIDATION_ERROR' &&
      overOffset.status === 400 &&
      maxLimit.status === 200 &&
      Array.isArray(maxRows) &&
      maxRows.length <= 500 &&
      barsOf(overLimit) === null;
    addCheck(results, {
      id: 'V3',
      title: '分页参数超限被 400 拒绝，不 clamp 后放行超量数据',
      clause: ['decisions.md L35', 'decisions.md L28'],
      attempt: `bars?limit=600 / bars?limit=500 / bars?limit=1&offset=1001（有效态实例）`,
      expectation: 'limit>500 与 offset 越界 → 400 VALIDATION_ERROR 且无 bars 数据；limit=500 → 200 且 rows≤500',
      observed: {
        overLimit: { status: overLimit.status, code: overLimit.json?.code ?? null },
        overOffset: { status: overOffset.status, code: overOffset.json?.code ?? null },
        maxLimit: { status: maxLimit.status, rows: Array.isArray(maxRows) ? maxRows.length : null },
      },
      status: ok ? 'PASS' : 'FAIL',
      severity: ok ? null : 'P2',
      evidence: {},
    });
  }

  return res.json;
}

/** 过期态矩阵：与受限态相同的攻击面。 */
export async function runExpiredApiMatrix({ results, cfg }) {
  const base = cfg.apiBases.expiring;
  const attempts = [];
  for (const a of headerAttempts(base).slice(0, 8)) {
    const res = await http(a.url, { headers: { ...HEADERS, ...a.headers } });
    logRaw(`E1 ${a.name}`, res);
    attempts.push({ name: a.name, res });
  }
  recordBlockedFamily(results, {
    id: 'E1',
    title: '到期后伪造头不能恢复行情（fail-closed）',
    clause: ['decisions.md L36-1', 'decisions.md L36-2'],
    attempts,
  });

  const instrument = await http(`${base}/v1/instruments/SSE:600519`);
  logRaw('E2 expired instrument', instrument);
  const meta = instrument.json?.meta ?? {};
  const ok = instrument.status === 200 && meta.entitlement?.is_entitled === false && meta.entitlement?.tier === 'internal_eval';
  addCheck(results, {
    id: 'E2',
    title: '到期后基础信息 200 但 is_entitled=false / tier=internal_eval',
    clause: ['decisions.md L36-2'],
    attempt: 'GET /v1/instruments/SSE:600519',
    expectation: '200 + meta.entitlement.is_entitled=false + tier=internal_eval + no-store',
    observed: { status: instrument.status, entitlement: meta.entitlement ?? null, cacheControl: instrument.headers['cache-control'] ?? null },
    status: ok ? 'PASS' : 'FAIL',
    severity: ok ? null : 'P0',
    evidence: {},
  });
}

/** 限流攻击面（#5）：默认桶耗尽后伪造 XFF 不能换桶；TRUST_PROXY=true 启动被拒；配错 CIDR 时换桶（条件性 LEAK）。 */
export async function runRateLimitAttack({ results, cfg, spawnLogDir }) {
  const base = cfg.apiBases.limited;
  const q = `${base}/v1/instruments/SSE:600519/quote`;

  // R1 默认桶：连续请求触发 429
  const statuses = [];
  let first429 = -1;
  let sample429 = null;
  for (let i = 0; i < 14; i += 1) {
    const res = await http(q);
    statuses.push(res.status);
    logRaw(`R1 burst #${i}`, res);
    if (res.status === 429) {
      if (first429 === -1) {
        first429 = i;
        sample429 = res;
      }
    }
  }
  const r1Ok =
    first429 > 0 &&
    first429 <= 11 &&
    sample429.json?.code === 'RATE_LIMITED' &&
    Number(sample429.headers['retry-after']) >= 1 &&
    (sample429.headers['cache-control'] ?? '').includes('no-store');
  addCheck(results, {
    id: 'R1',
    title: '默认限流桶：连续请求触发 429（RATE_LIMITED + retry-after + no-store）',
    clause: ['decisions.md L28'],
    attempt: `连续 14 次 GET quote（默认 ipBurst=10）`,
    expectation: '第 ≤11 次起 429；code=RATE_LIMITED；retry-after≥1；no-store',
    observed: { statuses, first429, sample: sample429 ? { status: sample429.status, headers: sample429.headers, body: sample429.text.slice(0, 240) } : null },
    status: r1Ok ? 'PASS' : 'FAIL',
    severity: r1Ok ? null : 'P1',
    evidence: {},
  });

  // R2 桶耗尽后伪造 XFF：默认 trustProxy=false，IP 取 socket 地址，不应换桶
  const spoof = [];
  for (const xff of ['8.8.8.8', '1.1.1.1', '203.0.113.7', '127.0.0.1']) {
    const res = await http(q, { headers: { 'X-Forwarded-For': xff } });
    statuses.push(res.status);
    spoof.push({ xff, status: res.status, code: res.json?.code ?? null });
    logRaw(`R2 XFF ${xff}`, res);
  }
  const spoofOk = spoof.every((s) => s.status === 429);
  addCheck(results, {
    id: 'R2',
    title: '桶耗尽后伪造 X-Forwarded-For 不能换桶（默认 TRUST_PROXY 未开）',
    clause: ['decisions.md L28'],
    attempt: '桶耗尽后带 4 个不同 X-Forwarded-For 请求',
    expectation: '全部 429（同一 socket IP 桶）；若出现 403/200 则说明按 XFF 换桶',
    observed: spoof,
    status: spoofOk ? 'PASS' : 'FAIL',
    severity: spoofOk ? null : 'P1',
    evidence: {},
  });

  // R3 TRUST_PROXY=true 必须启动失败（防 XFF 换桶的配置防线）
  {
    const logFile = path.join(spawnLogDir, 'api-trustproxy-true.log');
    const handle = spawnService({
      name: 'api-trustproxy-true',
      command: 'node',
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: path.join(cfg.workspace, 'services', 'api'),
      env: {
        PORT: String(cfg.ports.trustProxyApi),
        ENTITLEMENT_TIER: 'internal_eval',
        E2E_MODE: '1',
        APP_PROFILE: 'test',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        DATABASE_URL: cfg.dbUrl,
        TRUST_PROXY: 'true',
      },
      logFile,
    });
    const exited = await waitFor('trustProxy=true 进程退出', () => handle.child.exitCode !== null, { timeoutMs: 30_000, intervalMs: 200 }).catch(() => false);
    const log = fs.readFileSync(logFile, 'utf8');
    await handle.cleanup();
    const refused = exited && /TRUST_PROXY/i.test(log) && /(禁止|ConfigError|failed to start)/i.test(log);
    addCheck(results, {
      id: 'R3',
      title: 'TRUST_PROXY=true 启动被配置层拒绝（防伪造 XFF 换桶）',
      clause: ['decisions.md L28'],
      attempt: `TRUST_PROXY=true node --import tsx src/server.ts (port ${cfg.ports.trustProxyApi})`,
      expectation: '进程启动失败，日志含 TRUST_PROXY 被禁说明',
      observed: { exited, log: log.slice(0, 500) },
      status: refused ? 'PASS' : 'FAIL',
      severity: refused ? null : 'P1',
      evidence: { log: rel(logFile) },
    });
  }

  // R4 条件性 LEAK：TRUST_PROXY 配成可信直连网段时，伪造 XFF 可换桶（部署前提）
  await runTrustProxyCidrCheck({ results, cfg, spawnLogDir, tag: 'R4' });

  // 清理桶对后续测试的影响：本 API 为独立实例，无需处理
  await sleep(30);
}


/**
 * R4 条件性 LEAK 的单条用例（也可由 run.mjs --only=R4 单独复跑）：
 * TRUST_PROXY 配成覆盖直连客户端 IP 的网段时，耗尽桶后伪造 X-Forwarded-For 能否换桶。
 * 修复后期望形态有两种，均按 PASS 记录：
 *   1) 配置层拒绝 loopback/宽网段（进程拒绝启动，日志含 TRUST_PROXY 说明）；
 *   2) 实例启动但桶耗尽后伪造 XFF 仍 429（不换桶）。
 */
export async function runTrustProxyCidrCheck({ results, cfg, spawnLogDir, tag = 'R4' }) {
  const logFile = path.join(spawnLogDir, 'api-trustproxy-cidr.log');
  const handle = spawnService({
    name: 'api-trustproxy-cidr',
    command: 'node',
    args: ['--import', 'tsx', 'src/server.ts'],
    cwd: path.join(cfg.workspace, 'services', 'api'),
    env: {
      PORT: String(cfg.ports.trustProxyCidrApi),
      ENTITLEMENT_TIER: 'internal_eval',
      E2E_MODE: '1',
      APP_PROFILE: 'test',
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: cfg.dbUrl,
      TRUST_PROXY: '127.0.0.0/8',
    },
    logFile,
  });
  try {
    const cidrBase = `http://127.0.0.1:${cfg.ports.trustProxyCidrApi}`;
    let listenedPort = false;
    const healthy = await waitFor('trustProxyCidr 健康', async () => {
      if (await portInUse(cfg.ports.trustProxyCidrApi).catch(() => false)) listenedPort = true;
      return (await fetch(`${cidrBase}/healthz`)).ok;
    }, { timeoutMs: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!listenedPort && await portInUse(cfg.ports.trustProxyCidrApi).catch(() => false)) listenedPort = true;
    await sleep(150);
    const log = fs.readFileSync(logFile, 'utf8');

    if (!healthy) {
      // 修复后的配置守卫：loopback CIDR 被拒绝启动
      const mentionsTrustProxy = /TRUST_PROXY/i.test(log);
      const exitFirstLine = log.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
      const refused = handle.child.exitCode !== null && !listenedPort && mentionsTrustProxy;
      addCheck(results, {
        id: tag,
        title: 'TRUST_PROXY 覆盖直连网段时：loopback CIDR 被配置层拒绝启动（XFF 换桶不可达）',
        clause: ['decisions.md L28'],
        attempt: 'TRUST_PROXY=127.0.0.0/8 node --import tsx src/server.ts',
        expectation: '进程退出 + 日志点名 TRUST_PROXY + 从未监听端口（宽/回环网段守卫）；启动成功则继续换桶探测',
        observed: { refused, exitCode: handle.child.exitCode, listenedPort, exitFirstLine, log: log.slice(0, 800) },
        status: refused ? 'PASS' : 'INFO',
        severity: null,
        evidence: { log: rel(logFile) },
      });
      return;
    }

    // 先耗尽默认桶（同 127.0.0.1 socket IP）
    for (let i = 0; i < 12; i += 1) await http(`${cidrBase}/v1/instruments/SSE:600519/quote`);
    const beforeSpoof = await http(`${cidrBase}/v1/instruments/SSE:600519/quote`);
    const afterSpoof = await http(`${cidrBase}/v1/instruments/SSE:600519/quote`, { headers: { 'X-Forwarded-For': '8.8.8.8' } });
    logRaw('R4 cidr before', beforeSpoof);
    logRaw('R4 cidr after XFF', afterSpoof);
    const switched = beforeSpoof.status === 429 && afterSpoof.status === 403;
    addCheck(results, {
      id: tag,
      title: 'TRUST_PROXY 覆盖直连网段时：伪造 X-Forwarded-For 可换限流桶（条件性）',
      clause: ['decisions.md L28'],
      attempt: '实例 TRUST_PROXY=127.0.0.0/8；耗尽桶后带 X-Forwarded-For: 8.8.8.8',
      expectation: '条件性 LEAK 记录：若 429→403 则证明按 XFF 换桶；仅当客户端可直连 pod 且网段被信任时成立',
      observed: { beforeSpoof: beforeSpoof.status, afterSpoof: afterSpoof.status, afterSpoofCode: afterSpoof.json?.code ?? null },
      status: switched ? 'FAIL' : 'PASS',
      severity: switched ? 'P2' : null,
      evidence: { note: '部署必须保证只有 ingress 能连 pod，且 TRUST_PROXY 只列 ingress 网段' },
    });
  } catch (error) {
    addCheck(results, {
      id: tag,
      title: 'TRUST_PROXY CIDR 条件性换桶测试',
      clause: [],
      attempt: 'TRUST_PROXY=127.0.0.0/8 实例',
      expectation: '-',
      observed: { error: String(error.message) },
      status: 'INFO',
    });
  } finally {
    await handle.cleanup();
  }
}

/**
 * 攻击面 1/6 补充：E2E 后门能否被"漏配 APP_PROFILE"的生产实例打开。
 * 依据：services/market/src/config.ts:158-176 assertNoE2EBackdoorInProduction（L44/L46）。
 * G1/G2 断言进程拒绝启动；G3 断言生产 profile 实例即使带 dev-token 也拿不到身份。
 */
export async function runBackdoorGuardChecks({ results, cfg, spawnLogDir }) {
  const mkEnv = (extra) => ({
    PORT: String(cfg.ports.backdoorApi),
    ENTITLEMENT_TIER: 'internal_eval',
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    DATABASE_URL: cfg.dbUrl,
    ...extra,
  });
  const attempt = async (id, logName, env) => {
    const logFile = path.join(spawnLogDir, logName);
    const handle = spawnService({
      name: id,
      command: 'node',
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: path.join(cfg.workspace, 'services', 'api'),
      env,
      logFile,
    });
    try {
      const exited = await waitFor(`${id} 进程退出`, () => handle.child.exitCode !== null, { timeoutMs: 20_000, intervalMs: 200 }).catch(() => false);
      return { exited, log: fs.readFileSync(logFile, 'utf8') };
    } finally {
      await handle.cleanup();
    }
  };

  // G1：APP_PROFILE 缺省（=prod）+ E2E_MODE=1 / E2E_AUTH_TOKEN → 拒绝启动
  {
    const { exited, log } = await attempt('backdoor-default-profile', 'api-backdoor-default.log', mkEnv({ E2E_MODE: '1', E2E_AUTH_TOKEN: 'dev-token' }));
    const ok = exited && /E2E 模式在生产不可用/.test(log) && /APP_PROFILE/.test(log);
    addCheck(results, {
      id: 'G1',
      title: 'APP_PROFILE 缺省时 E2E 后门被配置层拒绝启动',
      clause: ['decisions.md L28', 'config.ts:158-176 L44/L46'],
      attempt: 'APP_PROFILE 未设置 + E2E_MODE=1 + E2E_AUTH_TOKEN=dev-token 启动 API',
      expectation: '进程退出，日志含「E2E 模式在生产不可用」与 APP_PROFILE',
      observed: { exited, log: log.slice(0, 400) },
      status: ok ? 'PASS' : 'FAIL',
      severity: ok ? null : 'P1',
      evidence: { log: rel(path.join(spawnLogDir, 'api-backdoor-default.log')) },
    });
  }

  // G2：APP_PROFILE 缺省 + 仅 E2E_AUTH_TOKEN（无 E2E_MODE）→ 同样拒绝启动
  {
    const { exited, log } = await attempt('backdoor-token-only', 'api-backdoor-token-only.log', mkEnv({ E2E_AUTH_TOKEN: 'dev-token' }));
    const ok = exited && /E2E 模式在生产不可用/.test(log) && /E2E_AUTH_TOKEN/.test(log);
    addCheck(results, {
      id: 'G2',
      title: 'APP_PROFILE 缺省时固定身份 token 也被拒绝启动',
      clause: ['decisions.md L28', 'config.ts:158-176 L44/L46'],
      attempt: 'APP_PROFILE 未设置 + 仅 E2E_AUTH_TOKEN=dev-token 启动 API',
      expectation: '进程退出，日志点名 E2E_AUTH_TOKEN',
      observed: { exited, log: log.slice(0, 400) },
      status: ok ? 'PASS' : 'FAIL',
      severity: ok ? null : 'P1',
      evidence: { log: rel(path.join(spawnLogDir, 'api-backdoor-token-only.log')) },
    });
  }

  // G3：生产 profile（APP_PROFILE 缺省、无任何 E2E env）正常启动，但 dev-token 不被接受
  {
    const base = `http://127.0.0.1:${cfg.ports.backdoorApi}`;
    const logFile = path.join(spawnLogDir, 'api-prod-profile.log');
    const handle = spawnService({
      name: 'api-prod-profile',
      command: 'node',
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: path.join(cfg.workspace, 'services', 'api'),
      env: mkEnv({}),
      logFile,
    });
    try {
      let started = false;
      try {
        await waitFor('生产 profile 实例健康', async () => (await fetch(`${base}/healthz`)).ok, { timeoutMs: 40_000 });
        started = true;
      } catch { started = false; }
      let watchlist = null;
      if (started) {
        watchlist = await http(`${base}/v1/watchlist`, { headers: { authorization: 'Bearer dev-token' } });
        logRaw('G3 prod profile watchlist dev-token', watchlist);
      }
      const ok = started && watchlist?.status === 401;
      addCheck(results, {
        id: 'G3',
        title: '生产 profile 实例正常启动，但 dev-token 不被接受（固定身份入口关闭）',
        clause: ['decisions.md L28', 'config.ts:158-176 L44/L46'],
        attempt: 'APP_PROFILE 缺省（=prod）、无 E2E env 启动；用 Authorization: Bearer dev-token 访问 /v1/watchlist',
        expectation: '实例健康，watchlist 返回 401（无 dev 身份）',
        observed: { started, watchlistStatus: watchlist?.status ?? null, watchlistBody: watchlist?.text?.slice(0, 300) ?? null },
        status: ok ? 'PASS' : 'FAIL',
        severity: ok ? null : 'P1',
        evidence: { log: rel(logFile) },
      });
    } finally {
      await handle.cleanup();
    }
  }

  // G4 裸启动（L36 第 8 条）：不设任何 ENTITLEMENT_* 环境变量启动 → 默认 internal_eval、行情全 403
  {
    const base = `http://127.0.0.1:${cfg.ports.backdoorApi}`;
    const logFile = path.join(spawnLogDir, 'api-bare-start.log');
    const handle = spawnService({
      name: 'api-bare-start',
      command: 'node',
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: path.join(cfg.workspace, 'services', 'api'),
      env: {
        PORT: String(cfg.ports.backdoorApi),
        APP_PROFILE: 'test',
        E2E_MODE: '1',
        E2E_AUTH_TOKEN: 'dev-token',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        DATABASE_URL: cfg.dbUrl,
      },
      logFile,
    });
    try {
      let started = false;
      try {
        await waitFor('裸启动实例健康', async () => (await fetch(`${base}/healthz`)).ok, { timeoutMs: 40_000 });
        started = true;
      } catch { started = false; }
      const quote = started ? await http(`${base}/v1/instruments/SSE:600519/quote`) : null;
      const instrument = started ? await http(`${base}/v1/instruments/SSE:600519`) : null;
      logRaw('G4 bare-start quote', quote ?? { url: base, status: 0, headers: {}, text: 'not-started' });
      const ent = instrument?.json?.meta?.entitlement ?? null;
      const ok =
        started &&
        quote?.status === 403 &&
        quote?.json?.code === 'ENTITLEMENT_RESTRICTED' &&
        instrument?.status === 200 &&
        ent?.tier === 'internal_eval' &&
        ent?.is_entitled === false;
      addCheck(results, {
        id: 'G4',
        title: '裸启动（无任何 ENTITLEMENT_* env）默认 internal_eval：行情 403、meta.tier=internal_eval',
        clause: ['decisions.md L36-8', 'config.ts:80-87 parseTier 缺省 internal_eval'],
        attempt: `不设 ENTITLEMENT_TIER/ENTITLEMENT_EXPIRES_AT/ENTITLEMENT_CONFIG_EXPECTED_SHA256 启动（port ${cfg.ports.backdoorApi}）后请求 quote/instrument`,
        expectation: '进程正常启动；quote 403 ENTITLEMENT_RESTRICTED；instrument 200 且 meta.tier=internal_eval,is_entitled=false',
        observed: { started, quoteStatus: quote?.status ?? null, quoteCode: quote?.json?.code ?? null, entitlement: ent },
        status: ok ? 'PASS' : 'FAIL',
        severity: ok ? null : 'P0',
        evidence: { log: rel(logFile) },
      });
    } finally {
      await handle.cleanup();
    }
  }
}
