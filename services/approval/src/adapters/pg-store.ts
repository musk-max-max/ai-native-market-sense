/**
 * DomainStore 的 PostgreSQL 实现（A4）。
 *
 * 表结构真源：services/approval/migrations/001_approval.sql（单事务幂等；已部署迁移永不改，只新增）。
 * 连接参数按 decisions L73/L76/L77：connectionTimeoutMillis 1000 / query_timeout 2000 / statement_timeout 2000。
 * 每个 DomainStore 方法 = 一事务边界（多语句方法显式 BEGIN/COMMIT，出错 ROLLBACK）。
 */

import pg from 'pg';
import type {
  ApplicationFilter,
  ApprovalAuditEvent,
  ConfigFilter,
  CreateApplicationInput,
  DomainStore,
  IdempotentRecord,
  ListResult,
  ReleaseBinding,
  ReleaseFilter,
  StoredConfig,
  StoredRelease,
  StoredVersionRow,
} from '../ports/stores.js';
import type { EventDraft, LedgerEvent, StoredApplication } from '../domain/ledger.js';
import type { Environment } from '../domain/types.js';
import { GENESIS_HASH, computeEventHash } from '../domain/ledger.js';

export interface PgDomainStoreOptions {
  connectionString: string;
  pool?: pg.Pool;
}

function toEvent(row: Record<string, unknown>): LedgerEvent {
  return {
    eventId: row['event_id'] as string,
    approvalRef: row['approval_ref'] as string,
    seq: row['seq'] as number,
    type: row['type'] as LedgerEvent['type'],
    at: row['at'] as string,
    actor: (row['actor'] ?? null) as LedgerEvent['actor'],
    evaluation: (row['evaluation'] ?? null) as LedgerEvent['evaluation'],
    decision: (row['decision'] ?? null) as LedgerEvent['decision'],
    note: (row['note'] ?? null) as LedgerEvent['note'],
    prevEventHash: row['prev_event_hash'] as string,
    eventHash: row['event_hash'] as string,
  };
}

