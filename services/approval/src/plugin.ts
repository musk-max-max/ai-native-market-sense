/**
 * approval/config 域 Fastify 插件（A4）。
 *
 * 按 services/identity/src/plugin.ts 先例：相对路径导入壳（services/api），路由写相对路径
 * （shell 的 registerDomainPlugins 以 /v1 为 prefix），不 listen、不注册全局错误处理器。
 *
 * 错误面（H2 m00177 落笔后统一走壳）：DomainError → 抛 HttpProblem(status, code, title, detail,
 * extensions)；409 CONFLICT / 412 PRECONDITION_FAILED 由壳 STATUS_BY_CODE 单一映射，
 * 扩展字段仅 diff/approval_ref/current_status 三键（契约 additionalProperties:false）。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_TITLES } from '../../api/src/copy.js';
import { HttpProblem, type ProblemCode, type ProblemExtensions } from '../../api/src/errors.js';
import type { DomainPlugin, DomainPluginOptions } from '../../api/src/plugin.js';
import type {} from '../../api/src/auth.js';
import type { Principal } from '../../identity/src/domain/principal.js';
import { DomainError } from './domain/errors.js';
import { actorFromPrincipal, type Actor, type Environment } from './domain/types.js';
import { MemoryDomainStore } from './adapters/memory-store.js';
import type { DomainStore } from './ports/stores.js';
import { ApprovalService, type ActorContext } from './services/approval-service.js';
import { ConfigService } from './services/config-service.js';

export interface ApprovalPluginOptions {
  store?: DomainStore;
  approvals?: ApprovalService;
  configService?: ConfigService;
  now?: () => string;
  env?: NodeJS.ProcessEnv;
}

interface Services {
  store: DomainStore;
  approvals: ApprovalService;
  config: ConfigService;
}

/** 进程内共享服务（approval/config 两插件共享同一账本/配置库）。 */
let sharedServices: Services | null = null;

function buildServices(options: ApprovalPluginOptions): Services {
  if (options.store && options.approvals && options.configService) {
    return { store: options.store, approvals: options.approvals, config: options.configService };
  }
  if (!sharedServices) {
    const now = options.now ?? (() => new Date().toISOString());
    // 存储注入（测试）或共享默认存储；真实栈 DATABASE_URL 由部署注入（Pg 实现见 adapters/pg-store.ts）
    const store = options.store ?? new MemoryDomainStore();
    const approvals = options.approvals ?? new ApprovalService(store, now);
    const config = options.configService ?? new ConfigService({ store, approvals, now });
    sharedServices = { store, approvals, config };
  }
  return sharedServices;
}

const STATUS_TO_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
};

function problemDetail(error: DomainError): string | undefined {
  return error.issues ? JSON.stringify({ errors: error.issues }) : undefined;
}

/**
 * DomainError → HttpProblem（统一走壳；H2 errors.ts 已落笔 ProblemCode CONFLICT/PRECONDITION_FAILED
 * + typed 三键扩展，本插件直发例外已撤除）。
 */
function toHttpProblem(error: DomainError): HttpProblem {
  const code = (STATUS_TO_CODE[error.status] ?? 'INTERNAL_ERROR') as ProblemCode;
  const title = (ERROR_TITLES as Record<number, string | undefined>)[error.status] ?? ERROR_TITLES.default;
  const detail = problemDetail(error);
  const extensions: ProblemExtensions = {
    ...(error.extras.diff ? { diff: error.extras.diff } : {}),
    ...(error.extras.approvalRef ? { approval_ref: error.extras.approvalRef } : {}),
    ...(error.extras.currentStatus ? { current_status: error.extras.currentStatus } : {}),
  };
  return new HttpProblem(error.status, code, title, detail, Object.keys(extensions).length > 0 ? extensions : undefined);
}

/** 执行服务调用；DomainError 统一转 HttpProblem 抛出，由壳 installErrorHandling 映射。 */
async function guard<T>(_request: FastifyRequest, _reply: FastifyReply, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DomainError) {
      throw toHttpProblem(error);
    }
    throw error;
  }
}

function principalOf(request: FastifyRequest): Principal {
  if (!request.user) {
    throw new HttpProblem(401, 'UNAUTHENTICATED', ERROR_TITLES[401]);
  }
  return request.user;
}

function actorContextOf(request: FastifyRequest): ActorContext {
  const principal = principalOf(request);
  const raw = request.headers['x-model-version'];
  const modelVersion = Array.isArray(raw) ? raw[0] : raw;
  return { principal, ...(modelVersion ? { modelVersion } : {}) };
}

