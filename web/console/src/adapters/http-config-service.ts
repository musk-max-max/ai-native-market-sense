/**
 * HTTP 实现 ConfigServicePort（contracts/config/openapi.yaml）。
 *
 * 契约事实（CONTRACT-MAP + tests/contract/specimens/provider/*.json）：
 * - GET  /v1/internal/configs?environment&limit  → WireList<WireOpsConfigDocument>
 * - GET  /v1/internal/configs/{config_id}?environment → WireOpsConfigDocument（带 ETag "v<n>"）
 * - PUT  /v1/internal/configs/{config_id}（If-Match "v<n>"，409 → ConfigConflictProblem.diff）
 * - POST /v1/internal/configs/{config_id}/validate → WireValidationReport
 * - POST /v1/internal/configs/{config_id}/submit  → WireApprovalSubmission
 * - POST /v1/internal/configs/{config_id}/publish（approval_ref + canary_percent 1-10）→ WireRelease
 * - POST /v1/internal/configs/{config_id}/rollback（target_release_id + approval_ref）→ WireRollback
 * - GET  /v1/internal/releases?config_id&environment → WireList<WireRelease>
 *
 * environment 由构造函数注入（Port 不带 environment 参数；页面固定一个 environment 视图）。
 * config_id ↔ itemId 用 config-ids.ts 双向映射；未映射的 itemId 在写操作抛 ConfigGateError。
 *
 * ⚠️ UI 字段直接绑定 JSON Pointer（CONTRACT-MAP「OpsSpec 编辑」）。Port 的 ConfigValues 在
 * HTTP adapter 里承载为 JSON Pointer → 叶子值（flattenWriteBody/patchWriteBody），
 * 不丢 OpsSpec 结构。registry 的 ConfigFieldDef.key 与 OpsSpec 路径的对应由上层表单负责。
 */

import type {
  Actor,
  ChangeRequest,
  ConfigItemDef,
  ConfigValues,
  DraftConfig,
  ImpactScope,
  PublishedConfig,
  Release,
  ValidationIssue,
} from '../domain/types';
import { ConfigGateError } from '../mocks/ports';
import type { ValidationOutcome } from '../mocks/ports';
import type {
  ConfigItemDetail,
  ConfigItemSummary,
  PublishInput,
  RollbackInput,
  SaveDraftInput,
  SaveDraftOutcome,
  SubmitApprovalInput,
} from '../mocks/ports';
import { findConfigItem } from '../domain/registry';
import { requestJson, flattenWriteBody, patchWriteBody, toWriteBody, deepClone } from './http-common';
import type { HttpFetch, HttpRequestOptions } from './http-common';
import { configIdForItemId, itemIdForConfigId } from './config-ids';
import type {
  Environment,
  WireApprovalSubmission,
  WireConfigConflictProblem,
  WireOpsConfigDocument,
  WireOpsConfigWrite,
  WireRelease,
  WireRollback,
  WireValidationReport,
} from './contract-types';

export interface HttpConfigServiceOptions {
  fetchImpl: HttpFetch;
  baseUrl: string;
  environment: Environment;
  authHeaders: () => Record<string, string>;
  /** publish 缺省灰度百分比（契约 1-10，无全量字段）。 */
  canaryPercent?: number;
  /** list/limit 页大小（契约默认 20）。 */
  pageSize?: number;
}

/** submit 返回的 approval_ref 按 config_id 暂存，publish 时回填（页面在同一会话内完成链路）。 */
export class HttpConfigService {
  private readonly fetchImpl: HttpFetch;
  private readonly baseUrl: string;
  private readonly environment: Environment;
  private readonly authHeaders: () => Record<string, string>;
  private readonly canaryPercent: number;
  private readonly pageSize: number;
  /** itemId → 最近一次 submit 拿到的 approval_ref（内存态，供 publish 门禁）。 */
  private readonly approvalRefByItemId = new Map<string, string>();

