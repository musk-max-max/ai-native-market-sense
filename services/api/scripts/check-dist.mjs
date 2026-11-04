/**
 * 生产产物出口扫描（H3 m01038 条件 4）：
 * - 不允许发布 sourcemap（源码注释会随 sourcemap 下发，等于客户端可达出口）；
 * - tsc 构建已开 removeComments（tsconfig.build.json），再对 dist 下所有 .js 做一次厂商标识/内部编号静态扫描。
 * 说明：internal_eval / c_end_display 等是运行时判定常量，不是响应文案，不在本扫描的禁词表；
 * 用户可见输出另由 test/app.test.ts 的出口断言覆盖。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const FORBIDDEN = [/\btushare\b/i, /\bwind\b/i, /\bchoice\b/i, /\bifind\b/i, /\bakshare\b/i, /\beastmoney\b/i, /（F1）|\bF1\b/];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let jsCount = 0;
const violations = [];
for await (const file of walk(dist)) {
  const rel = path.relative(root, file);
  if (rel.endsWith('.map')) {
    violations.push(`${rel}: 生产产物包含 sourcemap`);
    continue;
  }
  if (!rel.endsWith('.js')) continue;
  jsCount += 1;
  const text = await readFile(file, 'utf8');
  for (const pattern of FORBIDDEN) {
    if (pattern.test(text)) violations.push(`${rel}: 命中 ${String(pattern)}`);
  }
}

if (violations.length > 0) {
  console.error('[dist] 生产产物出口扫描失败：');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`[dist] OK files=${jsCount}（无 sourcemap、无厂商标识/内部编号 F1）`);
