/**
 * Postprocess 执行宿主（A3，ADR-007 D3 / Lead L126 边界）。
 *
 * 职责：
 *  - 请求路径内 fail-closed：授权阻断在调用 LLM 前短路；策略/审计失败不得透传原始模型输出；
 *  - 失败按调用方选择 500（throw）或降级数据卡（policy 明确拒绝时），绝不静默放行；
 *  - P2–P6 的纯过滤实现属于 `packages/ai-policy/`（A5 owner），本文件只定义接口并执行，
 *    不复制任何合规/数值复算/证据绑定逻辑（L45：两份真源会互相打红）。
 *
 * 边界（ADR-007 D4 / Lead m03143）：
 *  - ai 不跑 gate：entitlement 由 market 在数据侧判定后随请求上下文传入；
 *  - 403 短路发生在调用 LLM 前，`entitlement.blocked` 为 true 时直接拒绝，不调用 provider；
 *  - 用户可见文案由 api 注入，本层不写中文文案、不写供应商/模型名。
 */

import { computeOutputHash, type AuditOutputClaim } from '@market-sense/ai-policy';

import {
  assertValidAiGenerationAuditEvent,
  type AiGenerationAuditEvent,
  type AiGenerationKind,
  type AiGenerationPostprocessAction,
} from './audit.js';

export type PostprocessAudience = 'c_end' | 'internal';

export interface EntitlementSnapshot {
  readonly audience: PostprocessAudience;
  /** C 端：是否允许展示真实数值（来自 market meta.entitlement/is_entitled）。 */
  readonly displayAllowed: boolean;
  /** 内部：是否允许访问（来自 market 内部受众判定）。 */
  readonly internalAccessAllowed: boolean;
  /** 授权基础设施阻断（expired/hold/control/指纹等）；true 时不得调用 LLM。 */
  readonly blocked: boolean;
}

export interface PostprocessContext {
  readonly audience: PostprocessAudience;
  readonly policyVersion: string;
  readonly entitlement: EntitlementSnapshot;
  readonly analysisId?: string;
  readonly traceId?: string;

  // P8 审计元数据（A5 1.1.1 DDL 必填）。只有注入 audit 时才强制校验，
  // 未接审计的骨架/测试路径可缺省；请求路径一旦开审计，缺字段即 P8 失败。
  /** 统一请求 id，P8 event_key 身份（chat/analyses 共用）。 */
  readonly requestId?: string;
  /** HMAC(subject_ref)；系统触达用 `system`。 */
  readonly userId?: string;
  readonly kind?: AiGenerationKind;
  readonly modelFamily?: string;
  readonly modelId?: string;
  readonly promptVersion?: string;
  /** P7 注入的文案版本。 */
  readonly contentVersion?: string;
  readonly labelVersion?: string;
  /** 数据业务时点（ISO-8601），不是 occurred_at。 */
  readonly asOf?: string;
  /** 输入证据集 hash，由取数方调用 A5 `computeInputEvidenceHash()` 计算，host 不复算。 */
  readonly inputEvidenceHash?: string;
}

/** A5 `packages/ai-policy/` 的实现由外部注入；本层不复制其逻辑。 */
export interface PolicyVerdict {
  /** 策略判定阻断（例如数据不足/合规拦截）时返回确定性降级卡，而非原始模型输出。 */
  readonly blocked: boolean;
  readonly reasonCodes: readonly string[];
  readonly output?: unknown;
  /** P2–P6 命中/改写记录，供 P8 `postprocess_actions` 留痕；不含用户文案。 */
  readonly actions?: readonly AiGenerationPostprocessAction[];
  /** P2–P6 后的最终 claim（P6 改写后文本），供 A5 `computeOutputHash`；blocked 时为被阻断候选。 */
  readonly outputClaims?: readonly AuditOutputClaim[];
}

export interface PolicyEvaluator {
  evaluate(input: unknown, context: PostprocessContext): Promise<PolicyVerdict>;
}

export interface DegradedDataCard {
  readonly degraded: true;
  readonly reasonCodes: readonly string[];
}

export interface PostprocessAuditRecord extends AiGenerationAuditEvent {}

export interface PostprocessHostOptions {
  /** 未注入 = 配置错误，必须 fail-closed（不允许"空过滤直接透传"跑在生产请求路径）。 */
  readonly policy?: PolicyEvaluator;
  /** P8 审计写入；失败视为请求失败（fail-closed），不回传已生成文案。 */
  readonly audit?: (record: PostprocessAuditRecord) => void | Promise<void>;
  /** 策略拒绝时用于降级数据卡；默认 `{degraded:true, reasonCodes}`。 */
  readonly degradedCard?: (reasonCodes: readonly string[]) => DegradedDataCard;
}

export interface PostprocessHostResult<T> {
  readonly output: T | DegradedDataCard;
  readonly blocked: boolean;
  readonly degraded: boolean;
  readonly reasonCodes: readonly string[];
}

/** P0 授权阻断：调用方应映射为 403，且**不得**调用 LLM（D4.3）。 */
export class PostprocessBlockedError extends Error {
  override readonly name = 'PostprocessBlockedError';
  readonly reasonCodes: readonly string[];
  public constructor(reasonCodes: readonly string[] = ['ENTITLEMENT_BLOCKED']) {
    super('postprocess blocked before LLM');
    this.reasonCodes = reasonCodes;
  }
}

