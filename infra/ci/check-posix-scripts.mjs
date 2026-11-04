#!/usr/bin/env node
/**
 * check-posix-scripts.mjs —— 容器内可执行性守卫（Lead L77 / ECS 事故）
 *
 * WHY：`tests/e2e/docker-compose.yml` 的 db-migrate 镜像只能是 postgres:16
 *      （Debian，/bin/sh=dash，无 bash、无 node）。如果 bootstrap.sh / db-migrate.sh
 *      回退到 bash 特性（[[ ]]、BASH_SOURCE、${var,,}、数组、进程替换、$'\t'）或调 node，
 *      macOS 本地仍会过，ECS 上必挂——这正是 L77「造不出环境」的同源教训。
 *
 * 检查：
 *  1) 两个脚本 shebang 必须是 `#!/bin/sh`；db-migrate compose 服务必须 `sh` 调用两脚本；
 *  2) 脚本正文（去掉注释行）不得出现 bash-only 构造；
 *  3) bootstrap 的 node 静态校验必须包在 `command -v node` 分支内，且无 node 时打印显式跳过；
 *  4) 本地 `dash -n` / `sh -n` 语法检查（有 dash 时）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url).pathname;
const SCRIPTS = ['infra/db/bootstrap.sh', 'infra/scripts/db-migrate.sh'];
const COMPOSE = 'tests/e2e/docker-compose.yml';
const failures = [];
const checks = [];
const ok = (m) => checks.push(m);
const bad = (m) => failures.push(m);

const BASH_ONLY = [
  [/\[\[/, '[[ ]] 双中括号'],
  [/\]\]/, '[[ ]] 双中括号'],
  [/\bBASH_SOURCE\b/, 'BASH_SOURCE'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*,,[^}]*\}/, '${var,,} 小写扩展'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^[^}]*\}/, '${var^^} 大写扩展'],
  [/^\s*[A-Za-z_][A-Za-z0-9_]*=\(/m, '数组赋值 name=(...)'],
  [/declare\s+-[aA]/, 'declare -a/-A 数组'],
  [/\$\{#[A-Za-z_][A-Za-z0-9_]*\[@\]\}/, '${#arr[@]} 数组长度'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}/, '${arr[@]} 数组展开'],
  [/<\(/, '进程替换 <(...)'],
  [/\$'[^']*\\t[^']*'/, "$'\\t' ANSI-C 引号"],
  [/\bset\s+-[a-zA-Z]*o\s+pipefail/, 'set -o pipefail'],
];

function stripComments(text) {
  return text
    .split('\n')
    .map((l) => (l.trim().startsWith('#') ? '' : l))
    .join('\n');
}

for (const rel of SCRIPTS) {
  const p = ROOT + rel;
  if (!existsSync(p)) {
    bad(`${rel} 不存在`);
    continue;
  }
  const raw = readFileSync(p, 'utf8');
  const body = stripComments(raw);
  const first = raw.split('\n')[0];
  if (first === '#!/bin/sh') ok(`${rel}: shebang #!/bin/sh`);
  else bad(`${rel}: shebang 必须是 #!/bin/sh（实际：${first}）`);
  for (const [re, desc] of BASH_ONLY) if (re.test(body)) bad(`${rel}: 含 bash-only 构造 ${desc}`);
  ok(`${rel}: 无 bash-only 构造（去注释后扫描）`);
  const r = spawnSync('dash', ['-n', p], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') ok(`${rel}: 本机无 dash，跳过 dash -n（CI 上必须跑）`);
  else if (r.status !== 0) bad(`${rel}: dash -n 失败：${(r.stderr || '').trim()}`);
  else ok(`${rel}: dash -n 通过`);
}

// bootstrap 的 node 静态校验必须可缺省（容器内无 node），且跳过必须显式
const boot = readFileSync(ROOT + 'infra/db/bootstrap.sh', 'utf8');
if (!/command -v node/.test(boot))
  bad('bootstrap.sh: node 静态校验未加 command -v node 守卫（容器内会 node: not found）');
else ok('bootstrap.sh: node 静态校验有 command -v node 守卫');
if (!/无 node|跳过静态校验/.test(boot))
  bad('bootstrap.sh: 无 node 时缺少显式跳过说明（禁止静默跳过）');
else ok('bootstrap.sh: 无 node 时显式声明跳过（不伪装通过）');

// compose db-migrate 必须用 sh 调两脚本，不得调 bash
if (!existsSync(ROOT + COMPOSE)) bad(`${COMPOSE} 不存在`);
else {
  const y = readFileSync(ROOT + COMPOSE, 'utf8');
  const block = (y.match(/^ {2}db-migrate:\n([\s\S]*?)(?=^ {2}[a-zA-Z])/m) || [])[1] || '';
  if (!/image:\s*postgres:16/.test(block))
    bad('compose db-migrate: 期望 image postgres:16（psql/pg_dump 所在）');
  else ok('compose db-migrate: image postgres:16');
  if (!/sh infra\/db\/bootstrap\.sh/.test(block))
    bad('compose db-migrate: bootstrap.sh 未用 sh 调用');
  else ok('compose db-migrate: bootstrap.sh 用 sh 调用');
  if (!/sh infra\/scripts\/db-migrate\.sh/.test(block))
    bad('compose db-migrate: db-migrate.sh 未用 sh 调用');
  else ok('compose db-migrate: db-migrate.sh 用 sh 调用');
  if (/\bbash\s+infra\//.test(block)) bad('compose db-migrate: 仍调用 bash（postgres:16 无 bash）');
  else ok('compose db-migrate: 无 bash 调用');
}

if (failures.length) {
  console.error('❌ POSIX 容器兼容检查失败：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(
  `✅ POSIX 容器兼容检查通过：${checks.length} 项（脚本 shebang/bash-only/dash -n、node 守卫、compose sh 调用）`,
);
