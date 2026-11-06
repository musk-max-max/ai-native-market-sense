/**
 * /v1/ai/analyses 路由（契约 contracts/ai/openapi.yaml；挂载前缀由外壳统一传 /v1）。
 *
 * - 鉴权：外壳（services/api installAuth）已装饰 request.user；standalone 可注入 authenticate。
 * - audience 按路径判定：/v1/ai/* 一律 c_end（/v1/internal/* 才是 internal，本期不提供）。
 * - 用户 Bearer（短 TTL）随内部调用透传证据源（L126）。
 * - 错误一律 throw HttpProblem；/v1/* 一律 no-store 由外壳/standalone 兜底。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ERROR_TITLES } from '../../../api/src/copy.js';
import { HttpProblem } from '../../../api/src/errors.js';

import {
  validateAnalysisRequest,
  type AnalysesService,
  type AiPrincipal,
} from '../domain/analyses.js';

export type AiAuthenticate = (
  request: FastifyRequest,
) => AiPrincipal | null | Promise<AiPrincipal | null>;

/**
 * 缺省认证：直接消费外壳 installAuth 装饰的 request.user
 * （services/identity Principal{userId,tier,…} 的消费子集）。
 */
export function principalFromShell(request: FastifyRequest): AiPrincipal | null {
  const user = (request as { user?: unknown }).user;
  if (typeof user !== 'object' || user === null) {
    return null;
  }
  const record = user as { userId?: unknown; tier?: unknown };
  if (typeof record.userId !== 'string' || record.userId === '') {
    return null;
  }
  return {
    userId: record.userId,
    tier: typeof record.tier === 'string' ? record.tier : 'c_end_display',
  };
}

function bearerFrom(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1];
}

async function requirePrincipal(
  request: FastifyRequest,
  authenticate: AiAuthenticate,
): Promise<AiPrincipal> {
  const principal = await authenticate(request);
  if (principal === null) {
    throw new HttpProblem(401, 'UNAUTHENTICATED', ERROR_TITLES[401]);
  }
  return principal;
}

export interface AnalysesRouteDeps {
  readonly service: AnalysesService;
  readonly authenticate?: AiAuthenticate;
}

export function registerAnalysesRoutes(app: FastifyInstance, deps: AnalysesRouteDeps): void {
  const authenticate = deps.authenticate ?? principalFromShell;

  // POST /v1/ai/analyses：P0 全同步 200（契约允许短任务 200；202 队列留 P1）。
  app.post('/ai/analyses', async (request, reply) => {
    const principal = await requirePrincipal(request, authenticate);
    const body = validateAnalysisRequest(request.body);
    const result = await deps.service.run({
      request: body,
      principal,
      audience: 'c_end',
      // 审计链 request_id 优先取客户端 request-id 头（跨服务追踪锚点），缺省回退 Fastify 内部 req.id。
      requestId: readClientRequestId(request),
      ...(bearerFrom(request) !== undefined ? { bearer: bearerFrom(request) as string } : {}),
    });
    return reply.code(200).send(result.response);
  });

  // GET /v1/ai/analyses/{analysis_id}：仅本人可见；不存在/非本人一律 404（不泄露存在性）。
  app.get<{ Params: { analysis_id: string } }>('/ai/analyses/:analysis_id', async (request, reply) => {
    const principal = await requirePrincipal(request, authenticate);
    const response = deps.service.get(request.params.analysis_id, principal.userId);
    return reply.code(200).send(response);
  });

  // GET /v1/ai/analyses/{analysis_id}/events：契约 streamAiAnalysisEvents（SSE 重放）。
  // P0 生成为同步 200，事件流按 analysis_id 重放已确认片段：status → section* → caveat* → done。
  // 只发用户可见内容（与 GET 响应同源，已过 P2–P6）；不传模型原始输出、内部 tier/供应商信息。
  // 鉴权/校验/越权 404 在建流前完成（与 GET 同语义，错误走 Problem JSON，不进流）。
  app.get<{ Params: { analysis_id: string } }>('/ai/analyses/:analysis_id/events', async (request, reply) => {
    const principal = await requirePrincipal(request, authenticate);
    const response = deps.service.get(request.params.analysis_id, principal.userId);
    const data = readResponseData(response);
    const analysisId = readRequiredString(data, 'analysis_id');
    const status = readRequiredString(data, 'status');

    const frames: { event: string; payload: Record<string, unknown> }[] = [
      { event: 'status', payload: { analysis_id: analysisId, event: 'status', status } },
    ];
    if (Array.isArray(data.sections)) {
      for (const section of data.sections) {
        frames.push({ event: 'section', payload: { analysis_id: analysisId, event: 'section', section } });
      }
    }
    if (Array.isArray(data.caveats)) {
      for (const caveat of data.caveats) {
        frames.push({ event: 'caveat', payload: { analysis_id: analysisId, event: 'caveat', caveat } });
      }
    }
    frames.push({ event: 'done', payload: { analysis_id: analysisId, event: 'done' } });

    const payload = frames
      .map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.payload)}\n\n`)
      .join('');
    return reply.code(200).type('text/event-stream').send(payload);
  });
}

function readResponseData(response: unknown): Record<string, unknown> {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new HttpProblem(500, 'INTERNAL_ERROR', ERROR_TITLES.default);
  }
  const data = (response as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpProblem(500, 'INTERNAL_ERROR', ERROR_TITLES.default);
  }
  return data as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new HttpProblem(500, 'INTERNAL_ERROR', ERROR_TITLES.default);
  }
  return value;
}

/**
 * 读客户端 request-id 头（跨服务审计链锚点）；缺省回退 Fastify 内部 req.id。
 * 仅接受非空字符串；空白头视为缺失。
 */
function readClientRequestId(request: FastifyRequest): string {
  const header = request.headers['request-id'] ?? request.headers['x-request-id'];
  if (typeof header === 'string') {
    const trimmed = header.trim();
    if (trimmed !== '') return trimmed;
  }
  return String(request.id);
}
