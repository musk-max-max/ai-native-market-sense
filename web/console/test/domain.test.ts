import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UnresolvedConflictsError,
  applyMergeResolutions,
  conflictRows,
  diffValues,
  summarizeDiff,
  threeWayMerge,
} from '../src/domain/diff';
import {
  InvalidTransitionError,
  assertTransition,
  canTransition,
  checkPublishGate,
} from '../src/domain/state-machine';
import { findConfigItem, configurableItems, assertConfigurable, LockedConfigError } from '../src/domain/registry';
import { hasBlockingIssues, validateValues } from '../src/domain/validation';
import type { Actor, ReleaseAuthorization } from '../src/domain/types';

const human: Actor = { kind: 'human', id: 'H2' };
const agent: Actor = { kind: 'agent', id: 'A15', modelVersion: 'sensenova-6.8-flash', runId: 'run-1' };
const banner = findConfigItem('ops.home-banner');
if (!banner) throw new Error('ops.home-banner 未注册');

const humanAuthorization: ReleaseAuthorization = {
  kind: 'human_approval',
  approvalRef: 'console/cr-1',
  approver: human,
  changeRequestId: 'cr-1',
};

test('两点 diff：新增/修改/移除/未变四类', () => {
  const feed = findConfigItem('ops.home-feed');
  if (!feed) throw new Error('ops.home-feed 未注册');
  const before = { rank_strategy: '均衡', page_size: 20, pinned_count: 2 };
  const after = { rank_strategy: '热度优先', page_size: 20, pinned_count: 3 };
  const rows = diffValues(feed.fields, before, after);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.equal(byKey.get('rank_strategy')?.kind, 'changed');
  assert.equal(byKey.get('page_size')?.kind, 'unchanged');
  assert.equal(byKey.get('pinned_count')?.kind, 'changed');

  const added = diffValues(feed.fields, {}, { page_size: 20 });
  assert.equal(added.find((row) => row.key === 'page_size')?.kind, 'added');

  const removed = diffValues(feed.fields, { page_size: 20 }, {});
  assert.equal(removed.find((row) => row.key === 'page_size')?.kind, 'removed');

  const summary = summarizeDiff(rows);
  assert.equal(summary.changed, 2);
  assert.equal(summary.unchanged, feed.fields.length - 2);
});

test('三点合并：仅我改/仅对方改/双方同值/冲突', () => {
  const feed = findConfigItem('ops.home-feed');
  if (!feed) throw new Error('ops.home-feed 未注册');
  const base = { rank_strategy: '均衡', page_size: 20, pinned_count: 2, enable_quick_watchlist: true };
  const mine = { rank_strategy: '热度优先', page_size: 20, pinned_count: 3, enable_quick_watchlist: false };
  const theirs = { rank_strategy: '时效优先', page_size: 30, pinned_count: 3, enable_quick_watchlist: true };
  const rows = threeWayMerge(feed.fields, base, mine, theirs);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.equal(byKey.get('rank_strategy')?.resolution, 'conflict');
  assert.equal(byKey.get('page_size')?.resolution, 'theirs');
  assert.equal(byKey.get('pinned_count')?.resolution, 'same-change');
  assert.equal(byKey.get('enable_quick_watchlist')?.resolution, 'mine');

  const conflicts = conflictRows(rows);
  assert.deepEqual(
    conflicts.map((row) => row.key),
    ['rank_strategy'],
  );

  assert.throws(
    () => applyMergeResolutions(rows, {}, mine),
    (error: unknown) => error instanceof UnresolvedConflictsError && error.keys[0] === 'rank_strategy',
  );

  const merged = applyMergeResolutions(rows, { rank_strategy: 'theirs' }, mine);
  assert.equal(merged['rank_strategy'], '时效优先');
  assert.equal(merged['page_size'], 30);
  assert.equal(merged['pinned_count'], 3);
});

test('状态机：不能跳步（draft → pending_approval 必须经过 validated）', () => {
  assert.equal(canTransition('draft', 'validated'), true);
  assert.equal(canTransition('draft', 'pending_approval'), false);
  assert.equal(canTransition('validated', 'pending_approval'), true);
  assert.equal(canTransition('approved', 'published'), true);
  assert.equal(canTransition('published', 'rolled_back'), true);

  assert.throws(
    () => assertTransition('draft', 'published'),
    (error: unknown) => error instanceof InvalidTransitionError,
  );
});

test('发布门禁：必须 approved + diff 已确认 + 授权合法', () => {
  assert.equal(
    checkPublishGate({
      state: 'pending_approval',
      level: 'C3',
      authorization: humanAuthorization,
      diffAcknowledged: true,
      actor: human,
    }).ok,
    false,
  );

  assert.equal(
    checkPublishGate({
      state: 'approved',
      level: 'C3',
      authorization: humanAuthorization,
      diffAcknowledged: false,
      actor: human,
    }).ok,
    false,
  );

  assert.equal(
    checkPublishGate({
      state: 'approved',
      level: 'C3',
      authorization: { ...humanAuthorization, approver: agent },
      diffAcknowledged: true,
      actor: human,
    }).ok,
    false,
  );

  assert.equal(
    checkPublishGate({
      state: 'approved',
      level: 'C3',
      authorization: humanAuthorization,
      diffAcknowledged: true,
      actor: human,
    }).ok,
    true,
  );

  // 规则引擎自动放行只允许 C0/C1，且发布动作由 agent（规则引擎）发起。
  const autoAuthorization: ReleaseAuthorization = {
    kind: 'rule_engine_auto',
    ruleVersion: 'rules-v1',
    engine: agent,
    changeRequestId: 'cr-2',
  };
  assert.equal(
    checkPublishGate({
      state: 'approved',
      level: 'C3',
      authorization: autoAuthorization,
      diffAcknowledged: true,
      actor: agent,
    }).ok,
    false,
  );
  assert.equal(
    checkPublishGate({
      state: 'approved',
      level: 'C1',
      authorization: autoAuthorization,
      diffAcknowledged: true,
      actor: agent,
    }).ok,
    true,
  );
});

test('校验：必填、链接前缀、时间窗口、阈值关系', () => {
  const issues = validateValues(banner, {
    title: '',
    link_url: 'javascript:alert(1)',
    enabled: true,
    start_at: '2026-12-31T00:00:00Z',
    end_at: '2026-01-01T00:00:00Z',
  });
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes('required'));
  assert.ok(codes.includes('prefix'));
  assert.ok(codes.includes('window'));
  assert.equal(hasBlockingIssues(issues), true);

  const sentiment = findConfigItem('market.sentiment-thresholds');
  if (!sentiment) throw new Error('market.sentiment-thresholds 未注册');
  const thresholdIssues = validateValues(sentiment, {
    hot_threshold: 20,
    cold_threshold: 20,
    sample_window: 20,
  });
  assert.ok(thresholdIssues.some((issue) => issue.code === 'threshold'));
});

test('注册表：锁定项永远不在可配置列表，适配层二次拒绝', () => {
  const ids = configurableItems().map((item) => item.id);
  assert.ok(!ids.includes('compliance.disclaimer'));
  assert.ok(ids.includes('ops.home-banner'));

  assert.throws(
    () => assertConfigurable('compliance.disclaimer'),
    (error: unknown) => error instanceof LockedConfigError && error.itemId === 'compliance.disclaimer',
  );
});