function toApplication(row: Record<string, unknown>): StoredApplication {
  return {
    approvalRef: row['approval_ref'] as string,
    applicationId: row['application_id'] as string,
    flow: row['flow'] as StoredApplication['flow'],
    status: row['status'] as StoredApplication['status'],
    applicant: row['applicant'] as StoredApplication['applicant'],
    beneficiary: (row['beneficiary'] ?? null) as StoredApplication['beneficiary'],
    executor: (row['executor'] ?? null) as StoredApplication['executor'],
    subject: row['subject'] as StoredApplication['subject'],
    change: row['change'] as StoredApplication['change'],
    evidence: (row['evidence'] ?? null) as StoredApplication['evidence'],
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function toConfig(row: Record<string, unknown>): StoredConfig {
  return {
    configId: row['config_id'] as string,
    environment: row['environment'] as StoredConfig['environment'],
    version: row['version'] as number,
    status: row['status'] as StoredConfig['status'],
    schemaVersion: row['schema_version'] as string,
    changeReason: row['change_reason'] as string,
    impactScope: row['impact_scope'] as StoredConfig['impactScope'],
    spec: row['spec'] as StoredConfig['spec'],
    createdBy: row['created_by'] as StoredConfig['createdBy'],
    updatedBy: row['updated_by'] as StoredConfig['updatedBy'],
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function toRelease(row: Record<string, unknown>): StoredRelease {
  return {
    releaseId: row['release_id'] as string,
    configId: row['config_id'] as string,
    environment: row['environment'] as StoredRelease['environment'],
    version: row['version'] as number,
    schemaVersion: row['schema_version'] as string,
    policyVersion: row['policy_version'] as string,
    contentHash: row['content_hash'] as string,
    publishedAt: row['published_at'] as string,
    approvalRef: row['approval_ref'] as string,
    canaryPercent: row['canary_percent'] as number,
    releaseNotes: (row['release_notes'] ?? null) as StoredRelease['releaseNotes'],
    previousReleaseId: (row['previous_release_id'] ?? null) as StoredRelease['previousReleaseId'],
    isCurrent: row['is_current'] as boolean,
  };
}

/** Pool 与事务连接共用的最小查询面（Pool|PoolClient 联合类型的方法签名不可直接调用）。 */
interface PgQueryable {
  query(text: string, values?: readonly unknown[]): Promise<pg.QueryResult>;
}

export class PgDomainStore implements DomainStore {
  private readonly pool: pg.Pool;
  private readonly ownPool: boolean;
  /** 非空 = 处于事务中：所有读写走该连接（同一事务内可见彼此未提交写）。 */
  private executor: pg.PoolClient | null = null;

  constructor(options: PgDomainStoreOptions) {
    this.pool =
      options.pool ??
      new pg.Pool({
        connectionString: options.connectionString,
        connectionTimeoutMillis: 1000,
        query_timeout: 2000,
        statement_timeout: 2000,
      });
    this.ownPool = options.pool === undefined;
  }

  async insertApplicationWithCreatedEvent(input: CreateApplicationInput): Promise<LedgerEvent> {
    return this.inTx(async (client) => {
      await client.query(
        `INSERT INTO approval.applications
           (approval_ref, application_id, flow, status, applicant, beneficiary, executor, subject, change, evidence, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          input.application.approvalRef,
          input.application.applicationId,
          input.application.flow,
          input.application.status,
          JSON.stringify(input.application.applicant),
          JSON.stringify(input.application.beneficiary ?? null),
          JSON.stringify(input.application.executor ?? null),
          JSON.stringify(input.application.subject),
          JSON.stringify(input.application.change),
          JSON.stringify(input.application.evidence ?? null),
          input.application.createdAt,
          input.application.updatedAt,
        ],
      );
      const event = this.composeEvent(input.event, 1, GENESIS_HASH);
      await this.insertEvent(client, event);
      return event;
    });
  }

  async getApplication(approvalRef: string): Promise<{ application: StoredApplication; events: LedgerEvent[] } | null> {
    const app = await this.db().query('SELECT * FROM approval.applications WHERE approval_ref = $1', [approvalRef]);
    if (app.rows.length === 0) return null;
    const events = await this.db().query('SELECT * FROM approval.events WHERE approval_ref = $1 ORDER BY seq ASC', [approvalRef]);
    return { application: toApplication(app.rows[0]), events: events.rows.map(toEvent) };
  }

  async listApplications(filter: ApplicationFilter): Promise<ListResult<StoredApplication>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.environment) add("subject->>'environment' = ?", filter.environment);
    if (filter.flow) add('flow = ?', filter.flow);
    if (filter.status) add('status = ?', filter.status);
    if (filter.applicantId) add("applicant->>'id' = ?", filter.applicantId);
    if (filter.from) add('created_at >= ?', filter.from);
    if (filter.to) add('created_at <= ?', filter.to);
    if (filter.cursor) {
      const [sortKey, id] = this.decodeCursor(filter.cursor);
      params.push(sortKey, id);
      where.push(`(created_at, approval_ref) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(filter.limit + 1);
    const sql = `SELECT * FROM approval.applications ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, approval_ref DESC LIMIT $${params.length}`;
    const result = await this.db().query(sql, params);
    const items = result.rows.slice(0, filter.limit).map(toApplication);
    const last = items.at(-1);
    const nextCursor =
      result.rows.length > filter.limit && last ? this.encodeCursor(last.createdAt, last.approvalRef) : null;
    return { items, nextCursor };
  }

  async appendEvent(approvalRef: string, event: EventDraft): Promise<LedgerEvent> {
    return this.inTx(async (client) => {
      const last = await client.query(
        'SELECT seq, event_hash FROM approval.events WHERE approval_ref = $1 ORDER BY seq DESC LIMIT 1 FOR UPDATE',
        [approvalRef],
      );
      const prev = last.rows[0];
      const composed = this.composeEvent(event, (prev?.['seq'] as number) + 1, (prev?.['event_hash'] as string) ?? GENESIS_HASH);
      await this.insertEvent(client, composed);
      await client.query('UPDATE approval.applications SET status = $2, updated_at = $3 WHERE approval_ref = $1', [
        approvalRef,
        this.statusFor(composed.type),
        composed.at,
      ]);
      return composed;
    });
  }

  async findIdempotent(scope: string, key: string): Promise<IdempotentRecord | null> {
    const result = await this.db().query('SELECT * FROM approval.idempotency WHERE scope = $1 AND idempotency_key = $2', [scope, key]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      scope: row['scope'] as string,
      key: row['idempotency_key'] as string,
      requestHash: row['request_hash'] as string,
      approvalRef: row['approval_ref'] as string,
      response: row['response'],
      createdAt: row['created_at'] as string,
    };
  }

  async putIdempotent(record: IdempotentRecord): Promise<void> {
    await this.db().query(
      `INSERT INTO approval.idempotency (scope, idempotency_key, request_hash, approval_ref, response, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (scope, idempotency_key) DO NOTHING`,
      [record.scope, record.key, record.requestHash, record.approvalRef, JSON.stringify(record.response), record.createdAt],
    );
  }

  async getConfig(configId: string, environment: string): Promise<StoredConfig | null> {
    const result = await this.db().query('SELECT * FROM approval.ops_configs WHERE config_id = $1 AND environment = $2', [configId, environment]);
    return result.rows.length > 0 ? toConfig(result.rows[0]) : null;
  }

  async upsertConfig(config: StoredConfig): Promise<StoredConfig> {
    await this.db().query(
      `INSERT INTO approval.ops_configs
         (config_id, environment, version, status, schema_version, change_reason, impact_scope, spec, created_by, updated_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (config_id, environment) DO UPDATE SET
         version = EXCLUDED.version, status = EXCLUDED.status, schema_version = EXCLUDED.schema_version,
         change_reason = EXCLUDED.change_reason, impact_scope = EXCLUDED.impact_scope, spec = EXCLUDED.spec,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [
        config.configId,
        config.environment,
        config.version,
        config.status,
        config.schemaVersion,
        config.changeReason,
        JSON.stringify(config.impactScope),
        JSON.stringify(config.spec),
        JSON.stringify(config.createdBy),
        JSON.stringify(config.updatedBy),
        config.createdAt,
        config.updatedAt,
      ],
    );
    return config;
  }

  async insertVersionRow(row: StoredVersionRow): Promise<void> {
    await this.db().query(
      `INSERT INTO approval.ops_config_versions (config_id, environment, version, spec, change_reason, impact_scope, saved_at, saved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (config_id, environment, version) DO NOTHING`,
      [row.configId, row.environment, row.version, JSON.stringify(row.spec), row.changeReason, JSON.stringify(row.impactScope), row.savedAt, JSON.stringify(row.savedBy)],
    );
  }

  async getVersionRow(configId: string, environment: string, version: number): Promise<StoredVersionRow | null> {
    const result = await this.db().query(
      'SELECT * FROM approval.ops_config_versions WHERE config_id = $1 AND environment = $2 AND version = $3',
      [configId, environment, version],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      configId: row['config_id'] as string,
      environment: row['environment'] as StoredVersionRow['environment'],
      version: row['version'] as number,
      spec: row['spec'] as StoredVersionRow['spec'],
      changeReason: row['change_reason'] as string,
      impactScope: row['impact_scope'] as StoredVersionRow['impactScope'],
      savedAt: row['saved_at'] as string,
      savedBy: row['saved_by'] as StoredVersionRow['savedBy'],
    };
  }

  async listConfigs(filter: ConfigFilter): Promise<ListResult<StoredConfig>> {
    const params: unknown[] = [filter.environment];
    let where = 'environment = $1';
    if (filter.status) {
      params.push(filter.status);
      where += ` AND status = $${params.length}`;
    }
    if (filter.cursor) {
      const [sortKey, id] = this.decodeCursor(filter.cursor);
      params.push(sortKey, id);
      where += ` AND (updated_at, config_id || '|' || environment) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(filter.limit + 1);
    const result = await this.db().query(
      `SELECT * FROM approval.ops_configs WHERE ${where} ORDER BY updated_at DESC, config_id DESC, environment DESC LIMIT $${params.length}`,
      params,
    );
    const items = result.rows.slice(0, filter.limit).map(toConfig);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        result.rows.length > filter.limit && last ? this.encodeCursor(last.updatedAt, `${last.configId}|${last.environment}`) : null,
    };
  }

  async insertBinding(binding: ReleaseBinding): Promise<void> {
    await this.db().query(
      `INSERT INTO approval.release_bindings (approval_ref, purpose, config_id, environment, version, policy_version, created_at, consumed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [binding.approvalRef, binding.purpose, binding.configId, binding.environment, binding.version, binding.policyVersion, binding.createdAt, binding.consumedAt],
    );
  }

  async getBinding(approvalRef: string): Promise<ReleaseBinding | null> {
    const result = await this.db().query('SELECT * FROM approval.release_bindings WHERE approval_ref = $1', [approvalRef]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      approvalRef: row['approval_ref'] as string,
      purpose: row['purpose'] as ReleaseBinding['purpose'],
      configId: row['config_id'] as string,
      environment: row['environment'] as ReleaseBinding['environment'],
      version: row['version'] as number,
      policyVersion: row['policy_version'] as string,
      createdAt: row['created_at'] as string,
      consumedAt: (row['consumed_at'] ?? null) as string | null,
    };
  }

  async consumeBinding(approvalRef: string, consumedAt: string): Promise<ReleaseBinding | null> {
    const result = await this.db().query(
      'UPDATE approval.release_bindings SET consumed_at = $2 WHERE approval_ref = $1 AND consumed_at IS NULL RETURNING *',
      [approvalRef, consumedAt],
    );
    return result.rows.length > 0 ? this.getBinding(approvalRef) : null;
  }

  async insertRelease(release: StoredRelease): Promise<StoredRelease> {
    await this.db().query(
      `INSERT INTO approval.ops_releases
         (release_id, config_id, environment, version, schema_version, policy_version, content_hash, published_at, approval_ref, canary_percent, release_notes, previous_release_id, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        release.releaseId,
        release.configId,
        release.environment,
        release.version,
        release.schemaVersion,
        release.policyVersion,
        release.contentHash,
        release.publishedAt,
        release.approvalRef,
        release.canaryPercent,
        release.releaseNotes,
        release.previousReleaseId,
        release.isCurrent,
      ],
    );
    return release;
  }

  async getRelease(releaseId: string): Promise<StoredRelease | null> {
    const result = await this.db().query('SELECT * FROM approval.ops_releases WHERE release_id = $1', [releaseId]);
    return result.rows.length > 0 ? toRelease(result.rows[0]) : null;
  }

  async getCurrentRelease(configId: string, environment: string): Promise<StoredRelease | null> {
    const result = await this.db().query(
      'SELECT * FROM approval.ops_releases WHERE config_id = $1 AND environment = $2 AND is_current',
      [configId, environment],
    );
    return result.rows.length > 0 ? toRelease(result.rows[0]) : null;
  }

  async setCurrentRelease(configId: string, environment: Environment, releaseId: string): Promise<void> {
    await this.inTx(async (client) => {
      await client.query('UPDATE approval.ops_releases SET is_current = false WHERE config_id = $1 AND environment = $2', [configId, environment]);
      await client.query('UPDATE approval.ops_releases SET is_current = true WHERE release_id = $1', [releaseId]);
    });
  }

  async listReleases(filter: ReleaseFilter): Promise<ListResult<StoredRelease>> {
    const params: unknown[] = [filter.environment];
    let where = 'environment = $1';
    if (filter.configId) {
      params.push(filter.configId);
      where += ` AND config_id = $${params.length}`;
    }
    if (filter.cursor) {
      const [sortKey, id] = this.decodeCursor(filter.cursor);
      params.push(sortKey, id);
      where += ` AND (published_at, release_id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(filter.limit + 1);
    const result = await this.db().query(
      `SELECT * FROM approval.ops_releases WHERE ${where} ORDER BY published_at DESC, release_id DESC LIMIT $${params.length}`,
      params,
    );
    const items = result.rows.slice(0, filter.limit).map(toRelease);
    const last = items.at(-1);
    return {
      items,
      nextCursor: result.rows.length > filter.limit && last ? this.encodeCursor(last.publishedAt, last.releaseId) : null,
    };
  }

  async audit(event: ApprovalAuditEvent): Promise<void> {
    await this.db().query(
      `INSERT INTO approval.audit_events
         (event_id, event_type, occurred_at, actor_kind, actor_id, actor_model_version, subject_kind, subject_id, before_state, after_state, reason, approval_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        event.eventId,
        event.eventType,
        event.occurredAt,
        event.actor.kind,
        event.actor.id,
        event.actor.kind === 'agent' ? event.actor.model_version : null,
        event.subjectKind,
        event.subjectId,
        JSON.stringify(event.before ?? null),
        JSON.stringify(event.after ?? null),
        event.reason,
        event.approvalRef,
      ],
    );
  }

  async close(): Promise<void> {
    if (this.ownPool) await this.pool.end();
  }

  async transaction<T>(fn: (tx: DomainStore) => Promise<T>): Promise<T> {
    if (this.executor !== null) {
      // 重入：并入外层事务（提交/回滚由外层负责）。
      return fn(this);
    }
    const client = await this.pool.connect();
    const tx = Object.create(this) as PgDomainStore;
    tx.executor = client;
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // BEGIN/COMMIT 自身失败时 ROLLBACK 可能同样失败；保留原始错误上抛。
      }
      throw error;
    } finally {
      tx.executor = null;
      client.release();
    }
  }

  async findActiveSubmission(input: {
    configId: string;
    environment: Environment;
    version: number;
  }): Promise<{ application: StoredApplication; binding: ReleaseBinding } | null> {
    const result = await this.db().query(
      `SELECT b.approval_ref AS binding_ref, b.purpose, b.config_id, b.environment, b.version,
              b.policy_version, b.created_at AS binding_created_at, b.consumed_at, a.*
       FROM approval.release_bindings b
       JOIN approval.applications a ON a.approval_ref = b.approval_ref
       WHERE b.config_id = $1 AND b.environment = $2 AND b.version = $3 AND b.consumed_at IS NULL
       ORDER BY b.created_at ASC`,
      [input.configId, input.environment, input.version],
    );
    for (const row of result.rows) {
      const application = toApplication(row);
      // rejected/expired 按 R9 允许重提新建单 → 不算活跃提交。
      if (application.status === 'rejected' || application.status === 'expired') continue;
      const binding: ReleaseBinding = {
        approvalRef: row['binding_ref'] as string,
        purpose: row['purpose'] as ReleaseBinding['purpose'],
        configId: row['config_id'] as string,
        environment: row['environment'] as ReleaseBinding['environment'],
        version: row['version'] as number,
        policyVersion: row['policy_version'] as string,
        createdAt: row['binding_created_at'] as string,
        consumedAt: (row['consumed_at'] ?? null) as string | null,
      };
      return { application, binding };
    }
    return null;
  }

  // ---- 私有 ----

  /** 事务内走当前事务连接，事务外走连接池；读写同连接才能看见未提交写。 */
  private db(): PgQueryable {
    return this.executor ?? this.pool;
  }

  /** 多语句方法的执行器：已在事务中 → 直接并入；否则自开 BEGIN/COMMIT/ROLLBACK。 */
  private async inTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (this.executor !== null) return fn(this.executor);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 同 transaction()：保留原始错误上抛。
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private composeEvent(event: EventDraft, seq: number, prevEventHash: string): LedgerEvent {
    const full: LedgerEvent = { ...event, seq, prevEventHash, eventHash: '' };
    return { ...full, eventHash: computeEventHash(full) };
  }

  private async insertEvent(client: pg.PoolClient, event: LedgerEvent): Promise<void> {
    await client.query(
      `INSERT INTO approval.events (event_id, approval_ref, seq, type, at, actor, evaluation, decision, note, prev_event_hash, event_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        event.eventId,
        event.approvalRef,
        event.seq,
        event.type,
        event.at,
        JSON.stringify(event.actor ?? null),
        JSON.stringify(event.evaluation ?? null),
        JSON.stringify(event.decision ?? null),
        event.note,
        event.prevEventHash,
        event.eventHash,
      ],
    );
  }

  private statusFor(type: LedgerEvent['type']): StoredApplication['status'] {
    return type === 'created' ? 'submitted' : (type as StoredApplication['status']);
  }

  private encodeCursor(sortKey: string, id: string): string {
    return Buffer.from(`${sortKey}|${id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): [string, string] {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const index = decoded.indexOf('|');
    return [decoded.slice(0, index), decoded.slice(index + 1)];
  }
}
