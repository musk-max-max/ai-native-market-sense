/**
 * identity 域插件（A4）：Fastify plugin，供外壳（A0）挂载到 /v1。
 *
 * 挂载后路由：
 *   POST /v1/auth/register            C 端公开注册（→ c_end，可立即登录）
 *   POST /v1/internal/auth/register   内部注册（→ internal_pending，202，需邀请码/企业邮箱）
 *   POST /v1/auth/login               密码登录（→ token；internal_pending 403 不签）
 *   GET  /v1/auth/me                  Bearer → 当前 principal
 *
 * 刻意**不**在 P0 暴露审批 HTTP 入口：审批人（H3/user）的人类身份由 A0/A8 的管理后台认证体系提供，
 * 在 H5+A9 签发该体系前，任何 HTTP 审批入口都可能被 agent 身份冒用（agents/README.md「agent 不能审批」）。
 * 审批逻辑已完整实现在 `IdentityService`（可单测），A0 接线时只需注入真实的人类 admin principal。
 *
 * 文案：所有错误 title 来自 `services/api/src/copy.ts`（A0/H3 出口），域内不拼文案。
 * 缓存：本域响应含 token/个人信息，一律 `Cache-Control: no-store`。
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';

import { ERROR_TITLES } from '../../api/src/copy.js';
import { HttpProblem } from '../../api/src/errors.js';
import type { DomainPlugin, DomainPluginOptions } from '../../api/src/plugin.js';
import { PgIdentityStore } from './adapters/pg-store.js';
import { createIdentityAuthenticator } from './auth/authenticator.js';
import { loadIdentityConfig, type IdentityConfig } from './config.js';
import { isIdentityError } from './domain/errors.js';
import type { Principal } from './domain/principal.js';
import type { IdentityStore } from './ports/store.js';
import { createIdentityService, type IdentityService } from './service/identity-service.js';

export interface IdentityPluginOptions {
  /** 测试注入：完整服务（优先于 config/store）。 */
  readonly service?: IdentityService;
  /** 测试注入：仓储（须与 config 搭配）。 */
  readonly store?: IdentityStore;
  readonly config?: IdentityConfig;
  readonly env?: NodeJS.ProcessEnv;
}

const EMAIL_SCHEMA = { type: 'string', minLength: 3, maxLength: 254 } as const;
const PASSWORD_SCHEMA = { type: 'string', minLength: 1, maxLength: 1024 } as const;

function statusToProblemCode(status: number): 'VALIDATION_ERROR' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INTERNAL_ERROR' {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    default:
      return 'INTERNAL_ERROR';
  }
}

/** 域错误 → HttpProblem（title 查 copy.ts；reason 不进入响应）。 */
function rethrowAsProblem(error: unknown): never {
  if (isIdentityError(error)) {
    const title =
      ERROR_TITLES[error.status as keyof typeof ERROR_TITLES] ?? ERROR_TITLES.default;
    throw new HttpProblem(error.status, statusToProblemCode(error.status), title);
  }
  throw error;
}

function principalPayload(principal: Principal): Record<string, string> {
  return {
    user_id: principal.userId,
    user_type: principal.userType,
    tier: principal.tier,
  };
}

interface RouteDeps {
  readonly service: IdentityService;
}

function registerIdentityRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const authenticate = createIdentityAuthenticator(deps.service);

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: { email: EMAIL_SCHEMA, password: PASSWORD_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await deps.service.registerPublic(request.body);
        return reply.code(201).send({ user_id: result.userId });
      } catch (error) {
        rethrowAsProblem(error);
      }
    },
  );

  app.post<{
    Body: { email: string; password: string; company_email: string; invite_code?: string };
  }>(
    '/internal/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password', 'company_email'],
          additionalProperties: false,
          properties: {
            email: EMAIL_SCHEMA,
            password: PASSWORD_SCHEMA,
            company_email: EMAIL_SCHEMA,
            invite_code: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await deps.service.registerInternal({
          email: request.body.email,
          password: request.body.password,
          companyEmail: request.body.company_email,
          ...(request.body.invite_code === undefined
            ? {}
            : { inviteCode: request.body.invite_code }),
          // 来源 IP 取连接层，不接受 body/header 自报。
          ...(request.ip === undefined ? {} : { sourceIp: request.ip }),
        });
        return reply.code(202).send({
          application_id: result.applicationId,
          status: result.status,
        });
      } catch (error) {
        rethrowAsProblem(error);
      }
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: { email: EMAIL_SCHEMA, password: PASSWORD_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await deps.service.login(request.body);
        return reply.code(200).send({
          token: result.token,
          expires_at: result.expiresAt,
        });
      } catch (error) {
        rethrowAsProblem(error);
      }
    },
  );

  app.get('/auth/me', async (request, reply) => {
    const principal = await authenticate(request).catch(rethrowAsProblem);
    if (principal === null) {
      throw new HttpProblem(401, 'UNAUTHENTICATED', ERROR_TITLES[401]);
    }
    return reply.code(200).send(principalPayload(principal));
  });

}

export type IdentityDomainPlugin = DomainPlugin;

function buildPlugin(options: IdentityPluginOptions): IdentityDomainPlugin {
  return Object.assign(
    (async (app: FastifyInstance, _options: DomainPluginOptions) => {
      const env = options.env ?? process.env;
      let ownedStore: PgIdentityStore | null = null;

      let service = options.service;
      if (service === undefined) {
        const config = options.config ?? loadIdentityConfig(env);
        let store = options.store;
        if (store === undefined) {
          const databaseUrl = env['DATABASE_URL'];
          ownedStore = new PgIdentityStore(
            databaseUrl === undefined
              ? {}
              : {
                  pool: new Pool({
                    connectionString: databaseUrl,
                    connectionTimeoutMillis: 1000,
                    query_timeout: 2000,
                    statement_timeout: 2000,
                  }),
                },
          );
          store = ownedStore;
        }
        service = createIdentityService({ store, config });
      }

      // token/个人信息响应不得被任何中间层缓存（内部受众亦要求 no-store，ADR-008 D6）。
      app.addHook('onSend', async (_request, reply, payload) => {
        reply.header('cache-control', 'no-store');
        return payload;
      });

      registerIdentityRoutes(app, { service });

      if (ownedStore !== null) {
        const storeToClose = ownedStore;
        app.addHook('onClose', async () => {
          await storeToClose.close();
        });
      }
    }) as FastifyPluginAsync<DomainPluginOptions>,
    { domain: 'identity' } as const,
  );
}

/** 外壳挂载用（配置在 app.ready 阶段从 env 读取，缺失即启动失败）。 */
export const identityPlugin: IdentityDomainPlugin = buildPlugin({ env: process.env });

/** 单测工厂：注入内存 store/service，不起 PG。 */
export function createIdentityPlugin(options: IdentityPluginOptions = {}): IdentityDomainPlugin {
  return buildPlugin(options);
}
