/**
 * HTTP 实现 ApprovalServicePort（contracts/approval/openapi.yaml）。
 *
 * 契约事实：
 * - GET  /v1/internal/approvals?environment&limit → WireList<WireApprovalApplication>
 * - POST /v1/internal/approvals/{approval_ref}/decision（Idempotency-Key，reason≥8）→ WireApprovalDecision
 * - POST /v1/internal/approvals/{approval_ref}/evaluate（调度器/规则引擎用，UI 不提供）
 * - GET  /v1/internal/approvals/{approval_ref}/events → WireList<WireApprovalEvent>（审计）
 *
 * approval_ref 寻址（非 changeRequestId）；decision 必填 reason≥8（「通过」也必填，合规留痕）；
 * 人类主体单条审批；agent 抛 ApprovalAuthorityError('AGENT_CANNOT_FINAL_APPROVE')。
 * UI 不提供 batch 方法（API 约束）。
 */

import type { Actor, ApprovalItemView, ChangeRequest, ConfigValues, ImpactItem } from '../domain/types';
import { ApprovalAuthorityError, ConfigGateError } from '../mocks/ports';
import type { ApproveInput, RejectInput } from '../mocks/ports';
import { requestJson, newIdempotencyKey } from './http-common';
import type { HttpFetch, HttpRequestOptions } from './http-common';
import { itemIdForConfigId } from './config-ids';
import type {
  Environment,
  WireApprovalApplication,
  WireApprovalDecision,
  WireApprovalDecisionRequest,
  WireApprovalEvent,
} from './contract-types';

export interface HttpApprovalServiceOptions {
  fetchImpl: HttpFetch;
  baseUrl: string;
  environment: Environment;
  authHeaders: () => Record<string, string>;
  pageSize?: number;
}

export class HttpApprovalService {
  private readonly fetchImpl: HttpFetch;
  private readonly baseUrl: string;
  private readonly environment: Environment;
  private readonly authHeaders: () => Record<string, string>;
  private readonly pageSize: number;