/** 策略未配置/策略执行异常/审计失败：调用方映射为 500（fail-closed）。 */
export class PostprocessHostError extends Error {
  override readonly name = 'PostprocessHostError';
  readonly stage: string;
  public constructor(stage: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.stage = stage;
  }
}

/**
 * 请求校验阶段可提前调用：P8 必填元数据缺失时抛 P8（API 应在调用模型前调用，
 * 避免生成完成后才失败）。host 注入 audit 时也会先执行本校验。
 */
export function assertAuditContextReady(context: PostprocessContext): void {
  requiredAuditField(context.requestId, 'request_id');
  requiredAuditField(context.userId, 'user_id');
  requiredAuditField(context.kind, 'kind');
  requiredAuditField(context.modelFamily, 'model_family');
  requiredAuditField(context.promptVersion, 'prompt_version');
  requiredAuditField(context.contentVersion, 'content_version');
  requiredAuditField(context.asOf, 'as_of');
  requiredAuditField(context.inputEvidenceHash, 'input_evidence_hash');
}

export async function runPostprocessHost<T>(
  input: T,
  context: PostprocessContext,
  options: PostprocessHostOptions = {},
): Promise<PostprocessHostResult<T>> {
  if (options.audit !== undefined) {
    assertAuditContextReady(context);
  }
  // P0：授权判定（由 market 传入）。阻断必须发生在 LLM 之前；这里只是执行宿主，不重做 gate。
  if (context.entitlement.blocked) {
    throw new PostprocessBlockedError();
  }
  if (context.audience === 'c_end' && !context.entitlement.displayAllowed) {
    throw new PostprocessBlockedError(['DISPLAY_NOT_ALLOWED']);
  }
  if (context.audience === 'internal' && !context.entitlement.internalAccessAllowed) {
    throw new PostprocessBlockedError(['INTERNAL_ACCESS_NOT_ALLOWED']);
  }
  const policy = options.policy;
  if (policy === undefined) {
    throw new PostprocessHostError('P2-P6', 'postprocess 策略未配置（packages/ai-policy 未接入）');
  }

  // P2–P6：纯过滤逻辑由 A5 的 PolicyEvaluator 执行；异常不得透传原始输出。
  let verdict: PolicyVerdict;
  try {
    verdict = await policy.evaluate(input, context);
  } catch (error) {
    throw new PostprocessHostError('P2-P6', 'postprocess 策略执行失败', { cause: error });
  }
  const reasonCodes = [...verdict.reasonCodes];
  const blocked = verdict.blocked;
  const output: T | DegradedDataCard = blocked
    ? (options.degradedCard?.(reasonCodes) ?? { degraded: true as const, reasonCodes })
    : ((verdict.output ?? input) as T);

  // P7 文案注入由 api 层完成；本层不写用户可见文案。
  // P8 审计：失败即请求失败（不能"生成完但没留痕"）。
  if (options.audit !== undefined) {
    try {
      await options.audit(buildAuditEvent(context, verdict, blocked));
    } catch (error) {
      if (error instanceof PostprocessHostError) {
        // 已在 buildAuditEvent 内标明具体缺失字段/非法结构；不要用泛化文案覆盖。
        throw error;
      }
      throw new PostprocessHostError('P8', 'postprocess 审计写入失败', { cause: error });
    }
  }

  return { output, blocked, degraded: blocked, reasonCodes };
}

function requiredAuditField<T>(value: T | undefined, field: string): T {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new PostprocessHostError('P8', `P8 审计缺少必填字段 ${field}`);
  }
  return value;
}

/** 组装 A5 1.1.1 的 P8 事件；字段缺失/结构非法先在应用侧失败，不把 23514 留到 DB。 */
function buildAuditEvent(
  context: PostprocessContext,
  verdict: PolicyVerdict,
  blocked: boolean,
): AiGenerationAuditEvent {
  const requestId = requiredAuditField(context.requestId, 'request_id');
  const userId = requiredAuditField(context.userId, 'user_id');
  const kind = requiredAuditField(context.kind, 'kind');
  const modelFamily = requiredAuditField(context.modelFamily, 'model_family');
  const promptVersion = requiredAuditField(context.promptVersion, 'prompt_version');
  const contentVersion = requiredAuditField(context.contentVersion, 'content_version');
  const asOf = requiredAuditField(context.asOf, 'as_of');
  const inputEvidenceHash = requiredAuditField(context.inputEvidenceHash, 'input_evidence_hash');

  let outputHash: string;
  try {
    // A5 1.1.1：模型输出/被阻断候选 claim 的 hash，不是降级卡/最终展示结构。
    outputHash = computeOutputHash([...(verdict.outputClaims ?? [])]);
  } catch (error) {
    throw new PostprocessHostError('P8', 'postprocess 输出 claims 无法 canonical 序列化', { cause: error });
  }

  const event: AiGenerationAuditEvent = {
    requestId,
    ...(context.analysisId !== undefined ? { analysisId: context.analysisId } : {}),
    audience: context.audience,
    userId,
    kind,
    modelFamily,
    ...(context.modelId !== undefined ? { modelId: context.modelId } : {}),
    promptVersion,
    policyVersion: context.policyVersion,
    contentVersion,
    ...(context.labelVersion !== undefined ? { labelVersion: context.labelVersion } : {}),
    inputEvidenceHash,
    outputHash,
    postprocessActions: verdict.actions ?? [],
    decision: blocked ? 'blocked' : 'passed',
    ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
    asOf,
  };
  assertValidAiGenerationAuditEvent(event);
  return event;
}
