/**
 * H3 m01237 / Lead m01254：manifest 的 hash 只能由脚本重算并写入，禁止手抄。
 *
 * `tsx scripts/copy-manifest.mjs`         校验并回写 docs/release/copy-version-manifest.md
 *                                        中当前 COPY_VERSION 行的 frontend/backend hash 与快照文件名。
 * `tsx scripts/copy-manifest.mjs --check` 只校验，不写；hash/文件名对不上即退出 1。
 *
 * 人工只负责写 release/日期/依据列；数字列由本脚本覆盖。
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AI_COPY, COPY_TEXT_HASH, COPY_VERSION, ERROR_TITLES, MARKET_COPY, RATE_LIMITED_DETAIL, VALIDATION_FAILED_DETAIL } from '../src/copy.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const manifestPath = path.join(root, 'docs/release/copy-version-manifest.md');
const snapshotDir = path.join(root, 'docs/release/copy-snapshots');
const checkOnly = process.argv.includes('--check');

function canon() {
  return {
    version: COPY_VERSION,
    titles: ERROR_TITLES,
    validation_failed_detail: VALIDATION_FAILED_DETAIL,
    rate_limited_detail: RATE_LIMITED_DETAIL,
    market: MARKET_COPY,
    ai: AI_COPY,
  };
}
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

const backendHash = stableHash(canon());
if (backendHash !== COPY_TEXT_HASH) {
  console.error(`[copy-manifest] copy.ts 的 COPY_TEXT_HASH 已过期：计算=${backendHash} 声明=${COPY_TEXT_HASH}`);
  process.exit(1);
}

const frontendFiles = (await readdir(snapshotDir)).filter(
  (f) => f.startsWith(`${COPY_VERSION}.`) && f.endsWith('.frontend.json'),
);
if (frontendFiles.length !== 1) {
  console.error(`[copy-manifest] ${COPY_VERSION} 的 frontend 快照应恰好 1 个，实际 ${frontendFiles.length}：${frontendFiles.join(', ')}`);
  process.exit(1);
}
const frontendFile = frontendFiles[0];
const frontendSnapshot = JSON.parse(await readFile(path.join(snapshotDir, frontendFile), 'utf8'));
const frontendHash = frontendSnapshot.hash;
if (typeof frontendHash !== 'string' || !frontendFile.includes(frontendHash.slice(0, 12))) {
  console.error(`[copy-manifest] frontend 快照文件名与内容 hash 不一致：${frontendFile} / ${frontendHash}`);
  process.exit(1);
}

const backendFile = `${COPY_VERSION}.${backendHash.slice(0, 12)}.backend.json`;
try {
  await readFile(path.join(snapshotDir, backendFile), 'utf8');
} catch {
  console.error(`[copy-manifest] 缺少 backend 快照：${backendFile}`);
  process.exit(1);
}

const manifest = await readFile(manifestPath, 'utf8');
const lines = manifest.split('\n');
// append-only：同版本可能有历史行（P0-pre、P0-pre-2…），当前行取最后一条；
// 历史行不因快照删除而失效，由墓碑段落回指。
const rowIndex = lines.findLastIndex((line) => {
  const cells = line.split('|').map((c) => c.trim());
  return cells.length >= 8 && cells[3] === COPY_VERSION && cells[4] === COPY_VERSION;
});
if (rowIndex < 0) {
  console.error(`[copy-manifest] manifest 找不到 ${COPY_VERSION} 的行（frontend/backend 版本列均为该值）`);
  process.exit(1);
}

const cells = lines[rowIndex].split('|');
// H3 m01237：当前行的“快照文件”列必须引用实际存在的文件，且包含 frontend/backend 两个快照名。
const snapshotCell = cells[7] ?? '';
const referencedSnapshots = [...snapshotCell.matchAll(/`([^`]+\.json)`/g)].map((m) => m[1]);
if (!referencedSnapshots.includes(frontendFile)) {
  console.error(`[copy-manifest] manifest 当前行未引用 frontend 快照：${frontendFile}`);
  process.exit(1);
}
if (!referencedSnapshots.includes(backendFile)) {
  console.error(`[copy-manifest] manifest 当前行未引用 backend 快照：${backendFile}`);
  process.exit(1);
}
for (const snapshotFile of referencedSnapshots) {
  try {
    await readFile(path.join(snapshotDir, snapshotFile), 'utf8');
  } catch {
    console.error(`[copy-manifest] manifest 当前行引用了不存在的快照：${snapshotFile}`);
    process.exit(1);
  }
}

const expected = [...cells];
expected[5] = ` ${frontendHash} `;
expected[6] = ` ${backendHash} `;
const rewritten = expected.join('|');
const changed = rewritten !== lines[rowIndex];

if (checkOnly) {
  if (changed) {
    console.error('[copy-manifest] manifest 数字列与脚本重算不一致（运行不带 --check 让脚本回写）：');
    console.error(`  frontend 期望=${frontendHash} 实际=${cells[5].trim()}`);
    console.error(`  backend  期望=${backendHash} 实际=${cells[6].trim()}`);
    process.exit(1);
  }
  console.log(`[copy-manifest] OK version=${COPY_VERSION} frontend=${frontendFile} backend=${backendFile}`);
} else {
  if (changed) {
    lines[rowIndex] = rewritten;
    await writeFile(manifestPath, lines.join('\n'), 'utf8');
    console.log(`[copy-manifest] 已回写 manifest 数字列：frontend=${frontendHash.slice(0, 12)} backend=${backendHash.slice(0, 12)}`);
  } else {
    console.log(`[copy-manifest] manifest 已是最新：version=${COPY_VERSION}`);
  }
}
