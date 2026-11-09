import type {
  Actor,
  ApprovalItemView,
  AuditEvent,
  ChangeRequest,
  ConfigItemDef,
  ConfigValues,
  DraftConfig,
  PublishedConfig,
  Release,
} from '../domain/types';
import {
  DEFAULT_VALUES,
  assertConfigurable,
  configurableItems,
  findConfigItem,
} from '../domain/registry';
import { diffValues, describeDiff, valuesEqual } from '../domain/diff';
import { checkPublishGate, CONFIG_STATE_LABEL } from '../domain/state-machine';
import { computeImpact } from '../domain/impact';
import { hasBlockingIssues, validateValues } from '../domain/validation';
import {
  ApprovalAuthorityError,
  ConfigGateError,
  type ApprovalServicePort,
  type ApproveInput,
  type AuditPort,
  type ConfigItemDetail,
  type ConfigItemSummary,
  type ConfigServicePort,
  type PublishInput,
  type RejectInput,
  type RollbackInput,
  type SaveDraftInput,
  type SaveDraftOutcome,
  type SubmitApprovalInput,
  type ValidationOutcome,
} from './ports';

/**
 * Mock 适配层：一张内存表同时模拟 Config Service + Approval API + AuditSink。
 *
 * 角色：本地开发/无真契约后端时的 fallback（App.tsx 默认走这里；URL ?backend=http 切换到 src/adapters/ HTTP 适配器）。
 * 契约已落地的三个域（contracts/{config,approval}/openapi.yaml + identity.AuditSink）：
 * - Config Service：draft/publish 双态、If-Match 乐观锁、409 + 三点 diff、不可变 release
 * - Approval API：单条审批（无 batch）、approval_ref、人类终审
 * - identity.AuditSink：actor{kind,id,modelVersion,runId} 来源真源
 *
 * 刻意保留的行为（与决策一致，测试覆盖）：
 * - agent 不能终审（A15 只有低风险自动放行，且由规则引擎判定）；
 * - 锁定项在适配层二次拒绝，即使有人绕过 UI 直接调用；
 * - 发布/回滚必须带 diffAcknowledged，且生成不可变 release；
 * - 发布状态机不允许跳步。
 */

export interface MockBackendOptions {
  /** 注入时钟，测试用固定时间。 */
  now?: () => string;
  /** 给页面演示用的种子审批单（测试默认关闭，保证列表空）。 */
  seedDemoApprovals?: boolean;
}

interface ItemState {
  published: PublishedConfig;
  releases: Release[];
  draft: DraftConfig | null;
}

const SEED_PUBLISHER: Actor = { kind: 'human', id: 'H2' };

export class MockBackend implements ConfigServicePort, ApprovalServicePort, AuditPort {
  private readonly now: () => string;
  private readonly items = new Map<string, ItemState>();
  private readonly changeRequests = new Map<string, ChangeRequest>();
  private readonly auditEvents: AuditEvent[] = [];
  private seq = 0;

  constructor(options: MockBackendOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    for (const item of configurableItems()) {
      const values = DEFAULT_VALUES[item.id] ?? {};
      const publishedAt = this.now();
      const release: Release = {
        releaseId: `rel-${item.id}-1`,
        itemId: item.id,
        version: 1,
        values,
        publishedBy: SEED_PUBLISHER,
        publishedAt,
        authorization: {
          kind: 'human_approval',
          approvalRef: 'seed/initial-release',
          approver: SEED_PUBLISHER,
          changeRequestId: 'seed',
        },
      };
      this.items.set(item.id, {
        published: {
          itemId: item.id,
          version: 1,
          values,
          publishedAt,
          releaseId: release.releaseId,
        },
        releases: [release],
        draft: null,
      });
    }
    if (options.seedDemoApprovals) {
      this.seedDemoApprovals();
    }
  }

  // ---------------------------------------------------------------- configs

  async list(): Promise<ConfigItemSummary[]> {
    return configurableItems().map((item) => this.summaryOf(item));
  }

  async get(itemId: string): Promise<ConfigItemDetail> {
    const item = this.requireItem(itemId);
    const state = this.stateOf(item.id);
    return {
      ...this.summaryOf(item),
      published: state.published,
      releases: [...state.releases],
    };
  }

