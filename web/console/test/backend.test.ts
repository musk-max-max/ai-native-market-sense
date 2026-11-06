import test from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend } from '../src/mocks';
import { ApprovalAuthorityError, ConfigGateError } from '../src/mocks';
import { DEFAULT_VALUES } from '../src/domain/registry';
import type { Actor, ConfigValues, Release } from '../src/domain/types';

const NOW = () => '2026-11-06T10:00:00.000Z';
const humanApprover: Actor = { kind: 'human', id: 'H2' };
const agentRequester: Actor = { kind: 'agent', id: 'A15', modelVersion: 'sensenova-6.8-flash', runId: 'run-20261106-0912' };
const ruleEngine: Actor = { kind: 'agent', id: 'A15-rule', modelVersion: 'sensenova-6.8-flash', runId: 'run-rule' };

function bannerValues(patch: ConfigValues = {}): ConfigValues {
  const base = DEFAULT_VALUES['ops.home-banner'];
  if (!base) throw new Error('seed 缺失');
  return { ...base, ...patch };
}

function sentimentValues(patch: ConfigValues = {}): ConfigValues {
  const base = DEFAULT_VALUES['market.sentiment-thresholds'];
  if (!base) throw new Error('seed 缺失');
  return { ...base, ...patch };
}

async function toApprovedBanner(
  backend: MockBackend,
  requester: Actor = agentRequester,
  values: ConfigValues = bannerValues({ title: '收盘后 15 分钟：今日市场复盘直播' }),
): Promise<string> {
  const current = await backend.get('ops.home-banner');
  const saved = await backend.saveDraft({
    itemId: 'ops.home-banner',
    expectedVersion: current.publishedVersion,
    values,
    actor: requester,
  });
  assert.equal(saved.ok, true);
  const validated = await backend.validate('ops.home-banner', requester);
  assert.equal(validated.ok, true);
  const changeRequest = await backend.submitForApproval({
    itemId: 'ops.home-banner',
    actor: requester,
    diffAcknowledged: true,
  });
  return changeRequest.id;
}

test('完整链路：agent 发起 → 人类终审 → 发布（不可变 release + 审计可区分来源）', async () => {
  const backend = new MockBackend({ now: NOW });
  const crId = await toApprovedBanner(backend);

  assert.equal((await backend.listPending()).length, 1);

  await assert.rejects(
    () =>
      backend.approve({
        changeRequestId: crId,
        actor: agentRequester,
        approvalRef: 'console/agent',
        diffAcknowledged: true,
      }),
    (error: unknown) =>
      error instanceof ApprovalAuthorityError && error.code === 'AGENT_CANNOT_FINAL_APPROVE',
  );

  await assert.rejects(
    () =>
      backend.approve({
        changeRequestId: crId,
        actor: humanApprover,
        approvalRef: '   ',
        diffAcknowledged: true,
      }),
    (error: unknown) =>
      error instanceof ApprovalAuthorityError && error.code === 'APPROVAL_REF_REQUIRED',
  );

  await backend.approve({
    changeRequestId: crId,
    actor: humanApprover,
    approvalRef: `console/${crId}`,
    diffAcknowledged: true,
  });

  await assert.rejects(
    () =>
      backend.publish({
        itemId: 'ops.home-banner',
        changeRequestId: crId,
        actor: humanApprover,
        diffAcknowledged: false,
      }),
    (error: unknown) => error instanceof ConfigGateError && /diff/i.test(error.message),
  );

  const release = await backend.publish({
    itemId: 'ops.home-banner',
    changeRequestId: crId,
    actor: humanApprover,
    diffAcknowledged: true,
  });
  assert.equal(release.version, 2);
  assert.equal(release.authorization.kind, 'human_approval');

  const detail = await backend.get('ops.home-banner');
  assert.equal(detail.publishedVersion, 2);
  assert.equal(detail.draft, null);
  assert.equal(detail.releases.length, 2);

  const audit = await backend.listAudit();
  const actions = audit.map((event) => event.action);
  for (const expected of ['draft.saved', 'config.validated', 'approval.submitted', 'approval.approved', 'config.published']) {
    assert.ok(actions.includes(expected as never), `缺少审计动作 ${expected}`);
  }
  assert.ok(audit.some((event) => event.actor.kind === 'agent' && event.actor.modelVersion === 'sensenova-6.8-flash'));
  assert.ok(audit.some((event) => event.actor.kind === 'human' && event.actor.id === 'H2'));
});

