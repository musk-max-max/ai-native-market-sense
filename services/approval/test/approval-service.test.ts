/**
 * ApprovalService 单测：G-03 B 级缺口 B1（断链自检）、B2（多步写原子）、B4（actor unknown）、B5（cursor）。
 * 运行：npm test（node --import tsx --test test/*.test.ts）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryDomainStore } from '../src/adapters/memory-store.js';
import { DomainError } from '../src/domain/errors.js';
import { ApprovalService } from '../src/services/approval-service.js';
import { AGENT_CTX, HUMAN_CTX, FailingStore, createBody, fixedNow } from './fixtures.js';

function isInjected(error: unknown): boolean {
  return error instanceof Error && error.message.includes('injected failure');
}

function isIntegrity500(error: unknown): boolean {
  return error instanceof DomainError && error.status === 500 && error.reason === 'ledger_integrity_failure';
}

async function createOne(svc: ApprovalService, key: string): Promise<string> {
  const created = await svc.create({ body: createBody(), idempotencyKey: key, actorContext: AGENT_CTX });
  return created.application.approval_ref;
}

describe('B1 账本断链自检（verifyChain）', () => {
  it('篡改事件 hash → get/events/evaluate/decide 全部 500 ledger_integrity_failure；健康链不受影响', async () => {
    const store = new MemoryDomainStore();
    const svc = new ApprovalService(store, fixedNow);
    const ref = await createOne(svc, 'idem-b1-01');

    // 健康链放行
    const healthy = await svc.get(ref);
    assert.equal(healthy.approval_ref, ref);

    // 模拟存储损坏：篡改 created 事件的 eventHash
    const internals = store as unknown as { events: Map<string, { eventHash: string }[]> };
    const ledger = internals.events.get(ref);
    assert.ok(ledger !== undefined);
    ledger[0]!.eventHash = `sha256:${'0'.repeat(64)}`;

    await assert.rejects(svc.get(ref), isIntegrity500);
    await assert.rejects(svc.events(ref, 10), isIntegrity500);
    await assert.rejects(svc.evaluateApproval(ref, AGENT_CTX), isIntegrity500);
    await assert.rejects(
      svc.decide({
        approvalRef: ref,
        body: { decision: 'approved', reason: '通过审核且无异议' },
        idempotencyKey: 'idem-b1-decide',
        actorContext: HUMAN_CTX,
      }),
      isIntegrity500,
    );
    // 断链只拒绝读取/流转，不返回损坏内容
    assert.equal(store.auditLog.filter((e) => e.eventType === 'approval_decided').length, 0);
  });
});

describe('B4 actor 显式映射（不得 unknown 落审计）', () => {
  it('agent 缺/空 x-model-version → 400 且零写入；带头 → 显式落审计；human 不需要头', async () => {
    const store = new MemoryDomainStore();
    const svc = new ApprovalService(store, fixedNow);

    await assert.rejects(
      svc.create({ body: createBody(), idempotencyKey: 'idem-b4-01', actorContext: { principal: AGENT_CTX.principal } }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.status === 400 &&
        JSON.stringify(error.issues).includes('x-model-version'),
    );
    assert.equal((await store.listApplications({ limit: 10 })).items.length, 0);
    assert.equal(store.auditLog.length, 0);

    await assert.rejects(
      svc.create({
        body: createBody(),
        idempotencyKey: 'idem-b4-02',
        actorContext: { principal: AGENT_CTX.principal, modelVersion: '   ' },
      }),
      (error: unknown) => error instanceof DomainError && error.status === 400,
    );
    assert.equal(store.auditLog.length, 0);

    // 带头 → 成功，audit actor = 主体 + 显式模型版本
    await svc.create({ body: createBody(), idempotencyKey: 'idem-b4-03', actorContext: AGENT_CTX });
    const created = store.auditLog.find((e) => e.eventType === 'approval_created');
    assert.ok(created !== undefined);
    assert.deepEqual(created.actor, { kind: 'agent', id: 'a15', model_version: 'mimo-v2.6-flash' });

    // human 主体（H3）无需模型版本头
    const humanStore = new MemoryDomainStore();
    const humanSvc = new ApprovalService(humanStore, fixedNow);
    await humanSvc.create({ body: createBody(), idempotencyKey: 'idem-b4-04', actorContext: HUMAN_CTX });
    const humanAudit = humanStore.auditLog.find((e) => e.eventType === 'approval_created');
    assert.ok(humanAudit !== undefined);
    assert.deepEqual(humanAudit.actor, { kind: 'human', id: 'H3' });
  });
});

describe('B5 events cursor 守卫', () => {
  it('畸形 cursor（abc/1e3/NaN/-1/12a）→ 400 且 issues 指向 /cursor；合法 cursor 正常分页', async () => {
    const store = new MemoryDomainStore();
    const svc = new ApprovalService(store, fixedNow);
    const ref = await createOne(svc, 'idem-b5-01');
    await svc.evaluateApproval(ref, AGENT_CTX); // seq 2

    for (const bad of ['abc', '1e3', 'NaN', '-1', '12a']) {
      await assert.rejects(
        svc.events(ref, 10, bad),
        (error: unknown) =>
          error instanceof DomainError &&
          error.status === 400 &&
          error.reason === 'validation_failed' &&
          JSON.stringify(error.issues).includes('/cursor'),
        `cursor=${bad} 应被拒绝`,
      );
    }

    const page1 = await svc.events(ref, 1);
    assert.equal(page1.items.length, 1);
    assert.equal(page1.next_cursor, '1');
    const page2 = await svc.events(ref, 1, '1');
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0]?.type, 'evaluated');
    assert.equal(page2.next_cursor, null);
    const tail = await svc.events(ref, 10, '2');
    assert.equal(tail.items.length, 0);
    assert.equal(tail.next_cursor, null);
  });
});

describe('B2 多步写原子性（approval 侧）', () => {
  it('create：putIdempotent 失败 → 无单/无留痕/无幂等记录；重试成功', async () => {
    const store = new FailingStore();
    const svc = new ApprovalService(store, fixedNow);
    store.arm('putIdempotent');
    await assert.rejects(
      svc.create({ body: createBody(), idempotencyKey: 'idem-b2-create', actorContext: AGENT_CTX }),
      isInjected,
    );
    assert.equal((await store.listApplications({ limit: 10 })).items.length, 0);
    assert.equal(store.auditLog.length, 0);
    assert.equal(await store.findIdempotent('approval.create', 'idem-b2-create'), null);

    const retry = await svc.create({ body: createBody(), idempotencyKey: 'idem-b2-create', actorContext: AGENT_CTX });
    assert.equal(retry.replayed, false);
    assert.equal((await store.listApplications({ limit: 10 })).items.length, 1);
    assert.equal(store.auditLog.filter((e) => e.eventType === 'approval_created').length, 1);
  });

  it('decide：留痕失败 → 决定事件/状态投影回滚；重试成功且恰一条 decided 留痕', async () => {
    const store = new FailingStore();
    const svc = new ApprovalService(store, fixedNow);
    const ref = await createOne(svc, 'idem-b2-decide');
    const decisionBody = { decision: 'approved', reason: '内容合规且风险可控' };

    store.arm('audit');
    await assert.rejects(
      svc.decide({ approvalRef: ref, body: decisionBody, idempotencyKey: 'idem-b2-decide-key', actorContext: HUMAN_CTX }),
      isInjected,
    );
    const afterFail = await svc.get(ref);
    assert.equal(afterFail.status, 'submitted');
    assert.equal(store.auditLog.filter((e) => e.eventType === 'approval_decided').length, 0);

    const retry = await svc.decide({
      approvalRef: ref,
      body: decisionBody,
      idempotencyKey: 'idem-b2-decide-key',
      actorContext: HUMAN_CTX,
    });
    assert.equal(retry.decision, 'approved');
    assert.equal((await svc.get(ref)).status, 'approved');
    assert.equal(store.auditLog.filter((e) => e.eventType === 'approval_decided').length, 1);
  });

  it('evaluate：事件追加失败 → 状态停留 submitted、无 evaluated 留痕；重试成功', async () => {
    const store = new FailingStore();
    const svc = new ApprovalService(store, fixedNow);
    const ref = await createOne(svc, 'idem-b2-eval');

    store.arm('appendEvent');
    await assert.rejects(svc.evaluateApproval(ref, AGENT_CTX), isInjected);
    assert.equal((await svc.get(ref)).status, 'submitted');
    assert.equal(store.auditLog.filter((e) => e.eventType === 'approval_evaluated').length, 0);

    const evaluated = await svc.evaluateApproval(ref, AGENT_CTX);
    assert.equal(evaluated.status, 'evaluated');
    assert.equal(store.auditLog.filter((e) => e.eventType === 'approval_evaluated').length, 1);
  });
});
