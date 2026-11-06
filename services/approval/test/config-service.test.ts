/**
 * ConfigService 单测：G-03 B 级缺口 B2（多步写原子）、B3（submit 幂等）。
 * 运行：npm test（node --import tsx --test test/*.test.ts）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryDomainStore } from '../src/adapters/memory-store.js';
import { DomainError } from '../src/domain/errors.js';
import { AGENT_CTX, CONFIG_ID, ENV, FailingStore, draftBody, makeServices, seedConfig, submitBody } from './fixtures.js';

function isInjected(error: unknown): boolean {
  return error instanceof Error && error.message.includes('injected failure');
}

const PUBLISH_BODY = { canary_percent: 5 } as const;

describe('B2 多步写原子性（config 侧）', () => {
  it('putDraft：insertVersionRow 失败 → 版本回退 v1、无 config_drafted 留痕；重试成功到 v2', async () => {
    const store = new FailingStore();
    await seedConfig(store);
    const { configs } = makeServices(store);
    const input = {
      configId: CONFIG_ID,
      environment: ENV,
      ifMatch: '"v1"',
      body: draftBody(),
      actor: { kind: 'human', id: 'H3' } as const,
    };

    store.arm('insertVersionRow');
    await assert.rejects(configs.putDraft(input), isInjected);
    const row = await store.getConfig(CONFIG_ID, ENV);
    assert.ok(row != null);
    assert.equal(row.version, 1);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_drafted').length, 0);

    const ok = await configs.putDraft(input);
    assert.equal(ok.etag, '"v2"');
    assert.equal((await store.getConfig(CONFIG_ID, ENV))?.version, 2);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_drafted').length, 1);
  });

  it('submit：insertBinding 失败 → 无孤儿单/无留痕/无活跃绑定；重试成功', async () => {
    const store = new FailingStore();
    await seedConfig(store);
    const { configs } = makeServices(store);
    const input = { configId: CONFIG_ID, environment: ENV, body: submitBody(), actorContext: AGENT_CTX };

    store.arm('insertBinding');
    await assert.rejects(configs.submit(input), isInjected);
    assert.equal((await store.listApplications({ limit: 10 })).items.length, 0);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_submitted').length, 0);
    assert.equal(await store.findActiveSubmission({ configId: CONFIG_ID, environment: ENV, version: 1 }), null);

    const sub = await configs.submit(input);
    assert.match(sub.approval_ref, /^apr_/);
    assert.equal(sub.flow, 't1');
    assert.equal(sub.status, 'submitted');
    assert.equal((await store.listApplications({ limit: 10 })).items.length, 1);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_submitted').length, 1);
    const binding = await store.getBinding(sub.approval_ref);
    assert.ok(binding !== undefined && binding !== null);
    assert.equal(binding.consumedAt, null);
  });

  it('publish：setCurrentRelease 失败 → 指针/绑定/状态全部回滚；重试成功', async () => {
    const store = new FailingStore();
    await seedConfig(store);
    const { approvals, configs } = makeServices(store);

    const sub = await configs.submit({ configId: CONFIG_ID, environment: ENV, body: submitBody(), actorContext: AGENT_CTX });
    await approvals.decide({
      approvalRef: sub.approval_ref,
      body: { decision: 'approved', reason: '变更合规准予发布上线' },
      idempotencyKey: 'idem-pub-decide',
      actorContext: { principal: { userId: 'H3', userType: 'internal_active', tier: 'internal_eval', sessionVersion: 1 } },
    });
    const publishInput = {
      configId: CONFIG_ID,
      environment: ENV,
      body: { approval_ref: sub.approval_ref, expected_version: 1, ...PUBLISH_BODY },
      actor: { kind: 'human', id: 'H3' } as const,
    };

    store.arm('setCurrentRelease');
    await assert.rejects(configs.publish(publishInput), isInjected);
    assert.equal(await store.getCurrentRelease(CONFIG_ID, ENV), null);
    const binding = await store.getBinding(sub.approval_ref);
    assert.ok(binding !== undefined && binding !== null);
    assert.equal(binding.consumedAt, null);
    assert.equal((await store.getConfig(CONFIG_ID, ENV))?.status, 'draft');
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_published').length, 0);

    const release = await configs.publish(publishInput);
    assert.match(release.release_id, /^rel_/);
    assert.equal((await store.getConfig(CONFIG_ID, ENV))?.status, 'published');
    const consumed = await store.getBinding(sub.approval_ref);
    assert.ok(consumed !== undefined && consumed !== null);
    assert.notEqual(consumed.consumedAt, null);
    assert.equal((await store.getCurrentRelease(CONFIG_ID, ENV))?.releaseId, release.release_id);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_published').length, 1);

    // 一 ref 恰一次：再次发布同 ref → 409 approval_ref_reuse
    await assert.rejects(
      configs.publish(publishInput),
      (error: unknown) => error instanceof DomainError && error.status === 409 && error.reason === 'approval_ref_reuse',
    );
  });

  it('rollback：留痕失败 → 绑定/指针回滚、无 config_rolled_back 留痕；重试成功', async () => {
    const store = new FailingStore();
    await seedConfig(store);
    const { approvals, configs } = makeServices(store);

    const sub = await configs.submit({ configId: CONFIG_ID, environment: ENV, body: submitBody(), actorContext: AGENT_CTX });
    await approvals.decide({
      approvalRef: sub.approval_ref,
      body: { decision: 'approved', reason: '变更合规准予发布上线' },
      idempotencyKey: 'idem-rb-pub-decide',
      actorContext: { principal: { userId: 'H3', userType: 'internal_active', tier: 'internal_eval', sessionVersion: 1 } },
    });
    const release = await configs.publish({
      configId: CONFIG_ID,
      environment: ENV,
      body: { approval_ref: sub.approval_ref, expected_version: 1, ...PUBLISH_BODY },
      actor: { kind: 'human', id: 'H3' },
    });

    // 回滚审批由建单接口直建（独立单，非发布 ref）
    const rbCreate = await approvals.create({
      body: (await import('./fixtures.js')).createBody(),
      idempotencyKey: 'idem-rb-create',
      actorContext: AGENT_CTX,
    });
    const rbRef = rbCreate.application.approval_ref;
    await approvals.decide({
      approvalRef: rbRef,
      body: { decision: 'approved', reason: '线上异常需回滚处置' },
      idempotencyKey: 'idem-rb-decide',
      actorContext: { principal: { userId: 'H3', userType: 'internal_active', tier: 'internal_eval', sessionVersion: 1 } },
    });

    const rollbackInput = {
      configId: CONFIG_ID,
      environment: ENV,
      body: { target_release_id: release.release_id, approval_ref: rbRef, reason: '线上指标异常紧急回滚处理' },
      actor: { kind: 'human', id: 'H3' } as const,
    };

    store.arm('audit');
    await assert.rejects(configs.rollback(rollbackInput), isInjected);
    assert.equal(await store.getBinding(rbRef), null);
    assert.equal((await store.getCurrentRelease(CONFIG_ID, ENV))?.releaseId, release.release_id);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_rolled_back').length, 0);

    const rolled = await configs.rollback(rollbackInput);
    assert.equal(rolled.release_id, release.release_id);
    assert.equal((await store.getCurrentRelease(CONFIG_ID, ENV))?.releaseId, release.release_id);
    assert.notEqual(await store.getBinding(rbRef), null);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_rolled_back').length, 1);
  });
});

describe('B3 submit 幂等（原缺口：幂等键拼 uuidv7 恒不命中）', () => {
  it('同内容重复 submit → 重放原单（同 ref、单数 1、留痕 1）；异内容 → 409 显式拒绝', async () => {
    const store = new MemoryDomainStore();
    await seedConfig(store);
    const { configs } = makeServices(store);
    const input = { configId: CONFIG_ID, environment: ENV, body: submitBody(), actorContext: AGENT_CTX };

    const first = await configs.submit(input);
    const second = await configs.submit(input);
    assert.equal(second.approval_ref, first.approval_ref);
    assert.equal(second.application_id, first.application_id);
    assert.equal((await store.listApplications({ limit: 10 })).items.length, 1);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_submitted').length, 1);

    await assert.rejects(
      configs.submit({
        configId: CONFIG_ID,
        environment: ENV,
        body: { ...submitBody(), change_reason: '完全不同的另一件事由另一人发起' },
        actorContext: AGENT_CTX,
      }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.status === 409 &&
        error.reason === 'approval_state_conflict' &&
        error.extras.approvalRef === first.approval_ref,
    );
    assert.equal((await store.listApplications({ limit: 10 })).items.length, 1);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'config_submitted').length, 1);
  });

  it('H3 驳回后同内容重提 → 新建单（R9 决定不可复用），单数 2', async () => {
    const store = new MemoryDomainStore();
    await seedConfig(store);
    const { approvals, configs } = makeServices(store);
    const input = { configId: CONFIG_ID, environment: ENV, body: submitBody(), actorContext: AGENT_CTX };

    const first = await configs.submit(input);
    await approvals.decide({
      approvalRef: first.approval_ref,
      body: { decision: 'rejected', reason: '材料不充分退回重新准备' },
      idempotencyKey: 'idem-r9-reject',
      actorContext: { principal: { userId: 'H3', userType: 'internal_active', tier: 'internal_eval', sessionVersion: 1 } },
    });

    const third = await configs.submit(input);
    assert.notEqual(third.approval_ref, first.approval_ref);
    assert.equal((await store.listApplications({ limit: 10 })).items.length, 2);
    // 被驳回单仍可查（append-only），新单独立存在
    assert.equal((await store.getApplication(first.approval_ref))?.application.status, 'rejected');
    assert.equal((await store.getApplication(third.approval_ref))?.application.status, 'submitted');
  });
});