  async saveDraft(input: SaveDraftInput): Promise<SaveDraftOutcome> {
    let item: ConfigItemDef;
    try {
      item = this.requireItem(input.itemId);
    } catch {
      return {
        ok: false,
        kind: 'locked',
        message: '该配置项为合规锁定项或未知项，适配层拒绝写入（界面也不应渲染入口）。',
      };
    }
    const state = this.stateOf(item.id);

    if (input.expectedVersion !== state.published.version) {
      const baseRelease = state.releases.find((release) => release.version === input.expectedVersion);
      return {
        ok: false,
        kind: 'conflict',
        conflict: {
          base: baseRelease?.values ?? {},
          mine: input.values,
          theirs: state.published.values,
          currentVersion: state.published.version,
          message: '配置已被他人发布新版本（409 冲突）：请基于三点 diff 选择保留哪个值后再提交。',
        },
      };
    }

    const issues = validateValues(item, input.values);
    const draft: DraftConfig = {
      itemId: item.id,
      baseVersion: input.expectedVersion,
      values: input.values,
      state: 'draft',
      updatedBy: input.actor,
      updatedAt: this.now(),
    };
    state.draft = draft;
    this.audit(
      'draft.saved',
      input.actor,
      item.id,
      `保存草稿 v${input.expectedVersion}（${issues.length} 条校验提示）`,
    );
    return { ok: true, draft, issues };
  }

  async validate(itemId: string, actor: Actor): Promise<ValidationOutcome> {
    const item = this.requireItem(itemId);
    const state = this.stateOf(item.id);
    const draft = state.draft;
    if (!draft) {
      throw new ConfigGateError('NO_DRAFT', '没有可校验的草稿，请先保存草稿。');
    }
    if (draft.state === 'pending_approval' || draft.state === 'approved') {
      throw new ConfigGateError(
        'STATE',
        `草稿当前为「${CONFIG_STATE_LABEL[draft.state]}」，不能重复校验。`,
      );
    }

    const issues = validateValues(item, draft.values);
    if (hasBlockingIssues(issues)) {
      draft.state = 'draft';
      return { ok: false, state: 'draft', issues };
    }
    draft.state = 'validated';
    this.audit('config.validated', actor, item.id, `草稿校验通过（${issues.length} 条提示）`);
    return { ok: true, state: 'validated', issues };
  }

  async submitForApproval(input: SubmitApprovalInput): Promise<ChangeRequest> {
    const item = this.requireItem(input.itemId);
    const state = this.stateOf(item.id);
    const draft = state.draft;
    if (!draft) {
      throw new ConfigGateError('NO_DRAFT', '没有草稿可提交。');
    }
    if (draft.state !== 'validated') {
      throw new ConfigGateError(
        'NOT_VALIDATED',
        `草稿必须先通过校验才能提交审批（当前：${CONFIG_STATE_LABEL[draft.state]}）。`,
      );
    }
    if (!input.diffAcknowledged) {
      throw new ConfigGateError(
        'DIFF_NOT_ACKNOWLEDGED',
        '提交前必须展示并确认 before/after diff 与影响范围（硬约束）。',
      );
    }
    const issues = validateValues(item, draft.values);
    if (hasBlockingIssues(issues)) {
      throw new ConfigGateError('INVALID', '草稿仍有校验错误，不能提交审批。');
    }

    const before = this.valuesAtVersion(item.id, draft.baseVersion);
    const diffs = diffValues(item.fields, before, draft.values);
    const changed = diffs.filter((row) => row.kind !== 'unchanged');
    if (changed.length === 0) {
      throw new ConfigGateError('NO_CHANGE', '没有任何字段变更，无需提交审批。');
    }

    const changeRequest: ChangeRequest = {
      id: `cr-${++this.seq}`,
      itemId: item.id,
      title: item.title,
      level: item.level,
      values: draft.values,
      baseVersion: draft.baseVersion,
      requester: input.actor,
      submittedAt: this.now(),
      state: 'pending_approval',
      diffAcknowledged: true,
      changedFields: changed.map((row) => row.key),
    };
    this.changeRequests.set(changeRequest.id, changeRequest);
    draft.state = 'pending_approval';
    this.audit(
      'approval.submitted',
      input.actor,
      item.id,
      `提交审批 ${changeRequest.id}：${describeDiff(diffs)}；diff 已确认`,
    );
    return changeRequest;
  }

