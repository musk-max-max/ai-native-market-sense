/**
 * P8 审计写入（A3，ai_app 列级 INSERT）。
 *
 * 表结构/契约归 A5：`audit.ai_generation_events`（003，sha 以 A5 交付为准）。
 * 本文件只做三件事：
 *  - 把 A5 契约的必填字段/JSONPath 约束在应用侧先校验（fail-closed，不靠 DB 23514 才发现）；
 *  - 生成固定列级 INSERT（不写 event_key/prev_hash/hash/occurred_at，触发器权威计算）；
 *  - 提供可注入的 query 执行器（生产注入 pg.Pool，测试注入 fake）。
 *
 * input_evidence_hash / output_hash 由调用方用 `@market-sense/ai-policy` 导出的
 * `hashCanonicalJson()` 计算，禁止在本文件里另写 canonical 序列化（A5 1.1.0）。
 */

import type { PolicyViolation } from '@market-sense/ai-policy';

import type { PostprocessAudience } from './host.js';

export const AI_GENERATION_KINDS = [
  'stock_interpretation',
  'watchlist_review',
  'post_market_review',
  'lhb_review',
  'capital_features',
  'factor_screen',
  'research_brief',
  'anomaly_alert',
] as const;

export type AiGenerationKind = (typeof AI_GENERATION_KINDS)[number];

export type AiGenerationDecision = 'passed' | 'blocked';

/** 与 003 的 JSONPath CHECK 同构；matched 必填，block/redact 至少带一种原文标识。 */
export interface AiGenerationPostprocessAction {
  readonly stage: 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
  readonly action: 'allow' | 'block' | 'redact' | 'caveat';
  readonly matched: string;
  readonly code?: string;
  readonly category?: string;
  readonly claim_index?: number;
  readonly original_text?: string;
  readonly original_hash?: string;
  readonly rewritten_text?: string;
  readonly rewritten_hash?: string;
}

export interface AiGenerationAuditEvent {
  readonly requestId: string;
  readonly analysisId?: string;
  readonly audience: PostprocessAudience;
  /** HMAC(subject_ref)；系统触达固定 `system`。 */
  readonly userId: string;
  readonly kind: AiGenerationKind;
  readonly modelFamily: string;
  readonly modelId?: string;
  readonly promptVersion: string;
  readonly policyVersion: string;
  /** P7 文案版本，由 API 注入方传入。 */
  readonly contentVersion: string;
  readonly labelVersion?: string;
  readonly inputEvidenceHash: string;
  readonly outputHash: string;
  readonly postprocessActions: readonly AiGenerationPostprocessAction[];
  readonly decision: AiGenerationDecision;
  readonly traceId?: string;
  /** 数据业务时点（非 occurred_at）；ISO-8601。 */
  readonly asOf: string;
}

