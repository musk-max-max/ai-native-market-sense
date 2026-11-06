/**
 * config 域服务（A4）：/v1/internal/configs + /v1/internal/releases 十操作。
 *
 * 真源契约：contracts/config/openapi.yaml（H2 拥有，禁改）。
 * M1 矩阵（docs/adr/CONTRACT-REVIEW-2026-11-06-config-approval.md）：
 *   PUT If-Match 不符 → 409 + ConfigConflictProblem（三点 diff）；
 *   submit/publish body expected_version 不符 → 412 PRECONDITION_FAILED；
 *   approval 域一切状态冲突 → 409 ApprovalConflictProblem。
 * V-01–V-10 在 domain/validation.ts；V-11/V-12 发布时在此硬校验；V-13（query environment 为准）在路由层。
 * 状态机：draft 可编辑；published 不可原地修改（PUT 必须 If-Match 当前版本 → version+1 只写 draft）；
 * publish 不增版本（Release.version = 已审批 draft 内容版本，同一 version 可多个不同 canary release）；
 * rollback 只切 is_current 指针，不改历史 release。
 */

import { canonicalJson, sha256Ref } from '../domain/canonical.js';
import { threeWayDiff, flatten } from '../domain/diff.js';
import { DomainError } from '../domain/errors.js';
import { loadPolicy } from '../domain/evaluation.js';
import { actorFromPrincipal } from '../domain/types.js';
import type {
  Actor,
  ApprovalSubmission,
  Environment,
  OpsConfigDocument,
  OpsConfigList,
  OpsConfigWrite,
  PublishRequest,
  Release,
  ReleaseList,
  Rollback,
  RollbackRequest,
  SubmitRequest,
  SystemMeta,
  ThreeWayDiff,
  ValidationReport,
} from '../domain/types.js';
import { toValidationReport, validateOpsWrite } from '../domain/validation.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
import type { StoredApplication } from '../domain/ledger.js';
import type {
  ConfigFilter,
  DomainStore,
  ReleaseFilter,
  StoredConfig,
  StoredRelease,
  StoredVersionRow,
} from '../ports/stores.js';
import { uuidv7 } from '../../../identity/src/domain/approval-ref.js';
import type { ApprovalService, ActorContext } from './approval-service.js';

/** M2：wire 层 approval_ref = 裸 apr_<uuidv7>（跨环境前缀仅限 DB/审计内部存储，不上契约）。 */
const WIRE_APPROVAL_REF_PATTERN = /^apr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLICY_VERSION_PATTERN = /^ai-content-policy\/[0-9]+\.[0-9]+\.[0-9]+$/;
const RELEASE_ID_PATTERN = /^rel_[0-9a-z-]{8,40}$/;

type Issue = { path: string; code: string; message: string };

function issue(path: string, code: string, message: string): Issue {
  return { path, code, message };
}

export interface ConfigServiceOptions {
  store: DomainStore;
  approvals: ApprovalService;
  now?: () => string;
}

export class ConfigService {
  private readonly store: DomainStore;
  private readonly approvals: ApprovalService;
  readonly now: () => string;

