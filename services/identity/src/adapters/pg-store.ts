/**
 * PostgreSQL 实现（生产）。
 *
 * 表结构见 `services/identity/migrations/001_identity.sql`（schema `identity`）。
 * 事务：`runInTransaction` 从 pool 取独立连接，`BEGIN/COMMIT/ROLLBACK`，审计与业务写入同事务；
 * 连接用后必然释放。并发：用户更新 `WHERE session_version = $expected`，申请更新
 * `WHERE status = $expected`，失败返回 false（服务层 fail-closed）。
 *
 * 时间统一存 `timestamptz`，读回转 ISO8601（UTC）字符串，与领域层约定一致。
 */

import { Pool, type PoolClient } from 'pg';

import { uuidv7 } from '../domain/approval-ref.js';
import type { ApplicationStatus, InternalApplication, InternalTier, ApproverId, UserRecord, UserType } from '../domain/types.js';
import type { AuditActor, AuditSink, IdentityAuditEvent } from '../ports/audit-sink.js';
import type {
  ApplicationRepository,
  IdentityRepositories,
  IdentityStore,
  UserRepository,
} from '../ports/store.js';

/** pg Pool / PoolClient 的公共查询面。 */
interface Executor {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new TypeError(`identity pg: 期望 timestamptz，实际 ${typeof value}`);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError(`identity pg: 期望 text，实际 ${typeof value}`);
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function rowToUser(row: Row): UserRecord {
  return {
    userId: text(row['user_id']),
    email: text(row['email']),
    passwordHash: text(row['password_hash']),
    userType: text(row['user_type']) as UserType,
    internalTier: nullableText(row['internal_tier']) as InternalTier | null,
    approvedBy: nullableText(row['approved_by']) as ApproverId | null,
    approvedAt: nullableIso(row['approved_at']),
    approvalRef: nullableText(row['approval_ref']),
    sessionVersion: Number(row['session_version']),
    accountLocked: row['account_locked'] === true,
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

function rowToApplication(row: Row): InternalApplication {
  return {
    applicationId: text(row['application_id']),
    userId: text(row['user_id']),
    status: text(row['status']) as ApplicationStatus,
    companyEmail: text(row['company_email']),
    inviteCodeRef: nullableText(row['invite_code_ref']),
    sourceIpHash: nullableText(row['source_ip_hash']),
    requestedAt: iso(row['requested_at']),
    proposedInternalTier: nullableText(row['proposed_internal_tier']) as InternalTier | null,
    decidedAt: nullableIso(row['decided_at']),
    decidedBy: nullableText(row['decided_by']) as ApproverId | null,
    decisionRef: nullableText(row['decision_ref']),
    decisionReason: nullableText(row['decision_reason']),
  };
}

const USER_COLUMNS = `user_id, email, password_hash, user_type, internal_tier, approved_by,
  approved_at, approval_ref, session_version, account_locked, created_at, updated_at`;

const APPLICATION_COLUMNS = `application_id, user_id, status, company_email, invite_code_ref,
  source_ip_hash, requested_at, proposed_internal_tier, decided_at, decided_by, decision_ref,
  decision_reason`;

class PgUserRepository implements UserRepository {
  constructor(private readonly db: Executor) {}

  async findById(userId: string): Promise<UserRecord | null> {
    const result = await this.db.query(
      `SELECT ${USER_COLUMNS} FROM identity.users WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToUser(row);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.db.query(
      `SELECT ${USER_COLUMNS} FROM identity.users WHERE email = $1`,
      [email],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToUser(row);
  }

  async insertIfAbsent(user: UserRecord): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO identity.users (${USER_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (email) DO NOTHING
       RETURNING user_id`,
      [
        user.userId,
        user.email,
        user.passwordHash,
        user.userType,
        user.internalTier,
        user.approvedBy,
        user.approvedAt,
        user.approvalRef,
        user.sessionVersion,
        user.accountLocked,
        user.createdAt,
        user.updatedAt,
      ],
    );
    return result.rows.length > 0;
  }

  async update(user: UserRecord, expectedSessionVersion: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE identity.users SET
         password_hash = $2, user_type = $3, internal_tier = $4, approved_by = $5,
         approved_at = $6, approval_ref = $7, session_version = $8, account_locked = $9,
         updated_at = $10
       WHERE user_id = $1 AND session_version = $11
       RETURNING user_id`,
      [
        user.userId,
        user.passwordHash,
        user.userType,
        user.internalTier,
        user.approvedBy,
        user.approvedAt,
        user.approvalRef,
        user.sessionVersion,
        user.accountLocked,
        user.updatedAt,
        expectedSessionVersion,
      ],
    );
    return result.rows.length > 0;
  }
}

class PgApplicationRepository implements ApplicationRepository {
  constructor(private readonly db: Executor) {}

  async findById(applicationId: string): Promise<InternalApplication | null> {
    const result = await this.db.query(
      `SELECT ${APPLICATION_COLUMNS} FROM identity.internal_applications WHERE application_id = $1`,
      [applicationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToApplication(row);
  }

  async findPendingByUserId(userId: string): Promise<InternalApplication | null> {
    const result = await this.db.query(
      `SELECT ${APPLICATION_COLUMNS} FROM identity.internal_applications
       WHERE user_id = $1 AND status = 'pending'`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToApplication(row);
  }

  async insertIfAbsent(application: InternalApplication): Promise<boolean> {
    try {
      const result = await this.db.query(
        `INSERT INTO identity.internal_applications (${APPLICATION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (application_id) DO NOTHING
         RETURNING application_id`,
        [
          application.applicationId,
          application.userId,
          application.status,
          application.companyEmail,
          application.inviteCodeRef,
          application.sourceIpHash,
          application.requestedAt,
          application.proposedInternalTier,
          application.decidedAt,
          application.decidedBy,
          application.decisionRef,
          application.decisionReason,
        ],
      );
      return result.rows.length > 0;
    } catch (error) {
      // 同一用户只能有一条 pending 申请（部分唯一索引 uq_internal_applications_pending）。
      if ((error as { code?: unknown }).code === '23505') {
        return false;
      }
      throw error;
    }
  }

  async update(application: InternalApplication, expectedStatus: ApplicationStatus): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE identity.internal_applications SET
         status = $2, decided_at = $3, decided_by = $4, decision_ref = $5, decision_reason = $6
       WHERE application_id = $1 AND status = $7
       RETURNING application_id`,
      [
        application.applicationId,
        application.status,
        application.decidedAt,
        application.decidedBy,
        application.decisionRef,
        application.decisionReason,
        expectedStatus,
      ],
    );
    return result.rows.length > 0;
  }
}

class PgAuditSink implements AuditSink {
  constructor(private readonly db: Executor) {}

  async record(event: IdentityAuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO identity.audit_events (
         event_id, event_type, occurred_at, actor_kind, actor_id, actor_model_version,
         subject_user_id, subject_application_id, before_state, after_state, reason, approval_ref
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        `aud_${uuidv7()}`,
        event.eventType,
        event.occurredAt,
        event.actor.kind,
        event.actor.id,
        event.actor.modelVersion ?? null,
        event.subjectUserId,
        event.subjectApplicationId,
        event.before === null ? null : JSON.stringify(event.before),
        event.after === null ? null : JSON.stringify(event.after),
        event.reason,
        event.approvalRef,
      ],
    );
  }
}

export interface PgIdentityStoreOptions {
  /** 复用外壳/测试的 pool（不负责关闭）。 */
  readonly pool?: Pool;
  /** 自建 pool 的连接串（缺省读 PG* 环境变量）；由调用方 `close()` 释放。 */
  readonly connectionString?: string;
}

export class PgIdentityStore implements IdentityStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  readonly audit: AuditSink;

  constructor(options: PgIdentityStoreOptions = {}) {
    if (options.pool !== undefined) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool(
        options.connectionString === undefined
          ? {}
          : { connectionString: options.connectionString },
      );
      this.ownsPool = true;
    }
    this.audit = new PgAuditSink(this.pool as unknown as Executor);
  }

  private static repositories(db: Executor): IdentityRepositories {
    return {
      users: new PgUserRepository(db),
      applications: new PgApplicationRepository(db),
      audit: new PgAuditSink(db),
    };
  }

  private get baseRepositories(): IdentityRepositories {
    return PgIdentityStore.repositories(this.pool as unknown as Executor);
  }

  async runInTransaction<T>(work: (repos: IdentityRepositories) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const db = client as unknown as Executor;
    try {
      await client.query('BEGIN');
      const result = await work(PgIdentityStore.repositories(db));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 供只读入口使用（注册/登录路径都在事务里，这里仅为接口完整性）。 */
  get users(): UserRepository {
    return this.baseRepositories.users;
  }

  get applications(): ApplicationRepository {
    return this.baseRepositories.applications;
  }

  /** 仅当 pool 由本实例创建时生效。 */
  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
