/**
 * 确定性规则判定（evaluateApproval 的单一实现）。
 *
 * 硬约束（configs/rbac/approval-rule-engine.md §0，A15 设计稿 + 决策 #5）：
 *   - 规则引擎未实现 ⇒ 可绿集合 = ∅，一切审批单 yellow_route，**绝不假绿**；
 *   - 两类永不绿硬门：T5 权限类（含 agent 身份/角色/数据授权）+ ADR-008 内部员工转正/tier 改档；
 *   - 红是默认方向：输入无法复算 → red_block（不降级黄）；
 *   - A15 不入 decided_by/approved_by；auto_passed 只能来自确定性引擎（非 LLM）。
 * 判定必须可复算：input_hash = sha256(规范化 JSON({flow, subject, change, policy_version}))。
 */

import { readFileSync } from 'node:fs';

import { canonicalJson, sha256Hex, sha256Ref } from './canonical.js';
import type { ApprovalEvaluation, ApprovalFlow, ApprovalChange, ApprovalSubject } from './types.js';

export interface PolicyCategory {
  readonly id: string;
  readonly reason_code: string;
  readonly patterns: readonly string[];
}

export interface LoadedPolicy {
  readonly policyVersion: string;
  readonly fileSha256: string;
  readonly categories: readonly PolicyCategory[];
}

let cachedPolicy: LoadedPolicy | null = null;

const POLICY_URL = new URL('../../../../rules/ai-content-policy.json', import.meta.url);

/** 当前已签规则策略（rules/ai-content-policy.json，A5 真源）；带文件 sha 供 policy_snapshot。 */
export function loadPolicy(): LoadedPolicy {
  if (cachedPolicy !== null) {
    return cachedPolicy;
  }
  const path = process.env['POLICY_PATH'] ?? POLICY_URL;
  const bytes = readFileSync(path);
  const parsed = JSON.parse(bytes.toString('utf8')) as {
    policy_version: string;
    categories: { id: string; reason_code: string; patterns: string[] }[];
  };
  cachedPolicy = {
    policyVersion: parsed.policy_version,
    fileSha256: sha256Hex(bytes),
    categories: parsed.categories.map((category) => ({
      id: category.id,
      reason_code: category.reason_code,
      patterns: category.patterns,
    })),
  };
  return cachedPolicy;
}

export interface EvaluationInput {
  readonly flow: ApprovalFlow;
  readonly subject: ApprovalSubject;
  readonly change: ApprovalChange;
  /** T3 文案单携带的 policy_version（evidence.policy_version），参与 input_hash 复算。 */
  readonly policyVersion?: string | undefined;
  readonly evaluatedAt: string;
}

const RULE_ID = 'KD-APPROVAL-001';
const RULE_VERSION = '0.1.2';
const SOURCE_REFS = [
  'configs/rbac/approval-rule-engine.md §0 (v0.1.2；gap C-09：规则引擎未实现)',
  'approvals/README.md（账本规则；A9）',
  'agents/decisions.md C1（终审归人类）',
];

export function evaluate(input: EvaluationInput): ApprovalEvaluation {
  const policy = loadPolicy();
  const inputHash = sha256Ref(
    canonicalJson({
      flow: input.flow,
      subject: input.subject,
      change: input.change,
      policy_version: input.policyVersion ?? null,
    }),
  );

  // 红是默认方向：输入缺失即 red_block（契约 schema 已必填，此处是纵深防御）。
  if (input.subject === null || input.change === null || input.change.keys.length === 0) {
    return {
      decision: 'red_block',
      rule_id: RULE_ID,
      rule_version: RULE_VERSION,
      source_refs: SOURCE_REFS,
      policy_snapshot: { version: policy.policyVersion, sha256: policy.fileSha256 },
      input_hash: inputHash,
      reason_codes: ['input_not_recomputable'],
      route_to: 'H5',
      evaluated_at: input.evaluatedAt,
    };
  }

  const reasonCodes: string[] = ['rule_engine_unimplemented'];
  const requiredReviews: string[] = [];
  if (input.flow === 't5') {
    // 硬门一：T5 权限类永不绿（含 agent 身份/角色/数据授权）。
    reasonCodes.push('hard_gate_t5_permission');
    requiredReviews.push('H5');
  }
  if (input.subject.domain === 'identity' || input.subject.domain === 'rbac') {
    // 硬门二：ADR-008 内部员工转正/tier 改档永不绿。
    reasonCodes.push('hard_gate_adr008_tier');
  }
  if (input.flow === 't3') {
    requiredReviews.push('H3');
  }

  return {
    decision: 'yellow_route',
    rule_id: RULE_ID,
    rule_version: RULE_VERSION,
    source_refs: SOURCE_REFS,
    policy_snapshot: { version: policy.policyVersion, sha256: policy.fileSha256 },
    input_hash: inputHash,
    reason_codes: reasonCodes,
    // 黄档必填的人类席位（决策 #5：人类审批人 = H3/user；agent 禁入审批链）。
    route_to: 'H3,user',
    ...(requiredReviews.length > 0 ? { required_reviews: requiredReviews } : {}),
    evaluated_at: input.evaluatedAt,
  };
}
