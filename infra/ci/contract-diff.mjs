/**
 * market-sense-h5 · 契约门禁（redocly lint + oasdiff 按域 breaking diff）
 *
 * 规则（Lead 派单 m00019）：
 *  - oasdiff 固定 1.35.0，不用 latest；版本不符直接失败（可复现，供应链可审计）。
 *  - 按域（contracts/<domain>/openapi.yaml）分别 diff：一个域破坏性变更即红灯。
 *  - 破坏性判定以 oasdiff `breaking` 为准（exit 1）；新增域/新增文件允许并记录。
 *  - 删除契约文件 = 破坏性（显式红灯），因为下游 api-client/e2e 会断。
 *  - 基线：CI 传 CONTRACT_BASE_SHA（PR base）或 CONTRACT_BASE_REF（merge-base 计算）；
 *    首次推送 / 无基线 → 只做 lint（写清楚 skip 原因，不假装 diff 过）。
 *  - 空仓（尚无契约）→ skip。
 *
 * 用法：node infra/ci/contract-diff.mjs [--base <sha|ref>] [--head <ref>] [--json]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OASDIFF_VERSION = '1.35.0';
// decisions.md L45：PR 门禁与 baseline 门禁必须共用同一份 severity 文件；
// 无 waiver 通道（豁免走 tests/contract/waivers.yaml + H2 签字）。
const SEVERITY_FILE = 'contracts/oasdiff-severity.txt';
const CONTRACTS_DIR = join(ROOT, 'contracts');

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...options });
}

function hasContracts() {
  try {
    return readdirSync(CONTRACTS_DIR, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(CONTRACTS_DIR, entry.name, 'openapi.yaml')),
    );
  } catch {
    return false;
  }
}

function contractFiles() {
  return readdirSync(CONTRACTS_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(CONTRACTS_DIR, entry.name, 'openapi.yaml')),
    )
    .map((entry) => `contracts/${entry.name}/openapi.yaml`)
    .sort();
}

function git(args) {
  return run('git', args, { cwd: ROOT });
}

function isGitRepo() {
  return git(['rev-parse', '--is-inside-work-tree']).status === 0;
}

function redoclyLint(files) {
  const config = join(ROOT, 'infra', 'ci', 'redocly.yaml');
  const result = run('pnpm', ['exec', 'redocly', 'lint', '--config', config, ...files]);
  if (result.status === 0) return { ok: true, output: result.stdout + result.stderr };
  return { ok: false, output: (result.stdout || '') + (result.stderr || '') };
}

function oasdiffVersion() {
  const result = run('oasdiff', ['--version']);
  if (result.status !== 0) return null;
  return `${result.stdout}${result.stderr}`.trim();
}

function resolveBase(argBase) {
  if (argBase) return argBase;
  if (process.env.CONTRACT_BASE_SHA) return process.env.CONTRACT_BASE_SHA;
  if (process.env.CONTRACT_BASE_REF) {
    const mergeBase = git(['merge-base', process.env.CONTRACT_BASE_REF, 'HEAD']);
    if (mergeBase.status === 0) return mergeBase.stdout.trim();
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const mergeBase = git(['merge-base', candidate, 'HEAD']);
    if (mergeBase.status === 0) return mergeBase.stdout.trim();
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const baseArgIndex = argv.indexOf('--base');
  const baseArg = baseArgIndex >= 0 ? argv[baseArgIndex + 1] : null;

  if (!hasContracts()) {
    console.log('⏭ 契约门禁 skipped：contracts/ 下还没有 openapi.yaml（空仓阶段）');
    return;
  }
  const files = contractFiles();
  console.log(`契约门禁：${files.length} 份契约`);

  const failures = [];

  // 1) lint（始终执行）
  const lint = redoclyLint(files);
  if (lint.ok) {
    console.log('✅ redocly lint 通过');
  } else {
    failures.push('redocly lint');
    console.error('❌ redocly lint 失败：\n' + lint.output);
  }

  // 2) oasdiff 版本必须固定
  const versionText = oasdiffVersion();
  if (!versionText) {
    failures.push('oasdiff 未安装');
    console.error(
      '❌ 未找到 oasdiff：CI 由 infra/ci/install-oasdiff.sh 安装；本地可 `brew install oasdiff`',
    );
  } else if (!versionText.includes(OASDIFF_VERSION)) {
    failures.push(`oasdiff 版本不是 ${OASDIFF_VERSION}`);
    console.error(`❌ oasdiff 版本不符：期望 ${OASDIFF_VERSION}，实际 ${versionText}`);
  } else {
    console.log(`✅ oasdiff ${OASDIFF_VERSION} 版本锁定`);
  }

  // 3) 按域 breaking diff
  if (failures.includes('oasdiff 未安装') || failures.some((f) => f.startsWith('oasdiff 版本'))) {
    console.error('\n❌ 契约门禁失败（oasdiff 不可用，无法做破坏性 diff）');
    process.exit(1);
  }

  if (!isGitRepo()) {
    console.log('⏭ 破坏性 diff skipped：当前目录不是 git 仓库（本地骨架阶段）；CI 中会执行');
    if (failures.length > 0) process.exit(1);
    return;
  }

  const base = resolveBase(baseArg);
  if (!base) {
    console.log('⏭ 破坏性 diff skipped：无基线（首次推送/空仓）；已做 lint 与版本锁定');
    if (failures.length > 0) process.exit(1);
    return;
  }
  if (/^0+$/.test(base)) {
    console.log('⏭ 破坏性 diff skipped：base 是全零 SHA（新分支首次推送）；已做 lint');
    if (failures.length > 0) process.exit(1);
    return;
  }

  const diff = git(['diff', '--name-status', `${base}...HEAD`, '--', 'contracts']);
  if (diff.status !== 0) {
    console.error(`❌ 无法计算契约 diff（base=${base}）：${diff.stderr.trim()}`);
    process.exit(1);
  }
  const changes = diff.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status, path };
    })
    .filter((change) => change.path?.endsWith('openapi.yaml'));

  if (changes.length === 0) {
    console.log(`✅ 无契约变更（base=${base.slice(0, 8)}），破坏性检查无需执行`);
    if (failures.length > 0) process.exit(1);
    console.log('\n✅ 契约门禁通过');
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'oasdiff-'));
  try {
    for (const change of changes) {
      if (change.status.startsWith('D')) {
        failures.push(`删除契约 ${change.path}`);
        console.error(`❌ 破坏性：删除契约文件 ${change.path}（下游 api-client/e2e 会断）`);
        continue;
      }
      if (change.status.startsWith('A')) {
        console.log(`ℹ 新增契约 ${change.path}（新增域允许）`);
        continue;
      }
      const oldFile = join(tmp, `${change.path.replaceAll('/', '_')}.old.yaml`);
      const show = git(['show', `${base}:${change.path}`]);
      if (show.status !== 0) {
        failures.push(`无法读取基线 ${change.path}`);
        console.error(`❌ 无法从 ${base} 读取 ${change.path}：${show.stderr.trim()}`);
        continue;
      }
      writeFileSync(oldFile, show.stdout);
      if (!existsSync(join(ROOT, SEVERITY_FILE))) {
        failures.push(`缺少 severity 文件 ${SEVERITY_FILE}`);
        console.error(
          `❌ 缺少 ${SEVERITY_FILE}（A0 写/H2 审）；不允许退回默认级别，否则 PR 与 baseline 口径分裂`,
        );
        continue;
      }
      const result = run('oasdiff', [
        'breaking',
        '--severity-levels',
        SEVERITY_FILE,
        oldFile,
        change.path,
      ]);
      if (result.status === 0) {
        console.log(`✅ [${change.path}] 无破坏性变更`);
      } else {
        failures.push(`破坏性变更 ${change.path}`);
        console.error(
          `❌ [${change.path}] 检测到破坏性变更：\n${(result.stdout || '') + (result.stderr || '')}`,
        );
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n❌ 契约门禁失败（${failures.length} 项）：${failures.join('；')}`);
    console.error(
      '处置：破坏性变更须 A0 更新契约 + H2 评审 + 升级 API 版本策略；禁止在 PR 里静默改坏。',
    );
    process.exit(1);
  }
  console.log('\n✅ 契约门禁通过（lint + oasdiff breaking diff）');
}

main();
