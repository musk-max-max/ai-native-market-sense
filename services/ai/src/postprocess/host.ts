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
}

/** A5 `packages/ai-policy/` 的实现由外部注入；本层不复制其逻辑。 */
export interface PolicyVerdict {
  /** 策略判定阻断（例如数据不足/合规拦截）时返回确定性降级卡，而非原始模型输出。 */
  readonly blocked: boolean;
  readonly reasonCodes: readonly string[];
  readonly output?: unknown;
}

export interface PolicyEvaluator {
  evaluate(input: unknown, context: PostprocessContext): Promise<PolicyVerdict>;
}

export interface DegradedDataCard {
  readonly degraded: true;
  readonly reasonCodes: readonly string[];
}

export interface PostprocessAuditRecord {
  readonly analysisId?: string;
  readonly traceId?: string;
  readonly audience: PostprocessAudience;
  readonly policyVersion: string;
  readonly blocked: boolean;
  readonly degraded: boolean;
  readonly reasonCodes: readonly string[];
}

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

export async function runPostprocessHost<T>(
  input: T,
  context: PostprocessContext,
  options: PostprocessHostOptions = {},
): Promise<PostprocessHostResult<T>> {
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
      await options.audit({
        ...(context.analysisId !== undefined ? { analysisId: context.analysisId } : {}),
        ...(context.traceId !== undefined ? { traceId: context.traceId } : {}),
        audience: context.audience,
        policyVersion: context.policyVersion,
        blocked,
        degraded: blocked,
        reasonCodes,
      });
    } catch (error) {
      throw new PostprocessHostError('P8', 'postprocess 审计写入失败', { cause: error });
    }
  }

  return { output, blocked, degraded: blocked, reasonCodes };
}
