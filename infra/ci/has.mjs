/**
 * market-sense-h5 · 仓库存量探测（空仓友好）
 *
 * WHY：S0 是骨架阶段，很多目录只有 .gitkeep。CI 不能因为「还没有实现」就红灯，
 *      但也不能假装做过检查。本脚本输出「这项现在有没有东西可查」，让每个 job 明确
 *      skip 而不是 silent pass。skip 会写进 job summary，评审可见。
 *
 * 用法：
 *   node infra/ci/has.mjs                 # 人类可读
 *   node infra/ci/has.mjs --json          # JSON
 *   node infra/ci/has.mjs --gha all       # 输出 key=value，供 $GITHUB_OUTPUT 消费
 */

import { appendFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.pnpm-store',
  '.terraform',
]);
const CODE_DIRS = ['services', 'packages', 'web', 'jobs'];
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function walk(dir, visit, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit, depth + 1);
    else if (entry.isFile()) visit(full, entry.name);
  }
}

function rel(full) {
  return full.slice(ROOT.length + 1);
}

function collect() {
  const contractDomains = [];
  const contractsDir = join(ROOT, 'contracts');
  try {
    for (const entry of readdirSync(contractsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        if (statSync(join(contractsDir, entry.name, 'openapi.yaml')).isFile())
          contractDomains.push(entry.name);
      } catch {
        /* 该域没有 openapi.yaml */
      }
    }
  } catch {
    /* 还没有 contracts/ */
  }

  const runbooks = [];
  try {
    for (const entry of readdirSync(join(ROOT, 'docs', 'runbook'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
        runbooks.push(entry.name);
    }
  } catch {
    /* 还没有 docs/runbook/ */
  }

  let hasCode = false;
  let hasTests = false;
  const codeFiles = [];
  const testFiles = [];
  for (const dirName of CODE_DIRS) {
    walk(join(ROOT, dirName), (full, name) => {
      const path = rel(full);
      if (CODE_EXT.test(name)) {
        hasCode = true;
        codeFiles.push(path);
      }
      if (TEST_FILE.test(name)) {
        hasTests = true;
        testFiles.push(path);
      }
    });
  }
  walk(join(ROOT, 'tests'), (full, name) => {
    const path = rel(full);
    if (TEST_FILE.test(name)) {
      hasTests = true;
      testFiles.push(path);
    }
  });
  walk(join(ROOT, 'infra', 'ci', 'test'), (full, name) => {
    if (TEST_FILE.test(name)) {
      hasTests = true;
      testFiles.push(rel(full));
    }
  });

  const hasHelm = exists(join(ROOT, 'infra', 'helm', 'market-sense', 'Chart.yaml'));
  const hasTerraform = exists(join(ROOT, 'infra', 'terraform', 'envs', 'dev', 'main.tf'));
  const hasMonitoring = exists(
    join(ROOT, 'infra', 'monitoring', 'alerts', 'market-sense.rules.yaml'),
  );
  const hasDocker = exists(join(ROOT, 'Dockerfile')) || exists(join(ROOT, 'docker-compose.yml'));
  const hasBundle = exists(join(ROOT, 'pnpm-lock.yaml'));

  // e2e 是独立安装单元（不在 pnpm workspace 内），见 infra/ci/README.md。
  // 只有当 playwright 配置与至少一个 spec 同时存在时才认为可跑，避免占位目录触发空跑。
  const e2eDir = join(ROOT, 'tests', 'e2e');
  const hasPlaywrightConfig = [
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.ts',
    'playwright.config.cjs',
  ].some((name) => exists(join(e2eDir, name)));
  let e2eSpecCount = 0;
  try {
    for (const entry of readdirSync(join(e2eDir, 'specs'), { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:spec|test)\.[cm]?[jt]s$/.test(entry.name)) e2eSpecCount += 1;
    }
  } catch {
    /* 还没有 tests/e2e/specs/ */
  }
  const hasE2e = hasPlaywrightConfig && e2eSpecCount > 0;

  return {
    has_contracts: contractDomains.length > 0,
    contract_domains: contractDomains.join(','),
    contract_count: String(contractDomains.length),
    has_code: hasCode,
    code_count: String(codeFiles.length),
    has_tests: hasTests,
    test_count: String(testFiles.length),
    has_runbooks: runbooks.length > 0,
    runbook_count: String(runbooks.length),
    has_helm: hasHelm,
    has_terraform: hasTerraform,
    has_monitoring: hasMonitoring,
    has_docker: hasDocker,
    has_e2e: hasE2e,
    e2e_spec_count: String(e2eSpecCount),
    has_bundle: hasBundle,
    runbooks: runbooks.join(','),
  };
}

function exists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const data = collect();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (argv.includes('--gha')) {
    const lines = Object.entries(data)
      .filter(([key]) => key !== 'runbooks')
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
    console.log(lines);
    return;
  }
  console.log(`仓库探测（${ROOT}）：`);
  for (const [key, value] of Object.entries(data)) {
    if (key === 'runbooks') continue;
    console.log(`  ${key}: ${value}`);
  }
  if (data.runbooks) console.log(`  runbooks: ${data.runbooks}`);
}

main();
