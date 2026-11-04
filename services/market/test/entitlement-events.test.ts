/**
 * 审计事件写入单测（H4 m00813）：event_key 派生、3 次重试、失败上报不阻塞授权翻转。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EntitlementEventWriter,
  expiredEventKey,
  flipEventKey,
  observedEventKey,
  unauthorizedEventKey,
} from '../src/domain/entitlement-events.js';
import type { EntitlementEventRecord, EntitlementEventRepo } from '../src/ports/entitlement.js';

const record = (eventKey: string): EntitlementEventRecord => ({
  eventKey,
  eventType: 'tier_state_observed',
  occurredAt: new Date('2026-11-04T02:00:00Z'),
  bootId: 'boot-1',
  stateVersion: 0,
});

class FlakyRepo implements EntitlementEventRepo {
  calls = 0;
  readonly keys: string[] = [];

  constructor(private readonly succeedAt: number) {}

  async insert(event: EntitlementEventRecord): Promise<void> {
    this.calls += 1;
    this.keys.push(event.eventKey);
    if (this.calls < this.succeedAt) throw new Error(`模拟第 ${this.calls} 次写入失败`);
  }
}

describe('event_key 派生（Lead/H4 公式，不得用 from/to 组合）', () => {
  it('四类 key 与 H4 口径逐字一致', () => {
    assert.equal(observedEventKey('boot-1'), 'obs|boot-1');
    assert.equal(flipEventKey('boot-1', 3), 'flip|boot-1|3');
    assert.equal(unauthorizedEventKey('a'.repeat(64), 'boot-1'), `unauth|${'a'.repeat(64)}|boot-1`);
    assert.equal(
      expiredEventKey('c_end_display', '2026-11-12T00:00:00.000Z', 'expires_at_passed'),
      'exp|c_end_display|2026-11-12T00:00:00.000Z|expires_at_passed',
    );
  });
});

describe('EntitlementEventWriter：重试与失败上报', () => {
  it('首次成功 → 只写一次、返回 true', async () => {
    const repo = new FlakyRepo(1);
    const writer = new EntitlementEventWriter(repo);
    assert.equal(await writer.write(record('obs|boot-1')), true);
    assert.equal(repo.calls, 1);
  });

  it('第 3 次成功 → 返回 true（重试 3 次：100/500/2000ms 退避的注入版本）', async () => {
    const repo = new FlakyRepo(3);
    const writer = new EntitlementEventWriter(repo, { retryDelaysMs: [0, 0, 0] });
    assert.equal(await writer.write(record('obs|boot-1')), true);
    assert.equal(repo.calls, 3);
  });

  it('始终失败 → 返回 false，上报结构化字段（不抛、不阻塞翻转）', async () => {
    const repo = new FlakyRepo(99);
    const reported: Array<{ eventKey: string; eventType: string; attempts: number }> = [];
    const writer = new EntitlementEventWriter(repo, {
      retryDelaysMs: [0, 0, 0],
      reportFailure: (payload) => reported.push(payload),
    });
    assert.equal(await writer.write(record('obs|boot-1')), false);
    assert.equal(repo.calls, 4);
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.eventKey, 'obs|boot-1');
    assert.equal(reported[0]?.eventType, 'tier_state_observed');
    assert.equal(reported[0]?.attempts, 4);
  });

  it('reportFailure 缺席时写结构化 stderr + emitWarning（不扩展消息队列）', async () => {
    const repo = new FlakyRepo(99);
    const writer = new EntitlementEventWriter(repo, { retryDelaysMs: [0, 0, 0] });
    const errors: string[] = [];
    const warnings: string[] = [];
    const originalError = console.error;
    const originalWarn = process.emitWarning;
    console.error = (line: string) => errors.push(line);
    process.emitWarning = ((message: string) => warnings.push(message)) as typeof process.emitWarning;
    try {
      assert.equal(await writer.write(record('obs|boot-1')), false);
    } finally {
      console.error = originalError;
      process.emitWarning = originalWarn;
    }
    assert.ok(errors.some((line) => line.includes('entitlement_event_write_failed')));
    assert.ok(warnings.some((line) => line.includes('entitlement 事件写入失败')));
  });
});

describe('audit_gap：写失败窗口恢复补记（L63/L65，H4 m01784/m01800）', () => {
  it('gap = gap|<deployment_uid>|<window_start>，window_start 取链上最后一条成功事件 occurred_at（含 gap 自身），不重放丢失事件', async () => {
    const inserted: EntitlementEventRecord[] = [];
    let failNext = true;
    const repo: EntitlementEventRepo = {
      async insert(event) {
        if (failNext) {
          failNext = false;
          throw new Error('连接重置（transient）');
        }
        inserted.push(event);
      },
    };
    const writer = new EntitlementEventWriter(repo, {
      retryDelaysMs: [],
      deploymentUid: 'deploy-1',
      operator: 'market-app',
    });

    const observed = record(observedEventKey('boot-1'));
    assert.equal(await writer.write(observed), false, '首次写失败');

    const next = { ...record(unauthorizedEventKey('fp', 'boot-1')), eventType: 'unauthorized_config' as const };
    assert.equal(await writer.write(next), true);

    const gap = inserted.find((event) => event.eventType === 'audit_gap');
    assert.ok(gap, '恢复后必须先补 audit_gap');
    assert.equal(gap?.eventKey, 'gap|deploy-1|2026-11-04T02:00:00.000Z');
    assert.equal(gap?.schemaVersion, 2);
    assert.equal(gap?.reason, undefined, 'reason 列置 NULL');
    const value = gap?.newValue ?? {};
    assert.deepEqual(Object.keys(value).sort(), [
      'deployment_uid',
      'lost_count',
      'operator',
      'owner',
      'reason',
      'window_end',
      'window_start',
    ]);
    assert.equal(value.window_start, '2026-11-04T02:00:00.000Z');
    assert.equal(value.lost_count, 1);
    assert.equal(value.reason, 'transient_write_failure');
    assert.equal(value.deployment_uid, 'deploy-1');
    // gap 在正常事件之前写；丢失的 observed 不重放。
    assert.deepEqual(inserted.map((event) => event.eventType), ['audit_gap', 'unauthorized_config']);
  });
});

describe('audit_gap：缺 DEPLOYMENT_UID 时不写 gap（H4 m01880）', () => {
  it('deployment_uid 缺失 → 抑制 gap 写入（避免多个 dev/preview 共库同 key 被吞），只告警', async () => {
    const inserted: EntitlementEventRecord[] = [];
    let failNext = true;
    const repo: EntitlementEventRepo = {
      async insert(event) {
        if (failNext) {
          failNext = false;
          throw new Error('连接重置（transient）');
        }
        inserted.push(event);
      },
    };
    const writer = new EntitlementEventWriter(repo, { retryDelaysMs: [] });
    assert.equal(await writer.write(record(observedEventKey('boot-1'))), false);
    assert.equal(await writer.write(record(unauthorizedEventKey('fp', 'boot-1'))), true);
    assert.equal(inserted.some((event) => event.eventType === 'audit_gap'), false);
    assert.equal(inserted.length, 1, '只写下一条正常事件，不补 gap、不重放丢失事件');
  });
});
