#!/usr/bin/env node
// check-repo-hygiene.mjs —— 前向检查：待提交文件里出现秘密/状态/日志/超大文件即红。
// 目的不是替代 .gitignore，而是在秘密进入历史之前拦住（Lead m01563）。
// 覆盖：已 tracked（git ls-files --cached）与未 tracked 但会被提交的文件（--others --exclude-standard）。
// 无 .git 时显式 skip（S0 早期），不伪装通过。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseYaml } from './lib/mini-yaml.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWLIST_FILE =
  process.env.REPO_HYGIENE_ALLOWLIST ||
  path.join(repo, 'infra/ci/repo-hygiene.allowlist.yaml');
const APPROVERS = ['H4', 'H5', 'H1', 'H2']; // 入库例外只能由人类席位批，agent 不能自批

// 超限文件例外（H4 m02775）：只允许精确文件路径，必须「path + owner + 到期 + reason + 人类批准」。
// 到期即恢复红；禁止目录前缀/通配符，不允许一条豁免带出一片。
const ALLOWED_KEYS = new Set([
  'path',
  'sha256',
  'owner',
  'reason',
  'expires_at',
  'approved_by',
  'approval_ref',
]);
function loadAllowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return { entries: [], errors: [] };
  let doc;
  try {
    doc = parseYaml(readFileSync(ALLOWLIST_FILE, 'utf8'));
  } catch (err) {
    return { entries: [], errors: [`allowlist 解析失败：${err.message}`] };
  }
  const raw = Array.isArray(doc?.entries) ? doc.entries : [];
  const errors = [];
  const entries = [];
  for (const e of raw) {
    const where = e?.path ? `allowlist[${e.path}]` : 'allowlist[?]';
    for (const k of Object.keys(e || {})) {
      if (!ALLOWED_KEYS.has(k)) errors.push(`${where}: 未知字段 ${k}`);
    }
    if (!e?.path || typeof e.path !== 'string') {
      errors.push(`${where}: 缺 path`);
      continue;
    }
    if (e.path.includes('*') || e.path.endsWith('/')) {
      errors.push(`${where}: 只允许精确文件路径（禁止通配符/目录前缀）`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.expires_at || ''))) {
      errors.push(`${where}: expires_at 必须是 YYYY-MM-DD`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(String(e.sha256 || ''))) {
      errors.push(`${where}: sha256 必须是 64 位小写 hex（同一路径换内容豁免自动失效）`);
    }
    if (!e.owner || typeof e.owner !== 'string') errors.push(`${where}: 缺 owner`);
    if (!e.reason || typeof e.reason !== 'string') errors.push(`${where}: 缺 reason`);
    const approvedBy = String(e.approved_by || '')
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean);
    if (approvedBy.length === 0 || approvedBy.some((who) => !APPROVERS.includes(who))) {
      errors.push(`${where}: approved_by 必须是人类席位（${APPROVERS.join('/')}，多人用 / 分隔）`);
    }
    if (!e.approval_ref || typeof e.approval_ref !== 'string') errors.push(`${where}: 缺 approval_ref`);
    entries.push({ ...e });
  }
  return { entries, errors };
}

let failures = 0;
function fail(msg) {
  failures++;
  console.log(`❌ ${msg}`);
}

const { entries: allowlist, errors: allowlistErrors } = loadAllowlist();
const nowUtc = new Date();
const todayUtc = nowUtc.toISOString().slice(0, 10);
const WARN_DAYS = 5;
for (const e of allowlist) {
  const abs = path.join(repo, e.path);
  const daysLeft = Math.floor(
    (Date.parse(`${e.expires_at}T00:00:00Z`) - nowUtc.getTime()) / 86_400_000,
  );
  if (e.expires_at < todayUtc) {
    fail(`仓库卫生 allowlist 已过期：${e.path}（expires_at ${e.expires_at}）——续期需人类重新批准`);
  } else if (daysLeft <= WARN_DAYS) {
    console.log(
      `⚠️ 仓库卫生 allowlist 将在 ${daysLeft} 天到期：${e.path}（expires_at ${e.expires_at}）——需 H4/H5 复审签字，不自动续`,
    );
  }
  if (!existsSync(abs)) {
    console.log(`⏳ allowlist 条目指向的文件当前不存在（不豁免其它路径）：${e.path}`);
  } else {
    const actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
    if (actual !== String(e.sha256 || '')) {
      fail(
        `仓库卫生 allowlist 哈希不匹配：${e.path}（条目 ${e.sha256 || '缺'}，实算 ${actual}）——内容已变，豁免失效`,
      );
    }
  }
}
for (const err of allowlistErrors) fail(`仓库卫生 allowlist 非法：${err}`);
const FIXTURE_PREFIXES = ['tests/fixtures/', 'tests/e2e/fixtures/', 'data/golden/'];
const FORBIDDEN = [
  { name: '.env 文件', re: /(^|\/)\.env(\.|$)/ },
  { name: 'kubeconfig', re: /(^|\/)kubeconfig[^/]*$/i },
  { name: 'terraform state', re: /\.tfstate(\.backup)?$/ },
  { name: '日志文件', re: /\.log$/i },
  { name: '私钥/证书', re: /(^|\/)(id_rsa|id_ed25519|[^/]+\.pem)$/ },
  { name: 'PGDATA/.state', re: /(^|\/)\.state\// },
];

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
    const allow = allowlist.find((e) => e.path === rel && e.expires_at >= todayUtc);
    if (allow) {
      console.log(
        `✅ 超限文件已批准入库：${rel}（${(st.size / 1024 / 1024).toFixed(1)}MB，expires ${allow.expires_at}，${allow.approved_by} ${allow.approval_ref}）`,
      );
    } else {
      fail(`大于 2MB 的非 fixture 文件：${rel}（${(st.size / 1024 / 1024).toFixed(1)}MB）`);
    }
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
  `✅ 仓库卫生检查通过（检查 ${files.length} 个待提交文件；无 .env/tfstate/kubeconfig/.log/超大文件；allowlist ${allowlist.length} 条）`,
);
