#!/usr/bin/env node
/* global console, process, URL */
/**
 * AC-9 首屏 JS 预算检查：dist/assets/*.js 的 gzip 合计必须 ≤ 200KB。
 *
 * 为什么按 gzip 合计而不是只看入口 chunk：首屏会并行 preload 入口依赖的 chunk，
 * 合计值才是浏览器实际要下载的脚本量（保守口径）。超预算时优先砍功能，
 * 不允许砍免责声明、as_of、数据来源等合规标识。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BUDGET_BYTES = 200 * 1024;
const H5_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ASSETS_DIR = process.env.WEB_ASSETS_DIR
  ? resolve(process.env.WEB_ASSETS_DIR)
  : join(H5_DIR, 'dist', 'assets');

if (!existsSync(ASSETS_DIR)) {
  console.error(`[budget] 未找到构建产物：${ASSETS_DIR}。请先运行 npm run build。`);
  process.exit(1);
}

const files = readdirSync(ASSETS_DIR)
  .filter((name) => name.endsWith('.js'))
  .map((name) => {
    const path = join(ASSETS_DIR, name);
    const source = readFileSync(path);
    return { name, raw: statSync(path).size, gzip: gzipSync(source, { level: 9 }).length };
  })
  .sort((a, b) => b.gzip - a.gzip);

if (files.length === 0) {
  console.error(`[budget] ${ASSETS_DIR} 下没有 .js 产物。`);
  process.exit(1);
}

const totalRaw = files.reduce((sum, file) => sum + file.raw, 0);
const totalGzip = files.reduce((sum, file) => sum + file.gzip, 0);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

console.log('[budget] 首屏 JS（gzip）明细：');
for (const file of files) {
  console.log(
    `  ${file.name.padEnd(36)} ${kb(file.raw).padStart(10)} raw  ${kb(file.gzip).padStart(9)} gzip`,
  );
}
console.log(
  `[budget] 合计：${kb(totalRaw)} raw / ${kb(totalGzip)} gzip（预算 ${kb(BUDGET_BYTES)} gzip）`,
);

if (totalGzip > BUDGET_BYTES) {
  const over = totalGzip - BUDGET_BYTES;
  console.error(
    `[budget] FAIL：首屏 JS 超出预算 ${kb(over)}。按约束先砍功能，不砍免责/as_of/来源标识。`,
  );
  process.exit(1);
}

console.log(`[budget] PASS：剩余 ${kb(BUDGET_BYTES - totalGzip)}。`);
