#!/usr/bin/env node
// check-internal-boundary.mjs —— 内部域（config/approval）客户端边界门禁。
//
// 依据：ADR-001 D4 / ADR-007 / H2 2026-11-06 会签条件。
// 内部域成功响应豁免 `{data,meta}` 包络，因此客户端边界必须真实隔离：
//   1) `@market-sense/api-client/internal/*` 只允许 `web/console/**`（A8 中后台）import；
//      `web/h5/**`、`services/**`、`packages/**`（`packages/api-client` 自身除外）、
//      `jobs/**` 等任何其他代码出现该 import 即红（含相对路径钻进 src/internal 的绕过）。
//   2) 面客入口 `packages/api-client/src/index.ts` 的 `ApiPaths` 不得包含 config/approval 的 paths：
//      公开 generated/* 里不得出现内部域 path key，ApiPaths 只由 market/fundamental/watchlist 组成。
//
// 零依赖；`--self-test` 用内存夹具自检（防止脚本静默失效）。CI 与 `pnpm ci:all` 都跑。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_ROOTS = ['web', 'services', 'packages', 'jobs'];
const ALLOWED_PREFIXES = ['web/console/', 'packages/api-client/'];
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.state',
  '.terraform',
  '.git',
]);
const PUBLIC_GENERATED = [
  'packages/api-client/src/generated/market.ts',
  'packages/api-client/src/generated/fundamental.ts',
  'packages/api-client/src/generated/watchlist.ts',
  'packages/api-client/src/generated/shared.ts',
];
const INDEX_TS = 'packages/api-client/src/index.ts';
const PACKAGE_JSON = 'packages/api-client/package.json';

const INTERNAL_SPEC_RE = /api-client\/(?:src\/)?internal\//;
const SPECIFIER_RE = /['"]([^'"]+)['"]/g;

function walk(absDir, out = []) {
  if (!existsSync(absDir)) return out;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // 隐藏目录（.next 等）不进；但允许扫普通点文件之外的代码
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, out);
    } else if (entry.isFile() && CODE_EXT.has(path.extname(entry.name))) {
      out.push(abs);
    }
  }
  return out;
}

/** 从源码文本里找 api-client/internal 的 import 目标（包名或相对路径绕过）。 */
export function internalSpecifiers(text) {
  const specs = [];
  let m;
  SPECIFIER_RE.lastIndex = 0;
  while ((m = SPECIFIER_RE.exec(text)) !== null) {
    if (INTERNAL_SPEC_RE.test(m[1])) specs.push(m[1]);
  }
  return [...new Set(specs)];
}

/** 相对仓库根的路径是否允许 import internal 入口。 */
export function isAllowedImporter(relPath) {
  return ALLOWED_PREFIXES.some((p) => relPath.startsWith(p));
}

/** 解析 OpenAPI yaml 的 paths 键（忽略缩进外的其他键）。仅覆盖本仓 6 域契约的简单格式。 */
export function parsePathKeys(yamlText) {
  const keys = [];
  let inPaths = false;
  for (const line of yamlText.split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      if (/^\S/.test(line) || /^  [A-Za-z_][\w-]*:\s*/.test(line)) {
        inPaths = false;
        continue;
      }
      const m = /^\s{2}["']?(\/[^"':]+)["']?:\s*$/.exec(line);
      if (m) keys.push(m[1]);
    }
  }
  return keys;
}