  constructor(options: HttpConfigServiceOptions) {
    this.fetchImpl = options.fetchImpl;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.environment = options.environment;
    this.authHeaders = options.authHeaders;
    this.canaryPercent = options.canaryPercent ?? 5;
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

  /** listOpsConfigs → ConfigItemSummary[]；只暴露 registry 里 editable 的项（锁定项不渲染入口）。 */
  async list(): Promise<ConfigItemSummary[]> {
    const { body } = await this.request('/v1/internal/configs', { method: 'GET' }, {
      environment: this.environment,
      limit: this.pageSize,
    });
    const wire = (body as { items?: WireOpsConfigDocument[] }).items ?? [];
    return wire
      .map((doc) => this.toSummary(doc))
      .filter((summary): summary is ConfigItemSummary => summary !== null);
  }

  /** getOpsConfig → ConfigItemDetail（published + releases 并行取）。 */
  async get(itemId: string): Promise<ConfigItemDetail> {
    const configId = this.requireConfigId(itemId);
    const { body, etag } = await this.request(
      `/v1/internal/configs/${encodeURIComponent(configId)}`,
      { method: 'GET' },
      { environment: this.environment },
    );
    const doc = body as WireOpsConfigDocument;
    const summary = this.toSummary(doc, etag);
    if (summary === null) {
      throw new ConfigGateError('NOT_FOUND', `配置项「${itemId}」不在界面注册表里。`);
    }
    const releases = await this.listReleases(itemId);
    const latest = [...releases].sort((a, b) => b.version - a.version)[0];
    const published: PublishedConfig = latest
      ? {
          itemId,
          version: latest.version,
          values: latest.values,
          publishedAt: latest.publishedAt,
          releaseId: latest.releaseId,
        }
      : {
          itemId,
          version: doc.version,
          values: flattenWriteBody(toWriteBody(doc)),
          publishedAt: doc.meta?.updated_at ?? '',
          releaseId: '',
        };
    return { ...summary, published, releases };
  }

  /** saveDraft → PUT（If-Match "v<n>"）；409 → ConflictPayload（契约 diff.base/current/submitted）。 */
  async saveDraft(input: SaveDraftInput): Promise<SaveDraftOutcome> {
    const item = findConfigItem(input.itemId);
    if (!item || !item.editable) {
      return {
        ok: false,
        kind: 'locked',
        message: '该配置项为合规锁定项或未知项，适配层拒绝写入（界面也不应渲染入口）。',
      };
    }
    const configId = configIdForItemId(input.itemId);
    const changeReason = input.changeReason ?? '';
    const impactScope = (input.impactScope ?? []) as ImpactScope[];
    // 以输入 values（JSON Pointer 承载）patch 一个最小完整文档骨架（P2 标量子集）。
    const skeleton: WireOpsConfigWrite = {
      schema_version: '0.1',
      config_id: configId,
      environment: this.environment,
      change_reason: changeReason,
      impact_scope: impactScope,
      spec: { columns: [], content_items: [], strategies: [] },
    };
    const body = patchWriteBody(skeleton, input.values);
    try {
      const { body: docBody } = await this.request(
        `/v1/internal/configs/${encodeURIComponent(configId)}`,
        {
          method: 'PUT',
          headers: { 'if-match': `"v${input.expectedVersion}"` },
          body,
        },
        { environment: this.environment },
      );
      const doc = docBody as WireOpsConfigDocument;
      const draft: DraftConfig = {
        itemId: input.itemId,
        baseVersion: input.expectedVersion,
        values: flattenWriteBody(toWriteBody(doc)),
        state: 'draft',
        updatedBy: input.actor,
        updatedAt: doc.meta?.updated_at ?? new Date().toISOString(),
      };
      return { ok: true, draft, issues: [] };
    } catch (error) {
      if (isProblem(error, 409)) {
        const problem = (error as { problem: WireConfigConflictProblem }).problem;
        const diff = problem.diff;
        return {
          ok: false,
          kind: 'conflict',
          conflict: {
            base: diffToPointValues(diff.changes.map((change) => [change.path, change.base])),
            mine: input.values,
            theirs: diffToPointValues(diff.changes.map((change) => [change.path, change.current])),
            currentVersion: diff.current_version,
            message: `配置已被他人发布新版本（409 冲突，base v${diff.base_version} → current v${diff.current_version}）：请基于三点 diff 选择保留哪个值后再提交。`,
          },
        };
      }
      throw error;
    }
  }

  /** validateOpsConfig → ValidationOutcome（valid + issues 从 structural/semantic errors 合并）。 */
  async validate(itemId: string, actor: Actor): Promise<ValidationOutcome> {
    const configId = this.requireConfigId(itemId);
    void actor;
    // validate 需要完整文档：先 GET 再 POST validate（服务端以文档为输入，不依赖 draft）。
    const { body: docBody } = await this.request(
      `/v1/internal/configs/${encodeURIComponent(configId)}`,
      { method: 'GET' },
      { environment: this.environment },
    );
    const doc = docBody as WireOpsConfigDocument;
    const { body: reportBody } = await this.request(
      `/v1/internal/configs/${encodeURIComponent(configId)}/validate`,
      { method: 'POST', body: toWriteBody(doc) },
      { environment: this.environment },
    );
    const report = reportBody as WireValidationReport;
    const issues: ValidationIssue[] = [
      ...report.structural_errors.map((issue) => ({
        field: issue.path,
        severity: 'error' as const,
        code: issue.code,
        message: issue.message,
      })),
      ...report.semantic_errors.map((issue) => ({
        field: issue.path,
        severity: 'error' as const,
        code: issue.code,
        message: issue.message,
      })),
    ];
    return {
      ok: report.valid,
      state: report.valid ? 'validated' : 'draft',
      issues,
    };
  }

  /** submitOpsConfig → ChangeRequest（approval_ref 暂存供 publish）。 */
  async submitForApproval(input: SubmitApprovalInput): Promise<ChangeRequest> {
    const item = this.requireItem(input.itemId);
    const configId = configIdForItemId(input.itemId);
    const { body: docBody } = await this.request(
      `/v1/internal/configs/${encodeURIComponent(configId)}`,
      { method: 'GET' },
      { environment: this.environment },
    );
    const doc = docBody as WireOpsConfigDocument;
    const { body: submitBody } = await this.request(
      `/v1/internal/configs/${encodeURIComponent(configId)}/submit`,
      {
        method: 'POST',
        body: {
          change_reason: doc.change_reason,
          impact_scope: doc.impact_scope,
          expected_version: doc.version,
        },
      },
      { environment: this.environment },
    );
    const submission = submitBody as WireApprovalSubmission;
    this.approvalRefByItemId.set(input.itemId, submission.approval_ref);
    return {
      id: submission.approval_ref,
      itemId: input.itemId,
      title: item.title,
      level: item.level,
      values: flattenWriteBody(toWriteBody(doc)),
      baseVersion: doc.version,
      requester: input.actor,
      submittedAt: submission.submitted_at,
      state: 'pending_approval',
      diffAcknowledged: input.diffAcknowledged,
      changedFields: [],
    };
  }

  /** publishOpsConfig → Release（approval_ref + canary_percent 1-10，无全量字段）。 */
  async publish(input: PublishInput): Promise<Release> {
    const configId = this.requireConfigId(input.itemId);
    const canaryPercent = input.canaryPercent ?? this.canaryPercent;
    if (!Number.isInteger(canaryPercent) || canaryPercent < 1 || canaryPercent > 10) {
      throw new ConfigGateError('INVALID', '灰度百分比必须为 1-10 整数（契约无全量参数）。');
    }
    const approvalRef = this.approvalRefByItemId.get(input.itemId) ?? '';
    if (approvalRef.length === 0) {
      throw new ConfigGateError('NO_APPROVAL', '缺少审批授权（approval_ref）：请先 submit。');
    }
    const { body: docBody } = await this.request(
      `/v1/internal/configs/${encodeURIComponent(configId)}`,
      { method: 'GET' },
      { environment: this.environment },
    );
    const doc = docBody as WireOpsConfigDocument;
    const { body: releaseBody } = await this.request(
      `/v1/internal/configs/${encodeURIComponent(configId)}/publish`,
      {
        method: 'POST',
        body: {
          approval_ref: approvalRef,
          expected_version: doc.version,
          canary_percent: canaryPercent,
          ...(input.releaseNotes ? { release_notes: input.releaseNotes } : {}),
        },
      },
      { environment: this.environment },
    );
    const wire = releaseBody as WireRelease;
    this.approvalRefByItemId.delete(input.itemId);
    return this.wireReleaseToRelease(wire, input.actor, input.changeRequestId);
  }

  /** rollbackOpsConfig → Release（target_release_id + approval_ref 必填；reason 进契约可选字段）。 */
  async rollback(input: RollbackInput): Promise<Release> {
    if (input.actor.kind !== 'human') {
      throw new ConfigGateError('STATE', '回滚是危险操作，必须由人类操作者在二次确认后发起。');
    }
    if (!input.diffAcknowledged) {
      throw new ConfigGateError('DIFF_NOT_ACKNOWLEDGED', '回滚前必须展示目标版本与当前版本的 diff 并确认。');
    }
    if (input.reason.trim().length === 0) {
      throw new ConfigGateError('INVALID', '回滚必须填写原因（进入审计）。');
    }
    const approvalRef = input.approvalRef?.trim() ?? '';
    if (approvalRef.length === 0) {
      throw new ConfigGateError('NO_APPROVAL', '回滚必须先走 T6 审批（approval_ref 必填）。');
    }
    const configId = this.requireConfigId(input.itemId);
    const releases = await this.listReleases(input.itemId);
    const target = releases.find((release) => release.version === input.targetVersion);
    if (!target) {
      throw new ConfigGateError('VERSION_NOT_FOUND', `找不到 v${input.targetVersion} 的发布记录。`);
    }
    const { body } = await this.request(
      `/v1/internal/configs/${encodeURIComponent(configId)}/rollback`,
      {
        method: 'POST',
        body: {
          target_release_id: target.releaseId,
          approval_ref: approvalRef,
          reason: input.reason,
        } satisfies { target_release_id: string; approval_ref: string; reason?: string },
      },
      { environment: this.environment },
    );
    const wire = body as WireRollback;
    const values = target.values;
    const now = wire.rolled_back_at;
    return {
      releaseId: wire.release_id,
      itemId: input.itemId,
      version: target.version,
      values: deepClone(values),
      publishedBy: input.actor,
      publishedAt: now,
      authorization: {
        kind: 'human_approval',
        approvalRef,
        approver: input.actor,
        changeRequestId: 'rollback',
      },
      rolledBackFrom: wire.previous_release_id,
    };
  }

  /** listOpsReleases（按 config_id 过滤）→ Release[]（wire version 不递增，UI vN 来自 config）。 */
  async listReleases(itemId: string): Promise<Release[]> {
    const configId = configIdForItemId(itemId);
    const { body } = await this.request('/v1/internal/releases', { method: 'GET' }, {
      config_id: configId,
      environment: this.environment,
      limit: this.pageSize,
    });
    const items = (body as { items?: WireRelease[] }).items ?? [];
    const actor: Actor = { kind: 'human', id: 'unknown' };
    return items.map((wire) =>
      this.wireReleaseToRelease(wire, actor, itemIdForConfigId(configId)),
    );
  }

  // ------------------------------------------------------------------ helpers

  private requireConfigId(itemId: string): string {
    try {
      return configIdForItemId(itemId);
    } catch {
      throw new ConfigGateError('NOT_FOUND', `配置项「${itemId}」不在 UI key→config_id 映射里。`);
    }
  }

  private requireItem(itemId: string): ConfigItemDef {
    const item = findConfigItem(itemId);
    if (!item) {
      throw new ConfigGateError('NOT_FOUND', `配置项「${itemId}」不在界面注册表里。`);
    }
    return item;
  }

  /** 文档 → ConfigItemSummary；未在 registry 的 config_id 返回 null（list 过滤掉）。 */
  private toSummary(doc: WireOpsConfigDocument, etag?: string | null): ConfigItemSummary | null {
    const itemId = itemIdForConfigId(doc.config_id);
    const item = findConfigItem(itemId);
    if (!item) return null;
    void etag;
    return {
      item,
      publishedVersion: doc.version,
      publishedAt: doc.meta?.updated_at ?? '',
      draft: doc.status === 'draft'
        ? {
            itemId,
            baseVersion: doc.version,
            values: flattenWriteBody(toWriteBody(doc)),
            state: 'draft',
            updatedBy: doc.meta?.created_by
              ? { kind: doc.meta.created_by.kind, id: doc.meta.created_by.id }
              : { kind: 'human', id: 'unknown' },
            updatedAt: doc.meta?.updated_at ?? '',
          }
        : null,
      pendingApprovals: 0,
    };
  }

  private wireReleaseToRelease(wire: WireRelease, actor: Actor, changeRequestId: string): Release {
    void wire;
    void actor;
    void changeRequestId;
    // Release.values 在契约里没有 spec 文档（只有 content_hash + approval_ref），
    // values 由上层通过 GET config 按 release.version 还原；这里返回空 values（P2 标注）。
    return {
      releaseId: wire.release_id,
      itemId: itemIdForConfigId(wire.config_id),
      version: wire.version,
      values: {},
      publishedBy: { kind: 'human', id: 'unknown' },
      publishedAt: wire.published_at,
      authorization: {
        kind: 'human_approval',
        approvalRef: wire.approval_ref,
        approver: { kind: 'human', id: 'unknown' },
        changeRequestId,
      },
    };
  }
}

/** 409 diff.changes（path + base/current/submitted 叶子值）→ 稀疏 ConfigValues（JSON Pointer 承载）。 */
function diffToPointValues(entries: (readonly [string, unknown])[]): ConfigValues {
  const out: Record<string, string | number | boolean | readonly string[] | null> = {};
  for (const [path, value] of entries) {
    out[`/${path.replace(/\./g, '/')}`] = (value ?? null) as string | number | boolean | readonly string[] | null;
  }
  return out;
}

function isProblem(error: unknown, status: number): boolean {
  return (
    error instanceof Error &&
    (error as { status?: number; problem?: unknown }).status === status &&
    (error as { problem?: unknown }).problem !== undefined
  );
}