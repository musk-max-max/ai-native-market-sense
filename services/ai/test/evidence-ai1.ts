/**
 * AI1 HTTP 层闭环增补证据脚本（A3，2026-11-06，Lead m00480「复核扩充、不覆盖」口径）。
 *
 * 定位：ea4bf474 的样本（ai1-evidence-2026-11-06.md 判据 2）是服务层直驱
 * （AnalysesService.run() + initdb 临时库）。本脚本补 HTTP 层闭环证据：
 *   进程内真栈 buildApp(壳) + marketPlugin(serving 真库) + aiPlugin(audit 真库)
 *   → 真实 socket HTTP POST /v1/ai/analyses → audit.ai_generation_events 落行
 *   → request_id / analysis_id / hash 三向闭环 + 幂等重放 + 越权 GET 404。
 *
 * 运行（services/ai 目录下）：node --import tsx test/evidence-ai1.ts
 * 产物：打印 JSON 报告（人工并入 tests/data/acceptance/artifacts/ai1-evidence-2026-11-06.md）。
 * 说明：文件名不匹配 test/*.test.ts，不进 CI 测试；但受 tsc 门禁约束，必须保持类型干净。
 */
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { computeInputEvidenceHash, computeOutputHash } from '@market-sense/ai-policy';
import type { Principal } from '../../identity/src/domain/principal.js';
import { configFingerprint } from '../../market/src/domain/entitlement.js';
import { buildApp } from '../../api/src/app.js';
import { marketPlugin } from '../../market/src/plugin.js';
import { createAiPlugin } from '../src/plugin.js';
import { createAiPolicyEvaluator } from '../src/postprocess/policy-evaluator.js';
import { httpEvidenceSource } from '../src/evidence.js';
import type { AnalysisSubjectLike, EvidenceItem, EvidenceProbeResult } from '../src/evidence.js';

// ---------- 环境（必须先于 buildApp/register 生效；market/ai 插件安装时读取） ----------
const PG_PORT = 55432;
const EXPIRES_RAW = '2026-11-12T23:59:59+08:00';
const USER_HASH_KEY = 'ai1-evidence-user-hash-key';
const TOKEN = 'ai1-http-evidence-token';
const TOKEN_2 = 'ai1-http-evidence-token-2';

process.env.DATABASE_URL = `postgres://market_app:market_app@127.0.0.1:${PG_PORT}/market_sense`;
process.env.ENTITLEMENT_TIER = 'c_end_display';
process.env.ENTITLEMENT_EXPIRES_AT = EXPIRES_RAW;
process.env.ENTITLEMENT_HOLD_CHECK = '1';
process.env.ENTITLEMENT_AUDIT = '1';
// parseExpiresAt 归一化为 UTC ISO 后参与指纹（services/market/src/config.ts:170）。
process.env.ENTITLEMENT_CONFIG_EXPECTED_SHA256 = configFingerprint(
  'c_end_display',
  new Date(EXPIRES_RAW).toISOString(),
);
process.env.AI_DATABASE_URL = `postgres://ai_app:ai_app@127.0.0.1:${PG_PORT}/market_sense`;
// 缺省 APP_PROFILE=prod → market config 强制 DEPLOYMENT_UID（L65 audit_gap 去重键）。本脚本跑真栈，显式给值。
process.env.DEPLOYMENT_UID = 'ai1-http-evidence-deployment';
process.env.AI_USER_HASH_KEY = USER_HASH_KEY;
delete process.env.E2E_MODE;
delete process.env.MARKET_NOW;

// ---------- 工具 ----------
type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  if (typeof value !== 'object' || value === null) throw new Error(`期望对象，收到 ${typeof value}`);
  return value as Json;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`期望字符串，收到 ${typeof value}`);
  return value;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('期望数组');
  return value.map((item) => asString(item));
}

interface Check {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
function check(label: string, passed: boolean, detail: string): void {
  checks.push({ label, passed, detail });
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('未能取得临时端口'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolvePort(port));
    });
  });
}

// ---------- 主流程 ----------
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const REQUEST_ID = 'ai1-http-req-0001';

const evidence = httpEvidenceSource({ baseUrl: BASE });
const policyPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../rules/ai-content-policy.json');
const aiPlugin = createAiPlugin({
  evidence,
  policyEvaluator: createAiPolicyEvaluator({ policyPath }),
  userHashKey: USER_HASH_KEY,
});
const authenticator = async (request: FastifyRequest): Promise<Principal | null> => {
  const header = request.headers.authorization;
  if (header === `Bearer ${TOKEN}`) {
    return { userId: 'evidence-user-001', userType: 'c_end', tier: 'c_end_display', sessionVersion: 1 };
  }
  if (header === `Bearer ${TOKEN_2}`) {
    return { userId: 'evidence-user-002', userType: 'c_end', tier: 'c_end_display', sessionVersion: 1 };
  }
  return null;
};
const app = buildApp({ domainPlugins: [marketPlugin, aiPlugin], authenticator });
await app.listen({ port: PORT, host: '127.0.0.1' });

