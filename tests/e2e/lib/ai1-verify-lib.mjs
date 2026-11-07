/**
 * A7 · AI-1 真栈验证共享库（tests/ 写域）。
 *
 * 用途：ai1-verify.mjs（V3a HTTP 真栈 passed 样本）与 ai1-blocked-verify.mjs（V3b 服务层
 * 真库 blocked 样本）共用的独立复算工具。canonical 规范按 packages/ai-policy/src/canonical.ts
 * 注释口径独立实现（键按 Unicode 码点升序、无空白、数组保序、禁非有限数/循环引用），
 * evidence 项构造按 services/ai/src/evidence.ts 口径独立实现（factText / collectNumbers）。
 * 复算对象是「A3 证据声称」，因此实现刻意不 import A3 的函数——hash 对上才算独立闭环。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ---------- 独立 canonical JSON（对齐 packages/ai-policy/src/canonical.ts 口径） ----------

function compareCodePoints(left, right) {
  const a = Array.from(left, (c) => c.codePointAt(0) ?? 0);
  const b = Array.from(right, (c) => c.codePointAt(0) ?? 0);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

export function canonicalJson(value, stack = new Set()) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: 非有限数字不允许');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: 不支持的类型 ${typeof value}`);
  }
  if (stack.has(value)) throw new TypeError('canonicalJson: 不允许循环引用');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, stack)).join(',')}]`;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: 只允许 plain object');
    }
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], stack)}`)
      .join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** output_hash 独立复算：sha256(canonicalJson({claims:[{text,class,evidence_ids}]}))，claims 保序。 */
export function recomputeOutputHash(claims) {
  return sha256hex(
    canonicalJson({
      claims: claims.map((claim) => ({
        text: claim.text,
        class: claim.class,
        evidence_ids: [...claim.evidence_ids],
      })),
    }),
  );
}

/** input_evidence_hash 独立复算：evidence 按 id 字典序排序后入 canonical。 */
export function recomputeInputEvidenceHash({ kind, audience, asOf, evidence }) {
  const sorted = [...evidence]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => ({
      id: item.id,
      text: item.text,
      ...(item.numbers === undefined ? {} : { numbers: item.numbers }),
    }));
  return sha256hex(
    canonicalJson({ kind, audience, as_of: asOf, evidence: sorted }),
  );
}

/** blocked 样本 output_hash 独立复算：sha256(canonicalJson(完整被阻断 draft))。 */
export function recomputeBlockedDraftHash(draft) {
  return sha256hex(canonicalJson(draft));
}

// ---------- 独立 evidence 项构造（对齐 services/ai/src/evidence.ts 口径） ----------

/** market 响应 data 数值展平：递归、Object.values 序、depth<=6、上限 200。 */
export function collectNumbers(value, out, depth = 0) {
  if (depth > 6 || out.length >= 200) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectNumbers(item, out, depth + 1);
  }
}

/** 事实行：<module>|as_of=<ISO>|<compact json>，预算 1800 截断加省略号。 */
export function evidenceFactText(module, asOf, data) {
  // 防御：非 200/缺 data 信封不崩（JSON.stringify(undefined)===undefined）；正常 200 路径行为不变。
  const json = JSON.stringify(data) ?? 'null';
  const budget = 1800 - module.length - asOf.length;
  const truncated = json.length > budget ? `${json.slice(0, Math.max(0, budget))}…` : json;
  return `${module}|as_of=${asOf}|${truncated}`;
}

/** 从 market wire 响应独立构造单模块 evidence 项（id 形如 ev:<module>）。 */
export function evidenceItemFromEnvelope(module, envelope) {
  const asOf = envelope?.meta?.source?.as_of ?? '';
  const numbers = [];
  collectNumbers(envelope?.data, numbers);
  return { id: `ev:${module}`, text: evidenceFactText(module, asOf, envelope?.data), numbers };
}

// ---------- psql 直查（审计行取证） ----------

export function makePsql(envOverrides = {}) {
  const env = {
    PGHOST: envOverrides.PGHOST ?? '/tmp/a7-ai1-verify/sock',
    PGPORT: envOverrides.PGPORT ?? '55533',
    PGUSER: envOverrides.PGUSER ?? 'postgres',
    PGDATABASE: envOverrides.PGDATABASE ?? 'postgres',
  };
  const psqlBin = envOverrides.PSQL ?? 'psql';
  return function psql(sql) {
    const r = spawnSync(psqlBin, ['-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
}

/** SQL 字面量（dollar quoting，覆盖 JSON/引号/换行）。 */
export function sqlLit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  let tag = 'q';
  while (text.includes(`$${tag}$`)) tag += 'q';
  return `$${tag}$${text}$${tag}$`;
}

// ---------- 检查台账 ----------

export function makeLedger() {
  const checks = [];
  return {
    checks,
    add(id, name, pass, expected, actual, note = '') {
      checks.push({
        id,
        name,
        pass: pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO',
        expected: expected === undefined ? null : expected,
        actual: actual === undefined ? null : actual,
        note,
      });
      const mark = pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO';
      console.log(`[${mark}] ${id} ${name}` + (pass === false ? `  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}` : ''));
    },
    failed() {
      return checks.filter((c) => c.pass === 'FAIL');
    },
  };
}

export const HASH_RE = /^[0-9a-f]{64}$/;
