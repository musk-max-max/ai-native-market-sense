/**
 * mini-yaml 解析器测试：它必须足够可靠，因为 path guard / 告警门禁都依赖它，
 * 且运行在 pnpm install 之前（零依赖）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../lib/mini-yaml.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('解析块映射、嵌套与注释', () => {
  const doc = parseYaml(`
# 顶层注释
schema_version: '0.1'
owner: A13
paths:
  - path: infra/
    owner: A13
    reviewers: [H5]
  - path: contracts/
    owner: A0
    forbidden: ['*']
notes:
  unmatched_paths: deny   # 行尾注释
`);
  assert.equal(doc.schema_version, '0.1');
  assert.equal(doc.owner, 'A13');
  assert.equal(doc.paths.length, 2);
  assert.deepEqual(doc.paths[0].reviewers, ['H5']);
  assert.deepEqual(doc.paths[1].forbidden, ['*']);
  assert.equal(doc.notes.unmatched_paths, 'deny');
});

test('数字/布尔/null 与引号', () => {
  const doc = parseYaml(`
n: 42
f: 1.5
yes: true
no: false
nothing: null
quoted: "a: b # not comment"
single: 'it''s ok'
`);
  assert.equal(doc.n, 42);
  assert.equal(doc.f, 1.5);
  assert.equal(doc.yes, true);
  assert.equal(doc.no, false);
  assert.equal(doc.nothing, null);
  assert.equal(doc.quoted, 'a: b # not comment');
  assert.equal(doc.single, "it's ok");
});

test('flow 映射与空数组', () => {
  const doc = parseYaml('labels: {severity: critical, team: sre}\nempty: []\n');
  assert.equal(doc.labels.severity, 'critical');
  assert.equal(doc.labels.team, 'sre');
  assert.deepEqual(doc.empty, []);
});

test('URL 中的 # 不是注释', () => {
  const doc = parseYaml(`url: https://github.com/o/r/blob/main/docs/runbook/a.md#止血\n`);
  assert.equal(doc.url, 'https://github.com/o/r/blob/main/docs/runbook/a.md#止血');
});

test('拒绝 tab 缩进（YAML 规范）', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tab/i);
});

test('拒绝块标量（显式报错而不是静默解析错）', () => {
  assert.throws(() => parseYaml('desc: |\n  line1\n  line2\n'), /块标量|block/i);
});

test('能解析真实 ownership.yaml（路径表 + default-deny）', () => {
  const doc = parseYaml(readFileSync(join(ROOT, 'ownership.yaml'), 'utf8'));
  assert.equal(doc.schema_version, '0.1');
  assert.ok(
    doc.paths.length >= 26,
    `路径条目=${doc.paths.length}，应至少 26 条（随仓库增长只增不减）`,
  );
  assert.equal(
    new Set(doc.paths.map((p) => p.path)).size,
    doc.paths.length,
    'ownership 路径不得重复',
  );
  assert.equal(doc.notes.unmatched_paths, 'deny');
  const infra = doc.paths.find((entry) => entry.path === 'infra/');
  assert.equal(infra.owner, 'A8');
  assert.deepEqual(infra.reviewers, ['H4']);
});

test('能解析真实告警规则（57? 条 alert 全部带 runbook_url）', () => {
  const doc = parseYaml(
    readFileSync(join(ROOT, 'infra/monitoring/alerts/market-sense.rules.yaml'), 'utf8'),
  );
  const rules = doc.groups.flatMap((group) => group.rules);
  const alerts = rules.filter((rule) => rule.alert);
  assert.ok(alerts.length >= 18, `告警数应 >=18，实际 ${alerts.length}`);
  assert.ok(
    alerts.some((a) => a.alert === 'HostExposureDrift'),
    '缺少 HostExposureDrift',
  );
  for (const alert of alerts) {
    assert.ok(alert.annotations?.runbook_url, `${alert.alert} 缺少 runbook_url`);
  }
});
