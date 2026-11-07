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
import { HttpConfigService } from './http-config-service';
import { HttpApprovalService } from './http-approval-service';
import { HttpAuditService } from './http-audit-service';
import type { HttpFetch } from './http-common';

export interface ConsoleServices {
  config: HttpConfigService;
  approval: HttpApprovalService;
  audit: HttpAuditService;
}

export interface CreateHttpConsoleServicesOptions {
  baseUrl: string;
  environment: Environment;
  authHeaders: () => Record<string, string>;
  fetchImpl?: HttpFetch;
  canaryPercent?: number;
  pageSize?: number;
}

export function createHttpConsoleServices(
  options: CreateHttpConsoleServicesOptions,
): ConsoleServices {
  const fetchImpl: HttpFetch = options.fetchImpl
    ?? (globalThis.fetch as unknown as HttpFetch);
  return {
    config: new HttpConfigService({
      fetchImpl,
      baseUrl: options.baseUrl,
      environment: options.environment,
      authHeaders: options.authHeaders,
      canaryPercent: options.canaryPercent,
      pageSize: options.pageSize,
    }),
    approval: new HttpApprovalService({
      fetchImpl,
      baseUrl: options.baseUrl,
      environment: options.environment,
      authHeaders: options.authHeaders,
      pageSize: options.pageSize,
    }),
    audit: new HttpAuditService(fetchImpl, options.baseUrl, options.authHeaders),
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
