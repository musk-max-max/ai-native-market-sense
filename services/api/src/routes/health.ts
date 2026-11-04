/**
 * 健康检查路由（外壳层，不属于业务契约）。
 * 仅证明进程存活与已注册域；不探测数据库/外部数据源（readiness 归 A13 的部署探针，
 * P0 不做 DB 检查，避免 seed 未跑时误判 API 不健康）。
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

export interface HealthRouteDeps {
  readonly config: AppConfig;
  readonly domains: readonly string[];
  /** 域插件贡献的只读健康字段（如 data_ready）；失败只跳过，不阻断 /healthz */
  readonly contributors?: readonly (() => Promise<Record<string, unknown>>)[];
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptime_s: number;
  domains: string[];
}

export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get('/healthz', async (): Promise<HealthResponse> => {
    const base: HealthResponse = {
      status: 'ok',
      service: deps.config.serviceName,
      version: deps.config.serviceVersion,
      uptime_s: Math.round(process.uptime()),
      domains: [...deps.domains],
    };
    const extra: Record<string, unknown> = {};
    for (const contributor of deps.contributors ?? []) {
      try {
        Object.assign(extra, await contributor());
      } catch {
        // 健康检查不因贡献者异常而 500；缺字段由调用方按 fail-closed 处理
      }
    }
    return { ...base, ...extra };
  });
}
