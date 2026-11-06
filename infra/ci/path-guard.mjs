/**
 * market-sense-h5 · ownership path guard
 *
 * 目的：在 CI 里把 ownership.yaml 从「文档」变成「可执行的写域边界」。
 * 语义（与 ownership.yaml notes.unmatched_paths 一致）：
 *   1. 最长前缀优先：目录项（以 / 结尾）按前缀匹配，文件项按全等匹配。
 *   2. default-deny：未命中任何目录项/根文件白名单的路径 → 违规（UNMATCHED）。
 *   3. actor 强制：若能确定操作者（--actor 或分支名 `<agent>/<slug>`），
 *      则任一变更文件的 owner 必须等于操作者，否则 OUT_OF_SCOPE。
 *   4. 删除文件也算写（--diff-filter=ACMRD），防止用删文件绕过门禁。
 *   5. 本脚本零依赖：不依赖 pnpm install / node_modules，必须在依赖安装前就能跑。
 *
 * 用法：
 *   node infra/ci/path-guard.mjs --validate-registry        # 只校验注册表自身
 *   node infra/ci/path-guard.mjs --base <sha> --head <sha>  # CI 模式（git diff）
 *   node infra/ci/path-guard.mjs --all-tracked              # 首次推送（无 base）
 *   node infra/ci/path-guard.mjs --files a.tf b.md --actor A8
 *   node infra/ci/path-guard.mjs --self-test               # 内置用例自检
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './lib/mini-yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  repo: process.cwd(),
  ownershipFile: 'ownership.yaml',
  allowlistFile: 'infra/ci/root-toolchain.allowlist.yaml',
  rosterFile: 'agents/roster.yaml',
  humanSeats: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'],
};

function parseArgs(argv) {
  const args = {
    files: [],
    actor: null,
    base: null,
    head: 'HEAD',
    allTracked: false,
    selfTest: false,
    validateRegistry: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--repo':
        args.repo = argv[++i];
        break;
      case '--base':
        args.base = argv[++i];
        break;
      case '--head':
        args.head = argv[++i];
        break;
      case '--files': {
        let next = argv[++i];
        while (next && !next.startsWith('--')) {
          args.files.push(next);
          next = argv[++i];
        }
        i -= 1;
        break;
      }
      case '--actor':
        args.actor = argv[++i];
        break;
      case '--all-tracked':
        args.allTracked = true;
        break;
      case '--self-test':
        args.selfTest = true;
        break;
      case '--validate-registry':
        args.validateRegistry = true;
        break;
      case '--roster':
        args.roster = argv[++i];
        break;
      case '--skip-roster-consistency':
        args.skipRosterConsistency = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        console.log('见文件头注释：node infra/ci/path-guard.mjs --help');
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  return args;
}

// 已知主体 = 「可被注册表引用」的全集。刻意比现役 17 席宽：
// 重映射是渐进过程（ownership.yaml / roster.yaml / allowlist 分批改），
// 旧 id 留在注册表里只能告警、不能把 CI 判红（否则 L0 每次重映射都会误红）。
// lead 与 L0 是同一席位的旧名/现役名（roster.yaml `- id: L0, codename: lead`），
// 两个写法都要认；比较时用 seatKey() 归一。
const KNOWN_PRINCIPALS = [
  'lead',
  'L0',
  ...Array.from({ length: 24 }, (_, i) => `A${i}`), // A0–A23：含旧编制存量
  'M1', // 17 席新增：多模态设计（MiMo）
  ...DEFAULTS.humanSeats,
];

/** 同席别名归一：lead ≡ L0（旧名/现役名）。其余主体按小写全等比较。 */
export function seatKey(id) {
  const text = String(id ?? '')
    .trim()
    .toLowerCase();
  return text === 'lead' || text === 'l0' ? 'l0' : text;
}

