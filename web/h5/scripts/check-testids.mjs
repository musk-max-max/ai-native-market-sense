#!/usr/bin/env node
/* global console, process, URL */
/**
 * testid 契约漂移检查（A12 owns tests/e2e/testids.json，web/h5 只消费）。
 *
 * 规则：
 *  - testids.json 里的每个 id 必须在 web/h5/src 出现（否则页面漏实现）；
 *  - 免责关闭件（disclaimer-close）是唯一例外：它必须「不出现」，因为没有关闭控件；
 *  - stock-page-empty 是预留 state id，P0 暂无空态，允许暂未使用。
 *
 * 该脚本不替代 E2E，只用于在提交前快速发现 testid 改名/漏挂。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const H5_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(H5_DIR, '..', '..');
const TESTIDS_PATH = join(REPO_ROOT, 'tests', 'e2e', 'testids.json');
const SRC_DIR = join(H5_DIR, 'src');

const NOT_RENDERED = new Set(['disclaimer-close']);
const PENDING = new Set(['stock-page-empty']);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

let testids;
try {
  testids = JSON.parse(readFileSync(TESTIDS_PATH, 'utf8'));
} catch (error) {
  console.error(`[testids] 无法读取 ${TESTIDS_PATH}: ${error.message}`);
  process.exit(1);
}

const ids = new Map(
  [...Object.entries(testids.ids ?? {}), ...Object.entries(testids.stateIds ?? {})].filter(
    ([key]) => key !== 'description',
  ),
);

const source = walk(SRC_DIR)
  .filter((path) => /\.(ts|tsx)$/.test(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

const missing = [];
for (const [key, id] of ids) {
  if (NOT_RENDERED.has(id) || PENDING.has(id)) continue;
  if (!source.includes(`'${id}'`) && !source.includes(`"${id}"`)) missing.push(`${key}=${id}`);
}

if (source.includes('disclaimer-close')) {
  console.error(
    '[testids] FAIL：src 中出现 disclaimer-close —— 免责声明不可关闭，DOM 不得渲染关闭控件。',
  );
  process.exit(1);
}

if (missing.length > 0) {
  console.error('[testids] FAIL：以下 testid 在 web/h5/src 中未实现：');
  for (const item of missing) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(
  `[testids] PASS：${ids.size} 个 id 已对齐 tests/e2e/testids.json（关闭件按规则不渲染）。`,
);