const subject: AnalysisSubjectLike = {
  // 客户端期望数据截止时点（D2：不能替代审计业务时点 as_of——本例故意与源 as_of 不同）。
  instrument_id: 'SSE:600519',
  as_of: '2026-11-06T15:30:00+08:00',
};
const requestBody = {
  kind: 'stock_interpretation',
  subject,
  options: { include_evidence: true },
  idempotency_key: 'ai1-http-evidence-01',
};

// 请求 1：真实生成。
const res1 = await fetch(`${BASE}/v1/ai/analyses`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    'request-id': REQUEST_ID,
    'x-request-id': REQUEST_ID,
  },
  body: JSON.stringify(requestBody),
});
const body1 = asRecord(await res1.json());
const data = asRecord(body1['data']);
const analysisId = asString(data['analysis_id']);
const aiMeta = asRecord(data['ai']);
const dataMeta = asRecord(data['meta']);
const topMeta = asRecord(body1['meta']);
const compliance = asRecord(data['compliance']);
const sections = data['sections'];
if (!Array.isArray(sections)) throw new Error('sections 不是数组');

check('POST /v1/ai/analyses → 200', res1.status === 200, `status=${res1.status}`);
check('analysis_id 形态（8..128 ^[A-Za-z0-9_-]+$）', /^[A-Za-z0-9_-]{8,128}$/.test(analysisId), analysisId);
check(
  'data.ai 六字段齐 + generated=true',
  ['generated', 'label_version', 'content_version', 'model_family', 'prompt_version', 'policy_version'].every(
    (key) => key in aiMeta,
  ) && aiMeta['generated'] === true,
  JSON.stringify(Object.keys(aiMeta)),
);
check(
  'data.as_of = 源业务时点 ≠ 客户端 subject.as_of（D2 审计 as_of 口径）',
  typeof data['as_of'] === 'string' && data['as_of'] !== subject.as_of,
  `data.as_of=${String(data['as_of'])}；subject.as_of=${subject.as_of}`,
);
check('顶层 meta 与 data.meta 同形（契约两处同形）', JSON.stringify(topMeta) === JSON.stringify(dataMeta), 'deepEqual');
check(
  'meta.disclaimer 不可关闭（closable=false）',
  JSON.stringify(dataMeta).includes('"closable":false'),
  'meta.disclaimer',
);

// 请求 2：幂等重放（同 user + idempotency_key → 同 analysis_id，不再生成）。
const res2 = await fetch(`${BASE}/v1/ai/analyses`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    'request-id': 'ai1-http-req-0002',
  },
  body: JSON.stringify(requestBody),
});
const body2 = asRecord(await res2.json());
const analysisId2 = asString(asRecord(body2['data'])['analysis_id']);
check('幂等重放同 analysis_id', res2.status === 200 && analysisId2 === analysisId, `second=${analysisId2}`);

// 请求 3/4：GET 本人 200；越权（另一用户）404，不泄露存在性。
const res3 = await fetch(`${BASE}/v1/ai/analyses/${analysisId}`, {
  headers: { authorization: `Bearer ${TOKEN}`, 'request-id': 'ai1-http-req-0003' },
});
const res4 = await fetch(`${BASE}/v1/ai/analyses/${analysisId}`, {
  headers: { authorization: `Bearer ${TOKEN_2}`, 'request-id': 'ai1-http-req-0004' },
});
check('GET 本人可取', res3.status === 200, `status=${res3.status}`);
check('GET 越权/非本人 404（不泄露存在性）', res4.status === 404, `status=${res4.status}`);

// ---------- 审计行读回（owner 角色 ms；ai_app 仅 INSERT 列级授权，SELECT 归 A13 GRANT 待办） ----------
const pool = new Pool({
  host: '127.0.0.1',
  port: PG_PORT,
  user: 'ms',
  password: 'ms',
  database: 'market_sense',
  connectionTimeoutMillis: 3000,
  query_timeout: 3000,
  statement_timeout: 3000,
});
const { rows } = await pool.query<{ row: string }>(
  `SELECT row_to_json(t)::text AS row FROM (
     SELECT request_id, trace_id, analysis_id, audience, user_id, kind, model_family,
            prompt_version, policy_version, content_version, label_version,
            input_evidence_hash, output_hash, decision, as_of, event_key, prev_hash, hash
     FROM audit.ai_generation_events WHERE analysis_id = $1
   ) t`,
  [analysisId],
);
if (rows.length !== 1) throw new Error(`审计行数=${rows.length}，期望 1`);
const auditRow = asRecord(JSON.parse(rows[0]!.row));

