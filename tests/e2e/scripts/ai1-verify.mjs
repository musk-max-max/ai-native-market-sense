#!/usr/bin/env node
/**
 * A7 · AI-1 真栈验证 V3a：HTTP 真栈复现 ai1-evidence-2026-11-06.md 的 passed 样本。
 *
 * 栈（真代码链，仅数据行为种子 fixture）：
 *   临时 PG(127.0.0.1:55533) → services/api 真壳(identity+market+ai 三域, 8181, market 自环)
 *   → identity 真注册/登录 → market 真仓储(serving 视图) → services/ai 真路由/生成/P2-P8
 *   → audit.ai_generation_events 真审计链(迁移 001→003 + 触发器)。
 *
 * 判据映射（AI-CARD-SIGNOFF-2026-11-06.md AI1-* + ai1-evidence 判据 1/2/3）：
 *   AI1-1  POST /v1/ai/analyses 真实响应信封（data.ai 六字段、as_of 原样 +08:00、免责 closable=false）
 *   AI1-2  audit.ai_generation_events 行样本 + request_id 闭环 + user_id HMAC
 *   AI1-3  output_hash/input_evidence_hash 独立重算闭环 + analysis_id 同源 + GET 回环 + 404 不泄露
 *
 * 运行：node tests/e2e/scripts/ai1-verify.mjs   （需 api 已按证据报告起在 AI1_API_URL）
 * 证据：tests/e2e/evidence/ai1-2026-11-06/http-verify.json
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  sha256hex,
  recomputeOutputHash,
  recomputeInputEvidenceHash,
  evidenceItemFromEnvelope,
  makePsql,
  sqlLit,
  makeLedger,
  HASH_RE,
} from '../lib/ai1-verify-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(HERE, '..', 'evidence', 'ai1-2026-11-06');
const API = (process.env.AI1_API_URL ?? 'http://127.0.0.1:8181').replace(/\/$/, '');
const USER_HASH_KEY = process.env.AI1_USER_HASH_KEY ?? 'a7-ai1-verify-hmac-key';
const EXPECTED_AS_OF = '2026-11-06T15:00:00+08:00';
const INSTRUMENT = 'SSE:600519';
const REQUEST_ID = 'a7-v3a-req-0001';
const ADVISORY_RE = /(推荐买入|建议卖出|目标价|止损位|稳赚|翻倍|满仓|抄底|必涨|包赚|无风险收益)/;
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const DISCLAIMER_VERSION_RE = /^\d{4}\.\d{2}\.\d+$/;
const ANALYSIS_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

const ledger = makeLedger();
const psql = makePsql();
const observations = [];

async function req(method, path, { token, body, requestId } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(requestId !== undefined ? { 'x-request-id': requestId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function registerAndLogin(tag) {
  const email = `a7-v3a-${tag}-${Date.now()}-${process.pid}@example.test`;
  const password = 'A7-Verify-Pass-2026!x';
  const reg = await req('POST', '/v1/auth/register', { body: { email, password } });
  const login = await req('POST', '/v1/auth/login', { body: { email, password } });
  return { email, userId: reg.body?.user_id, token: login.body?.token, reg, login };
}

async function main() {
  console.log(`V3a 目标 API = ${API}`);

  // ---- 1. 真注册/登录（identity 域） ----
  const userA = await registerAndLogin('userA');
  ledger.add('V3a-AUTH-1', 'POST /v1/auth/register → 201 + user_id', userA.reg.status === 201 && typeof userA.userId === 'string' && userA.userId.length > 0, '201 + user_id', { status: userA.reg.status, user_id: userA.userId });
  ledger.add('V3a-AUTH-2', 'POST /v1/auth/login → 200 + token', userA.login.status === 200 && typeof userA.token === 'string' && userA.token.length > 0, '200 + token', { status: userA.login.status, expires_at: userA.login.body?.expires_at });

  // ---- 2. POST /v1/ai/analyses（真路由→真生成→真审计） ----
  const post = await req('POST', '/v1/ai/analyses', {
    token: userA.token,
    requestId: REQUEST_ID,
    body: { kind: 'stock_interpretation', subject: { instrument_id: INSTRUMENT } },
  });
  const data = post.body?.data;
  const meta = post.body?.meta;
  ledger.add('V3a-POST-1', 'POST /v1/ai/analyses → 200', post.status === 200, 200, post.status, `body=${JSON.stringify(post.body).slice(0, 200)}`);

  // AI1-1 信封
  ledger.add('V3a-ENV-1', 'data.analysis_id 形状', typeof data?.analysis_id === 'string' && ANALYSIS_ID_RE.test(data.analysis_id), '^[A-Za-z0-9_-]{8,128}$', data?.analysis_id);
  ledger.add('V3a-ENV-2', "data.kind==='stock_interpretation'", data?.kind === 'stock_interpretation', 'stock_interpretation', data?.kind);
  ledger.add('V3a-ENV-3', 'data.as_of 原样 +08:00 严格相等', data?.as_of === EXPECTED_AS_OF, EXPECTED_AS_OF, data?.as_of, '严格相等=与种子市场时点一致，禁止换算/格式化');
  ledger.add('V3a-ENV-4', 'data.as_of ISO8601 偏移形式', ISO_OFFSET_RE.test(String(data?.as_of)), ISO_OFFSET_RE.toString(), data?.as_of);
  const ai = data?.ai;
  ledger.add('V3a-ENV-5', 'data.ai.generated===true', ai?.generated === true, true, ai?.generated);
  for (const field of ['label_version', 'content_version', 'model_family', 'prompt_version', 'policy_version']) {
    ledger.add(`V3a-ENV-6-${field}`, `data.ai.${field} 非空字符串`, typeof ai?.[field] === 'string' && ai[field].trim() !== '', '非空字符串', ai?.[field]);
  }
  ledger.add('V3a-ENV-7', 'policy_version 与 ai-content-policy v1.1.2 对齐', ai?.policy_version === 'ai-content-policy/1.1.2', 'ai-content-policy/1.1.2', ai?.policy_version);
  const disc = meta?.disclaimer;
  ledger.add('V3a-ENV-8', 'meta.disclaimer.text 非空', typeof disc?.text === 'string' && disc.text.trim() !== '', '非空字符串', disc?.text);
  ledger.add('V3a-ENV-9', 'meta.disclaimer.version 形状', DISCLAIMER_VERSION_RE.test(String(disc?.version)), 'YYYY.MM.N', disc?.version);
  ledger.add('V3a-ENV-10', 'meta.disclaimer.closable===false（不可关闭）', disc?.closable === false, false, disc?.closable);
  ledger.add('V3a-ENV-11', 'meta.source + meta.entitlement 在位', meta?.source !== undefined && meta?.entitlement !== undefined, '{source,entitlement}', { source: meta?.source, entitlement: meta?.entitlement });
  ledger.add('V3a-ENV-12', "data.compliance.decision==='passed'", data?.compliance?.decision === 'passed', 'passed', data?.compliance);
  const visibleText = JSON.stringify([data?.sections, data?.caveats] ?? []);
  ledger.add('V3a-RED-1', 'AI 可见文案无荐股红线词', !ADVISORY_RE.test(visibleText), '无命中', ADVISORY_RE.exec(visibleText)?.[0] ?? null);
  observations.push({ note: '命名澄清（AI-CARD「meta.ai」vs 契约 data.ai）', data_ai_present: data?.ai !== undefined, meta_ai_present: meta?.ai !== undefined, data_meta_present: data?.meta !== undefined });

  // ---- 3. market 证据独立重放（input_evidence_hash 复算素材） ----
  const quote = await req('GET', `/v1/instruments/${encodeURIComponent(INSTRUMENT)}/quote`, { token: userA.token });
  const fund = await req('GET', `/v1/instruments/${encodeURIComponent(INSTRUMENT)}/fundamental-summary`, { token: userA.token });
  ledger.add('V3a-EV-1', 'market quote 200（自环真仓储）', quote.status === 200, 200, quote.status);
  ledger.add('V3a-EV-2', 'market fundamental-summary 200', fund.status === 200, 200, fund.status);
  const evidence = [
    evidenceItemFromEnvelope('market_quote', quote.body),
    evidenceItemFromEnvelope('fundamental_summary', fund.body),
  ];
  const inputHashRecomputed = recomputeInputEvidenceHash({
    kind: 'stock_interpretation',
    audience: 'c_end',
    asOf: String(data?.as_of ?? ''),
    evidence,
  });

  // ---- 4. 审计行（audit.ai_generation_events） ----
  const rowsRaw = psql(`SELECT row_to_json(t) FROM (SELECT * FROM audit.ai_generation_events WHERE analysis_id = ${sqlLit(data?.analysis_id)}) t`);
  const rows = rowsRaw === '' ? [] : rowsRaw.split('\n').map((line) => JSON.parse(line));
  ledger.add('V3a-AUD-1', '审计行恰 1 条（analysis_id 同源）', rows.length === 1, 1, rows.length);
  const row = rows[0] ?? {};
  ledger.add('V3a-AUD-2', "decision==='passed'", row.decision === 'passed', 'passed', row.decision);
  ledger.add('V3a-AUD-3', 'request_id 非空（闭环键）', typeof row.request_id === 'string' && row.request_id.trim() !== '', '非空', row.request_id);
  ledger.add('V3a-AUD-4', 'request_id 与请求头 x-request-id 同值（如外壳透传）', row.request_id === REQUEST_ID, REQUEST_ID, row.request_id, row.request_id === REQUEST_ID ? '外壳透传 x-request-id' : 'INFO：外壳未透传头，request.id 自生成——闭环改以 analysis_id 对账');
  if (row.request_id !== REQUEST_ID) ledger.checks[ledger.checks.length - 1].pass = 'INFO';
  ledger.add('V3a-AUD-5', 'user_id = HMAC-SHA256(identity user_id, key) 独立复算', row.user_id === createHmac('sha256', USER_HASH_KEY).update(String(userA.userId), 'utf8').digest('hex'), createHmac('sha256', USER_HASH_KEY).update(String(userA.userId), 'utf8').digest('hex'), row.user_id);
  ledger.add('V3a-AUD-6', 'as_of 与响应 data.as_of 同值', row.as_of === data?.as_of, data?.as_of, row.as_of);
  ledger.add('V3a-AUD-7', 'model_family 记录', typeof row.model_family === 'string' && row.model_family !== '', '非空', row.model_family);
  ledger.add('V3a-AUD-8', 'input_evidence_hash 64hex', HASH_RE.test(String(row.input_evidence_hash)), '64hex', row.input_evidence_hash);
  ledger.add('V3a-AUD-9', 'output_hash 64hex', HASH_RE.test(String(row.output_hash)), '64hex', row.output_hash);
  ledger.add('V3a-AUD-10', 'passed 行无 blocked_draft', row.blocked_draft === null || row.blocked_draft === undefined, null, row.blocked_draft);
  ledger.add('V3a-AUD-11', 'postprocess_actions 为数组', Array.isArray(row.postprocess_actions), 'array', JSON.stringify(row.postprocess_actions)?.slice(0, 200));
  ledger.add('V3a-AUD-12', '链字段 event_key/prev_hash/hash 在位', [row.event_key, row.prev_hash, row.hash].every((v) => typeof v === 'string' && v !== ''), '三字段非空', { event_key: row.event_key, prev_hash: row.prev_hash, hash: row.hash });

  // ---- 5. hash 独立重算闭环（AI1-3） ----
  const responseClaims = (Array.isArray(data?.sections) ? data.sections : [])
    .flatMap((section) => (Array.isArray(section?.claims) ? section.claims : []))
    .map((claim) => ({ text: claim?.text, class: 'historical_facts', evidence_ids: claim?.evidence_ids ?? [] }));
  const outputHashRecomputed = recomputeOutputHash(responseClaims);
  ledger.add('V3a-HASH-1', 'output_hash 独立重算闭环（claims=响应 sections，class=数据卡口径 historical_facts）', outputHashRecomputed === row.output_hash, row.output_hash, outputHashRecomputed, '数据卡降级路径 claim.class 固定 historical_facts（services/ai/src/generation.ts dataCardDraft）');
  const outputHashNullClass = recomputeOutputHash(responseClaims.map((c) => ({ ...c, class: null })));
  ledger.add('V3a-HASH-2', 'output_hash 兜底口径（class=null）比对', outputHashNullClass === row.output_hash, row.output_hash, outputHashNullClass, '仅当 HASH-1 失败时参考');
  const hash1Pass = ledger.checks.find((c) => c.id === 'V3a-HASH-1')?.pass === 'PASS';
  if (hash1Pass) ledger.checks[ledger.checks.length - 1].pass = 'INFO';
  ledger.add('V3a-HASH-3', 'input_evidence_hash 独立重算闭环（market 响应重放）', inputHashRecomputed === row.input_evidence_hash, row.input_evidence_hash, inputHashRecomputed, 'evidence 项构造独立实现在 tests/e2e/lib/ai1-verify-lib.mjs');

  // ---- 6. GET 回环 + 404 不泄露 ----
  const get = await req('GET', `/v1/ai/analyses/${encodeURIComponent(data?.analysis_id ?? '')}`, { token: userA.token });
  ledger.add('V3a-GET-1', 'GET /v1/ai/analyses/{id} → 200 同 analysis_id', get.status === 200 && get.body?.data?.analysis_id === data?.analysis_id, { status: 200, analysis_id: data?.analysis_id }, { status: get.status, analysis_id: get.body?.data?.analysis_id });
  ledger.add('V3a-GET-2', 'GET 回环 data.as_of 同值', get.body?.data?.as_of === data?.as_of, data?.as_of, get.body?.data?.as_of);
  ledger.add('V3a-GET-3', 'GET 回环 data 与 POST 一致（canonical 比对）', canonicalJson(get.body?.data) === canonicalJson(data), 'canonical 相等', canonicalJson(get.body?.data) === canonicalJson(data) ? '相等' : '不等');

  const missing = await req('GET', '/v1/ai/analyses/does-not-exist-0001', { token: userA.token });
  ledger.add('V3a-404-1', '不存在 analysis_id → 404 problem', missing.status === 404 && missing.body?.status === 404 && typeof missing.body?.code === 'string', { status: 404, problem_shape: true }, { status: missing.status, code: missing.body?.code, title: missing.body?.title });
  const userB = await registerAndLogin('userB');
  const cross = await req('GET', `/v1/ai/analyses/${encodeURIComponent(data?.analysis_id ?? '')}`, { token: userB.token });
  ledger.add('V3a-404-2', '非本人 analysis_id → 404 且与不存在同型（不泄露存在性）', cross.status === 404 && cross.body?.code === missing.body?.code, { status: 404, code: missing.body?.code }, { status: cross.status, code: cross.body?.code });

  // ---- 7. 证据落盘 ----
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidenceOut = {
    generated_at: new Date().toISOString(),
    target: API,
    instrument: INSTRUMENT,
    request_id_sent: REQUEST_ID,
    checks: ledger.checks,
    raw: {
      register_a: userA.reg,
      login_a_status: userA.login.status,
      post: post.body,
      get_roundtrip_status: get.status,
      audit_row: row,
      missing_404: missing.body,
      cross_user_404: cross.body,
    },
    recompute: {
      input_evidence_hash: { computed: inputHashRecomputed, audit: row.input_evidence_hash },
      output_hash: { computed: outputHashRecomputed, computed_null_class: outputHashNullClass, audit: row.output_hash },
      evidence_items: evidence.map(({ id, text, numbers }) => ({ id, text_len: text.length, numbers_len: numbers.length })),
    },
    observations,
  };
  const outPath = join(EVIDENCE_DIR, 'http-verify.json');
  writeFileSync(outPath, JSON.stringify(evidenceOut, null, 2));
  console.log(`\n证据 → ${outPath}`);
  const failed = ledger.failed();
  console.log(`V3a 结果：${ledger.checks.filter((c) => c.pass === 'PASS').length} PASS / ${failed.length} FAIL / ${ledger.checks.filter((c) => c.pass === 'INFO').length} INFO`);
  if (failed.length > 0) {
    console.log('FAIL 清单：' + failed.map((c) => c.id).join(', '));
    process.exitCode = 1;
  }
}

await main();
