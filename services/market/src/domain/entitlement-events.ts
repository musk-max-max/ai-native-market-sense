/**
 * 审计事件写入（H4 m00813 口径）：event_key 幂等、3 次重试（100/500/2000ms 指数退避）、
 * 最终失败写结构化 stderr + process.emitWarning，不阻塞授权翻转。
 *
 * 只写 A3 拥有的 4 类事件：tier_state_observed / entitlement_expired / entitlement_flip / unauthorized_config。
 * deploy/tier_switch/hold_set/hold_clear 由 A13/人工角色写，A3 不得写。
 */

import type { EntitlementEventRecord, EntitlementEventRepo } from '../ports/entitlement.js';

export type EventWriteFailureReporter = (payload: { eventKey: string; eventType: string; attempts: number; error: unknown }) => void;

export interface EntitlementEventWriterOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly reportFailure?: EventWriteFailureReporter;
  /** audit_gap 去重键与必填归属（H4 m01784：service 与 reconciler 要算出同一个 key）。 */
  readonly deploymentUid?: string;
  readonly operator?: string;
}

const DEFAULT_RETRY_DELAYS_MS = [100, 500, 2_000] as const;

export interface EventWriteFailure {
  readonly error: unknown;
  readonly at: Date;
  readonly eventType: string;
  readonly eventKey: string;
}

/** 写失败窗口（H4 m01741）：恢复后补一条 audit_gap，不重放丢失事件。 */
interface GapWindow {
  readonly from: Date;
  lostCount: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class EntitlementEventWriter {
  /** 最近一次最终失败（调用方据此区分确定性/瞬态写错误，H4 m01741）。 */
  lastFailure: EventWriteFailure | undefined;
  private gap: GapWindow | undefined;
  /** 失败前最后一条成功事件的 occurred_at（L63/H4：服务与 reconciler 能重算出同一个 gap_from）。 */
  private lastSuccessAt: Date | undefined;

  constructor(private readonly repo: EntitlementEventRepo, private readonly options: EntitlementEventWriterOptions = {}) {}

  /**
   * 返回是否最终写入成功；失败不抛（调用方决定阻断/非阻断）。
   * 若存在未补的写失败窗口，先写 audit_gap（event_key=`gap|<boot>|<gap_from ISO>`，幂等），
   * 再写下一条正常事件；不重放丢失事件本身。
   */
  async write(record: EntitlementEventRecord): Promise<boolean> {
    if (this.gap !== undefined && record.eventType !== 'audit_gap') {
      await this.flushGap(record.bootId);
    }
    const ok = await this.attempt(record);
    if (ok) {
      this.lastSuccessAt = record.occurredAt;
    } else {
      // gap_from = 最后一条成功事件的 occurred_at（没有成功记录时退回本事件 occurred_at）。
      this.gap ??= { from: this.lastSuccessAt ?? record.occurredAt, lostCount: 0 };
      this.gap.lostCount += 1;
    }
    return ok;
  }

  private async flushGap(bootId: string): Promise<void> {
    const gap = this.gap;
    if (gap === undefined) return;
    const windowEnd = new Date();
    const deploymentUid = this.options.deploymentUid ?? 'unknown';
    const record: EntitlementEventRecord = {
      // H4 m01784：用 deployment_uid 而非 boot_id，service 与 reconciler 才能算同一个去重键。
      eventKey: `gap|${deploymentUid}|${gap.from.toISOString()}`,
      eventType: 'audit_gap',
      schemaVersion: 2, // A5 002 起默认 2；history/seed 才用 1
      occurredAt: windowEnd,
      bootId,
      deploymentUid,
      stateVersion: 0,
      // reason 列置 NULL；失败原因放 new_value.reason（transient_write_failure）。
      newValue: {
        window_start: gap.from.toISOString(),
        window_end: windowEnd.toISOString(),
        lost_count: gap.lostCount,
        reason: 'transient_write_failure',
        owner: this.options.operator ?? 'market-app',
        deployment_uid: deploymentUid,
        operator: this.options.operator ?? 'market-app',
      },
    };
    if (await this.attempt(record)) {
      this.lastSuccessAt = record.occurredAt;
      this.gap = undefined;
    }
  }

  private async attempt(record: EntitlementEventRecord): Promise<boolean> {
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const attempts = delays.length + 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.repo.insert(record);
        return true;
      } catch (error) {
        lastError = error;
        const delay = delays[attempt];
        if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    this.lastFailure = {
      error: lastError,
      at: new Date(),
      eventType: record.eventType,
      eventKey: record.eventKey,
    };
    this.report(record, attempts, lastError);
    return false;
  }

  private report(record: EntitlementEventRecord, attempts: number, error: unknown): void {
    if (this.options.reportFailure !== undefined) {
      this.options.reportFailure({ eventKey: record.eventKey, eventType: record.eventType, attempts, error });
      return;
    }
    // 结构化 stderr（H4 规定的上限：不扩成消息队列）。
    console.error(
      JSON.stringify({
        event: 'entitlement_event_write_failed',
        event_key: record.eventKey,
        event_type: record.eventType,
        attempts,
        error: messageOf(error),
      }),
    );
    process.emitWarning(`[market] entitlement 事件写入失败（${record.eventType}/${record.eventKey}），不阻塞授权翻转`);
  }
}

export function observedEventKey(bootId: string): string {
  return `obs|${bootId}`;
}

export function flipEventKey(bootId: string, stateVersion: number): string {
  return `flip|${bootId}|${stateVersion}`;
}

export function unauthorizedEventKey(configFingerprint: string, bootId: string): string {
  return `unauth|${configFingerprint}|${bootId}`;
}

export function expiredEventKey(configuredTier: string, expiresAt: string, reason: string): string {
  return `exp|${configuredTier}|${expiresAt}|${reason}`;
}