function actorOf(request: FastifyRequest): Actor {
  const context = actorContextOf(request);
  return actorFromPrincipal(context.principal, context.modelVersion);
}

function idempotencyKeyOf(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || key.length < 8 || key.length > 128) {
    throw new DomainError(400, 'idempotency_key_required', {}, [
      { path: 'idempotency-key', code: 'min_length', message: 'Idempotency-Key 头必填，长度 8–128。' },
    ]);
  }
  return key;
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function queryInt(value: unknown, path: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new DomainError(400, 'validation_failed', {}, [{ path, code: 'minimum', message: `必须是 ${min}–${max} 的整数。` }]);
  }
  return parsed;
}

function requireEnvironment(query: unknown): Environment {
  const value = queryString(query);
  if (value !== 'dev' && value !== 'staging' && value !== 'prod') {
    throw new DomainError(400, 'validation_failed', {}, [
      { path: '/environment', code: 'enum', message: 'environment 必填：dev|staging|prod。' },
    ]);
  }
  return value;
}

function enumOrUndefined(value: unknown, allowed: string[], path: string): string | undefined {
  const v = queryString(value);
  if (v === undefined) return undefined;
  if (!allowed.includes(v)) {
    throw new DomainError(400, 'validation_failed', {}, [{ path, code: 'enum', message: `取值必须是 ${allowed.join('|')}。` }]);
  }
  return v;
}

/** /v1/internal/approvals*（契约 contracts/approval/openapi.yaml，6 操作）。 */
export function createApprovalPlugin(options: ApprovalPluginOptions = {}): DomainPlugin {
  return Object.assign(
    async (app: FastifyInstance, _options: DomainPluginOptions): Promise<void> => {
      const { approvals } = buildServices(options);

      app.post('/internal/approvals', async (request, reply) => {
        const result = await guard(request, reply, () =>
          approvals.create({
            body: request.body,
            idempotencyKey: idempotencyKeyOf(request),
            actorContext: actorContextOf(request),
          }),
        );
        reply
          .code(201)
          .header('location', `/v1/internal/approvals/${result.application.approval_ref}`)
          .send(result.application);
      });

      app.get('/internal/approvals', async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const result = await guard(request, reply, () =>
          approvals.list({
            environment: enumOrUndefined(query['environment'], ['dev', 'staging', 'prod'], '/environment') as Environment | undefined,
            flow: enumOrUndefined(query['flow'], ['t1', 't2', 't3', 't4', 't5', 't6', 't7'], '/flow'),
            status: enumOrUndefined(
              query['status'],
              ['submitted', 'evaluated', 'routed', 'auto_passed', 'approved', 'rejected', 'expired'],
              '/status',
            ),
            applicantId: queryString(query['applicant_id']),
            from: queryString(query['from']),
            to: queryString(query['to']),
            limit: queryInt(query['limit'], '/limit', 1, 100, 20),
            cursor: queryString(query['cursor']),
          }),
        );
        reply.send(result);
      });

      app.get('/internal/approvals/:approval_ref', async (request, reply) => {
        const { approval_ref: approvalRef } = request.params as { approval_ref: string };
        const result = await guard(request, reply, () => approvals.get(approvalRef));
        reply.send(result);
      });

      app.post('/internal/approvals/:approval_ref/evaluate', async (request, reply) => {
        const { approval_ref: approvalRef } = request.params as { approval_ref: string };
        const result = await guard(request, reply, () => approvals.evaluateApproval(approvalRef, actorContextOf(request)));
        reply.send(result);
      });

      app.post('/internal/approvals/:approval_ref/decision', async (request, reply) => {
        const { approval_ref: approvalRef } = request.params as { approval_ref: string };
        const result = await guard(request, reply, () =>
          approvals.decide({
            approvalRef,
            body: request.body,
            idempotencyKey: idempotencyKeyOf(request),
            actorContext: actorContextOf(request),
          }),
        );
        reply.send(result);
      });

      app.get('/internal/approvals/:approval_ref/events', async (request, reply) => {
        const { approval_ref: approvalRef } = request.params as { approval_ref: string };
        const query = (request.query ?? {}) as Record<string, unknown>;
        const result = await guard(request, reply, () =>
          approvals.events(approvalRef, queryInt(query['limit'], '/limit', 1, 100, 20), queryString(query['cursor'])),
        );
        reply.send(result);
      });
    },
    { domain: 'approval' },
  );
}

