#!/usr/bin/env node
// check-repo-hygiene.mjs —— 前向检查：待提交文件里出现秘密/状态/日志/超大文件即红。
// 目的不是替代 .gitignore，而是在秘密进入历史之前拦住（Lead m01563）。
// 覆盖：已 tracked（git ls-files --cached）与未 tracked 但会被提交的文件（--others --exclude-standard）。
// 无 .git 时显式 skip（S0 早期），不伪装通过。
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BYTES = 2 * 1024 * 1024;
const FIXTURE_PREFIXES = ['tests/fixtures/', 'tests/e2e/fixtures/', 'data/golden/'];
const FORBIDDEN = [
  { name: '.env 文件', re: /(^|\/)\.env(\.|$)/ },
  { name: 'kubeconfig', re: /(^|\/)kubeconfig[^/]*$/i },
  { name: 'terraform state', re: /\.tfstate(\.backup)?$/ },
  { name: '日志文件', re: /\.log$/i },
  { name: '私钥/证书', re: /(^|\/)(id_rsa|id_ed25519|[^/]+\.pem)$/ },
  { name: 'PGDATA/.state', re: /(^|\/)\.state\// },
];

let failures = 0;
function fail(msg) {
  failures++;
  console.log(`❌ ${msg}`);
}

if (!existsSync(path.join(repo, '.git'))) {
  console.log('⏭ 不是 git 仓库：仓库卫生检查跳过（S0 早期；git init 后自动生效）');
  process.exit(0);
}

let files = [];
try {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  files = out.split('\0').filter(Boolean);
} catch (err) {
  console.error(`❌ git ls-files 失败：${err.message}`);
  process.exit(1);
}

for (const rel of files) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(rel)) fail(`禁止提交 ${rule.name}：${rel}`);
  }
  const abs = path.join(repo, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    continue; // 已删除但仍在索引里的路径，由 git status 处理
  }
  if (!st.isFile()) continue;
  if (st.size > MAX_BYTES && !FIXTURE_PREFIXES.some((p) => rel.startsWith(p))) {
    fail(`大于 2MB 的非 fixture 文件：${rel}（${(st.size / 1024 / 1024).toFixed(1)}MB）`);
  }
}

// .gitignore 必须包含关键条目，防止以后有人删掉。
let gitignore = '';
try {
  gitignore = execFileSync('git', ['show', 'HEAD:.gitignore'], { cwd: repo, encoding: 'utf8' });
} catch {
  gitignore = '';
}
for (const entry of ['.state', 'node_modules', '*.tfstate', 'kubeconfig', '*.log']) {
  if (!gitignore.includes(entry)) fail(`.gitignore 缺少 ${entry}`);
}

if (failures > 0) {
  console.error(`\n仓库卫生检查失败：${failures} 项（秘密/状态文件不得进入历史）`);
  process.exit(1);
}
console.log(
  `✅ 仓库卫生检查通过（检查 ${files.length} 个待提交文件；无 .env/tfstate/kubeconfig/.log/超大文件）`,
);
