/**
 * HTTP 适配层公共件：fetch 封装、Problem(+json) 错误、JSON Pointer 读写、
 * 文档扁平化（OpsConfigDocument ↔ Port 的 ConfigValues）。
 *
 * 契约事实（contracts/config、contracts/approval、shared）：
 * - success 不套 shared ResponseMeta；错误 400/409/412 均为 application/problem+json。
 * - /v1/internal/* 全部 Bearer（A4 identity：internal_active + sessionVersion）。
 * - approval create/decide 带 Idempotency-Key（8–128 字符）。
 */

import type {
  ConfigValue,
  ConfigValues,
} from '../domain/types';
import type {
  WireOpsConfigDocument,
  WireOpsConfigWrite,
  WireProblem,
} from './contract-types';

/** 最小 fetch 形状（便于测试注入；类型对齐 DOM lib 的 fetch 子集）。 */
export type HttpFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Problem(+json) 错误：status/code/detail 原样保留，errors[].path 是 JSON Pointer。 */
export class HttpProblemError extends Error {
  readonly status: number;
  readonly problem: WireProblem;

  constructor(status: number, problem: WireProblem) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
    this.name = 'HttpProblemError';
    this.status = status;
    this.problem = problem;
  }
}

export interface HttpRequestOptions {
  method: 'GET' | 'PUT' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
}

export async function requestJson(
  fetchImpl: HttpFetch,
  url: string,
  authHeaders: () => Record<string, string>,
  options: HttpRequestOptions,
): Promise<{ status: number; body: unknown; etag: string | null }> {
  const headers: Record<string, string> = {
    accept: 'application/json, application/problem+json',
    ...authHeaders(),
    ...options.headers,
  };
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetchImpl(url, { method: options.method, headers, body: payload });
  const etag = res.headers.get('ETag');
  const raw = await res.text();
  const parsed: unknown = raw.length > 0 ? safeJson(raw) : null;
  if (res.status >= 400) {
    throw new HttpProblemError(res.status, normalizeProblem(res.status, parsed));
  }
  return { status: res.status, body: parsed, etag };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { type: 'about:blank', title: raw.slice(0, 200), status: 0, code: 'NON_JSON' };
  }
}

function normalizeProblem(status: number, parsed: unknown): WireProblem {
  const obj = (parsed ?? {}) as Partial<WireProblem>;
  return {
    type: typeof obj.type === 'string' ? obj.type : 'about:blank',
    title: typeof obj.title === 'string' ? obj.title : `HTTP ${status}`,
    status,
    code: typeof obj.code === 'string' ? obj.code : 'UNKNOWN',
    detail: typeof obj.detail === 'string' ? obj.detail : undefined,
    trace_id: typeof obj.trace_id === 'string' ? obj.trace_id : undefined,
    errors: Array.isArray(obj.errors) ? (obj.errors as WireProblem['errors']) : undefined,
  };
}

/** Idempotency-Key（8–128 字符）；同 key 重试返回同一单，不重复建单。 */
export function newIdempotencyKey(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 12);
  return `idem-console-${stamp}-${rand}`;
}

/* ---------------- JSON Pointer（RFC 6901 子集） ---------------- */

export function pointerSegments(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function getByPointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const seg of pointerSegments(pointer)) {
    if (Array.isArray(node)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return undefined;
      node = node[idx];
    } else if (node !== null && typeof node === 'object') {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return node;
}

export function setByPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const segs = pointerSegments(pointer);
  if (segs.length === 0) return;
  let node: unknown = root;
  for (const seg of segs.slice(0, -1)) {
    if (Array.isArray(node)) {
      node = node[Number(seg)];
    } else if (node !== null && typeof node === 'object') {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return;
    }
  }
  const last = segs[segs.length - 1]!;
  if (Array.isArray(node)) {
    node[Number(last)] = value;
  } else if (node !== null && typeof node === 'object') {
    (node as Record<string, unknown>)[last] = value;
  }
}

/* ---------------- 文档 ↔ 扁平 values ---------------- */

/**
 * 把 OpsConfigWrite 的可编辑叶子（change_reason/impact_scope/spec）扁平化成
 * ConfigValues：key = JSON Pointer（与契约 errors[].path、DiffViewer 字段定位同一坐标系，
 * 见 CONTRACT-MAP「UI 字段直接绑定 JSON Pointer，不要扁平化成 values」——这里是 Port 边界的
 * 承载形式，不丢结构：saveDraft 按 pointer 写回完整文档）。
 */
export function flattenWriteBody(body: WireOpsConfigWrite): ConfigValues {
  const out: Record<string, ConfigValue> = {};
  out['/change_reason'] = body.change_reason;
  out['/impact_scope'] = body.impact_scope;
  flattenInto(out, '/spec', body.spec as unknown);
  return out;
}

function flattenInto(out: Record<string, ConfigValue>, pointer: string, node: unknown): void {
  if (node === null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    out[pointer] = node as ConfigValue;
    return;
  }
  if (Array.isArray(node)) {
    if (node.every((el) => typeof el === 'string')) {
      out[pointer] = node.slice() as readonly string[];
      return;
    }
    node.forEach((el, i) => flattenInto(out, `${pointer}/${i}`, el));
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flattenInto(out, `${pointer}/${escapeSegment(key)}`, value);
    }
  }
}

function escapeSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 按 JSON Pointer 把扁平 values 写回完整文档（深拷贝，不改入参）。 */
export function patchWriteBody(body: WireOpsConfigWrite, values: ConfigValues): WireOpsConfigWrite {
  const clone = deepClone(body) as unknown as Record<string, unknown>;
  for (const [pointer, value] of Object.entries(values)) {
    setByPointer(clone, pointer, value);
  }
  return clone as unknown as WireOpsConfigWrite;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 文档 → 请求体（剥掉服务端维护的 version/status/meta）。 */
export function toWriteBody(doc: WireOpsConfigDocument): WireOpsConfigWrite {
  return {
    schema_version: doc.schema_version,
    config_id: doc.config_id,
    environment: doc.environment,
    change_reason: doc.change_reason,
    impact_scope: doc.impact_scope,
    spec: deepClone(doc.spec),
  };
}
