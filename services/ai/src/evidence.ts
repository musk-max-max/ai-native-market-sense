/**
 * P1 证据/取数端口（ADR-007 D3 P1 / D4）。
 *
 * 规则：
 *  - 数据真源在 services/market（serving 视图），本层只经其 HTTP API 取数并透传用户 Bearer（L126）；
 *  - 受限（403 ENTITLEMENT_RESTRICTED）与不可得（网络/5xx/404）必须区分：受限≠无数据；
 *  - 全受限时调用方必须在调 LLM 前返 403 ENTITLEMENT_RESTRICTED（D4.3，不消耗 token）；
 *  - 部分受限：删受限证据、留 caveat 机器码（D4.4），不得把受限数据塞进 prompt。
 */

import type { EvidenceItem } from '@market-sense/ai-policy';

export type { EvidenceItem };

export interface EvidenceEntitlement {
  readonly tier: string;
  readonly is_entitled: boolean;
}

/** contracts/shared SourceRef 的结构子集（真实字段以契约为准）。 */
export interface EvidenceSourceRef {
  readonly source: string;
  readonly source_id?: string;
  readonly as_of: string;
  readonly staleness_ms: number;
}

export type EvidenceModuleStatus = 'ok' | 'restricted' | 'unavailable';

/** 单个数据模块的取数结果。evidence id 形如 `ev:<module>`。 */
export interface EvidenceModule {
  readonly module: string;
  readonly status: EvidenceModuleStatus;
  readonly source?: EvidenceSourceRef;
  readonly entitlement?: EvidenceEntitlement;
  readonly evidence: readonly EvidenceItem[];
  /** market 返回 INSTRUMENT_NOT_FOUND（存在性 404，非取数 404）。 */
  readonly instrumentNotFound?: boolean;
}

export interface EvidenceProbeResult {
  readonly modules: readonly EvidenceModule[];
}

export interface EvidenceProbeContext {
  /** 用户 Bearer（短 TTL），随内部调用透传给 market（L126）。 */
  readonly bearer?: string;
}

export interface AnalysisSubjectLike {
  readonly instrument_id?: string;
  readonly universe?: 'market' | 'watchlist';
  /** 客户端期望数据截止时点（D2：不替代审计业务时点 as_of）。 */
  readonly as_of?: string;
}

export interface EvidenceSource {
  probe(subject: AnalysisSubjectLike, context: EvidenceProbeContext): Promise<EvidenceProbeResult>;
}

/** 可用模块（status=ok）；供调用方判定全受限/部分受限。 */
export function okModules(result: EvidenceProbeResult): EvidenceModule[] {
  return result.modules.filter((module) => module.status === 'ok');
}

export function hasRestrictedModule(result: EvidenceProbeResult): boolean {
  return result.modules.some((module) => module.status === 'restricted');
}

/** 证据 id → 模块名（id 形如 `ev:<module>`）。 */
export function moduleOfEvidenceId(id: string): string | undefined {
  return id.startsWith('ev:') ? id.slice('ev:'.length) : undefined;
}

export const DEFAULT_MARKET_API_URL = 'http://127.0.0.1:8081';

export interface HttpEvidenceSourceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface ModulePlanItem {
  readonly module: string;
  readonly path: string;
}

/** 把 market 响应 data 中的数值展平成 numbers（P4 数值一致性需要）。 */
function collectNumbers(value: unknown, out: number[], depth = 0): void {
  if (depth > 6 || out.length >= 200) {
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNumbers(item, out, depth + 1);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      collectNumbers(item, out, depth + 1);
    }
  }
}

/** 事实行：`<module>|as_of=<ISO>|<compact json>`，确定性数据卡的 claim.text 直接用它（无 LLM 文案）。 */
function evidenceFactText(module: string, asOf: string, data: unknown): string {
  const json = JSON.stringify(data);
  const budget = 1800 - module.length - asOf.length;
  const truncated = json.length > budget ? `${json.slice(0, Math.max(0, budget))}…` : json;
  return `${module}|as_of=${asOf}|${truncated}`;
}

/**
 * 基于 services/market HTTP API 的证据源。
 *
 * 模块规划：instrument_id → market_quote + fundamental_summary；
 * universe=watchlist → watchlist_review；universe=market → limit_ladder。
 */
export function httpEvidenceSource(options: HttpEvidenceSourceOptions = {}): EvidenceSource {
  const baseUrl = (options.baseUrl ?? DEFAULT_MARKET_API_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;

  return {
    async probe(subject, context): Promise<EvidenceProbeResult> {
      const plan: ModulePlanItem[] = [];
      if (subject.instrument_id !== undefined) {
        const id = encodeURIComponent(subject.instrument_id);
        plan.push({ module: 'market_quote', path: `/v1/instruments/${id}/quote` });
        plan.push({ module: 'fundamental_summary', path: `/v1/instruments/${id}/fundamental-summary` });
      }
      if (subject.universe === 'watchlist') {
        plan.push({ module: 'watchlist_review', path: '/v1/watchlist/review' });
      }
      if (subject.universe === 'market') {
        plan.push({ module: 'limit_ladder', path: '/v1/market/limit-ladder' });
      }

      const modules = await Promise.all(
        plan.map(async (item): Promise<EvidenceModule> => probeOne(item, baseUrl, fetchImpl, timeoutMs, context)),
      );
      return { modules };
    },
  };
}

async function probeOne(
  plan: ModulePlanItem,
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  context: EvidenceProbeContext,
): Promise<EvidenceModule> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (context.bearer !== undefined && context.bearer !== '') {
    headers.authorization = `Bearer ${context.bearer}`;
  }
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${plan.path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { module: plan.module, status: 'unavailable', evidence: [] };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 200) {
    const envelope = body as {
      data?: unknown;
      meta?: { source?: EvidenceSourceRef; entitlement?: EvidenceEntitlement };
    };
    const source = envelope.meta?.source;
    const asOf = source?.as_of ?? '';
    const numbers: number[] = [];
    collectNumbers(envelope.data, numbers);
    const text = evidenceFactText(plan.module, asOf, envelope.data);
    return {
      module: plan.module,
      status: 'ok',
      source,
      entitlement: envelope.meta?.entitlement,
      evidence: [{ id: `ev:${plan.module}`, text, numbers }],
    };
  }

  const problem = body as { code?: unknown } | null;
  const code = typeof problem?.code === 'string' ? problem.code : '';
  if (response.status === 403 && code === 'ENTITLEMENT_RESTRICTED') {
    return { module: plan.module, status: 'restricted', evidence: [] };
  }
  if (response.status === 404 && code === 'INSTRUMENT_NOT_FOUND') {
    return { module: plan.module, status: 'unavailable', evidence: [], instrumentNotFound: true };
  }
  return { module: plan.module, status: 'unavailable', evidence: [] };
}
