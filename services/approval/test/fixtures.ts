/**
 * 测试夹具（不匹配 test/*.test.ts glob，不被 --test 直接执行）。
 *
 * 覆盖对象：G-03 B 级缺口（B1 断链自检 / B2 多步写原子 / B3 submit 幂等 / B4 actor unknown / B5 cursor NaN）。
 */

import type { Principal } from '../../identity/src/domain/principal.js';
import { MemoryDomainStore } from '../src/adapters/memory-store.js';
import type { EventDraft, LedgerEvent } from '../src/domain/ledger.js';
import type { ApprovalAuditEvent, IdempotentRecord, ReleaseBinding, StoredVersionRow } from '../src/ports/stores.js';
import type { Environment } from '../src/domain/types.js';
import { ApprovalService } from '../src/services/approval-service.js';
import { ConfigService } from '../src/services/config-service.js';

export const agentPrincipal: Principal = {
  userId: 'a15',
  userType: 'internal_active',
  tier: 'internal_eval',
  sessionVersion: 1,
};
export const approverPrincipal: Principal = {
  userId: 'H3',
  userType: 'internal_active',
  tier: 'internal_eval',
  sessionVersion: 1,
};

export const CONFIG_ID = 'ops_cfg_demo';
export const ENV: Environment = 'dev';

let tick = 0;
/** 单调递增的固定时钟：每次取值 +1ms，保证 createdAt/updatedAt 严格有序。 */
export function fixedNow(): string {
  tick += 1;
  return new Date(Date.parse('2026-11-06T10:00:00.000Z') + tick).toISOString();
}

export function emptySpec(): { columns: []; content_items: []; strategies: [] } {
  return { columns: [], content_items: [], strategies: [] };
}

export function createBody(objectId: string = CONFIG_ID): Record<string, unknown> {
  return {
    flow: 't1',
    applicant: { kind: 'agent', id: 'a15', model_version: 'mimo-v2.6-flash' },
    subject: {
      environment: ENV,
      domain: 'ops_config',
      object_id: objectId,
      path: `/v1/internal/configs/${objectId}`,
      diff_hash: `sha256:${'a'.repeat(64)}`,
    },
    change: {
      keys: ['/spec/banner/title'],
      diff_hash: `sha256:${'b'.repeat(64)}`,
      before: {},
      after: { banner: { title: '示例' } },
    },
    evidence: {
      change_reason: '首轮提审：展示位与文案调整',
      impact_scope: ['column_layout'],
      expected_version: 1,
      policy_version: null,
    },
  };
}

export function draftBody(): Record<string, unknown> {
  return {
    schema_version: '0.1',
    config_id: CONFIG_ID,
    environment: ENV,
    change_reason: '首轮草稿建档与展示位调整',
    impact_scope: ['column_layout'],
    spec: emptySpec(),
  };
}

export function submitBody(): Record<string, unknown> {
  return {
    change_reason: '首提：展示位与文案调整',
    impact_scope: ['column_layout'],
    expected_version: 1,
  };
}

/** 注册 config_id 首版草稿（v1 draft，无版本快照行：submit v1 不读 prevRow）。 */
export async function seedConfig(store: MemoryDomainStore): Promise<void> {
  await store.upsertConfig({
    configId: CONFIG_ID,
    environment: ENV,
    version: 1,
    status: 'draft',
    schemaVersion: '0.1',
    changeReason: '初始建档',
    impactScope: ['column_layout'],
    spec: emptySpec(),
    createdBy: { kind: 'human', id: 'H3' },
    updatedBy: { kind: 'human', id: 'H3' },
    createdAt: '2026-11-06T09:00:00.000Z',
    updatedAt: '2026-11-06T09:00:00.000Z',
  });
}

export function makeServices(store: MemoryDomainStore): { approvals: ApprovalService; configs: ConfigService } {
  const approvals = new ApprovalService(store, fixedNow);
  const configs = new ConfigService({ store, approvals, now: fixedNow });
  return { approvals, configs };
}

export const AGENT_CTX = { principal: agentPrincipal, modelVersion: 'mimo-v2.6-flash' } as const;
export const HUMAN_CTX = { principal: approverPrincipal } as const;

/** 注入一次性写失败（B2 原子性）：arm 后第一次命中即抛错并自动解除。 */
export class FailingStore extends MemoryDomainStore {
  private failPoint: string | null = null;

  arm(point: string): void {
    this.failPoint = point;
  }

  private trip(point: string): void {
    if (this.failPoint === point) {
      this.failPoint = null;
      throw new Error(`injected failure: ${point}`);
    }
  }

  override async putIdempotent(record: IdempotentRecord): Promise<void> {
    this.trip('putIdempotent');
    return super.putIdempotent(record);
  }

  override async insertVersionRow(row: StoredVersionRow): Promise<void> {
    this.trip('insertVersionRow');
    return super.insertVersionRow(row);
  }

  override async insertBinding(binding: ReleaseBinding): Promise<void> {
    this.trip('insertBinding');
    return super.insertBinding(binding);
  }

  override async setCurrentRelease(configId: string, environment: Environment, releaseId: string): Promise<void> {
    this.trip('setCurrentRelease');
    return super.setCurrentRelease(configId, environment, releaseId);
  }

  override async appendEvent(approvalRef: string, event: EventDraft): Promise<LedgerEvent> {
    this.trip('appendEvent');
    return super.appendEvent(approvalRef, event);
  }

  override async audit(event: ApprovalAuditEvent): Promise<void> {
    this.trip('audit');
    return super.audit(event);
  }
}
