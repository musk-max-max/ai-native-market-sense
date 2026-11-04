/**
 * 审计事件写入（audit.entitlement_events，A5 canonical DDL）。market_app 只有列级 INSERT，
 * 且 GRANT 明确排除 event_id / event_key / prev_hash / hash（20_grants.sql）：
 *   - INSERT 列清单**不得包含** event_key（A5 BEFORE INSERT 触发器权威计算，应用不得自证）；
 *   - hash 链由同一触发器生成，应用只提供业务字段；
 *   - 幂等用**裸** ON CONFLICT DO NOTHING：market_app 只有列级 INSERT、没有 SELECT，
 *     指定冲突目标 (event_key) 需要 SELECT 权限会 permission denied（A5 m01191）。
 *     A3 只写 4 类事件，表中唯一约束即 event_key（tier_switch 部分唯一索引 A3 不触发）。
 */

import type { Pool } from 'pg';

import type { EntitlementEventRecord, EntitlementEventRepo } from '../ports/entitlement.js';

export const ENTITLEMENT_EVENTS_TABLE = 'audit.entitlement_events';

export class PgEntitlementEventRepo implements EntitlementEventRepo {
  constructor(private readonly pool: Pool, private readonly table: string = ENTITLEMENT_EVENTS_TABLE) {}

  async insert(record: EntitlementEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (
         event_type, occurred_at, boot_id, deployment_uid, state_version,
         old_value, new_value, reason, effective_tier, configured_tier, expires_at,
         config_fingerprint, trace_id, rule_version, release_id
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING`,
      [
        record.eventType,
        record.occurredAt.toISOString(),
        record.bootId,
        record.deploymentUid ?? null,
        record.stateVersion,
        record.oldValue === undefined ? null : JSON.stringify(record.oldValue),
        record.newValue === undefined ? null : JSON.stringify(record.newValue),
        record.reason ?? null,
        record.effectiveTier ?? null,
        record.configuredTier ?? null,
        record.expiresAt ?? null,
        record.configFingerprint ?? null,
        record.traceId ?? null,
        record.ruleVersion ?? null,
        record.releaseId ?? null,
      ],
    );
  }
}