/** /v1/internal/configs* + /v1/internal/releases*（契约 contracts/config/openapi.yaml，10 操作）。 */
export function createConfigPlugin(options: ApprovalPluginOptions = {}): DomainPlugin {
  return Object.assign(
    async (app: FastifyInstance, _options: DomainPluginOptions): Promise<void> => {
      const { config } = buildServices(options);

      app.get('/internal/configs', async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const result = await guard(request, reply, () =>
          config.listConfigs({
            environment: requireEnvironment(query['environment']),
            status: enumOrUndefined(query['status'], ['draft', 'published'], '/status') as 'draft' | 'published' | undefined,
            limit: queryInt(query['limit'], '/limit', 1, 50, 20),
            cursor: queryString(query['cursor']),
          }),
        );
        reply.send(result);
      });

      app.get('/internal/configs/:config_id', async (request, reply) => {
        const { config_id: configId } = request.params as { config_id: string };
        const query = (request.query ?? {}) as Record<string, unknown>;
        const result = await guard(request, reply, () => config.getOpsConfig(configId, requireEnvironment(query['environment'])));
        reply.header('etag', result.etag).send(result.document);
      });

      app.put('/internal/configs/:config_id', async (request, reply) => {
        const { config_id: configId } = request.params as { config_id: string };
        const query = (request.query ?? {}) as Record<string, unknown>;
        const rawIfMatch = request.headers['if-match'];
        const result = await guard(request, reply, () =>
          config.putDraft({
            configId,
            environment: requireEnvironment(query['environment']),
            ifMatch: Array.isArray(rawIfMatch) ? rawIfMatch[0] : rawIfMatch,
            body: request.body,
            actor: actorOf(request),
          }),
        );
        reply.header('etag', result.etag).send(result.document);
      });

      app.post('/internal/configs/:config_id/validate', async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const report = await guard(request, reply, () => config.validateOnly(request.body, requireEnvironment(query['environment'])));
        reply.send(report);
      });

      app.post('/internal/configs/:config_id/submit', async (request, reply) => {
        const { config_id: configId } = request.params as { config_id: string };
        const query = (request.query ?? {}) as Record<string, unknown>;
        const result = await guard(request, reply, () =>
          config.submit({
            configId,
            environment: requireEnvironment(query['environment']),
            body: request.body,
            actorContext: actorContextOf(request),
          }),
        );
        reply.send(result);
      });

      app.post('/internal/configs/:config_id/publish', async (request, reply) => {
        const { config_id: configId } = request.params as { config_id: string };
        const query = (request.query ?? {}) as Record<string, unknown>;
        const result = await guard(request, reply, () =>
          config.publish({
            configId,
            environment: requireEnvironment(query['environment']),
            body: request.body,
            actor: actorOf(request),
          }),
        );
        reply.send(result);
      });

      app.post('/internal/configs/:config_id/rollback', async (request, reply) => {
        const { config_id: configId } = request.params as { config_id: string };
        const query = (request.query ?? {}) as Record<string, unknown>;
        const result = await guard(request, reply, () =>
          config.rollback({
            configId,
            environment: requireEnvironment(query['environment']),
            body: request.body,
            actor: actorOf(request),
          }),
        );
        reply.send(result);
      });

      app.get('/internal/configs/:config_id/diff', async (request, reply) => {
        const { config_id: configId } = request.params as { config_id: string };
        const query = (request.query ?? {}) as Record<string, unknown>;
        const currentRaw = queryString(query['current']);
        const result = await guard(request, reply, () =>
          config.diff({
            configId,
            environment: requireEnvironment(query['environment']),
            baseVersion: queryInt(query['base'], '/base', 1, Number.MAX_SAFE_INTEGER, NaN),
            ...(currentRaw ? { currentVersion: queryInt(query['current'], '/current', 1, Number.MAX_SAFE_INTEGER, NaN) } : {}),
            submittedVersion: queryInt(query['submitted'], '/submitted', 1, Number.MAX_SAFE_INTEGER, NaN),
          }),
        );
        reply.send(result);
      });

      app.get('/internal/releases', async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const result = await guard(request, reply, () =>
          config.listReleases({
            environment: requireEnvironment(query['environment']),
            configId: queryString(query['config_id']),
            limit: queryInt(query['limit'], '/limit', 1, 50, 20),
            cursor: queryString(query['cursor']),
          }),
        );
        reply.send(result);
      });

      app.get('/internal/releases/:release_id', async (request, reply) => {
        const { release_id: releaseId } = request.params as { release_id: string };
        const result = await guard(request, reply, () => config.getRelease(releaseId));
        reply.send(result);
      });
    },
    { domain: 'config' },
  );
}

export const approvalPlugin: DomainPlugin = createApprovalPlugin({ env: process.env });
export const configPlugin: DomainPlugin = createConfigPlugin({ env: process.env });
