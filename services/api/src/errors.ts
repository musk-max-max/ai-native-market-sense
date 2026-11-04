/**
 * 全局错误映射：所有错误响应统一为契约 `Problem`（RFC 9457 + 机器可读 code）。
 *
 * 契约真源：contracts/shared/openapi.yaml 的 `Problem` schema。
 * 域插件主动表达业务错误时抛 `HttpProblem`，不要手写 reply.send(problem)。
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_TITLES, VALIDATION_FAILED_DETAIL } from './copy.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://errors.market-sense.invalid';

export type ProblemCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INSTRUMENT_NOT_FOUND'
  | 'ENTITLEMENT_RESTRICTED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  /** 外壳层：标识存在但无数据 / 路由不存在（契约 shared 0.2.x 已收录）。 */
  | 'NOT_FOUND';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  trace_id: string;
}

/** 域插件表达「可预期的业务错误」时使用；未捕获异常一律映射为 500 INTERNAL_ERROR。 */
export class HttpProblem extends Error {
  override readonly name = 'HttpProblem';
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail?: string;

  constructor(status: number, code: ProblemCode, title: string, detail?: string) {
    super(detail ?? title);
    this.status = status;
    this.code = code;
    this.title = title;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

export function problemBody(input: {
  status: number;
  code: string;
  title: string;
  detail?: string | undefined;
  traceId: string;
}): ProblemBody {
  const body: ProblemBody = {
    type: `${PROBLEM_TYPE_BASE}/${input.code.toLowerCase().replaceAll('_', '-')}`,
    title: input.title,
    status: input.status,
    code: input.code,
    trace_id: input.traceId,
  };
  if (input.detail !== undefined) {
    body.detail = input.detail;
  }
  return body;
}

function statusCodeFrom(err: FastifyError): number {
  const raw = (err as { statusCode?: unknown }).statusCode;
  return typeof raw === 'number' && raw >= 400 && raw <= 599 ? raw : 500;
}

/**
 * 4xx 的用户可见 title 一律来自 copy.ts（H3 m00839：服务层禁止拼中文/英文原文透出）。
 * 兼容旧调用点保留函数名，实际只做查表。
 */
function titleForStatus(status: number): string {
  return ERROR_TITLES[status as keyof typeof ERROR_TITLES] ?? ERROR_TITLES.default;
}

function codeForStatus(status: number): ProblemCode {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

function sendProblem(reply: FastifyReply, body: ProblemBody): FastifyReply {
  return reply
    .code(body.status)
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .send(body);
}

/**
 * 注册全局错误处理器与 404 处理器。
 * - Fastify schema 校验失败 → 400 VALIDATION_ERROR
 * - HttpProblem → 原样映射（域插件唯一推荐的业务错误出口）
 * - 其它带 4xx statusCode 的 Fastify 错误 → 按状态码映射
 * - 未捕获异常 → 500 INTERNAL_ERROR，detail 不回传内部堆栈（只进日志 + trace_id）
 */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.id;

    if (error instanceof HttpProblem) {
      request.log.info({ err: error, code: error.code }, 'http problem');
      return sendProblem(
        reply,
        problemBody({
          status: error.status,
          code: error.code,
          title: error.title,
          detail: error.detail,
          traceId,
        }),
      );
    }

    if (error.validation) {
      request.log.info({ err: error }, 'request validation failed');
      return sendProblem(
        reply,
        problemBody({
          status: 400,
          code: 'VALIDATION_ERROR',
          title: titleForStatus(400),
          detail: VALIDATION_FAILED_DETAIL,
          traceId,
        }),
      );
    }

    const status = statusCodeFrom(error);
    if (status < 500) {
      request.log.info({ err: error, status }, 'mapped client error');
      return sendProblem(
        reply,
        problemBody({
          status,
          code: codeForStatus(status),
          // 不把 error.message（英文原文/内部细节）透给 C 端；title 由本地文案表兜底。
          title: titleForStatus(status),
          traceId,
        }),
      );
    }

    request.log.error({ err: error }, 'unhandled error');
    return sendProblem(
      reply,
      problemBody({
        status: 500,
        code: 'INTERNAL_ERROR',
        title: '服务内部错误',
        traceId,
      }),
    );
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    sendProblem(
      reply,
      problemBody({
        status: 404,
        code: 'NOT_FOUND',
        title: ERROR_TITLES[404],
        detail: `${request.method} ${request.url}`,
        traceId: request.id,
      }),
    ),
  );
}
