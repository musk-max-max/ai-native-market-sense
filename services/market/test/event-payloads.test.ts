/**
 * L70：事件 payload 键集唯一真源守卫（docs/reference/event-payloads.json，A5 授权写）。
 *
 * 与 reason-vocabulary.test.ts 同思路：测试读文件，不抄名单；写入前 fail-closed。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EntitlementEventWriter } from '../src/domain/entitlement-events.js';
import {
  EventPayloadContractError,
  loadEventPayloadContract,
} from '../src/domain/event-payload-contract.js';
import type { EntitlementEventRecord, EntitlementEventRepo } from '../src/ports/entitlement.js';

const contract = loadEventPayloadContract();

function gapRecord(newValue: Record<string, unknown>): EntitlementEventRecord {
  return {
    eventKey: 'gap|deploy-1|2026-11-04T00:00:00.000Z',
    eventType: 'audit_gap',
    schemaVersion: 2,
    occurredAt: new Date('2026-11-04T00:00:01Z'),
    bootId: 'boot-1',
    deploymentUid: 'deploy-1',
    stateVersion: 0,
    newValue,
  };
}

describe('L70 事件 payload 契约', () => {
  it('契约可读，A3 事件键集与声明一致（audit_gap 恰好 5 键、observed 3 个可选键）', () => {
    assert.equal(contract.event_types['audit_gap']?.new_value.required.length, 5);
    assert.deepEqual([...contract.event_types['audit_gap']!.new_value.required].sort(), [
      'lost_count',
      'owner',
      'reason',
      'window_end',
      'window_start',
    ]);
    assert.deepEqual(contract.event_types['audit_gap']!.new_value.optional, []);
    assert.deepEqual([...contract.event_types['tier_state_observed']!.new_value.optional].sort(), [
      'configured_tier',
      'effective_tier',
      'expires_at',
    ]);
  });

  it('缺 required 键 → 拒绝写入（不落库、不重试）、抛契约错误', async () => {
    const inserted: EntitlementEventRecord[] = [];
    const repo: EntitlementEventRepo = {
      async insert(event) {
        inserted.push(event);
      },
    };
    const writer = new EntitlementEventWriter(repo, { retryDelaysMs: [], payloadContract: contract });
    const ok = await writer.write(
      gapRecord({ window_start: '2026-11-04T00:00:00.000Z', lost_count: 1, reason: 'transient_write_failure', owner: 'x' }),
    );
    assert.equal(ok, false);
    assert.deepEqual(inserted, []);
    assert.ok(writer.lastFailure?.error instanceof EventPayloadContractError);
  });

  it('required 齐全 → 正常写入；契约外额外键不拒绝（A5 unknown_keys 口径）', async () => {
    const inserted: EntitlementEventRecord[] = [];
    const repo: EntitlementEventRepo = {
      async insert(event) {
        inserted.push(event);
      },
    };
    const writer = new EntitlementEventWriter(repo, { retryDelaysMs: [], payloadContract: contract });
    const ok = await writer.write(
      gapRecord({
        window_start: '2026-11-04T00:00:00.000Z',
        window_end: '2026-11-04T00:00:01.000Z',
        lost_count: 1,
        reason: 'transient_write_failure',
        owner: 'market-app',
        future_key: true,
      }),
    );
    assert.equal(ok, true);
    assert.equal(inserted.length, 1);
  });
});
