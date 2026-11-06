/**
 * 内存存储实现（测试与 E2E_MODE 本地用）；语义与 Pg 实现一致：
 * 账本 append-only（此处由 API 保证，不导出 update/delete）、hash 链、幂等 PK、发布指针唯一。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { computeEventHash, GENESIS_HASH, type EventDraft, type LedgerEvent, type StoredApplication } from '../domain/ledger.js';
import type {
  ApprovalAuditEvent,
  ApplicationFilter,
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
import type { Environment } from '../domain/types.js';

function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(`${sortKey}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep < 0) return null;
    return { sortKey: raw.slice(0, sep), id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

function keysetPage<T>(
  rows: T[],
  limit: number,
  cursor: string | undefined,
  keyOf: (row: T) => { sortKey: string; id: string },
): ListResult<T> {
  const sorted = [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka.sortKey !== kb.sortKey) return ka.sortKey < kb.sortKey ? 1 : -1;
    return ka.id < kb.id ? 1 : -1;
  });
  let start = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (decoded !== null) {
      start = sorted.findIndex((row) => {
        const key = keyOf(row);
        return key.sortKey === decoded.sortKey && key.id === decoded.id;
      }) + 1;
      if (start === 0) start = sorted.length;
    }
  }
  const page = sorted.slice(start, start + limit + 1);
  const hasMore = page.length > limit;
  const items = hasMore ? page.slice(0, limit) : page;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last !== undefined ? (() => {
      const key = keyOf(last);
      return encodeCursor(key.sortKey, key.id);
    })() : null,
  };
}

export class MemoryDomainStore implements DomainStore {
  private applications = new Map<string, StoredApplication>();
  private events = new Map<string, LedgerEvent[]>();
  private idempotency = new Map<string, IdempotentRecord>();
  private configs = new Map<string, StoredConfig>();
  private versions = new Map<string, StoredVersionRow>();
  private bindings = new Map<string, ReleaseBinding>();
  private releases = new Map<string, StoredRelease>();
  readonly auditLog: ApprovalAuditEvent[] = [];
  /** 事务重入标记：同一异步链上的嵌套 transaction 并入外层。 */
  private readonly txScope = new AsyncLocalStorage<true>();
  /** 顶层事务串行队列：避免并发事务交错读到半提交状态。 */
  private txChain: Promise<unknown> = Promise.resolve();

  async insertApplicationWithCreatedEvent(input: CreateApplicationInput): Promise<LedgerEvent> {
    const existing = this.applications.get(input.application.approvalRef);
    if (existing !== undefined) {
      throw new Error('duplicate approval_ref');
    }
    this.applications.set(input.application.approvalRef, input.application);
    const draft: LedgerEvent = { ...input.event, seq: 1, prevEventHash: GENESIS_HASH, eventHash: '' };
    const event: LedgerEvent = { ...draft, eventHash: computeEventHash(draft) };
    this.events.set(input.application.approvalRef, [event]);
    return event;
  }

  async getApplication(approvalRef: string): Promise<{ application: StoredApplication; events: LedgerEvent[] } | null> {
    const application = this.applications.get(approvalRef);
    if (application === undefined) return null;
    return { application, events: [...(this.events.get(approvalRef) ?? [])] };
  }

  async listApplications(filter: ApplicationFilter): Promise<ListResult<StoredApplication>> {
    const rows = [...this.applications.values()].filter((app) => {
      if (filter.environment !== undefined && app.subject.environment !== filter.environment) return false;
      if (filter.flow !== undefined && app.flow !== filter.flow) return false;
      if (filter.status !== undefined && app.status !== filter.status) return false;
      if (filter.applicantId !== undefined && app.applicant.id !== filter.applicantId) return false;
      if (filter.from !== undefined && app.createdAt < filter.from) return false;
      if (filter.to !== undefined && app.createdAt > filter.to) return false;
      return true;
    });
    return keysetPage(rows, filter.limit, filter.cursor, (app) => ({ sortKey: app.createdAt, id: app.approvalRef }));
  }

  async appendEvent(approvalRef: string, event: EventDraft): Promise<LedgerEvent> {
    const ledger = this.events.get(approvalRef);
    if (ledger === undefined) {
      throw new Error('appendEvent: unknown approval_ref');
    }
    const last = ledger[ledger.length - 1];
    const full: LedgerEvent = {
      ...event,
      seq: (last?.seq ?? 0) + 1,
      prevEventHash: last?.eventHash ?? GENESIS_HASH,
      eventHash: '',
    };
    const stored: LedgerEvent = { ...full, eventHash: computeEventHash(full) };
    ledger.push(stored);
    const app = this.applications.get(approvalRef);
    if (app !== undefined) {
      // status 是 fold 投影的缓存列（权威在事件）。
      this.applications.set(approvalRef, { ...app, status: stored.type === 'created' ? 'submitted' : stored.type, updatedAt: stored.at });
    }
    return stored;
  }

  async findIdempotent(scope: string, key: string): Promise<IdempotentRecord | null> {
    return this.idempotency.get(`${scope}|${key}`) ?? null;
  }

  async putIdempotent(record: IdempotentRecord): Promise<void> {
    this.idempotency.set(`${record.scope}|${record.key}`, record);
  }

  private configKey(configId: string, environment: Environment): string {
    return `${configId}|${environment}`;
  }

  async getConfig(configId: string, environment: Environment): Promise<StoredConfig | null> {
    return this.configs.get(this.configKey(configId, environment)) ?? null;
  }

  async upsertConfig(config: StoredConfig): Promise<StoredConfig> {
    this.configs.set(this.configKey(config.configId, config.environment), config);
    return config;
  }

  async insertVersionRow(row: StoredVersionRow): Promise<void> {
    this.versions.set(`${row.configId}|${row.environment}|${row.version}`, row);
  }

  async getVersionRow(configId: string, environment: Environment, version: number): Promise<StoredVersionRow | null> {
    return this.versions.get(`${configId}|${environment}|${version}`) ?? null;
  }

  async listConfigs(filter: ConfigFilter): Promise<ListResult<StoredConfig>> {
    const rows = [...this.configs.values()].filter((config) => {
      if (config.environment !== filter.environment) return false;
      if (filter.status !== undefined && config.status !== filter.status) return false;
      return true;
    });
    return keysetPage(rows, filter.limit, filter.cursor, (config) => ({ sortKey: config.updatedAt, id: this.configKey(config.configId, config.environment) }));
  }

  async insertBinding(binding: ReleaseBinding): Promise<void> {
    if (this.bindings.has(binding.approvalRef)) {
      throw new Error('duplicate binding');
    }
    this.bindings.set(binding.approvalRef, binding);
  }

  async getBinding(approvalRef: string): Promise<ReleaseBinding | null> {
    return this.bindings.get(approvalRef) ?? null;
  }

  async consumeBinding(approvalRef: string, consumedAt: string): Promise<ReleaseBinding | null> {
    const binding = this.bindings.get(approvalRef);
    if (binding === undefined || binding.consumedAt !== null) return null;
    const consumed: ReleaseBinding = { ...binding, consumedAt };
    this.bindings.set(approvalRef, consumed);
    return consumed;
  }

  async insertRelease(release: StoredRelease): Promise<StoredRelease> {
    this.releases.set(release.releaseId, release);
    return release;
  }

  async getRelease(releaseId: string): Promise<StoredRelease | null> {
    return this.releases.get(releaseId) ?? null;
  }

  async getCurrentRelease(configId: string, environment: Environment): Promise<StoredRelease | null> {
    for (const release of this.releases.values()) {
      if (release.configId === configId && release.environment === environment && release.isCurrent) {
        return release;
      }
    }
    return null;
  }

  async setCurrentRelease(configId: string, environment: Environment, releaseId: string): Promise<void> {
    for (const [id, release] of this.releases) {
      if (release.configId === configId && release.environment === environment) {
        this.releases.set(id, { ...release, isCurrent: id === releaseId });
      }
    }
  }

  async listReleases(filter: ReleaseFilter): Promise<ListResult<StoredRelease>> {
    const rows = [...this.releases.values()].filter((release) => {
      if (release.environment !== filter.environment) return false;
      if (filter.configId !== undefined && release.configId !== filter.configId) return false;
      return true;
    });
    return keysetPage(rows, filter.limit, filter.cursor, (release) => ({ sortKey: release.publishedAt, id: release.releaseId }));
  }

  async audit(event: ApprovalAuditEvent): Promise<void> {
    this.auditLog.push(event);
  }

  async transaction<T>(fn: (tx: DomainStore) => Promise<T>): Promise<T> {
    if (this.txScope.getStore() === true) {
      // 重入：并入外层事务（提交/回滚由外层负责）。
      return fn(this);
    }
    const run = async (): Promise<T> => {
      const snapshot = this.snapshot();
      try {
        return await this.txScope.run(true, () => fn(this));
      } catch (error) {
        // fn 抛错 → 恢复到入事务前状态（fail-closed，不留半截写）。
        this.restore(snapshot);
        throw error;
      }
    };
    const next = this.txChain.then(run, run);
    this.txChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async findActiveSubmission(input: {
    configId: string;
    environment: Environment;
    version: number;
  }): Promise<{ application: StoredApplication; binding: ReleaseBinding } | null> {
    for (const binding of this.bindings.values()) {
      if (
        binding.configId !== input.configId ||
        binding.environment !== input.environment ||
        binding.version !== input.version ||
        binding.consumedAt !== null
      ) {
        continue;
      }
      const application = this.applications.get(binding.approvalRef);
      if (application === undefined) continue;
      // rejected/expired 按 R9 允许重提新建单 → 不算活跃提交。
      if (application.status === 'rejected' || application.status === 'expired') continue;
      return { application, binding };
    }
    return null;
  }

  // ---- 事务快照（顶层事务失败 → 恢复到入事务前状态） ----

  private snapshot(): {
    applications: Map<string, StoredApplication>;
    events: Map<string, LedgerEvent[]>;
    idempotency: Map<string, IdempotentRecord>;
    configs: Map<string, StoredConfig>;
    versions: Map<string, StoredVersionRow>;
    bindings: Map<string, ReleaseBinding>;
    releases: Map<string, StoredRelease>;
    auditLength: number;
  } {
    return {
      applications: new Map(this.applications),
      events: new Map([...this.events].map(([ref, ledger]) => [ref, [...ledger]] as const)),
      idempotency: new Map(this.idempotency),
      configs: new Map(this.configs),
      versions: new Map(this.versions),
      bindings: new Map(this.bindings),
      releases: new Map(this.releases),
      auditLength: this.auditLog.length,
    };
  }

  private restore(state: ReturnType<MemoryDomainStore['snapshot']>): void {
    this.applications = state.applications;
    this.events = state.events;
    this.idempotency = state.idempotency;
    this.configs = state.configs;
    this.versions = state.versions;
    this.bindings = state.bindings;
    this.releases = state.releases;
    this.auditLog.length = state.auditLength;
  }
}
