/**
 * H3 m00839/m00870：copy.ts 内容 hash ↔ COPY_VERSION 的构建期校验。
 *
 * 规则：COPY_TEXT_HASH 必须等于本脚本对当前文本的规范化哈希；且
 * docs/release/copy-snapshots/<COPY_VERSION>.json 必须存在并逐字匹配当前文本。
 * 文案改了却没升版本/没加新快照 → 退出码 1（构建失败），杜绝「改文不升版」。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COPY_TEXT_HASH, COPY_VERSION, ERROR_TITLES, MARKET_COPY, RATE_LIMITED_DETAIL, VALIDATION_FAILED_DETAIL } from '../src/copy.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const snapshotPath = path.join(root, 'docs/release/copy-snapshots', `${COPY_VERSION}.${COPY_TEXT_HASH.slice(0, 12)}.backend.json`);

function canon() {
  return {
    version: COPY_VERSION,
    titles: ERROR_TITLES,
    validation_failed_detail: VALIDATION_FAILED_DETAIL,
    rate_limited_detail: RATE_LIMITED_DETAIL,
    market: MARKET_COPY,
  };
}
function hashOf(value) {
  return createHash('sha256')
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest('hex');
}
// 与生成 COPY_TEXT_HASH 时相同的规范序列化（sort_keys + 紧凑分隔符）。
function stableHash(value) {
  const stable = (v) => {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
  };
  return createHash('sha256').update(stable(value)).digest('hex');
}

const current = canon();
const currentHash = stableHash(current);
if (currentHash !== COPY_TEXT_HASH) {
  console.error(`[copy] COPY_TEXT_HASH 不匹配：当前=${currentHash} 声明=${COPY_TEXT_HASH}`);
  console.error('[copy] 文案变更必须升 COPY_VERSION、重算 hash 并新增快照。');
  process.exit(1);
}

let snapshot;
try {
  snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
} catch {
  console.error(`[copy] 缺少快照：${path.relative(root, snapshotPath)}`);
  process.exit(1);
}
if (stableHash(snapshot) !== currentHash) {
  console.error(`[copy] 快照与当前文案不一致：${path.relative(root, snapshotPath)}`);
  console.error('[copy] 快照 append-only：请新增版本而不是改旧快照。');
  process.exit(1);
}
console.log(`[copy] OK version=${COPY_VERSION} hash=${currentHash.slice(0, 12)}… snapshot=${path.relative(root, snapshotPath)}`);