  async publish(input: PublishInput): Promise<Release> {
    const item = this.requireItem(input.itemId);
    const state = this.stateOf(item.id);
    const changeRequest = this.requireChangeRequest(input.changeRequestId);
    if (changeRequest.itemId !== item.id) {
      throw new ConfigGateError('NOT_FOUND', '审批单与配置项不匹配。');
    }
    if (changeRequest.state !== 'approved') {
      throw new ConfigGateError(
        'STATE',
        `审批单状态为「${changeRequest.state}」，只有已批准的变更才能发布。`,
      );
    }
    if (!changeRequest.authorization) {
      throw new ConfigGateError('NO_APPROVAL', '缺少审批授权（approval_ref）。');
    }
    const gate = checkPublishGate({
      state: 'approved',
      level: item.level,
      authorization: changeRequest.authorization,
      diffAcknowledged: input.diffAcknowledged,
      actor: input.actor,
    });
    if (!gate.ok) {
      throw new ConfigGateError('STATE', gate.reason ?? '发布门禁未通过。');
    }

    const version = state.published.version + 1;
    const release: Release = {
      releaseId: `rel-${item.id}-${version}`,
      itemId: item.id,
      version,
      values: changeRequest.values,
      publishedBy: input.actor,
      publishedAt: this.now(),
      authorization: changeRequest.authorization,
    };
    state.releases.push(release);
    state.published = {
      itemId: item.id,
      version,
      values: release.values,
      publishedAt: release.publishedAt,
      releaseId: release.releaseId,
    };
    state.draft = null;
    this.audit(
      'config.published',
      input.actor,
      item.id,
      `发布 v${version}（${release.releaseId}，来源 ${changeRequest.authorization.kind}）`,
    );
    return release;
  }

  async rollback(input: RollbackInput): Promise<Release> {
    const item = this.requireItem(input.itemId);
    const state = this.stateOf(item.id);
    if (input.actor.kind !== 'human') {
      throw new ConfigGateError('STATE', '回滚是危险操作，必须由人类操作者在二次确认后发起。');
    }
    if (!input.diffAcknowledged) {
      throw new ConfigGateError(
        'DIFF_NOT_ACKNOWLEDGED',
        '回滚前必须展示目标版本与当前版本的 diff 并确认。',
      );
    }
    if (input.reason.trim().length === 0) {
      throw new ConfigGateError('INVALID', '回滚必须填写原因（进入审计）。');
    }
    const target = state.releases.find((release) => release.version === input.targetVersion);
    if (!target) {
      throw new ConfigGateError('VERSION_NOT_FOUND', `找不到 v${input.targetVersion} 的发布记录。`);
    }
    if (target.version === state.published.version) {
      throw new ConfigGateError('STATE', '目标版本就是当前发布版本，无需回滚。');
    }

    const version = state.published.version + 1;
    const release: Release = {
      releaseId: `rel-${item.id}-${version}`,
      itemId: item.id,
      version,
      values: target.values,
      publishedBy: input.actor,
      publishedAt: this.now(),
      authorization: {
        kind: 'human_approval',
        approvalRef: `rollback/${target.releaseId}`,
        approver: input.actor,
        changeRequestId: 'rollback',
      },
      rolledBackFrom: target.releaseId,
    };
    state.releases.push(release);
    state.published = {
      itemId: item.id,
      version,
      values: release.values,
      publishedAt: release.publishedAt,
      releaseId: release.releaseId,
    };
    state.draft = null;
    this.audit(
      'config.rolled_back',
      input.actor,
      item.id,
      `回滚到 v${target.version}，生成 v${version}（${release.releaseId}）：${input.reason}`,
    );
    return release;
  }

  async listReleases(itemId: string): Promise<Release[]> {
    const item = this.requireItem(itemId);
    return [...this.stateOf(item.id).releases];
  }

  // --------------------------------------------------------------- approvals

