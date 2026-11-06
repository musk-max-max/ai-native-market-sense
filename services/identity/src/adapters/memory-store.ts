/**
 * 内存实现（单测/E2E 夹具用）。
 *
 * 语义尽量贴近 PG：email 唯一、乐观并发（sessionVersion / status）、事务失败回滚用户与申请。
 * **审计不回滚**：失败操作的审计本身就是证据（与 PG 实现「同一事务」略有差异，见 README）。
 */

import type { AuditSink, IdentityAuditEvent } from '../ports/audit-sink.js';
import type {
  ApplicationRepository,
  IdentityRepositories,
  IdentityStore,
  UserRepository,
} from '../ports/store.js';
import type { ApplicationStatus, InternalApplication, UserRecord } from '../domain/types.js';

/** 供测试断言审计内容；只暴露只读拷贝。 */
export class MemoryAuditSink implements AuditSink {
  private readonly events: IdentityAuditEvent[] = [];

  async record(event: IdentityAuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  list(): readonly IdentityAuditEvent[] {
    return this.events.map((event) => structuredClone(event));
  }
}

class MemoryUserRepository implements UserRepository {
  constructor(
    private readonly users: Map<string, UserRecord>,
    private readonly emailIndex: Map<string, string>,
  ) {}

  async findById(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const userId = this.emailIndex.get(email);
    return userId === undefined ? null : (this.users.get(userId) ?? null);
  }

  async insertIfAbsent(user: UserRecord): Promise<boolean> {
    if (this.emailIndex.has(user.email) || this.users.has(user.userId)) {
      return false;
    }
    this.users.set(user.userId, user);
    this.emailIndex.set(user.email, user.userId);
    return true;
  }

  async update(user: UserRecord, expectedSessionVersion: number): Promise<boolean> {
    const current = this.users.get(user.userId);
    if (current === undefined || current.sessionVersion !== expectedSessionVersion) {
      return false;
    }
    this.users.set(user.userId, user);
    return true;
  }
}

class MemoryApplicationRepository implements ApplicationRepository {
  constructor(
    private readonly applications: Map<string, InternalApplication>,
    private readonly pendingByUser: Map<string, string>,
  ) {}

  async findById(applicationId: string): Promise<InternalApplication | null> {
    return this.applications.get(applicationId) ?? null;
  }

  async findPendingByUserId(userId: string): Promise<InternalApplication | null> {
    const applicationId = this.pendingByUser.get(userId);
    return applicationId === undefined ? null : (this.applications.get(applicationId) ?? null);
  }

  async insertIfAbsent(application: InternalApplication): Promise<boolean> {
    if (this.applications.has(application.applicationId)) {
      return false;
    }
    if (application.status === 'pending' && this.pendingByUser.has(application.userId)) {
      return false;
    }
    this.applications.set(application.applicationId, application);
    if (application.status === 'pending') {
      this.pendingByUser.set(application.userId, application.applicationId);
    }
    return true;
  }

  async update(application: InternalApplication, expectedStatus: ApplicationStatus): Promise<boolean> {
    const current = this.applications.get(application.applicationId);
    if (current === undefined || current.status !== expectedStatus) {
      return false;
    }
    this.applications.set(application.applicationId, application);
    if (current.status === 'pending' && application.status !== 'pending') {
      this.pendingByUser.delete(current.userId);
    }
    return true;
  }
}

export class MemoryIdentityStore implements IdentityStore {
  private userMap = new Map<string, UserRecord>();
  private emailIndex = new Map<string, string>();
  private applicationMap = new Map<string, InternalApplication>();
  private pendingByUser = new Map<string, string>();

  readonly audit: AuditSink;

  constructor(audit: AuditSink = new MemoryAuditSink()) {
    this.audit = audit;
  }

  get users(): UserRepository {
    return new MemoryUserRepository(this.userMap, this.emailIndex);
  }

  get applications(): ApplicationRepository {
    return new MemoryApplicationRepository(this.applicationMap, this.pendingByUser);
  }

  private repositories(): IdentityRepositories {
    return {
      users: this.users,
      applications: this.applications,
      audit: this.audit,
    };
  }

  async runInTransaction<T>(work: (repos: IdentityRepositories) => Promise<T>): Promise<T> {
    const usersSnapshot = new Map(this.userMap);
    const emailSnapshot = new Map(this.emailIndex);
    const applicationsSnapshot = new Map(this.applicationMap);
    const pendingSnapshot = new Map(this.pendingByUser);
    try {
      return await work(this.repositories());
    } catch (error) {
      this.userMap = usersSnapshot;
      this.emailIndex = emailSnapshot;
      this.applicationMap = applicationsSnapshot;
      this.pendingByUser = pendingSnapshot;
      throw error;
    }
  }
}