  constructor(options: HttpApprovalServiceOptions) {
    this.fetchImpl = options.fetchImpl;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.environment = options.environment;
    this.authHeaders = options.authHeaders;
    this.pageSize = options.pageSize ?? 20;
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) qs.set(key, String(value));
    }
    const suffix = qs.toString();
    return `${this.baseUrl}${path}${suffix ? `?${suffix}` : ''}`;
  }

  private async request(
    path: string,
    options: Omit<HttpRequestOptions, 'headers'> & { headers?: Record<string, string> },
    query?: Record<string, string | number | undefined>,
  ) {
    return requestJson(this.fetchImpl, this.url(path, query), this.authHeaders, options);
  }

  /** listApprovals → ApprovalItemView[]（只暴露 ops_config 域 pending 状态；UI 不提供 batch）。 */
  async listPending(): Promise<ApprovalItemView[]> {
    const { body } = await this.request('/v1/internal/approvals', { method: 'GET' }, {
      environment: this.environment,
      limit: this.pageSize,
    });
    const items = (body as { items?: WireApprovalApplication[] }).items ?? [];
    return items
      .filter((app) => app.subject.domain === 'ops_config')
      .filter((app) => app.status === 'submitted' || app.status === 'routed' || app.status === 'evaluated')
      .map((app) => this.toApprovalItemView(app));
  }

  /** decideApproval(approved) → ChangeRequest；agent 抛 AGENT_CANNOT_FINAL_APPROVE；reason 必填。 */
  async approve(input: ApproveInput): Promise<ChangeRequest> {
    if (input.actor.kind !== 'human') {
      throw new ApprovalAuthorityError(
        'AGENT_CANNOT_FINAL_APPROVE',
        'agent 不具备终审权（C1=A：A15 只是调度员，低风险由规则引擎放行）。',
      );
    }
    if (input.approvalRef.trim().length === 0) {
      throw new ApprovalAuthorityError('APPROVAL_REF_REQUIRED', '人类审批必须提供 approval_ref。');
    }
    if (!input.diffAcknowledged) {
      throw new ConfigGateError(
        'DIFF_NOT_ACKNOWLEDGED',
        '审批前必须核对 before/after diff 与影响范围并确认。',
      );
    }
    return this.decide(input.approvalRef, 'approved', input.note ?? '同意发布（审批通过）', input.actor, input.changeRequestId);
  }

  /** decideApproval(rejected) → ChangeRequest；reason 必填；人类主体。 */
  async reject(input: RejectInput): Promise<ChangeRequest> {
    if (input.actor.kind !== 'human') {
      throw new ApprovalAuthorityError('HUMAN_ONLY', '驳回同样属于审批决定，必须由人类操作。');
    }
    if (input.reason.trim().length === 0) {
      throw new ApprovalAuthorityError('STATE', '驳回必须填写原因（进入审计）。');
    }
    // reject 用 changeRequestId 当 approval_ref（Port 形状约定；UI 层把 submit 拿到的 approval_ref 填入）。
    return this.decide(input.changeRequestId, 'rejected', input.reason, input.actor, input.changeRequestId);
  }

  // ------------------------------------------------------------------ helpers

  private async decide(
    approvalRef: string,
    decision: 'approved' | 'rejected',
    reason: string,
    actor: Actor,
    changeRequestId: string,
  ): Promise<ChangeRequest> {
    if (reason.trim().length < 8) {
      throw new ApprovalAuthorityError('STATE', '审批决定必须填写 ≥8 字原因（合规留痕，「通过」也必填）。');
    }
    const reqBody: WireApprovalDecisionRequest = {
      decision,
      reason: reason.trim(),
    };
    const { body } = await this.request(
      `/v1/internal/approvals/${encodeURIComponent(approvalRef)}/decision`,
      {
        method: 'POST',
        headers: { 'idempotency-key': newIdempotencyKey() },
        body: reqBody,
      },
    );
    const wire = body as WireApprovalDecision;
    return {
      id: changeRequestId || wire.approval_ref,
      itemId: '',
      title: approvalRef,
      level: 'C0',
      values: {} as ConfigValues,
      baseVersion: 0,
      requester: actor,
      submittedAt: wire.decided_at,
      state: decision === 'approved' ? 'approved' : 'rejected',
      diffAcknowledged: true,
      changedFields: [],
      authorization: decision === 'approved'
        ? {
            kind: 'human_approval',
            approvalRef: wire.approval_ref,
            approver: actor,
            changeRequestId: changeRequestId || wire.approval_ref,
          }
        : undefined,
    };
  }

  /** WireApprovalApplication → ApprovalItemView（P2 最小映射；before/impact 由上层按 subject 还原）。 */
  private toApprovalItemView(app: WireApprovalApplication): ApprovalItemView {
    const itemId = itemIdForConfigId(app.subject.object_id);
    const changeRequest: ChangeRequest = {
      id: app.approval_ref,
      itemId,
      title: app.subject.path ?? app.subject.object_id,
      level: 'C0',
      values: {} as ConfigValues,
      baseVersion: 0,
      requester: { kind: app.applicant.kind, id: app.applicant.id },
      submittedAt: app.created_at,
      state: 'pending_approval',
      diffAcknowledged: false,
      changedFields: app.change.keys,
    };
    const impact: ImpactItem[] = app.change.keys.map((key) => ({
      kind: 'data' as const,
      label: key,
      detail: `变更字段：${key}`,
      severity: 'low' as const,
    }));
    return {
      changeRequest,
      impact,
      before: {} as ConfigValues,
    };
  }
}

/** 审计事件查询（契约 GET events；P2 不通过 AuditPort 暴露，留给后续 AuditSink 集成）。 */
export class HttpApprovalEventReader {
  private readonly fetchImpl: HttpFetch;
  private readonly baseUrl: string;
  private readonly authHeaders: () => Record<string, string>;

  constructor(fetchImpl: HttpFetch, baseUrl: string, authHeaders: () => Record<string, string>) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authHeaders = authHeaders;
  }

  async listEvents(approvalRef: string): Promise<WireApprovalEvent[]> {
    const { body } = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/internal/approvals/${encodeURIComponent(approvalRef)}/events`,
      this.authHeaders,
      { method: 'GET' },
    );
    return (body as { items?: WireApprovalEvent[] }).items ?? [];
  }
}