test('提交审批：必须已校验 + 必须确认 diff（硬约束在前端与服务端双重校验）', async () => {
  const backend = new MockBackend({ now: NOW });
  const saved = await backend.saveDraft({
    itemId: 'ops.home-banner',
    expectedVersion: 1,
    values: bannerValues({ title: '未校验就提交' }),
    actor: agentRequester,
  });
  assert.equal(saved.ok, true);

  await assert.rejects(
    () =>
      backend.submitForApproval({
        itemId: 'ops.home-banner',
        actor: agentRequester,
        diffAcknowledged: true,
      }),
    (error: unknown) => error instanceof ConfigGateError && error.code === 'NOT_VALIDATED',
  );

  await backend.validate('ops.home-banner', agentRequester);

  await assert.rejects(
    () =>
      backend.submitForApproval({
        itemId: 'ops.home-banner',
        actor: agentRequester,
        diffAcknowledged: false,
      }),
    (error: unknown) => error instanceof ConfigGateError && error.code === 'DIFF_NOT_ACKNOWLEDGED',
  );
});

test('乐观锁 409：旧版本保存返回 base/mine/theirs 三点冲突', async () => {
  const backend = new MockBackend({ now: NOW });
  const crId = await toApprovedBanner(backend);
  await backend.approve({
    changeRequestId: crId,
    actor: humanApprover,
    approvalRef: `console/${crId}`,
    diffAcknowledged: true,
  });
  await backend.publish({
    itemId: 'ops.home-banner',
    changeRequestId: crId,
    actor: humanApprover,
    diffAcknowledged: true,
  });

  const stale = await backend.saveDraft({
    itemId: 'ops.home-banner',
    expectedVersion: 1,
    values: bannerValues({ title: '基于旧版本的草稿' }),
    actor: humanApprover,
  });
  assert.equal(stale.ok, false);
  if (stale.ok || stale.kind !== 'conflict') throw new Error('期望 409 冲突');
  assert.equal(stale.conflict.currentVersion, 2);
  assert.equal(stale.conflict.mine['title'], '基于旧版本的草稿');
  assert.equal(stale.conflict.theirs['title'], '收盘后 15 分钟：今日市场复盘直播');
  assert.equal(stale.conflict.base['title'], DEFAULT_VALUES['ops.home-banner']?.['title']);
});

test('锁定项 + 回滚 + 规则引擎自动放行边界', async () => {
  const backend = new MockBackend({ now: NOW });

  const locked = await backend.saveDraft({
    itemId: 'compliance.disclaimer',
    expectedVersion: 1,
    values: { text: '改免责声明' },
    actor: humanApprover,
  });
  assert.equal(locked.ok, false);
  if (locked.ok) throw new Error('锁定项不应可写');
  assert.equal(locked.kind, 'locked');

  // 先发布 v2，再回滚到 v1（回滚追加 v3，历史保留）。
  const crId = await toApprovedBanner(backend);
  await backend.approve({
    changeRequestId: crId,
    actor: humanApprover,
    approvalRef: `console/${crId}`,
    diffAcknowledged: true,
  });
  await backend.publish({
    itemId: 'ops.home-banner',
    changeRequestId: crId,
    actor: humanApprover,
    diffAcknowledged: true,
  });

  await assert.rejects(
    () =>
      backend.rollback({
        itemId: 'ops.home-banner',
        targetVersion: 1,
        actor: agentRequester,
        diffAcknowledged: true,
        reason: 'agent 想回滚',
      }),
    (error: unknown) => error instanceof ConfigGateError,
  );

  const rollback: Release = await backend.rollback({
    itemId: 'ops.home-banner',
    targetVersion: 1,
    actor: humanApprover,
    diffAcknowledged: true,
    reason: '文案有合规风险，先回滚',
  });
  assert.equal(rollback.version, 3);
  assert.equal(rollback.rolledBackFrom, 'rel-ops.home-banner-1');

  // C2 不允许规则引擎自动放行。
  const c2Cr = await toApprovedBanner(backend, humanApprover, bannerValues({ title: 'C2 自动放行尝试' }));
  await assert.rejects(
    () => backend.autoReleaseByRule(c2Cr, ruleEngine, 'rules-v1'),
    (error: unknown) => error instanceof ApprovalAuthorityError && error.code === 'HUMAN_ONLY',
  );

  // C1 允许规则引擎自动放行，并由规则引擎 agent 发布。
  const saved = await backend.saveDraft({
    itemId: 'market.sentiment-thresholds',
    expectedVersion: 1,
    values: sentimentValues({ hot_threshold: 82 }),
    actor: humanApprover,
  });
  assert.equal(saved.ok, true);
  await backend.validate('market.sentiment-thresholds', humanApprover);
  const c1Cr = await backend.submitForApproval({
    itemId: 'market.sentiment-thresholds',
    actor: humanApprover,
    diffAcknowledged: true,
  });
  await backend.autoReleaseByRule(c1Cr.id, ruleEngine, 'rules-v1');
  const autoRelease = await backend.publish({
    itemId: 'market.sentiment-thresholds',
    changeRequestId: c1Cr.id,
    actor: ruleEngine,
    diffAcknowledged: true,
  });
  assert.equal(autoRelease.authorization.kind, 'rule_engine_auto');

  // 单条审批是 API 约束：端口没有批量方法。
  const surface = backend as unknown as Record<string, unknown>;
  assert.equal(surface['approveMany'], undefined);
  assert.equal(surface['batchApprove'], undefined);
});
