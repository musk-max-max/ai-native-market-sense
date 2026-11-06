/**
 * 仓储端口（hexagonal）：领域服务只依赖这些接口，PG / 内存实现可替换。
 *
 * 并发约束（P0 必须显式）：
 *   - `users.insertIfAbsent` 原子防重（email 唯一），否则并发注册可双写；
 *   - `users.update(user, expectedSessionVersion)` 乐观并发：审批/停用/改档都基于读到的版本，
 *     两个人同时审批同一申请时只有一个能成功（ADR-008「单条审批、审批留痕」）；
 *   - `applications.update(..., expectedStatus)` 保证 pending→approved/rejected 只发生一次。
 *
 * `IdentityStore.runInTransaction` 让「改用户 + 改申请 + 写审计」原子提交；
 * 内存实现无隔离（仅测试用），PG 实现使用真实事务（见 adapters/pg-store.ts）。
 */

import type { AuditSink } from './audit-sink.js';
import type { ApplicationStatus, InternalApplication, UserRecord } from '../domain/types.js';

export interface UserRepository {
  findById(userId: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /** @returns false = email 已存在（UNIQUE 冲突，不回滚外层事务）。 */
  insertIfAbsent(user: UserRecord): Promise<boolean>;
  /** @returns false = 版本不一致（说明有并发写），调用方应 fail-closed。 */
  update(user: UserRecord, expectedSessionVersion: number): Promise<boolean>;
}

export interface ApplicationRepository {
  findById(applicationId: string): Promise<InternalApplication | null>;
  findPendingByUserId(userId: string): Promise<InternalApplication | null>;
  insertIfAbsent(application: InternalApplication): Promise<boolean>;
  update(application: InternalApplication, expectedStatus: ApplicationStatus): Promise<boolean>;
}

export interface IdentityRepositories {
  readonly users: UserRepository;
  readonly applications: ApplicationRepository;
  readonly audit: AuditSink;
}

export interface IdentityStore extends IdentityRepositories {
  runInTransaction<T>(work: (repos: IdentityRepositories) => Promise<T>): Promise<T>;
}
