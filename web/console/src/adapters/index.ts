/**
 * HTTP Console 服务工厂：组装 ConfigServicePort + ApprovalServicePort + AuditPort。
 *
 * 用法（App.tsx 接线示例，P1-6 完成后启用）：
 * ```ts
 * const services = createHttpConsoleServices({
 *   baseUrl: '/v1',           // 或完整 https://api.example.com/v1
 *   environment: 'dev',
 *   authHeaders: () => ({ authorization: `Bearer ${token}` }),
 * });
 * ```
 *
 * fetchImpl 默认取 globalThis.fetch；测试注入 fake fetch。
 */

import type { Environment } from './contract-types';
import type { ConsoleServices as ConsoleServicesPort } from '../lib/services';
import { HttpConfigService } from './http-config-service';
import { HttpApprovalService } from './http-approval-service';
import { HttpAuditService } from './http-audit-service';
import type { HttpFetch } from './http-common';

export interface CreateHttpConsoleServicesOptions {
  baseUrl: string;
  environment: Environment;
  authHeaders: () => Record<string, string>;
  fetchImpl?: HttpFetch;
  canaryPercent?: number;
  pageSize?: number;
}

/**
 * 组装 ConfigServicePort + ApprovalServicePort + AuditPort 成 App 依赖的 ConsoleServices。
 * 显式满足 lib/services.ts 的接口（extends 同三端口），App.tsx 无需 cast。
 */
export interface HttpConsoleServices extends ConsoleServicesPort {
  readonly config: HttpConfigService;
  readonly approval: HttpApprovalService;
  readonly audit: HttpAuditService;
}

export function createHttpConsoleServices(
  options: CreateHttpConsoleServicesOptions,
): HttpConsoleServices {
  const fetchImpl: HttpFetch = options.fetchImpl
    ?? (globalThis.fetch as unknown as HttpFetch);
  const config = new HttpConfigService({
    fetchImpl,
    baseUrl: options.baseUrl,
    environment: options.environment,
    authHeaders: options.authHeaders,
    canaryPercent: options.canaryPercent,
    pageSize: options.pageSize,
  });
  const approval = new HttpApprovalService({
    fetchImpl,
    baseUrl: options.baseUrl,
    environment: options.environment,
    authHeaders: options.authHeaders,
    pageSize: options.pageSize,
  });
  const audit = new HttpAuditService(fetchImpl, options.baseUrl, options.authHeaders);
  return {
    config,
    approval,
    audit,
    // 委托方法（App 直接持有 ConsoleServices 时使用，无需走 .config/.approval/.audit）。
    list: (...args) => config.list(...args),
    get: (...args) => config.get(...args),
    saveDraft: (...args) => config.saveDraft(...args),
    validate: (...args) => config.validate(...args),
    submitForApproval: (...args) => config.submitForApproval(...args),
    publish: (...args) => config.publish(...args),
    rollback: (...args) => config.rollback(...args),
    listReleases: (...args) => config.listReleases(...args),
    listPending: (...args) => approval.listPending(...args),
    approve: (...args) => approval.approve(...args),
    reject: (...args) => approval.reject(...args),
    listAudit: (...args) => audit.listAudit(...args),
  };
}

export { HttpConfigService } from './http-config-service';
export { HttpApprovalService, HttpApprovalEventReader } from './http-approval-service';
export { HttpAuditService } from './http-audit-service';
export { configIdForItemId, itemIdForConfigId } from './config-ids';
export { requestJson, HttpProblemError, newIdempotencyKey } from './http-common';
export type { HttpFetch, HttpProblemError as HttpProblemErrorClass } from './http-common';
export type {
  Environment,
  WireOpsConfigDocument,
  WireOpsConfigWrite,
  WireValidationReport,
  WireApprovalSubmission,
  WireRelease,
  WireRollback,
  WireApprovalApplication,
  WireApprovalDecision,
  WireApprovalEvent,
  WireConfigConflictProblem,
} from './contract-types';
