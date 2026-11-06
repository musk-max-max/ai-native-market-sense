import type { Actor, ConfigLevel, ConfigState, ReleaseAuthorization } from './types';
import { levelRank } from './registry';

/**
 * 配置生命周期状态机（硬约束：前端不得绕过；适配层与服务端都要二次校验）。
 *
 * 草稿 → 校验 → 审批 → 发布，失败可驳回/回退；发布产物不可变，回滚 = 追加新 release。
 */

export const CONFIG_STATE_LABEL: Readonly<Record<ConfigState, string>> = {
  draft: '草稿',
  validated: '已校验',
  pending_approval: '待审批',
  approved: '已批准',
  published: '已发布',
  rejected: '已驳回',
  rolled_back: '已回滚',
};

export const CONFIG_STATE_ORDER: readonly ConfigState[] = [
  'draft',
  'validated',
  'pending_approval',
  'approved',
  'published',
];

export const STATE_TRANSITIONS: Readonly<Record<ConfigState, readonly ConfigState[]>> = {
  draft: ['validated'],
  validated: ['pending_approval', 'draft'],
  pending_approval: ['approved', 'rejected'],
  approved: ['published'],
  published: ['rolled_back'],
  rejected: ['draft'],
  rolled_back: ['draft'],
};

export function canTransition(from: ConfigState, to: ConfigState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: ConfigState;
  readonly to: ConfigState;

  constructor(from: ConfigState, to: ConfigState) {
    super(`非法状态迁移：${CONFIG_STATE_LABEL[from]} → ${CONFIG_STATE_LABEL[to]}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: ConfigState, to: ConfigState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/** 允许规则引擎自动放行的最高等级（C1=A：低风险自动放行；A15 不取得终审权）。 */
export const RULE_ENGINE_AUTO_MAX_LEVEL: ConfigLevel = 'C1';

export function authorizationAllowsAutoRelease(
  level: ConfigLevel,
  authorization: ReleaseAuthorization,
): boolean {
  if (authorization.kind === 'human_approval') {
    return authorization.approver.kind === 'human' && authorization.approvalRef.trim().length > 0;
  }
  // 规则引擎自动放行只对低风险等级开放；且执行者必须是规则引擎声明的 agent。
  return (
    levelRank(level) <= levelRank(RULE_ENGINE_AUTO_MAX_LEVEL) &&
    authorization.engine.kind === 'agent' &&
    authorization.ruleVersion.trim().length > 0
  );
}

export interface PublishGateInput {
  state: ConfigState;
  level: ConfigLevel;
  authorization: ReleaseAuthorization | undefined;
  diffAcknowledged: boolean;
  actor: Actor;
}

export interface PublishGateResult {
  ok: boolean;
  reason?: string;
}

/**
 * 发布门禁（UI 按钮可用性 + 适配层复用同一函数，避免两套判断）：
 * 1. 必须是 approved 状态；
 * 2. 必须已确认 before/after diff（决策 gate）；
 * 3. C2+ 必须人类审批，且审批人不能是 agent；
 * 4. 只有低风险 C0/C1 允许规则引擎自动放行。
 */
export function checkPublishGate(input: PublishGateInput): PublishGateResult {
  if (input.state !== 'approved') {
    return { ok: false, reason: `当前状态为「${CONFIG_STATE_LABEL[input.state]}」，只有「已批准」的变更才能发布` };
  }
  if (!input.diffAcknowledged) {
    return { ok: false, reason: '必须先核对 before/after diff 与影响范围并确认' };
  }
  if (!input.authorization) {
    return { ok: false, reason: '缺少审批授权（approval_ref）' };
  }
  if (input.authorization.kind === 'human_approval') {
    if (input.authorization.approver.kind !== 'human') {
      return { ok: false, reason: '终审必须是人类审批人；agent 不具备终审权' };
    }
    if (input.authorization.approvalRef.trim().length === 0) {
      return { ok: false, reason: '人类审批缺少 approval_ref' };
    }
    return { ok: true };
  }
  if (levelRank(input.level) > levelRank(RULE_ENGINE_AUTO_MAX_LEVEL)) {
    return { ok: false, reason: `${input.level} 级配置必须人类审批，规则引擎只能自动放行 C0/C1` };
  }
  if (input.actor.kind !== 'agent') {
    return { ok: false, reason: '规则引擎自动放行只能由规则引擎 actor 发起' };
  }
  return { ok: true };
}
