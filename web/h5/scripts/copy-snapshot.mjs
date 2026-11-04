#!/usr/bin/env node
/* global console, process, URL */
/**
 * 用户可见文案快照校验（ADR-006 D3 的前端实现）。
 *
 * 用法：
 *   node scripts/copy-snapshot.mjs --check     校验快照与当前 copy.ts 逐字一致（构建期挂载）
 *   node scripts/copy-snapshot.mjs --write     升版后重新生成本版本快照（人工执行并随版本提交）
 *
 * 快照：docs/release/copy-snapshots/<COPY_VERSION>.<hash12>.frontend.json（与 backend 同规则，append-only）
 * hash：对「规范化文本清单」做 sha256（清单 = 所有用户可见字符串，排序去重），
 *       并回填 docs/release/copy-version-manifest.md 的 frontend hash 列。
 * 规则：改了文案不升版本 / 不更新快照 → 构建失败。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { COPY_VERSION, ERROR_COPY, MISSING, SOURCE_LABELS, copy } from '../src/lib/copy.ts';

const H5_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_DIR = join(H5_DIR, '..', '..');
const SNAPSHOT_DIR = join(REPO_DIR, 'docs', 'release', 'copy-snapshots');
const MANIFEST_FILE = join(REPO_DIR, 'docs', 'release', 'copy-version-manifest.md');

/** 递归收集所有字符串叶子；函数（debug 文案生成器）跳过，它的输出只用于控制台。 */
function collectStrings(value, out = new Set()) {
  if (typeof value === 'string') {
    out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/** 规范化文本清单：排序去重，保证同文案任何机器上 hash 一致。 */
export function canonicalStrings() {
  const all = collectStrings([copy, ERROR_COPY, SOURCE_LABELS, MISSING]);
  return [...all].sort();
}

export function copyTextHash() {
  const payload = JSON.stringify({ version: COPY_VERSION, strings: canonicalStrings() });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function buildSnapshot() {
  return {
    version: COPY_VERSION,
    side: 'frontend',
    generatedFrom: 'web/h5/src/lib/copy.ts',
    hash: copyTextHash(),
    strings: canonicalStrings(),
  };
}

function snapshotFileName(hash) {
  return `${COPY_VERSION}.${hash.slice(0, 12)}.frontend.json`;
}

function snapshotPath(hash) {
  return join(SNAPSHOT_DIR, snapshotFileName(hash));
}

/** 找本版本已存在的 frontend 快照（可能因文案改动导致 hash 变化）。 */
function existingFrontendSnapshots() {
  try {
    return readdirSync(SNAPSHOT_DIR).filter(
      (name) => name.startsWith(`${COPY_VERSION}.`) && name.endsWith('.frontend.json'),
    );
  } catch {
    return [];
  }
}

function checkManifestRow(hash, fileName) {
  if (!existsSync(MANIFEST_FILE)) return { ok: false, reason: 'copy-version-manifest.md 不存在' };
  const text = readFileSync(MANIFEST_FILE, 'utf8');
  // 同一版本可追加多行（发版前文案修正会产生新 hash）；以登记了当前 hash 的行为准，
  // 找不到时回退到最新一行，便于报出「登记的是哪个旧 hash」。
  const rows = text
    .split('\n')
    .filter((line) =>
      line
        .split('|')
        .map((cell) => cell.trim())
        .includes(COPY_VERSION),
    );
  const row = rows.find((candidate) => candidate.includes(hash)) ?? rows.at(-1);
  if (!row) return { ok: false, reason: `manifest 缺少 ${COPY_VERSION} 行（成对发版登记）` };
  if (!row.includes(hash)) {
    return {
      ok: false,
      reason: `manifest 的 ${COPY_VERSION} 行未登记当前 frontend hash（预期 ${hash}）`,
    };
  }
  if (!row.includes(fileName)) {
    return { ok: false, reason: `manifest 的 ${COPY_VERSION} 行未记录快照文件名 ${fileName}` };
  }
  // 该行引用的后端快照文件必须存在（后端 hash 由后端校验）。
  const backendRefs = row.match(new RegExp(`${COPY_VERSION.replaceAll('.', '\\.')}\\.[a-f0-9]+\\.backend\\.json`, 'g')) ?? [];
  for (const ref of backendRefs) {
    if (!existsSync(join(SNAPSHOT_DIR, ref))) {
      return { ok: false, reason: `manifest 引用的后端快照不存在：${ref}` };
    }
  }
  return { ok: true };
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const snapshot = buildSnapshot();
  const fileName = snapshotFileName(snapshot.hash);
  const target = snapshotPath(snapshot.hash);

  if (mode === 'write') {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`[copy] 写入快照 ${target}`);
    console.log(`[copy] frontend hash = ${snapshot.hash}`);
    return;
  }

  if (!existsSync(target)) {
    const stale = existingFrontendSnapshots();
    console.error(`[copy] 缺少当前文案的快照：${fileName}`);
    if (stale.length > 0) {
      console.error(`[copy] 已存在其他 hash 的 ${COPY_VERSION} 快照：${stale.join(', ')}`);
      console.error('[copy] 说明文案改过但没升版本（或没重新生成快照并按规则改名）。');
    } else {
      console.error('[copy] 若这是新版本，请先升 COPY_VERSION 再运行 --write 并登记 manifest。');
    }
    process.exit(1);
  }
  const stored = JSON.parse(readFileSync(target, 'utf8'));
  if (stored.version !== snapshot.version || stored.hash !== snapshot.hash) {
    console.error('[copy] 文案与快照不一致（改了文案但没升版本或没更新快照）。');
    console.error(`[copy] 快照 hash=${stored.hash} 当前 hash=${snapshot.hash}`);
    process.exit(1);
  }
  const sameStrings = JSON.stringify(stored.strings) === JSON.stringify(snapshot.strings);
  if (!sameStrings) {
    console.error('[copy] 快照文本清单与当前 copy.ts 不一致，请核对后重新生成。');
    process.exit(1);
  }
  // manifest 只记文件名与 hash；断言引用的文件真实存在（回指不能断链）。
  const manifest = checkManifestRow(snapshot.hash, snapshotFileName(snapshot.hash));
  if (!manifest.ok) {
    console.error(`[copy] ${manifest.reason}`);
    process.exit(1);
  }
  console.log(`[copy] OK · ${COPY_VERSION} · ${snapshot.strings.length} 条文案 · ${snapshot.hash}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
