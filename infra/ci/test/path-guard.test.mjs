/**
 * path guard 核心语义测试（写域边界是硬约束，必须有回归测试）。
 * 覆盖：最长前缀、default-deny、actor 越界、删除文件、注册表校验。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyChanges,
  matchEntry,
  parseRosterAgents,
  validateRegistry,
  validateRosterConsistency,
} from '../path-guard.mjs';

const registry = {
  unmatchedPolicy: 'deny',
  paths: [
    { path: 'infra/', owner: 'A13', reviewers: ['H5'], forbidden: ['*'] },
    { path: 'docs/', owner: 'A0', reviewers: ['H2'], forbidden: ['*'] },
    { path: 'docs/runbook/', owner: 'A13', reviewers: ['H5'], forbidden: ['*'] },
    { path: 'contracts/', owner: 'A0', reviewers: ['H2'], forbidden: ['*'] },
  ],
  rootFiles: [{ path: 'package.json', owner: 'A13', reviewers: ['H5'] }],
};

test('最长前缀优先', () => {
  assert.equal(matchEntry('docs/runbook/a.md', registry).owner, 'A13');
  assert.equal(matchEntry('docs/adr/x.md', registry).owner, 'A0');
  assert.equal(matchEntry('infra/terraform/main.tf', registry).owner, 'A13');
  assert.equal(matchEntry('package.json', registry).owner, 'A13');
});

test('default-deny：未登记路径违规', () => {
  const result = classifyChanges(['scripts/deploy.sh'], registry, { actor: 'A13' });
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].code, 'UNMATCHED');
});

test('actor 越界写被拒', () => {
  const result = classifyChanges(['contracts/market/openapi.yaml'], registry, { actor: 'A13' });
  assert.equal(result.violations[0].code, 'OUT_OF_SCOPE');
  assert.equal(result.violations[0].owner, 'A0');
});

test('未识别 actor 时只做覆盖检查（不误伤本地/机器人）', () => {
  const result = classifyChanges(['infra/terraform/main.tf'], registry, {});
  assert.equal(result.violations.length, 0);
});

test('删除文件同样计入写域', () => {
  const result = classifyChanges(['docs/runbook/a.md'], registry, { actor: 'A0' });
  assert.equal(result.violations.length, 1);
});

test('agent 不能作为 reviewer', () => {
  const broken = {
    ...registry,
    paths: [{ path: 'x/', owner: 'A7', reviewers: ['A13'], forbidden: ['*'] }],
    rootFiles: [],
  };
  assert.ok(validateRegistry(broken).some((error) => error.includes('人类席位')));
});

test('未知主体被拒', () => {
  const broken = {
    ...registry,
    paths: [{ path: 'x/', owner: 'A99', reviewers: ['H5'], forbidden: ['*'] }],
    rootFiles: [],
  };
  assert.ok(validateRegistry(broken).some((error) => error.includes('已知主体')));
});

test('重复登记被拒', () => {
  const broken = {
    ...registry,
    paths: [
      { path: 'infra/', owner: 'A13', reviewers: ['H5'], forbidden: ['*'] },
      { path: 'infra/', owner: 'A13', reviewers: ['H5'], forbidden: ['*'] },
    ],
    rootFiles: [],
  };
  assert.ok(validateRegistry(broken).some((error) => error.includes('重复')));
});

test('roster 解析：id / write_scope / forbidden（块标量不干扰）', () => {
  const text = [
    'agents:',
    '  - id: A13',
    '    owns: ["infra/"]',
    '    permissions:',
    '      write_scope: ["infra/", ".github/workflows/"]',
    '      forbidden: ["生产发布不经 H5 确认"]',
    '    system_prompt: |',
    '      write_scope: ["should-not-be-parsed/"]',
    '  - id: A7',
    '    permissions:',
    '      write_scope: ["web/h5/"]',
    '      forbidden: ["contracts/"]',
  ].join('\n');
  const agents = parseRosterAgents(text);
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ['A13', 'A7'],
  );
  assert.deepEqual(agents[0].writeScope, ['infra/', '.github/workflows/']);
  assert.deepEqual(agents[0].forbidden, ['生产发布不经 H5 确认']);
});

test('roster 一致性：write_scope 必须被同 owner 的条目覆盖', () => {
  const agents = [{ id: 'A13', writeScope: ['infra/', '.github/workflows/'], forbidden: [] }];
  const okRegistry = {
    paths: [
      { path: 'infra/', owner: 'A13' },
      { path: '.github/workflows/', owner: 'A13' },
    ],
    reservedPaths: [],
  };
  assert.equal(validateRosterConsistency(agents, okRegistry).length, 0);

  const badRegistry = {
    paths: [
      { path: 'infra/', owner: 'A13' },
      { path: '.github/workflows/', owner: 'A0' },
    ],
    reservedPaths: [],
  };
  const errors = validateRosterConsistency(agents, badRegistry);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A13 write_scope "\.github\/workflows\/"/);
  assert.match(errors[0], /owner=A13/);
});

test('roster 一致性：forbidden 不得与自有 ownership 条目同路径', () => {
  const agents = [{ id: 'A7', writeScope: ['web/h5/'], forbidden: ['web/h5/'] }];
  const registry = { paths: [{ path: 'web/h5/', owner: 'A7' }], reservedPaths: [] };
  const errors = validateRosterConsistency(agents, registry);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /自相矛盾/);
});

test('roster 一致性：reserved_paths 也计入覆盖（P2/P3 预登记）', () => {
  const agents = [{ id: 'A15', writeScope: ['approvals/'], forbidden: [] }];
  const registry = {
    paths: [],
    reservedPaths: [{ path: 'approvals/', owner: 'A15' }],
  };
  assert.equal(validateRosterConsistency(agents, registry).length, 0);
});

test('roster 一致性：owns 里形如 x/ 的 token 必须被 ownership 覆盖（L6 条件 d 第三条）', () => {
  const agents = [
    { id: 'A13', writeScope: ['infra/'], forbidden: [], owns: ['infra/', 'ops/runbooks/'] },
  ];
  const errors = validateRosterConsistency(agents, registry);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A13 owns "ops\/runbooks\/"/);
});
