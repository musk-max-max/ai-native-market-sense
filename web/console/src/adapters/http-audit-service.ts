/**
 * HTTP 实现 AuditPort。
 *
 * 契约事实（CONTRACT-MAP）：契约未见 audit 列表端点，等 A4 identity.AuditSink + A0 统一开放。
 * 当前实现返回空数组（fail-safe：不伪造审计条目）。
 * 后续 A4 暴露 GET /v1/internal/audit?actor&item_id&from&to 后，在此实现真实查询。
 */

import type { AuditEvent } from '../domain/types';
import type { HttpFetch } from './http-common';

export class HttpAuditService {
  private readonly fetchImpl: HttpFetch;

  constructor(fetchImpl: HttpFetch, _baseUrl: string, _authHeaders: () => Record<string, string>) {
    this.fetchImpl = fetchImpl;
    void this.fetchImpl;
  }

  async listAudit(): Promise<AuditEvent[]> {
    // 契约未见 audit 列表端点（CONTRACT-MAP 注「等 A4/A0」）。
    // 返回空数组，不伪造审计条目；UI 显示「审计留痕暂未接入」。
    return [];
  }
}