// 现役 17 席（docs/HANDOFF-team-rebuild-2026-11-06.md）：L0 + H1–H4 + M1 + A1–A11。
// 旧 id A0/A12–A23/H5/H6 已撤销；检测到残留只告警（见 findRetiredSeatUsage）。
const CURRENT_AGENT_SEATS = ['M1', ...Array.from({ length: 11 }, (_, i) => `A${i + 1}`)];
const CURRENT_HUMAN_SEATS = ['H1', 'H2', 'H3', 'H4'];

export function isHumanSeat(id) {
  return DEFAULTS.humanSeats.includes(id);
}

export function normalizeActingId(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const seat = text.match(/^(H[1-6])$/i);
  if (seat) return seat[1].toUpperCase();
  const agent = text.match(/^(A\d{1,2})$/i);
  if (agent) return agent[1].toUpperCase();
  const multi = text.match(/^(M\d{1,2})$/i);
  if (multi) return multi[1].toUpperCase();
  if (/^lead$/i.test(text)) return 'lead';
  if (/^L0$/i.test(text)) return 'L0';
  return null;
}

/**
 * 旧席 id 残留检测（只告警不判红）：重映射后应为空。
 * 返回 [{ id, paths }]，用于 --validate-registry 输出提醒 L0 清理。
 */
export function findRetiredSeatUsage(registry) {
  const active = new Set(['lead', 'L0', ...CURRENT_AGENT_SEATS, ...CURRENT_HUMAN_SEATS]);
  const usage = new Map();
  const record = (id, path) => {
    if (!id || active.has(id)) return;
    if (!usage.has(id)) usage.set(id, []);
    usage.get(id).push(path);
  };
  for (const entry of [...registry.paths, ...registry.rootFiles]) {
    record(entry.owner, entry.path);
    for (const reviewer of entry.reviewers ?? []) record(reviewer, entry.path);
  }
  return [...usage.entries()].map(([id, paths]) => ({ id, paths }));
}

/** 从分支名推导操作者：`a8/ci-skeleton` → A8、`m1/design-token` → M1；无法推导 → null（降级为仅覆盖检查）。 */
export function actorFromBranch(branch) {
  if (!branch) return null;
  const first = String(branch).split('/')[0];
  return normalizeActingId(first);
}