check(
  'audit.request_id ↔ 请求头 request-id 闭环',
  auditRow['request_id'] === REQUEST_ID,
  `audit.request_id=${String(auditRow['request_id'])}；sent=${REQUEST_ID}`,
);
check('audit.trace_id = requestId（跨服务调用链锚点）', auditRow['trace_id'] === REQUEST_ID, String(auditRow['trace_id']));
check('audit.analysis_id ↔ data.analysis_id 闭环', auditRow['analysis_id'] === analysisId, String(auditRow['analysis_id']));
check(
  'audit.event_key = ai|generation|<request_id>（003 契约约定）',
  auditRow['event_key'] === `ai|generation|${REQUEST_ID}`,
  String(auditRow['event_key']),
);
check('audience=c_end（按路径判定）', auditRow['audience'] === 'c_end', String(auditRow['audience']));
check(
  'audit.as_of = data.as_of = 源业务时点',
  auditRow['as_of'] === data['as_of'],
  `audit.as_of=${String(auditRow['as_of'])}`,
);
check(
  'content_version/label_version = COPY_VERSION.derived（2026.11.5.ac875c9d9237）',
  auditRow['content_version'] === '2026.11.5.ac875c9d9237' && auditRow['label_version'] === '2026.11.5.ac875c9d9237',
  String(auditRow['content_version']),
);
check(
  'policy_version = ai-content-policy/1.1.2（rules 真源）',
  auditRow['policy_version'] === 'ai-content-policy/1.1.2',
  String(auditRow['policy_version']),
);
check('decision=passed 且 response status=succeeded', auditRow['decision'] === 'passed' && data['status'] === 'succeeded', String(auditRow['decision']));
check('prev_hash/hash 64hex（003 触发器权威生成）', /^[0-9a-f]{64}$/.test(String(auditRow['hash'])) && /^[0-9a-f]{64}$/.test(String(auditRow['prev_hash'])), String(auditRow['hash']));

// ---------- hash 复算（展示留痕可复算，判据 3） ----------
// ① input_evidence_hash：重探测证据集 → computeInputEvidenceHash 复算。
const probe: EvidenceProbeResult = await evidence.probe(subject, { bearer: TOKEN });
const evItems: EvidenceItem[] = probe.modules
  .filter((module) => module.status === 'ok')
  .flatMap((module) => [...module.evidence]);
const recomputedInput = computeInputEvidenceHash({
  kind: asString(data['kind']),
  audience: 'c_end',
  asOf: asString(data['as_of']),
  evidence: evItems.map((item) => ({ ...item })),
});
check(
  'input_evidence_hash 复算一致（重探测证据集）',
  recomputedInput === auditRow['input_evidence_hash'],
  `recomputed=${recomputedInput}`,
);

// ② output_hash：响应用户可见 claim（数据卡路径 class=historical_facts）→ computeOutputHash 复算。
const visibleClaims = sections.flatMap((rawSection) => {
  const section = asRecord(rawSection);
  const claims = section['claims'];
  if (!Array.isArray(claims)) throw new Error('claims 不是数组');
  return claims.map((rawClaim) => {
    const claim = asRecord(rawClaim);
    return {
      text: asString(claim['text']),
      class: 'historical_facts' as const,
      evidence_ids: asStringArray(claim['evidence_ids']),
    };
  });
});
const recomputedOutput = computeOutputHash(visibleClaims);
check(
  'output_hash 复算一致（用户可见 claim canonical sha256）',
  recomputedOutput === auditRow['output_hash'],
  `recomputed=${recomputedOutput}`,
);

// ---------- 报告 ----------
const report = {
  run_at: new Date().toISOString(),
  stack: '进程内 buildApp(壳)+marketPlugin(serving 真库)+aiPlugin(audit 真库)，PG 55432 market_sense',
  request: { request_id: REQUEST_ID, body: requestBody },
  response: body1,
  audit_row: auditRow,
  recomputed: { input_evidence_hash: recomputedInput, output_hash: recomputedOutput },
  checks,
  all_passed: checks.every((item) => item.passed),
};
console.log(JSON.stringify(report, null, 2));

await pool.end();
await app.close();
process.exitCode = checks.every((item) => item.passed) ? 0 : 1;