  constructor(options: ConfigServiceOptions) {
    this.store = options.store;
    this.approvals = options.approvals;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ---------- 查询 ----------

  async listConfigs(filter: ConfigFilter & { environment: Environment }): Promise<OpsConfigList> {
    const page = await this.store.listConfigs(filter);
    const items = await Promise.all(
      page.items.map(async (row) => {
        const release = row.status === 'published' ? await this.store.getCurrentRelease(row.configId, row.environment) : null;
        return this.toDocument(row, release);
      }),
    );
    return { items, next_cursor: page.nextCursor };
  }

  async getOpsConfig(configId: string, environment: Environment): Promise<{ document: OpsConfigDocument; etag: string }> {
    const row = await this.loadConfig(configId, environment);
    const release = row.status === 'published' ? await this.store.getCurrentRelease(row.configId, row.environment) : null;
    return { document: this.toDocument(row, release), etag: this.etagOf(row.version) };
  }

  // ---------- 写操作 ----------

  /** PUT 草稿：If-Match 乐观锁（S1 语义：config_id 未注册 → 404；已注册 → upsert 草稿版本）。 */
  async putDraft(input: {
    configId: string;
    environment: Environment;
    ifMatch: string | undefined;
    body: unknown;
    actor: Actor;
  }): Promise<{ document: OpsConfigDocument; etag: string }> {
    const { configId, environment, body, actor } = input;
    const row = await this.loadConfig(configId, environment);
    const expected = this.parseIfMatch(input.ifMatch);
    if (expected !== row.version) {
      // M1：409 + 三点 diff（base=If-Match 版本，current=当前版本，submitted=本次提交）
      const baseRow = await this.store.getVersionRow(configId, environment, expected);
      const submitted = isRecord(body) && isRecord(body['spec']) ? body['spec'] : {};
      throw new DomainError(409, 'version_conflict', {
        diff: threeWayDiff({
          configId,
          environment,
          baseVersion: expected,
          currentVersion: row.version,
          submittedVersion: row.version + 1,
          base: baseRow?.spec ?? {},
          current: row.spec,
          submitted,
        }),
      });
    }

    // V-13：query environment 为路由键，body.environment 必须相等
    if (isRecord(body) && body['environment'] !== undefined && body['environment'] !== environment) {
      throw new DomainError(400, 'environment_mismatch', {}, [
        issue('/environment', 'V-13', '请求体 environment 与路径 query 不一致（query 为准）。'),
      ]);
    }

    const result = validateOpsWrite(body, environment);
    const issues = [...result.structural, ...result.semantic];
    if (issues.length > 0) {
      throw new DomainError(400, 'validation_failed', {}, issues);
    }
    const write = body as OpsConfigWrite;
    const now = this.now();
    const newVersion = row.version + 1;
    // 版本行 + 配置行 + 留痕同一事务：失败整体回滚（版本号不空转、不留半截 draft）。
    await this.store.transaction(async (tx) => {
      await tx.upsertConfig({
        ...row,
        version: newVersion,
        status: 'draft',
        changeReason: write.change_reason,
        impactScope: write.impact_scope,
        spec: write.spec,
        updatedBy: actor,
        updatedAt: now,
      });
      await tx.insertVersionRow({
        configId,
        environment,
        version: newVersion,
        spec: write.spec,
        changeReason: write.change_reason,
        impactScope: write.impact_scope,
        savedAt: now,
        savedBy: actor,
      });
      await this.auditEvent('config_drafted', actor, `${configId}@${environment}`, null, {
        version: newVersion,
        change_reason: write.change_reason,
        impact_scope: write.impact_scope,
      }, 'put_draft', null, tx);
    });
    const updated = await this.loadConfig(configId, environment);
    return { document: this.toDocument(updated, null), etag: this.etagOf(updated.version) };
  }

  /** 只读校验：不写 draft、不建审批单、不改 version；valid=false 仍 HTTP 200。 */
  validateOnly(body: unknown, environment: Environment): ValidationReport {
    if (isRecord(body) && body['environment'] !== undefined && body['environment'] !== environment) {
      throw new DomainError(400, 'environment_mismatch', {}, [
        issue('/environment', 'V-13', '请求体 environment 与路径 query 不一致（query 为准）。'),
      ]);
    }
    const result = validateOpsWrite(body, environment);
    const spec = isRecord(body) && isRecord(body['spec']) ? (body['spec'] as OpsConfigWrite['spec']) : null;
    return toValidationReport(result, spec);
  }

  /** 对当前 draft 建审批单（T1 常规 / T3 文案）；approval_ref 只能由建单事务生成，本接口不接收。 */
  async submit(input: {
    configId: string;
    environment: Environment;
    body: unknown;
    actorContext: ActorContext;
  }): Promise<ApprovalSubmission> {
    const { configId, environment, actorContext } = input;
    const row = await this.loadConfig(configId, environment);
    const request = this.validateSubmitRequest(input.body);

    // M1：expected_version 不符 → 412 PRECONDITION_FAILED
    if (request.expected_version !== row.version) {
      throw new DomainError(412, 'precondition_failed', {}, [
        issue('/expected_version', 'PRECONDITION_FAILED', 'expected_version 与当前版本不一致。'),
      ]);
    }

    const policy = loadPolicy();
    // impact_scope 含 content_copy ⇒ T3 文案（T3 字段 6 个见 field-catalog §7）；否则 T1
    const flow = request.impact_scope.includes('content_copy') ? 't3' : 't1';
    if (flow === 't3') {
      if (!request.policy_version || !POLICY_VERSION_PATTERN.test(request.policy_version)) {
        throw new DomainError(400, 'policy_version_mismatch', {}, [
          issue('/policy_version', 'V-12', 'T3 文案审批必须携带当前已签 policy_version。'),
        ]);
      }
      if (request.policy_version !== policy.policyVersion) {
        throw new DomainError(400, 'policy_version_mismatch', {}, [
          issue('/policy_version', 'V-12', 'policy_version 与当前已签规则不一致，须重新预检。'),
        ]);
      }
    }

    // 变更 keys/diff_hash：上一版本 spec → 当前 spec（禁止空 diff）
    const prevRow = row.version > 1 ? await this.store.getVersionRow(configId, environment, row.version - 1) : null;
    const before = prevRow?.spec ?? {};
    const after = row.spec;
    const keys = this.changedPaths(before, after);
    const diffHash = sha256Ref(canonicalJson({ before, after }));
    const now = this.now();
    // agent 主体缺/空 x-model-version → 写前 400（不得以 unknown 落审计）。
    const actor = actorFromPrincipal(actorContext.principal, actorContext.modelVersion);

    // 建单 + 绑定 + 留痕同一事务：失败整体回滚（不留无绑定的孤儿审批单）。
    return this.store.transaction(async (tx) => {
      // submit 幂等（原缺口：幂等键拼 uuidv7 恒不命中）：同 config@version 已有活跃提交时，
      // 同内容 → 重放原单（不新建不重复绑定）；异内容 → 409 显式拒绝；
      // rejected/expired 后重提 → 新建单（R9 决定不可复用）。确定性键不可行：驳回后同版重提会撞旧记录。
      const active = await tx.findActiveSubmission({ configId, environment, version: row.version });
      if (active !== null) {
        if (this.sameSubmission(active.application, request)) {
          return {
            approval_ref: active.application.approvalRef,
            application_id: active.application.applicationId,
            // sameSubmission 已比对 impact_scope ⇒ flow 必与原单一致。
            flow: active.application.flow as ApprovalSubmission['flow'],
            status: 'submitted' as const,
            submitted_at: active.application.createdAt,
          };
        }
        throw new DomainError(409, 'approval_state_conflict', {
          approvalRef: active.application.approvalRef,
          currentStatus: active.application.status,
        });
      }

      const created = await this.approvals.withStore(tx).create({
        body: {
          flow,
          applicant: actor,
          subject: {
            environment,
            domain: 'ops_config',
            object_id: configId,
            path: `/v1/internal/configs/${configId}`,
            diff_hash: diffHash,
          },
          change: { keys: keys.length > 0 ? keys : ['/spec'], diff_hash: diffHash, before, after },
          evidence: {
            change_reason: request.change_reason,
            impact_scope: request.impact_scope,
            expected_version: request.expected_version,
            policy_version: request.policy_version ?? null,
          },
        },
        // uuidv7 只保证单次尝试内键唯一（create 层幂等仍兜底）；跨提交幂等由上方 findActiveSubmission 承担。
        idempotencyKey: `submit:${configId}:${environment}:${row.version}:${uuidv7()}`,
        actorContext,
      });

      await tx.insertBinding({
        approvalRef: created.application.approval_ref,
        purpose: 'config_publish',
        configId,
        environment,
        version: row.version,
        policyVersion: policy.policyVersion,
        createdAt: now,
        consumedAt: null,
      });
      await this.auditEvent('config_submitted', actor, `${configId}@${environment}`, { version: row.version, status: row.status }, {
        approval_ref: created.application.approval_ref,
        flow,
        change_reason: request.change_reason,
        impact_scope: request.impact_scope,
      }, `submit_flow_${flow}`, created.application.approval_ref, tx);

      return {
        approval_ref: created.application.approval_ref,
        application_id: created.application.application_id,
        flow,
        status: 'submitted' as const,
        submitted_at: now,
      };
    });
  }

  /** submit 幂等判定：与原单 evidence 四字段完全一致才可重放（任一不同 → 409）。 */
  private sameSubmission(application: StoredApplication, request: SubmitRequest): boolean {
    const evidence = (application.evidence ?? {}) as {
      change_reason?: unknown;
      impact_scope?: unknown;
      expected_version?: unknown;
      policy_version?: unknown;
    };
    const sameReason = evidence.change_reason === request.change_reason;
    const sameScope =
      Array.isArray(evidence.impact_scope) &&
      Array.isArray(request.impact_scope) &&
      evidence.impact_scope.length === request.impact_scope.length &&
      [...(evidence.impact_scope as string[])].sort().join('|') === [...request.impact_scope].sort().join('|');
    const sameVersion = evidence.expected_version === request.expected_version;
    const samePolicy = (evidence.policy_version ?? null) === (request.policy_version ?? null);
    return sameReason && sameScope && sameVersion && samePolicy;
  }

  /** 发布：approval_ref 必须可解析 + approved + 绑定本 config/version/policy；一 ref 发布恰一次；version 不增。 */
  async publish(input: {
    configId: string;
    environment: Environment;
    body: unknown;
    actor: Actor;
  }): Promise<Release> {
    const { configId, environment, actor } = input;
    const row = await this.loadConfig(configId, environment);
    const request = this.validatePublishRequest(input.body);

    // M1：expected_version 不符 → 412
    if (request.expected_version !== row.version) {
      throw new DomainError(412, 'precondition_failed', {}, [
        issue('/expected_version', 'PRECONDITION_FAILED', 'expected_version 与当前版本不一致。'),
      ]);
    }

    // V-12：发布时 binding.policy_version 必须等于当前已签 policy（不一致须重新预检，拒绝发布）
    const policy = loadPolicy();
    await this.approvals.requireApprovedBinding({
      approvalRef: request.approval_ref,
      purpose: 'config_publish',
      configId,
      environment,
      version: row.version,
      policyVersion: policy.policyVersion,
    });

    const now = this.now();
    const previous = await this.store.getCurrentRelease(configId, environment);
    const release: StoredRelease = {
      releaseId: `rel_${uuidv7().replace(/-/g, '')}`,
      configId,
      environment,
      version: row.version,
      schemaVersion: '0.1',
      policyVersion: policy.policyVersion,
      contentHash: sha256Ref(canonicalJson(row.spec)),
      publishedAt: now,
      approvalRef: request.approval_ref,
      canaryPercent: request.canary_percent,
      releaseNotes: request.release_notes ?? null,
      previousReleaseId: previous?.releaseId ?? null,
      isCurrent: true,
    };
    // release + 消费绑定 + 指针 + 配置行 + 留痕同一事务：失败整体回滚（绑定不被无发布消耗）。
    await this.store.transaction(async (tx) => {
      await tx.insertRelease(release);
      const consumed = await tx.consumeBinding(request.approval_ref, now);
      if (consumed === null) {
        // 一 ref 恰一次：并发/重复发布在事务内显式拒绝（原实现忽略返回值）。
        throw new DomainError(409, 'approval_ref_reuse', {
          approvalRef: request.approval_ref,
          currentStatus: 'approved',
        });
      }
      await tx.setCurrentRelease(configId, environment, release.releaseId);
      await tx.upsertConfig({ ...row, status: 'published', updatedBy: actor, updatedAt: now });
      await this.auditEvent('config_published', actor, `${configId}@${environment}`,
        { status: row.status, current_release_id: previous?.releaseId ?? null },
        { release_id: release.releaseId, approval_ref: request.approval_ref, canary_percent: request.canary_percent },
        'publish', request.approval_ref, tx);
    });
    return this.toContractRelease(release);
  }

  /** 回滚：新建 approved 审批（不得复用发布 ref），只切 is_current 指针；历史 release 不改。 */
  async rollback(input: {
    configId: string;
    environment: Environment;
    body: unknown;
    actor: Actor;
  }): Promise<Rollback> {
    const { configId, environment, actor } = input;
    await this.loadConfig(configId, environment);
    const request = this.validateRollbackRequest(input.body);

    const target = await this.store.getRelease(request.target_release_id);
    if (!target || target.configId !== configId || target.environment !== environment) {
      throw new DomainError(404, 'not_found', {}, [issue('/target_release_id', 'NOT_FOUND', '目标 release 不存在。')]);
    }
    const current = await this.store.getCurrentRelease(configId, environment);
    if (!current) {
      throw new DomainError(404, 'not_found', {}, [issue('/target_release_id', 'NOT_FOUND', '当前无已发布 release，无法回滚。')]);
    }

    // 审批侧检查：approved + 绑定本 config；发布 ref/已用 ref 复用 → 409
    await this.approvals.assertApprovedFor(request.approval_ref, configId);
    const existing = await this.store.getBinding(request.approval_ref);
    if (existing) {
      throw new DomainError(409, 'approval_ref_reuse', { approvalRef: request.approval_ref });
    }
    // rollback 绑定在调用时建立并即刻消费（提交接口只建 config_publish 绑定；回滚审批由建单接口直建）
    const now = this.now();
    // 绑定 + 指针 + 留痕同一事务：失败整体回滚（不留已消费无回滚的绑定）。
    await this.store.transaction(async (tx) => {
      await tx.insertBinding({
        approvalRef: request.approval_ref,
        purpose: 'config_rollback',
        configId,
        environment,
        version: target.version,
        policyVersion: target.policyVersion,
        createdAt: now,
        consumedAt: now,
      });
      await tx.setCurrentRelease(configId, environment, target.releaseId);
      await this.auditEvent('config_rolled_back', actor, `${configId}@${environment}`,
        { current_release_id: current.releaseId },
        { release_id: target.releaseId, previous_release_id: current.releaseId },
        request.reason ?? 'rollback', request.approval_ref, tx);
    });
    return {
      config_id: configId,
      environment,
      release_id: target.releaseId,
      previous_release_id: current.releaseId,
      approval_ref: request.approval_ref,
      rolled_back_at: now,
    };
  }

  /** 三点只读 diff（base/current/submitted 都取版本快照；current 缺省 = 当前版本）。 */
  async diff(input: {
    configId: string;
    environment: Environment;
    baseVersion: number;
    currentVersion?: number;
    submittedVersion: number;
  }): Promise<ThreeWayDiff> {
    const { configId, environment } = input;
    await this.loadConfig(configId, environment);
    const currentVersion = input.currentVersion ?? (await this.loadConfig(configId, environment)).version;
    const baseRow = await this.requireVersionRow(configId, environment, input.baseVersion);
    const currentRow = await this.requireVersionRow(configId, environment, currentVersion);
    const submittedRow = await this.requireVersionRow(configId, environment, input.submittedVersion);
    return threeWayDiff({
      configId,
      environment,
      baseVersion: input.baseVersion,
      currentVersion,
      submittedVersion: input.submittedVersion,
      base: baseRow.spec,
      current: currentRow.spec,
      submitted: submittedRow.spec,
    });
  }

  async listReleases(filter: ReleaseFilter): Promise<ReleaseList> {
    const page = await this.store.listReleases(filter);
    return { items: page.items.map((r) => this.toContractRelease(r)), next_cursor: page.nextCursor };
  }

  async getRelease(releaseId: string): Promise<Release> {
    const release = await this.store.getRelease(releaseId);
    if (!release) throw new DomainError(404, 'not_found');
    return this.toContractRelease(release);
  }

  // ---------- 私有 ----------

  private async loadConfig(configId: string, environment: Environment): Promise<StoredConfig> {
    const row = await this.store.getConfig(configId, environment);
    if (!row) throw new DomainError(404, 'not_found');
    return row;
  }

  private async requireVersionRow(configId: string, environment: Environment, version: number): Promise<StoredVersionRow> {
    const row = await this.store.getVersionRow(configId, environment, version);
    if (!row) {
      throw new DomainError(404, 'not_found', {}, [issue('/base', 'NOT_FOUND', `版本 v${version} 无快照记录。`)]);
    }
    return row;
  }

  private etagOf(version: number): string {
    return `"v${version}"`;
  }

  private parseIfMatch(header: string | undefined): number {
    const match = /^"v([0-9]+)"$/.exec(header ?? '');
    if (!match) {
      throw new DomainError(400, 'validation_failed', {}, [
        issue('if-match', 'INVALID_SYSTEM_FIELD', 'If-Match 必须形如 "v<version>"（来自上一次 GET/PUT 的 ETag）。'),
      ]);
    }
    return Number(match[1]);
  }

  private changedPaths(before: unknown, after: unknown): string[] {
    const b = flatten(before, '');
    const a = flatten(after, '');
    const paths = new Set<string>();
    for (const [path, value] of b) {
      if (!a.has(path) || a.get(path) !== value) paths.add(path);
    }
    for (const path of a.keys()) {
      if (!b.has(path)) paths.add(path);
    }
    return [...paths].slice(0, 50);
  }

  private validateSubmitRequest(body: unknown): SubmitRequest {
    const issues: Issue[] = [];
    if (!isRecord(body)) {
      throw new DomainError(400, 'validation_failed', {}, [issue('', 'type', '请求体必须是对象。')]);
    }
    const allowed = ['change_reason', 'impact_scope', 'expected_version', 'policy_version'];
    this.rejectUnknownKeys(body, allowed, issues);
    const changeReason = body['change_reason'];
    if (typeof changeReason !== 'string' || changeReason.length < 8 || changeReason.length > 200) {
      issues.push(issue('/change_reason', 'min_length', 'change_reason 长度 8–200。'));
    }
    const impactScope = body['impact_scope'];
    const scopes = ['column_layout', 'content_copy', 'content_placement', 'ranking', 'rotation', 'visibility'];
    if (
      !Array.isArray(impactScope) || impactScope.length < 1 || impactScope.length > 6 ||
      new Set(impactScope).size !== impactScope.length || impactScope.some((s) => !scopes.includes(s as string))
    ) {
      issues.push(issue('/impact_scope', 'enum', 'impact_scope 为 1–6 个不重复的枚举值。'));
    }
    const expectedVersion = body['expected_version'];
    if (!isInt(expectedVersion) || (expectedVersion as number) < 1) {
      issues.push(issue('/expected_version', 'minimum', 'expected_version 必须是 ≥1 的整数。'));
    }
    const policyVersion = body['policy_version'];
    if (policyVersion !== undefined && (typeof policyVersion !== 'string' || !POLICY_VERSION_PATTERN.test(policyVersion))) {
      issues.push(issue('/policy_version', 'pattern', 'policy_version 形如 ai-content-policy/<major>.<minor>.<patch>。'));
    }
    if (issues.length > 0) throw new DomainError(400, 'validation_failed', {}, issues);
    return body as unknown as SubmitRequest;
  }

  private validatePublishRequest(body: unknown): PublishRequest {
    const issues: Issue[] = [];
    if (!isRecord(body)) {
      throw new DomainError(400, 'validation_failed', {}, [issue('', 'type', '请求体必须是对象。')]);
    }
    const allowed = ['approval_ref', 'expected_version', 'canary_percent', 'release_notes'];
    this.rejectUnknownKeys(body, allowed, issues);
    const approvalRef = body['approval_ref'];
    if (typeof approvalRef !== 'string' || !WIRE_APPROVAL_REF_PATTERN.test(approvalRef)) {
      issues.push(issue('/approval_ref', 'pattern', 'approval_ref 必须是可解析的 apr_<uuidv7>。'));
    }
    const expectedVersion = body['expected_version'];
    if (!isInt(expectedVersion) || (expectedVersion as number) < 1) {
      issues.push(issue('/expected_version', 'minimum', 'expected_version 必须是 ≥1 的整数。'));
    }
    const canary = body['canary_percent'];
    if (!isInt(canary) || (canary as number) < 1 || (canary as number) > 10) {
      issues.push(issue('/canary_percent', 'minimum', 'canary_percent 为 1–10 的整数。'));
    }
    const notes = body['release_notes'];
    if (notes !== undefined && (typeof notes !== 'string' || notes.length > 500)) {
      issues.push(issue('/release_notes', 'max_length', 'release_notes 长度 ≤500。'));
    }
    if (issues.length > 0) throw new DomainError(400, 'validation_failed', {}, issues);
    return body as unknown as PublishRequest;
  }

  private validateRollbackRequest(body: unknown): RollbackRequest {
    const issues: Issue[] = [];
    if (!isRecord(body)) {
      throw new DomainError(400, 'validation_failed', {}, [issue('', 'type', '请求体必须是对象。')]);
    }
    const allowed = ['target_release_id', 'approval_ref', 'reason'];
    this.rejectUnknownKeys(body, allowed, issues);
    const target = body['target_release_id'];
    if (typeof target !== 'string' || !RELEASE_ID_PATTERN.test(target)) {
      issues.push(issue('/target_release_id', 'pattern', 'target_release_id 形如 rel_<id>。'));
    }
    const approvalRef = body['approval_ref'];
    if (typeof approvalRef !== 'string' || !WIRE_APPROVAL_REF_PATTERN.test(approvalRef)) {
      issues.push(issue('/approval_ref', 'pattern', 'approval_ref 必须是可解析的 apr_<uuidv7>（不得复用发布 ref）。'));
    }
    const reason = body['reason'];
    if (reason !== undefined && (typeof reason !== 'string' || reason.length < 8 || reason.length > 500)) {
      issues.push(issue('/reason', 'min_length', 'reason 长度 8–500。'));
    }
    if (issues.length > 0) throw new DomainError(400, 'validation_failed', {}, issues);
    return body as unknown as RollbackRequest;
  }

  private rejectUnknownKeys(body: Record<string, unknown>, allowed: string[], issues: Issue[]): void {
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) {
        issues.push(issue(`/${key}`, 'additional_property', '请求体包含未知字段。'));
      }
    }
  }

  private toDocument(row: StoredConfig, release: StoredRelease | null): OpsConfigDocument {
    const meta: SystemMeta = {
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      created_by: row.createdBy,
    };
    if (release) {
      meta.published_release = {
        release_id: release.releaseId,
        published_at: release.publishedAt,
        approval_ref: release.approvalRef,
        content_hash: release.contentHash,
        schema_version: '0.1',
        policy_version: release.policyVersion,
      };
    }
    return {
      schema_version: '0.1',
      config_id: row.configId,
      environment: row.environment,
      version: row.version,
      status: row.status,
      change_reason: row.changeReason,
      impact_scope: row.impactScope,
      spec: row.spec,
      meta,
    };
  }

  private toContractRelease(release: StoredRelease): Release {
    return {
      release_id: release.releaseId,
      config_id: release.configId,
      environment: release.environment,
      version: release.version,
      schema_version: '0.1',
      policy_version: release.policyVersion,
      content_hash: release.contentHash,
      published_at: release.publishedAt,
      approval_ref: release.approvalRef,
      canary_percent: release.canaryPercent,
      ...(release.releaseNotes ? { release_notes: release.releaseNotes } : {}),
    };
  }

  private async auditEvent(
    eventType: 'config_drafted' | 'config_submitted' | 'config_published' | 'config_rolled_back',
    actor: Actor,
    subjectId: string,
    before: unknown,
    after: unknown,
    reason: string,
    approvalRef: string | null,
    store: DomainStore = this.store,
  ): Promise<void> {
    await store.audit({
      eventId: `aud_${uuidv7()}`,
      eventType,
      occurredAt: this.now(),
      actor,
      subjectKind: 'ops_config',
      subjectId,
      before,
      after,
      reason,
      approvalRef,
    });
  }
}