  async listPending(): Promise<ApprovalItemView[]> {
    const pending = [...this.changeRequests.values()]
      .filter((changeRequest) => changeRequest.state === 'pending_approval')
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
    return pending.map((changeRequest) => {
      const item = this.requireItem(changeRequest.itemId);
      const before = this.valuesAtVersion(item.id, changeRequest.baseVersion);
      const diffs = diffValues(item.fields, before, changeRequest.values);
      return {
        changeRequest,
        before,
        impact: computeImpact(item.fields, diffs, item.level),
      };
    });
  }

  async approve(input: ApproveInput): Promise<ChangeRequest> {
    const changeRequest = this.requireChangeRequest(input.changeRequestId);
    if (changeRequest.state !== 'pending_approval') {
      throw new ApprovalAuthorityError('STATE', '该审批单已处理，不能重复审批。');
    }
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
    changeRequest.state = 'approved';
    changeRequest.authorization = {
      kind: 'human_approval',
      approvalRef: input.approvalRef,
      approver: input.actor,
      changeRequestId: changeRequest.id,
    };
    this.audit(
      'approval.approved',
      input.actor,
      changeRequest.itemId,
      `审批通过 ${changeRequest.id}（approval_ref=${input.approvalRef}）`,
    );
    return changeRequest;
  }

  async reject(input: RejectInput): Promise<ChangeRequest> {
    const changeRequest = this.requireChangeRequest(input.changeRequestId);
    if (changeRequest.state !== 'pending_approval') {
      throw new ApprovalAuthorityError('STATE', '该审批单已处理，不能重复审批。');
    }
    if (input.actor.kind !== 'human') {
      throw new ApprovalAuthorityError('HUMAN_ONLY', '驳回同样属于审批决定，必须由人类操作。');
    }
    if (input.reason.trim().length === 0) {
      throw new ApprovalAuthorityError('STATE', '驳回必须填写原因（进入审计）。');
    }
    changeRequest.state = 'rejected';
    const state = this.stateOf(changeRequest.itemId);
    if (state.draft && state.draft.state === 'pending_approval') {
      state.draft.state = 'rejected';
    }
    this.audit(
      'approval.rejected',
      input.actor,
      changeRequest.itemId,
      `驳回 ${changeRequest.id}：${input.reason}`,
    );
    return changeRequest;
  }

  /**
   * 规则引擎低风险自动放行（C1=A）：只允许 C0/C1，且只由规则引擎调用；
   * 不属于 ApprovalServicePort，UI 永远拿不到这个入口。
   */
  async autoReleaseByRule(
    changeRequestId: string,
    engine: Actor,
    ruleVersion: string,
  ): Promise<ChangeRequest> {
    const changeRequest = this.requireChangeRequest(changeRequestId);
    const item = this.requireItem(changeRequest.itemId);
    if (engine.kind !== 'agent' || ruleVersion.trim().length === 0) {
      throw new ApprovalAuthorityError('HUMAN_ONLY', '自动放行必须由规则引擎 agent 声明 ruleVersion。');
    }
    if (changeRequest.state !== 'pending_approval') {
      throw new ApprovalAuthorityError('STATE', '该审批单已处理。');
    }
    if (item.level !== 'C0' && item.level !== 'C1') {
      throw new ApprovalAuthorityError(
        'HUMAN_ONLY',
        `${item.level} 级配置不允许规则引擎自动放行，必须人类审批。`,
      );
    }
    changeRequest.state = 'approved';
    changeRequest.authorization = {
      kind: 'rule_engine_auto',
      ruleVersion,
      engine,
      changeRequestId: changeRequest.id,
    };
    this.audit(
      'approval.approved',
      engine,
      changeRequest.itemId,
      `规则引擎自动放行 ${changeRequest.id}（rule=${ruleVersion}）`,
    );
    return changeRequest;
  }

  // ------------------------------------------------------------------ audit

  async listAudit(): Promise<AuditEvent[]> {
    return [...this.auditEvents];
  }

  // ---------------------------------------------------------------- helpers