function normalizePath(value) {
  return String(value).replace(/^\.\//, '').replace(/^\/+/, '');
}

function isDirEntry(entry) {
  return entry.path.endsWith('/');
}

/** 最长前缀匹配；无命中返回 null。 */
export function matchEntry(file, registry) {
  let best = null;
  for (const entry of registry.paths) {
    const p = entry.path;
    const hits = isDirEntry(entry) ? file === p.slice(0, -1) || file.startsWith(p) : file === p;
    if (!hits) continue;
    if (!best || p.length > best.path.length) best = entry;
  }
  for (const entry of registry.rootFiles) {
    if (file === entry.path && (!best || entry.path.length > best.path.length)) best = entry;
  }
  return best;
}

/**
 * 读取 roster.yaml 的 agent 写域（H2 L6 条件 d）。
 *
 * 为什么不用 mini-yaml 整文件解析：roster 的 system_prompt 是块标量（|），
 * 而 mini-yaml 明确只支持 YAML 子集（不支持块标量），也不该为了一个一致性检查
 * 去扩大零依赖解析器的攻击面。这里只抓 agents: 段内的 id / write_scope / forbidden，
 * 值本身仍是 flow 数组，复用同一解析器。
 */
export function parseRosterAgents(text) {
  const lines = String(text).split(/\r?\n/);
  const agents = [];
  let inAgents = false;
  let current = null;
  const flowValue = (raw) => {
    const cleaned = raw.replace(/\s+#.*$/, '').trim();
    const parsed = parseYaml(`__v: ${cleaned}`);
    const value = parsed?.__v;
    if (!Array.isArray(value)) throw new Error(`roster 写域必须是 flow 数组：${raw}`);
    return value.map((item) => normalizePath(String(item)));
  };
  // 跳过块标量（system_prompt: |）：其正文里可能出现 write_scope 字样的说明文字，
  // 不能把说明当配置。按缩进判定块范围。
  let blockIndent = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (blockIndent !== null) {
      if (line.trim() === '') continue;
      const indent = line.length - line.trimStart().length;
      if (indent > blockIndent) continue;
      blockIndent = null;
    }
    const blockStart = /^(\s*)[A-Za-z_][\w]*:\s*[|>][-+]?\s*$/.exec(line);
    if (blockStart) {
      blockIndent = blockStart[1].length;
      continue;
    }
    if (/^agents:\s*$/.test(line)) {
      inAgents = true;
      continue;
    }
    if (!inAgents) continue;
    const agentMatch = /^\s{2}- id:\s*([AML]\d{1,2})\s*$/.exec(line);
    if (agentMatch) {
      current = { id: agentMatch[1], writeScope: [], forbidden: [], owns: [] };
      agents.push(current);
      continue;
    }
    if (!current) continue;
    const scopeMatch = /^\s{4,}write_scope:\s*(\[.*\])\s*$/.exec(line);
    if (scopeMatch) {
      current.writeScope = flowValue(scopeMatch[1]);
      continue;
    }
    const forbiddenMatch = /^\s{4,}forbidden:\s*(\[.*\])\s*$/.exec(line);
    if (forbiddenMatch) current.forbidden = flowValue(forbiddenMatch[1]);

    // L6 条件 d 第三条：owns 里形如 `x/` 的 token 也必须被 ownership 覆盖。
    // 否则 roster 里删了/改了 owns，ownership 不跟随，CI 仍然绿（与 write_scope 同一类漂移）。
    const ownsMatch = /^\s{4,}owns:\s*(\[.*\])\s*$/.exec(line);
    if (ownsMatch) current.owns = flowValue(ownsMatch[1]);
  }
  return agents;
}

/** 目录项语义的路径前缀（保证按路径边界匹配，不误伤 services/api-client 之类）。 */
function pathPrefixCovers(entryPath, scope) {
  if (entryPath === scope) return true;
  if (entryPath.endsWith('/')) return scope.startsWith(entryPath);
  return scope === entryPath || scope.startsWith(`${entryPath}/`);
}

/**
 * H2 L6 条件 d：roster.yaml 与 ownership.yaml 的一致性不变式（纯函数）。
 *   1. 每个 agent 的 write_scope 前缀必须被「owner 相同」的 ownership 条目覆盖；
 *   2. agent 的 forbidden 不得与其在 ownership 中拥有的路径同一（自相矛盾）。
 * 返回 errors 数组（空数组 = 一致）。
 */
export function validateRosterConsistency(rosterAgents, registry) {
  const errors = [];
  const ownershipEntries = [...registry.paths, ...(registry.reservedPaths ?? [])];
  const knownAgents = new Set(rosterAgents.map((agent) => agent.id));
  if (knownAgents.size === 0) errors.push('roster.yaml 没有解析到任何 agent（agents: 段缺失？）');
  for (const agent of rosterAgents) {
    for (const scope of agent.writeScope) {
      const covered = ownershipEntries.some(
        (entry) => entry.owner === agent.id && pathPrefixCovers(entry.path, scope),
      );
      if (!covered) {
        errors.push(
          `[roster-无覆盖] ${agent.id} write_scope "${scope}" 在 ownership.yaml 中找不到 owner=${agent.id} 的条目覆盖`,
        );
      }
    }
    for (const own of agent.owns ?? []) {
      if (!own.endsWith('/')) continue;
      const covered = ownershipEntries.some(
        (entry) => entry.owner === agent.id && pathPrefixCovers(entry.path, own),
      );
      if (!covered) {
        errors.push(
          `[roster-owns-无覆盖] ${agent.id} owns "${own}" 在 ownership.yaml 中找不到 owner=${agent.id} 的条目覆盖`,
        );
      }
    }

    for (const forbidden of agent.forbidden) {
      const looksLikePath = forbidden.includes('/');
      if (!looksLikePath) continue;
      const clash = ownershipEntries.some(
        (entry) => entry.owner === agent.id && pathPrefixCovers(entry.path, forbidden),
      );
      if (clash) {
        errors.push(
          `[roster-自相矛盾] ${agent.id} forbidden 含 "${forbidden}"，但 ownership.yaml 把该路径登记给 ${agent.id}`,
        );
      }
    }
  }
  return errors;
}

export function validateRegistry(registry) {
  const errors = [];
  const seen = new Set();
  const allEntries = [...registry.paths, ...registry.rootFiles];
  for (const entry of allEntries) {
    const label = entry.path;
    if (!entry.path) {
      errors.push(`注册表存在空 path 条目（${JSON.stringify(entry)}）`);
      continue;
    }
    if (seen.has(entry.path)) errors.push(`重复登记 path: ${label}`);
    seen.add(entry.path);
    if (!KNOWN_PRINCIPALS.includes(entry.owner)) {
      errors.push(`${label}: owner "${entry.owner}" 不是已知主体（lead/L0 / M1 / A0–A23 / H1–H6）`);
    }
    if (!Array.isArray(entry.reviewers) || entry.reviewers.length === 0) {
      errors.push(`${label}: 缺少 reviewers（必须至少一个人类席位）`);
    } else {
      for (const reviewer of entry.reviewers) {
        if (!isHumanSeat(reviewer)) {
          errors.push(
            `${label}: reviewer "${reviewer}" 不是人类席位（agent 不能批准 agent，README §3）`,
          );
        }
      }
    }
    if (!Array.isArray(entry.forbidden) && !registry.rootFiles.includes(entry)) {
      errors.push(`${label}: forbidden 必须是数组`);
    }
  }
  for (const rootEntry of registry.rootFiles) {
    if (rootEntry.path.includes('/')) {
      errors.push(`根文件白名单只允许登记仓库根文件: ${rootEntry.path}`);
    }
    for (const dirEntry of registry.paths) {
      if (dirEntry.path.endsWith('/') && `${rootEntry.path}` === dirEntry.path.slice(0, -1)) {
        errors.push(`根文件与目录条目重复: ${rootEntry.path}`);
      }
    }
  }
  if (!['deny', 'warn'].includes(registry.unmatchedPolicy)) {
    errors.push(
      `notes.unmatched_paths 必须是 deny|warn；当前为 ${String(registry.unmatchedPolicy)}`,
    );
  }
  return errors;
}

/**
 * 纯函数核心：给定变更文件 + 注册表 + 操作者，返回违规列表。
 * @returns {{violations: Array<{file: string, code: string, owner?: string, detail: string}>, owners: Record<string, string[]>}}
 */
export function classifyChanges(changedFiles, registry, options = {}) {
  const actor = normalizeActingId(options.actor);
  const violations = [];
  const owners = {};
  for (const raw of changedFiles) {
    const file = normalizePath(raw);
    if (!file) continue;
    const entry = matchEntry(file, registry);
    if (!entry) {
      if (registry.unmatchedPolicy === 'deny') {
        violations.push({
          file,
          code: 'UNMATCHED',
          detail: '路径未在 ownership.yaml / 根文件白名单登记（default-deny）',
        });
      }
      continue;
    }
    owners[entry.owner] = owners[entry.owner] ?? [];
    owners[entry.owner].push(file);
    if (actor && seatKey(entry.owner) !== seatKey(actor)) {
      violations.push({
        file,
        code: 'OUT_OF_SCOPE',
        owner: entry.owner,
        detail: `操作者 ${actor} 不是该路径 owner（owner=${entry.owner}）`,
      });
    }
  }
  return { violations, owners, actor };
}

function loadRegistry(repo) {
  const ownershipPath = join(repo, DEFAULTS.ownershipFile);
  const allowlistPath = join(repo, DEFAULTS.allowlistFile);
  const ownership = parseYaml(readFileSync(ownershipPath, 'utf8'));
  if (!ownership || typeof ownership !== 'object')
    throw new Error(`${DEFAULTS.ownershipFile} 解析结果不是对象`);
  if (!Array.isArray(ownership.paths)) throw new Error(`${DEFAULTS.ownershipFile} 缺少 paths 数组`);
  const allowlist = parseYaml(readFileSync(allowlistPath, 'utf8'));
  const rootFiles = Array.isArray(allowlist?.entries) ? allowlist.entries : [];
  return {
    paths: ownership.paths,
    rootFiles,
    reservedPaths: Array.isArray(ownership?.notes?.reserved_paths)
      ? ownership.notes.reserved_paths
      : [],
    unmatchedPolicy: ownership?.notes?.unmatched_paths ?? 'deny',
    ownership,
    allowlist,
  };
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function changedFilesFromGit(repo, args) {
  if (args.allTracked) {
    return git(repo, ['ls-files']).split('\n').filter(Boolean);
  }
  if (!args.base) throw new Error('需要 --base <sha> 或 --all-tracked（首次推送）');
  const range = `${args.base}...${args.head}`;
  const out = git(repo, ['diff', '--name-only', '--diff-filter=ACMRD', range]);
  return out.split('\n').filter(Boolean);
}

function syntheticRegistry() {
  return {
    unmatchedPolicy: 'deny',
    paths: [
      { path: 'infra/', owner: 'A13', reviewers: ['H5'], forbidden: ['*'] },
      { path: 'docs/', owner: 'A0', reviewers: ['H2'], forbidden: ['*'] },
      { path: 'docs/runbook/', owner: 'A13', reviewers: ['H5'], forbidden: ['*'] },
      { path: 'contracts/', owner: 'A0', reviewers: ['H2'], forbidden: ['*'] },
      { path: 'agents/', owner: 'lead', reviewers: ['H1'], forbidden: ['*'] },
    ],
    rootFiles: [
      { path: 'package.json', owner: 'A13', reviewers: ['H5'], note: 'toolchain' },
      { path: 'ownership.yaml', owner: 'A0', reviewers: ['H2'], note: 'registry' },
    ],
  };
}

export function runSelfTest() {
  const registry = syntheticRegistry();
  const cases = [];
  const check = (name, condition) => cases.push({ name, ok: Boolean(condition) });

  check('目录前缀命中', matchEntry('infra/terraform/main.tf', registry)?.owner === 'A13');
  check('最长前缀优先', matchEntry('docs/runbook/data.md', registry)?.owner === 'A13');
  check('父目录命中', matchEntry('docs/adr/ADR-001.md', registry)?.owner === 'A0');
  check('根文件白名单命中', matchEntry('package.json', registry)?.owner === 'A13');
  check('未登记路径不命中', matchEntry('scripts/deploy.sh', registry) === null);

  const inScope = classifyChanges(['infra/terraform/main.tf', 'docs/runbook/x.md'], registry, {
    actor: 'A13',
  });
  check('in-scope 无违规', inScope.violations.length === 0);

  const outOfScope = classifyChanges(['contracts/market/openapi.yaml'], registry, { actor: 'A13' });
  check(
    '越界写判 OUT_OF_SCOPE',
    outOfScope.violations.some((v) => v.code === 'OUT_OF_SCOPE'),
  );

  const unmatched = classifyChanges(['scripts/hack.sh'], registry, { actor: 'A13' });
  check(
    '未登记路径判 UNMATCHED',
    unmatched.violations.some((v) => v.code === 'UNMATCHED'),
  );

  const noActor = classifyChanges(['contracts/market/openapi.yaml'], registry, {});
  check('无 actor 时只做覆盖检查（不误伤）', noActor.violations.length === 0);

  const deletion = classifyChanges(['contracts/market/openapi.yaml'], registry, { actor: 'A13' });
  check('删除/修改文件同样受约束', deletion.violations.length === 1);

  const registryErrors = validateRegistry(registry);
  check('合成注册表自身合法', registryErrors.length === 0);

  check(
    'agent 不能做 reviewer',
    validateRegistry({
      ...registry,
      paths: [{ path: 'x/', owner: 'A7', reviewers: ['A13'], forbidden: ['*'] }],
      rootFiles: [],
    }).length > 0,
  );

  check(
    '未知主体被拒',
    validateRegistry({
      ...registry,
      paths: [{ path: 'x/', owner: 'A99', reviewers: ['H5'], forbidden: ['*'] }],
      rootFiles: [],
    }).length > 0,
  );

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${cases.length} 自检失败`);
    process.exitCode = 1;
  } else {
    console.log(`\n全部 ${cases.length} 项自检通过`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }
  const repo = resolve(args.repo ?? DEFAULTS.repo);
  const registry = loadRegistry(repo);
  const registryErrors = validateRegistry(registry);
  if (registryErrors.length > 0) {
    console.error('注册表自身不合法：');
    for (const err of registryErrors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }
  if (args.validateRegistry) {
    const rosterPath = join(repo, args.roster ?? DEFAULTS.rosterFile);
    let rosterAgents = [];
    if (!args.skipRosterConsistency) {
      try {
        rosterAgents = parseRosterAgents(readFileSync(rosterPath, 'utf8'));
      } catch (err) {
        console.error(`无法读取/解析 roster（${rosterPath}）：${err.message}`);
        process.exitCode = 1;
        return;
      }
      const rosterErrors = validateRosterConsistency(rosterAgents, registry);
      if (rosterErrors.length > 0) {
        console.error('roster.yaml 与 ownership.yaml 不一致（H2 L6 条件 d）：');
        for (const err of rosterErrors) console.error(`  - ${err}`);
        console.error('\n处置：改 roster（lead 写域）或 ownership.yaml（A0 写域），改一份不够。');
        process.exitCode = 1;
        return;
      }
    }
    console.log(
      `注册表合法：目录项 ${registry.paths.length} 个，根文件 ${registry.rootFiles.length} 个，default-policy=${registry.unmatchedPolicy}`,
    );
    if (!args.skipRosterConsistency) {
      console.log(
        `roster 一致性：${rosterAgents.length} 个 agent 的 write_scope/forbidden/owns 与 ownership 一致`,
      );
    }
    return;
  }
  const actor =
    normalizeActingId(args.actor) ??
    actorFromBranch(process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME);
  const files = args.files.length > 0 ? args.files : changedFilesFromGit(repo, args);
  const { violations, owners } = classifyChanges(files, registry, { actor });
  const ownerSummary = Object.entries(owners)
    .map(([owner, list]) => `  ${owner}: ${list.length} 个文件`)
    .join('\n');
  if (args.json) {
    console.log(
      JSON.stringify({ actor: actor ?? null, checked: files.length, owners, violations }, null, 2),
    );
  } else {
    console.log(`path guard：检查 ${files.length} 个变更文件`);
    if (!actor)
      console.log(
        '  ⚠ 未识别操作者（分支名不是 <agent>/<slug> 且未传 --actor）：只做覆盖检查，不做 owner 校验',
      );
    if (ownerSummary) console.log(ownerSummary);
    if (violations.length === 0) {
      console.log('✅ 全部变更落在登记写域内');
    } else {
      console.error(`\n❌ ${violations.length} 处写域违规：`);
      for (const v of violations) console.error(`  - [${v.code}] ${v.file}：${v.detail}`);
      console.error(
        '\n处置：改到自己的写域，或先由 A0 在 ownership.yaml 登记（reviewer 含 H2）。禁止绕过。',
      );
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

// 本地调试用：node infra/ci/path-guard.mjs --repo . --files ...
export { HERE };
