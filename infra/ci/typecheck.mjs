/**
 * market-sense-h5 · 聚合 typecheck
 *
 * S0 阶段各 workspace 还没有 tsconfig；本脚本遍历存在的 tsconfig.json，逐个 `tsc -p`。
 * 一个都没有时明确 skip（exit 0）并打印原因，避免「空仓绿」被误读成「类型已检查」。
 * CI 中 skip 会写入 job summary（见 .github/workflows/ci.yml）。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKSPACE_DIRS = ['packages', 'services', 'web', 'jobs'];

function findProjects() {
  const projects = [];
  for (const group of WORKSPACE_DIRS) {
    let entries;
    try {
      entries = readdirSync(join(ROOT, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(ROOT, group, entry.name);
      if (existsFile(join(dir, 'tsconfig.json'))) projects.push(join(group, entry.name));
    }
  }
  return projects;
}

function existsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const projects = findProjects();
if (projects.length === 0) {
  console.log(
    '⏭ typecheck skipped：还没有任何 workspace 提供 tsconfig.json（S0 骨架阶段，不是类型检查通过）',
  );
  process.exit(0);
}

const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
const failed = [];
for (const project of projects) {
  console.log(`\n▶ tsc -p ${project}`);
  const result = spawnSync(tsc, ['-p', project], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) failed.push(project);
}

if (failed.length > 0) {
  console.error(`\n❌ typecheck 失败：${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n✅ typecheck 通过：${projects.length} 个 workspace 工程`);
