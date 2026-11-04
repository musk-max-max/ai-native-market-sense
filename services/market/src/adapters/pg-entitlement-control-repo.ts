/**
 * control 行读取（audit.entitlement_hold_state 只读视图，A5 canonical DDL）。
 * market_app 仅被 GRANT SELECT 视图（20_grants.sql），基表 audit.entitlement_hold 不可读；
 * 视图不存在(42P01)/权限不足(42501) 等错误原样抛出，由 EntitlementGate 分类为确定性配置错误。
 */

import type { Pool } from 'pg';

import type { EntitlementControlRepo, EntitlementControlRow } from '../ports/entitlement.js';

export const ENTITLEMENT_HOLD_TABLE = 'audit.entitlement_hold_state';

interface RawRow {
  hold: boolean;
  hold_id: string | null;
  hold_reason: string | null;
  last_reconciled_at: Date | null;
}

export class PgEntitlementControlRepo implements EntitlementControlRepo {
  constructor(private readonly pool: Pool, private readonly table: string = ENTITLEMENT_HOLD_TABLE) {}

  async fetchControl(): Promise<EntitlementControlRow | null> {
    const { rows } = await this.pool.query<RawRow>(
      `SELECT hold, hold_id, hold_reason AS reason, last_reconciled_at FROM ${this.table} WHERE id = 1`,
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      hold: row.hold === true,
      holdId: row.hold_id,
      reason: row.hold_reason,
      lastReconciledAt: row.last_reconciled_at === null ? null : new Date(row.last_reconciled_at),
    };
  }
}