export interface AuditQuery {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ai_generation 审计字段 ${field} 必须是非空字符串`);
  }
}

function optionalNonEmpty(value: string | undefined, field: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`ai_generation 审计字段 ${field} 若存在必须是非空字符串`);
  }
}

function assertAction(action: AiGenerationPostprocessAction, index: number): void {
  const path = `postprocess_actions[${index}]`;
  if (!['P2', 'P3', 'P4', 'P5', 'P6'].includes(action.stage)) {
    throw new Error(`${path}.stage 非法：${String(action.stage)}`);
  }
  if (!['allow', 'block', 'redact', 'caveat'].includes(action.action)) {
    throw new Error(`${path}.action 非法：${String(action.action)}`);
  }
  requireNonEmpty(action.matched, `${path}.matched`);
  if (
    (action.action === 'block' || action.action === 'redact') &&
    action.original_text === undefined &&
    action.original_hash === undefined
  ) {
    throw new Error(`${path} 为 ${action.action} 时必须提供 original_text 或 original_hash`);
  }
  if (
    action.action === 'redact' &&
    action.rewritten_text === undefined &&
    action.rewritten_hash === undefined
  ) {
    throw new Error(`${path} 为 redact 时必须提供 rewritten_text 或 rewritten_hash`);
  }
  optionalNonEmpty(action.original_text, `${path}.original_text`);
  optionalNonEmpty(action.original_hash, `${path}.original_hash`);
  optionalNonEmpty(action.rewritten_text, `${path}.rewritten_text`);
  optionalNonEmpty(action.rewritten_hash, `${path}.rewritten_hash`);
}

/** 应用侧预校验（与 DB CHECK 同构）；失败直接抛错，由 host 映射 P8 失败。 */
export function assertValidAiGenerationAuditEvent(event: AiGenerationAuditEvent): void {
  requireNonEmpty(event.requestId, 'request_id');
  optionalNonEmpty(event.analysisId, 'analysis_id');
  if (event.audience !== 'c_end' && event.audience !== 'internal') {
    throw new Error(`ai_generation 审计字段 audience 非法：${String(event.audience)}`);
  }
  requireNonEmpty(event.userId, 'user_id');
  if (!(AI_GENERATION_KINDS as readonly string[]).includes(event.kind)) {
    throw new Error(`ai_generation 审计字段 kind 非法：${String(event.kind)}`);
  }
  requireNonEmpty(event.modelFamily, 'model_family');
  optionalNonEmpty(event.modelId, 'model_id');
  requireNonEmpty(event.promptVersion, 'prompt_version');
  requireNonEmpty(event.policyVersion, 'policy_version');
  requireNonEmpty(event.contentVersion, 'content_version');
  optionalNonEmpty(event.labelVersion, 'label_version');
  if (!HASH_PATTERN.test(event.inputEvidenceHash)) {
    throw new Error('ai_generation 审计字段 input_evidence_hash 必须是 64 位小写 hex');
  }
  if (!HASH_PATTERN.test(event.outputHash)) {
    throw new Error('ai_generation 审计字段 output_hash 必须是 64 位小写 hex');
  }
  if (event.decision !== 'passed' && event.decision !== 'blocked') {
    throw new Error(`ai_generation 审计字段 decision 非法：${String(event.decision)}`);
  }
  optionalNonEmpty(event.traceId, 'trace_id');
  if (typeof event.asOf !== 'string' || Number.isNaN(Date.parse(event.asOf))) {
    throw new Error('ai_generation 审计字段 as_of 必须是可解析的 ISO-8601 时间');
  }
  if (!Array.isArray(event.postprocessActions)) {
    throw new Error('ai_generation 审计字段 postprocess_actions 必须是数组');
  }
  event.postprocessActions.forEach(assertAction);
}

/** 固定列级 INSERT；event_key/prev_hash/hash/occurred_at 由 DB 触发器/默认值生成。 */
export const AI_GENERATION_INSERT_SQL = `INSERT INTO audit.ai_generation_events (
  request_id, analysis_id, audience, user_id, kind, model_family, model_id,
  prompt_version, policy_version, content_version, label_version,
  input_evidence_hash, output_hash, postprocess_actions, decision, trace_id, as_of
) VALUES (
  $1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11,
  $12, $13, $14::jsonb, $15, $16, $17::timestamptz
)`;

export type AiGenerationAuditWriter = (event: AiGenerationAuditEvent) => Promise<void>;

/**
 * 构造 P8 写入器。query 抛错/DB 拒绝都必须向上抛，由 `runPostprocessHost`
 * 映射为 P8 失败（不得吞掉后继续返回文案）。
 */
export function createAiGenerationAuditWriter(query: AuditQuery): AiGenerationAuditWriter {
  return async (event) => {
    assertValidAiGenerationAuditEvent(event);
    await query.query(AI_GENERATION_INSERT_SQL, [
      event.requestId,
      event.analysisId ?? null,
      event.audience,
      event.userId,
      event.kind,
      event.modelFamily,
      event.modelId ?? null,
      event.promptVersion,
      event.policyVersion,
      event.contentVersion,
      event.labelVersion ?? null,
      event.inputEvidenceHash,
      event.outputHash,
      JSON.stringify(event.postprocessActions),
      event.decision,
      event.traceId ?? null,
      event.asOf,
    ]);
  };
}

/**
 * 把 A5 `runAiPolicy` 的 violations 转成 `postprocess_actions` 行。
 * 每条命中/改写/阻断动作都要留痕（H3 条件 1）；不复制判定，只做字段补齐。
 */
export function postprocessActionsFromViolations(
  violations: readonly PolicyViolation[],
): AiGenerationPostprocessAction[] {
  return violations.map((violation) => {
    const matched = violation.matched ?? violation.rewritten_text ?? violation.code;
    const action: AiGenerationPostprocessAction = {
      stage: violation.stage,
      action: violation.action,
      matched,
      code: violation.code,
      ...(violation.category !== undefined ? { category: violation.category } : {}),
      ...(violation.claim_index >= 0 ? { claim_index: violation.claim_index } : {}),
      ...(violation.action === 'block' || violation.action === 'redact'
        ? { original_text: matched }
        : {}),
      ...(violation.action === 'redact'
        ? { rewritten_text: violation.rewritten_text ?? matched }
        : {}),
    };
    return action;
  });
}
