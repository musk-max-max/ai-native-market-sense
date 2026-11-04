/**
 * WatchlistRepo 的 PostgreSQL 实现（平台自有数据，A3 自持表，迁移见 services/market/migrations/）。
 *
 * 幂等语义与契约一致：
 *  - add：ON CONFLICT DO NOTHING；冲突时读回首次 added_at（added_at 不被覆盖）；
 *  - remove：DELETE 不报错（不存在同样 204）；
 *  - list：最近加入在前；每用户最多 limit 条（上限由 config 注入，不写死在契约里）。
 */

import type { Pool } from 'pg';

import type {
  WatchlistAddResult,
  WatchlistItemRow,
  WatchlistRepo,
} from '../ports/watchlist-repo.js';
import { WatchlistLimitExceededError } from '../ports/watchlist-repo.js';

interface WatchlistDbRow {
  instrument_id: string;
  added_at: Date;
}

const TABLE_PATTERN = /^[a-z_][a-z0-9_]*$/;

export class PgWatchlistRepo implements WatchlistRepo {
  constructor(
    private readonly pool: Pool,
    private readonly table: string,
  ) {
    if (!TABLE_PATTERN.test(table)) {
      throw new Error(`非法的 watchlist 表名: ${JSON.stringify(table)}`);
    }
  }

  private get quotedTable(): string {
    return `"${this.table}"`;
  }

  async list(userId: string): Promise<WatchlistItemRow[]> {
    const result = await this.pool.query<WatchlistDbRow>(
      `SELECT instrument_id, added_at
         FROM ${this.quotedTable}
        WHERE user_id = $1
        ORDER BY added_at DESC, instrument_id ASC`,
      [userId],
    );
    return result.rows.map((row) => ({ instrument_id: row.instrument_id, added_at: row.added_at }));
  }

  async add(userId: string, instrumentId: string, limit: number): Promise<WatchlistAddResult> {
    const inserted = await this.pool.query<WatchlistDbRow>(
      `INSERT INTO ${this.quotedTable} (user_id, instrument_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, instrument_id) DO NOTHING
       RETURNING instrument_id, added_at`,
      [userId, instrumentId],
    );
    const created = inserted.rows[0];
    if (created !== undefined) {
      return {
        item: { instrument_id: created.instrument_id, added_at: created.added_at },
        created: true,
      };
    }

    // 已存在（幂等）：返回首次加入时间，不做 added_at 更新。
    const existing = await this.pool.query<WatchlistDbRow>(
      `SELECT instrument_id, added_at FROM ${this.quotedTable} WHERE user_id = $1 AND instrument_id = $2`,
      [userId, instrumentId],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      throw new Error(`watchlist 幂等冲突后读回失败: user=${userId} instrument=${instrumentId}`);
    }
    return { item: { instrument_id: row.instrument_id, added_at: row.added_at }, created: false };
  }

  async remove(userId: string, instrumentId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.quotedTable} WHERE user_id = $1 AND instrument_id = $2`,
      [userId, instrumentId],
    );
  }

  /** 幂等建表 + 上限检查在应用层（PostgreSQL advisory lock 防止并发重复建表）。 */
  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('market_watchlist_migrations'))`);
      // 生产/真栈：表由迁移预建，market_app 无 public schema CREATE 权限（20_grants REVOKE）；
      // 存在即跳过全部 DDL，避免 CREATE INDEX IF NOT EXISTS 仍触发 schema CREATE 权限检查（42501）。
      const existing = await client.query(`SELECT to_regclass($1) AS table_name`, [this.table]);
      if (existing.rows[0]?.table_name !== null && existing.rows[0]?.table_name !== undefined) return;
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.quotedTable} (
          user_id       text        NOT NULL,
          instrument_id text        NOT NULL,
          added_at      timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, instrument_id),
          CONSTRAINT ${this.table}_instrument_id_format
            CHECK (instrument_id ~ '^(SSE|SZSE|BSE):[0-9]{6}$')
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.table}_user_added_idx ON ${this.quotedTable} (user_id, added_at DESC)`,
      );
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('market_watchlist_migrations'))`).catch(() => undefined);
      client.release();
    }
  }
}