  private summaryOf(item: ConfigItemDef): ConfigItemSummary {
    const state = this.stateOf(item.id);
    return {
      item,
      publishedVersion: state.published.version,
      publishedAt: state.published.publishedAt,
      draft: state.draft,
      pendingApprovals: [...this.changeRequests.values()].filter(
        (changeRequest) =>
          changeRequest.itemId === item.id && changeRequest.state === 'pending_approval',
      ).length,
    };
  }

  private requireItem(itemId: string): ConfigItemDef {
    const item = assertConfigurable(itemId);
    if (!this.items.has(item.id)) {
      throw new ConfigGateError('NOT_FOUND', `未知配置项 ${itemId}`);
    }
    return item;
  }

  private stateOf(itemId: string): ItemState {
    const state = this.items.get(itemId);
    if (!state) {
      throw new ConfigGateError('NOT_FOUND', `未知配置项 ${itemId}`);
    }
    return state;
  }

  private requireChangeRequest(changeRequestId: string): ChangeRequest {
    const changeRequest = this.changeRequests.get(changeRequestId);
    if (!changeRequest) {
      throw new ConfigGateError('NOT_FOUND', `找不到审批单 ${changeRequestId}`);
    }
    return changeRequest;
  }

  private valuesAtVersion(itemId: string, version: number): ConfigValues {
    const state = this.stateOf(itemId);
    const release = state.releases.find((entry) => entry.version === version);
    return release?.values ?? state.releases[0]?.values ?? {};
  }

  private audit(
    action: AuditEvent['action'],
    actor: Actor,
    itemId: string,
    detail: string,
  ): void {
    this.auditEvents.push({
      id: `aud-${++this.seq}`,
      at: this.now(),
      actor,
      action,
      itemId,
      detail,
    });
  }

  /** 仅演示用：构造两条待审批单（一条 agent 发起、一条人类发起），跳过完整流程。 */
  private seedDemoApprovals(): void {
    const seeds: Array<{ itemId: string; values: ConfigValues; requester: Actor }> = [
      {
        itemId: 'ops.home-banner',
        values: {
          ...(DEFAULT_VALUES['ops.home-banner'] ?? {}),
          title: '收盘后 15 分钟：今日市场复盘直播',
          link_url: '/reports/live',
        },
        requester: {
          kind: 'agent',
          id: 'A15',
          modelVersion: 'sensenova-6.8-flash',
          runId: 'run-20261106-0912',
        },
      },
      {
        itemId: 'market.sentiment-thresholds',
        values: {
          ...(DEFAULT_VALUES['market.sentiment-thresholds'] ?? {}),
          hot_threshold: 82,
          cold_threshold: 18,
        },
        requester: { kind: 'human', id: 'H3' },
      },
    ];

    for (const seed of seeds) {
      const item = findConfigItem(seed.itemId);
      const state = item ? this.items.get(item.id) : undefined;
      if (!item || !state) continue;
      const before = state.published.values;
      const diffs = diffValues(item.fields, before, seed.values);
      const changeRequest: ChangeRequest = {
        id: `cr-${++this.seq}`,
        itemId: item.id,
        title: item.title,
        level: item.level,
        values: seed.values,
        baseVersion: state.published.version,
        requester: seed.requester,
        submittedAt: this.now(),
        state: 'pending_approval',
        diffAcknowledged: true,
        changedFields: diffs.filter((row) => row.kind !== 'unchanged').map((row) => row.key),
      };
      this.changeRequests.set(changeRequest.id, changeRequest);
      state.draft = {
        itemId: item.id,
        baseVersion: state.published.version,
        values: seed.values,
        state: 'pending_approval',
        updatedBy: seed.requester,
        updatedAt: this.now(),
      };
      this.audit(
        'approval.submitted',
        seed.requester,
        item.id,
        `提交审批 ${changeRequest.id}：${describeDiff(diffs)}；diff 已确认`,
      );
    }
  }
}

/** 演示数据里“值没变”的行不应出现在审批单变更字段里，单测兜底。 */
export function changedFieldCount(valuesBefore: ConfigValues, valuesAfter: ConfigValues): number {
  const keys = new Set([...Object.keys(valuesBefore), ...Object.keys(valuesAfter)]);
  let changed = 0;
  for (const key of keys) {
    if (!valuesEqual(valuesBefore[key], valuesAfter[key])) changed += 1;
  }
  return changed;
}