/** 面客入口断言：index.ts 不 import/export internal，ApiPaths 只由公开域构成。 */
export function checkPublicEntry(indexText) {
  const problems = [];
  if (
    /from\s+['"]\.\/internal\//.test(indexText) ||
    /from\s+['"][^'"]*\/internal\//.test(indexText)
  ) {
    problems.push('index.ts 直接 import 了 ./internal/*（内部域混入面客入口）');
  }
  const apiPaths = /export\s+type\s+ApiPaths\s*=\s*([^;]+);/.exec(indexText)?.[1]?.trim();
  if (!apiPaths) {
    problems.push('index.ts 未找到 `export type ApiPaths = ...`（脚本规则需同步契约入口）');
  } else {
    if (/Internal|ConfigPaths|ApprovalPaths/i.test(apiPaths)) {
      problems.push(`ApiPaths 引用了内部域类型：${apiPaths}`);
    }
    const parts = apiPaths.split('&').map((s) => s.trim());
    const allowed = new Set(['MarketPaths', 'FundamentalPaths', 'WatchlistPaths']);
    for (const part of parts) {
      if (!allowed.has(part)) problems.push(`ApiPaths 含非公开域成分：${part}`);
    }
  }
  return problems;
}

function loadText(rel) {
  const abs = path.join(repo, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

function runMain() {
  const failures = [];
  const violations = [];
  let scanned = 0;

  for (const root of SCAN_ROOTS) {
    for (const abs of walk(path.join(repo, root))) {
      const rel = path.relative(repo, abs).split(path.sep).join('/');
      scanned += 1;
      const text = readFileSync(abs, 'utf8');
      const specs = internalSpecifiers(text);
      if (specs.length > 0 && !isAllowedImporter(rel)) {
        violations.push({ rel, specs });
      }
    }
  }

  // 2) package.json 必须保留独立 internal 入口（否则隔离形同虚设）。
  let pkg = null;
  try {
    pkg = JSON.parse(loadText(PACKAGE_JSON) || '{}');
  } catch {
    failures.push(`${PACKAGE_JSON} 不是合法 JSON`);
  }
  if (pkg && !pkg.exports?.['./internal/*']) {
    failures.push(`${PACKAGE_JSON} 缺少 "./internal/*" 独立入口（面客入口不能被内部域复用）`);
  }

  // 3) 面客入口 ApiPaths 不含 config/approval（按契约 paths 键逐个断言，含生成文件）。
  const indexText = loadText(INDEX_TS);
  if (indexText === null) {
    failures.push(`缺少 ${INDEX_TS}`);
  } else {
    failures.push(...checkPublicEntry(indexText).map((p) => `${INDEX_TS}: ${p}`));
  }

  const contractPaths = [];
  for (const rel of ['contracts/config/openapi.yaml', 'contracts/approval/openapi.yaml']) {
    const text = loadText(rel);
    if (text === null) {
      failures.push(`缺少内部域契约 ${rel}（无法断言 ApiPaths 隔离）`);
      continue;
    }
    contractPaths.push(...parsePathKeys(text));
  }
  if (contractPaths.length === 0) failures.push('内部域契约未解析出任何 paths（规则失效）');

  for (const rel of PUBLIC_GENERATED) {
    const text = loadText(rel);
    if (text === null) {
      failures.push(`缺少面客生成文件 ${rel}`);
      continue;
    }
    for (const p of contractPaths) {
      if (text.includes(`"${p}"`)) {
        failures.push(`${rel} 含内部域 path "${p}"（面客 ApiPaths 不得包含 config/approval）`);
      }
    }
  }

  if (violations.length === 0 && failures.length === 0) {
    console.log(
      `✓ 内部域客户端边界：扫描 ${scanned} 个代码文件，无越界 import；面客 ApiPaths 不含 ${contractPaths.length} 条内部域 path`,
    );
    return 0;
  }
  for (const v of violations) {
    console.error(`✗ 越界 import：${v.rel}`);
    for (const s of v.specs) console.error(`    ${s}`);
  }
  for (const f of failures) console.error(`✗ ${f}`);
  console.error(
    '\n内部域（config/approval）只能由 web/console 经 @market-sense/api-client/internal/* 访问。',
  );
  return 1;
}

function runSelfTest() {
  const checks = [];
  const t = (name, cond) => checks.push([name, Boolean(cond)]);

  t(
    '识别包名 import',
    internalSpecifiers(`import { getConfig } from '@market-sense/api-client/internal/config';`)
      .length === 1,
  );
  t(
    '识别相对路径绕过',
    internalSpecifiers(
      `import { getConfig } from '../../../packages/api-client/src/internal/config';`,
    ).length === 1,
  );
  t(
    '普通面客 import 不误报',
    internalSpecifiers(`import { createApiClient } from '@market-sense/api-client';`).length === 0,
  );
  t('web/console 允许', isAllowedImporter('web/console/src/api/internal.ts'));
  t('web/h5 不允许', !isAllowedImporter('web/h5/src/api/internal.ts'));
  t('services 不允许', !isAllowedImporter('services/api/src/internal.ts'));
  t('packages 其他包不允许', !isAllowedImporter('packages/shared/src/internal.ts'));
  t('api-client 自身允许', isAllowedImporter('packages/api-client/src/internal/config.ts'));

  const yaml = [
    'paths:',
    '  /v1/internal/configs:',
    '    get:',
    '      responses: {}',
    '  /v1/internal/approvals:',
    '',
  ].join('\n');
  t(
    '解析契约 paths',
    JSON.stringify(parsePathKeys(yaml)) ===
      JSON.stringify(['/v1/internal/configs', '/v1/internal/approvals']),
  );

  t(
    '拒绝 ApiPaths 引用内部域',
    checkPublicEntry(
      `import type { paths as MarketPaths } from './generated/market.js';\nexport type ApiPaths = MarketPaths & ConfigPaths;`,
    ).length > 0,
  );
  t(
    '拒绝 import ./internal',
    checkPublicEntry(
      `import type { paths as X } from './internal/config.js';\nexport type ApiPaths = X;`,
    ).length > 0,
  );
  t(
    '接受纯公开 ApiPaths',
    checkPublicEntry(
      `import type { paths as MarketPaths } from './generated/market.js';\nexport type ApiPaths = MarketPaths;`,
    ).length === 0,
  );

  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (failed.length > 0) {
    console.error(`\n内部域边界门禁自检失败：${failed.length}/${checks.length}`);
    return 1;
  }
  console.log(`\n内部域边界门禁自检通过：${checks.length} 项`);
  return 0;
}

const selfTest = process.argv.includes('--self-test');
process.exit(selfTest ? runSelfTest() : runMain());
